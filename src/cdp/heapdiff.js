// Heap snapshot diff — find what an action *allocated*.
//
// Two V8 heap snapshots are taken N seconds apart (page session). Every heap
// node id in the second snapshot that was not in the first is a new object.
// Decoded secrets that never transit the network or the crypto boundary —
// plaintext built in JS and kept in a closure — show up here as new strings.
//
// The snapshot format is one JSON blob: flat `nodes` int array (each node is
// node_fields.length ints), flat `edges` int array laid out consecutively in
// node order, and a `strings` table. Field layout is read from snapshot.meta
// (Chrome versions differ — some drop trace_node_id), never hardcoded.
//
// V8 lazily flattens "a"+"b": a freshly built value stays a "concatenated
// string" (or "sliced string" from .slice) until accessed, so a value search
// that wants runtime-built tokens must resolve all three node kinds.
//
// parseSnapshot/diffSnapshots are pure (no CDP) and unit-tested; the CDP
// chunk assembly lives in takeSnapshot.

const { C } = require('../util/colors');
const { writeLog } = require('../util/log');
const { trackEvent, trackSecret, trackHeapDiff } = require('../util/summary');

const STRING_TYPES = new Set(['string', 'concatenated string', 'sliced string']);
const USER_RETAINER_EDGE_TYPES = new Set(['property', 'element']);
const USER_RETAINER_NODE_TYPES = new Set(['object', 'closure']);
const TYPED_ARRAYS = new Set(['ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array',
    'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
    'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']);

function parseSnapshot(data) {
    if (!data || !data.snapshot || !data.snapshot.meta) {
        throw new Error('not a V8 heap snapshot (missing snapshot.meta)');
    }
    const meta = data.snapshot.meta;
    const nodeFields = meta.node_fields, edgeFields = meta.edge_fields;
    return {
        nodes: data.nodes,
        edges: data.edges,
        strings: data.strings,
        nodeCount: data.snapshot.node_count,
        nw: nodeFields.length,
        ew: edgeFields.length,
        fType: nodeFields.indexOf('type'),
        fName: nodeFields.indexOf('name'),
        fId: nodeFields.indexOf('id'),
        fSize: nodeFields.indexOf('self_size'),
        fEdges: nodeFields.indexOf('edge_count'),
        eType: edgeFields.indexOf('type'),
        eName: edgeFields.indexOf('name_or_index'),
        eTo: edgeFields.indexOf('to_node'),
        nodeTypes: meta.node_types[0],
        edgeTypes: meta.edge_types[0]
    };
}

// Node accessors — index math in one place.
function nodeType(s, i) { return s.nodeTypes[s.nodes[i * s.nw + s.fType]]; }
function nodeName(s, i) { return s.strings[s.nodes[i * s.nw + s.fName]]; }
function nodeId(s, i) { return s.nodes[i * s.nw + s.fId]; }
function nodeSelfSize(s, i) { return s.nodes[i * s.nw + s.fSize]; }
function nodeEdgeCount(s, i) { return s.nodes[i * s.nw + s.fEdges]; }

// First-edge offsets: edges are laid out consecutively in node order.
function buildEdgeOffset(s) {
    const offset = new Array(s.nodeCount);
    let running = 0;
    for (let i = 0; i < s.nodeCount; i++) {
        offset[i] = running;
        running += s.nodes[i * s.nw + s.fEdges];
    }
    return offset;
}

// node index -> [{ edgeType, rawName, to }]
function edgesOf(s, i, offset) {
    const first = offset[i];
    const out = [];
    for (let k = 0; k < nodeEdgeCount(s, i); k++) {
        const base = (first + k) * s.ew;
        out.push({
            edgeType: s.edgeTypes[s.edges[base + s.eType]],
            rawName: s.edges[base + s.eName],
            to: s.edges[base + s.eTo] / s.nw
        });
    }
    return out;
}

// Reverse-edge index (node -> its retainers), built once, lazily.
function buildRetainers(s) {
    const offset = buildEdgeOffset(s);
    const retainers = new Map(); // node idx -> [{ from, edgeType, rawName }]
    for (let i = 0; i < s.nodeCount; i++) {
        const first = offset[i];
        for (let k = 0; k < nodeEdgeCount(s, i); k++) {
            const base = (first + k) * s.ew;
            const target = s.edges[base + s.eTo] / s.nw;
            let list = retainers.get(target);
            if (!list) { list = []; retainers.set(target, list); }
            list.push({ from: i, edgeType: s.edgeTypes[s.edges[base + s.eType]], rawName: s.edges[base + s.eName] });
        }
    }
    return retainers;
}

