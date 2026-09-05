const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    shortUrl, decodeHexEscapes, tryBase64ToHex, extractContentKey, extractHlsKeyUri
} = require('../src/util/decoders');

test('shortUrl strips protocol and truncates', () => {
    const long = 'https://example.com/a/very/long/path/that/exceeds/fifty/characters/for/sure';
    assert.equal(shortUrl(long), long.replace(/^https?:\/\//, '').substring(0, 50));
    assert.equal(shortUrl('http://a.io/x'), 'a.io/x');
    assert.equal(shortUrl(null), '');
});

test('decodeHexEscapes converts \\xNN sequences', () => {
    assert.equal(decodeHexEscapes('\\x41\\x42\\x43'), 'ABC');
    assert.equal(decodeHexEscapes('plain'), 'plain');
});

test('tryBase64ToHex passes through real hex', () => {
    assert.equal(tryBase64ToHex('00112233445566778899aabbccddeeff'), '00112233445566778899aabbccddeeff');
});

test('tryBase64ToHex decodes base64 to AES-sized hex', () => {
    // 16 raw bytes -> base64 -> hex
    const buf = Buffer.from('0123456789abcdef'); // exactly 16 bytes
    const b64 = buf.toString('base64');
    assert.equal(tryBase64ToHex(b64), buf.toString('hex'));
});

test('tryBase64ToHex leaves non-key strings alone', () => {
    assert.equal(tryBase64ToHex('hello world this is not base64!!'), 'hello world this is not base64!!');
    // base64 of 15 bytes (not 16/24/32) is not converted
    const b64 = Buffer.from('0123456789abcde').toString('base64');
    assert.equal(tryBase64ToHex(b64), b64);
});

test('extractContentKey finds ck/key/contentKey/aesKey fields', () => {
    const cases = [
        ['{"ck":"00112233445566778899aabbccddeeff"}', 'ck'],
        ['{"key":"deadbeefdeadbeefdeadbeefdeadbeef"}', 'key'],
        ['{"contentKey":"cafebabecafebabecafebabecafebabe"}', 'contentKey'],
        ['{"aesKey":"0102030405060708090a0b0c0d0e0f10"}', 'aesKey']
    ];
    for (const [body, field] of cases) {
        const ck = extractContentKey(body);
        assert.ok(ck, `should match ${field}`);
        assert.equal(ck.field, field);
        assert.equal(ck.decoded, body.match(/"([0-9a-f]+)"/i)[1]);
    }
});

test('extractContentKey decodes hex escapes in raw value', () => {
    const ck = extractContentKey('{"ck":"\\x41\\x42"}');
    assert.ok(ck);
    assert.equal(ck.raw, '\\x41\\x42');
    assert.equal(ck.decoded, 'AB');
});

test('extractContentKey returns null when no key field', () => {
    assert.equal(extractContentKey('{"other":"00112233445566778899aabbccddeeff"}'), null);
    assert.equal(extractContentKey('not json at all'), null);
});

test('extractHlsKeyUri extracts URI and optional IV', () => {
    const body = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key.bin",IV=0x9c7db8778570d05c3177c349fd9236aa\n#EXTINF:10,\nseg1.ts';
    const hls = extractHlsKeyUri(body);
    assert.ok(hls);
    assert.equal(hls.keyUri, 'https://cdn.example.com/key.bin');
    assert.equal(hls.iv, '0x9c7db8778570d05c3177c349fd9236aa');
});

test('extractHlsKeyUri handles missing IV', () => {
    const body = '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/k"\n';
    const hls = extractHlsKeyUri(body);
    assert.ok(hls);
    assert.equal(hls.iv, null);
});

test('extractHlsKeyUri returns null without EXT-X-KEY', () => {
    assert.equal(extractHlsKeyUri('#EXTM3U\n#EXTINF:10,\nseg1.ts'), null);
});
