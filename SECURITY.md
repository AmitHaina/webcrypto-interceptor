# Security Policy

## Scope

This repository contains a Chrome DevTools Protocol capture tool. Two classes of security reports are relevant:

1. **Vulnerabilities in this tool itself** — e.g. a path traversal in `--full` extraction, unsafe handling of captured data, code execution via a crafted session file.
2. **Reports about third-party sites** — e.g. "this tool can steal keys from website X". These are **not** security issues in this project and will be closed. The tool is a local research instrument; what you point it at is your responsibility and governed by the law and the site's terms.

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | ✅        |
| < 0.2.0 | ❌        |

## How to report

**Preferred:** open a private GitHub Security Advisory at
https://github.com/AmitHaina/webcrypto-interceptor/security/advisories/new

This keeps the report confidential, lets us coordinate a fix, and credits you automatically on disclosure.

Please include:

- Affected version / commit SHA
- Exact steps to reproduce (commands + environment)
- Sanitized proof — **redact real key material, tokens, and cookies**
- Your assessment of impact

## What to expect

- Acknowledgement within **72 hours**.
- Fix or mitigation timeline agreed with you based on severity.
- Public disclosure after the patched release ships, with credit to you (unless you prefer otherwise).

## Responsible-use reminder

Capturing cryptographic material from systems you do not own or lack written permission to test is illegal in most jurisdictions (CFAA, Computer Misuse Act, and equivalents). This project's tooling is provided for authorized research, CTF work, DRM-interoperability research within your legal jurisdiction, and debugging your own applications.
