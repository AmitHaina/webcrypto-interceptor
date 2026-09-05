// Tests for scripts/verify-reimpl.js — the pure corpus extraction and the
// strict comparison logic that decides whether a reimplementation ships.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractPairs, deepEqual } = require('../scripts/verify-reimpl');

const jsonl = [
    JSON.stringify({ timestamp: 't', type: 'hook_call', hook: 'window.a', args: [1] }),
    JSON.stringify({ timestamp: 't', type: 'hook_pair', hook: 'window.sign', input: ['zoe', 0], output: 'zoe:0' }),
    JSON.stringify({ timestamp: 't', type: 'hook_pair', hook: 'window.sign', input: ['', 1], output: ':8' }),
    JSON.stringify({ timestamp: 't', type: 'hook_pair', hook: 'window.other', input: [2], output: 4 }),
    JSON.stringify({ timestamp: 't', type: 'hook_pair', hook: 'window.sign', input: ['obj'], output: null, output_type: 'object' }),
    'not json at all',
    '',
    JSON.stringify({ timestamp: 't', type: 'hook_pair', hook: 'window.sign', input: ['n'], output: 42 })
].join('\n');

test('extractPairs filters by label and skips unserialized outputs', () => {
    const pairs = extractPairs(jsonl, 'window.sign');
    assert.equal(pairs.length, 3);
    assert.deepEqual(pairs[0], { input: ['zoe', 0], output: 'zoe:0' });
    assert.deepEqual(pairs[2], { input: ['n'], output: 42 });
});

test('extractPairs with no label returns every pair', () => {
    const pairs = extractPairs(jsonl, null);
    assert.equal(pairs.length, 4); // 3 sign + 1 other (unserialized skipped)
});

test('extractPairs tolerates garbage lines', () => {
    assert.equal(extractPairs('garbage\n\n{"type":"hook_pair","hook":"x","input":[],"output":1}', 'x').length, 1);
    assert.equal(extractPairs('', 'x').length, 0);
});

test('deepEqual: primitives are type-strict', () => {
    assert.ok(deepEqual(2, 2));
    assert.ok(!deepEqual(2, '2'));
    assert.ok(!deepEqual(1, true), 'bool must not equal 1');
    assert.ok(!deepEqual(true, 1));
    assert.ok(!deepEqual(null, undefined));
    assert.ok(!deepEqual(0, false));
    assert.ok(deepEqual('a', 'a'));
});

test('deepEqual: arrays are order-aware', () => {
    assert.ok(deepEqual([1, [2, 3]], [1, [2, 3]]));
    assert.ok(!deepEqual([1, 2], [2, 1]));
    assert.ok(!deepEqual([1, 2], [1, 2, 3]));
});

test('deepEqual: objects are key-set-aware, key order irrelevant', () => {
    assert.ok(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }));
    assert.ok(deepEqual({ a: { b: [1, { c: 'x' }] } }, { a: { b: [1, { c: 'x' }] } }));
    assert.ok(!deepEqual({}, { a: undefined }));
    assert.ok(!deepEqual({ a: 1 }, { a: 1, b: null }));
});

test('deepEqual: nested mismatch is caught', () => {
    assert.ok(!deepEqual({ r: { sig: 'aaa' } }, { r: { sig: 'aab' } }));
});
