import test from 'node:test';
import assert from 'node:assert/strict';
import { isChineseLanguage, isClearlyChineseText, outputTextFromResponse, publicError } from '../supabase/functions/dwell-voice-transcribe/logic.mjs';

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

