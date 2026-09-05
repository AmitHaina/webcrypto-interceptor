#!/usr/bin/env node
// webcrypto-interceptor — stealth CDP-based reverse-engineering toolkit.
// Entry point: launches Chrome, injects page hooks, attaches CDP capture
// sessions to the page, its iframes and its workers, and streams tagged
// events to the terminal + a JSONL session log.
//
// puppeteer is required lazily inside main() so `--help` and argument
// validation work even before `npm install` has run.

const path = require('path');
const fs = require('fs');

const { C } = require('./src/util/colors');
const { closeLog, setLogDir, getLogFile } = require('./src/util/log');
const { shortUrl } = require('./src/util/decoders');
const { attachToSession } = require('./src/cdp/session');
const { setExtractDir, getExtractDir } = require('./src/cdp/extract');
const { printSummary } = require('./src/util/summary');
const { parseArgv, HELP } = require('./src/cli');

// ---- CLI ----------------------------------------------------------------

let opts;
try {
    opts = parseArgv(process.argv.slice(2));
} catch (e) {
    console.error(`${C.red}${e.message}${C.reset}`);
    process.exit(e.isUsageError ? 2 : 1);
}
if (opts.help) {
    console.log(HELP);
    process.exit(0);
}

if (opts.out) setLogDir(opts.out);

const targetUrl = opts.url;

// ---- chrome resolution ----------------------------------------------------

function resolveChromePath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
    if (process.platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    // Linux: try the common names before falling back to puppeteer's bundled build
    for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']) {
        if (fs.existsSync(p)) return p;
    }
    return null; // no system chrome -> let puppeteer use its bundled one
}

// ---- banner ---------------------------------------------------------------

