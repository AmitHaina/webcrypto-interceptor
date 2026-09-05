// Hook-event handling for all CDP sessions (main page, iframes, workers).
//
// Events reach us through two channels:
//   1. STRUCTURED (preferred): the page-side hook calls the `__wci` binding
//      (installed via Runtime.addBinding) with a JSON envelope:
//        { uid, type, data }            — normal event
//        { uid, type: 'wasm_hex', seq, of, hex, hash } — chunked big payloads
//   2. LEGACY (fallback): console.log lines tagged "[Reversed-Event] ..." —
//      parsed with the original string matching, used when a context has no
//      binding (e.g. attached mid-flight) or the binding call throws.
//
// Both channels dedupe by uid, so a hook that falls back after a failed
// binding call never double-reports.

const fs = require('fs');
const path = require('path');
const { C } = require('../util/colors');
const { writeLog } = require('../util/log');
const { shortUrl } = require('../util/decoders');
const { trackEvent, trackSecret, trackWasmDump } = require('../util/summary');

// Dedupe window for event uids (Set with FIFO cap).
const seenUids = new Set();
const MAX_UIDS = 20000;
function isDuplicate(uid) {
    if (!uid) return false;
    if (seenUids.has(uid)) return true;
    seenUids.add(uid);
    if (seenUids.size > MAX_UIDS) {
        // Sets keep insertion order — drop the oldest fifth.
        let drop = Math.floor(MAX_UIDS / 5);
        for (const v of seenUids) { seenUids.delete(v); if (--drop <= 0) break; }
    }
    return false;
}

// Chunked payload reassembly (wasm_hex): chunkId -> {parts: Map, total, hash}
const pendingChunks = new Map();
const CHUNK_TTL_MS = 120000;
function reassembleChunks(evt) {
    const now = Date.now();
    for (const [k, s] of pendingChunks) {
        if (now - s.ts > CHUNK_TTL_MS) pendingChunks.delete(k);
    }
    const id = evt.uid || evt.hash;
    let slot = pendingChunks.get(id);
    if (!slot) {
        slot = { ts: now, total: evt.of, hash: evt.hash, parts: new Map() };
        pendingChunks.set(id, slot);
    }
    slot.parts.set(evt.seq, evt.hex || '');
    if (slot.parts.size < slot.total) return null;
    let hex = '';
    for (let i = 0; i < slot.total; i++) hex += slot.parts.get(i) || '';
    pendingChunks.delete(id);
    return hex;
}

// ---- structured event -> console coloring -------------------------------

const tagMap = {
    fetch:        (d) => [`${C.cyan}[🌐 NET]${C.reset}`, `${d.video ? C.magenta + '[🎬 VIDEO] ' : ''}[${d.method || 'GET'}] ${d.url} body: ${d.body}`.trim()],
    xhr:          (d) => [`${C.cyan}[🌐 NET]${C.reset}`, `[${d.method || 'GET'}] ${d.url} body: ${d.body}`],
    beacon:       (d) => [`${C.cyan}[🌐 NET]${C.reset}`, `sendBeacon ${d.url} body: ${d.body}`],
    ws_send:      (d) => [`${C.cyan}[🌐 NET]${C.reset}`, `WebSocket [SEND] ${d.url} body: ${d.body}`],
    ws_recv:      (d) => [`${C.cyan}[🌐 NET]${C.reset}`, `WebSocket [RECV] ${d.url} body: ${d.body}`],
    worker_msg:   (d) => [`${C.magenta}[📨 MSG]${C.reset}`, `${d.source === 'port' ? 'PORT' : 'WORKER'} postMessage: ${d.preview}`],
    blob_url:     (d) => [`${C.cyan}[🗂️  BLOB URL]${C.reset}`, `${d.url} type=${d.type} size=${d.size}B`],
    blob_content: (d) => [`${C.hlgrn}[📄 BLOB CONTENT]${C.reset}`, `${d.url}: ${d.snippet}`],
    storage:      (d) => [`${C.yellow}[💾 STORAGE STATE]${C.reset}`, `[${d.storage}] set ${d.key} = ${d.value}`],
    random:       (d) => [`${C.blue}[🎲 RANDOM]${C.reset}`, `getRandomValues ${d.t} len=${d.len} hex=${d.hex}`],
    crypto_args:  (d) => [`${C.hlred}[🔓 CRYPTO ARGS]${C.reset}`, `${d.method} ${d.args}`],
    jscrypto:     (d) => [`${C.hlred}[🔐 JSCRYPTO]${C.reset}`, `${d.label} ${d.payload}`],
    hook_init:    (d) => [`${C.dim}[⚓ HOOK]${C.reset}`, d.lib],
    wasm:         (d) => [`${C.magenta}[🧬 WASM INJECT]${C.reset}`, `WebAssembly.${d.method} of ${d.bytes} bytes hash=${d.hash}`]
};

