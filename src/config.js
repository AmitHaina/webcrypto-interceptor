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

module.exports = { SUBTLE_METHODS, RESP_KEYWORDS, SKIP_RESP_EXT, SKIP_RESP_CT };
