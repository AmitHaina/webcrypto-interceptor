// Test runner entry: spawns `node --test` with explicit file paths.
// Needed because directory-form arguments differ across Node 18/20/22/24
// and shell glob expansion doesn't exist on Windows.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.test.js'))
    .map(f => path.join(__dirname, f))
    .sort();

if (!files.length) {
    console.error('No *.test.js files found in', __dirname);
    process.exit(1);
}

const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status || 0);
