// ESLint flat config — pragmatic rules for a Node.js CDP tool that also
// ships browser-injected code (stealth.js uses var/arguments patterns
// deliberately for maximum scope compatibility).
export default [
    {
        ignores: ['node_modules/', 'extracted_*/', 'wasm_modules/', 'dist/', 'coverage/']
    },
    {
        // CommonJS language options apply to the tool's .js sources only —
        // scoping them here keeps this .mjs config file itself lintable as ESM.
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: {
                console: 'readonly', process: 'readonly', Buffer: 'readonly',
                __dirname: 'readonly', __filename: 'readonly', require: 'readonly',
                module: 'writable', exports: 'writable',
                window: 'readonly', navigator: 'readonly', document: 'readonly',
                fetch: 'readonly', WebSocket: 'readonly', Worker: 'readonly',
                MessagePort: 'readonly', WebAssembly: 'readonly', Storage: 'readonly',
                XMLHttpRequest: 'readonly', URL: 'readonly', Blob: 'readonly',
                FormData: 'readonly', ArrayBuffer: 'readonly', Uint8Array: 'readonly',
                CryptoKey: 'readonly', TextDecoder: 'readonly', localStorage: 'readonly',
                sessionStorage: 'readonly', WeakMap: 'readonly', Proxy: 'readonly',
                Reflect: 'readonly', Object: 'readonly', JSON: 'readonly',
                Math: 'readonly', Date: 'readonly', Promise: 'readonly', Set: 'readonly',
                Map: 'readonly', Function: 'readonly', Error: 'readonly',
                setInterval: 'readonly', clearInterval: 'readonly', setTimeout: 'readonly',
                globalThis: 'readonly', self: 'readonly'
            }
        },
        rules: {
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
            'no-undef': 'error',
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-control-regex': 'off',
            'no-prototype-builtins': 'off',
            'no-async-promise-executor': 'error',
            'require-atomic-updates': 'off',
            'no-constant-condition': ['error', { checkLoops: false }]
        }
    }
];
