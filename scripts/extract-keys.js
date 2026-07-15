// Post-process a session_capture_*.jsonl log and correlate the AES key +
// IV used to decrypt each video segment, so you don't have to eyeball
// [🔓 CRYPTO ARGS] lines by hand.
//
// The capture log already contains everything needed (see src/cdp/network.js
// and src/page/stealth.js): every crypto.subtle call is logged as a
// `hook_event` with message "[Reversed-Event] CRYPTO-ARGS <method> <jsonArgs>",
// and every fetch is logged the same way. We just replay them in order:
//   - remember the most recent video-ish fetch URL
//   - remember the most recent importKey("raw", <hex>, ..., ["decrypt"]) call
//   - when a decrypt(...) call comes in, pair its IV with that key + URL
//
// Usage: node scripts/extract-keys.js [session_capture_*.jsonl]
// (defaults to the newest session_capture_*.jsonl in the cwd)

const fs = require('fs');
const path = require('path');

const VIDEO_URL_RE = /\.(m3u8|mpd|ts|mp4|m4s|webm|mkv|key|bin)(\?|$)/i;

function extractKeys(lines) {
    let lastVideoUrl = null;
    let lastImportedKey = null; // { hex, algorithm }
    const results = [];

    for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch (e) { continue; }
        if (entry.type !== 'hook_event' || typeof entry.message !== 'string') continue;
        const msg = entry.message;

        if (msg.startsWith('[Reversed-Event] fetch ') || msg.startsWith('[Reversed-Event] VIDEO ')) {
            const urlMatch = msg.match(/https?:\/\/\S+/);
            if (urlMatch && VIDEO_URL_RE.test(urlMatch[0])) lastVideoUrl = urlMatch[0].split(' body:')[0];
            continue;
        }

        const cryptoMatch = msg.match(/^\[Reversed-Event\] CRYPTO-ARGS (\w+) (.+)$/);
        if (!cryptoMatch) continue;
        const [, method, argsJson] = cryptoMatch;
        let args;
        try { args = JSON.parse(argsJson); } catch (e) { continue; } // truncated (>4096B) lines aren't valid JSON

        if (method === 'importKey') {
            const [, keyData, algorithm, , usages] = args;
            if (keyData && keyData.hex && Array.isArray(usages) && usages.includes('decrypt')) {
                lastImportedKey = { hex: keyData.hex, algorithm: algorithm && algorithm.name };
            }
            continue;
        }

        if (method === 'decrypt') {
            const [algoParam] = args;
            const iv = algoParam && algoParam.iv && algoParam.iv.hex;
            if (lastImportedKey && iv) {
                results.push({
                    url: lastVideoUrl,
                    algorithm: lastImportedKey.algorithm || (algoParam && algoParam.name),
                    keyHex: lastImportedKey.hex,
                    ivHex: iv,
                    timestamp: entry.timestamp,
                });
            }
        }
    }
    return results;
}

function dedupe(results) {
    const seen = new Set();
    return results.filter(r => {
        const sig = `${r.url}|${r.keyHex}|${r.ivHex}`;
        if (seen.has(sig)) return false;
        seen.add(sig);
        return true;
    });
}

function findLatestLog() {
    const candidates = fs.readdirSync('.').filter(f => /^session_capture_\d+\.jsonl$/.test(f));
    if (!candidates.length) return null;
    return candidates.sort().pop();
}

function main() {
    const logPath = process.argv[2] || findLatestLog();
    if (!logPath) {
        console.error('No session_capture_*.jsonl given and none found in cwd.');
        process.exit(2);
    }
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    const results = dedupe(extractKeys(lines));

    if (!results.length) {
        console.log('No decrypt calls with a paired importKey found in', logPath);
        return;
    }
    for (const r of results) {
        console.log(`\nurl:  ${r.url || '(unknown)'}`);
        console.log(`algo: ${r.algorithm}`);
        console.log(`key:  ${r.keyHex}`);
        console.log(`iv:   ${r.ivHex}`);
        console.log(`# openssl enc -d -${(r.algorithm || 'aes-128-cbc').toLowerCase().replace('-', '-')} -K ${r.keyHex} -iv ${r.ivHex} -in seg.enc -out seg.dec`);
    }
    console.log(`\n${results.length} key/iv pair(s) extracted from ${logPath}`);
}

if (require.main === module) main();

module.exports = { extractKeys, dedupe };
