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
        if (bodyObj.base64Encoded) {
            try {
                body = Buffer.from(bodyObj.body, 'base64').toString('utf8');
                console.log(`   ${C.dim}(base64-decoded ${bodyObj.body.length}B \u2192 ${body.length}B)${C.reset}`);
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