function edgeLabel(s, edgeType, rawName) {
    switch (edgeType) {
        case 'property': case 'internal': case 'context': case 'shortcut': case 'hidden':
            return s.strings[rawName];
        default:
            return rawName; // element edges carry the index
    }
}

// A fresh value is only "live" if a JS object or closure holds it — V8
// internals retain type-name strings and other noise via system edges.
function hasUserRetainer(s, idx, retainers) {
    const list = retainers.get(idx);
    if (!list) return false;
    for (const r of list) {
        if (USER_RETAINER_EDGE_TYPES.has(r.edgeType) && USER_RETAINER_NODE_TYPES.has(nodeType(s, r.from))) {
            return true;
        }
    }
    return false;
}

// Resolve concatenated/sliced strings to the real value via their internal
// edges ("first"/"second"/"parent"). Depth-capped against pathological chains.
function resolveString(s, idx, offset, depth) {
    const kind = nodeType(s, idx);
    if (depth < 64 && kind === 'concatenated string') {
        let first = '', second = '';
        for (const e of edgesOf(s, idx, offset)) {
            if (e.edgeType !== 'internal') continue;
            const label = edgeLabel(s, e.edgeType, e.rawName);
            if (label === 'first') first = resolveString(s, e.to, offset, depth + 1);
            else if (label === 'second') second = resolveString(s, e.to, offset, depth + 1);
        }
        return first + second;
    }
    if (depth < 64 && kind === 'sliced string') {
        for (const e of edgesOf(s, idx, offset)) {
            if (e.edgeType === 'internal' && edgeLabel(s, e.edgeType, e.rawName) === 'parent') {
                return resolveString(s, e.to, offset, depth + 1);
            }
        }
    }
    return nodeName(s, idx);
}

function diffSnapshots(before, after, opts) {
    const options = opts || {};
    const maxStrings = options.maxStrings || 200;
    const maxObjects = options.maxObjects || 30;

    // Heap ids are stable across snapshots: an id present in `before` is not new.
    const oldIds = new Set();
    for (let i = 0; i < before.nodeCount; i++) oldIds.add(nodeId(before, i));

    const retainers = buildRetainers(after);
    const offset = buildEdgeOffset(after);

    const stringSet = new Set();
    const strings = [];
    let overflowStrings = 0;
    const constructors = Object.create(null);
    const buffers = [];

    for (let i = 0; i < after.nodeCount; i++) {
        if (oldIds.has(nodeId(after, i))) continue;
        const kind = nodeType(after, i);
        if (STRING_TYPES.has(kind)) {
            const value = resolveString(after, i, offset, 0);
            if (value && value.length > 3 && !stringSet.has(value) && hasUserRetainer(after, i, retainers)) {
                stringSet.add(value);
                if (strings.length < maxStrings) strings.push(value);
                else overflowStrings++;
            }
        } else if (kind === 'object') {
            const ctor = nodeName(after, i);
            constructors[ctor] = (constructors[ctor] || 0) + 1;
            if (TYPED_ARRAYS.has(ctor)) {
                buffers.push({ type: ctor, size: nodeSelfSize(after, i) });
            }
        }
    }

    strings.sort((a, b) => b.length - a.length);
    buffers.sort((a, b) => b.size - a.size);

    // Classify the new strings with the shared secrets scanner — anything the
    // page decoded into key/JWT/credential shape gets surfaced first.
    let secrets = [];
    try {
        const { scanForSecrets } = require('../util/secrets');
        const body = strings.join('\n');
        secrets = scanForSecrets(body, 'heap-diff');
    } catch (e) { /* scanner unavailable — strings are still reported */ }

    const topObjects = Object.entries(constructors)
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxObjects);

    return {
        new_strings: strings,
        secrets,
        new_objects_by_constructor: Object.fromEntries(topObjects),
        new_buffers: buffers.slice(0, maxObjects),
        totals: {
            distinct_new_strings: strings.length + overflowStrings,
            new_objects: Object.values(constructors).reduce((a, b) => a + b, 0),
            new_buffers: buffers.length
        }
    };
}

