#!/usr/bin/env node
// verify-reimpl.js — the verification oracle.
//
// Reading obfuscated JS gives you a hypothesis, not a fact. This script checks
// the hypothesis: it loads (input -> output) pairs captured by
//   node capture_server.js <url> --hook-return "window.sign"
// from a session JSONL, then runs YOUR reimplementation of the function in an
// isolated headless Chrome page (about:blank — it cannot see the target, its
// closures, or its network) against the whole corpus, and prints a structured
// diff with concrete counterexamples.
//
// Iterate until the diff is empty. Nothing inferred is trusted until then.
//
// Usage:
//   node scripts/verify-reimpl.js --session session_capture_123.jsonl \
//        --label "window.sign" --candidate ./my_signer.js
//
// Candidate contract: a JS file with `module.exports = function (...args) {...}`
// (sync or promise-returning). Extra smoke inputs (NOT counted in the
// verdict): --input '<json-args-array>' — repeatable.
//
// Exit codes: 0 verified | 1 mismatches | 2 usage/no corpus | 3 runtime error.
'use strict';

const fs = require('fs');
const path = require('path');

// ---- pure core (unit-tested) --------------------------------------------

// Extract (input,output) corpus pairs for one hook label from JSONL content.
// Non-serializable outputs are recorded as unserialized and skipped by the
// verifier (they cannot be compared by value).
function extractPairs(jsonlContent, label) {
    const pairs = [];
    for (const line of jsonlContent.split('\n')) {
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch (e) { continue; }
        if (!evt || evt.type !== 'hook_pair') continue;
        if (label && evt.hook !== label) continue;
        if (evt.output === null && evt.output_type) continue; // unserialized output
        pairs.push({ input: evt.input, output: evt.output });
    }
    return pairs;
}

// Strict deep equality: type-sensitive (bool !== 1, '2' !== 2), order-aware
// for arrays, key-set-aware for objects. Own implementation — the comparisons
// decide whether a reimplementation ships, so no coercing shortcuts.
function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a === 'boolean' || typeof b === 'boolean') return false;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!deepEqual(a[i], b[i])) return false;
        }
        return true;
    }
    if (typeof a === 'object') {
        const ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (const k of ka) {
            if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
            if (!deepEqual(a[k], b[k])) return false;
        }
        return true;
    }
    return false; // primitives that passed a === b and the type check are equal
}

// ---- CLI -------------------------------------------------------------------

function usage(code) {
    console.log(`verify-reimpl.js — check a reimplementation against captured ground truth

Usage:
  node scripts/verify-reimpl.js --session <file.jsonl> --label <hook> --candidate <file.js>
                                [--input '<json-args-array>'] [--max-mismatches 5]

  --session <file>       Session JSONL (from capture_server.js) containing
                         hook_pair events (capture with --hook-return).
  --label <hook>         Hook label to verify, e.g. "window.buildPayload".
                         Required when the session has more than one hooked fn.
  --candidate <file>     JS file: module.exports = function (...args) { ... }
                         Runs in an isolated about:blank page — no network, no
                         access to the target site or its closures.
  --input <json>         Extra args array as a smoke test, e.g. '["zoe", 0]'.
                         Printed but NOT counted in the verdict.
  --max-mismatches <n>   Counterexamples to print (default 5).

Exit: 0 verified | 1 mismatches | 2 usage/no corpus | 3 runtime error`);
    process.exit(code);
}

function parseCli(argv) {
    const opts = { session: null, label: null, candidate: null, inputs: [], maxMismatches: 5 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--session') opts.session = argv[++i];
        else if (a === '--label') opts.label = argv[++i];
        else if (a === '--candidate') opts.candidate = argv[++i];
        else if (a === '--input') opts.inputs.push(argv[++i]);
        else if (a === '--max-mismatches') opts.maxMismatches = parseInt(argv[++i], 10);
        else if (a === '--help' || a === '-h') usage(0);
        else usageError(`unknown argument: ${a}`);
    }
    if (!opts.session) usageError('--session is required');
    if (!opts.candidate) usageError('--candidate is required');
    if (!Number.isFinite(opts.maxMismatches) || opts.maxMismatches < 1) usageError('--max-mismatches must be >= 1');
    return opts;
}

function usageError(msg) {
    console.error(`error: ${msg}\n(run with --help for usage)`);
    process.exit(2);
}

