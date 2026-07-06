const { C } = require('../util/colors');
const { writeLog } = require('../util/log');
const { extractContentKey, extractHlsKeyUri } = require('../util/decoders');
const { RESP_KEYWORDS } = require('../config');

async function attachNetworkCapture(cdpSession) {
    try { await cdpSession.send('Network.enable'); } catch (e) { return; }

    cdpSession.on('Network.responseReceived', async (params) => {
        const response = params.response;
        const url = response.url;
        const lower = url.toLowerCase();
        if (!RESP_KEYWORDS.some(k => lower.includes(k))) return;

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
