import test from 'node:test';
import assert from 'node:assert/strict';
await import('../extension/content-core.js');
const {
  base64ToBytes,
  bytesToBase64,
  diagnoseCapture,
  extensionForAudio,
  fileNameForAudio,
  isClearlyChineseText,
  isFacebookVoiceMessageLabel,
  isUsableAudioSource,
  isPausedVoicePlaybackLabel,
  isVoicePlaybackLabel,
  normalizeMimeType,
  userFacingError
} = globalThis.DwellVoiceCore;

test('normalizes MIME types and chooses stable audio extensions', () => {
  assert.equal(normalizeMimeType('audio/ogg; codecs=opus'), 'audio/ogg');
  assert.equal(extensionForAudio('audio/mpeg', ''), 'mp3');
  assert.equal(extensionForAudio('', 'https://example.test/voice.m4a?x=1'), 'm4a');
  assert.equal(fileNameForAudio('audio/webm; codecs=opus', ''), 'voice-message.webm');
});

test('accepts only fetchable audio sources', () => {
  assert.equal(isUsableAudioSource('blob:https://web.whatsapp.com/id'), true);
  assert.equal(isUsableAudioSource('https://example.test/audio.ogg'), true);
  assert.equal(isUsableAudioSource('http://127.0.0.1:8768/audio.wav'), true);
  assert.equal(isUsableAudioSource('http://example.test/audio.wav'), false);
  assert.equal(isUsableAudioSource('javascript:alert(1)'), false);
  assert.equal(isUsableAudioSource(''), false);
});

test('recognizes WhatsApp voice playback controls', () => {
  assert.equal(isVoicePlaybackLabel('Play voice message'), true);
  assert.equal(isVoicePlaybackLabel('Pause voice message'), true);
  assert.equal(isVoicePlaybackLabel('播放语音消息'), true);
  assert.equal(isVoicePlaybackLabel('暂停语音消息'), true);
  assert.equal(isPausedVoicePlaybackLabel('暂停语音消息'), true);
  assert.equal(isPausedVoicePlaybackLabel('播放语音消息'), false);
  assert.equal(isVoicePlaybackLabel('Voice message'), false);
  assert.equal(isVoicePlaybackLabel('Play video'), false);
});

test('recognizes Facebook voice message controls without confusing WhatsApp play buttons', () => {
  assert.equal(isFacebookVoiceMessageLabel('Voice Message'), true);
  assert.equal(isFacebookVoiceMessageLabel('voice message'), true);
  assert.equal(isFacebookVoiceMessageLabel('Play voice message'), false);
  assert.equal(isFacebookVoiceMessageLabel('Voice call'), false);
});

test('hides duplicate Chinese translation only for clearly Chinese transcripts', () => {
  assert.equal(isClearlyChineseText('你问我那些情况？现在我就是不敢喝。'), true);
  assert.equal(isClearlyChineseText('Hello, I have a question about my joints.'), false);
  assert.equal(isClearlyChineseText('你好 D WELL, how are you doing today?'), false);
});

test('maps service errors to concise Chinese help', () => {
  assert.match(userFacingError({ code: 'AUTH_REQUIRED' }), /登录/);
  assert.match(userFacingError({ code: 'AUDIO_NOT_READY' }), /刷新页面/);
  assert.match(userFacingError({ code: 'NO_API_CREDITS' }), /余额/);
  assert.match(userFacingError({ code: 'AUDIO_NOT_READY', diagnostic: 'M1' }), /M1/);
  assert.match(userFacingError({ code: 'AUDIO_PERMISSION_REQUIRED' }), /F1/);
  assert.match(userFacingError({ code: 'AUDIO_FETCH_FAILED' }), /F2/);
});

test('diagnoses capture stages without retaining audio or URLs', () => {
  assert.equal(diagnoseCapture({ armed: false }), 'M0');
  assert.equal(diagnoseCapture({ armed: true, clicked: true, metrics: {} }), 'M1');
  assert.equal(diagnoseCapture({ armed: true, clicked: true, metrics: { playCalls: 1 } }), 'M2');
  assert.equal(diagnoseCapture({ armed: true, clicked: true, metrics: { sourceKinds: { http: 1 } } }), 'M3');
  assert.equal(diagnoseCapture({ armed: true, clicked: true, metrics: { blobFetchFailures: 1 } }), 'M4');
});

test('round-trips binary audio through Chrome-safe Base64 messages', () => {
  const input = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
  assert.deepEqual(base64ToBytes(bytesToBase64(input)), input);
});