function logStructured(evt, targetLabel) {
    const d = evt.data || {};
    const render = tagMap[evt.type];
    if (evt.type === 'wasm_hex') return; // handled by dump path below
    if (render) {
        const [tag, rest] = render(d);
        console.log(`\n${tag}${targetLabel ? ` ${C.dim}(${targetLabel})${C.reset}` : ''} ${rest}`);
    } else {
        console.log(`${C.blue}[⚓ EVENT]${C.reset} ${C.dim}${evt.type}${C.reset} ${JSON.stringify(d).substring(0, 300)}`);
    }
    // Persist a plain-text mirror of the event (same shape as the legacy
    // console format so post-processors like scripts/extract-keys.js work
    // unchanged on both channels).
    const legacyText = structuredToLegacy(evt);
    if (legacyText) writeLog({ type: 'hook_event', channel: 'binding', message: legacyText });
    else writeLog({ type: 'hook_event', channel: 'binding', event: evt });
}

// Convert a structured event back into the legacy "[Reversed-Event] ..." text
// format so downstream tooling keeps working regardless of channel.
function structuredToLegacy(evt) {
    const d = evt.data || {};
    switch (evt.type) {
        case 'fetch':        return `[Reversed-Event] ${d.video ? 'VIDEO' : 'fetch'} [${d.method || 'GET'}] ${d.url}${d.body ? ' body: ' + d.body : ''}`;
        case 'xhr':          return `[Reversed-Event] ${d.video ? 'VIDEO' : 'XHR'} [${d.method || 'GET'}] ${d.url}${d.body ? ' body: ' + d.body : ''}`;
        case 'beacon':       return `[Reversed-Event] sendBeacon ${d.url}${d.body ? ' body: ' + d.body : ''}`;
        case 'ws_send':      return `[Reversed-Event] WebSocket [SEND] ${d.url} body: ${d.body}`;
        case 'ws_recv':      return `[Reversed-Event] WebSocket [RECV] ${d.url} body: ${d.body}`;
        case 'worker_msg':   return `[Reversed-Event] ${d.source === 'port' ? 'PORT' : 'WORKER'} postMessage: ${d.preview}`;
        case 'blob_url':     return `[Reversed-Event] BLOB URL ${d.url} type=${d.type} size=${d.size}B`;
        case 'blob_content': return `[Reversed-Event] BLOB CONTENT ${d.url}: ${d.snippet}`;
        case 'storage':      return `[Reversed-Event] STORAGE [${d.storage}] set ${d.key} = ${d.value}`;
        case 'random':       return `[Reversed-Event] CRYPTO-ARGS getRandomValues ${d.raw}`;
        case 'crypto_args':  return `[Reversed-Event] CRYPTO-ARGS ${d.method} ${d.args}`;
        case 'jscrypto':     return `[Reversed-Event] JSCRYPTO-ARGS ${d.label} ${d.payload}`;
        case 'hook_init':    return `[Reversed-Event] JSCRYPTO-ARGS init ${d.lib}`;
        case 'wasm':         return `[Reversed-Event] WASM WebAssembly.${d.method} of ${d.bytes} bytes hash=${d.hash}`;
        default:             return null;
    }
}

// ---- WASM dump (moved from capture_server.js) ----------------------------

function dumpWasmFromHex(hash, hex, extractDirGetter) {
    try {
        const buf = Buffer.from(hex, 'hex');
        const targetDir = extractDirGetter() ? path.join(extractDirGetter(), 'wasm') : path.join(process.cwd(), 'wasm_modules');
        fs.mkdirSync(targetDir, { recursive: true });
        const wasmPath = path.join(targetDir, `module_${hash}.wasm`);
        fs.writeFileSync(wasmPath, buf);
        trackWasmDump();
        console.log(`${C.magenta}[🧬 WASM DUMPED]${C.reset} Saved WebAssembly module (${buf.length} bytes) to ${wasmPath}`);
    } catch (e) {
        console.error('Failed to save WASM module:', e.message);
    }
}

// ---- entry points --------------------------------------------------------

// Handle one structured binding event. Returns true if it was consumed.
function handleStructuredEvent(rawJson, targetLabel, extractDirGetter) {
    let evt;
    try { evt = JSON.parse(rawJson); } catch (e) { return false; }
    if (!evt || typeof evt !== 'object' || !evt.type) return false;
    if (isDuplicate(evt.uid)) return true;

    if (evt.type === 'wasm_hex') {
        const hex = reassembleChunks(evt);
        if (hex !== null) dumpWasmFromHex(evt.hash || 'unknown', hex, extractDirGetter);
        return true;
    }

    const urlForStats = evt.data && (evt.data.url || evt.data.endpoint) || null;
    trackEvent(evt.type, urlForStats);
    if (evt.type === 'jscrypto' || evt.type === 'crypto_args') { /* counted by type */ }
    logStructured(evt, targetLabel);

    // Secrets can ride inside blob contents and crypto payloads.
    if (evt.type === 'blob_content' && evt.data && evt.data.snippet) {
        try {
            const { scanForSecrets, reportSecrets } = require('../util/secrets');
            const findings = scanForSecrets(evt.data.snippet, evt.data.url || 'blob');
            if (findings.length) { reportSecrets(findings, evt.data.url || 'blob'); trackSecret(); }
        } catch (e) {}
    }
    return true;
}

