import test from 'node:test';
import assert from 'node:assert/strict';
import { isChineseLanguage, isClearlyChineseText, outputTextFromResponse, providerDiagnostic, publicError, shouldRetryLegacyTranscription } from '../supabase/functions/dwell-voice-transcribe/logic.mjs';

test('recognizes Chinese language variants', () => {
  assert.equal(isChineseLanguage('zh-Hans'), true);
  assert.equal(isChineseLanguage('cmn'), true);
  assert.equal(isChineseLanguage('yue'), true);
  assert.equal(isChineseLanguage('en'), false);
});

test('recognizes clearly Chinese speech when the transcription API omits language', () => {
  assert.equal(isClearlyChineseText('我最近关节比较好，不过晚上还是有点痛。'), true);
  assert.equal(isClearlyChineseText('I feel better, but my joints still ache.'), false);
  assert.equal(isClearlyChineseText('你好 D WELL, I need help with my order.'), false);
});

test('extracts output text from Responses API payloads', () => {
  assert.equal(outputTextFromResponse({ output_text: '你好' }), '你好');
  assert.equal(outputTextFromResponse({ output: [{ content: [{ type: 'output_text', text: '翻译内容' }] }] }), '翻译内容');
  assert.equal(outputTextFromResponse({ output: [] }), '');
});

test('does not leak provider billing errors', () => {
  assert.deepEqual(publicError(429, { error: { message: 'You have no credits remaining' } }), {
    status: 402,
    code: 'NO_API_CREDITS',
    error: 'OpenAI API 暂无可用余额。'
  });
});

test('retries the legacy model only for a rejected audio file', () => {
  assert.equal(shouldRetryLegacyTranscription(400, { error: { param: 'file', code: 'unsupported_value' } }), true);
  assert.equal(shouldRetryLegacyTranscription(400, { error: { param: 'model' } }), false);
  assert.equal(shouldRetryLegacyTranscription(401, { error: { param: 'file' } }), false);
  assert.equal(shouldRetryLegacyTranscription(429, { error: { param: 'file' } }), false);
});

test('provider diagnostics retain only allowlisted metadata', () => {
  const diagnostic = providerDiagnostic('translation', 403, {
    error: {
      code: 'model_not_found',
      type: 'invalid_request_error',
      param: 'file',
      message: 'Customer transcript and private details',
      extra: { transcript: 'secret' }
    }
  }, '123e4567-e89b-12d3-a456-426614174000', {
    type: 'audio/aac', name: 'voice-message.aac', size: 1400
  });
  assert.deepEqual(diagnostic, {
    event: 'voice_provider_failure',
    stage: 'translation',
    status: 403,
    providerCode: 'model_not_found',
    providerType: 'invalid_request_error',
    providerParam: 'file',
    providerFileType: 'audio/aac',
    providerFileExtension: 'aac',
    providerFileSizeKb: 2,
    diagnosticId: '123e4567-e89b-12d3-a456-426614174000'
  });
  assert(!JSON.stringify(diagnostic).includes('Customer transcript'));
  assert.equal(providerDiagnostic('transcription', 400, { error: { code: 'unsafe value here' } }).providerCode, null);
  assert.equal(providerDiagnostic('transcription', 400, { error: { param: 'customer_private_value' } }).providerParam, null);
  const unknown = providerDiagnostic('transcription', 400, {}, '', {
    type: 'audio/unknown-private', name: 'customer-name.mp3.exe', size: 1
  });
  assert.equal(unknown.providerFileType, 'other');
  assert.equal(unknown.providerFileExtension, 'other');
  assert(!JSON.stringify(unknown).includes('customer-name'));
});

