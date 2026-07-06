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
        hook(Storage.prototype, 'setItem', function (origSetItem) {
            return function setItem(key, value) {
                try {
                    const type = this === localStorage ? 'localStorage' : 'sessionStorage';
                    const interestingKeys = /(token|jwt|session|uuid|device|visitor|cipher|key|pan|card|cvv|auth|pay|bearer|secret|refresh)/i;
                    if (interestingKeys.test(key) || interestingKeys.test(value)) {
                        console.log(`[Reversed-Event] STORAGE [${type}] set ${key} = ${typeof value === 'string' ? value.substring(0, 500) : value}`);
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

    if (typeof Worker !== 'undefined' && Worker.prototype && Worker.prototype.postMessage) {
        hook(Worker.prototype, 'postMessage', function (origPost) {
            return function postMessage(msg) {
                try {
                    let preview;
                    if (typeof msg === 'string') preview = msg.substring(0, 500);
                    else if (msg && msg.byteLength !== undefined) preview = `[binary ${msg.byteLength}B]`;
                    else { try { preview = JSON.stringify(msg).substring(0, 500); } catch (e) { preview = '[unserializable]'; } }
                    console.log(`[Reversed-Event] WORKER postMessage: ${preview}`);
                } catch (e) {}
                return origPost.apply(this, arguments);
            };
        });
    }

    if (typeof MessagePort !== 'undefined' && MessagePort.prototype && MessagePort.prototype.postMessage) {
        hook(MessagePort.prototype, 'postMessage', function (origPost) {
            return function postMessage(msg) {
                try {
                    let preview;
                    if (typeof msg === 'string') preview = msg.substring(0, 500);
                    else if (msg && msg.byteLength !== undefined) preview = `[binary ${msg.byteLength}B]`;
                    else { try { preview = JSON.stringify(msg).substring(0, 500); } catch (e) { preview = '[unserializable]'; } }
                    console.log(`[Reversed-Event] PORT postMessage: ${preview}`);
                } catch (e) {}
                return origPost.apply(this, arguments);
            };
        });
    }

    if (typeof URL !== 'undefined' && URL.createObjectURL) {
        const origCreate = URL.createObjectURL;
        URL.createObjectURL = function createObjectURL(obj) {
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
        secureObject(URL.createObjectURL, 'name', 'createObjectURL', false);
    }
})();
