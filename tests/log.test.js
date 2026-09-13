const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('../src/util/log');
const {
    printSummary, trackEvent, resetSummary, writeExtractedSummary,
    trackContentKey, trackRawAesKey, trackHlsKey, trackSecretFinding,
    trackManifest, trackWasmDump, trackExtractedFile
} = require('../src/util/summary');

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

test('writeExtractedSummary generates structured extracted_summary.json with crypto, secrets, manifests, wasm and files', () => {
    const extractDir = path.join(tmpDir, 'extract_summary_dir');
    fs.mkdirSync(extractDir, { recursive: true });

    trackContentKey({ field: 'ck', decoded: '0123456789abcdef', url: 'https://example.com/player' });
    trackRawAesKey({ bits: 128, hex: 'deadbeefdeadbeefdeadbeefdeadbeef', url: 'https://example.com/key.bin' });
    trackHlsKey({ keyUri: 'https://example.com/stream.key', iv: '0x1234', url: 'https://example.com/master.m3u8' });
    trackSecretFinding({ type: 'JWT', value: 'eyJ...', url: 'https://example.com/bundle.js' });
    trackManifest({ type: 'hls_manifest', url: 'https://example.com/master.m3u8' });
    trackWasmDump({ file: 'wasm/module_abc.wasm', hash: 'abc', size: 1024 });
    trackExtractedFile(path.join(extractDir, 'index.html'));
    trackExtractedFile(path.join(extractDir, 'bundle.js'));

    const summaryPath = writeExtractedSummary(extractDir, 'https://example.com');
    assert.ok(fs.existsSync(summaryPath));
    const data = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

    assert.equal(data.target, 'https://example.com');
    assert.equal(data.crypto.contentKeys[0].decoded, '0123456789abcdef');
    assert.equal(data.crypto.rawAesKeys[0].hex, 'deadbeefdeadbeefdeadbeefdeadbeef');
    assert.equal(data.crypto.hlsKeys[0].keyUri, 'https://example.com/stream.key');
    assert.equal(data.secrets[0].type, 'JWT');
    assert.equal(data.manifests[0].url, 'https://example.com/master.m3u8');
    assert.equal(data.wasmModules[0].hash, 'abc');
    assert.equal(data.files.total, 2);
    assert.equal(data.files.byExtension['.html'], 1);
    assert.equal(data.files.byExtension['.js'], 1);
});

