// Page-side hooks — injected via evaluateOnNewDocument (pages/iframes) or
// Runtime.evaluate (worker targets). Scope-agnostic: uses globalThis so it
// runs identically in window and worker scopes.
//
// Event transport:
//   1. STRUCTURED (preferred): if the Node side installed the `__wci`
//      Runtime.addBinding, events are emitted as JSON envelopes:
//        { uid, type, data }
//      Large payloads (WASM hex) are chunked into { seq, of } pieces and
//      reassembled by src/cdp/events.js.
//   2. LEGACY fallback: console.log("[Reversed-Event] ...") lines, parsed by
//      the Node side exactly like the original release. Used when no binding
//      exists (attached mid-flight) or when a binding call throws.
//
// Stealth: every wrapper is registered in originalFunctions so
// Function.prototype.toString keeps returning the native source, and
// secureObject keeps name/arity looking native.

(function () {
    'use strict';

    var W = typeof globalThis !== 'undefined' ? globalThis : self;
    var CFG = W.__WCI_CFG || {}; // prelude-injected config: { allTraffic: true }

    // ---------------- transport ----------------
    var bindingFn = null;
    try { if (typeof W.__wci === 'function') bindingFn = W.__wci; } catch (e) {}

    var uidCounter = 0;
    var uidBase = Math.random().toString(36).slice(2, 10) + '-';
    var CHUNK_SIZE = 200000; // stay well under any binding payload limits

    function newUid() { return uidBase + (++uidCounter); }

    function legacyText(type, d) {
        switch (type) {
            case 'fetch':        return '[Reversed-Event] ' + (d.video ? 'VIDEO' : 'fetch') + ' [' + (d.method || 'GET') + '] ' + d.url + (d.body ? ' body: ' + d.body : '');
            case 'xhr':          return '[Reversed-Event] ' + (d.video ? 'VIDEO' : 'XHR') + ' [' + (d.method || 'GET') + '] ' + d.url + (d.body ? ' body: ' + d.body : '');
            case 'beacon':       return '[Reversed-Event] sendBeacon ' + d.url + (d.body ? ' body: ' + d.body : '');
            case 'ws_send':      return '[Reversed-Event] WebSocket [SEND] ' + d.url + ' body: ' + d.body;
            case 'ws_recv':      return '[Reversed-Event] WebSocket [RECV] ' + d.url + ' body: ' + d.body;
            case 'worker_msg':   return '[Reversed-Event] ' + (d.source === 'port' ? 'PORT' : 'WORKER') + ' postMessage: ' + d.preview;
            case 'blob_url':     return '[Reversed-Event] BLOB URL ' + d.url + ' type=' + d.type + ' size=' + d.size + 'B';
            case 'blob_content': return '[Reversed-Event] BLOB CONTENT ' + d.url + ': ' + d.snippet;
            case 'storage':      return '[Reversed-Event] STORAGE [' + d.storage + '] set ' + d.key + ' = ' + d.value;
            case 'random':       return '[Reversed-Event] CRYPTO-ARGS getRandomValues ' + d.raw;
            case 'crypto_args':   return '[Reversed-Event] CRYPTO-ARGS ' + d.method + ' ' + d.args;
            case 'crypto_result': return '[Reversed-Event] CRYPTO-RESULT ' + d.method + ' ' + d.result;
            case 'jscrypto':     return '[Reversed-Event] JSCRYPTO-ARGS ' + d.label + ' ' + d.payload;
            case 'hook_init':    return '[Reversed-Event] JSCRYPTO-ARGS init ' + d.lib;
            case 'wasm':         return '[Reversed-Event] WASM WebAssembly.' + d.method + ' of ' + d.bytes + ' bytes hash=' + d.hash;
            default:             return null;
        }
    }

    function emit(type, data) {
        if (bindingFn) {
            try {
                bindingFn(JSON.stringify({ uid: newUid(), type: type, data: data }));
                return;
            } catch (e) { /* fall through to console */ }
        }
        var text = legacyText(type, data);
        if (text) {
            try { W.console.log(text); } catch (e) {}
        }
    }

    // WASM hex can be multiple MB. Send as numbered chunks; events.js
    // reassembles. Falls back to the legacy "WASM-HEX <hash> <hex>" console
    // line when no binding exists.
    function emitWasmHex(hash, hex) {
        if (!bindingFn) {
            try { W.console.log('[Reversed-Event] WASM-HEX ' + hash + ' ' + hex); } catch (e) {}
            return;
        }
        var uid = newUid();
        var total = Math.ceil(hex.length / CHUNK_SIZE);
        for (var i = 0; i < total; i++) {
            try {
                bindingFn(JSON.stringify({
                    uid: uid + '#' + i, type: 'wasm_hex',
                    seq: i, of: total, hash: hash,
                    hex: hex.substr(i * CHUNK_SIZE, CHUNK_SIZE)
                }));
            } catch (e) { return; }
        }
    }

    // ---------------- getRandomValues rate limiter ----------------
    // Fraud-detection scripts call it thousands of times; without a cap the
    // log floods and the useful signals drown. First 40 calls per rolling
    // second are logged verbatim, after that only every 100th call.
    var rlWindowStart = 0, rlCount = 0, rlSkipped = 0;
    function shouldLogRandom() {
        var now = Date.now();
        if (now - rlWindowStart > 1000) { rlWindowStart = now; rlCount = 0; if (rlSkipped > 0) { emit('random', { t: 'rate', len: rlSkipped, hex: '(suppressed ' + rlSkipped + ' calls in last second)', raw: '{"suppressed":' + rlSkipped + '}' }); rlSkipped = 0; } }
        rlCount++;
        if (rlCount <= 40) return true;
        if ((rlCount - 40) % 100 === 0) return true;
        rlSkipped++;
        return false;
    }

    // ---------------- stealth plumbing ----------------
    var originalFunctions = new WeakMap();
    var backupToString = Function.prototype.toString;

    function secureObject(obj, prop, value, writable) {
        Object.defineProperty(obj, prop, {
            value: value, writable: writable !== false, configurable: true, enumerable: false
        });
    }

    function hook(parentObj, propName, buildHook) {
        if (!parentObj || !parentObj[propName]) return;
        var originalFn = parentObj[propName];
        if (originalFunctions.has(originalFn)) return;
        var hookedFn = buildHook(originalFn);
        originalFunctions.set(hookedFn, originalFn);
        secureObject(hookedFn, 'name', originalFn.name || propName, false);
        if (originalFn.prototype) hookedFn.prototype = originalFn.prototype;
        parentObj[propName] = hookedFn;
    }

    Function.prototype.toString = function toString() {
        if (originalFunctions.has(this)) {
            return backupToString.call(originalFunctions.get(this));
        }
        return backupToString.call(this);
    };
    secureObject(Function.prototype.toString, 'name', 'toString', false);

    // ---------------- debugger traps ----------------
    try {
        var OrigFunction = W.Function;
        var FunctionProxy = new Proxy(OrigFunction, {
            construct(target, args) {
                if (args.length > 0) {
                    var srcIdx = args.length - 1;
                    var src = args[srcIdx];
                    if (typeof src === 'string' && /\bdebugger\b/i.test(src)) {
                        args[srcIdx] = src.replace(/\bdebugger\b/gi, '/* bypassed debugger */');
                    }
                }
                return Reflect.construct(target, args);
            },
            apply(target, thisArg, args) {
                if (args.length > 0) {
                    var srcIdx = args.length - 1;
                    var src = args[srcIdx];
                    if (typeof src === 'string' && /\bdebugger\b/i.test(src)) {
                        args[srcIdx] = src.replace(/\bdebugger\b/gi, '/* bypassed debugger */');
                    }
                }
                return Reflect.apply(target, thisArg, args);
            }
        });
        Object.defineProperty(FunctionProxy, 'prototype', { value: OrigFunction.prototype });
        W.Function = FunctionProxy;
        originalFunctions.set(FunctionProxy, OrigFunction);
    } catch (e) {}

    try {
        hook(W, 'setInterval', function (origSetInterval) {
            return function setInterval(fn, ms) {
                if (typeof fn === 'string' && /\bdebugger\b/i.test(fn)) return 0;
                if (typeof fn === 'function' && /\bdebugger\b/i.test(backupToString.call(fn))) return 0;
                return origSetInterval.apply(this, arguments);
            };
        });
        hook(W, 'setTimeout', function (origSetTimeout) {
            return function setTimeout(fn, ms) {
                if (typeof fn === 'string' && /\bdebugger\b/i.test(fn)) return 0;
                if (typeof fn === 'function' && /\bdebugger\b/i.test(backupToString.call(fn))) return 0;
                return origSetTimeout.apply(this, arguments);
            };
        });
    } catch (e) {}
    // ---------------- URL classification ----------------
    function isInterestingUrl(url) {
        if (!url) return false;
        if (CFG.allTraffic) return true;
        var noise = [
            'doubleclick', 'google-analytics', 'googletagmanager', 'clarity.ms',
            'facebook.com', 'facebook.net', 'linkedin.com', 'google.com/ccm',
            'google.com/measurement', 'google.com/rmkt', 'googleadservices',
            'analytics.google', '/collect?', '/collect ', 'gtag/', 'forter.com',
            'sharethis.com', 'crwdcntrl.net', 'scorecardresearch.com', 'quantserve.com',
            'hotjar.com', 'mixpanel.com', 'segment.io', 'segment.com', 'amplitude.com',
            'sentry.io', 'bugsnag.com', 'newrelic.com', 'datadoghq.com',
            '/cdn-cgi/rum', '/cdn-cgi/challenge-platform', '/cdn-cgi/beacon',
            '/cdn-cgi/trace', '/cdn-cgi/zaraz'
        ];
        var lower = String(url).toLowerCase();
        return !noise.some(function (n) { return lower.includes(n); });
    }

    function isVideoUrl(url) {
        if (!url) return false;
        return /\.(m3u8|mpd|ts|mp4|m4s|webm|mkv|key)(\?|$)/i.test(url)
            || /\/(hls|dash|stream|manifest|segment|video|getVideo|playlist)/i.test(url);
    }

    function describeBody(payload) {
        if (payload === null || payload === undefined) return null;
        if (payload instanceof ArrayBuffer || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(payload))) {
            return '[binary ' + (payload.byteLength !== undefined ? payload.byteLength : payload.length) + 'B]';
        }
        if (typeof Blob !== 'undefined' && payload instanceof Blob) {
            return '[blob ' + payload.size + 'B ' + payload.type + ']';
        }
        if (typeof FormData !== 'undefined' && payload instanceof FormData) {
            var parts = [];
            try { var it = payload.entries(), step; while (!(step = it.next()).done) { parts.push(step.value[0] + '=' + (typeof step.value[1] === 'string' ? step.value[1] : '[file]')); } } catch (e) {}
            return parts.join('&');
        }
        return payload;
    }

    // ---------------- network: fetch / XHR / beacon / websocket ----------------
    hook(W, 'fetch', function (origFetch) {
        return function fetch(resource, options) {
            try {
                var endpoint = (typeof resource === 'string') ? resource : (resource && resource.url ? resource.url : '');
                if (isInterestingUrl(endpoint)) {
                    var body = options && options.body ? describeBody(options.body) : null;
                    emit('fetch', { method: (options && options.method) || 'GET', url: endpoint, video: isVideoUrl(endpoint), body: body });
                }
            } catch (e) {}
            return origFetch.apply(this, arguments);
        };
    });

    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        hook(navigator, 'sendBeacon', function (origSendBeacon) {
            return function sendBeacon(url, data) {
                try {
                    if (isInterestingUrl(url)) {
                        emit('beacon', { url: url, body: describeBody(data) });
                    }
                } catch (e) {}
                return origSendBeacon.apply(this, arguments);
            };
        });
    }

    if (typeof WebSocket !== 'undefined') {
        hook(WebSocket.prototype, 'send', function (origSend) {
            return function send(data) {
                try {
                    var url = this.url;
                    if (isInterestingUrl(url)) {
                        var payload = data;
                        if (data instanceof ArrayBuffer || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data))) {
                            payload = '[binary ws ' + (data.byteLength !== undefined ? data.byteLength : data.length) + 'B]';
                        }
                        emit('ws_send', { url: url, body: payload });
                    }
                } catch (e) {}
                return origSend.apply(this, arguments);
            };
        });
    }

    // Receive side: send() above only sees outbound frames. Wrapping the
    // constructor in a Proxy lets us attach a 'message' listener to every
    // socket instance without clobbering the site's own onmessage= or
    // addEventListener('message', ...) usage. Instance creation goes through
    // Object.create(WebSocket.prototype) semantics so subclass sites that do
    // `class W extends WebSocket` keep working: instead of returning a
    // foreign object from the construct trap (which breaks `instanceof W`),
    // we attach the listener on the instance the site actually receives.
    if (typeof WebSocket !== 'undefined') {
        try {
            var OrigWebSocket = W.WebSocket;
            var WebSocketProxy = new Proxy(OrigWebSocket, {
                construct(target, args) {
                    var instance = Reflect.construct(target, args);
                    try { attachWsRecv(instance); } catch (e) {}
                    return instance;
                }
            });
            Object.defineProperty(WebSocketProxy, 'prototype', { value: OrigWebSocket.prototype });
            W.WebSocket = WebSocketProxy;
            originalFunctions.set(WebSocketProxy, OrigWebSocket);
            try { OrigWebSocket.prototype.constructor = WebSocketProxy; } catch (e) {}
        } catch (e) {}

        // The site may also construct sockets via the captured original
        // reference before our proxy was installed — patch the prototype's
        // constructor trap once more via a marker so direct `new WebSocket`
        // on the ORIGINAL still gets a receiver (best effort).
        var attachWsRecv = function (instance) {
            instance.addEventListener('message', function (evt) {
                try {
                    if (!isInterestingUrl(instance.url)) return;
                    var data = evt.data;
                    if (data instanceof ArrayBuffer) data = '[binary ws ' + data.byteLength + 'B]';
                    else if (typeof data === 'string' && data.length > 1000) data = data.substring(0, 1000) + '...';
                    emit('ws_recv', { url: instance.url, body: data });
                } catch (e) {}
            });
        };
    }
    // ---------------- WASM ----------------
    if (typeof WebAssembly !== 'undefined') {
        function getWasmHash(bytes) {
            var hash = 5381;
            var limit = Math.min(bytes.length, 1024);
            for (var i = 0; i < limit; i++) {
                hash = (hash * 33) ^ bytes[i];
            }
            return (hash >>> 0).toString(16);
        }

        function dumpWasm(bytes, method) {
            try {
                var len = bytes.byteLength;
                var arr = new Uint8Array(bytes);
                var hash = getWasmHash(arr);
                emit('wasm', { method: method, bytes: len, hash: hash });
                if (len < 5000000) {
                    var hex = '';
                    for (var i = 0; i < arr.length; i++) {
                        hex += (arr[i] < 16 ? '0' : '') + arr[i].toString(16);
                    }
                    emitWasmHex(hash, hex);
                }
            } catch (e) {}
        }

        hook(WebAssembly, 'compile', function (origCompile) {
            return function compile(bufferSource) {
                var bytes = (bufferSource instanceof ArrayBuffer) ? bufferSource : (bufferSource && bufferSource.buffer);
                if (bytes) dumpWasm(bytes, 'compile');
                return origCompile.apply(this, arguments);
            };
        });

        hook(WebAssembly, 'instantiate', function (origInstantiate) {
            return function instantiate(bufferSource, importObject) {
                var bytes = (bufferSource instanceof ArrayBuffer) ? bufferSource : (bufferSource && bufferSource.buffer);
                if (bytes) dumpWasm(bytes, 'instantiate');
                return origInstantiate.apply(this, arguments);
            };
        });

        hook(WebAssembly, 'instantiateStreaming', function (origInstantiateStreaming) {
            return function instantiateStreaming(source, importObject) {
                try { emit('wasm', { method: 'instantiateStreaming', bytes: 0, hash: 'streaming' }); } catch (e) {}
                return origInstantiateStreaming.apply(this, arguments);
            };
        });
    }

    // ---------------- storage ----------------
    if (typeof Storage !== 'undefined') {
        var analyticsNoise = /^(ph_|posthog|_ga|_gid|_gcl|_gac|_fbp|_fbc|_hj|hjid|hjsession|mp_|amplitude|mixpanel|_uetsid|_uetvid|utm_|__utm|_pk_|matomo|clarity|_scid)/i;
        var interestingKeys = /(token|jwt|session|uuid|device|visitor|cipher|key|pan|card|cvv|auth|pay|bearer|secret|refresh|access_token|id_token)/i;
        var lastStorage = new Map();
        hook(Storage.prototype, 'setItem', function (origSetItem) {
            return function setItem(key, value) {
                try {
                    if (!analyticsNoise.test(key) && (interestingKeys.test(key) || interestingKeys.test(String(value).substring(0, 200)))) {
                        var type = this === localStorage ? 'localStorage' : 'sessionStorage';
                        var val = typeof value === 'string' ? value : String(value);
                        var sig = type + '|' + key + '|' + val.length + '|' + val.substring(0, 32);
                        if (lastStorage.get(key) !== sig) {
                            lastStorage.set(key, sig);
                            emit('storage', { storage: type, key: key, value: val.substring(0, 300) });
                        }
                    }
                } catch (e) {}
                return origSetItem.apply(this, arguments);
            };
        });
    }

    // ---------------- XHR ----------------
    if (typeof XMLHttpRequest !== 'undefined') {
        var xhrMeta = new WeakMap();
        hook(XMLHttpRequest.prototype, 'open', function (origOpen) {
            return function open(method, url) {
                xhrMeta.set(this, { url: url, method: method });
                return origOpen.apply(this, arguments);
            };
        });
        hook(XMLHttpRequest.prototype, 'send', function (origSend) {
            return function send(body) {
                try {
                    var meta = xhrMeta.get(this) || {};
                    if (isInterestingUrl(meta.url)) {
                        emit('xhr', { method: meta.method || 'GET', url: meta.url, video: isVideoUrl(meta.url), body: body ? describeBody(body) : null });
                    }
                } catch (e) {}
                return origSend.apply(this, arguments);
            };
        });
    }

    // ---------------- worker / port messaging ----------------
    // React 18 scheduler uses MessagePort.postMessage(null) constantly to yield.
    // Skip empty/null/tiny numeric messages that carry no useful data.
    function isBoringMsg(msg) {
        if (msg === null || msg === undefined) return true;
        if (typeof msg === 'number' || typeof msg === 'boolean') return true;
        if (typeof msg === 'string' && msg.length < 3) return true;
        return false;
    }

    function previewMsg(msg) {
        if (typeof msg === 'string') return msg.substring(0, 500);
        if (msg && msg.byteLength !== undefined) return '[binary ' + msg.byteLength + 'B]';
        try { return JSON.stringify(msg).substring(0, 500); } catch (e) { return '[unserializable]'; }
    }

    if (typeof Worker !== 'undefined' && Worker.prototype && Worker.prototype.postMessage) {
        hook(Worker.prototype, 'postMessage', function (origPost) {
            return function postMessage(msg) {
                try {
                    if (!isBoringMsg(msg)) emit('worker_msg', { source: 'worker', preview: previewMsg(msg) });
                } catch (e) {}
                return origPost.apply(this, arguments);
            };
        });
    }

    if (typeof MessagePort !== 'undefined' && MessagePort.prototype && MessagePort.prototype.postMessage) {
        hook(MessagePort.prototype, 'postMessage', function (origPost) {
            return function postMessage(msg) {
                try {
                    if (!isBoringMsg(msg)) emit('worker_msg', { source: 'port', preview: previewMsg(msg) });
                } catch (e) {}
                return origPost.apply(this, arguments);
            };
        });
    }

    // ---------------- blob urls ----------------
    if (typeof URL !== 'undefined' && URL.createObjectURL) {
        hook(URL, 'createObjectURL', function (origCreate) {
            return function createObjectURL(obj) {
                var url = origCreate.apply(this, arguments);
                try {
                    if (obj instanceof Blob) {
                        emit('blob_url', { url: url, type: obj.type, size: obj.size });
                        if (obj.size < 200000 && (/javascript|json|text|wasm/i.test(obj.type) || obj.type === '')) {
                            obj.text().then(function (txt) {
                                var snippet = txt.length > 800 ? txt.substring(0, 800) + '...' : txt;
                                emit('blob_content', { url: url, snippet: snippet });
                            }).catch(function () {});
                        }
                    }
                } catch (e) {}
                return url;
            };
        });
    }
    // ---------------- crypto.getRandomValues ----------------
    // crypto.subtle argument capture — page-side wrapper. Complements the CDP
    // breakpoint (which pauses at the caller frame and sometimes can't see args
    // that live in a Promise microtask closure). This wrapper runs at call time
    // so it always sees the real arguments.
    // Surfaces client-generated nonces/IVs (e.g. the random AES key in the
    // RSA+AES hybrid request wrapper) so they can be matched against the
    // request/response that consumes them.
    try {
        var cr = W.crypto;
        if (cr && typeof cr.getRandomValues === 'function') {
            hook(cr, 'getRandomValues', function (origGetRandomValues) {
                return function getRandomValues(array) {
                    var ret = origGetRandomValues.apply(this, arguments);
                    try {
                        if (shouldLogRandom()) {
                            var hex = '';
                            var limit = Math.min(array.length, 64);
                            for (var i = 0; i < limit; i++) hex += (array[i] < 16 ? '0' : '') + array[i].toString(16);
                            emit('random', {
                                t: array.constructor && array.constructor.name,
                                len: array.length, hex: hex,
                                raw: JSON.stringify([{ __t: array.constructor && array.constructor.name, len: array.length, hex: hex }])
                            });
                        }
                    } catch (e) {}
                    return ret;
                };
            });
        }
    } catch (e) {}

    // ---------------- crypto.subtle wrappers ----------------
    try {
        var subtle = W.crypto && W.crypto.subtle;
        if (subtle) {
            function bytesToObj(u, name) {
                var hex = '', utf8 = '';
                var limit = Math.min(u.length, 512);
                for (var i = 0; i < limit; i++) hex += (u[i] < 16 ? '0' : '') + u[i].toString(16);
                var out = { __t: name || 'Bytes', len: u.length, hex: hex };
                try { utf8 = new TextDecoder('utf-8', { fatal: false }).decode(u.subarray(0, 512)); } catch (e) {}
                // Only include utf8 if it looks like real text: no U+FFFD
                // replacement chars and mostly-printable content. Otherwise
                // it's binary (AES key / ciphertext) and the string is garbage.
                if (utf8 && utf8.indexOf('\uFFFD') === -1) {
                    var printable = 0, total = utf8.length;
                    for (var j = 0; j < total; j++) {
                        var code = utf8.charCodeAt(j);
                        // Printable ASCII, tab, LF, CR, or any non-ASCII code point
                        if ((code >= 0x20 && code <= 0x7E) || code === 9 || code === 10 || code === 13 || code > 0x7F) printable++;
                    }
                    if (total > 0 && printable / total >= 0.9) out.utf8 = utf8;
                }
                return out;
            }
            function serializeArg(v, depth) {
                if (depth === undefined) depth = 3;
                if (v === null || v === undefined) return v;
                var t = typeof v;
                if (t === 'string') return v.length > 512 ? v.substring(0, 512) + '...' : v;
                if (t === 'number' || t === 'boolean') return v;
                if (t === 'function') return '[function]';
                if (v instanceof ArrayBuffer) return bytesToObj(new Uint8Array(v), 'ArrayBuffer');
                if (ArrayBuffer.isView(v)) return bytesToObj(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), v.constructor && v.constructor.name);
                if (typeof CryptoKey !== 'undefined' && v instanceof CryptoKey) {
                    return { __t: 'CryptoKey', type: v.type, extractable: v.extractable, algorithm: v.algorithm, usages: v.usages };
                }
                if (Array.isArray(v)) {
                    if (depth <= 0) return '[Array len=' + v.length + ']';
                    return v.slice(0, 16).map(function (x) { return serializeArg(x, depth - 1); });
                }
                if (t === 'object') {
                    if (depth <= 0) return '[Object]';
                    var out = {};
                    var keys;
                    try { keys = Object.keys(v).slice(0, 24); } catch (e) { return '[unreadable]'; }
                    for (var i = 0; i < keys.length; i++) {
                        try { out[keys[i]] = serializeArg(v[keys[i]], depth - 1); } catch (e) { out[keys[i]] = '[unreadable]'; }
                    }
                    return out;
                }
                return String(v);
            }
            var subtleMethods = ['encrypt', 'decrypt', 'sign', 'verify', 'digest',
                'deriveKey', 'deriveBits', 'importKey', 'exportKey',
                'generateKey', 'wrapKey', 'unwrapKey'];
            for (var mi = 0; mi < subtleMethods.length; mi++) {
                (function (m) {
                    var orig;
                    try { orig = subtle[m]; } catch (e) { return; }
                    if (typeof orig !== 'function') return;
                    var wrapped = function () {
                        try {
                            var args = [];
                            for (var i = 0; i < arguments.length; i++) args.push(serializeArg(arguments[i]));
                            var line;
                            try { line = JSON.stringify(args); } catch (e) { line = '[unserializable args]'; }
                            if (line.length > 4096) line = line.substring(0, 4096) + '...';
                            emit('crypto_args', { method: m, args: line });
                        } catch (e) {}
                        var res = orig.apply(this, arguments);
                        if (res && typeof res.then === 'function') {
                            res.then(function (resolved) {
                                try {
                                    var serialized = serializeArg(resolved);
                                    var resLine;
                                    try { resLine = JSON.stringify(serialized); } catch (e) { resLine = '[unserializable result]'; }
                                    if (resLine && resLine.length > 4096) resLine = resLine.substring(0, 4096) + '...';
                                    emit('crypto_result', { method: m, result: resLine });
                                } catch (e) {}
                            }).catch(function () {});
                        }
                        return res;
                    };
                    originalFunctions.set(wrapped, orig);
                    secureObject(wrapped, 'name', m, false);
                    try {
                        Object.defineProperty(subtle, m, { value: wrapped, writable: true, configurable: true, enumerable: true });
                    } catch (e) {}
                })(subtleMethods[mi]);
            }
        }
    } catch (e) {}
    // ---------------- pure-JS crypto libraries ----------------
    // CryptoJS / JSEncrypt / sjcl hooks — for sites that don't use Web Crypto.
    // Poller runs for ~15s to catch libs loaded lazily after our stealth
    // script. Uses the same stealth pattern (originalFunctions map so
    // Function.prototype.toString still returns the native source).
    try {
        var jsHooked = { CryptoJS: false, JSEncrypt: false, sjcl: false };

        function jsWaToHex(wa) {
            try {
                if (wa && typeof wa.toString === 'function') return wa.toString();
            } catch (e) {}
            return null;
        }
        function jsDescribeKey(k) {
            if (k === null || k === undefined) return null;
            if (typeof k === 'string') return { __t: 'Passphrase', value: k.length > 256 ? k.substring(0, 256) + '...' : k };
            if (k && typeof k === 'object' && k.words) return { __t: 'WordArray', sigBytes: k.sigBytes, hex: jsWaToHex(k) };
            return { __t: typeof k, value: String(k).substring(0, 128) };
        }
        function jsDescribeMsg(m) {
            if (m === null || m === undefined) return null;
            if (typeof m === 'string') return { __t: 'String', len: m.length, value: m.length > 512 ? m.substring(0, 512) + '...' : m };
            if (m && typeof m === 'object' && m.words) return { __t: 'WordArray', sigBytes: m.sigBytes, hex: jsWaToHex(m) };
            return { __t: typeof m, value: String(m).substring(0, 128) };
        }
        function jsDescribeCipherParams(cp) {
            if (!cp || typeof cp !== 'object') return null;
            var out = { __t: 'CipherParams' };
            try { if (cp.ciphertext) out.ciphertext = jsWaToHex(cp.ciphertext); } catch (e) {}
            try { if (cp.key) out.key = jsWaToHex(cp.key); } catch (e) {}
            try { if (cp.iv) out.iv = jsWaToHex(cp.iv); } catch (e) {}
            try { if (cp.salt) out.salt = jsWaToHex(cp.salt); } catch (e) {}
            try { out.b64 = cp.toString(); } catch (e) {}
            return out;
        }
        function jsDescribeCfg(cfg) {
            if (!cfg || typeof cfg !== 'object') return cfg;
            var out = {};
            try { if (cfg.iv) out.iv = jsWaToHex(cfg.iv); } catch (e) {}
            try { if (cfg.mode && cfg.mode.name) out.mode = cfg.mode.name; } catch (e) {}
            try { if (cfg.padding && cfg.padding.name) out.padding = cfg.padding.name; } catch (e) {}
            try { if (cfg.format) out.format = 'custom'; } catch (e) {}
            return out;
        }
        function jsEmit(label, obj) {
            try {
                var s = JSON.stringify(obj);
                if (s.length > 4096) s = s.substring(0, 4096) + '...';
                emit('jscrypto', { label: label, payload: s });
            } catch (e) {}
        }
        function jsWrap(parent, prop, factory) {
            var orig = parent[prop];
            if (typeof orig !== 'function') return;
            var wrapped = factory(orig);
            originalFunctions.set(wrapped, orig);
            secureObject(wrapped, 'name', orig.name || prop, false);
            parent[prop] = wrapped;
        }

        function hookCryptoJS() {
            if (jsHooked.CryptoJS) return;
            var CJ = W.CryptoJS;
            if (!CJ || !CJ.AES) return;
            jsHooked.CryptoJS = true;
            ['AES', 'DES', 'TripleDES', 'Rabbit', 'RC4'].forEach(function (algo) {
                if (!CJ[algo]) return;
                ['encrypt', 'decrypt'].forEach(function (op) {
                    jsWrap(CJ[algo], op, function (orig) {
                        return function (message, key, cfg) {
                            var ret = orig.apply(this, arguments);
                            try {
                                jsEmit(algo + '.' + op, {
                                    message: jsDescribeMsg(message),
                                    key: jsDescribeKey(key),
                                    cfg: jsDescribeCfg(cfg),
                                    result: op === 'encrypt' ? jsDescribeCipherParams(ret) : jsDescribeMsg(ret)
                                });
                            } catch (e) {}
                            return ret;
                        };
                    });
                });
            });
            ['HmacSHA256', 'HmacSHA1', 'HmacSHA512', 'HmacMD5'].forEach(function (fn) {
                jsWrap(CJ, fn, function (orig) {
                    return function (message, key) {
                        var ret = orig.apply(this, arguments);
                        try {
                            jsEmit(fn, {
                                message: jsDescribeMsg(message),
                                key: jsDescribeKey(key),
                                digest: jsWaToHex(ret)
                            });
                        } catch (e) {}
                        return ret;
                    };
                });
            });
            emit('hook_init', { lib: 'CryptoJS hooked' });
        }

        function hookJSEncrypt() {
            if (jsHooked.JSEncrypt) return;
            var JE = W.JSEncrypt;
            if (!JE || !JE.prototype) return;
            jsHooked.JSEncrypt = true;
            ['setPublicKey', 'setPrivateKey'].forEach(function (m) {
                jsWrap(JE.prototype, m, function (orig) {
                    return function (pem) {
                        try {
                            jsEmit('JSEncrypt.' + m, {
                                pem: typeof pem === 'string' ? (pem.length > 2048 ? pem.substring(0, 2048) + '...' : pem) : String(pem)
                            });
                        } catch (e) {}
                        return orig.apply(this, arguments);
                    };
                });
            });
            ['encrypt', 'decrypt', 'sign', 'verify'].forEach(function (m) {
                jsWrap(JE.prototype, m, function (orig) {
                    return function () {
                        var args = [];
                        for (var i = 0; i < arguments.length; i++) args.push(jsDescribeMsg(arguments[i]));
                        var ret = orig.apply(this, arguments);
                        try {
                            jsEmit('JSEncrypt.' + m, {
                                args: args,
                                result: typeof ret === 'string' ? (ret.length > 512 ? ret.substring(0, 512) + '...' : ret) : String(ret).substring(0, 128)
                            });
                        } catch (e) {}
                        return ret;
                    };
                });
            });
            emit('hook_init', { lib: 'JSEncrypt hooked' });
        }

        function hookSjcl() {
            if (jsHooked.sjcl) return;
            var S = W.sjcl;
            if (!S || typeof S.encrypt !== 'function') return;
            jsHooked.sjcl = true;
            ['encrypt', 'decrypt'].forEach(function (m) {
                jsWrap(S, m, function (orig) {
                    return function (password, data, params) {
                        var ret = orig.apply(this, arguments);
                        try {
                            jsEmit('sjcl.' + m, {
                                password: typeof password === 'string' ? (password.length > 128 ? password.substring(0, 128) + '...' : password) : '[non-string]',
                                data: jsDescribeMsg(data),
                                params: params,
                                result: typeof ret === 'string' ? (ret.length > 1024 ? ret.substring(0, 1024) + '...' : ret) : String(ret).substring(0, 512)
                            });
                        } catch (e) {}
                        return ret;
                    };
                });
            });
            emit('hook_init', { lib: 'sjcl hooked' });
        }

        function pollJsCrypto() {
            try { hookCryptoJS(); } catch (e) {}
            try { hookJSEncrypt(); } catch (e) {}
            try { hookSjcl(); } catch (e) {}
        }
        pollJsCrypto();
        var jsPollCount = 0;
        var jsPollId = setInterval(function () {
            pollJsCrypto();
            if (++jsPollCount > 60) clearInterval(jsPollId); // 60 * 250ms = 15s
        }, 250);
    } catch (e) {}
})();
