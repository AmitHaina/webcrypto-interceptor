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
    // real call site.
    const wrapperNames = new Set(SUBTLE_METHODS);
    let skip = 0;
    while (skip < frames.length && wrapperNames.has(frames[skip].functionName)) skip++;
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

async function armCryptoBreakpoints(cdpSession, targetLabel, bpMap) {
    let armed = 0;
    for (const method of SUBTLE_METHODS) {
        try {
            // Target SubtleCrypto.prototype.<method> (native) rather than
            // crypto.subtle.<method>, which by page-load time is shadowed by
            // our stealth.js wrapper. Prototype gives us the real native fn
            // so each of the 12 methods gets a distinct breakpoint id.
            const fn = await cdpSession.send('Runtime.evaluate', {
                expression: `SubtleCrypto.prototype.${method}`, silent: true
            });
            if (fn.result && fn.result.type === 'function' && fn.result.objectId) {
                const bp = await cdpSession.send('Debugger.setBreakpointOnFunctionCall', {
                    objectId: fn.result.objectId
                });
                if (bp.breakpointId) {
                    bpMap[bp.breakpointId] = `crypto.subtle.${method}`;
                    armed++;
                }
            }
        } catch (e) {}
    }
    if (armed > 0) {
        console.log(`${C.magenta}[🕷️  CRYPTO HOOK]${C.reset} ${armed} breakpoints armed on ${C.cyan}${targetLabel}${C.reset}`);
    }
    return armed;
}

module.exports = { recordCryptoCall, armCryptoBreakpoints };
