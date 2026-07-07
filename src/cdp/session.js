const { C } = require('../util/colors');
const { enableAntiDebug } = require('./anti-debug');
const { attachNetworkCapture } = require('./network');
const { attachScriptScanner } = require('./scripts');
const { recordCryptoCall, armCryptoBreakpoints } = require('./crypto');

async function attachToSession(cdpSession, targetLabel) {
    try { await cdpSession.send('Runtime.enable'); } catch (e) {}
    try { await cdpSession.send('Debugger.enable'); } catch (e) {}
    await enableAntiDebug(cdpSession);
    await attachNetworkCapture(cdpSession);
    await attachScriptScanner(cdpSession);

    const bpMap = {};

    cdpSession.on('Debugger.paused', async (params) => {
        const hitBps = params.hitBreakpoints || [];
        if (hitBps.some(b => bpMap[b])) {
            try { await recordCryptoCall(cdpSession, params, bpMap, targetLabel); }
            catch (e) { console.warn(`${C.red}Record error:${C.reset}`, e.message); }
        }
        try { await cdpSession.send('Debugger.resume'); } catch (e) {}
    });

    await armCryptoBreakpoints(cdpSession, targetLabel, bpMap);
}

module.exports = { attachToSession };
