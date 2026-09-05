const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgv, HELP } = require('../src/cli');

test('parses basic URL', () => {
    const o = parseArgv(['https://example.com']);
    assert.equal(o.url, 'https://example.com');
    assert.equal(o.gui, false);
    assert.equal(o.full, false);
    assert.equal(o.allTraffic, false);
    assert.equal(o.timeout, 60000);
});

test('parses flags and values', () => {
    const o = parseArgv(['https://example.com', '--gui', '--full', '--out', '/tmp/dumps', '--timeout', '90', '--all-traffic']);
    assert.equal(o.gui, true);
    assert.equal(o.full, true);
    assert.equal(o.out, '/tmp/dumps');
    assert.equal(o.timeout, 90000);
    assert.equal(o.allTraffic, true);
});

test('accepts url + proxy + ua', () => {
    const o = parseArgv(['http://10.0.0.1/', '--proxy', 'http://127.0.0.1:8080', '--ua', 'MyAgent/1.0']);
    assert.equal(o.proxy, 'http://127.0.0.1:8080');
    assert.equal(o.ua, 'MyAgent/1.0');
    assert.equal(o.url, 'http://10.0.0.1/');
});

test('rejects missing URL', () => {
    assert.throws(() => parseArgv([]), /Missing <URL>/);
});

test('rejects non-http URL', () => {
    assert.throws(() => parseArgv(['ftp://example.com']), /http/);
    assert.throws(() => parseArgv(['example.com']), /http/);
});

test('rejects invalid timeout', () => {
    assert.throws(() => parseArgv(['https://example.com', '--timeout', '-5']), /timeout/);
    assert.throws(() => parseArgv(['https://example.com', '--timeout', 'abc']), /timeout/);
});

test('--help short-circuits', () => {
    const o = parseArgv(['--help']);
    assert.equal(o.help, true);
    assert.ok(HELP.includes('--gui'));
    assert.ok(HELP.includes('webcrypto-interceptor'));
});
