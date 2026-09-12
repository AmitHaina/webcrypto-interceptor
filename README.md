# WebCrypto Interceptor

[![CI](https://github.com/AmitHaina/webcrypto-interceptor/actions/workflows/ci.yml/badge.svg)](https://github.com/AmitHaina/webcrypto-interceptor/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/AmitHaina/webcrypto-interceptor)](https://github.com/AmitHaina/webcrypto-interceptor/releases)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen?logo=nodedotjs&logoColor=white)](https://github.com/AmitHaina/webcrypto-interceptor#install)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?logo=discord&logoColor=white)](https://discord.gg/QphWRKHvH2)

A stealth CDP-based reverse-engineering toolkit that watches what a website does under the hood — every `crypto.subtle` call, every network request/response, every worker message, every blob URL. Works on any site.

Unlike script-based hooks (which anti-bot scripts detect easily), this uses real V8 debugger breakpoints. The target page cannot see anything is patched.

---

## What it captures

- **Crypto boundary** — every `crypto.subtle.encrypt/decrypt/sign/digest/...` call, with plaintext inputs, key material, and 5-level call stack.
- **Network traffic** — outbound `fetch`, `XHR`, `WebSocket` (send **and** receive), `sendBeacon` bodies; inbound response bodies (auto base64-decoded, AES-key-shaped binaries flagged).
- **Video / streaming** — auto-tags m3u8, mpd, HLS, DASH URLs with `[🎬 VIDEO]`.
- **Content keys** — auto-extracts hex/base64 AES keys from JSON fields (`ck`, `key`, `contentKey`, `aesKey`) and HLS `#EXT-X-KEY` lines. Keys served as `application/octet-stream` are caught too (a common HLS/DRM delivery path).
- **Worker communication** — `Worker.postMessage` and `MessagePort.postMessage`, plus hook injection **inside worker scopes** (dedicated/shared/service workers run their own crypto — you see it now).
- **Blob URLs** — dumps the actual JS source of workers/eval bundles created via `URL.createObjectURL`.
- **Storage writes** — flags `localStorage`/`sessionStorage` sets containing tokens, keys, or auth material.
- **Randomness** — `crypto.getRandomValues` sampled with rate-limiting so nonce generation is visible without flooding.
- **WebAssembly** — logs every WASM module loaded and dumps modules < 5 MB to disk.
- **Secrets scanner** — PEM/DER keys, hardcoded `apiKey`/`secretKey` assignments, AES-shaped hex constants, JWTs — scanned in every script source (via `Debugger.scriptParsed`, including inline/eval/webpack chunks) and every interesting response body.
- **Anti-anti-debug** — blackboxes scripts and neutralizes `debugger;` traps so the page loads normally.

Everything above is written to a `session_capture_<timestamp>.jsonl` file for offline analysis, and a markdown **session summary** is printed and saved when you stop with `Ctrl+C`.

---

## Install

```bash
git clone https://github.com/AmitHaina/webcrypto-interceptor.git
cd webcrypto-interceptor
npm install
```

Requires **Node.js 18+** and Chrome or Brave installed locally. If your browser is somewhere unusual, point at it:

```bash
PUPPETEER_EXECUTABLE_PATH="/path/to/browser" node capture_server.js "https://example.com"
```

---

## Use

```bash
# Headless
node capture_server.js "https://example.com"

# With visible browser (recommended — you can click around)
node capture_server.js "https://example.com" --gui

# Use Brave browser
node capture_server.js "https://example.com" --brave --gui

# Full site extraction (see below)
node capture_server.js "https://example.com" --full --gui
```

Interact with the page. Watch the terminal for tagged events. Stop with `Ctrl+C` — the JSONL log is flushed and a session summary printed.

### All options

| Option | Meaning |
|---|---|
| `--gui` | Show the browser window |
| `--brave` | Use Brave browser instead of Chrome / Chromium |
| `--full` | Extract every script/response body to disk |
| `--out <dir>` | Base directory for the extract folder and session log |
| `--timeout <sec>` | Page navigation timeout (default 60) |
| `--ua <user-agent>` | Override the User-Agent on every attached target |
| `--proxy <server>` | Route Chrome through a proxy, e.g. `http://127.0.0.1:8080` |
| `--all-traffic` | Disable the analytics/tracker noise filter |
| `--hook <expr>` | Invisible breakpoint hook on a site function — logs every call with args + stack (repeatable). The function is never wrapped, so `fn.toString()` checks see nothing |
| `--hook-return <expr>` | Like `--hook`, plus breakpoints on the function's return locations: records (input → output) pairs for `scripts/verify-reimpl.js` |
| `--heap-diff <sec>` | Snapshot the heap after load, wait, snapshot again: report newly allocated user-retained strings (secret-classified), typed arrays, object counts |
| `--help` | Show help |

### Extract AES keys from a captured session

```bash
node scripts/extract-keys.js session_capture_1700000000000.jsonl
```

Correlates `importKey` + `decrypt` calls with the video segment URLs around them and prints a ready-to-run `openssl` command per key/IV pair.

### Verify a reimplementation (the oracle loop)

Reading obfuscated JS gives you a hypothesis, not a fact. Capture ground truth first, then check your rewrite of the function against it:

```bash
# 1. Capture (input -> output) pairs from the real function, invisibly:
node capture_server.js "https://example.com" --hook-return "window.buildPayload"

# 2. Write your own version in ./my_payload.js:
#    module.exports = function buildPayload(user, ts) { ... }

# 3. Verify it against the captured corpus — your code runs in an isolated
#    about:blank page: no network, no access to the target or its closures.
node scripts/verify-reimpl.js \
     --session session_capture_1700000000000.jsonl \
     --label "window.buildPayload" \
     --candidate ./my_payload.js
```

The verdict is a structured diff with concrete counterexamples — `matched: 41/42`, plus the exact inputs where your output diverges. Iterate until the diff is empty; exit code `0` means verified (scriptable). Extra `--input '["a", 1]'` arguments run as smoke tests without affecting the verdict.

---

## `--full` — extract a site's frontend code

Dumps the page's actual HTML/CSS/JS to disk instead of just logging events. Three layers, saved to `extracted_<host>_<timestamp>/`:

- **Raw responses** — every network response body (HTML, CSS, JS, JSON/API), saved mirroring each URL's own path. URLs that collide on the same path (e.g. `?v=1` vs `?v=2`) get a short hash suffix instead of overwriting each other.
- **Script sources** — every script V8 parses: external files, inline `<script>` blocks, `eval()`/`new Function` strings, webpack chunks — saved under `_inline/` when there's no real URL to mirror.
- **`_rendered.html`** — a snapshot of `document.documentElement` after the page finishes loading (saved even when navigation times out but the page is usable). This is what actually matches what you see on screen for JS-heavy/SPA sites, where the raw `index.html` is just an empty shell before React/Vue/Nuxt hydrates it.

```bash
node capture_server.js "https://example.com" --full
```

Non-fetched/synthetic URLs (puppeteer internals, `blob:`, `data:`, `webpack://`) are skipped or routed to `_inline/` — they aren't real site files and can't corrupt the output folder.

Not extracted: backend/server-side logic (it never reaches the browser), and asset links in the saved HTML/CSS aren't rewritten to local paths (so `_rendered.html` won't open standalone offline — the pieces are all there, just not relinked).

---

## Tags you'll see

| Tag | Meaning |
|---|---|
| `[🔓 CRYPTO BOUNDARY]` | A `crypto.subtle.*` call fired — native breakpoint hit, real call site shown |
| `[🔓 CRYPTO ARGS]` | Page-side capture of `crypto.subtle` arguments (inputs, keys, IVs) |
| `[🔐 JSCRYPTO]` | Pure-JS crypto calls: CryptoJS, JSEncrypt, sjcl |
| `[🎲 RANDOM]` | `crypto.getRandomValues` output (rate-limited) |
| `[🌐 NET]` | Outbound fetch/XHR with body |
| `[📥 NET RESP]` | Response body (base64-decoded if needed) |
| `[🎬 VIDEO]` | Streaming URL (m3u8/hls/mp4) |
| `[🔑 CONTENT KEY]` | AES key auto-extracted from response |
| `[🔑 RAW AES KEY]` | 128/192/256-bit binary key body (octet-stream `.key` included) |
| `[🔐 HLS AES KEY URI]` | HLS AES-128 key URL from `#EXT-X-KEY` |
| `[🔑 SECRET]` | Scanner finding: PEM/DER key, hardcoded secret, or JWT |
| `[📨 MSG]` | Worker or MessagePort postMessage |
| `[🗂️ BLOB URL]` | New blob URL created |
| `[📄 BLOB CONTENT]` | Blob source code (JS/JSON/WASM under 200KB) |
| `[💾 STORAGE STATE]` | Interesting localStorage/sessionStorage write |
| `[🧬 WASM INJECT]` | WebAssembly module loaded |
| `[🧬 WASM DUMPED]` | WASM module saved to disk |
| `[🕷️ CRYPTO HOOK]` | Native breakpoints armed on a target |
| `[🪝 HOOK]` | A `--hook`-ed site function fired — args + call stack recorded |
| `[🪝 HOOK PAIR]` | A `--hook-return`-ed function returned — (input, output) pair recorded |
| `[🧠 HEAP DIFF]` | Heap snapshot diff: what the last N seconds of activity allocated |

---

## Architecture notes

- **Two event channels.** Page hooks prefer a structured `Runtime.addBinding` transport (JSON envelopes, no truncation, immune to site console spam) and fall back to tagged `console.log` lines when no binding exists. Both are deduped and both land in the JSONL log.
- **Worker support.** Workers never see `evaluateOnNewDocument` and don't relay console output — so the toolkit attaches to worker targets directly, evaluates the (globalThis-based) hook source there, and relies on the binding channel for transport.
- **Leak-free breakpoints.** Native `SubtleCrypto.prototype` breakpoints are armed per execution context and removed when the context dies — long SPA sessions no longer accumulate thousands of dead breakpoints.

## Extend

Site not matching enough endpoints? Edit [`src/config.js`](src/config.js):

```js
RESP_KEYWORDS.push('mycustomendpoint', '/api/decrypt');
```

---

## Development

```bash
npm test        # node:test suite — decoders, secrets scanner, extract-keys, path safety, CLI, event transport
npm run lint    # eslint
```

No test database, no network, no Chrome needed — the suite exercises pure modules only.

---

## License

[MIT](LICENSE) — with a responsible-use notice: this tool is for authorized security research and reverse-engineering of software you own or have permission to test.

## Community

- 💬 **Discord** — questions, target-debugging help, research sharing: [discord.gg/QphWRKHvH2](https://discord.gg/QphWRKHvH2)
- 🐞 **Bugs** — open a [bug report](https://github.com/AmitHaina/webcrypto-interceptor/issues/new?template=bug_report.yml)
- 💡 **Ideas** — [feature requests](https://github.com/AmitHaina/webcrypto-interceptor/issues/new?template=feature_request.yml) welcome
- 🔒 **Vulnerabilities** — report privately via [Security Advisories](https://github.com/AmitHaina/webcrypto-interceptor/security/advisories/new), never as a public issue
- 🤝 **Contributing** — read [CONTRIBUTING.md](CONTRIBUTING.md); everyone is held to the [Code of Conduct](CODE_OF_CONDUCT.md)
