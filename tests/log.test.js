const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('../src/util/log');
const { printSummary, trackEvent, resetSummary } = require('../src/util/summary');

let tmpDir;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wci-log-test-')); });
after(() => {
    log.resetLogStateForTesting();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
});

beforeEach(() => {
    log.resetLogStateForTesting();
    resetSummary();
});

test('stripAnsi removes ANSI escapes while preserving emojis and plain text', () => {
    const colored = '\x1b[1m\x1b[32m🤖 WEBCRYPTO-INTERCEPTOR\x1b[0m: \x1b[33mActive\x1b[0m';
    const clean = log.stripAnsi(colored);
    assert.equal(clean, '🤖 WEBCRYPTO-INTERCEPTOR: Active');
    assert.equal(log.stripAnsi('plain text 123'), 'plain text 123');
    assert.equal(log.stripAnsi(null), null);
});

test('startTerminalCapture tees stdout and stderr into terminal_output.txt without ANSI', async () => {
    const captureDir = path.join(tmpDir, 'term_test');
    const termFile = log.startTerminalCapture(captureDir);
    assert.equal(termFile, path.join(captureDir, 'terminal_output.txt'));

    // Write to stdout and stderr with ANSI escape colors
    process.stdout.write('\x1b[36m[🌐 NET]\x1b[0m GET https://example.com/api\n');
    process.stderr.write('\x1b[31m[⚠️ WARN]\x1b[0m Warning message\n');

    await log.stopTerminalCapture();

    assert.ok(fs.existsSync(termFile));
    const content = fs.readFileSync(termFile, 'utf8');
    assert.ok(content.includes('[🌐 NET] GET https://example.com/api\n'));
    assert.ok(content.includes('[⚠️ WARN] Warning message\n'));
    assert.ok(!content.includes('\x1b['), 'must not contain ANSI escape codes');
});

test('setLogDir configures JSONL log path under specified directory', () => {
    const logDir = path.join(tmpDir, 'log_dir_test');
    log.setLogDir(logDir);
    const logFile = log.getLogFile();
    assert.ok(logFile.startsWith(logDir));
    assert.ok(path.basename(logFile).startsWith('session_capture_'));
    assert.ok(logFile.endsWith('.jsonl'));
});

test('printSummary writes markdown summary report next to log file', () => {
    const sessionDir = path.join(tmpDir, 'summary_dir');
    fs.mkdirSync(sessionDir, { recursive: true });
    const logFile = path.join(sessionDir, 'session_capture_12345.jsonl');

    trackEvent('crypto_subtle', 'https://example.com/test');
    printSummary('https://example.com', logFile);

    const reportFile = path.join(sessionDir, 'session_capture_12345_summary.md');
    assert.ok(fs.existsSync(reportFile));
    const content = fs.readFileSync(reportFile, 'utf8');
    assert.ok(content.includes('# webcrypto-interceptor — session summary'));
    assert.ok(content.includes('https://example.com'));
    assert.ok(content.includes('crypto_subtle'));
});
