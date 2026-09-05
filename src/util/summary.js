// Session summary: counts every captured event by type, tracks top URLs and
// secret findings, and renders a markdown report printed at shutdown and
// saved next to the session log.
const { C } = require('./colors');

const state = {
    startedAt: Date.now(),
    counts: Object.create(null),   // type -> count
    urls: new Map(),               // url -> hits (capped)
    secrets: 0,
    wasmDumped: 0,
    heapDiffs: 0,
    heapSecrets: 0
};

const MAX_URLS = 500;

function trackEvent(type, url) {
    state.counts[type] = (state.counts[type] || 0) + 1;
    if (url && typeof url === 'string' && url.length < 300) {
        if (state.urls.has(url)) {
            state.urls.set(url, state.urls.get(url) + 1);
        } else if (state.urls.size < MAX_URLS) {
            state.urls.set(url, 1);
        }
    }
}

function trackSecret(fromHeap) {
    state.secrets++;
    if (fromHeap) state.heapSecrets++;
}
function trackWasmDump() { state.wasmDumped++; }
function trackHeapDiff() { state.heapDiffs++; }

function topUrls(n) {
    return [...state.urls.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n);
}

function renderSummary(targetUrl, sessionLogFile) {
    const total = Object.values(state.counts).reduce((a, b) => a + b, 0);
    const mins = ((Date.now() - state.startedAt) / 60000).toFixed(1);
    const lines = [];
    lines.push(`# webcrypto-interceptor — session summary`);
    lines.push('');
    lines.push(`- **Target:** ${targetUrl}`);
    lines.push(`- **Duration:** ${mins} min`);
    lines.push(`- **Captured events:** ${total}`);
    lines.push(`- **Secret findings:** ${state.secrets}${state.heapSecrets ? ` (${state.heapSecrets} from heap diff)` : ''}`);
    lines.push(`- **WASM modules dumped:** ${state.wasmDumped}`);
    if (state.heapDiffs) lines.push(`- **Heap diffs run:** ${state.heapDiffs}`);
    lines.push(`- **Log:** ${sessionLogFile}`);
    lines.push('');
    lines.push(`## Events by type`);
    lines.push('');
    lines.push('| Type | Count |');
    lines.push('|---|---|');
    for (const [type, count] of Object.entries(state.counts).sort((a, b) => b[1] - a[1])) {
        lines.push(`| ${type} | ${count} |`);
    }
    const top = topUrls(15);
    if (top.length) {
        lines.push('');
        lines.push(`## Top URLs`);
        lines.push('');
        lines.push('| Hits | URL |');
        lines.push('|---|---|');
        for (const [url, hits] of top) {
            lines.push(`| ${hits} | ${url.replace(/\|/g, '\\|')} |`);
        }
    }
    lines.push('');
    return lines.join('\n');
}

function printSummary(targetUrl, logFile) {
    const sessionLogFile = logFile || '(session log)';
    console.log(`\n${C.bold}==================== SESSION SUMMARY ====================${C.reset}`);
    const total = Object.values(state.counts).reduce((a, b) => a + b, 0);
    const mins = ((Date.now() - state.startedAt) / 60000).toFixed(1);
    console.log(`Target: ${targetUrl}  |  ${mins} min  |  ${total} events  |  ${state.secrets} secrets  |  ${state.wasmDumped} wasm${state.heapDiffs ? `  |  ${state.heapDiffs} heap diff(s)` : ''}`);
    const top = topUrls(5);
    if (top.length) {
        console.log(`${C.dim}Top URLs:${C.reset}`);
        for (const [url, hits] of top) {
            console.log(`  ${C.dim}${String(hits).padStart(4)}  ${url.substring(0, 90)}${C.reset}`);
        }
    }
    console.log(`${C.dim}Full report: ${sessionLogFile.replace(/\.jsonl$/, '_summary.md')}${C.reset}`);
    console.log(`${C.bold}==========================================================${C.reset}\n`);
}

function resetSummary() {
    state.startedAt = Date.now();
    state.counts = Object.create(null);
    state.urls = new Map();
    state.secrets = 0;
    state.wasmDumped = 0;
    state.heapDiffs = 0;
    state.heapSecrets = 0;
}

module.exports = { trackEvent, trackSecret, trackWasmDump, trackHeapDiff, renderSummary, printSummary, resetSummary };
