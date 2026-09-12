const fs = require('fs');
const path = require('path');

let logStream = null;
let sessionLogFile = null;

let terminalStream = null;
let terminalFile = null;
let origStdoutWrite = null;
let origStderrWrite = null;

const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(str) {
    if (typeof str !== 'string') return str;
    return str.replace(ANSI_REGEX, '');
}

function setLogDir(baseDir) {
    if (logStream) return; // too late to move an open stream; call before first write
    if (baseDir) fs.mkdirSync(baseDir, { recursive: true });
    sessionLogFile = path.join(baseDir || process.cwd(), `session_capture_${Date.now()}.jsonl`);
}

function getLogFile() {
    if (!sessionLogFile) setLogDir(null);
    return sessionLogFile;
}

function getStream() {
    if (!logStream) logStream = fs.createWriteStream(getLogFile(), { flags: 'a' });
    return logStream;
}

function writeLog(event) {
    try {
        getStream().write(JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n');
    } catch (e) { /* never let logging break capture */ }
}

function startTerminalCapture(baseDir) {
    if (terminalStream) return terminalFile;
    if (baseDir) fs.mkdirSync(baseDir, { recursive: true });
    terminalFile = path.join(baseDir || process.cwd(), 'terminal_output.txt');
    terminalStream = fs.createWriteStream(terminalFile, { flags: 'a' });

    origStdoutWrite = process.stdout.write.bind(process.stdout);
    origStderrWrite = process.stderr.write.bind(process.stderr);

    process.stdout.write = function (chunk, encoding, cb) {
        try {
            if (terminalStream && !terminalStream.destroyed) {
                const raw = typeof chunk === 'string'
                    ? chunk
                    : Buffer.isBuffer(chunk)
                        ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8')
                        : String(chunk);
                terminalStream.write(stripAnsi(raw));
            }
        } catch (e) {}
        return origStdoutWrite(chunk, encoding, cb);
    };

    process.stderr.write = function (chunk, encoding, cb) {
        try {
            if (terminalStream && !terminalStream.destroyed) {
                const raw = typeof chunk === 'string'
                    ? chunk
                    : Buffer.isBuffer(chunk)
                        ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8')
                        : String(chunk);
                terminalStream.write(stripAnsi(raw));
            }
        } catch (e) {}
        return origStderrWrite(chunk, encoding, cb);
    };

    return terminalFile;
}

function stopTerminalCapture() {
    return new Promise((resolve) => {
        if (origStdoutWrite) {
            process.stdout.write = origStdoutWrite;
            origStdoutWrite = null;
        }
        if (origStderrWrite) {
            process.stderr.write = origStderrWrite;
            origStderrWrite = null;
        }
        if (!terminalStream) return resolve();
        const stream = terminalStream;
        terminalStream = null;
        stream.end(() => resolve());
    });
}

function getTerminalFile() {
    return terminalFile;
}

// Flush and close the stream. MUST be awaited before process.exit on
// shutdown — writeStream.end() inside the 'exit' handler cannot flush
// pending async writes, which silently dropped the tail of the capture.
function closeLog() {
    return new Promise((resolve) => {
        if (!logStream) return resolve();
        const stream = logStream;
        logStream = null;
        stream.end(() => resolve());
    });
}

function resetLogStateForTesting() {
    if (origStdoutWrite) {
        process.stdout.write = origStdoutWrite;
        origStdoutWrite = null;
    }
    if (origStderrWrite) {
        process.stderr.write = origStderrWrite;
        origStderrWrite = null;
    }
    if (terminalStream) {
        try { terminalStream.end(); } catch (e) {}
        terminalStream = null;
    }
    terminalFile = null;
    if (logStream) {
        try { logStream.end(); } catch (e) {}
        logStream = null;
    }
    sessionLogFile = null;
}

process.on('exit', () => {
    try { if (logStream) logStream.end(); } catch (e) {}
    try { if (terminalStream) terminalStream.end(); } catch (e) {}
});

module.exports = {
    writeLog,
    closeLog,
    setLogDir,
    getLogFile,
    startTerminalCapture,
    stopTerminalCapture,
    getTerminalFile,
    stripAnsi,
    resetLogStateForTesting
};
