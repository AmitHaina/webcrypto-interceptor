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
    } catch (e) { if (process.env.EXTRACT_DEBUG) console.error('saveFile ERR', url, e.message); }
}

// Test hook: clear per-session collision state.
function resetExtractState() {
    pathByUrl.clear();
    usedPaths.clear();
}

module.exports = { setExtractDir, getExtractDir, saveFile, isExtracting: () => !!extractDir, urlToFilePath, resetExtractState };
