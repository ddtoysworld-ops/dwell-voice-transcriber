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

export function shouldRetryLegacyTranscription(status, payload = {}) {
  return status === 400 && payload?.error?.param === 'file';
}

export function providerDiagnostic(stage, status, payload = {}, diagnosticId = '', file = null) {
  const safeToken = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value)
    ? value : null;
  const parameter = payload?.error?.param;
  const providerParam = ['file', 'model', 'response_format', 'language', 'prompt'].includes(parameter)
    ? parameter : null;
  const mime = String(file?.type || '').toLowerCase();
  const providerFileType = ['audio/aac', 'audio/flac', 'audio/m4a', 'audio/mp4', 'audio/mpeg',
    'audio/ogg', 'audio/opus', 'audio/wav', 'audio/webm'].includes(mime) ? mime : 'other';
  const extension = String(file?.name || '').split('.').pop()?.toLowerCase();
  const providerFileExtension = ['aac', 'flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga',
    'ogg', 'opus', 'wav', 'webm'].includes(extension) ? extension : 'other';
  const providerFileSizeKb = Number.isSafeInteger(file?.size) && file.size > 0
    ? Math.ceil(file.size / 1024) : null;
  return {
    event: 'voice_provider_failure',
    stage: stage === 'translation' ? 'translation' : 'transcription',
    status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 0,
    providerCode: safeToken(payload?.error?.code),
    providerType: safeToken(payload?.error?.type),
    providerParam,
    providerFileType,
    providerFileExtension,
    providerFileSizeKb,
    diagnosticId: safeToken(diagnosticId)
  };
}

