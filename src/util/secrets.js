// Shared secret-scanner used by both network-body scanning and Debugger script
// scanning. Detects hardcoded crypto material in any text: PEM keys, RSA/EC
// key material with the DER SPKI/PKCS8 magic prefix (bare base64), assignment
// patterns (rsaPublicKey: "...", secretKey='...', etc.), fixed-length hex keys,
// and JWTs.
//
// Dedup is global per-process — the same secret value is only reported once.

const { C } = require('./colors');
const { writeLog } = require('./log');

const seenSecrets = new Set();

function scanForSecrets(body /* , url */) {
    const findings = [];
    if (!body || typeof body !== 'string') return findings;

    // 1. PEM public/private keys (RSA, EC, DSA, or generic)
    const pemRe = /-----BEGIN (?:RSA |EC |DSA )?(PUBLIC|PRIVATE) KEY-----([\s\S]{20,4000}?)-----END (?:RSA |EC |DSA )?\1 KEY-----/g;
    let m;
    while ((m = pemRe.exec(body)) !== null) {
        findings.push({ type: `PEM_${m[1]}_KEY`, value: m[0].replace(/\\n/g, '\n') });
    }

    // 2. Bare-base64 DER keys inside strings — no PEM wrapper.
    // RSA SPKI (public) starts with `MIIBIj...`, longer variants `MII[E-Z]...`.
    // RSA PKCS#8 (private) starts with `MIIEv...` / `MIIJKAI...`.
    // We require the value to sit inside a quoted string of substantial length
    // to keep false-positives down.
    const derRe = /['"`](MII[A-Za-z0-9+/]{160,4000}={0,3})['"`]/g;
    while ((m = derRe.exec(body)) !== null) {
        const val = m[1];
        // Classify by DER header prefix
        let kind = 'DER_KEY_MAYBE';
        if (val.startsWith('MIIBIj') || val.startsWith('MIICIj')) kind = 'DER_RSA_PUBLIC_KEY';
        else if (val.startsWith('MIIEv') || val.startsWith('MIIJKAI')) kind = 'DER_RSA_PRIVATE_KEY';
        else if (val.startsWith('MFkw') || val.startsWith('MHY')) kind = 'DER_EC_PUBLIC_KEY';
        findings.push({ type: kind, value: val });
    }

    // 3. Hardcoded key/secret assignments (JS/JSON-like)
    const assignRe = /["']?\b(rsaPublicKey|rsaPrivateKey|publicKey|privateKey|secretKey|aesKey|apiKey|api_key|appSecret|app_secret|hmacKey|signKey|encryptKey|encrypt_key|clientSecret|client_secret)["']?\s*[:=]\s*['"`]([A-Za-z0-9+/=_\-\\n\s]{16,4000})['"`]/g;
    while ((m = assignRe.exec(body)) !== null) {
        const raw = m[2].replace(/\\n/g, '\n').trim();
        if (raw.length >= 16) findings.push({ type: `HARDCODED_${m[1]}`, value: raw });
    }

    // 4. Bare AES-shaped hex constants assigned to a key-like variable.
    const hexKeyRe = /\b(?:key|iv|salt|secret|token)\w*\s*[:=]\s*['"]([a-fA-F0-9]{32}|[a-fA-F0-9]{48}|[a-fA-F0-9]{64})['"]/g;
    while ((m = hexKeyRe.exec(body)) !== null) {
        findings.push({ type: `HEX_KEY_${m[1].length * 4}bit`, value: m[1] });
    }

    // 5. JWTs
    const jwtRe = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
    while ((m = jwtRe.exec(body)) !== null) findings.push({ type: 'JWT', value: m[0] });

    return findings;
}

function reportSecrets(findings, sourceUrl) {
    for (const f of findings) {
        const sig = f.type + '|' + f.value.substring(0, 200);
        if (seenSecrets.has(sig)) continue;
        seenSecrets.add(sig);
        const preview = f.value.length > 400 ? f.value.substring(0, 400) + '...' : f.value;
        console.log(`${C.hlred}[\ud83d\udd11 SECRET] ${f.type}${C.reset} in ${C.dim}${sourceUrl}${C.reset}\n   ${C.green}${preview}${C.reset}`);
        writeLog({ type: 'secret_found', kind: f.type, url: sourceUrl, value: f.value });
    }
}

module.exports = { scanForSecrets, reportSecrets };
