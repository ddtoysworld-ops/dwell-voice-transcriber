import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkDiagnostic } from '../extension/network-diagnostic.mjs';

test('records only bounded request metadata during an active tab watch', () => {
  let time = 1000;
  const diagnostic = createNetworkDiagnostic(() => time);
  assert.equal(diagnostic.start(7), true);
  const details = {
    tabId: 7,
    requestId: 'secret-request-id',
    url: 'https://cdn.fbsbx.com/voice.m4a?private-token=secret',
    type: 'media'
  };
  diagnostic.observe(details, 'start');
  diagnostic.observe({
    ...details,
    statusCode: 206,
    responseHeaders: [
      { name: 'Content-Type', value: 'audio/mp4; charset=binary' },
      { name: 'Set-Cookie', value: 'sensitive=value' }
    ]
  }, 'headers');
  diagnostic.observe({ ...details, tabId: 8 }, 'error');
  const result = diagnostic.finish(7);
  assert.deepEqual(result, {
    requestCount: 1,
    samples: [{ host: 'cdn.fbsbx.com', type: 'media', status: 206, contentType: 'audio/mp4' }]
  });
  assert(!JSON.stringify(result).includes('secret'));
  assert(!JSON.stringify(result).includes('sensitive'));
  assert.deepEqual(diagnostic.finish(7), { requestCount: 0, samples: [] });

  diagnostic.start(7);
  time += 12001;
  diagnostic.observe(details, 'start');
  assert.deepEqual(diagnostic.finish(7), { requestCount: 0, samples: [] });
});

test('limits samples and sanitizes browser errors', () => {
  const diagnostic = createNetworkDiagnostic();
  assert.equal(diagnostic.start(-1), false);
  diagnostic.start(3);
  for (let index = 0; index < 15; index += 1) {
    diagnostic.observe({
      tabId: 3,
      requestId: `request-${index}`,
      url: `https://scontent.xx.fbcdn.net/audio-${index}?token=private`,
      type: 'xmlhttprequest'
    }, 'start');
  }
  diagnostic.observe({
    tabId: 3,
    requestId: 'request-0',
    url: 'https://scontent.xx.fbcdn.net/audio-0?token=private',
    error: 'URL=private'
  }, 'error');
  diagnostic.observe({
    tabId: 3,
    requestId: 'later-audio',
    url: 'https://cdn.fbsbx.com/opaque?token=private',
    type: 'xmlhttprequest',
    statusCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'audio/ogg' }]
  }, 'headers');
  const result = diagnostic.finish(3);
  assert.equal(result.requestCount, 16);
  assert.equal(result.samples.length, 12);
  assert.equal(result.samples[0].contentType, 'audio/ogg');
  assert.equal(result.samples[1].error, 'NetworkError');
});

test('records only own extension fetch failure metadata without exposing signed URLs', () => {
  const diagnostic = createNetworkDiagnostic(Date.now, 'own-extension');
  const url = 'https://cdn.fbsbx.com/voice.mp4?token=private';
  diagnostic.startFetch(url);
  const request = {
    tabId: -1,
    requestId: 'private-request',
    url,
    initiator: 'chrome-extension://own-extension',
    type: 'xmlhttprequest'
  };
  diagnostic.observe({ ...request, initiator: 'chrome-extension://another-extension' }, 'start');
  diagnostic.observe(request, 'start');
  diagnostic.observe({ ...request, statusCode: 206 }, 'headers');
  diagnostic.observe({ ...request, url: 'https://scontent.xx.fbcdn.net/redirected?secret=hidden',
    error: 'net::ERR_BLOCKED_BY_ORB' }, 'error');
  const result = diagnostic.finishFetch(url);
  assert.deepEqual(result, { requestCount: 1, status: 206, error: 'net::ERR_BLOCKED_BY_ORB' });
  assert(!JSON.stringify(result).includes('private'));
  assert(!JSON.stringify(result).includes('redirected'));
  assert.deepEqual(diagnostic.finishFetch(url), { requestCount: 0 });
});
