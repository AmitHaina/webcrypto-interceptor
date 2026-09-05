// Invisible hooks on arbitrary site functions, driven by --hook / --hook-return.
//
// Mechanism (breakpoint-based, nothing is wrapped or replaced):
//   1. Runtime.evaluate resolves the user expression to a live function
//      objectId *per execution context* (window differs per frame/worker).
//   2. Debugger.setBreakpointOnFunctionCall(objectId) pauses the page on
//      every call — fn.toString(), Proxy traps and monkeypatch detectors
//      still see the untouched native function.
//   3. For --hook-return, the first entry pause reveals the function's
//      location; Debugger.getPossibleBreakpoints(restrictToFunction) then
//      arms breakpoints on every `return` location, where the top frame's
//      returnValue is readable while the arguments are still in scope.
//      That yields (input -> output) pairs — the corpus format consumed
//      by scripts/verify-reimpl.js.
//
// State is per CDP session: executionContextIds are only unique within one
// session, so session-scoped maps (WeakMap on the session) avoid collisions
// between concurrently attached targets.
const { C } = require('../util/colors');
const { writeLog } = require('../util/log');
const { shortUrl } = require('../util/decoders');
const { trackEvent } = require('../util/summary');
const { HOOK_MAX_RECORDS, HOOK_PRINT_FIRST, HOOK_PRINT_EVERY } = require('../config');

const ARGS_EXPR = 'JSON.stringify(Array.prototype.slice.call(arguments))';

// Per-session hook state. hookSpecs: [{ expr, captureReturn }]
function createHookState(hookSpecs) {
    const specs = (hookSpecs || []).map(s => ({
        expr: s.expr,
        label: s.expr,
        captureReturn: !!s.captureReturn,
        records: 0,          // call records stored (capped)
        pairs: 0,            // (input,output) pairs stored
        seen: 0,             // total pauses seen (for print throttle)
        returnBpsSet: false  // return-location breakpoints armed yet?
    }));
    return {
        specs,
        callBp: new Map(),   // breakpointId -> spec index
        retBp: new Map()     // breakpointId -> spec index
    };
}

// Session-scoped bookkeeping of what was armed per execution context.
// Keyed WeakMap(session) -> Map(contextId -> { breakpointIds, objectIds })
// so two targets that both use contextId 1 never collide (the crypto
// armer previously keyed by contextId alone and hit exactly that).
const sessionArmed = new WeakMap();

function armedFor(session) {
    let m = sessionArmed.get(session);
    if (!m) { m = new Map(); sessionArmed.set(session, m); }
    return m;
}

async function armHooks(cdpSession, hookState, targetLabel, contextId) {
    if (!hookState.specs.length) return 0;
    const perContext = { breakpointIds: [], objectIds: [] };
    let armed = 0;
    for (let i = 0; i < hookState.specs.length; i++) {
        const spec = hookState.specs[i];
        try {
            const fn = await cdpSession.send('Runtime.evaluate', {
                expression: spec.expr,
                contextId,
                silent: true
            });
            if (!(fn.result && fn.result.type === 'function' && fn.result.objectId)) continue;
            perContext.objectIds.push(fn.result.objectId);
            const bp = await cdpSession.send('Debugger.setBreakpointOnFunctionCall', {
                objectId: fn.result.objectId
            });
            if (bp.breakpointId) {
                hookState.callBp.set(bp.breakpointId, i);
                perContext.breakpointIds.push(bp.breakpointId);
                armed++;
            }
        } catch (e) { /* expression may not resolve in this context */ }
    }
    if (armed) {
        armedFor(cdpSession).set(contextId, perContext);
        console.log(`${C.magenta}[🪝 HOOK ARMED]${C.reset} ${armed} function hook(s) on ${C.cyan}${targetLabel}${C.reset} (context ${contextId})`);
    }
    return armed;
}

// Tear down everything armed for contexts that just died.
async function cleanupHookContexts(cdpSession, destroyedContextIds, hookState) {
    const perSession = armedFor(cdpSession);
    for (const contextId of destroyedContextIds) {
        const record = perSession.get(contextId);
        if (!record) continue;
        for (const bpId of record.breakpointIds) {
            try { await cdpSession.send('Debugger.removeBreakpoint', { breakpointId: bpId }); } catch (e) {}
            hookState.callBp.delete(bpId);
            // return-location breakpoints are function-scoped, not context-
            // scoped, but a destroyed context means the function instance is
            // gone — drop its ret breakpoints too (best effort, id-mapped).
        }
        for (const objectId of record.objectIds) {
            try { await cdpSession.send('Runtime.releaseObject', { objectId }); } catch (e) {}
        }
        perSession.delete(contextId);
    }
}

// Lazily arm breakpoints on every `return` location of the hooked function.
// Done on first entry pause because getPossibleBreakpoints needs the
// function's concrete script location, which the paused frame provides.
async function setReturnBreakpoints(cdpSession, hookState, specIdx, topFrame) {
    const spec = hookState.specs[specIdx];
    const loc = topFrame.functionLocation;
    if (!loc) return 0;
    let locations = [];
    try {
        const r = await cdpSession.send('Debugger.getPossibleBreakpoints', {
            start: loc,
            restrictToFunction: true
        });
        locations = r.locations || [];
    } catch (e) { return 0; }
    let count = 0;
    for (const rl of locations) {
        if (rl.type !== 'return') continue;
        try {
            const bp = await cdpSession.send('Debugger.setBreakpoint', { location: rl });
            if (bp.breakpointId) {
                hookState.retBp.set(bp.breakpointId, specIdx);
                count++;
            }
        } catch (e) {}
    }
    if (!count) {
        console.log(`${C.yellow}[🪝 HOOK] no return location found for ${spec.label} — corpus stays call-args-only${C.reset}`);
    }
    return count;
}

