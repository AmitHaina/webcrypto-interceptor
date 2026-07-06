async function enableAntiDebug(cdpSession) {
    try { await cdpSession.send('Debugger.setBlackboxPatterns', { patterns: ['.*'] }); } catch (e) {}
    try { await cdpSession.send('Debugger.setPauseOnExceptions', { state: 'none' }); } catch (e) {}
}

module.exports = { enableAntiDebug };
