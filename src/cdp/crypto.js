const { C } = require('../util/colors');
const { writeLog } = require('../util/log');
const { shortUrl } = require('../util/decoders');
const { SUBTLE_METHODS } = require('../config');

async function recordCryptoCall(cdpSession, params, bpMap, targetLabel) {
    const frames = params.callFrames || [];
    if (!frames.length) return;

    const hitBps = params.hitBreakpoints || [];
    const method = hitBps.map(b => bpMap[b]).find(m => m) || 'crypto.subtle.*';

    // The top frame is our page-side wrapper in stealth.js (functionName equals
    // one of the SUBTLE_METHODS). Skip it so the reported caller is the site's
    // real call site. Only skip ONE wrapper level — a site function that is
    // itself legitimately named "encrypt"/"decrypt" must not be skipped too.
    const wrapperNames = new Set(SUBTLE_METHODS);
    let skip = 0;
    if (skip < frames.length && wrapperNames.has(frames[skip].functionName)) skip++;
    const displayFrames = frames.slice(skip);
    if (!displayFrames.length) return;

    const caller = displayFrames[0];
    const callerName = caller.functionName || '<anonymous>';

    const stackTrace = displayFrames.map(f => {
        const file = f.url ? shortUrl(f.url) : '<anonymous>';
        return `   at ${f.functionName || '<anonymous>'} (${file}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1})`;
    }).slice(0, 5).join('\n');

    console.log(`\n${C.hlred}[🔓 CRYPTO BOUNDARY] ${method}${C.reset} in ${C.magenta}${targetLabel}${C.reset} called by ${C.yellow}${callerName}${C.reset}`);
    console.log(`${C.dim}${stackTrace}${C.reset}`);

    writeLog({
        type: 'crypto_call',
        method,
        target: targetLabel,
        caller: callerName,
        stack: displayFrames.map(f => ({ fn: f.functionName, url: f.url, line: f.location.lineNumber, col: f.location.columnNumber }))
    });
}

// Per-context armament bookkeeping. Contexts are created and destroyed
// constantly (navigations, iframes); arming 12 breakpoints per context without
// ever removing them leaks both Debugger.breakpoint entries and RemoteObject
// handles until long sessions grind to a halt. We now track what was armed
// for each context and tear it down on executionContextDestroyed.
//
// Keyed WeakMap(session) -> Map(contextId -> record): executionContextIds are
// only unique WITHIN one CDP session, so a module-level Map(contextId) made
// two concurrently attached targets with the same context id collide — the
// second target's context was skipped as "already armed" and captured nothing.
const sessionArmed = new WeakMap();

function armedFor(cdpSession) {
    let m = sessionArmed.get(cdpSession);
    if (!m) { m = new Map(); sessionArmed.set(cdpSession, m); }
    return m;
}

async function armCryptoBreakpoints(cdpSession, targetLabel, bpMap, contextId) {
    const perSession = armedFor(cdpSession);
    if (perSession.has(contextId)) return 0; // already armed for this context
    const record = { breakpointIds: [], objectIds: [] };
    let armed = 0;
    for (const method of SUBTLE_METHODS) {
        try {
            // Target SubtleCrypto.prototype.<method> (native) rather than
            // crypto.subtle.<method>, which by page-load time is shadowed by
            // our stealth.js wrapper. Prototype gives us the real native fn
            // so each of the 12 methods gets a distinct breakpoint id.
            const fn = await cdpSession.send('Runtime.evaluate', {
                expression: `SubtleCrypto.prototype.${method}`,
                contextId: contextId,
                silent: true
            });
            if (fn.result && fn.result.type === 'function' && fn.result.objectId) {
                record.objectIds.push(fn.result.objectId);
                const bp = await cdpSession.send('Debugger.setBreakpointOnFunctionCall', {
                    objectId: fn.result.objectId
                });
                if (bp.breakpointId) {
                    bpMap[bp.breakpointId] = `crypto.subtle.${method}`;
                    record.breakpointIds.push(bp.breakpointId);
                    armed++;
                }
            }
        } catch (e) {}
    }
    if (armed > 0) {
        perSession.set(contextId, record);
        console.log(`${C.magenta}[🕷️  CRYPTO HOOK]${C.reset} ${armed} breakpoints armed on ${C.cyan}${targetLabel}${C.reset} (context ${contextId})`);
    }
    return armed;
}

// Tear down everything armed for contexts that just died. Returns the number
// of breakpoints removed so the caller can log if verbose.
async function cleanupContexts(cdpSession, destroyedContextIds, bpMap) {
    const perSession = armedFor(cdpSession);
    for (const contextId of destroyedContextIds) {
        const record = perSession.get(contextId);
        if (!record) continue;
        for (const bpId of record.breakpointIds) {
            try { await cdpSession.send('Debugger.removeBreakpoint', { breakpointId: bpId }); } catch (e) {}
            delete bpMap[bpId];
        }
        for (const objectId of record.objectIds) {
            try { await cdpSession.send('Runtime.releaseObject', { objectId }); } catch (e) {}
        }
        perSession.delete(contextId);
    }
}

module.exports = { recordCryptoCall, armCryptoBreakpoints, cleanupContexts };
