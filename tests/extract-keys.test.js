const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractKeys, dedupe, cipherFor } = require('../scripts/extract-keys');

function line(type, message, ts) {
    return JSON.stringify({ timestamp: ts || new Date().toISOString(), type, message });
}

const TS = '2026-01-01T00:00:00.000Z';

test('correlates importKey(raw) + decrypt with the last video URL', () => {
    const lines = [
        line('hook_event', '[Reversed-Event] fetch [GET] https://cdn.example.com/video/index.m3u8', TS),
        line('hook_event', '[Reversed-Event] CRYPTO-ARGS importKey ' + JSON.stringify([
            'raw', { __t: 'Bytes', len: 16, hex: '00112233445566778899aabbccddeeff' },
            { name: 'AES-CBC' }, false, ['decrypt']
        ]), TS),
        line('hook_event', '[Reversed-Event] CRYPTO-ARGS decrypt ' + JSON.stringify([
            { name: 'AES-CBC', iv: { __t: 'Uint8Array', len: 16, hex: '9c7db8778570d05c3177c349fd9236aa' } },
            { __t: 'ArrayBuffer', len: 1600, hex: 'ff' }
        ]), TS)
    ];
    const results = extractKeys(lines);
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'https://cdn.example.com/video/index.m3u8');
    assert.equal(results[0].keyHex, '00112233445566778899aabbccddeeff');
    assert.equal(results[0].ivHex, '9c7db8778570d05c3177c349fd9236aa');
    assert.equal(results[0].algorithm, 'AES-CBC');
});

test('decodes JWK base64url k field', () => {
    const rawKey = Buffer.from('0123456789abcdef'); // 16 bytes
    const b64url = rawKey.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const lines = [
        line('hook_event', '[Reversed-Event] CRYPTO-ARGS importKey ' + JSON.stringify([
            'jwk', { kty: 'oct', k: b64url }, { name: 'AES-CBC' }, false, ['decrypt']
        ]), TS),
        line('hook_event', '[Reversed-Event] CRYPTO-ARGS decrypt ' + JSON.stringify([
            { name: 'AES-CBC', iv: { hex: '0102030405060708090a0b0c0d0e0f10' } }
        ]), TS)
    ];
    const results = extractKeys(lines);
    assert.equal(results.length, 1);
    assert.equal(results[0].keyHex, rawKey.toString('hex'));
});

test('ignores decrypt without a preceding importKey', () => {
    const lines = [
        line('hook_event', '[Reversed-Event] CRYPTO-ARGS decrypt ' + JSON.stringify([
            { name: 'AES-CBC', iv: { hex: '0102030405060708090a0b0c0d0e0f10' } }
        ]), TS)
    ];
    assert.equal(extractKeys(lines).length, 0);
});

test('skips importKey calls without decrypt usage', () => {
    const lines = [
        line('hook_event', '[Reversed-Event] CRYPTO-ARGS importKey ' + JSON.stringify([
            'raw', { hex: '00112233445566778899aabbccddeeff' }, { name: 'AES-CBC' }, false, ['encrypt']
        ]), TS),
        line('hook_event', '[Reversed-Event] CRYPTO-ARGS decrypt ' + JSON.stringify([
            { name: 'AES-CBC', iv: { hex: '0102030405060708090a0b0c0d0e0f10' } }
        ]), TS)
    ];
    assert.equal(extractKeys(lines).length, 0);
});

test('dedupe removes identical url|key|iv rows', () => {
    const r = { url: 'https://x/seg1.ts', keyHex: 'aa', ivHex: 'bb' };
    assert.equal(dedupe([r, { ...r }, { ...r, ivHex: 'cc' }]).length, 2);
});

test('cipherFor builds valid openssl cipher names', () => {
    // hex-length math: N hex chars = N*4 bits; openssl needs the key size
    assert.equal(cipherFor('AES-CBC', 'a'.repeat(64)), 'aes-256-cbc');
    assert.equal(cipherFor('AES-CBC', 'a'.repeat(32)), 'aes-128-cbc');
    assert.equal(cipherFor('AES-GCM', 'a'.repeat(32)), 'aes-128-gcm');
    assert.equal(cipherFor('AES-CTR', 'a'.repeat(64)), 'aes-256-ctr');
    assert.equal(cipherFor(undefined, 'a'.repeat(32)), 'aes-128-cbc');
    assert.equal(cipherFor('AES-CBC', 'a'.repeat(64)).endsWith('-cbc'), true);
});
