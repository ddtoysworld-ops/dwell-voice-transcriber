const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

export function isAllowedMessengerAudioUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return host === 'business.facebook.com' ||
      host === 'fbcdn.net' || host.endsWith('.fbcdn.net') ||
      host === 'fbsbx.com' || host.endsWith('.fbsbx.com');
  } catch {
    return false;
  }
}

export async function probeMessengerRange(source, fetcher = fetch) {
  if (!isAllowedMessengerAudioUrl(source)) {
    throw Object.assign(new Error('不支持这个语音网址。'), { code: 'AUDIO_HOST_UNSUPPORTED' });
  }
  const probe = async (credentials) => {
    try {
      const response = await fetcher(source, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        credentials,
        redirect: 'follow',
        signal: AbortSignal.timeout(4000)
      });
      const result = {
        status: response.status,
        finalHostAllowed: isAllowedMessengerAudioUrl(response.url),
        contentType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(
          String(response.headers.get('content-type') || '').split(';', 1)[0].trim()
        ) ? String(response.headers.get('content-type')).split(';', 1)[0].trim().toLowerCase() : ''
      };
      const range = String(response.headers.get('content-range') || '');
      const total = /^bytes \d+-\d+\/(\d+)$/.exec(range);
      if (total) result.totalBytes = Number(total[1]);
      await response.body?.cancel().catch(() => {});
      return result;
    } catch (error) {
      return { errorName: ['TypeError', 'TimeoutError', 'AbortError'].includes(error?.name) ? error.name : 'Unknown' };
    }
  };
  const [include, omit] = await Promise.all([probe('include'), probe('omit')]);
  return { include, omit };
}

function audioFormat(bytes, declaredType) {
  const header = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 16)));
  if (header.startsWith('OggS')) return { mimeType: 'audio/ogg', fileName: 'voice-message.ogg' };
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WAVE') {
    return { mimeType: 'audio/wav', fileName: 'voice-message.wav' };
  }
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    return { mimeType: 'audio/aac', fileName: 'voice-message.aac' };
  }
  if (header.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
    return { mimeType: 'audio/mpeg', fileName: 'voice-message.mp3' };
  }
  if (header.slice(4, 8) === 'ftyp') return { mimeType: 'audio/mp4', fileName: 'voice-message.m4a' };
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { mimeType: 'audio/webm', fileName: 'voice-message.webm' };
  }
  const extensions = {
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav'
  };
  if (extensions[declaredType]) {
    return { mimeType: declaredType, fileName: `voice-message.${extensions[declaredType]}` };
  }
  return null;
}

export async function fetchMessengerAudio(source, fetcher = fetch) {
  if (!isAllowedMessengerAudioUrl(source)) {
    throw Object.assign(new Error('不支持这个语音网址。'), { code: 'AUDIO_HOST_UNSUPPORTED' });
  }
  let response;
  try {
    response = await fetcher(source, {
      credentials: 'include',
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw Object.assign(new Error(timedOut ? '读取网络语音超时。' : '无法连接语音服务器。'), {
      code: timedOut ? 'AUDIO_FETCH_TIMEOUT' : 'AUDIO_FETCH_FAILED',
      diagnosticData: {
        phase: 'network-fetch',
        host: new URL(source).hostname,
        errorName: String(error?.name || 'Unknown')
      }
    });
  }
  if (!isAllowedMessengerAudioUrl(response.url)) {
    throw Object.assign(new Error('语音跳转到不支持的域名。'), { code: 'AUDIO_REDIRECT_UNSUPPORTED' });
  }
  if (!response.ok) {
    throw Object.assign(new Error('网络语音无法读取。'), { code: 'AUDIO_NOT_READY' });
  }
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_AUDIO_BYTES) {
    throw Object.assign(new Error('语音文件太大。'), { code: 'AUDIO_TOO_LARGE' });
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_AUDIO_BYTES) {
          await reader.cancel();
          throw Object.assign(new Error('语音文件太大。'), { code: 'AUDIO_TOO_LARGE' });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    const value = new Uint8Array(await response.arrayBuffer());
    size = value.byteLength;
    if (size > MAX_AUDIO_BYTES) {
      throw Object.assign(new Error('语音文件太大。'), { code: 'AUDIO_TOO_LARGE' });
    }
    chunks.push(value);
  }
  if (!size) throw Object.assign(new Error('语音文件为空。'), { code: 'AUDIO_NOT_READY' });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const declaredType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  const format = audioFormat(bytes, declaredType);
  if (!format) throw Object.assign(new Error('网址返回的不是语音。'), { code: 'INVALID_AUDIO_TYPE' });
  return { bytes, ...format };
}
