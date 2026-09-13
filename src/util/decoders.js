function shortUrl(u) { return (u || '').replace(/^https?:\/\//, '').substring(0, 50); }

function decodeHexEscapes(v) {
    if (/\\+x[0-9a-fA-F]{2}/i.test(v)) {
        return v.replace(/\\+x([0-9a-fA-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
    return v;
}

function decodeBase(token, radix) {
    if (radix <= 36) {
        const n = parseInt(token, radix);
        return isNaN(n) ? -1 : n;
    }
    let val = 0;
    for (let i = 0; i < token.length; i++) {
        const code = token.charCodeAt(i);
        let digit;
        if (code >= 48 && code <= 57) digit = code - 48;
        else if (code >= 97 && code <= 122) digit = code - 87;
        else if (code >= 65 && code <= 90) digit = code - 29;
        else return -1;
        val = val * radix + digit;
    }
    return val;
}

const PACKER_RE = /(?:eval\s*\(\s*)?function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[rd]\s*\)\s*\{[\s\S]*?\}\s*\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*\.split\(\s*['"]\|['"]\s*\)(?:[\s\S]*?\)\s*\)|\))/g;

function isPacked(text) {
    if (!text || typeof text !== 'string') return false;
    return /(?:eval\s*\(\s*)?function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[rd]\s*\)/i.test(text);
}

function unpack(text) {
    if (!isPacked(text)) return text;

    let current = text;
    let maxPasses = 3;

    while (maxPasses-- > 0 && isPacked(current)) {
        let changed = false;
        current = current.replace(PACKER_RE, (fullMatch, rawPayload, radixStr, countStr, rawSymtab) => {
            changed = true;
            const radix = parseInt(radixStr, 10);
            const rawPayloadInner = rawPayload.substring(1, rawPayload.length - 1);
            const symtabStr = rawSymtab.substring(1, rawSymtab.length - 1);

            let payload = rawPayloadInner;
            if (rawPayload[0] === "'") {
                payload = payload.replace(/\\'/g, "'");
            } else {
                payload = payload.replace(/\\"/g, '"');
            }

            const symtab = symtabStr.split('|');

            return payload.replace(/\b\w+\b/g, (token) => {
                const idx = decodeBase(token, radix);
                if (idx >= 0 && idx < symtab.length && symtab[idx]) {
                    return symtab[idx];
                }
                return token;
            });
        });
        if (!changed) break;
    }

    return current;
}

function tryBase64ToHex(v) {
    try {
        const trimmed = v.trim();
        if (/^[0-9a-fA-F]{16,64}$/.test(trimmed)) return trimmed;

        // Check if base64 represents binary AES key bytes (16, 24, or 32 bytes)
        // Ensure base64 string structure is valid to avoid false positives on random strings
        if (/^[A-Za-z0-9+/=_-]{20,64}$/.test(trimmed)) {
            const buf = Buffer.from(trimmed, 'base64');
            if ([16, 24, 32].includes(buf.length)) {
                return buf.toString('hex');
            }
        }

        const b = Buffer.from(v, 'base64').toString('utf8');
        if (/^[0-9a-fA-F]{16,64}$/.test(b.trim())) return b.trim();
    } catch (e) {}
    return v;
}

function extractContentKey(body) {
    const m = body.match(/"(ck|key|contentKey|contentkey|aesKey|aeskey)"\s*:\s*"([^"]+)"/i);
    if (!m) return null;
    const raw = m[2];
    const unescaped = decodeHexEscapes(raw);
    const decoded = tryBase64ToHex(unescaped);
    return { field: m[1], raw, decoded };
}

function extractHlsKeyUri(body) {
    const m = body.match(/#EXT-X-KEY:[^\r\n]*?URI="([^"]+)"(?:[^\r\n]*?IV=(0x[0-9a-fA-F]+))?/i);
    if (!m) return null;
    return { keyUri: m[1], iv: m[2] || null };
}

module.exports = {
    shortUrl,
    decodeHexEscapes,
    tryBase64ToHex,
    extractContentKey,
    extractHlsKeyUri,
    decodeBase,
    isPacked,
    unpack
};
