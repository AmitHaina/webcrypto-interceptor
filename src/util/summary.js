// Session summary: counts every captured event by type, tracks top URLs and
// secret findings, and renders a markdown report printed at shutdown and
// saved next to the session log.
const fs = require('fs');
const path = require('path');
const { C } = require('./colors');

const state = {
    startedAt: Date.now(),
    counts: Object.create(null),   // type -> count
    urls: new Map(),               // url -> hits (capped)
    secrets: 0,
    wasmDumped: 0,
    heapDiffs: 0,
    heapSecrets: 0,
    sourcesRecovered: 0,
    // Structured capture items:
    contentKeys: [],
    rawAesKeys: [],
    hlsKeys: [],
    secretFindings: [],
    manifests: [],
    wasmModules: [],
    extractedFiles: { total: 0, byExtension: Object.create(null) }
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

function trackContentKey(finding) {
    if (!finding || !finding.decoded) return;
    if (state.contentKeys.some(k => k.decoded === finding.decoded && k.field === finding.field)) return;
    state.contentKeys.push({
        field: finding.field || 'key',
        raw: finding.raw || '',
        decoded: finding.decoded,
        url: finding.url || ''
    });
}

function trackRawAesKey(finding) {
    if (!finding || !finding.hex) return;
    if (state.rawAesKeys.some(k => k.hex === finding.hex)) return;
    state.rawAesKeys.push({
        bits: finding.bits || finding.hex.length * 4,
        hex: finding.hex,
        url: finding.url || ''
    });
}

function trackHlsKey(finding) {
    if (!finding || !finding.keyUri) return;
    if (state.hlsKeys.some(k => k.keyUri === finding.keyUri && k.iv === (finding.iv || null))) return;
    state.hlsKeys.push({
        keyUri: finding.keyUri,
        iv: finding.iv || null,
        url: finding.url || ''
    });
}

function trackSecretFinding(finding) {
    if (!finding || !finding.value) return;
    state.secrets++;
    const sig = `${finding.type}|${finding.value}`;
    if (state.secretFindings.some(s => `${s.type}|${s.value}` === sig)) return;
    state.secretFindings.push({
        type: finding.type || 'SECRET',
        value: finding.value,
        url: finding.url || ''
    });
}

function trackManifest(finding) {
    if (!finding || !finding.url) return;
    if (state.manifests.some(m => m.url === finding.url)) return;
    state.manifests.push({
        type: finding.type || 'manifest',
        url: finding.url
    });
}

function trackWasmDump(moduleInfo) {
    state.wasmDumped++;
    if (moduleInfo && moduleInfo.file) {
        if (!state.wasmModules.some(w => w.file === moduleInfo.file)) {
            state.wasmModules.push(moduleInfo);
        }
    }
}

function trackExtractedFile(filePath) {
    if (!filePath || typeof filePath !== 'string') return;
    state.extractedFiles.total++;
    const ext = path.extname(filePath).toLowerCase() || '(no-ext)';
    state.extractedFiles.byExtension[ext] = (state.extractedFiles.byExtension[ext] || 0) + 1;
}

function trackHeapDiff() { state.heapDiffs++; }
function trackSourcesRecovered(n) { state.sourcesRecovered += (n || 0); }

function topUrls(n) {
    return [...state.urls.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n);
}

function writeExtractedSummary(extractDir, targetUrl) {
    if (!extractDir) return null;
    const summaryFile = path.join(extractDir, 'extracted_summary.json');
    const durationSeconds = Math.round((Date.now() - state.startedAt) / 1000);

    const summaryData = {
        target: targetUrl || '',
        extractedAt: new Date().toISOString(),
        durationSeconds,
        crypto: {
            contentKeys: state.contentKeys,
            rawAesKeys: state.rawAesKeys,
            hlsKeys: state.hlsKeys,
            subtleOperations: Object.fromEntries(
                Object.entries(state.counts).filter(([k]) => k.startsWith('crypto_') || k === 'jscrypto' || k === 'random')
            )
        },
        secrets: state.secretFindings,
        manifests: state.manifests,
        wasmModules: state.wasmModules,
        files: {
            total: state.extractedFiles.total,
            byExtension: state.extractedFiles.byExtension
        }
    };

    try {
        fs.writeFileSync(summaryFile, JSON.stringify(summaryData, null, 2), 'utf8');
        return summaryFile;
    } catch (e) {
        return null;
    }
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
    if (state.sourcesRecovered) lines.push(`- **Original source files recovered (sourcemaps):** ${state.sourcesRecovered}`);
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
    console.log(`Target: ${targetUrl}  |  ${mins} min  |  ${total} events  |  ${state.secrets} secrets  |  ${state.wasmDumped} wasm${state.sourcesRecovered ? `  |  ${state.sourcesRecovered} src files from maps` : ''}${state.heapDiffs ? `  |  ${state.heapDiffs} heap diff(s)` : ''}`);
    const top = topUrls(5);
    if (top.length) {
        console.log(`${C.dim}Top URLs:${C.reset}`);
        for (const [url, hits] of top) {
            console.log(`  ${C.dim}${String(hits).padStart(4)}  ${url.substring(0, 90)}${C.reset}`);
        }
    }
    const reportPath = sessionLogFile.replace(/\.jsonl$/, '_summary.md');
    if (logFile && typeof logFile === 'string' && logFile.endsWith('.jsonl')) {
        try {
            fs.writeFileSync(reportPath, renderSummary(targetUrl, logFile), 'utf8');
        } catch (e) {}
    }
    console.log(`${C.dim}Full report: ${reportPath}${C.reset}`);
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
    state.sourcesRecovered = 0;
    state.contentKeys = [];
    state.rawAesKeys = [];
    state.hlsKeys = [];
    state.secretFindings = [];
    state.manifests = [];
    state.wasmModules = [];
    state.extractedFiles = { total: 0, byExtension: Object.create(null) };
}

module.exports = {
    trackEvent,
    trackSecret,
    trackWasmDump,
    trackHeapDiff,
    trackSourcesRecovered,
    trackContentKey,
    trackRawAesKey,
    trackHlsKey,
    trackSecretFinding,
    trackManifest,
    trackExtractedFile,
    writeExtractedSummary,
    renderSummary,
    printSummary,
    resetSummary
};
