const fs = require('fs');

const sessionLogFile = `session_capture_${Date.now()}.jsonl`;
const logStream = fs.createWriteStream(sessionLogFile, { flags: 'a' });

function writeLog(event) {
    logStream.write(JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n');
}

function closeLog() {
    return new Promise(resolve => logStream.end(resolve));
}

process.on('exit', () => { try { logStream.end(); } catch (e) {} });
process.on('SIGINT', () => { try { logStream.end(); } catch (e) {} process.exit(0); });

module.exports = { writeLog, closeLog, sessionLogFile };
