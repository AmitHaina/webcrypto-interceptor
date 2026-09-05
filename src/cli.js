// CLI parsing for capture_server.js — extracted so it can be unit-tested
// without launching puppeteer.
const { parseArgs } = require('node:util');

const HELP = `
webcrypto-interceptor — stealth CDP-based reverse-engineering toolkit

Usage:
  node capture_server.js <URL> [options]

Options:
  --gui                  Show the browser window (recommended: you can click around)
  --full                 Extract every script/response body to disk (site dump)
  --out <dir>            Base directory for the extract folder and session log (default: cwd)
  --timeout <seconds>    Page navigation timeout (default: 60)
  --ua <user-agent>      Override the browser User-Agent on every attached target
  --proxy <server>       Launch Chrome through a proxy, e.g. --proxy "http://127.0.0.1:8080"
  --all-traffic          Disable the analytics/tracker noise filter (capture everything)
  --help                 Show this help

Environment:
  PUPPETEER_EXECUTABLE_PATH   Path to a Chrome/Chromium binary (overrides auto-detection)

Examples:
  node capture_server.js "https://example.com" --gui
  node capture_server.js "https://example.com" --full --out ./dumps --timeout 90
  npx webcrypto-interceptor "https://example.com" --gui
`.trim();

function usageError(message) {
    const err = new Error(message + '\n\n' + HELP);
    err.isUsageError = true;
    return err;
}

function parseArgv(argv) {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            options: {
                gui: { type: 'boolean', default: false },
                full: { type: 'boolean', default: false },
                out: { type: 'string' },
                timeout: { type: 'string', default: '60' },
                ua: { type: 'string' },
                proxy: { type: 'string' },
                'all-traffic': { type: 'boolean', default: false },
                help: { type: 'boolean', default: false }
            },
            allowPositionals: true
        });
    } catch (e) {
        throw usageError(e.message);
    }

    if (parsed.values.help) {
        return { help: true };
    }

    const positional = parsed.positionals.filter(a => a && !a.startsWith('-'));
    const url = positional[0];
    if (!url) throw usageError('Missing <URL> argument.');
    if (!/^https?:\/\//i.test(url)) {
        throw usageError(`URL must start with http:// or https:// (got "${url}").`);
    }

    let timeout = parseInt(parsed.values.timeout, 10);
    if (!Number.isFinite(timeout) || timeout <= 0) {
        throw usageError(`--timeout must be a positive number of seconds (got "${parsed.values.timeout}").`);
    }

    return {
        help: false,
        url,
        gui: parsed.values.gui,
        full: parsed.values.full,
        out: parsed.values.out || process.cwd(),
        timeout: timeout * 1000,
        ua: parsed.values.ua || null,
        proxy: parsed.values.proxy || null,
        allTraffic: parsed.values['all-traffic']
    };
}

module.exports = { parseArgv, HELP };
