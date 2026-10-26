import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAdtsAac, normalizeAdtsAudio } from '../extension/audio-normalize.mjs';

const fixture = new URL('./fixtures/synthetic-tone.aac', import.meta.url);

test('remuxes synthetic ADTS AAC into supported M4A without customer media', async () => {
  const bytes = new Uint8Array(await readFile(fixture));
  assert.equal(isAdtsAac(bytes), true);
  const normalized = await normalizeAdtsAudio(bytes);
  assert.equal(normalized.mimeType, 'audio/mp4');
  assert.equal(normalized.fileName, 'voice-message.m4a');
  assert.equal(String.fromCharCode(...normalized.bytes.subarray(4, 8)), 'ftyp');
  assert(normalized.bytes.byteLength > 1000);
});

test('leaves other formats alone and fails closed on invalid or oversized AAC', async () => {
  assert.equal(isAdtsAac(new Uint8Array([0xff, 0xfb, 0x90, 0x64])), false);
  assert.equal(await normalizeAdtsAudio(new Uint8Array([0x49, 0x44, 0x33])), null);
  const bytes = new Uint8Array(await readFile(fixture));
  await assert.rejects(normalizeAdtsAudio(bytes, 100), { code: 'AUDIO_CONVERSION_FAILED' });
  await assert.rejects(normalizeAdtsAudio(new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0, 0, 0])), {
    code: 'AUDIO_CONVERSION_FAILED'
  });
});
