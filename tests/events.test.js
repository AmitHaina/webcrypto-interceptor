const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const events = require('../src/cdp/events');
const log = require('../src/util/log');

// Route test logs into a temp dir so we never pollute cwd.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wci-events-'));
log.setLogDir(tmpDir);

test('stealth.js compiles (syntax guard for browser-injected code)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', 'stealth.js'), 'utf8');
    assert.doesNotThrow(() => new Function(src));
    assert.ok(src.includes('globalThis'), 'must be scope-agnostic (worker support)');
    assert.ok(!src.includes('__WCI_PART'), 'no leftover chunk markers');
});

test('isDuplicate tracks uids', () => {
    assert.equal(events.isDuplicate('u1'), false);
    assert.equal(events.isDuplicate('u1'), true);
    assert.equal(events.isDuplicate(null), false);
});

test('reassembleChunks reassembles ordered hex chunks', () => {
    const chunks = [
        { uid: 'c1', type: 'wasm_hex', seq: 2, of: 3, hash: 'abc', hex: 'cc' },
        { uid: 'c1#0', type: 'wasm_hex', seq: 0, of: 3, hash: 'abc', hex: 'aa' },
        { uid: 'c1#1', type: 'wasm_hex', seq: 1, of: 3, hash: 'abc', hex: 'bb' }
    ];
    // note: uid differs per chunk in the real transport; assembly keys on uid
    // prefix logic — events.reassembleChunks keys on evt.uid, so simulate the
    // node-side view where each chunk shares the same uid.
    const same = chunks.map((c, i) => ({ ...c, uid: 'c1' }));
    let out = null;
    assert.equal(events.reassembleChunks(same[0]), null);
    assert.equal(events.reassembleChunks(same[1]), null);
    out = events.reassembleChunks(same[2]);
    assert.equal(out, 'aabbcc');
});

test('structuredToLegacy preserves the [Reversed-Event] wire format', () => {
    const t = events.structuredToLegacy({
        type: 'fetch',
        data: { method: 'POST', url: 'https://api.example.com/pay', video: false, body: 'a=1' }
    });
    assert.equal(t, '[Reversed-Event] fetch [POST] https://api.example.com/pay body: a=1');

    const v = events.structuredToLegacy({
        type: 'fetch',
        data: { method: 'GET', url: 'https://cdn.example.com/v/index.m3u8', video: true, body: null }
    });
    assert.equal(v, '[Reversed-Event] VIDEO [GET] https://cdn.example.com/v/index.m3u8');

    const s = events.structuredToLegacy({
        type: 'storage',
        data: { storage: 'localStorage', key: 'token', value: 'abc' }
    });
    assert.equal(s, '[Reversed-Event] STORAGE [localStorage] set token = abc');

    const cr = events.structuredToLegacy({
        type: 'crypto_result',
        data: { method: 'decrypt', result: '{"len":16,"hex":"aabb"}' }
    });
    assert.equal(cr, '[Reversed-Event] CRYPTO-RESULT decrypt {"len":16,"hex":"aabb"}');

    assert.equal(events.structuredToLegacy({ type: 'mystery', data: {} }), null);
});

test('handleStructuredEvent consumes valid envelopes end-to-end', () => {
    const evt = { uid: 'e2e-1', type: 'crypto_args', data: { method: 'decrypt', args: '[{"name":"AES-CBC","iv":{"hex":"aabb"}}]' } };
    assert.equal(events.handleStructuredEvent(JSON.stringify(evt), 'test:target', () => null), true);
    assert.equal(events.handleStructuredEvent(JSON.stringify(evt), 'test:target', () => null), true, 'duplicate uid consumed silently');

    const resEvt = { uid: 'e2e-2', type: 'crypto_result', data: { method: 'decrypt', result: '{"len":16,"hex":"aabb"}' } };
    assert.equal(events.handleStructuredEvent(JSON.stringify(resEvt), 'test:target', () => null), true);

    assert.equal(events.handleStructuredEvent('not json', 't', () => null), false);
    assert.equal(events.handleStructuredEvent('{"no":"type"}', 't', () => null), false);
});

test('formatHookConsole keeps legacy tag rendering', () => {
    const out = events.formatHookConsole('[Reversed-Event] CRYPTO-ARGS encrypt [{"a":1}]');
    assert.ok(out.includes('CRYPTO ARGS'));
    const resOut = events.formatHookConsole('[Reversed-Event] CRYPTO-RESULT decrypt {"hex":"aabb"}');
    assert.ok(resOut.includes('CRYPTO RESULT'));
    const blob = events.formatHookConsole('[Reversed-Event] BLOB URL blob:x type=text/javascript size=10B');
    assert.ok(blob.includes('BLOB URL'));
});
