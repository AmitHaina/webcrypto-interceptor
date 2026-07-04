# WebCrypto Interceptor

A stealthy, Chrome DevTools Protocol (CDP) based instrumentation toolkit designed to capture plaintext payloads from the Web Crypto API (crypto.subtle) before they are encrypted. 

Unlike traditional hooks that wrap or replace native JS functions (which modern anti-bot and security scripts can easily detect), this tool utilizes runtime-level V8 debugger breakpoints. This ensures complete invisibility to the target page's code.

---

## Features

- **Invisible Interception**: Hooks into `crypto.subtle` methods via real V8 debugger pause states, keeping native objects completely untouched.
- **Out-of-Process Iframe (OOPIF) Support**: Automatically creates dedicated CDP sessions for target iframes (like payment processors, gateway forms, or challenge workers) to hook their isolated crypto contexts dynamically.
- **Full Call-Stack Inspection**: Resolves and traces the execution stack up to 5 levels deep upon crypto hits, pointing you straight to the obfuscated caller scripts.
- **Payload Decoding**: Decodes ArrayBuffers, TypedArrays, complex objects, and stringified JSON payloads directly from paused V8 local variables.
- **Dynamic Response Capture**: Hooks network channels to inspect and dump corresponding server responses.
- **Automated Session Logging**: Keeps track of your investigations by writing clean event streams straight into a local JSONL file for offline replay and diffing.

---

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- Google Chrome installed locally

### Installation

1. Clone or download this project.
2. Initialize dependencies:
   ```bash
   npm install
   ```

---

## Usage

Start the capture server by running the orchestrator alongside your target URL:

```bash
# General headless capture
node capture_server.js "https://example.com"

# GUI mode (recommended for interacting with forms/payments)
node capture_server.js "https://example.com" --gui
```

Upon launching, the tool will automatically output interactive console signals whenever `crypto.subtle` operations are triggered. All results are live-streamed and written locally to `session_capture_<timestamp>.jsonl`.

---

## Contributing

Contributors are welcome! If you want to raise an issue, suggest improvements, or submit a pull request:
---

## Community

Join the discussion, ask questions, or share your reverse-engineering research on Discord:

[![Discord](https://img.shields.io/discord/1110000000000000000?color=5865F2&logo=discord&logoColor=white)](https://discord.gg/QphWRKHvH2)

Join our channel: [Discord Server](https://discord.gg/QphWRKHvH2)
