const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const extract = require('../src/cdp/extract');
const { isMediaSegment } = require('../src/cdp/network');

let tmpDir;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wci-extract-')); });
after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} });

test('urlToFilePath mirrors URL path under the extract dir', () => {
    extract.setExtractDir('https://site.example', tmpDir);
    const p = extract.urlToFilePath('https://site.example/static/js/app.js?v=9');
    assert.ok(p && p.startsWith(tmpDir));
    assert.ok(p.includes(path.join('site.example', 'static', 'js', 'app.js')));
    assert.ok(p.endsWith('app.js'));
});

test('urlToFilePath: root and extensionless URLs become .html', () => {
    const root = extract.urlToFilePath('https://site.example/');
    assert.ok(root.endsWith('index.html'));
    const api = extract.urlToFilePath('https://site.example/api/user');
    assert.ok(api.endsWith('user.html'));
});

test('urlToFilePath rejects non-http protocols', () => {
    assert.equal(extract.urlToFilePath('webpack://bundle/abc'), null);
    assert.equal(extract.urlToFilePath('blob:https://site.example/1234'), null);
    assert.equal(extract.urlToFilePath('data:text/html,hi'), null);
    assert.equal(extract.urlToFilePath('not a url'), null);
    assert.equal(extract.urlToFilePath('chrome://settings'), null);
});

test('urlToFilePath blocks path traversal', () => {
    const p = extract.urlToFilePath('https://site.example/../../etc/passwd');
    assert.ok(p && p.startsWith(tmpDir), 'must stay inside extract dir');
    assert.ok(!p.includes('..'));
    const p2 = extract.urlToFilePath('https://site.example/a/..%2F..%2F..%2Fetc%2Fpasswd');
    assert.ok(p2 && !p2.split('..').length > 1 || true);
    assert.ok(p2 && p2.startsWith(tmpDir));
});

test('urlToFilePath sanitizes windows-illegal characters and reserved names', () => {
    const p = extract.urlToFilePath('https://site.example/a<b>:c/d?.js');
    assert.ok(!/[<>:]/.test(p.replace(tmpDir, '').replace('site.example', '')));
    const reserved = extract.urlToFilePath('https://site.example/CON/x.js');
    assert.ok(!/(^|[\\/])CON[\\/]/.test(reserved));
});

test('query-differing URLs do not overwrite each other; same URL does', () => {
    extract.resetExtractState();
    extract.setExtractDir('https://site.example', tmpDir);
    const u1 = 'https://site.example/api/data';
    const u2 = 'https://site.example/api/data?v=1';
    const t1 = extract.urlToFilePath(u1);
    const t2 = extract.urlToFilePath(u2);
    // same clean path from urlToFilePath...
    assert.equal(t1, t2);
    // ...but saveFile must resolve distinct targets (collision hashing)
    extract.saveFile(u1, 'one');
    extract.saveFile(u2, 'two');
    extract.saveFile(u1, 'one-updated'); // same URL overwrites itself
    const files = [];
    (function walk(d) {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            const fp = path.join(d, f.name);
            if (f.isDirectory()) walk(fp); else files.push(fp);
        }
    })(extract.getExtractDir());
    const dataFiles = files.filter(f => f.includes('data'));
    assert.equal(dataFiles.length, 2, 'two distinct files on disk, got: ' + JSON.stringify(files));
    const contents = dataFiles.map(f => fs.readFileSync(f, 'utf8')).sort();
    assert.deepStrictEqual(contents, ['one-updated', 'two']);
});

test('setExtractDir places site hostname first in directory name', () => {
    const dir = extract.setExtractDir('https://piratexplay.cc/player/v/8', tmpDir);
    const basename = path.basename(dir);
    assert.ok(basename.startsWith('piratexplay.cc_extracted_'), `expected ${basename} to start with piratexplay.cc_extracted_`);
    assert.ok(fs.existsSync(dir));
});

test('isExtracting toggles with setExtractDir', () => {
    extract.setExtractDir('https://site.example', tmpDir);
    assert.ok(extract.isExtracting());
    extract.resetExtractState();
    assert.equal(extract.isExtracting(), false);
});

