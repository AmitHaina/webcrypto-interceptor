const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const targetUrl = process.argv[2];
if (!targetUrl) {
    console.error('Usage: node capture_server.js <URL> [--gui]');
    process.exit(1);
}
const isHeadful = process.argv.includes('--gui');

// Write capturing raw events directly to a JSONL log file
const sessionLogFile = `session_capture_${Date.now()}.jsonl`;

function writeLog(event) {
    fs.appendFileSync(sessionLogFile, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n');
}

// ANSI colors
const C = {
    reset: '\x1b[0m', dim: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m',
    yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
    bold: '\x1b[1m', hlred: '\x1b[41m\x1b[97m', hlgrn: '\x1b[42m\x1b[97m'
};

const SUBTLE_METHODS = ['encrypt', 'decrypt', 'sign', 'verify', 'digest',
                        'deriveBits', 'deriveKey', 'importKey', 'exportKey',
                        'wrapKey', 'unwrapKey', 'generateKey'];

// Function to run INSIDE the paused page to decode ArrayBuffer/TypedArray
const DECODE_FN = `function(){
    var u;
    if(this instanceof ArrayBuffer) u = new Uint8Array(this);
    else if(ArrayBuffer.isView(this)) u = new Uint8Array(this.buffer, this.byteOffset, this.byteLength);
    else return null;
    var hex = '', utf8 = '';
    var limit = Math.min(u.length, 512);
    for(var i = 0; i < limit; i++){ hex += (u[i] < 16 ? '0' : '') + u[i].toString(16); }
    try { utf8 = new TextDecoder('utf-8', {fatal: false}).decode(u.slice(0, 2048)); } catch(e){}
    return { length: u.length, hex: hex, utf8: utf8 };
}`;

function shortUrl(u) { return (u || '').replace(/^https?:\/\//, '').substring(0, 50); }

async function recordCryptoCall(cdpSession, params, bpMap, targetLabel) {
    const frames = params.callFrames || [];
    if (!frames.length) return;

    const hitBps = params.hitBreakpoints || [];
    const method = hitBps.map(b => bpMap[b]).find(m => m) || 'crypto.subtle.*';
    const caller = frames[0];
    const callerName = caller.functionName || '<anonymous>';
    const inputs = [];

    // Form absolute stack trace
    const stackTrace = frames.map(f => {
        const file = f.url ? shortUrl(f.url) : '<anonymous>';
        return `   at ${f.functionName || '<anonymous>'} (${file}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1})`;
    }).slice(0, 5).join('\n');

    // Walk the caller's scope chain and decode every variable in reach
    for (const scope of (caller.scopeChain || [])) {
        if (!['local', 'closure', 'block'].includes(scope.type)) continue;
        const scopeObjectId = scope.object && scope.object.objectId;
        if (!scopeObjectId) continue;

        let props;
        try {
            const resp = await cdpSession.send('Runtime.getProperties', {
                objectId: scopeObjectId, ownProperties: true
            });
            props = resp.result || [];
        } catch (e) { continue; }

        for (const prop of props) {
            const value = prop.value || {};

            if (value.type === 'string' && value.value) {
                inputs.push({ name: prop.name, kind: 'string', value: value.value.substring(0, 1024) });
            } else if (['arraybuffer', 'typedarray', 'dataview'].includes(value.subtype) && value.objectId) {
                try {
                    const decoded = await cdpSession.send('Runtime.callFunctionOn', {
                        objectId: value.objectId, functionDeclaration: DECODE_FN, returnByValue: true
                    });
                    if (decoded.result && decoded.result.value) {
                        inputs.push({ name: prop.name, kind: value.subtype, ...decoded.result.value });
                    }
                } catch (e) {}
            } else if (value.type === 'object' && value.className === 'Object' && value.objectId) {
                try {
                    const jsonResp = await cdpSession.send('Runtime.callFunctionOn', {
                        objectId: value.objectId,
                        functionDeclaration: 'function(){ try { return JSON.stringify(this); } catch(e) { return null; } }',
                        returnByValue: true
                    });
                    if (jsonResp.result && jsonResp.result.value) {
                        inputs.push({ name: prop.name, kind: 'object', value: jsonResp.result.value.substring(0, 2048) });
                    }
                } catch (e) {}
            }
        }
    }

    // Output visual stream
    console.log(`\n${C.hlred}[🔓 CRYPTO BOUNDARY] ${method}${C.reset} in ${C.magenta}${targetLabel}${C.reset} called by ${C.yellow}${callerName}${C.reset}`);
    console.log(`${C.dim}${stackTrace}${C.reset}`);
    
    for (const input of inputs) {
        if (input.kind === 'string' && input.value.length > 0) {
            console.log(`   ${C.cyan}${input.name}${C.reset} (string): ${C.green}${input.value}${C.reset}`);
        } else if (input.kind === 'object') {
            console.log(`   ${C.cyan}${input.name}${C.reset} (object): ${C.green}${input.value}${C.reset}`);
        } else if (input.utf8 !== undefined) {
            const printable = /^[\x20-\x7E\s]*$/.test(input.utf8);
            if (printable && input.utf8.trim().length > 0) {
                console.log(`   ${C.cyan}${input.name}${C.reset} (${input.kind}, ${input.length}B utf8): ${C.green}${input.utf8}${C.reset}`);
            } else {
                console.log(`   ${C.cyan}${input.name}${C.reset} (${input.kind}, ${input.length}B): ${C.dim}${input.hex.substring(0, 128)}${C.reset}`);
            }
        }
    }

    // Save to persistence
    writeLog({
        type: 'crypto_call',
        method,
        target: targetLabel,
        caller: callerName,
        stack: frames.map(f => ({ fn: f.functionName, url: f.url, line: f.location.lineNumber, col: f.location.columnNumber })),
        inputs: inputs.map(i => ({ name: i.name, kind: i.kind, value: i.value || i.hex || i.utf8 }))
    });
}

async function attachCryptoLoggerToSession(cdpSession, targetLabel) {
    try { await cdpSession.send('Runtime.enable'); } catch (e) {}
    try { await cdpSession.send('Debugger.enable'); } catch (e) {}
    // Anti-anti-debug: blackbox every script so `debugger;` statements in loops
    // don't pause our session. Our function-call breakpoints on native
    // crypto.subtle.* still fire because they target the native function itself.
    try {
        await cdpSession.send('Debugger.setBlackboxPatterns', { patterns: ['.*'] });
    } catch (e) {}
    // Also tell the debugger to skip past any debugger statements it does encounter
    try {
        await cdpSession.send('Debugger.setPauseOnExceptions', { state: 'none' });
    } catch (e) {}
    try {
        await cdpSession.send('Network.enable');
        // Capture HTTP response bodies for interesting endpoints:
        //  - Payment / auth (2c2p, stripe, checkCard, /pay, /token, /auth)
        //  - Streaming resolvers (/player, /getVideo, /source, /manifest)
        //  - HLS/DASH playlists (.m3u8, .mpd)
        //  - AES key files (.key, /key/, keyformat identifiers)
        const RESP_KEYWORDS = [
            'payment', '2c2p', 'checkcard', '/pay', '/token', '/auth',
            '/player', 'getvideo', '/source', '/manifest', '/stream',
            '.m3u8', '.mpd', '.key', '/key/', 'keyformat'
        ];
        cdpSession.on('Network.responseReceived', async (params) => {
            const response = params.response;
            const url = response.url;
            const lower = url.toLowerCase();
            if (RESP_KEYWORDS.some(k => lower.includes(k))) {
                try {
                    const bodyObj = await cdpSession.send('Network.getResponseBody', { requestId: params.requestId });
                    console.log(`\n${C.yellow}[📥 NET RESP] ${response.status} ${url}${C.reset}`);
                    if (bodyObj.body) {
                        // CDP returns base64Encoded=true for binary payloads. Decode so
                        // the terminal shows the real bytes (m3u8, SVG, keys, etc.)
                        let body = bodyObj.body;
                        if (bodyObj.base64Encoded) {
                            try {
                                body = Buffer.from(bodyObj.body, 'base64').toString('utf8');
                                console.log(`   ${C.dim}(base64-decoded ${bodyObj.body.length}B \u2192 ${body.length}B)${C.reset}`);
                            } catch (e) {
                                body = bodyObj.body; // fallback to raw
                            }
                        }

                        // Auto-decode 'ck'/'key'/'contentKey' fields (hex-escaped base64)
                        try {
                            const keyMatch = body.match(/"(ck|key|contentKey|contentkey|aesKey|aeskey)"\s*:\s*"([^"]+)"/i);
                            if (keyMatch) {
                                let v = keyMatch[2];
                                // decode \xHH sequences
                                if (/\\x[0-9a-fA-F]{2}/.test(v)) {
                                    v = v.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
                                }
                                // if result looks like base64, decode
                                let decoded = v;
                                try {
                                    const b = Buffer.from(v, 'base64').toString('utf8');
                                    if (/^[0-9a-fA-F]{16,64}$/.test(b.trim())) decoded = b.trim();
                                } catch (e) {}
                                console.log(`   ${C.hlred}\ud83d\udd11 CONTENT KEY (${keyMatch[1]}): ${decoded}${C.reset}`);
                                writeLog({ type: 'content_key', url, field: keyMatch[1], raw: keyMatch[2], decoded });
                            }
                        } catch (e) {}

                        // Highlight HLS AES key URIs inside m3u8
                        const keyUriMatch = body.match(/#EXT-X-KEY:[^\r\n]*URI="([^"]+)"[^\r\n]*(?:IV=(0x[0-9a-fA-F]+))?/i);
                        if (keyUriMatch) {
                            console.log(`   ${C.hlred}\ud83d\udd10 HLS AES KEY URI: ${keyUriMatch[1]}${keyUriMatch[2] ? '  IV=' + keyUriMatch[2] : ''}${C.reset}`);
                            writeLog({ type: 'hls_key_ref', url, keyUri: keyUriMatch[1], iv: keyUriMatch[2] || null });
                        }

                        const preview = body.length > 1500 ? body.substring(0, 1500) + '...' : body;
                        console.log(`   ${C.dim}${preview}${C.reset}`);
                        writeLog({ type: 'http_response', url, status: response.status, body });
                    }
                } catch(err) {
                    // Body might not be available or already consumed
                }
            }
        });
    } catch(e) {}

    const bpMap = {};

    // Wire the paused handler for THIS session
    cdpSession.on('Debugger.paused', async (params) => {
        const hitBps = params.hitBreakpoints || [];
        if (hitBps.some(b => bpMap[b])) {
            try { await recordCryptoCall(cdpSession, params, bpMap, targetLabel); }
            catch (e) { console.warn(`${C.red}Record error:${C.reset}`, e.message); }
        }
        try { await cdpSession.send('Debugger.resume'); } catch (e) {}
    });

    // Set breakpoints on THIS session's crypto.subtle.*
    let armed = 0;
    for (const method of SUBTLE_METHODS) {
        try {
            const fn = await cdpSession.send('Runtime.evaluate', {
                expression: `crypto.subtle.${method}`, silent: true
            });
            if (fn.result && fn.result.type === 'function' && fn.result.objectId) {
                const bp = await cdpSession.send('Debugger.setBreakpointOnFunctionCall', {
                    objectId: fn.result.objectId
                });
                if (bp.breakpointId) {
                    bpMap[bp.breakpointId] = `crypto.subtle.${method}`;
                    armed++;
                }
            }
        } catch (e) {}
    }
    if (armed > 0) {
        console.log(`${C.magenta}[🕷️  CRYPTO HOOK]${C.reset} ${armed} breakpoints armed on ${C.cyan}${targetLabel}${C.reset}`);
    }
}

(async () => {
    console.log(`\n${C.bold}=============================================================${C.reset}`);
    console.log(`${C.bold}🤖 STEALTH RE INSTRUMENTATION SERVER${C.reset}`);
    console.log(`📡 TARGET: ${targetUrl}`);
    console.log(`🖥️  MODE: ${isHeadful ? 'GUI (Headful)' : 'Headless'}`);
    console.log(`${C.bold}=============================================================${C.reset}\n`);

    let defaultExecutablePath;
    if (process.platform === 'win32') {
        defaultExecutablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    } else if (process.platform === 'darwin') {
        defaultExecutablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    } else {
        defaultExecutablePath = '/usr/bin/google-chrome';
    }

    const browser = await puppeteer.launch({
        headless: !isHeadful,
        executablePath: fs.existsSync(defaultExecutablePath) ? defaultExecutablePath : undefined,
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

    const hookSourcePath = path.join(__dirname, 'stealth_hooks.js');
    const hookCode = fs.readFileSync(hookSourcePath, 'utf8');

    // Inject minimal hooks into main page + all iframes on document_start
    await page.evaluateOnNewDocument(hookCode);

    // Attach crypto logger to MAIN page CDP session
    const mainClient = await page.target().createCDPSession();
    try {
        const version = await mainClient.send('Browser.getVersion');
        if (version.userAgent && version.userAgent.includes('HeadlessChrome')) {
            await mainClient.send('Network.setUserAgentOverride', {
                userAgent: version.userAgent.replace('HeadlessChrome', 'Chrome')
            });
        }
    } catch (e) {}
    await attachCryptoLoggerToSession(mainClient, `main:${shortUrl(targetUrl)}`);

    // === CRITICAL FIX: Attach crypto logger to EACH child target with its OWN session ===
    // 2C2P runs in an out-of-process iframe (OOPIF) with its own V8 context and its own
    // crypto.subtle object. We must create a proper child CDPSession per target.
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
            await attachCryptoLoggerToSession(childSession, `${type}:${shortUrl(url)}`);
        } catch (e) {
            // Some targets don't support CDP session creation; ignore
        }
    }

    browser.on('targetcreated', tryAttachTarget);
    browser.on('targetchanged', tryAttachTarget);

    // Console filter — only surface high-signal events
    page.on('console', msg => {
        const text = msg.text();
        const type = msg.type();

        if (text.includes('[Reversed-Event]')) {
            writeLog({ type: 'hook_event', message: text });
            
            if (text.includes('PAYMENT-JSON')) {
                console.log(`${C.hlgrn}[💳 PAYMENT-JSON]${C.reset} ${C.green}${text.replace('[Reversed-Event] PAYMENT-JSON: ', '')}${C.reset}`);
            } else if (text.includes('[Reversed-Event] VIDEO')) {
                console.log(`${C.magenta}[🎬 VIDEO]${C.reset} ${C.green}${text.replace('[Reversed-Event] VIDEO ', '')}${C.reset}`);
            } else if (text.includes('WASAssembly.instantiate')) {
                console.log(`${C.magenta}[🧬 WASM INJECT]${C.reset} ${C.dim}${text.replace('[Reversed-Event] ', '')}${C.reset}`);
            } else if (text.includes('STORAGE')) {
                console.log(`${C.yellow}[💾 STORAGE STATE]${C.reset} ${C.dim}${text.replace('[Reversed-Event] ', '')}${C.reset}`);
            } else if (text.includes(' body: ') && !text.includes(' body: [binary')) {
                console.log(`${C.cyan}[🌐 NET]${C.reset} ${text.replace('[Reversed-Event] ', '')}`);
            } else {
                console.log(`${C.blue}[⚓ EVENT]${C.reset} ${C.dim}${text.replace('[Reversed-Event] ', '')}${C.reset}`);
            }
            return;
        }
        if (type === 'error') {
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