// ---- main ------------------------------------------------------------------

async function main() {
    const opts = parseCli(process.argv.slice(2));

    // Corpus
    let content;
    try { content = fs.readFileSync(opts.session, 'utf8'); }
    catch (e) { usageError(`cannot read session file: ${e.message}`); }
    const pairs = extractPairs(content, opts.label);

    // Auto-label when the session captured exactly one hook.
    if (!opts.label) {
        const labels = new Set();
        for (const line of content.split('\n')) {
            if (!line.includes('hook_pair')) continue;
            try { const e = JSON.parse(line); if (e && e.type === 'hook_pair' && e.hook) labels.add(e.hook); } catch (e) {}
        }
        if (labels.size === 1) opts.label = [...labels][0];
    }
    if (!pairs.length) {
        console.error(`no (input,output) pairs in ${opts.session}${opts.label ? ` for label "${opts.label}"` : ''}.`);
        console.error('Capture a corpus first: node capture_server.js <url> --hook-return "<expr>"');
        process.exit(2);
    }

    // Candidate source
    let candidateSrc;
    try { candidateSrc = fs.readFileSync(path.resolve(opts.candidate), 'utf8'); }
    catch (e) { usageError(`cannot read candidate file: ${e.message}`); }

    // Isolated runner
    let puppeteer;
    try { puppeteer = require('puppeteer'); }
    catch (e) {
        console.error('puppeteer is not installed. Run: npm install');
        process.exit(3);
    }
    const browser = await puppeteer.launch({ headless: true, pipe: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        await page.goto('about:blank');

        const installed = await page.evaluate((src) => {
            try {
                const mod = { exports: {} };
                new Function('module', 'exports', src)(mod, mod.exports);
                const fn = mod.exports && mod.exports.default ? mod.exports.default : mod.exports;
                if (typeof fn !== 'function') {
                    return { ok: false, error: 'candidate must export a function: module.exports = fn' };
                }
                window.__candidate = fn;
                return { ok: true };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        }, candidateSrc);
        if (!installed.ok) {
            console.error(`candidate failed to load: ${installed.error}`);
            process.exit(3);
        }

        const runOne = async (input) => {
            const args = Array.isArray(input) ? input : [input];
            const r = await page.evaluate(async (a) => {
                try {
                    const v = await window.__candidate.apply(null, a);
                    return { ok: true, value: v === undefined ? null : v };
                } catch (e) {
                    return { ok: false, error: String(e && e.message || e) };
                }
            }, JSON.parse(JSON.stringify(args)));
            if (!r.ok) return { error: r.error };
            return r.value;
        };

        // Smoke inputs — printed, not scored.
        for (const raw of opts.inputs) {
            let parsed;
            try { parsed = JSON.parse(raw); } catch (e) { usageError(`--input is not valid JSON: ${raw}`); }
            const got = await runOne(parsed);
            console.log(`smoke ${JSON.stringify(parsed)} -> ${JSON.stringify(got)}`);
        }

        // Verdict over the corpus
        let matched = 0;
        const mismatches = [];
        for (const p of pairs) {
            const got = await runOne(p.input);
            const expected = p.output === undefined ? null : p.output;
            if (!got || typeof got !== 'object' || !('error' in got)) {
                if (deepEqual(expected, got)) { matched++; continue; }
            }
            if (mismatches.length < opts.maxMismatches) {
                mismatches.push({ input: p.input, expected, got });
            }
        }

        const verified = matched === pairs.length;
        console.log(`\n==== verify "${opts.label}" ====`);
        console.log(`corpus: ${pairs.length} pair(s) from ${path.basename(opts.session)}`);
        console.log(`matched: ${matched}/${pairs.length}`);
        for (const m of mismatches) {
            console.log(`\n  input:     ${JSON.stringify(m.input)}`);
            console.log(`  expected:  ${JSON.stringify(m.expected)}`);
            console.log(`  got:       ${JSON.stringify(m.got)}`);
        }
        console.log(`\nverdict: ${verified ? 'VERIFIED — reimplementation matches the captured ground truth' : 'NOT VERIFIED — iterate until the diff is empty'}`);
        process.exit(verified ? 0 : 1);
    } finally {
        try { await browser.close(); } catch (e) {}
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error('runtime error:', e.message);
        process.exit(3);
    });
}

module.exports = { extractPairs, deepEqual };