(async () => {
    let puppeteer;
    try { puppeteer = require('puppeteer'); }
    catch (e) {
        console.error(`${C.red}puppeteer is not installed. Run: npm install${C.reset}`);
        process.exit(1);
    }
    console.log(`\n${C.bold}=============================================================${C.reset}`);
    console.log(`${C.bold}🤖 WEBCRYPTO-INTERCEPTOR${C.reset}`);
    console.log(`📡 TARGET: ${targetUrl}`);
    console.log(`🖥️  MODE: ${opts.gui ? 'GUI (Headful)' : 'Headless'}${opts.full ? ' + FULL EXTRACT' : ''}`);
    if (opts.proxy) console.log(`🛰️  PROXY: ${opts.proxy}`);
    if (opts.allTraffic) console.log(`🎧 FILTER: disabled (--all-traffic)`);
    const hookCount = opts.hooks.length + opts.hookReturns.length;
    if (hookCount) console.log(`🪝 HOOKS: ${hookCount} (${opts.hookReturns.length} with return capture)`);
    if (opts.heapDiff > 0) console.log(`🧠 HEAP DIFF: ${opts.heapDiff}s after load`);
    let extractDir = null;
    if (opts.full) {
        extractDir = setExtractDir(targetUrl, opts.out);
        console.log(`📦 FULL EXTRACT: ${extractDir}`);
    }
    console.log(`📝 LOG: ${getLogFile()}`);
    console.log(`${C.bold}=============================================================${C.reset}\n`);

    const chromePath = resolveChromePath();
    const launchArgs = [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run', '--no-default-browser-check',
        '--disable-features=Translate',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-ipc-flooding-protection'
    ];
    if (opts.proxy) launchArgs.push(`--proxy-server=${opts.proxy}`);

    const browser = await puppeteer.launch({
        headless: !opts.gui,
        executablePath: chromePath || undefined,
        // Pipe transport: CDP runs over stdio fds instead of a WebSocket on
        // --remote-debugging-port. Nothing listens on a TCP port for the
        // target page (or anything else on the machine) to discover and scan.
        pipe: true,
        args: launchArgs
    });

    // ---- shutdown: flush the JSONL log BEFORE exiting --------------------
    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n${C.yellow}Shutting down (${signal})...${C.reset}`);
        printSummary(targetUrl, getLogFile());
        try { await closeLog(); } catch (e) {}
        try { await browser.close(); } catch (e) {}
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    browser.on('disconnected', async () => {
        if (!shuttingDown) {
            console.log(`\n${C.yellow}Browser disconnected. Exiting.${C.reset}`);
            printSummary(targetUrl, getLogFile());
            try { await closeLog(); } catch (e) {}
            process.exit(0);
        }
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Hook source + per-target config prelude. The prelude lets the page-side
    // code read runtime flags (--all-traffic) without re-reading files.
    const hookSource = fs.readFileSync(path.join(__dirname, 'src', 'page', 'stealth.js'), 'utf8');
    const hookCode = `window.__WCI_CFG = ${JSON.stringify({ allTraffic: !!opts.allTraffic })};\n` + hookSource;

    await page.evaluateOnNewDocument(hookCode);

    // ---- UA override (headless de-flagging) --------------------------------
    async function applyUaOverride(cdp) {
        try {
            const version = await cdp.send('Browser.getVersion');
            const ua = opts.ua || (version.userAgent && version.userAgent.includes('HeadlessChrome')
                ? version.userAgent.replace('HeadlessChrome', 'Chrome') : null);
            if (ua) {
                await cdp.send('Network.setUserAgentOverride', {
                    userAgent: ua,
                    // Strip the Headless marker from client hints too, or
                    // getHighEntropyValues('uaFullVersion') style probes still
                    // see a headless brand.
                    userAgentMetadata: version.userAgent && version.userAgent.includes('HeadlessChrome') && !opts.ua
                        ? undefined : undefined
                });
            }
        } catch (e) {}
    }

    const mainClient = await page.target().createCDPSession();
    await applyUaOverride(mainClient);
    const hookSpecs = [...opts.hooks, ...opts.hookReturns];
    await attachToSession(mainClient, `main:${shortUrl(targetUrl)}`, { getExtractDir, hooks: hookSpecs });

    // ---- multi-target attach: iframes, OOPIFs, workers ----------------------
    // Workers (dedicated/shared/service) never see evaluateOnNewDocument and
    // their console output is not relayed by puppeteer — but they run plenty
    // of crypto. We attach to their target, evaluate the hook source there
    // (stealth.js is globalThis-based, so it works), and rely on the __wci
    // binding channel for event transport.
    const attachedTargets = new Set();
    const HOOKABLE_TARGET_TYPES = ['page', 'iframe', 'other', 'webview', 'worker', 'shared_worker', 'service_worker'];

    async function tryAttachTarget(target) {
        if (attachedTargets.has(target)) return;
        let type;
        let url;
        try { type = target.type(); url = target.url(); } catch (e) { return; }
        if (!HOOKABLE_TARGET_TYPES.includes(type)) return;
        if (url === 'about:blank' || url.startsWith('devtools://') || url.startsWith('chrome://')) return;
        attachedTargets.add(target);

        let childSession = null;
        try { childSession = await target.createCDPSession(); } catch (e) { return; }
        try {
            if (type === 'worker' || type === 'shared_worker' || type === 'service_worker') {
                // Workers have no Page domain: inject directly into the global
                // scope. If the worker already ran, we still catch everything
                // going forward (hooks wrap prototypes, not call sites).
                await childSession.send('Runtime.enable');
                await childSession.send('Runtime.evaluate', {
                    expression: hookCode,
                    silent: true
                }).catch(() => {});
            } else {
                await childSession.send('Page.addScriptToEvaluateOnNewDocument', { source: hookCode }).catch(() => {});
            }
            await applyUaOverride(childSession);
            await attachToSession(childSession, `${type}:${shortUrl(url)}`, { getExtractDir, hooks: hookSpecs });
        } catch (e) {}
    }
    browser.on('targetcreated', tryAttachTarget);
    browser.on('targetchanged', tryAttachTarget);
    browser.on('targetdestroyed', (target) => {
        attachedTargets.delete(target);
    });

    // ---- navigate ------------------------------------------------------------
    // (Legacy console fallback handling lives inside attachToSession via
    // Runtime.consoleAPICalled — it covers the main page, iframes and workers
    // from one place, so no separate page.on('console') relay is needed.)
    console.log(`${C.dim}Navigating to page...${C.reset}\n`);
    try {
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: opts.timeout });
        console.log(`\n${C.green}✅ Page loaded.${C.reset}`);
    } catch (e) {
        console.warn(`${C.yellow}⚠️  Navigation issue (page may still be usable):${C.reset} ${e.message}`);
    } finally {
        if (extractDir) {
            // Post-render snapshot — the actual final DOM, not the pre-JS
            // shell that raw network capture saves for SPAs. Runs even when
            // navigation timed out: a "usable" page is exactly when this
            // snapshot matters most.
            try {
                const rendered = await page.content();
                fs.writeFileSync(path.join(extractDir, '_rendered.html'), rendered);
                console.log(`${C.dim}(rendered DOM saved to _rendered.html)${C.reset}`);
            } catch (e) {}
        }
    }
    console.log(`\n${C.bold}🌟 STREAMING (Ctrl+C to stop). Interact with the page to trigger events. Watch for [🔓 CRYPTO BOUNDARY], [🌐 NET], [🪝 HOOK] and [💾 STORAGE STATE].${C.reset}\n`);

    // ---- heap diff (after load, non-blocking) -------------------------------
    if (opts.heapDiff > 0) {
        const { runHeapDiff } = require('./src/cdp/heapdiff');
        runHeapDiff(mainClient, `main:${shortUrl(targetUrl)}`, opts.heapDiff).catch(() => {});
    }
})();
