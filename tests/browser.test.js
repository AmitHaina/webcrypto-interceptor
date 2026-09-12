const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveBrowserPath } = require('../src/util/browser');

test('resolveBrowserPath respects PUPPETEER_EXECUTABLE_PATH', () => {
    const old = process.env.PUPPETEER_EXECUTABLE_PATH;
    try {
        process.env.PUPPETEER_EXECUTABLE_PATH = '/custom/browser/path';
        assert.equal(resolveBrowserPath(false), '/custom/browser/path');
        assert.equal(resolveBrowserPath(true), '/custom/browser/path');
    } finally {
        if (old !== undefined) process.env.PUPPETEER_EXECUTABLE_PATH = old;
        else delete process.env.PUPPETEER_EXECUTABLE_PATH;
    }
});

test('resolveBrowserPath returns a string or null on current platform', () => {
    const pChrome = resolveBrowserPath(false);
    assert.ok(pChrome === null || typeof pChrome === 'string');

    const pBrave = resolveBrowserPath(true);
    assert.ok(pBrave === null || typeof pBrave === 'string');
});
