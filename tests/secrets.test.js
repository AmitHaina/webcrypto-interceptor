const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanForSecrets } = require('../src/util/secrets');

test('detects PEM public and private keys', () => {
    const filler = 'A'.repeat(60); // body between markers must exceed 20 chars
    const body = `const pk = "-----BEGIN RSA PRIVATE KEY-----\\n${filler}\\n-----END RSA PRIVATE KEY-----";`;
    const f = scanForSecrets(body);
    assert.ok(f.some(x => x.type === 'PEM_PRIVATE_KEY'));
    const pub = `-----BEGIN PUBLIC KEY-----\\n${filler}\\n-----END PUBLIC KEY-----`;
    assert.ok(scanForSecrets(pub).some(x => x.type === 'PEM_PUBLIC_KEY'));
});

test('classifies bare DER RSA public keys (SPKI)', () => {
    const val = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A' + 'A'.repeat(200);
    const f = scanForSecrets(`{"rsaPublicKey":"${val}"}`);
    assert.ok(f.some(x => x.type === 'DER_RSA_PUBLIC_KEY'));
    assert.equal(f.find(x => x.type === 'DER_RSA_PUBLIC_KEY').value, val);
});

test('classifies bare DER EC public keys (MFkw/MHY)', () => {
    // Realistic P-256 SPKI: 124 base64 chars, starts with MFkw
    const val = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'B'.repeat(88);
    const f = scanForSecrets(`key='${val}'`);
    assert.ok(f.some(x => x.type === 'DER_EC_PUBLIC_KEY'), 'EC SPKI must be classified, got: ' + JSON.stringify(f.map(x => x.type)));
});

test('detects hardcoded key assignments', () => {
    const body = `var cfg = { apiKey: 'abcd1234abcd1234abcd1234abcd1234', app_secret: 'zz9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4' };`;
    const f = scanForSecrets(body);
    assert.ok(f.some(x => x.type === 'HARDCODED_apiKey'));
    assert.ok(f.some(x => x.type === 'HARDCODED_app_secret'));
});

test('detects hex keys of 128/192/256-bit sizes on key-like vars', () => {
    // hex-length math: N hex chars = N*4 bits (32 chars = 128-bit AES key)
    const f128 = scanForSecrets(`key: '${'a'.repeat(32)}'`);
    assert.ok(f128.some(x => x.type === 'HEX_KEY_128bit'));
    const f192 = scanForSecrets(`iv = '${'c'.repeat(48)}';`);
    assert.ok(f192.some(x => x.type === 'HEX_KEY_192bit'));
    const f256 = scanForSecrets(`secretKey = "${'e'.repeat(64)}";`);
    assert.ok(f256.some(x => x.type === 'HEX_KEY_256bit'));
});

test('detects JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
    const f = scanForSecrets(`token: "${jwt}"`);
    assert.ok(f.some(x => x.type === 'JWT' && x.value === jwt));
});

test('returns empty for clean bodies', () => {
    assert.deepStrictEqual(scanForSecrets(''), []);
    assert.deepStrictEqual(scanForSecrets(null), []);
    assert.deepStrictEqual(scanForSecrets('just some normal javascript code'), []);
    assert.deepStrictEqual(scanForSecrets(42), []);
});

test('no false positive on short random strings', () => {
    const f = scanForSecrets(`var x = 'short', y = "1234";`);
    assert.deepStrictEqual(f, []);
});
