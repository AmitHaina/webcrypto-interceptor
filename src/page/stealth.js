(function () {
    'use strict';

    const originalFunctions = new WeakMap();
    const backupToString = Function.prototype.toString;

    function secureObject(obj, prop, value, writable = true) {
        Object.defineProperty(obj, prop, {
            value: value, writable: writable, configurable: true, enumerable: false
        });
    }

    function hook(parentObj, propName, buildHook) {
        if (!parentObj || !parentObj[propName]) return;
        const originalFn = parentObj[propName];
        if (originalFunctions.has(originalFn)) return;
        const hookedFn = buildHook(originalFn);
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

    try {
        const OrigFunction = window.Function;
        const FunctionProxy = new Proxy(OrigFunction, {
            construct(target, args) {
                const src = args[args.length - 1];
                if (typeof src === 'string' && /debugger/i.test(src)) {
                    return function () {};
                }
                return Reflect.construct(target, args);
            },
            apply(target, thisArg, args) {
                const src = args[args.length - 1];
                if (typeof src === 'string' && /debugger/i.test(src)) {
                    return function () {};
                }
                return Reflect.apply(target, thisArg, args);
            }
        });
        Object.defineProperty(FunctionProxy, 'prototype', { value: OrigFunction.prototype });
        window.Function = FunctionProxy;
    } catch (e) {}

    try {
        const origSetInterval = window.setInterval;
        window.setInterval = function (fn, ms) {
            if (typeof fn === 'string' && /debugger/i.test(fn)) return 0;
            if (typeof fn === 'function' && /debugger/i.test(backupToString.call(fn))) return 0;
            return origSetInterval.apply(this, arguments);
        };
        const origSetTimeout = window.setTimeout;
        window.setTimeout = function (fn, ms) {
            if (typeof fn === 'string' && /debugger/i.test(fn)) return 0;
            if (typeof fn === 'function' && /debugger/i.test(backupToString.call(fn))) return 0;
            return origSetTimeout.apply(this, arguments);
        };
    } catch (e) {}

    function isInterestingUrl(url) {
        if (!url) return false;
        const noise = [
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
        const lower = url.toLowerCase();
        return !noise.some(n => lower.includes(n));
    }

    function isVideoUrl(url) {
        if (!url) return false;
        return /\.(m3u8|mpd|ts|mp4|m4s|webm|mkv|key)(\?|$)/i.test(url)
            || /\/(hls|dash|stream|manifest|segment|video|getVideo|playlist)/i.test(url);
    }

    hook(window, 'fetch', function (origFetch) {
        return function fetch(resource, options) {
            try {
                const endpoint = (typeof resource === 'string') ? resource : (resource && resource.url ? resource.url : '');
                if (isInterestingUrl(endpoint)) {
                    const tag = isVideoUrl(endpoint) ? 'VIDEO' : 'fetch';
                    if (options && options.body) {
                        let payload = options.body;
                        if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
                            payload = `[binary ${payload.byteLength || payload.length}B]`;
                        } else if (payload instanceof Blob) {
                            payload = `[blob ${payload.size}B ${payload.type}]`;
                        } else if (payload instanceof FormData) {
                            const parts = [];
                            for (let [k, v] of payload.entries()) parts.push(`${k}=${typeof v === 'string' ? v : '[file]'}`);
                            payload = parts.join('&');
                        }
                        console.log(`[Reversed-Event] ${tag} [${options.method || 'GET'}] ${endpoint} body: ${payload}`);
                    } else {
                        console.log(`[Reversed-Event] ${tag} [${(options && options.method) || 'GET'}] ${endpoint}`);
                    }
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
                        let payload = data;
                        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
                            payload = `[binary ${data.byteLength || data.length}B]`;
                        } else if (data instanceof Blob) {
                            payload = `[blob ${data.size}B ${data.type}]`;
                        }
                        console.log(`[Reversed-Event] sendBeacon ${url} body: ${payload}`);
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
                    const url = this.url;
                    if (isInterestingUrl(url)) {
                        let payload = data;
                        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
                            payload = `[binary ws ${data.byteLength || data.length}B]`;
                        }
                        console.log(`[Reversed-Event] WebSocket [SEND] ${url} body: ${payload}`);
                    }
                } catch (e) {}
                return origSend.apply(this, arguments);
            };
        });
    }

    // Receive side: send() above only sees outbound frames. Wrapping the
    // constructor in a Proxy lets us attach a 'message' listener to every
    // socket instance without clobbering the site's own onmessage= or
    // addEventListener('message', ...) usage.
    if (typeof WebSocket !== 'undefined') {
        try {
            const OrigWebSocket = window.WebSocket;
            const WebSocketProxy = new Proxy(OrigWebSocket, {
                construct(target, args) {
                    const instance = Reflect.construct(target, args);
                    try {
                        instance.addEventListener('message', function (evt) {
                            try {
                                if (isInterestingUrl(instance.url)) {
                                    let data = evt.data;
                                    if (data instanceof ArrayBuffer) data = `[binary ws ${data.byteLength}B]`;
                                    else if (typeof data === 'string' && data.length > 1000) data = data.substring(0, 1000) + '...';
                                    console.log(`[Reversed-Event] WebSocket [RECV] ${instance.url} body: ${data}`);
                                }
                            } catch (e) {}
                        });
                    } catch (e) {}
                    return instance;
                },
            });
            Object.defineProperty(WebSocketProxy, 'prototype', { value: OrigWebSocket.prototype });
            window.WebSocket = WebSocketProxy;
        } catch (e) {}
    }

    if (typeof WebAssembly !== 'undefined') {
        hook(WebAssembly, 'instantiate', function (origInstantiate) {
            return function instantiate(bufferSource, importObject) {
                try {
                    const bytes = (bufferSource instanceof ArrayBuffer) ? bufferSource : (bufferSource && bufferSource.buffer);
                    if (bytes) {
                        console.log(`[Reversed-Event] WASM WebAssembly.instantiate compile of ${bytes.byteLength} bytes.`);
                    }
                } catch (e) {}
                return origInstantiate.apply(this, arguments);
            };
        });
        hook(WebAssembly, 'instantiateStreaming', function (origInstantiateStreaming) {
            return function instantiateStreaming(source, importObject) {
                try {
                    console.log(`[Reversed-Event] WASM WebAssembly.instantiateStreaming called.`);
                } catch (e) {}
                return origInstantiateStreaming.apply(this, arguments);
            };
        });
    }

    if (typeof Storage !== 'undefined') {
        const analyticsNoise = /^(ph_|posthog|_ga|_gid|_gcl|_gac|_fbp|_fbc|_hj|hjid|hjsession|mp_|amplitude|mixpanel|_uetsid|_uetvid|utm_|__utm|_pk_|matomo|clarity|_scid)/i;
        const interestingKeys = /(token|jwt|session|uuid|device|visitor|cipher|key|pan|card|cvv|auth|pay|bearer|secret|refresh|access_token|id_token)/i;
        const lastStorage = new Map();
        hook(Storage.prototype, 'setItem', function (origSetItem) {
            return function setItem(key, value) {
                try {
                    if (!analyticsNoise.test(key) && (interestingKeys.test(key) || interestingKeys.test(String(value).substring(0, 200)))) {
                        const type = this === localStorage ? 'localStorage' : 'sessionStorage';
                        const val = typeof value === 'string' ? value : String(value);
                        const sig = type + '|' + key + '|' + val.length + '|' + val.substring(0, 32);
                        if (lastStorage.get(key) !== sig) {
                            lastStorage.set(key, sig);
                            console.log(`[Reversed-Event] STORAGE [${type}] set ${key} = ${val.substring(0, 300)}`);
                        }
                    }
                } catch (e) {}
                return origSetItem.apply(this, arguments);
            };
        });
    }

    if (typeof XMLHttpRequest !== 'undefined') {
        const xhrMeta = new WeakMap();
        hook(XMLHttpRequest.prototype, 'open', function (origOpen) {
            return function open(method, url) {
                xhrMeta.set(this, { url, method });
                return origOpen.apply(this, arguments);
            };
        });
        hook(XMLHttpRequest.prototype, 'send', function (origSend) {
            return function send(body) {
                try {
                    const meta = xhrMeta.get(this) || {};
                    if (isInterestingUrl(meta.url)) {
                        const tag = isVideoUrl(meta.url) ? 'VIDEO' : 'XHR';
                        if (body) {
                            let payload = body;
                            if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
                                payload = `[binary ${payload.byteLength || payload.length}B]`;
                            }
                            console.log(`[Reversed-Event] ${tag} [${meta.method || 'POST'}] ${meta.url} body: ${payload}`);
                        } else {
                            console.log(`[Reversed-Event] ${tag} [${meta.method || 'GET'}] ${meta.url}`);
                        }
                    }
                } catch (e) {}
                return origSend.apply(this, arguments);
            };
        });
    }

    // React 18 scheduler uses MessagePort.postMessage(null) constantly to yield.
    // Skip empty/null/tiny numeric messages that carry no useful data.
    function isBoringMsg(msg) {
        if (msg === null || msg === undefined) return true;
        if (typeof msg === 'number' || typeof msg === 'boolean') return true;
        if (typeof msg === 'string' && msg.length < 3) return true;
        return false;
    }

    if (typeof Worker !== 'undefined' && Worker.prototype && Worker.prototype.postMessage) {
        hook(Worker.prototype, 'postMessage', function (origPost) {
            return function postMessage(msg) {
                try {
                    if (!isBoringMsg(msg)) {
                        let preview;
                        if (typeof msg === 'string') preview = msg.substring(0, 500);
                        else if (msg && msg.byteLength !== undefined) preview = `[binary ${msg.byteLength}B]`;
                        else { try { preview = JSON.stringify(msg).substring(0, 500); } catch (e) { preview = '[unserializable]'; } }
                        console.log(`[Reversed-Event] WORKER postMessage: ${preview}`);
                    }
                } catch (e) {}
                return origPost.apply(this, arguments);
            };
        });
    }

    if (typeof MessagePort !== 'undefined' && MessagePort.prototype && MessagePort.prototype.postMessage) {
        hook(MessagePort.prototype, 'postMessage', function (origPost) {
            return function postMessage(msg) {
                try {
                    if (!isBoringMsg(msg)) {
                        let preview;
                        if (typeof msg === 'string') preview = msg.substring(0, 500);
                        else if (msg && msg.byteLength !== undefined) preview = `[binary ${msg.byteLength}B]`;
                        else { try { preview = JSON.stringify(msg).substring(0, 500); } catch (e) { preview = '[unserializable]'; } }
                        console.log(`[Reversed-Event] PORT postMessage: ${preview}`);
                    }
                } catch (e) {}
                return origPost.apply(this, arguments);
            };
        });
    }

    if (typeof URL !== 'undefined' && URL.createObjectURL) {
        hook(URL, 'createObjectURL', function (origCreate) {
            return function createObjectURL(obj) {
                const url = origCreate.apply(this, arguments);
                try {
                    if (obj instanceof Blob) {
                        console.log(`[Reversed-Event] BLOB URL ${url} type=${obj.type} size=${obj.size}B`);
                        if (obj.size < 200000 && (/javascript|json|text|wasm/i.test(obj.type) || obj.type === '')) {
                            obj.text().then(txt => {
                                const snippet = txt.length > 800 ? txt.substring(0, 800) + '...' : txt;
                                console.log(`[Reversed-Event] BLOB CONTENT ${url}: ${snippet}`);
                            }).catch(() => {});
                        }
                    }
                } catch (e) {}
                return url;
            };
        });
    }

    // crypto.subtle argument capture — page-side wrapper. Complements the CDP
    // breakpoint (which pauses at the caller frame and sometimes can't see args
    // that live in a Promise microtask closure). This wrapper runs at call time
    // so it always sees the real arguments.
    // Surfaces client-generated nonces/IVs (e.g. the random AES key in the
    // RSA+AES hybrid request wrapper) so they can be matched against the
    // request/response that consumes them.
    try {
        if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
            hook(window.crypto, 'getRandomValues', function (origGetRandomValues) {
                return function getRandomValues(array) {
                    const ret = origGetRandomValues.apply(this, arguments);
                    try {
                        let hex = '';
                        const limit = Math.min(array.length, 64);
                        for (let i = 0; i < limit; i++) hex += (array[i] < 16 ? '0' : '') + array[i].toString(16);
                        console.log('[Reversed-Event] CRYPTO-ARGS getRandomValues ' + JSON.stringify([
                            { __t: array.constructor && array.constructor.name, len: array.length, hex },
                        ]));
                    } catch (e) {}
                    return ret;
                };
            });
        }
    } catch (e) {}

    try {
        const subtle = window.crypto && window.crypto.subtle;
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
                            console.log('[Reversed-Event] CRYPTO-ARGS ' + m + ' ' + line);
                        } catch (e) {}
                        return orig.apply(this, arguments);
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

    // Pure-JS crypto library hooks — for sites that use CryptoJS / JSEncrypt /
    // sjcl instead of Web Crypto. Poller runs for ~15s to catch libs loaded
    // lazily after our stealth script. Uses same stealth pattern (originalFunctions
    // map so Function.prototype.toString still returns the native source).
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
                console.log('[Reversed-Event] JSCRYPTO-ARGS ' + label + ' ' + s);
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
            var CJ = window.CryptoJS;
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
            console.log('[Reversed-Event] JSCRYPTO-ARGS init CryptoJS hooked');
        }

        function hookJSEncrypt() {
            if (jsHooked.JSEncrypt) return;
            var JE = window.JSEncrypt;
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
            console.log('[Reversed-Event] JSCRYPTO-ARGS init JSEncrypt hooked');
        }

        function hookSjcl() {
            if (jsHooked.sjcl) return;
            var S = window.sjcl;
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
            console.log('[Reversed-Event] JSCRYPTO-ARGS init sjcl hooked');
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
