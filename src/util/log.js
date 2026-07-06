const fs = require('fs');

const sessionLogFile = `session_capture_${Date.now()}.jsonl`;

function writeLog(event) {
    fs.appendFileSync(sessionLogFile, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n');
}

module.exports = { writeLog, sessionLogFile };