// Legacy console-text channel (unchanged behavior from the original
// formatHookConsole + WASM console dump, used when no binding is available).
function formatHookConsole(text) {
    const stripped = text.replace('[Reversed-Event] ', '');
    if (text.includes('PAYMENT-JSON')) return `${C.hlgrn}[💳 PAYMENT-JSON]${C.reset} ${C.green}${stripped.replace('PAYMENT-JSON: ', '')}${C.reset}`;
    if (text.includes('[Reversed-Event] CRYPTO-ARGS')) return `${C.hlred}[🔓 CRYPTO ARGS]${C.reset} ${C.green}${stripped.replace('CRYPTO-ARGS ', '')}${C.reset}`;
    if (text.includes('[Reversed-Event] JSCRYPTO-ARGS')) return `${C.hlred}[🔐 JSCRYPTO]${C.reset} ${C.green}${stripped.replace('JSCRYPTO-ARGS ', '')}${C.reset}`;
    if (text.includes('[Reversed-Event] VIDEO')) return `${C.magenta}[🎬 VIDEO]${C.reset} ${C.green}${stripped.replace('VIDEO ', '')}${C.reset}`;
    if (text.includes('[Reversed-Event] WASM')) return `${C.magenta}[🧬 WASM INJECT]${C.reset} ${C.dim}${stripped}${C.reset}`;
    if (text.includes('[Reversed-Event] BLOB CONTENT')) return `${C.hlgrn}[📄 BLOB CONTENT]${C.reset} ${C.green}${stripped.replace('BLOB CONTENT ', '')}${C.reset}`;
    if (text.includes('[Reversed-Event] BLOB URL')) return `${C.cyan}[🗂️  BLOB URL]${C.reset} ${C.dim}${stripped.replace('BLOB URL ', '')}${C.reset}`;
    if (text.includes('[Reversed-Event] WORKER') || text.includes('[Reversed-Event] PORT')) return `${C.magenta}[📨 MSG]${C.reset} ${C.green}${stripped}${C.reset}`;
    if (text.startsWith('[Reversed-Event] STORAGE ')) return `${C.yellow}[💾 STORAGE STATE]${C.reset} ${C.dim}${stripped}${C.reset}`;
    if (text.includes(' body: ') && !text.includes(' body: [binary')) return `${C.cyan}[🌐 NET]${C.reset} ${stripped}`;
    return `${C.blue}[⚓ EVENT]${C.reset} ${C.dim}${stripped}${C.reset}`;
}

// Handle a legacy console line; returns the WASM hex if this line carries one
// (so the caller can dump it), else null.
function handleLegacyConsoleText(text, targetLabel) {
    if (text.includes('WASM-HEX ')) {
        const match = text.match(/WASM-HEX (\w+) ([0-9a-fA-F]+)/);
        return match ? { hash: match[1], hex: match[2] } : null;
    }
    const m = text.match(/^\[Reversed-Event\] (fetch|XHR|VIDEO|sendBeacon|WebSocket|WORKER|PORT|BLOB|STORAGE|CRYPTO-ARGS|JSCRYPTO-ARGS)/);
    if (m) {
        const typeGuess = { fetch: 'fetch', XHR: 'xhr', VIDEO: 'fetch', sendBeacon: 'beacon', WebSocket: 'ws', WORKER: 'worker_msg', PORT: 'worker_msg', BLOB: 'blob', STORAGE: 'storage', 'CRYPTO-ARGS': 'crypto_args', 'JSCRYPTO-ARGS': 'jscrypto' }[m[1]];
        const urlMatch = text.match(/https?:\/\/\S+?(\s|$)/);
        trackEvent(typeGuess === 'ws' ? (text.includes('[SEND]') ? 'ws_send' : 'ws_recv') : typeGuess === 'blob' ? (text.includes('BLOB CONTENT') ? 'blob_content' : 'blob_url') : typeGuess, urlMatch ? urlMatch[0].trim() : null);
    }
    console.log(formatHookConsole(text));
    writeLog({ type: 'hook_event', channel: 'console', message: text });
    return null;
}

module.exports = { handleStructuredEvent, handleLegacyConsoleText, formatHookConsole, structuredToLegacy, isDuplicate, reassembleChunks, dumpWasmFromHex };
