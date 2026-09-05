const fs = require('fs');
const path = require('path');

let logStream = null;
let sessionLogFile = null;

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

// Flush and close the stream. MUST be awaited before process.exit on
// shutdown — writeStream.end() inside the 'exit' handler cannot flush
// pending async writes, which silently dropped the tail of the capture.
function closeLog() {
    return new Promise((resolve) => {
        if (!logStream) return resolve();
        logStream.end(() => resolve());
        logStream = null;
    });
}

process.on('exit', () => { try { if (logStream) logStream.end(); } catch (e) {} });

module.exports = { writeLog, closeLog, setLogDir, getLogFile };