// ---- CDP layer -------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Take one snapshot: collect addHeapSnapshotChunk events, then poll-parse —
// the reply lands before the dispatcher has drained every chunk, and the
// blob is complete exactly when it parses as JSON.
function takeSnapshot(cdpSession, timeoutMs) {
    const timeout = timeoutMs || 120000;
    return new Promise((resolve, reject) => {
        const chunks = [];
        const onChunk = (p) => chunks.push(p.chunk);
        cdpSession.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
        const cleanup = () => { try { cdpSession.off('HeapProfiler.addHeapSnapshotChunk', onChunk); } catch (e) {} };
        (async () => {
            try {
                await cdpSession.send('HeapProfiler.enable');
                await cdpSession.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
                const deadline = Date.now() + timeout;
                while (Date.now() < deadline) {
                    try {
                        const data = JSON.parse(chunks.join(''));
                        cleanup();
                        return resolve(data);
                    } catch (e) { await sleep(100); }
                }
                cleanup();
                reject(new Error(`heap snapshot did not assemble within ${timeout / 1000}s`));
            } catch (e) {
                cleanup();
                reject(e);
            }
        })();
    });
}

// Snapshot -> wait -> snapshot -> diff -> report. Fire-and-forget from the
// capture loop; never throws into the caller's path.
async function runHeapDiff(cdpSession, targetLabel, afterSeconds) {
    try {
        console.log(`\n${C.magenta}[🧠 HEAP DIFF]${C.reset} taking baseline snapshot on ${C.cyan}${targetLabel}${C.reset}...`);
        const t0 = Date.now();
        const before = parseSnapshot(await takeSnapshot(cdpSession));
        console.log(`${C.dim}[🧠 HEAP DIFF] baseline: ${before.nodeCount} objects (${((Date.now() - t0) / 1000).toFixed(1)}s). Waiting ${afterSeconds}s of page activity...${C.reset}`);

        await sleep(afterSeconds * 1000);

        const t1 = Date.now();
        const after = parseSnapshot(await takeSnapshot(cdpSession));
        const diff = diffSnapshots(before, after);

        console.log(`${C.dim}[🧠 HEAP DIFF] second snapshot: ${after.nodeCount} objects (${((Date.now() - t1) / 1000).toFixed(1)}s). Diffing...${C.reset}\n`);
        writeReport(diff, targetLabel, afterSeconds);

        trackEvent('heap_diff');
        trackHeapDiff();
        for (let i = 0; i < diff.secrets.length; i++) trackSecret(true);
        writeLog({
            type: 'heap_diff',
            target: targetLabel,
            after_seconds: afterSeconds,
            secrets: diff.secrets,
            new_strings: diff.new_strings,
            new_objects_by_constructor: diff.new_objects_by_constructor,
            new_buffers: diff.new_buffers,
            totals: diff.totals
        });

        // Surface classified secrets through the shared reporter (dedupes
        // against network/script findings, logs secret_found events).
        if (diff.secrets.length) {
            const { reportSecrets } = require('../util/secrets');
            reportSecrets(diff.secrets, 'heap-diff');
        }
        return diff;
    } catch (e) {
        console.warn(`${C.yellow}[🧠 HEAP DIFF] failed: ${e.message}${C.reset}`);
        writeLog({ type: 'heap_diff_error', target: targetLabel, error: e.message });
        return null;
    }
}

function writeReport(diff, targetLabel, afterSeconds) {
    const t = diff.totals;
    console.log(`${C.bold}[🧠 HEAP DIFF] what ${afterSeconds}s of activity allocated on ${targetLabel}:${C.reset}`);
    console.log(`${C.dim}  new strings: ${t.distinct_new_strings} (user-retained) | new objects: ${t.new_objects} | new buffers: ${t.new_buffers}${C.reset}`);

    if (diff.secrets.length) {
        console.log(`${C.hlred}  🔑 ${diff.secrets.length} secret-shaped value(s) among them — see [🔑 SECRET] lines / JSONL${C.reset}`);
    }
    const shown = diff.new_strings.slice(0, 25);
    if (shown.length) {
        console.log(`${C.dim}  longest new strings:${C.reset}`);
        for (const s of shown) {
            console.log(`    ${C.green}${s.length}B ${s.substring(0, 120).replace(/\n/g, '\\n')}${C.reset}`);
        }
        if (diff.new_strings.length > shown.length) {
            console.log(`${C.dim}    ... and ${diff.new_strings.length - shown.length} more in the JSONL log${C.reset}`);
        }
    }
    if (diff.new_buffers.length) {
        console.log(`${C.dim}  new typed arrays:${C.reset}`);
        for (const b of diff.new_buffers.slice(0, 10)) {
            console.log(`    ${C.blue}${b.type} ${b.size}B${C.reset}`);
        }
    }
    console.log('');
}

module.exports = { parseSnapshot, diffSnapshots, takeSnapshot, runHeapDiff };
