// --full mode: dump every script source and response body seen on the page
// to disk, mirroring each URL's own path — a poor-man's "save whole site".
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

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

// url: source URL, or falsy/non-http for inline <script>/eval/internal
// sources (saved under _inline/).
function saveFile(url, content, scriptId) {
    if (!extractDir) return;
    try {
        const filePath = url ? urlToFilePath(url) : null;
        const target = filePath || path.join(extractDir, '_inline', `${scriptId || Date.now()}.js`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    } catch (e) { if (process.env.EXTRACT_DEBUG) console.error('saveFile ERR', url, e.message); }
}

module.exports = { setExtractDir, saveFile, isExtracting: () => !!extractDir };
