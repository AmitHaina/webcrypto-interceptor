// --full mode: dump every script source and response body seen on the page
// to disk, mirroring each URL's own path — a poor-man's "save whole site".
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const beautify = require('js-beautify');

// ponytail: one global dir per process run. Fine for "visit one page and
// extract it"; if extracting multiple different sites concurrently ever
// matters, key this map by targetUrl instead.
let extractDir = null;

function setExtractDir(targetUrl) {
    const host = new URL(targetUrl).hostname;
    extractDir = path.join(process.cwd(), `extracted_${host}_${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });
    return extractDir;
}

// Returns null for anything that isn't a real fetched resource: puppeteer
// synthetic URLs (pptr:, __puppeteer_evaluation_script__), webpack://,
// blob:, data:, about: etc. Their "paths" are debugger sourceURLs / opaque
// ids, not real site structure — decoding them (e.g. pptr:'s %2F-encoded
// stack-frame paths) can otherwise forge arbitrary nested directories.
function urlToFilePath(url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

    let p = decodeURIComponent(u.pathname);
    if (p === '' || p.endsWith('/')) p += 'index.html';
    if (!path.extname(p)) p += '.html'; // extensionless SPA routes/API calls -> readable file

    // Defense in depth: collapse '..'/'.' segments so a crafted path can
    // never escape extractDir even if a decoded segment contains them.
    const safeSegs = p.split('/').filter(seg => seg && seg !== '.' && seg !== '..');
    return path.join(extractDir, u.hostname, ...safeSegs);
}

// Minified bundles/responses come back as one giant line — pretty-print
// text formats so the saved files are actually readable. Skips Buffers
// (binary content) and anything js-beautify/JSON.parse chokes on, falling
// back to the raw text untouched rather than losing the capture.
function prettify(target, content) {
    if (Buffer.isBuffer(content)) return content;
    const ext = path.extname(target).toLowerCase();
    try {
        if (ext === '.js') return beautify.js(content, { indent_size: 2 });
        if (ext === '.css') return beautify.css(content, { indent_size: 2 });
        if (ext === '.json') return JSON.stringify(JSON.parse(content), null, 2);
        // Extensionless API responses land as .html (SPA-route convention)
        // but are often JSON bodies — sniff and pretty-print those too,
        // before falling through to generic HTML beautify.
        if (ext === '.html' && /^\s*[{[]/.test(content)) return JSON.stringify(JSON.parse(content), null, 2);
        if (ext === '.html') return beautify.html(content, { indent_size: 2 });
    } catch (e) { /* not valid/parseable — save as-is below */ }
    return content;
}

// url: source URL, or falsy/non-http for inline <script>/eval/internal
// sources (saved under _inline/).
function saveFile(url, content, scriptId) {
    if (!extractDir) return;
    try {
        const filePath = url ? urlToFilePath(url) : null;
        const target = filePath || path.join(extractDir, '_inline', `${scriptId || Date.now()}.js`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, prettify(target, content));
    } catch (e) { if (process.env.EXTRACT_DEBUG) console.error('saveFile ERR', url, e.message); }
}

module.exports = { setExtractDir, saveFile, isExtracting: () => !!extractDir };
