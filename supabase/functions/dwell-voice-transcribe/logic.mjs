export function isChineseLanguage(code = '') {
  const normalized = String(code).trim().toLowerCase();
  return normalized === 'zh' || normalized === 'cmn' || normalized === 'yue' || normalized.startsWith('zh-');
}

export function isClearlyChineseText(value = '') {
  const text = String(value);
  const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (text.match(/[a-z]/gi) || []).length;
  return chinese >= 4 && chinese >= latin;
}

export function outputTextFromResponse(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string' && content.text.trim()) {
        return content.text.trim();
      }
    }
  }
  return '';
}

export function publicError(status, payload = {}) {
  const apiMessage = String(payload?.error?.message || payload?.message || '');
  if (status === 429 && /credit|quota|billing/i.test(apiMessage)) {
    return { status: 402, code: 'NO_API_CREDITS', error: 'OpenAI API 暂无可用余额。' };
  }
  if (status === 413) return { status: 413, code: 'AUDIO_TOO_LARGE', error: '语音文件太大。' };
  return { status: 502, code: 'OPENAI_REQUEST_FAILED', error: '语音处理服务暂时不可用。' };
}

