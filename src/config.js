const SUBTLE_METHODS = [
    'encrypt', 'decrypt', 'sign', 'verify', 'digest',
    'deriveBits', 'deriveKey', 'importKey', 'exportKey',
    'wrapKey', 'unwrapKey', 'generateKey'
];

const RESP_KEYWORDS = [
    '/payment', '2c2p', 'checkcard', '/pay/', '/token', '/auth/',
    '/player', 'getvideo', '/source', '/stream',
    '.m3u8', '.mpd', '.key', '/key/', 'keyformat', '/decrypt', '/license'
];

// Asset extensions to skip in response-body capture (CSS/fonts/images/media chunks are noise)
const SKIP_RESP_EXT = /\.(css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|eot|mp4|webm|ts|m4s|wasm)(\?|$)/i;
const SKIP_RESP_CT = /^(image|font|video|audio)\/|text\/css|application\/(font|octet-stream|wasm)/i;

// --hook recording caps: JSONL records kept per hooked function (memory guard
// for hot functions), plus the console print throttle (first N calls printed
// individually, then every Nth — the JSONL log stays complete up to the cap).
const HOOK_MAX_RECORDS = 5000;
const HOOK_PRINT_FIRST = 20;
const HOOK_PRINT_EVERY = 100;

module.exports = { SUBTLE_METHODS, RESP_KEYWORDS, SKIP_RESP_EXT, SKIP_RESP_CT, HOOK_MAX_RECORDS, HOOK_PRINT_FIRST, HOOK_PRINT_EVERY };
