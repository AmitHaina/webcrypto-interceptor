function shortUrl(u) { return (u || '').replace(/^https?:\/\//, '').substring(0, 50); }

function decodeHexEscapes(v) {
    if (/\\x[0-9a-fA-F]{2}/.test(v)) {
        return v.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
    return v;
}

function tryBase64ToHex(v) {
    try {
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

module.exports = { shortUrl, decodeHexEscapes, tryBase64ToHex, extractContentKey, extractHlsKeyUri };
