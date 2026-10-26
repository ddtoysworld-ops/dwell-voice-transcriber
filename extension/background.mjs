import { config } from './config.mjs';
import { fetchMessengerAudio, isAllowedMessengerAudioUrl, probeMessengerRange } from './remote-audio.mjs';
import { createNetworkDiagnostic } from './network-diagnostic.mjs';

const SESSION_KEY = 'dwellVoiceSession';
const networkDiagnostic = config.networkDiagnostic && chrome.webRequest
  ? createNetworkDiagnostic(Date.now, chrome.runtime.id)
  : null;

if (networkDiagnostic) {
  const filter = { urls: [
    'https://business.facebook.com/*',
    'https://*.fbcdn.net/*',
    'https://*.fbsbx.com/*'
  ] };
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => networkDiagnostic.observe(details, 'start'), filter
  );
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => networkDiagnostic.observe(details, 'headers'), filter, ['responseHeaders']
  );
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => networkDiagnostic.observe(details, 'error'), filter
  );
}

function diagnosticTab(sender) {
  if (!networkDiagnostic || !sender.url?.startsWith('https://business.facebook.com/') ||
      !Number.isInteger(sender.tab?.id)) {
    throw Object.assign(new Error('只支持测试版的 Messenger 对话。'), { code: 'DIAGNOSTIC_UNAVAILABLE' });
  }
  return sender.tab.id;
}

function storageGet(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function storageRemove(key) {
  return new Promise((resolve) => chrome.storage.local.remove(key, resolve));
}

async function authRequest(path, body) {
  const response = await fetch(`${config.supabaseUrl}${path}`, {
    method: 'POST',
    headers: {
      apikey: config.publishableKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error_description || payload.msg || payload.message || '登录失败');
  return payload;
}

function sessionRecord(payload) {
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(payload.expires_in || 3600),
    user: payload.user ? { id: payload.user.id, email: payload.user.email } : null
  };
}

async function login(email, password) {
  const payload = await authRequest('/auth/v1/token?grant_type=password', { email, password });
  const session = sessionRecord(payload);
  await storageSet({ [SESSION_KEY]: session });
  return { user: session.user };
}

async function logout() {
  await storageRemove(SESSION_KEY);
  return { ok: true };
}

async function getSession() {
  const stored = await storageGet(SESSION_KEY);
  const session = stored[SESSION_KEY];
  if (!session?.access_token || !session?.refresh_token) return null;
  if (Number(session.expires_at || 0) > Math.floor(Date.now() / 1000) + 90) return session;

  try {
    const payload = await authRequest('/auth/v1/token?grant_type=refresh_token', {
      refresh_token: session.refresh_token
    });
    const refreshed = sessionRecord(payload);
    await storageSet({ [SESSION_KEY]: refreshed });
    return refreshed;
  } catch {
    await storageRemove(SESSION_KEY);
    return null;
  }
}

async function transcribeAudio(message) {
  const session = await getSession();
  if (!session) throw Object.assign(new Error('Authentication required'), { code: 'AUTH_REQUIRED' });

  if (typeof message.audioBase64 !== 'string' || !message.audioBase64 || Number(message.audioByteLength || 0) <= 0) {
    throw Object.assign(new Error('Audio is unavailable'), { code: 'AUDIO_NOT_READY' });
  }
  if (Number(message.audioByteLength) > config.maxAudioBytes) {
    throw Object.assign(new Error('Audio is too large'), { code: 'AUDIO_TOO_LARGE' });
  }

  const binary = atob(message.audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.byteLength !== Number(message.audioByteLength)) throw new Error('Audio payload is incomplete');

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: message.mimeType || 'audio/webm' }), message.fileName || 'voice-message.webm');
  form.append('translate_to_zh', 'true');

  const response = await fetch(`${config.supabaseUrl}/functions/v1/${config.functionName}`, {
    method: 'POST',
    headers: {
      apikey: config.publishableKey,
      Authorization: `Bearer ${session.access_token}`
    },
    body: form
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || payload.message || `转写服务错误 (${response.status})`);
    error.code = payload.code || (response.status === 401 ? 'AUTH_REQUIRED' : 'TRANSCRIBE_FAILED');
    throw error;
  }
  return payload;
}

async function messengerAudio(message, sender) {
  if (!sender.url?.startsWith('https://business.facebook.com/')) {
    throw Object.assign(new Error('只支持 Messenger 对话。'), { code: 'AUDIO_HOST_UNSUPPORTED' });
  }
  if (!isAllowedMessengerAudioUrl(message.sourceUrl)) {
    throw Object.assign(new Error('不支持这个语音网址。'), { code: 'AUDIO_HOST_UNSUPPORTED' });
  }
  const host = new URL(message.sourceUrl).origin;
  const granted = await chrome.permissions.contains({ origins: [`${host}/*`] });
  if (!granted) {
    throw Object.assign(new Error('Chrome 未允许插件读取这个语音域名。'), {
      code: 'AUDIO_PERMISSION_REQUIRED',
      diagnosticData: { phase: 'permission', host: new URL(message.sourceUrl).hostname, granted: false }
    });
  }
  networkDiagnostic?.startFetch(message.sourceUrl);
  let audio;
  try {
    audio = await fetchMessengerAudio(message.sourceUrl);
  } catch (error) {
    if (networkDiagnostic) {
      error.diagnosticData = {
        ...error.diagnosticData,
        extensionFetch: networkDiagnostic.finishFetch(message.sourceUrl)
      };
    }
    throw error;
  }
  networkDiagnostic?.finishFetch(message.sourceUrl);
  let binary = '';
  for (let offset = 0; offset < audio.bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...audio.bytes.subarray(offset, offset + 0x8000));
  }
  return {
    audioBase64: btoa(binary),
    audioByteLength: audio.bytes.length,
    mimeType: audio.mimeType,
    fileName: audio.fileName
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    switch (message?.type) {
      case 'VOICE_AUTH_LOGIN': return login(String(message.email || '').trim(), String(message.password || ''));
      case 'VOICE_AUTH_LOGOUT': return logout();
      case 'VOICE_AUTH_STATUS': {
        const session = await getSession();
        return { signedIn: Boolean(session), user: session?.user || null };
      }
      case 'VOICE_TRANSCRIBE': return transcribeAudio(message);
      case 'VOICE_FETCH_MESSENGER_AUDIO': return messengerAudio(message, sender);
      case 'VOICE_PROBE_MESSENGER_RANGE': {
        diagnosticTab(sender);
        return probeMessengerRange(message.sourceUrl);
      }
      case 'VOICE_START_NETWORK_DIAGNOSTIC': {
        const tabId = diagnosticTab(sender);
        networkDiagnostic.start(tabId);
        return { durationMs: 8000 };
      }
      case 'VOICE_FINISH_NETWORK_DIAGNOSTIC': {
        const tabId = diagnosticTab(sender);
        return networkDiagnostic.finish(tabId);
      }
      default: throw new Error('Unsupported request');
    }
  };

  run().then((data) => sendResponse({ ok: true, data })).catch((error) => {
    sendResponse({ ok: false, error: {
      message: error.message,
      code: error.code || 'UNKNOWN',
      diagnosticData: error.diagnosticData || null
    } });
  });
  return true;
});

