import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const packageUrl = new URL(`../output/staging-${version}/`, import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', packageUrl), 'utf8'));
assert(manifest.name.startsWith('[TEST]'));
assert(manifest.permissions.includes('webRequest'));
assert(manifest.host_permissions.some((host) => host.includes('tjcmjsxmlotlwetwifpb')));
assert(!manifest.host_permissions.some((host) => host.includes('osgqzpdfjdnkzmyzitrm')));
const connectSources = manifest.content_security_policy.extension_pages
  .split(';').map((directive) => directive.trim())
  .find((directive) => directive.startsWith('connect-src ')).split(/\s+/).slice(1);
for (const origin of [
  "'self'",
  'https://tjcmjsxmlotlwetwifpb.supabase.co',
  'https://cdn.fbsbx.com'
]) assert(connectSources.includes(origin), `Missing connect-src origin: ${origin}`);
assert(!connectSources.some((origin) => origin.includes('osgqzpdfjdnkzmyzitrm')));

const listeners = {};
const filters = {};
let runtimeListener;
globalThis.chrome = {
  webRequest: Object.fromEntries(['onBeforeRequest', 'onHeadersReceived', 'onErrorOccurred'].map((name) => [
    name, { addListener(listener, filter) { listeners[name] = listener; filters[name] = filter; } }
  ])),
  permissions: { async contains() { return true; } },
  runtime: { id: 'synthetic-extension', onMessage: { addListener(listener) { runtimeListener = listener; } } }
};
await import(new URL('background.mjs', packageUrl));
assert.equal(Object.keys(listeners).length, 3);
assert(filters.onHeadersReceived.urls.includes('https://business.facebook.com/*'));

function message(type, sender = { url: 'https://business.facebook.com/inbox', tab: { id: 7 } }, extra = {}) {
  return new Promise((resolve) => {
    assert.equal(runtimeListener({ type, ...extra }, sender, resolve), true);
  });
}

assert.equal((await message('VOICE_START_NETWORK_DIAGNOSTIC')).ok, true);
const request = {
  tabId: 7,
  requestId: 'private-id',
  url: 'https://cdn.fbsbx.com/voice?private-token=secret',
  type: 'media'
};
listeners.onBeforeRequest(request);
listeners.onHeadersReceived({
  ...request,
  statusCode: 206,
  responseHeaders: [{ name: 'Content-Type', value: 'audio/mp4' }]
});
const result = await message('VOICE_FINISH_NETWORK_DIAGNOSTIC');
assert.equal(result.ok, true);
assert.deepEqual(result.data, {
  requestCount: 1,
  samples: [{ host: 'cdn.fbsbx.com', type: 'media', status: 206, contentType: 'audio/mp4' }]
});
assert(!JSON.stringify(result).includes('secret'));
assert.equal((await message('VOICE_START_NETWORK_DIAGNOSTIC', {
  url: 'https://web.whatsapp.com/', tab: { id: 7 }
})).error.code, 'DIAGNOSTIC_UNAVAILABLE');
const sourceUrl = 'https://cdn.fbsbx.com/audio.mp4?private-token=secret';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  const details = {
    tabId: -1, requestId: 'extension-request', url: sourceUrl,
    initiator: 'chrome-extension://synthetic-extension', type: 'xmlhttprequest'
  };
  listeners.onBeforeRequest(details);
  listeners.onErrorOccurred({ ...details, error: 'net::ERR_FAILED' });
  throw new TypeError('Failed to fetch');
};
try {
  const failed = await message('VOICE_FETCH_MESSENGER_AUDIO', undefined, { sourceUrl });
  assert.equal(failed.error.code, 'AUDIO_FETCH_FAILED');
  assert.deepEqual(failed.error.diagnosticData.extensionFetch, {
    requestCount: 1, error: 'net::ERR_FAILED'
  });
  assert(!JSON.stringify(failed).includes('private-token'));
} finally {
  globalThis.fetch = originalFetch;
}
const qaUrl = new URL(`../output/qa-${version}/`, import.meta.url);
const qaManifest = JSON.parse(await readFile(new URL('manifest.json', qaUrl), 'utf8'));
const qaConfig = await readFile(new URL('config.mjs', qaUrl), 'utf8');
assert(qaManifest.name.startsWith('[QA]'));
assert(!qaManifest.permissions.includes('webRequest'));
assert(!qaManifest.permissions.includes('debugger'));
assert(qaManifest.host_permissions.some((host) => host.includes('tjcmjsxmlotlwetwifpb')));
assert(!qaManifest.host_permissions.some((host) => host.includes('osgqzpdfjdnkzmyzitrm')));
assert(qaConfig.includes('networkDiagnostic: false'));
assert(qaManifest.content_security_policy.extension_pages.includes('https://cdn.fbsbx.com'));
const productionUrl = new URL(`../output/production-${version}/`, import.meta.url);
const productionManifest = JSON.parse(await readFile(new URL('manifest.json', productionUrl), 'utf8'));
const productionConfig = await readFile(new URL('config.mjs', productionUrl), 'utf8');
assert.equal(productionManifest.version, version);
assert.equal(productionManifest.name, "D'WELL 语音转文字");
assert(productionManifest.host_permissions.some((host) => host.includes('osgqzpdfjdnkzmyzitrm')));
assert(!productionManifest.host_permissions.some((host) => host.includes('tjcmjsxmlotlwetwifpb')));
assert(productionConfig.includes('networkDiagnostic: false'));
assert(!/sk-(?:proj-)?[A-Za-z0-9_-]{16,}/.test(productionConfig));
console.log('Staging, QA and production package checks passed.');
