// Minimal Signal-Focused Hooks for tracing, web sockets, fetch, XHR, storage and JSON
(function () {
    'use strict';

    const originalFunctions = new Map();
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

    // Defend Function.prototype.toString so hooks appear native to page inspections
    Function.prototype.toString = function toString() {
        if (originalFunctions.has(this)) {
            return backupToString.call(originalFunctions.get(this));
        }
        return backupToString.call(this);
    };
    secureObject(Function.prototype.toString, 'name', 'toString', false);

    // ============================================================
    // ANTI-ANTI-DEBUG — neutralize common `debugger;` trap patterns
    // ============================================================
    try {
        // 1. Kill `new Function('debugger')` and `Function('debugger').call()`
        const OrigFunction = window.Function;
        const FunctionProxy = new Proxy(OrigFunction, {
            construct(target, args) {
                const src = args[args.length - 1];
                if (typeof src === 'string' && /debugger/i.test(src)) {
                    return function () {}; // no-op
                }
                return Reflect.construct(target, args);
            },
            apply(target, thisArg, args) {
                const src = args[args.length - 1];
                if (typeof src === 'string' && /debugger/i.test(src)) {
                    return function () {}; // no-op
                }
                return Reflect.apply(target, thisArg, args);
            }
        });
        // Preserve Function.prototype identity
        Object.defineProperty(FunctionProxy, 'prototype', { value: OrigFunction.prototype });
        window.Function = FunctionProxy;
    } catch (e) {}

    try {
        // 2. Filter `debugger` out of setInterval/setTimeout string args
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

    try {
        // 3. Spoof timing-based devtools detection (performance.now diff checks)
        //    Many anti-debug scripts measure elapsed time around a `debugger;`
        //    statement and assume devtools is open if elapsed > threshold.
        //    We can't fully hide, but we can reduce the delta by making now()
        //    return values very close together during suspicious tight loops.
        //    (Kept minimal — enable only if needed to avoid breaking real code.)
    } catch (e) {}

    // Only log requests to interesting endpoints (skip trackers/analytics only)
    function isInterestingUrl(url) {
        if (!url) return false;
        const noise = [
            // Ad networks & analytics
            'doubleclick', 'google-analytics', 'googletagmanager', 'clarity.ms',
            'facebook.com', 'facebook.net', 'linkedin.com', 'google.com/ccm',
            'google.com/measurement', 'google.com/rmkt', 'googleadservices',
            'analytics.google', '/collect?', '/collect ', 'gtag/', 'forter.com',
            'sharethis.com', 'crwdcntrl.net', 'scorecardresearch.com', 'quantserve.com',
            'hotjar.com', 'mixpanel.com', 'segment.io', 'segment.com', 'amplitude.com',
            'sentry.io', 'bugsnag.com', 'newrelic.com', 'datadoghq.com',
            // Cloudflare telemetry & challenges (NOT /cdn-cgi/scripts which may host real code)
            '/cdn-cgi/rum', '/cdn-cgi/challenge-platform', '/cdn-cgi/beacon',
            '/cdn-cgi/trace', '/cdn-cgi/zaraz'
        ];
        const lower = url.toLowerCase();
        return !noise.some(n => lower.includes(n));
    }

    // Flag URLs that look like streaming video / DRM content
    function isVideoUrl(url) {
        if (!url) return false;
        return /\.(m3u8|mpd|ts|mp4|m4s|webm|mkv|key)(\?|$)/i.test(url)
            || /\/(hls|dash|stream|manifest|segment|video|getVideo|playlist)/i.test(url);
    }

    // Hook fetch — log outbound bodies to interesting endpoints
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

    // Hook navigator.sendBeacon
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

    // Hook WebSockets
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

    // Hook WebAssembly compile/instantiate to catch anti-bot payloads early
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

    // Hook Storage (localStorage / sessionStorage) setters to track state tokens
    if (typeof Storage !== 'undefined') {
        hook(Storage.prototype, 'setItem', function (origSetItem) {
            return function setItem(key, value) {
                try {
                    const type = this === localStorage ? 'localStorage' : 'sessionStorage';
                    const interestingKeys = /\b(token|jwt|session|uuid|device|visitor|cipher|key|pan|card|cvv|auth|pay)\b/i;
                    if (interestingKeys.test(key) || interestingKeys.test(value)) {
                        console.log(`[Reversed-Event] STORAGE [${type}] set ${key} = ${typeof value === 'string' ? value.substring(0, 500) : value}`);
                    }
                } catch (e) {}
                return origSetItem.apply(this, arguments);
            };
        });
    }

    // Hook XHR — remember open() params then log on send()
    if (typeof XMLHttpRequest !== 'undefined') {
        hook(XMLHttpRequest.prototype, 'open', function (origOpen) {
            return function open(method, url) {
                this.__url = url; this.__method = method;
                return origOpen.apply(this, arguments);
            };
        });
        hook(XMLHttpRequest.prototype, 'send', function (origSend) {
            return function send(body) {
                try {
                    if (isInterestingUrl(this.__url)) {
                        const tag = isVideoUrl(this.__url) ? 'VIDEO' : 'XHR';
                        if (body) {
                            let payload = body;
                            if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
                                payload = `[binary ${payload.byteLength || payload.length}B]`;
                            }
                            console.log(`[Reversed-Event] ${tag} [${this.__method || 'POST'}] ${this.__url} body: ${payload}`);
                        } else {
                            console.log(`[Reversed-Event] ${tag} [${this.__method || 'GET'}] ${this.__url}`);
                        }
                    }
                } catch (e) {}
                return origSend.apply(this, arguments);
            };
        });
    }
})();