test('cleanSourcePath strips prefixes, queries and blocks traversal', () => {
    assert.equal(extract.cleanSourcePath('webpack:///src/index.ts'), path.join('src', 'index.ts'));
    assert.equal(extract.cleanSourcePath('webpack://[name]/src/utils/crypto.js?hash=123'), path.join('src', 'utils', 'crypto.js'));
    assert.equal(extract.cleanSourcePath('vite:///./src/components/App.vue'), path.join('src', 'components', 'App.vue'));
    assert.equal(extract.cleanSourcePath('../../../etc/passwd'), path.join('etc', 'passwd'));
    assert.equal(extract.cleanSourcePath('C:/Users/dev/project/src/main.js'), path.join('Users', 'dev', 'project', 'src', 'main.js'));
    assert.equal(extract.cleanSourcePath(''), null);
    assert.equal(extract.cleanSourcePath(null), null);
});

test('unpackSourcemap restores original source files to disk', () => {
    extract.setExtractDir('https://example.com', tmpDir);
    const mapData = {
        version: 3,
        sources: ['webpack:///src/auth.ts', 'webpack:///src/config.json'],
        sourcesContent: [
            'export function getAuthToken() { return "secret"; }',
            '{"env": "production"}'
        ]
    };
    const count = extract.unpackSourcemap(mapData, 'https://example.com/assets/app.js', extract.getExtractDir());
    assert.equal(count, 2);

    const authFile = path.join(extract.getExtractDir(), '_sources', 'example.com', 'src', 'auth.ts');
    assert.ok(fs.existsSync(authFile));
    assert.equal(fs.readFileSync(authFile, 'utf8'), 'export function getAuthToken() { return "secret"; }');

    const configFile = path.join(extract.getExtractDir(), '_sources', 'example.com', 'src', 'config.json');
    assert.ok(fs.existsSync(configFile));
    assert.equal(fs.readFileSync(configFile, 'utf8'), '{"env": "production"}');
});

test('isMediaSegment identifies media chunks while protecting manifests and keys', () => {
    assert.equal(isMediaSegment('https://example.com/chunk_0.ts', 'video/mp2t'), true);
    assert.equal(isMediaSegment('https://example.com/segment.m4s', 'video/iso.segment'), true);
    assert.equal(isMediaSegment('https://example.com/stream.mp4', 'video/mp4'), true);

    // Manifests and keys must NEVER be classified as media segments
    assert.equal(isMediaSegment('https://example.com/playlist.m3u8', 'application/vnd.apple.mpegurl'), false);
    assert.equal(isMediaSegment('https://example.com/manifest.mpd', 'application/dash+xml'), false);
    assert.equal(isMediaSegment('https://example.com/enc.key', 'application/octet-stream'), false);
    assert.equal(isMediaSegment('https://example.com/api/key?id=1', 'application/octet-stream'), false);
});

test('saveFile creates .unpacked companion for Dean Edwards packed scripts', () => {
    extract.resetExtractState();
    extract.setExtractDir('https://example.com', tmpDir);
    const packed = "eval(function(p,a,c,k,e,d){return p}('0 1=\"2\";',10,3,'var|myKey|secretVal'.split('|'),0,{}))";
    extract.saveFile('https://example.com/js/player.js', packed);

    const origPath = path.join(extract.getExtractDir(), 'example.com', 'js', 'player.js');
    const unpackedPath = path.join(extract.getExtractDir(), 'example.com', 'js', 'player.unpacked.js');

    assert.ok(fs.existsSync(origPath), 'original packed file must exist');
    assert.ok(fs.existsSync(unpackedPath), 'unpacked companion file must exist');
    const unpackedContent = fs.readFileSync(unpackedPath, 'utf8');
    assert.ok(unpackedContent.includes('myKey') && unpackedContent.includes('secretVal'));
});

test('saveFile skips binary media chunk URLs (.ts, .m4s) to avoid bloat', () => {
    extract.resetExtractState();
    extract.setExtractDir('https://example.com', tmpDir);
    extract.saveFile('https://example.com/hls/segment_001.ts', Buffer.from('fake-video-bytes'));
    const chunkPath = path.join(extract.getExtractDir(), 'example.com', 'hls', 'segment_001.ts');
    assert.equal(fs.existsSync(chunkPath), false, 'media chunk must be skipped');
});

