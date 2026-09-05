# Contributing to webcrypto-interceptor

Thanks for your interest in improving the tool. This document covers the setup, the codebase layout, and the conventions that keep the project healthy. Contributions of every size are welcome — a one-line decoder fix is as valuable as a new capture domain.

## Ground rules

This is a **defensive security / reverse-engineering toolkit** built on Chrome DevTools Protocol breakpoints. By contributing you agree that:

- You will not add features whose primary purpose is attacking systems you don't own.
- You will never commit captured data (keys, tokens, cookies, session dumps) from real targets. Sanitize everything.
- Changes are reviewed with this use policy in mind. PRs that fail it will be closed.

## Development setup

```bash
git clone https://github.com/AmitHaina/webcrypto-interceptor.git
cd webcrypto-interceptor
npm install          # pulls puppeteer (~150 MB Chrome download on first install)
npm test             # node:test suite — no network, no Chrome needed
npm run lint         # eslint
```

Node **18 or newer** is required (puppeteer 24 baseline). The test suite deliberately exercises pure modules only, so it runs anywhere in seconds.

## Project layout

```
capture_server.js        # CLI entry — puppeteer launch, session wiring, shutdown
src/cli.js               # argument parsing (--gui --full --out --timeout --ua --proxy ...)
src/config.js            # constants: timeouts, tag labels, CT filters, limits
src/events.js            # Runtime.addBinding structured transport + reassembly
src/cdp/session.js       # per-target CDP session wiring
src/cdp/crypto.js        # Debugger breakpoints over crypto.subtle prototypes
src/cdp/network.js       # Network domain taps + key/manifest detection
src/cdp/anti-debug.js    # blackboxing + debugger-trap neutralization
src/cdp/scripts.js       # scriptParsed scanning, blob source dumps
src/cdp/extract.js       # --full site extraction (safe path handling)
src/page/stealth.js      # in-page hooks (scope-agnostic, binding emitter)
src/util/decoders.js     # base64/hex/DER decoding helpers
src/util/secrets.js      # PEM/JWT/hex-secret scanner
src/util/summary.js      # markdown session summary
src/util/log.js          # JSONL session logger (flush-safe)
scripts/extract-keys.js  # offline AES-key extraction from .jsonl sessions
tests/                   # node:test suites (run via tests/run.js)
```

## Conventions

**Code style**

- CommonJS (`require`) — matches the existing codebase.
- No new runtime dependencies unless the capability genuinely can't be built on CDP core. Dev deps are fine.
- Every source file must pass `node --check` (CI enforces this).

**Commits**

Conventional Commits, as used throughout the history:

```
fix(capture): key/manifest CT exemption, breakpoint leak, file collisions
feat(transport): structured binding events + real worker hooks
test: node:test suite - 45 tests, no dependencies, no browser
docs: README rewrite for v0.2.0
```

**Tests**

New behavior needs coverage in `tests/`. If you fix a bug, the test should fail before your fix and pass after — that's how we know the bug stays dead. Bug-fix PRs without a regression test will still be reviewed, but tests make merging much faster.

**Output stability**

Log tags (`[🔐 CRYPTO]`, `[🎬 VIDEO]`, `[🔑 SECRET]`, ...) and JSONL event shapes are the tool's public interface — downstream parsers depend on them. If you change an event shape, update the tag table in the README and note it as potentially breaking in your PR.

## Submitting

1. Fork / branch from `main`.
2. Make your change with tests.
3. `npm test && npm run lint` locally.
4. Open a PR against `main` using the template. Link any related issues.
5. CI must be green (3 OS × Node 18/20/22) before merge.

## Reporting bugs

Use the bug report template. Include the exact command, your Node version, and sanitized output — real key material in an issue will be edited out by a maintainer.
