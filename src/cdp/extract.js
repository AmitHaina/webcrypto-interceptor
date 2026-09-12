// --full mode: dump every script source and response body seen on the page
// to disk, mirroring each URL's own path — a poor-man's "save whole site".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ponytail: one global dir per process run. Fine for "visit one page and
// extract it"; if extracting multiple different sites concurrently ever
// matters, key this map by targetUrl instead.
let extractDir = null;

function setExtractDir(targetUrl, baseDir) {
    const host = new URL(targetUrl).hostname;
    extractDir = path.join(baseDir || process.cwd(), `extracted_${host}_${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });
    return extractDir;
}

function getExtractDir() {
    return extractDir;
}

// Returns null for anything that isn't a real fetched resource: puppeteer
// synthetic URLs (pptr:, __puppeteer_evaluation_script__), webpack://,
// blob:, data:, about: etc. Their "paths" are debugger sourceURLs / opaque
// ids, not real site structure — decoding them (e.g. pptr:'s %2F-encoded
// stack-frame paths) can otherwise forge arbitrary nested directories.
function urlToFilePath(url) {
    if (!extractDir) return null;
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

    let p = decodeURIComponent(u.pathname);
    if (p === '' || p.endsWith('/')) p += 'index.html';
    if (!path.extname(p)) p += '.html'; // extensionless SPA routes/API calls -> readable file

    // Defense in depth: collapse '..'/'.' segments so a crafted path can
    // never escape extractDir even if a decoded segment contains them.
    // Also sanitize segments to replace characters illegal on Windows filesystem.
    const safeSegs = p.split('/')
        .filter(seg => seg && seg !== '.' && seg !== '..')
        .map(seg => seg.replace(/[<>:"/\\|?*]/g, '_'))
        // Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
        .map(seg => /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(seg) ? '_' + seg : seg);
    if (!safeSegs.length) return null;
    return path.join(extractDir, u.hostname, ...safeSegs);
}

// Minified bundles/responses come back as one giant line — pretty-print
// text formats so the saved files are actually readable. Skips Buffers
// (binary content) and anything js-beautify/JSON.parse chokes on, falling
// back to the raw text untouched rather than losing the capture.
//
// js-beautify is required lazily: it is only needed in --full mode, and
// keeping it out of the module's load path lets the unit tests run without
// node_modules installed.
function prettify(target, content) {
    if (Buffer.isBuffer(content)) return content;
    // Guard: giant text bundles (>1MB) take seconds to beautify synchronously,
    // starving the Node.js event loop and dropping CDP packets. Save as-is.
    if (typeof content === 'string' && content.length > 1024 * 1024) return content;
    const ext = path.extname(target).toLowerCase();
    try {
        if (ext === '.js' || ext === '.css' || ext === '.html') {
            const beautify = require('js-beautify');
            if (ext === '.js') return beautify.js(content, { indent_size: 2 });
            if (ext === '.css') return beautify.css(content, { indent_size: 2 });
            return beautify.html(content, { indent_size: 2 });
        }
        if (ext === '.json') return JSON.stringify(JSON.parse(content), null, 2);
        // Extensionless API responses land as .html (SPA-route convention)
        // but are often JSON bodies — sniff and pretty-print those too,
        // before falling through to generic HTML beautify.
        if (ext === '.html' && /^\s*[{[]/.test(content)) return JSON.stringify(JSON.parse(content), null, 2);
    } catch (e) { /* not valid/parseable — save as-is below */ }
    return content;
}

// Collision handling: URLs that differ only in query string (or concurrent
// saves racing each other) used to silently overwrite the same mirrored
// path. First writer keeps the clean name; later ones get a short hash of
// the full URL spliced in before the extension. Repeat saves of the SAME
// url still overwrite (that's a re-fetch, not a collision).
const pathByUrl = new Map();   // full url -> final path (same url overwrites itself)
const usedPaths = new Set();   // every path ever handed out this session

function resolveTarget(url) {
    const filePath = urlToFilePath(url);
    if (!filePath) return null;

    const previous = pathByUrl.get(url);
    if (previous) return previous;

    let target = filePath;
    if (usedPaths.has(target)) {
        const hash = crypto.createHash('sha1').update(url).digest('hex').substring(0, 8);
        const ext = path.extname(target);
        target = path.join(path.dirname(target), path.basename(target, ext) + '_' + hash + ext);
    }
    pathByUrl.set(url, target);
    usedPaths.add(target);
    return target;
}

// url: source URL, or falsy/non-http for inline <script>/eval/internal
// sources (saved under _inline/).
function saveFile(url, content, scriptId) {
    if (!extractDir) return;
    try {
        let target;
        if (url) {
            target = resolveTarget(url);
            if (!target) return;
        } else {
            target = path.join(extractDir, '_inline', `${scriptId || Date.now()}.js`);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, prettify(target, content));
        // Opportunistic sourcemap detection & recovery in the background
        handleSourcemap(url, content).catch(() => {});
    } catch (e) { if (process.env.EXTRACT_DEBUG) console.error('saveFile ERR', url, e.message); }
}

const SOURCEMAP_RE = /(?:\/\/|\/\*)[#@] sourceMappingURL=([^\s*]+)/;
const seenMaps = new Set();

function cleanSourcePath(srcPath) {
    if (!srcPath || typeof srcPath !== 'string') return null;
    let p = srcPath.replace(/^(webpack|webpack-internal|rollup|vite|turbopack|file):\/\/?/i, '');
    p = p.replace(/^\[[^\]]+\]\//, '');
    p = p.split('?')[0].split('#')[0];
    p = p.replace(/\\/g, '/');
    p = p.replace(/^[a-zA-Z]:\//, '');
    const segs = p.split('/')
        .filter(s => s && s !== '.' && s !== '..')
        .map(s => s.replace(/[<>:"/\\|?*]/g, '_'))
        .map(s => /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(s) ? '_' + s : s);
    if (!segs.length) return null;
    return path.join(...segs);
}

function unpackSourcemap(mapData, baseUrl, targetDir) {
    if (!mapData || !Array.isArray(mapData.sources)) return 0;
    const sources = mapData.sources;
    const contents = Array.isArray(mapData.sourcesContent) ? mapData.sourcesContent : [];
    if (!contents.length) return 0;

    let hostDir = 'sources';
    try {
        if (baseUrl && /^https?:\/\//i.test(baseUrl)) {
            hostDir = new URL(baseUrl).hostname;
        }
    } catch (e) {}

    let count = 0;
    for (let i = 0; i < sources.length; i++) {
        const srcPath = sources[i];
        const srcContent = contents[i];
        if (!srcContent || typeof srcContent !== 'string') continue;

        const rel = cleanSourcePath(srcPath);
        if (!rel) continue;

        const dest = path.join(targetDir, '_sources', hostDir, rel);
        try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, srcContent, 'utf8');
            count++;
        } catch (e) {}
    }
    return count;
}

async function handleSourcemap(url, content) {
    if (!extractDir) return;
    const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content || '');
    if (!text.includes('sourceMappingURL')) return;

    const m = text.match(SOURCEMAP_RE);
    if (!m) return;
    const mapRef = m[1].trim();
    if (!mapRef) return;

    let mapJson = null;
    if (mapRef.startsWith('data:')) {
        try {
            if (mapRef.includes('base64,')) {
                mapJson = Buffer.from(mapRef.split('base64,')[1], 'base64').toString('utf8');
            } else if (mapRef.includes(',')) {
                mapJson = decodeURIComponent(mapRef.split(',')[1]);
            }
        } catch (e) { return; }
    } else {
        if (!url || !/^https?:\/\//i.test(url)) return;
        let mapUrl;
        try {
            mapUrl = new URL(mapRef, url).href;
        } catch (e) { return; }

        if (seenMaps.has(mapUrl)) return;
        seenMaps.add(mapUrl);

        try {
            const resp = await fetch(mapUrl, { signal: AbortSignal.timeout(5000) });
            if (!resp.ok) return;
            mapJson = await resp.text();
            saveFile(mapUrl, mapJson);
        } catch (e) { return; }
    }

    if (!mapJson) return;
    try {
        const mapData = JSON.parse(mapJson);
        const count = unpackSourcemap(mapData, url, extractDir);
        if (count > 0) {
            const { C } = require('../util/colors');
            const { shortUrl } = require('../util/decoders');
            const { trackSourcesRecovered } = require('../util/summary');
            const { writeLog } = require('../util/log');
            trackSourcesRecovered(count);
            console.log(`\n${C.hlgrn}[🗺️  SOURCEMAP]${C.reset} Recovered ${count} original source file(s) from ${C.cyan}${shortUrl(url || 'script')}${C.reset} \u2192 ${C.dim}_sources/${C.reset}`);
            writeLog({ type: 'sourcemap_recovered', url, filesRecovered: count });
        }
    } catch (e) {}
}

// Test hook: clear per-session collision state.
function resetExtractState() {
    pathByUrl.clear();
    usedPaths.clear();
    seenMaps.clear();
}

module.exports = {
    setExtractDir,
    getExtractDir,
    saveFile,
    isExtracting: () => !!extractDir,
    urlToFilePath,
    cleanSourcePath,
    unpackSourcemap,
    handleSourcemap,
    resetExtractState
};
