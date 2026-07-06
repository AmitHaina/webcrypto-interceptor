const SUBTLE_METHODS = [
    'encrypt', 'decrypt', 'sign', 'verify', 'digest',
    'deriveBits', 'deriveKey', 'importKey', 'exportKey',
    'wrapKey', 'unwrapKey', 'generateKey'
];

const RESP_KEYWORDS = [
    'payment', '2c2p', 'checkcard', '/pay', '/token', '/auth',
    '/player', 'getvideo', '/source', '/manifest', '/stream',
    '.m3u8', '.mpd', '.key', '/key/', 'keyformat'
];

module.exports = { SUBTLE_METHODS, RESP_KEYWORDS };
