import { isChineseLanguage, isClearlyChineseText, outputTextFromResponse, publicError } from './logic.mjs';

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const ALLOWED_MIME_PREFIX = 'audio/';

function corsHeaders(request: Request) {
  const origin = request.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': origin.startsWith('chrome-extension://') ? origin : 'null',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}

function json(request: Request, payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function publishableKey() {
  const dictionary = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS');
  if (dictionary) {
    try {
      return JSON.parse(dictionary).default || '';
    } catch {
      return '';
    }
  }
  return Deno.env.get('SUPABASE_ANON_KEY') || '';
}

async function authenticatedUser(request: Request) {
  const authorization = request.headers.get('authorization') || '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const key = publishableKey();
  if (!authorization.startsWith('Bearer ') || !supabaseUrl || !key) return null;

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: key }
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null);
  return user?.id ? user : null;
}

async function openAiJson(url: string, init: RequestInit) {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) });
  if (request.method !== 'POST') return json(request, { code: 'METHOD_NOT_ALLOWED', error: '只接受 POST 请求。' }, 405);

  const user = await authenticatedUser(request);
  if (!user) return json(request, { code: 'AUTH_REQUIRED', error: '请先登录客服账号。' }, 401);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(request, { code: 'INVALID_FORM', error: '无法读取上传的语音。' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return json(request, { code: 'AUDIO_REQUIRED', error: '没有收到语音文件。' }, 400);
  }
  if (file.size > MAX_AUDIO_BYTES) return json(request, { code: 'AUDIO_TOO_LARGE', error: '语音文件太大。' }, 413);
  if (file.type && !file.type.toLowerCase().startsWith(ALLOWED_MIME_PREFIX)) {
    return json(request, { code: 'INVALID_AUDIO_TYPE', error: '不支持这个语音格式。' }, 415);
  }

  const transcriptionBody = new FormData();
  transcriptionBody.append('file', file, file.name || 'voice-message.webm');
  transcriptionBody.append('model', Deno.env.get('OPENAI_TRANSCRIBE_MODEL') || 'gpt-4o-mini-transcribe');

  const transcription = await openAiJson('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    body: transcriptionBody
  });
  if (!transcription.response.ok) {
    const error = publicError(transcription.response.status, transcription.payload);
    return json(request, error, error.status);
  }

  const transcript = String(transcription.payload.text || '').trim();
  const language = String(transcription.payload.languages?.[0]?.code || transcription.payload.language || '').trim();
  if (!transcript) return json(request, { code: 'EMPTY_TRANSCRIPT', error: '没有识别到清楚的语音内容。' }, 422);

  let translationZh = '';
  const shouldTranslate = form.get('translate_to_zh') !== 'false' &&
    !isChineseLanguage(language) && !isClearlyChineseText(transcript);
  if (shouldTranslate) {
    const translation = await openAiJson('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: Deno.env.get('OPENAI_TRANSLATION_MODEL') || 'gpt-5-mini',
        instructions: 'Translate the supplied voice-message transcript into natural Simplified Chinese. Preserve names, product names, quantities and intent. Return only the translated text.',
        input: transcript
      })
    });
    if (!translation.response.ok) {
      const error = publicError(translation.response.status, translation.payload);
      return json(request, error, error.status);
    }
    translationZh = outputTextFromResponse(translation.payload);
  }

  return json(request, {
    transcript,
    language: language || null,
    translation_zh: translationZh || null,
    audio_saved: false
  });
});