async function readArgs(cdpSession, callFrameId) {
    try {
        const r = await cdpSession.send('Debugger.evaluateOnCallFrame', {
            callFrameId,
            expression: ARGS_EXPR,
            returnByValue: true,
            silent: true
        });
        const v = r.result && r.result.value;
        if (typeof v === 'string') {
            try { return JSON.parse(v); } catch (e) { return v; }
        }
        return v;
    } catch (e) {
        return `<args unavailable: ${String(e.message || e).substring(0, 80)}>`;
    }
}

// Entry pause on a hooked function: log the call, and lazily arm return
// breakpoints when the hook wants (input,output) pairs.
async function recordHookCall(cdpSession, hookState, specIdx, params, targetLabel) {
    const spec = hookState.specs[specIdx];
    const frames = params.callFrames || [];
    const top = frames[0];
    spec.seen++;

    if (spec.captureReturn && !spec.returnBpsSet) {
        spec.returnBpsSet = true;
        try { await setReturnBreakpoints(cdpSession, hookState, specIdx, top); } catch (e) {}
    }

    if (spec.records < HOOK_MAX_RECORDS) {
        spec.records++;
        const args = await readArgs(cdpSession, top.callFrameId);
        const stack = frames.slice(0, 5).map(f => ({
            fn: f.functionName || '<anonymous>',
            url: f.url ? shortUrl(f.url) : '<anonymous>',
            line: f.location ? f.location.lineNumber + 1 : 0
        }));
        writeLog({ type: 'hook_call', hook: spec.label, target: targetLabel, fn: top.functionName || '<anonymous>', args, stack });
        trackEvent('hook_call');
    }

    if (spec.seen <= HOOK_PRINT_FIRST || spec.seen % HOOK_PRINT_EVERY === 0) {
        console.log(`${C.hlyel}[🪝 HOOK]${C.reset} ${C.bold}${spec.label}${C.reset} call #${spec.seen} in ${C.magenta}${targetLabel}${C.reset}`);
    }
}

// Return-location pause: arguments still in scope, returnValue available on
// the top frame -> (input, output) corpus pair for the verification oracle.
async function recordHookPair(cdpSession, hookState, specIdx, params, targetLabel) {
    const spec = hookState.specs[specIdx];
    const frames = params.callFrames || [];
    const top = frames[0];
    if (!top) return;
    spec.seen++;

    const rv = top.returnValue || {};
    let output = rv.value;
    if (output === undefined && rv.type) {
        // Objects / ArrayBuffers don't serialize by value here; keep the
        // description so the corpus still shows *something* actionable.
        output = null;
        writeLog({
            type: 'hook_pair_unserialized', hook: spec.label, target: targetLabel,
            output_type: rv.subtype || rv.type, description: (rv.description || '').substring(0, 200)
        });
    }

    if (spec.pairs < HOOK_MAX_RECORDS) {
        spec.pairs++;
        const input = await readArgs(cdpSession, top.callFrameId);
        writeLog({
            type: 'hook_pair', hook: spec.label, target: targetLabel,
            input, output: output === undefined ? null : output,
            output_type: rv.type || null
        });
        trackEvent('hook_pair');
    }

    if (spec.seen <= HOOK_PRINT_FIRST || spec.seen % HOOK_PRINT_EVERY === 0) {
        const preview = JSON.stringify(output) || 'undefined';
        console.log(`${C.hlyel}[🪝 HOOK PAIR]${C.reset} ${C.bold}${spec.label}${C.reset} #${spec.seen} -> ${C.green}${preview.substring(0, 160)}${C.reset} ${C.dim}(${targetLabel})${C.reset}`);
    }
}

// Returns true if this pause belonged to a hook (caller still resumes).
async function handleHookPause(cdpSession, params, hookState, targetLabel) {
    if (!hookState.specs.length) return false;
    const hit = params.hitBreakpoints || [];
    const frames = params.callFrames || [];
    if (!frames.length) return false;

    // Return-location hits are checked first: a location can in principle
    // collide with nothing else, and the pair is the rarer, higher-value event.
    let retIdx;
    for (const b of hit) { const v = hookState.retBp.get(b); if (v !== undefined) { retIdx = v; break; } }
    if (retIdx !== undefined) {
        await recordHookPair(cdpSession, hookState, retIdx, params, targetLabel);
        return true;
    }

    let callIdx;
    for (const b of hit) { const v = hookState.callBp.get(b); if (v !== undefined) { callIdx = v; break; } }
    if (callIdx === undefined) return false;

    await recordHookCall(cdpSession, hookState, callIdx, params, targetLabel);
    return true;
}

module.exports = { createHookState, armHooks, cleanupHookContexts, handleHookPause };
