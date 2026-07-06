const { C } = require('../util/colors');
const { writeLog } = require('../util/log');
const { shortUrl } = require('../util/decoders');
const { SUBTLE_METHODS } = require('../config');

const DECODE_FN = `function(){
    var u;
    if(this instanceof ArrayBuffer) u = new Uint8Array(this);
    else if(ArrayBuffer.isView(this)) u = new Uint8Array(this.buffer, this.byteOffset, this.byteLength);
    else return null;
    var hex = '', utf8 = '';
    var limit = Math.min(u.length, 512);
    for(var i = 0; i < limit; i++){ hex += (u[i] < 16 ? '0' : '') + u[i].toString(16); }
    try { utf8 = new TextDecoder('utf-8', {fatal: false}).decode(u.slice(0, 2048)); } catch(e){}
    return { length: u.length, hex: hex, utf8: utf8 };
}`;

async function recordCryptoCall(cdpSession, params, bpMap, targetLabel) {
    const frames = params.callFrames || [];
    if (!frames.length) return;

    const hitBps = params.hitBreakpoints || [];
    const method = hitBps.map(b => bpMap[b]).find(m => m) || 'crypto.subtle.*';
    const caller = frames[0];
    const callerName = caller.functionName || '<anonymous>';
    const inputs = [];

    const stackTrace = frames.map(f => {
        const file = f.url ? shortUrl(f.url) : '<anonymous>';
        return `   at ${f.functionName || '<anonymous>'} (${file}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1})`;
    }).slice(0, 5).join('\n');

    const MAX_PROPS_PER_SCOPE = 80;
    let closuresSeen = 0;
    for (const scope of (caller.scopeChain || [])) {
        if (!['local', 'closure', 'block'].includes(scope.type)) continue;
        if (scope.type === 'closure') {
            if (closuresSeen >= 1) continue;
            closuresSeen++;
        }
        const scopeObjectId = scope.object && scope.object.objectId;
        if (!scopeObjectId) continue;

        let props;
        try {
            const resp = await cdpSession.send('Runtime.getProperties', {
                objectId: scopeObjectId, ownProperties: true
            });
            props = (resp.result || []).slice(0, MAX_PROPS_PER_SCOPE);
        } catch (e) { continue; }

        for (const prop of props) {
            const value = prop.value || {};

            if (value.type === 'string' && value.value) {
                inputs.push({ name: prop.name, kind: 'string', value: value.value.substring(0, 1024) });
            } else if (['arraybuffer', 'typedarray', 'dataview'].includes(value.subtype) && value.objectId) {
                try {
                    const decoded = await cdpSession.send('Runtime.callFunctionOn', {
                        objectId: value.objectId, functionDeclaration: DECODE_FN, returnByValue: true
                    });
                    if (decoded.result && decoded.result.value) {
                        inputs.push({ name: prop.name, kind: value.subtype, ...decoded.result.value });
                    }
                } catch (e) {}
            } else if (value.type === 'object' && value.className === 'Object' && value.objectId) {
                try {
                    const jsonResp = await cdpSession.send('Runtime.callFunctionOn', {
                        objectId: value.objectId,
                        functionDeclaration: 'function(){ try { return JSON.stringify(this); } catch(e) { return null; } }',
                        returnByValue: true
                    });
                    if (jsonResp.result && jsonResp.result.value) {
                        inputs.push({ name: prop.name, kind: 'object', value: jsonResp.result.value.substring(0, 2048) });
                    }
                } catch (e) {}
            }
        }
    }

    console.log(`\n${C.hlred}[🔓 CRYPTO BOUNDARY] ${method}${C.reset} in ${C.magenta}${targetLabel}${C.reset} called by ${C.yellow}${callerName}${C.reset}`);
    console.log(`${C.dim}${stackTrace}${C.reset}`);

    for (const input of inputs) {
        if (input.kind === 'string' && input.value.length > 0) {
            console.log(`   ${C.cyan}${input.name}${C.reset} (string): ${C.green}${input.value}${C.reset}`);
        } else if (input.kind === 'object') {
            console.log(`   ${C.cyan}${input.name}${C.reset} (object): ${C.green}${input.value}${C.reset}`);
        } else if (input.utf8 !== undefined) {
            const printable = /^[\x20-\x7E\s]*$/.test(input.utf8);
            if (printable && input.utf8.trim().length > 0) {
                console.log(`   ${C.cyan}${input.name}${C.reset} (${input.kind}, ${input.length}B utf8): ${C.green}${input.utf8}${C.reset}`);
            } else {
                console.log(`   ${C.cyan}${input.name}${C.reset} (${input.kind}, ${input.length}B): ${C.dim}${input.hex.substring(0, 128)}${C.reset}`);
            }
        }
    }

    writeLog({
        type: 'crypto_call',
        method,
        target: targetLabel,
        caller: callerName,
        stack: frames.map(f => ({ fn: f.functionName, url: f.url, line: f.location.lineNumber, col: f.location.columnNumber })),
        inputs: inputs.map(i => ({ name: i.name, kind: i.kind, value: i.value || i.hex || i.utf8 }))
    });
}

async function armCryptoBreakpoints(cdpSession, targetLabel, bpMap) {
    let armed = 0;
    for (const method of SUBTLE_METHODS) {
        try {
            const fn = await cdpSession.send('Runtime.evaluate', {
                expression: `crypto.subtle.${method}`, silent: true
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
