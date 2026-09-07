// build-test-extension.js — produce .test-build/: the extension with matches
// pointed at the local mock site and consent/enabled pre-set (test-only).
// The production manifest is never touched.

import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);                 // package/dsh-webcode-bridge
const repo = dirname(dirname(pkg));        // repo root
const extSrc = join(repo, 'extension');
const out = join(here, '.test-build');
const MOCK = 'http://127.0.0.1:8932';
const BRIDGE_PORT = process.argv[2] || '8931';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(extSrc, out, { recursive: true });

// manifest: swap matches to the mock site
const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
for (const cs of manifest.content_scripts) cs.matches = [MOCK + '/*'];
manifest.name = 'webcode bridge (TEST)';
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

// service worker: auto-consent + mock site roots + isolated bridge port
const swPath = join(out, 'background', 'service_worker.js');
let sw = readFileSync(swPath, 'utf8');
sw = sw.replace("const SITE_ROOT = 'https://chat.deepseek.com/';", `const SITE_ROOT = '${MOCK}/';`);
sw = sw.replace("const SITE_MATCH = 'https://chat.deepseek.com/*';", `const SITE_MATCH = '${MOCK}/*';`);
sw = sw.replace("bridgeUrl: 'ws://127.0.0.1:8931/bridge',", `bridgeUrl: 'ws://127.0.0.1:${BRIDGE_PORT}/bridge',`);
sw = sw.replace('enabled: false,', 'enabled: true,').replace('consentAccepted: false,', 'consentAccepted: true,');
writeFileSync(swPath, sw);

console.log('[m2] test extension built at', out, '(bridge port', BRIDGE_PORT + ')');
