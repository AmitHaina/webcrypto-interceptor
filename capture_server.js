const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const { C } = require('./src/util/colors');
const { writeLog, sessionLogFile } = require('./src/util/log');
const { shortUrl } = require('./src/util/decoders');
const { attachToSession } = require('./src/cdp/session');

const targetUrl = process.argv[2];
if (!targetUrl) {
    console.error('Usage: node capture_server.js <URL> [--gui]');
    process.exit(1);
}
const isHeadful = process.argv.includes('--gui');

function resolveChromePath() {
    if (process.platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return '/usr/bin/google-chrome';
}

function formatHookConsole(text) {
    const stripped = text.replace('[Reversed-Event] ', '');
    if (text.includes('PAYMENT-JSON')) return `${C.hlgrn}[💳 PAYMENT-JSON]${C.reset} ${C.green}${stripped.replace('PAYMENT-JSON: ', '')}${C.reset}`;
    if (text.includes('[Reversed-Event] VIDEO')) return `${C.magenta}[🎬 VIDEO]${C.reset} ${C.green}${stripped.replace('VIDEO ', '')}${C.reset}`;
    if (text.includes('WASAssembly.instantiate') || text.includes('[Reversed-Event] WASM')) return `${C.magenta}[🧬 WASM INJECT]${C.reset} ${C.dim}${stripped}${C.reset}`;
    if (text.includes('[Reversed-Event] BLOB CONTENT')) return `${C.hlgrn}[📄 BLOB CONTENT]${C.reset} ${C.green}${stripped.replace('BLOB CONTENT ', '')}${C.reset}`;
    if (text.includes('[Reversed-Event] BLOB URL')) return `${C.cyan}[🗂️  BLOB URL]${C.reset} ${C.dim}${stripped.replace('BLOB URL ', '')}${C.reset}`;
    if (text.includes('[Reversed-Event] WORKER') || text.includes('[Reversed-Event] PORT')) return `${C.magenta}[📨 MSG]${C.reset} ${C.green}${stripped}${C.reset}`;
    if (text.includes('STORAGE')) return `${C.yellow}[💾 STORAGE STATE]${C.reset} ${C.dim}${stripped}${C.reset}`;
    if (text.includes(' body: ') && !text.includes(' body: [binary')) return `${C.cyan}[🌐 NET]${C.reset} ${stripped}`;
    return `${C.blue}[⚓ EVENT]${C.reset} ${C.dim}${stripped}${C.reset}`;
}

(async () => {
    console.log(`\n${C.bold}=============================================================${C.reset}`);
    console.log(`${C.bold}🤖 WEBCRYPTO-INTERCEPTOR${C.reset}`);
    console.log(`📡 TARGET: ${targetUrl}`);
    console.log(`🖥️  MODE: ${isHeadful ? 'GUI (Headful)' : 'Headless'}`);
    console.log(`📝 LOG: ${sessionLogFile}`);
    console.log(`${C.bold}=============================================================${C.reset}\n`);

    const chromePath = resolveChromePath();
    const browser = await puppeteer.launch({
        headless: !isHeadful,
        executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--no-first-run', '--no-default-browser-check',
            '--disable-features=Translate',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-ipc-flooding-protection'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const hookCode = fs.readFileSync(path.join(__dirname, 'src', 'page', 'stealth.js'), 'utf8');
    await page.evaluateOnNewDocument(hookCode);

    const mainClient = await page.target().createCDPSession();
    try {
        const version = await mainClient.send('Browser.getVersion');
        if (version.userAgent && version.userAgent.includes('HeadlessChrome')) {
            await mainClient.send('Network.setUserAgentOverride', {
                userAgent: version.userAgent.replace('HeadlessChrome', 'Chrome')
            });
        }
    } catch (e) {}
    await attachToSession(mainClient, `main:${shortUrl(targetUrl)}`);

    const attachedTargets = new Set();
    async function tryAttachTarget(target) {
        if (attachedTargets.has(target)) return;
        const type = target.type();
        const url = target.url();
        if (!['page', 'iframe', 'other', 'webview'].includes(type)) return;
        if (url === 'about:blank' || url.startsWith('devtools://') || url.startsWith('chrome://')) return;
        attachedTargets.add(target);
        try {
            const childSession = await target.createCDPSession();
            try { await childSession.send('Page.addScriptToEvaluateOnNewDocument', { source: hookCode }); } catch (e) {}
            await attachToSession(childSession, `${type}:${shortUrl(url)}`);
        } catch (e) {}
    }
    browser.on('targetcreated', tryAttachTarget);
    browser.on('targetchanged', tryAttachTarget);

    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('[Reversed-Event]')) {
            writeLog({ type: 'hook_event', message: text });
            console.log(formatHookConsole(text));
            return;
        }
        if (msg.type() === 'error') {
            console.log(`${C.red}[Browser ERROR]${C.reset} ${text.substring(0, 200)}`);
        }
    });

    console.log(`${C.dim}Navigating to page...${C.reset}\n`);
    try {
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log(`\n${C.green}✅ Page loaded.${C.reset}`);
    } catch (e) {
        console.warn(`${C.yellow}⚠️  Navigation timeout (page may still be usable):${C.reset} ${e.message}`);
    }
    console.log(`\n${C.bold}🌟 STREAMING (Ctrl+C to stop). Interact with the page to trigger events. Watch for [🔓 CRYPTO BOUNDARY], [🌐 NET] and [💾 STORAGE STATE].${C.reset}\n`);
})();
