const { C } = require('../util/colors');
const { writeLog } = require('../util/log');
const { shortUrl } = require('../util/decoders');
const { SUBTLE_METHODS } = require('../config');

// Deep dump function executed in the target page's V8 context.
// Recursively expands objects; decodes TypedArray/ArrayBuffer/CryptoKey.
const DEEP_DUMP_FN = `function(depth){
    depth = depth || 2;
    var MAX_STRING = 512;
    var MAX_KEYS = 24;
    function dumpBytes(u, name){
        var hex = '', utf8 = '';
        var limit = Math.min(u.length, 512);
        for (var i = 0; i < limit; i++) hex += (u[i] < 16 ? '0' : '') + u[i].toString(16);
        try { utf8 = new TextDecoder('utf-8', {fatal:false}).decode(u.subarray(0, 512)); } catch(e){}
        return { __t: name || 'Bytes', len: u.length, hex: hex, utf8: utf8 };
    }
    function dump(v, d){
        if (v === null || v === undefined) return v;
        var t = typeof v;
        if (t === 'string') return v.length > MAX_STRING ? v.substring(0, MAX_STRING) + '...' : v;
        if (t === 'number' || t === 'boolean') return v;
        if (t === 'function') return '[function]';
        if (v instanceof ArrayBuffer) return dumpBytes(new Uint8Array(v), 'ArrayBuffer');
        if (ArrayBuffer.isView(v)) return dumpBytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), v.constructor && v.constructor.name);
        if (typeof CryptoKey !== 'undefined' && v instanceof CryptoKey) {
            return { __t: 'CryptoKey', type: v.type, extractable: v.extractable, algorithm: v.algorithm, usages: v.usages };
        }
        if (Array.isArray(v)) {
            if (d <= 0) return '[Array len=' + v.length + ']';
            return v.slice(0, 8).map(function(x){ return dump(x, d - 1); });
        }
        if (t === 'object') {
            if (d <= 0) return '[Object]';
            var out = {};
            var keys;
            try { keys = Object.keys(v).slice(0, MAX_KEYS); } catch(e){ return '[unreadable object]'; }
            for (var i = 0; i < keys.length; i++) {
                try { out[keys[i]] = dump(v[keys[i]], d - 1); } catch(e){ out[keys[i]] = '[unreadable]'; }
            }
            return out;
        }
        return String(v);
    }
    return dump(this, depth);
}`;

async function deepDump(cdpSession, objectId) {
    try {
        const resp = await cdpSession.send('Runtime.callFunctionOn', {
            objectId, functionDeclaration: DEEP_DUMP_FN, returnByValue: true, arguments: [{ value: 2 }]
        });
        return resp.result && resp.result.value;
    } catch (e) { return null; }
}

// Compact single-line renderer for the deep-dumped structure.
function renderValue(v, depth) {
    if (v === null || v === undefined) return String(v);
    if (typeof v !== 'object') return String(v);
    if (v.__t) {
        // Byte-like or CryptoKey
        if (v.__t === 'CryptoKey') {
            return `CryptoKey{type=${v.type}, alg=${JSON.stringify(v.algorithm)}, usages=[${(v.usages || []).join(',')}]}`;
        }
        const printable = v.utf8 && /^[\x20-\x7E\s]*$/.test(v.utf8) && v.utf8.trim().length > 0;
        if (printable) return `${v.__t}(${v.len}B) utf8="${v.utf8.substring(0, 200)}"`;
        return `${v.__t}(${v.len}B) hex=${(v.hex || '').substring(0, 128)}`;
    }
    if (depth <= 0) return Array.isArray(v) ? `[array len=${v.length}]` : '{...}';
    if (Array.isArray(v)) return '[' + v.map(x => renderValue(x, depth - 1)).join(', ') + ']';
    const parts = [];
    for (const k of Object.keys(v)) parts.push(`${k}: ${renderValue(v[k], depth - 1)}`);
    return '{ ' + parts.join(', ') + ' }';
}

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
                inputs.push({ name: prop.name, kind: 'string', rendered: value.value.substring(0, 1024), raw: value.value });
            } else if (value.type === 'object' && value.objectId) {
                const dumped = await deepDump(cdpSession, value.objectId);
                if (dumped !== null && dumped !== undefined) {
                    inputs.push({ name: prop.name, kind: value.subtype || value.className || 'object', rendered: renderValue(dumped, 3), raw: dumped });
                }
            }
        }
    }

    // Also dump `this` of the caller — sometimes the plaintext is stashed as an instance field.
    if (caller.this && caller.this.objectId && caller.this.className !== 'global' && caller.this.type !== 'undefined') {
        const dumped = await deepDump(cdpSession, caller.this.objectId);
        if (dumped && typeof dumped === 'object' && Object.keys(dumped).length > 0 && Object.keys(dumped).length < 30) {
            inputs.push({ name: 'this', kind: caller.this.className || 'object', rendered: renderValue(dumped, 3), raw: dumped });
        }
    }

    console.log(`\n${C.hlred}[🔓 CRYPTO BOUNDARY] ${method}${C.reset} in ${C.magenta}${targetLabel}${C.reset} called by ${C.yellow}${callerName}${C.reset}`);
    console.log(`${C.dim}${stackTrace}${C.reset}`);

    for (const input of inputs) {
        console.log(`   ${C.cyan}${input.name}${C.reset} (${input.kind}): ${C.green}${input.rendered}${C.reset}`);
    }

    writeLog({
        type: 'crypto_call',
        method,
        target: targetLabel,
        caller: callerName,
        stack: frames.map(f => ({ fn: f.functionName, url: f.url, line: f.location.lineNumber, col: f.location.columnNumber })),
        inputs: inputs.map(i => ({ name: i.name, kind: i.kind, value: i.raw !== undefined ? i.raw : i.rendered }))
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
