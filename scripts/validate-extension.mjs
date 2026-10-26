import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const extension = resolve(root, 'extension');
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, '0.1.3');
assert(!JSON.stringify(manifest).includes('OPENAI_API_KEY'));
assert(!manifest.permissions.includes('tabs'));
assert(!manifest.permissions.includes('tabCapture'));
const connectSources = manifest.content_security_policy.extension_pages
  .split(';').map((directive) => directive.trim())
  .find((directive) => directive.startsWith('connect-src ')).split(/\s+/).slice(1);
for (const origin of [
  "'self'",
  'https://osgqzpdfjdnkzmyzitrm.supabase.co',
  'https://cdn.fbsbx.com'
]) assert(connectSources.includes(origin), `Missing connect-src origin: ${origin}`);

const files = new Set([
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...manifest.content_scripts.flatMap((entry) => [...(entry.js || []), ...(entry.css || [])])
]);

for (const file of files) await access(resolve(extension, file));

const sourceFiles = ['audio-normalize.mjs', 'background.mjs', 'config.mjs', 'content-core.js', 'content.js', 'main-bridge.js', 'network-diagnostic.mjs', 'remote-audio.mjs', 'popup.mjs'];
for (const file of sourceFiles) {
  const source = await readFile(resolve(extension, file), 'utf8');
  assert(!/sk-(?:proj-)?[A-Za-z0-9_-]{16,}/.test(source), `${file} contains a secret-looking value`);
}

console.log('Extension manifest and secret-safety checks passed.');
