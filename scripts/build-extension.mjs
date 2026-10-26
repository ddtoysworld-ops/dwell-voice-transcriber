import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

const targets = {
  staging: {
    label: "[TEST] D'WELL 语音转文字",
    supabaseUrl: 'https://tjcmjsxmlotlwetwifpb.supabase.co',
    publishableKey: 'sb_publishable_q3PeRk9wuyjqIzCEjAcZow_89tloY9d'
  },
  qa: {
    label: "[QA] D'WELL 语音转文字",
    supabaseUrl: 'https://tjcmjsxmlotlwetwifpb.supabase.co',
    publishableKey: 'sb_publishable_q3PeRk9wuyjqIzCEjAcZow_89tloY9d'
  },
  production: {
    label: "D'WELL 语音转文字",
    supabaseUrl: 'https://osgqzpdfjdnkzmyzitrm.supabase.co',
    publishableKey: 'sb_publishable_IKABC_KIjLNgTbf45AZyFw_zGCFfpI5'
  }
};

const targetName = process.argv[2];
const target = targets[targetName];
if (!target) {
  throw new Error('Usage: node scripts/build-extension.mjs <staging|qa|production>');
}

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'extension');
const sourceManifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
const outputRoot = path.resolve(root, 'output');
const destination = path.resolve(outputRoot, `${targetName}-${sourceManifest.version}`);
if (path.dirname(destination) !== outputRoot) throw new Error('Invalid output path');

await rm(destination, { recursive: true, force: true });
await mkdir(path.dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });

const manifestPath = path.join(destination, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.name = target.label;
if (targetName === 'staging') manifest.permissions.push('webRequest');
manifest.host_permissions = [
  'https://web.whatsapp.com/*',
  'https://business.facebook.com/*',
  'https://*.fbcdn.net/*',
  'https://*.fbsbx.com/*',
  `${target.supabaseUrl}/*`
];
manifest.content_security_policy.extension_pages =
  `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${target.supabaseUrl} https://cdn.fbsbx.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'`;

const config = `export const config = Object.freeze({\n` +
  `  supabaseUrl: '${target.supabaseUrl}',\n` +
  `  publishableKey: '${target.publishableKey}',\n` +
  `  functionName: 'dwell-voice-transcribe',\n` +
  `  networkDiagnostic: ${targetName === 'staging'},\n` +
  `  maxAudioBytes: 12 * 1024 * 1024\n` +
  `});\n`;

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(path.join(destination, 'config.mjs'), config);
const backgroundPath = path.join(destination, 'background.mjs');
const bundlePath = path.join(destination, 'background.bundle.mjs');
await build({
  entryPoints: [backgroundPath],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome116',
  legalComments: 'eof',
  logLevel: 'silent'
});
await rm(backgroundPath);
await rename(bundlePath, backgroundPath);
const licenseDirectory = path.join(destination, 'third-party-licenses');
await mkdir(licenseDirectory, { recursive: true });
await cp(path.join(root, 'node_modules', 'mediabunny', 'LICENSE'),
  path.join(licenseDirectory, 'mediabunny.txt'));
console.log(destination);
