// Shared browser resolution logic across capture_server.js and verify-reimpl.js
const fs = require('fs');
const path = require('path');

function resolveBrowserPath(preferBrave) {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

    if (preferBrave) {
        if (process.platform === 'win32') {
            const candidates = [
                'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
                'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
                process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
            ].filter(Boolean);
            for (const p of candidates) {
                if (fs.existsSync(p)) return p;
            }
            return null;
        }
        if (process.platform === 'darwin') {
            const p = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
            if (fs.existsSync(p)) return p;
            return null;
        }
        // Linux
        for (const p of ['/usr/bin/brave-browser', '/snap/bin/brave', '/usr/bin/brave', '/usr/bin/brave-browser-stable']) {
            if (fs.existsSync(p)) return p;
        }
        return null;
    }

    if (process.platform === 'win32') {
        const candidates = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
        ].filter(Boolean);
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
        return null;
    }
    if (process.platform === 'darwin') {
        const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        if (fs.existsSync(p)) return p;
        return null;
    }
    // Linux: try common names before falling back to puppeteer's bundled build
    for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']) {
        if (fs.existsSync(p)) return p;
    }
    return null; // no system chrome -> let puppeteer use its bundled one
}

module.exports = { resolveBrowserPath };
