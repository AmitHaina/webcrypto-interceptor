// Tests for src/cdp/heapdiff.js — the pure snapshot parser + differ.
// Synthetic V8 heap snapshots are built to the real format contract: flat
// node/edge int arrays, string table, meta-driven field layout, to_node as a
// BYTE offset into the nodes array.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSnapshot, diffSnapshots } = require('../src/cdp/heapdiff');

const NODE_TYPES = ['(hidden)', 'object', 'closure', 'string', 'concatenated string', 'sliced string'];
const EDGE_TYPES = ['context', 'element', 'property', 'internal', 'shortcut', 'hidden'];
const NW = 5; // type, name, id, self_size, edge_count
const EW = 3; // type, name_or_index, to_node

// spec: array of { type, name, id, selfSize?, edges?: [{ type, name, to }] }
// where `to` is the target node INDEX. Returns a raw V8-snapshot-shaped object.
function buildSnapshot(spec) {
    const strings = [];
    const addString = (s) => {
        let i = strings.indexOf(s);
        if (i < 0) { strings.push(s); i = strings.length - 1; }
        return i;
    };
    // Layout: edges are consecutive in node order -> compute each node's start.
    let running = 0;
    const starts = spec.map(n => { const s = running; running += (n.edges || []).length; return s; });
    const flatEdges = new Array(running * EW).fill(0);
    spec.forEach((n, i) => {
        (n.edges || []).forEach((e, k) => {
            const base = (starts[i] + k) * EW;
            flatEdges[base] = EDGE_TYPES.indexOf(e.type);
            flatEdges[base + 1] = typeof e.name === 'string' ? addString(e.name) : (e.name || 0);
            flatEdges[base + 2] = e.to * NW; // to_node = BYTE offset into nodes
        });
    });
    const nodes = [];
    spec.forEach(n => {
        nodes.push(
            NODE_TYPES.indexOf(n.type),
            addString(n.name),
            n.id,
            n.selfSize || 0,
            (n.edges || []).length
        );
    });
    return {
        snapshot: {
            meta: {
                node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
                edge_fields: ['type', 'name_or_index', 'to_node'],
                node_types: [NODE_TYPES],
                edge_types: [EDGE_TYPES]
            },
            node_count: spec.length
        },
        nodes,
        edges: flatEdges,
        strings
    };
}

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

function beforeSnapshot() {
    return buildSnapshot([
        { type: 'object', name: 'Window', id: 1, edges: [{ type: 'property', name: 'w', to: 1 }] },
        { type: 'string', name: 'old', id: 10 }
    ]);
}

function afterSnapshot() {
    return buildSnapshot([
        // idx 0-1: pre-existing (same ids as before) -> not new
        { type: 'object', name: 'Window', id: 1, edges: [{ type: 'property', name: 'w', to: 1 }] },
        { type: 'string', name: 'old', id: 10 },
        // idx 2-4: user-retained new string + JWT, held by an object
        { type: 'object', name: 'SessionStore', id: 2, edges: [
            { type: 'property', name: 'token', to: 3 },
            { type: 'property', name: 'auth', to: 4 }
        ] },
        { type: 'string', name: 'supersecret123', id: 11 },
        { type: 'string', name: JWT, id: 12 },
        // idx 5-8: concatenated string "de"+"coded" held by a closure
        { type: 'closure', name: 'decodeFn', id: 3, edges: [{ type: 'property', name: 'cache', to: 6 }] },
        { type: 'concatenated string', name: '(concatenated string)', id: 13, edges: [
            { type: 'internal', name: 'first', to: 7 },
            { type: 'internal', name: 'second', to: 8 }
        ] },
        { type: 'string', name: 'de', id: 14 },
        { type: 'string', name: 'coded', id: 15 },
        // idx 9-10: system-retained noise: only a "(hidden)" node holds it -> filtered out
        { type: 'string', name: 'V8TypeNameNoise', id: 16 },
        { type: '(hidden)', name: '(system)', id: 4, edges: [{ type: 'hidden', name: 'x', to: 9 }] },
        // idx 11: typed array
        { type: 'object', name: 'Uint8Array', id: 5, selfSize: 64 },
        // idx 12-14: duplicate value across two nodes -> reported once
        { type: 'object', name: 'DupHolder', id: 6, edges: [
            { type: 'property', name: 'a', to: 13 },
            { type: 'property', name: 'b', to: 14 }
        ] },
        { type: 'string', name: 'dup_value_x', id: 17 },
        { type: 'string', name: 'dup_value_x', id: 18 }
    ]);
}

test('diff finds new user-retained strings and resolves concatenated chains', () => {
    const before = parseSnapshot(beforeSnapshot());
    const after = parseSnapshot(afterSnapshot());
    const d = diffSnapshots(before, after);

    assert.ok(d.new_strings.includes('supersecret123'));
    assert.ok(d.new_strings.includes('decoded'), 'concatenated string must resolve to its real value');
    assert.ok(d.new_strings.includes(JWT));
    assert.equal(d.new_strings.filter(v => v === 'dup_value_x').length, 1, 'duplicate values reported once');
    assert.ok(!d.new_strings.includes('V8TypeNameNoise'), 'system-retained noise filtered by user-retainer check');
    assert.ok(!d.new_strings.includes('old'), 'pre-existing strings are not new');
});

test('diff classifies secret-shaped strings', () => {
    const before = parseSnapshot(beforeSnapshot());
    const after = parseSnapshot(afterSnapshot());
    const d = diffSnapshots(before, after);
    const jwt = d.secrets.find(s => s.type === 'JWT');
    assert.ok(jwt, 'JWT in the heap diff must be classified');
    assert.equal(jwt.value, JWT);
});

test('diff counts new objects by constructor and lists typed arrays', () => {
    const before = parseSnapshot(beforeSnapshot());
    const after = parseSnapshot(afterSnapshot());
    const d = diffSnapshots(before, after);

    assert.equal(d.new_objects_by_constructor.SessionStore, 1);
    assert.equal(d.new_objects_by_constructor.Uint8Array, 1);
    assert.equal(d.new_objects_by_constructor.Window, undefined, 'pre-existing objects excluded');
    assert.deepEqual(d.new_buffers, [{ type: 'Uint8Array', size: 64 }]);
    assert.equal(d.totals.new_buffers, 1);
    assert.equal(d.totals.distinct_new_strings, 4, 'supersecret123 + JWT + decoded + dup_value_x');
});

test('diff with identical snapshots is empty', () => {
    const raw = beforeSnapshot();
    const d = diffSnapshots(parseSnapshot(raw), parseSnapshot(JSON.parse(JSON.stringify(raw))));
    assert.deepEqual(d.new_strings, []);
    assert.deepEqual(d.secrets, []);
    assert.deepEqual(d.new_buffers, []);
    assert.equal(d.totals.new_objects, 0);
});

test('parseSnapshot rejects malformed input', () => {
    assert.throws(() => parseSnapshot({}), /not a V8 heap snapshot/);
});
