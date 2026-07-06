# WebCrypto Interceptor

A stealth CDP-based reverse-engineering toolkit that watches what a website does under the hood — every `crypto.subtle` call, every network request/response, every worker message, every blob URL. Works on any site.

Unlike script-based hooks (which anti-bot scripts detect easily), this uses real V8 debugger breakpoints. The target page cannot see anything is patched.

---

## What it captures

- **Crypto boundary** — every `crypto.subtle.encrypt/decrypt/sign/digest/...` call, with plaintext inputs, key material, and 5-level call stack.
- **Network traffic** — outbound `fetch`, `XHR`, `WebSocket`, `sendBeacon` bodies; inbound response bodies (auto base64-decoded).
- **Video / streaming** — auto-tags m3u8, mpd, HLS, DASH URLs with `[🎬 VIDEO]`.
- **Content keys** — auto-extracts hex/base64 AES keys from JSON fields (`ck`, `key`, `contentKey`) and HLS `#EXT-X-KEY` lines.
- **Worker communication** — `Worker.postMessage` and `MessagePort.postMessage`.
- **Blob URLs** — dumps the actual JS source of workers/eval bundles created via `URL.createObjectURL`.
- **Storage writes** — flags `localStorage`/`sessionStorage` sets containing tokens, keys, or auth material.
- **WebAssembly** — logs every WASM module loaded.
- **Anti-anti-debug** — blackboxes scripts and neutralizes `debugger;` traps so the page loads normally.

Everything above is written to `session_capture_<timestamp>.jsonl` for offline analysis.

---

## Install

```bash
git clone https://github.com/AmitHaina/webcrypto-interceptor.git
cd webcrypto-interceptor
npm install
```

Requires Node.js 16+ and Chrome installed locally.

---

## Use

```bash
# Headless
node capture_server.js "https://example.com"

# With visible browser (recommended — you can click around)
node capture_server.js "https://example.com" --gui
```

Interact with the page. Watch the terminal for tagged events. Stop with `Ctrl+C`.

---

## Tags you'll see

| Tag | Meaning |
|---|---|
| `[🔓 CRYPTO BOUNDARY]` | A `crypto.subtle.*` call fired — inputs and stack shown |
| `[🌐 NET]` | Outbound fetch/XHR with body |
| `[📥 NET RESP]` | Response body (base64-decoded if needed) |
| `[🎬 VIDEO]` | Streaming URL (m3u8/hls/mp4) |
| `[🔑 CONTENT KEY]` | AES key auto-extracted from response |
| `[🔐 HLS AES KEY URI]` | HLS AES-128 key URL from `#EXT-X-KEY` |
| `[📨 MSG]` | Worker or MessagePort postMessage |
| `[🗂️ BLOB URL]` | New blob URL created |
| `[📄 BLOB CONTENT]` | Blob source code (JS/JSON/WASM under 200KB) |
| `[💾 STORAGE STATE]` | Interesting localStorage/sessionStorage write |
| `[🧬 WASM INJECT]` | WebAssembly module loaded |

---

## Extend

Site not matching enough endpoints? Edit [`src/config.js`](src/config.js):

```js
RESP_KEYWORDS.push('mycustomendpoint', '/api/decrypt');
```

---

## Structure

```
capture_server.js       ← entry point
src/
  config.js             ← keywords & method lists
  cdp/                  ← Chrome DevTools Protocol logic
  page/stealth.js       ← page-side hooks
  util/                 ← colors, logging, decoders
```

---

## Community

Join the Discord for questions and research sharing:

[![Discord](https://img.shields.io/discord/1110000000000000000?color=5865F2&logo=discord&logoColor=white)](https://discord.gg/QphWRKHvH2)

[https://discord.gg/QphWRKHvH2](https://discord.gg/QphWRKHvH2)

