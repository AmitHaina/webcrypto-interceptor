// Universal script scanner via CDP Debugger domain.
//
// Fires `Debugger.scriptParsed` for EVERY script the V8 parser processes,
// including:
//   - external <script src="..."> resources (also seen by Network domain)
//   - inline <script>...</script> blocks in HTML (typically NOT surfaced as
//     separate network responses — this is where Nuxt puts window.__NUXT__)
//   - eval() strings
//   - new Function(source) constructions
//   - Webpack-runtime-generated chunks and dynamic imports
//   - Worker scripts
//
// For each, we pull the source with Debugger.getScriptSource and run the same
// secret scanner used on network bodies. That catches keys embedded in module
// closures (u7buy-style) that never appear on `window`.

const { scanForSecrets, reportSecrets } = require('../util/secrets');

// Dedup per script URL+id so we don't re-scan the same source multiple times
// across sessions.
const scannedScripts = new Set();

// Skip obviously-uninteresting sources: chrome internals, extensions, empty
// generated wrappers.
function shouldSkipUrl(url) {
    if (!url) return false; // inline/eval scripts have empty url — we DO want those
    if (url.startsWith('chrome://')) return true;
    if (url.startsWith('chrome-extension://')) return true;
    if (url.startsWith('devtools://')) return true;
    if (url.startsWith('extensions::')) return true;
    return false;
}

async function attachScriptScanner(cdpSession) {
    try { await cdpSession.send('Debugger.enable'); } catch (e) { /* already enabled elsewhere */ }

    cdpSession.on('Debugger.scriptParsed', async (params) => {
        const { scriptId, url, hash, length } = params;
        // Skip very small (<200 char) scripts — unlikely to embed useful keys.
        if (typeof length === 'number' && length < 200) return;
        if (shouldSkipUrl(url)) return;

        const dedupKey = (url || '<inline>') + '|' + hash;
        if (scannedScripts.has(dedupKey)) return;
        scannedScripts.add(dedupKey);

        let source;
        try {
            const r = await cdpSession.send('Debugger.getScriptSource', { scriptId });
            source = r && r.scriptSource;
        } catch (e) {
            return; // script may already be GC'd or be a wasm module
        }
        if (!source) return;

        const findings = scanForSecrets(source);
        if (findings.length) {
            reportSecrets(findings, url || `<inline script ${scriptId}>`);
        }
    });
}

module.exports = { attachScriptScanner };
