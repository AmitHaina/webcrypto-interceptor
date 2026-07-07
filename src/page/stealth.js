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
    try {
        const subtle = window.crypto && window.crypto.subtle;
        if (subtle) {
            function bytesToObj(u, name) {
                var hex = '', utf8 = '';
                var limit = Math.min(u.length, 512);
                for (var i = 0; i < limit; i++) hex += (u[i] < 16 ? '0' : '') + u[i].toString(16);
                try { utf8 = new TextDecoder('utf-8', { fatal: false }).decode(u.subarray(0, 512)); } catch (e) {}
                return { __t: name || 'Bytes', len: u.length, hex: hex, utf8: utf8 };
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
})();
