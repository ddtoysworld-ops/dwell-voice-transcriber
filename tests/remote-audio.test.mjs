import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchMessengerAudio, isAllowedMessengerAudioUrl, probeMessengerRange } from '../extension/remote-audio.mjs';

const source = 'https://scontent.xx.fbcdn.net/voice.m4a?token=synthetic';

test('restricts network audio to Meta HTTPS media hosts', () => {
  assert.equal(isAllowedMessengerAudioUrl(source), true);
  assert.equal(isAllowedMessengerAudioUrl('https://cdn.fbsbx.com/test.ogg'), true);
  assert.equal(isAllowedMessengerAudioUrl('https://business.facebook.com/media'), true);
  assert.equal(isAllowedMessengerAudioUrl('https://fbcdn.net.evil.test/test.ogg'), false);
  assert.equal(isAllowedMessengerAudioUrl('http://scontent.xx.fbcdn.net/test.ogg'), false);
  assert.equal(isAllowedMessengerAudioUrl('https://user:pass@cdn.fbsbx.com/test.ogg'), false);
});

test('probes one byte with both credential modes and returns metadata only', async () => {
  const calls = [];
  const result = await probeMessengerRange(source, async (url, options) => {
    calls.push({ url, options });
    return {
      status: 206,
      url: 'https://cdn.fbsbx.com/voice.mp4?secret=redirected',
      headers: new Headers({
        'content-type': 'video/mp4; charset=binary',
        'content-range': 'bytes 0-0/1024'
      }),
      body: { cancel: async () => {} }
    };
  });
  assert.deepEqual(calls.map(({ options }) => options.credentials).sort(), ['include', 'omit']);
  for (const { url, options } of calls) {
    assert.equal(url, source);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Range, 'bytes=0-0');
    assert.equal(options.redirect, 'follow');
  }
  assert.deepEqual(result.include, {
    status: 206, finalHostAllowed: true, contentType: 'video/mp4', totalBytes: 1024
  });
  assert.deepEqual(result.omit, result.include);
  assert(!JSON.stringify(result).includes('secret='));
  assert(!JSON.stringify(result).includes('synthetic'));
});

test('range probe reports failed fetch without leaking URL and rejects unsupported host', async () => {
  const result = await probeMessengerRange(source, async () => {
    throw new TypeError('Failed to fetch https://secret.example/voice');
  });
  assert.deepEqual(result, { include: { errorName: 'TypeError' }, omit: { errorName: 'TypeError' } });
  await assert.rejects(probeMessengerRange('https://example.test/voice.mp4'), {
    code: 'AUDIO_HOST_UNSUPPORTED'
  });
});

test('accepts a bounded synthetic audio response and follows only to allowed Meta hosts', async () => {
  const audio = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69, 1, 2, 3]);
  const result = await fetchMessengerAudio(source, async (_url, options) => {
    assert.equal(options.redirect, 'follow');
    const response = new Response(audio, { headers: { 'content-type': 'audio/wav' } });
    Object.defineProperty(response, 'url', { value: 'https://video.xx.fbcdn.net/voice.wav' });
    return response;
  });
  assert.equal(result.mimeType, 'audio/wav');
  assert.equal(result.fileName, 'voice-message.wav');
  assert.deepEqual(result.bytes, audio);
});

test('rejects redirects outside Meta and classifies failed network reads', async () => {
  await assert.rejects(fetchMessengerAudio(source, async () => ({
    ok: true,
    url: 'https://example.test/voice.wav'
  })), { code: 'AUDIO_REDIRECT_UNSUPPORTED' });
  await assert.rejects(fetchMessengerAudio(source, async () => {
    throw new TypeError('Failed to fetch');
  }), (error) => {
    assert.equal(error.code, 'AUDIO_FETCH_FAILED');
    assert.deepEqual(error.diagnosticData, {
      phase: 'network-fetch',
      host: 'scontent.xx.fbcdn.net',
      errorName: 'TypeError'
    });
    assert(!JSON.stringify(error.diagnosticData).includes('token=synthetic'));
    return true;
  });
});

test('rejects HTML and oversized audio before upload', async () => {
  const fakeFetch = (body, headers = {}) => async () => ({
    ok: true,
    url: source,
    headers: new Headers(headers),
    body: null,
    arrayBuffer: async () => body.buffer
  });
  await assert.rejects(fetchMessengerAudio(source, fakeFetch(new TextEncoder().encode('<html>'), {
    'content-type': 'text/html'
  })), { code: 'INVALID_AUDIO_TYPE' });
  await assert.rejects(fetchMessengerAudio(source, fakeFetch(new Uint8Array(0), {
    'content-length': String(12 * 1024 * 1024 + 1)
  })), { code: 'AUDIO_TOO_LARGE' });
});
