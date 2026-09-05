const { C } = require('../util/colors');
const { enableAntiDebug } = require('./anti-debug');
const { attachNetworkCapture } = require('./network');
const { attachScriptScanner } = require('./scripts');
const { recordCryptoCall, armCryptoBreakpoints, cleanupContexts } = require('./crypto');
const { handleStructuredEvent, handleLegacyConsoleText } = require('./events');

const BINDING_NAME = '__wci';

async function attachToSession(cdpSession, targetLabel, opts) {
    const options = opts || {};
    const bpMap = {};

    // ---- structured event transport -------------------------------------
    // Runtime.addBinding exposes a global function `__wci(payload)` inside
    // every execution context of this target. Unlike console.log parsing it
    // is structured, untruncated and immune to site console spam. Worker
    // targets rely on this channel: their console output is NOT relayed
    // through puppeteer's page.on('console').
    let bindingReady = false;
    try {
        await cdpSession.send('Runtime.addBinding', { name: BINDING_NAME });
        bindingReady = true;
    } catch (e) {}

    if (bindingReady) {
        cdpSession.on('Runtime.bindingCalled', (params) => {
            if (params.name !== BINDING_NAME) return;
            try {
                handleStructuredEvent(params.payload, targetLabel, options.getExtractDir);
            } catch (e) {}
        });
    }

    // ---- legacy console fallback (page targets only) ---------------------
    cdpSession.on('Runtime.consoleAPICalled', (params) => {
        try {
            if (params.type !== 'log' && params.type !== 'info' && params.type !== 'debug') return;
            for (const arg of params.args || []) {
                const text = typeof arg.value === 'string' ? arg.value : (arg.description || '');
                if (!text.includes('[Reversed-Event]')) continue;
                if (isDuplicateLegacy(text)) continue;
                const wasm = handleLegacyConsoleText(text, targetLabel);
                if (wasm) {
                    const { dumpWasmFromHex } = require('./events');
                    dumpWasmFromHex(wasm.hash, wasm.hex, options.getExtractDir);
                }
                break; // one [Reversed-Event] per console call
            }
        } catch (e) {}
    });

    // ---- browser errors (replaces the old page.on('console') error relay) --
    cdpSession.on('Runtime.exceptionThrown', (params) => {
        try {
            const d = params.exceptionDetails || {};
            const text = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown';
            console.log(`${C.red}[Browser ERROR]${C.reset} ${String(text).split('\n')[0].substring(0, 200)}`);
        } catch (e) {}
    });

    // ---- crypto breakpoints ----------------------------------------------
    cdpSession.on('Runtime.executionContextCreated', async (params) => {
        const contextId = params.context.id;
        try {
            await armCryptoBreakpoints(cdpSession, targetLabel, bpMap, contextId);
        } catch (e) {}
    });
    cdpSession.on('Runtime.executionContextDestroyed', async (params) => {
        try { await cleanupContexts(cdpSession, [params.executionContextId], bpMap); } catch (e) {}
    });

    try { await cdpSession.send('Runtime.enable'); } catch (e) {}
    try { await cdpSession.send('Debugger.enable'); } catch (e) {}
    await enableAntiDebug(cdpSession);
    await attachNetworkCapture(cdpSession);
    await attachScriptScanner(cdpSession);

    cdpSession.on('Debugger.paused', async (params) => {
        const hitBps = params.hitBreakpoints || [];
        if (hitBps.some(b => bpMap[b])) {
            try { await recordCryptoCall(cdpSession, params, bpMap, targetLabel); }
            catch (e) { console.warn(`${C.red}Record error:${C.reset}`, e.message); }
        }
        try { await cdpSession.send('Debugger.resume'); } catch (e) {}
    });
}

// Legacy console lines have no uid — dedupe on the raw text within a short
// window (puppeteer + Runtime.consoleAPICalled can both surface a call).
const recentLegacy = new Map();
const LEGACY_TTL_MS = 2000;
function isDuplicateLegacy(text) {
    const now = Date.now();
    for (const [k, t] of recentLegacy) {
        if (now - t > LEGACY_TTL_MS) recentLegacy.delete(k);
    }
    if (recentLegacy.has(text)) return true;
    recentLegacy.set(text, now);
    return false;
}

module.exports = { attachToSession, BINDING_NAME };
