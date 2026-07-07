const { C } = require('../util/colors');
const { writeLog } = require('../util/log');
const { extractContentKey, extractHlsKeyUri } = require('../util/decoders');
const { RESP_KEYWORDS, SKIP_RESP_EXT, SKIP_RESP_CT } = require('../config');

// Cross-session dedup: same URL+status logged only once within TTL
const seenResponses = new Map();
const DEDUP_TTL_MS = 5000;
function alreadySeen(url, status) {
    const key = status + ' ' + url;
    const now = Date.now();
    for (const [k, t] of seenResponses) {
        if (now - t > DEDUP_TTL_MS) seenResponses.delete(k);
    }
    if (seenResponses.has(key)) return true;
    seenResponses.set(key, now);
    return false;
}

// Global dedup for discovered secrets — same value only reported once ever.
const seenSecrets = new Set();

// Scan any text body for hardcoded crypto material: PEM keys, RSA JWK n/e,
// AES/HMAC hex/base64 keys, JWTs. Returns array of findings.
function scanForSecrets(body, url) {
    const findings = [];
    if (!body || typeof body !== 'string') return findings;

    // PEM public/private keys (RSA, EC, generic)
    const pemRe = /-----BEGIN (?:RSA |EC |DSA )?(PUBLIC|PRIVATE) KEY-----([\s\S]{20,4000}?)-----END (?:RSA |EC |DSA )?\1 KEY-----/g;
    let m;
    while ((m = pemRe.exec(body)) !== null) {
        const full = m[0].replace(/\\n/g, '\n');
        findings.push({ type: `PEM_${m[1]}_KEY`, value: full });
    }

    // Hardcoded key/secret assignments: rsaPublicKey:"...", secretKey='...', aesKey:`...`, etc.
    const assignRe = /\b(rsaPublicKey|rsaPrivateKey|publicKey|privateKey|secretKey|aesKey|apiKey|api_key|appSecret|app_secret|hmacKey|signKey|encryptKey|encrypt_key)\s*[:=]\s*['"`]([A-Za-z0-9+/=_\-\\n\s]{16,4000})['"`]/g;
    while ((m = assignRe.exec(body)) !== null) {
        const raw = m[2].replace(/\\n/g, '\n').trim();
        if (raw.length >= 16) findings.push({ type: `HARDCODED_${m[1]}`, value: raw });
    }

    // Bare AES-shaped hex constants: 32/48/64 hex chars (128/192/256-bit)
    // Only match those clearly assigned to a variable to avoid random hex spam.
    const hexKeyRe = /\b(?:key|iv|salt|secret|token)\w*\s*[:=]\s*['"]([a-fA-F0-9]{32}|[a-fA-F0-9]{48}|[a-fA-F0-9]{64})['"]/g;
    while ((m = hexKeyRe.exec(body)) !== null) {
        findings.push({ type: `HEX_KEY_${m[1].length * 4}bit`, value: m[1] });
    }

    // JWTs — three base64url segments separated by dots
    const jwtRe = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
    while ((m = jwtRe.exec(body)) !== null) findings.push({ type: 'JWT', value: m[0] });

    return findings;
}

function reportSecrets(findings, url) {
    for (const f of findings) {
        const sig = f.type + '|' + f.value.substring(0, 200);
        if (seenSecrets.has(sig)) continue;
        seenSecrets.add(sig);
        const preview = f.value.length > 400 ? f.value.substring(0, 400) + '...' : f.value;
        console.log(`${C.hlred}[\ud83d\udd11 SECRET] ${f.type}${C.reset} in ${C.dim}${url}${C.reset}\n   ${C.green}${preview}${C.reset}`);
        writeLog({ type: 'secret_found', kind: f.type, url, value: f.value });
    }
}

async function attachNetworkCapture(cdpSession) {
    try { await cdpSession.send('Network.enable'); } catch (e) { return; }

    cdpSession.on('Network.responseReceived', async (params) => {
        const response = params.response;
        const url = response.url;
        const lower = url.toLowerCase();
        const ctHeader = String((response.headers && (response.headers['content-type'] || response.headers['Content-Type'])) || '').toLowerCase();

        // Secret-scan path: for any script/json response, fetch body once, scan
        // for hardcoded keys/secrets. Runs independently of the interesting-url
        // filter so we catch keys embedded in third-party bundles too.
        const isScriptLike = /javascript|json|ecmascript/.test(ctHeader) || /\.(?:js|mjs|json)(?:\?|$)/.test(lower);
        if (isScriptLike && !alreadySeen('secretscan:' + url, response.status)) {
            try {
                const scanBody = await cdpSession.send('Network.getResponseBody', { requestId: params.requestId });
                if (scanBody && scanBody.body) {
                    const text = scanBody.base64Encoded ? Buffer.from(scanBody.body, 'base64').toString('utf8') : scanBody.body;
                    const findings = scanForSecrets(text, url);
                    if (findings.length) reportSecrets(findings, url);
                }
            } catch (e) {}
        }

        // Existing interesting-response path
        if (!RESP_KEYWORDS.some(k => lower.includes(k))) return;
        if (SKIP_RESP_EXT.test(lower)) return;
        if (SKIP_RESP_CT.test(ctHeader)) return;
        if (alreadySeen(url, response.status)) return;

        let bodyObj;
        try {
            bodyObj = await cdpSession.send('Network.getResponseBody', { requestId: params.requestId });
        } catch (e) { return; }

        console.log(`\n${C.yellow}[📥 NET RESP] ${response.status} ${url}${C.reset}`);
        if (!bodyObj.body) return;

        let body = bodyObj.body;
        let rawBuf = null;
        if (bodyObj.base64Encoded) {
            try {
                const buf = Buffer.from(bodyObj.body, 'base64');
                rawBuf = buf;
                const headers = response.headers || {};
                const ct = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
                const isTextCT = /text|json|xml|javascript|html|css|mpegurl|dash|urlencoded/.test(ct);
                let isBinary = false;
                if (!isTextCT) {
                    const sample = buf.subarray(0, Math.min(buf.length, 512));
                    let nonPrint = 0;
                    for (const b of sample) {
                        if (b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13) || b === 0xFF) nonPrint++;
                    }
                    isBinary = sample.length > 0 && nonPrint / sample.length > 0.15;
                }
                if (isBinary) {
                    body = buf.toString('hex');
                    console.log(`   ${C.dim}(binary ${buf.length}B \u2192 hex)${C.reset}`);
                    if ([16, 24, 32].includes(buf.length)) {
                        console.log(`   ${C.hlred}\ud83d\udd11 RAW AES KEY (${buf.length * 8}-bit): ${body}${C.reset}`);
                        writeLog({ type: 'raw_aes_key', url, bits: buf.length * 8, hex: body });
                    }
                } else {
                    body = buf.toString('utf8');
                    console.log(`   ${C.dim}(base64-decoded ${bodyObj.body.length}B \u2192 ${body.length}B)${C.reset}`);
                }
            } catch (e) {
                body = bodyObj.body;
            }
        }

        // Also scan interesting response bodies for secrets (JWTs in responses etc.)
        const respFindings = scanForSecrets(body, url);
        if (respFindings.length) reportSecrets(respFindings, url);

        const ck = extractContentKey(body);
        if (ck) {
            console.log(`   ${C.hlred}\ud83d\udd11 CONTENT KEY (${ck.field}): ${ck.decoded}${C.reset}`);
            writeLog({ type: 'content_key', url, field: ck.field, raw: ck.raw, decoded: ck.decoded });
        }

        const hls = extractHlsKeyUri(body);
        if (hls) {
            console.log(`   ${C.hlred}\ud83d\udd10 HLS AES KEY URI: ${hls.keyUri}${hls.iv ? '  IV=' + hls.iv : ''}${C.reset}`);
            writeLog({ type: 'hls_key_ref', url, keyUri: hls.keyUri, iv: hls.iv });
        }

        const preview = body.length > 1500 ? body.substring(0, 1500) + '...' : body;
        console.log(`   ${C.dim}${preview}${C.reset}`);
        writeLog({ type: 'http_response', url, status: response.status, body });
    });
}

module.exports = { attachNetworkCapture };
