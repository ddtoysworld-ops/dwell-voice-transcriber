import test from 'node:test';
import assert from 'node:assert/strict';

let handler;
globalThis.Deno = {
  env: { get(name) {
    return {
      SUPABASE_URL: 'https://synthetic.supabase.co',
      SUPABASE_ANON_KEY: 'synthetic-publishable-key',
      OPENAI_API_KEY: 'synthetic-openai-key',
      OPENAI_TRANSCRIBE_MODEL: 'gpt-4o-mini-transcribe'
    }[name] || '';
  } },
  serve(callback) { handler = callback; }
};
await import('../supabase/functions/dwell-voice-transcribe/index.ts');

const originalFetch = globalThis.fetch;

async function invoke(fileName = 'voice-message.wav') {
  const body = new FormData();
  body.append('file', new File([new Uint8Array([82, 73, 70, 70, 1, 2, 3])], fileName,
    { type: fileName.endsWith('.ogg') ? 'audio/ogg' : 'audio/wav' }));
  body.append('translate_to_zh', 'true');
  const response = await handler(new Request('https://synthetic.supabase.co/functions/v1/dwell-voice-transcribe', {
    method: 'POST', headers: { authorization: 'Bearer synthetic-user-token' }, body
  }));
  return { status: response.status, payload: await response.json() };
}

test('uses gpt-transcribe and keeps the Chinese response shape', async () => {
  const models = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'synthetic-user' });
    assert(url.endsWith('/audio/transcriptions'));
    models.push(options.body.get('model'));
    assert.equal(options.body.get('response_format'), 'json');
    return Response.json({ text: '这是合成测试语音内容。', languages: [{ code: 'cmn' }] });
  };
  try {
    const result = await invoke();
    assert.equal(result.status, 200);
    assert.deepEqual(models, ['gpt-transcribe']);
    assert.equal(result.payload.transcription_model, 'gpt-transcribe');
    assert.equal(result.payload.translation_zh, null);
    assert.equal(result.payload.audio_saved, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retries an unsupported OGG file once with the existing model', async () => {
  const models = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'synthetic-user' });
    if (url.endsWith('/audio/transcriptions')) {
      assert.equal(options.body.get('file').name, 'voice-message.ogg');
      models.push(options.body.get('model'));
      return models.length === 1
        ? Response.json({ error: { code: 'unsupported_value', param: 'file' } }, { status: 400 })
        : Response.json({ text: '这是合成测试语音内容。' });
    }
    throw new Error('Unexpected request');
  };
  try {
    const result = await invoke('voice-message.ogg');
    assert.equal(result.status, 200);
    assert.deepEqual(models, ['gpt-transcribe', 'gpt-4o-mini-transcribe']);
    assert.equal(result.payload.transcription_model, 'gpt-4o-mini-transcribe');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not retry model errors or bypass authentication', async () => {
  const models = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'synthetic-user' });
    models.push(options.body.get('model'));
    return Response.json({ error: { code: 'model_not_found', param: 'model' } }, { status: 400 });
  };
  try {
    const failed = await invoke();
    assert.equal(failed.status, 502);
    assert.deepEqual(models, ['gpt-transcribe']);
    assert.equal(failed.payload.code, 'OPENAI_REQUEST_FAILED');
    const unauthenticated = await handler(new Request('https://synthetic.supabase.co/functions/v1/dwell-voice-transcribe', {
      method: 'POST'
    }));
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(models, ['gpt-transcribe']);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('stops after one compatibility retry if both models reject the file', async () => {
  const models = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'synthetic-user' });
    models.push(options.body.get('model'));
    return Response.json({ error: { code: 'unsupported_value', param: 'file' } }, { status: 400 });
  };
  try {
    const failed = await invoke('voice-message.ogg');
    assert.equal(failed.status, 502);
    assert.deepEqual(models, ['gpt-transcribe', 'gpt-4o-mini-transcribe']);
    assert.equal(failed.payload.code, 'OPENAI_REQUEST_FAILED');
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('keeps English-to-Chinese translation after the model switch', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'synthetic-user' });
    requests.push(url);
    if (url.endsWith('/audio/transcriptions')) return Response.json({
      text: 'Please confirm the delivery address.', languages: [{ code: 'en' }]
    });
    return Response.json({ output_text: '请确认收货地址。' });
  };
  try {
    const result = await invoke();
    assert.equal(result.status, 200);
    assert.equal(result.payload.translation_zh, '请确认收货地址。');
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
