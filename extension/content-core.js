(() => {
  const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'ogg', 'opus', 'wav', 'webm']);

  function normalizeMimeType(value = '') {
    return String(value).split(';', 1)[0].trim().toLowerCase();
  }

  function extensionForAudio(mimeType = '', source = '') {
    const mime = normalizeMimeType(mimeType);
    const subtype = mime.startsWith('audio/') ? mime.slice(6) : '';
    const aliases = { 'x-m4a': 'm4a', 'mp4': 'm4a', 'mpeg': 'mp3', 'x-wav': 'wav', 'ogg': 'ogg', 'webm': 'webm' };
    if (aliases[subtype]) return aliases[subtype];
    if (AUDIO_EXTENSIONS.has(subtype)) return subtype;

    try {
      const pathname = new URL(source, 'https://example.invalid').pathname;
      const ext = pathname.split('.').pop()?.toLowerCase();
      if (ext && AUDIO_EXTENSIONS.has(ext)) return ext;
    } catch {
      // The fallback below is suitable for most web voice notes.
    }
    return 'webm';
  }

  function fileNameForAudio(mimeType, source) {
    return `voice-message.${extensionForAudio(mimeType, source)}`;
  }

  function isUsableAudioSource(source = '') {
    const value = String(source).trim();
    return value.startsWith('blob:') ||
      value.startsWith('data:audio/') ||
      /^https:\/\//i.test(value) ||
      /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(value);
  }

  function isVoicePlaybackLabel(value = '') {
    const label = String(value).trim();
    return /^(?:play|pause) voice message$/i.test(label) ||
      /^(?:播放|暂停|暫停|继续|繼續).*(?:语音|語音)/.test(label);
  }

  function isPausedVoicePlaybackLabel(value = '') {
    const label = String(value).trim();
    return /^pause voice message$/i.test(label) ||
      /^(?:暂停|暫停).*(?:语音|語音)/.test(label);
  }

  function isFacebookVoiceMessageLabel(value = '') {
    return /^voice message$/i.test(String(value).trim());
  }

  function isClearlyChineseText(value = '') {
    const text = String(value);
    const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length;
    const latin = (text.match(/[a-z]/gi) || []).length;
    return chinese >= 4 && chinese >= latin;
  }

  function diagnoseCapture({ armed, clicked, metrics, usableAudioCount = 0 } = {}) {
    if (!armed) return 'M0';
    if (!clicked) return 'M1';
    if (usableAudioCount > 0) return 'M2';
    if (metrics?.blobFetchFailures > 0) return 'M4';
    if (metrics?.sourceKinds?.http > 0) return 'M3';
    const activity = (metrics?.playCalls || 0) + (metrics?.blobCreates || 0) +
      (metrics?.decodeCalls || 0) + (metrics?.srcSets || 0) +
      (metrics?.sourceKinds?.blob || 0);
    return activity ? 'M2' : 'M1';
  }

  function userFacingError(error) {
    const code = error && typeof error === 'object' ? error.code : '';
    if (code === 'AUTH_REQUIRED') return '请先点击插件图标并登录客服账号。';
    if (code === 'AUDIO_NOT_READY') {
      const messages = {
        M0: '插件未接入页面',
        M1: '未观察到播放器音频',
        M2: '播放器有活动，但未取得文件',
        M3: '网络音频未取得',
        M4: 'Blob 音频读取失败'
      };
      if (messages[error?.diagnostic]) return `读取失败 ${error.diagnostic}：${messages[error.diagnostic]}`;
      return '暂时无法读取这段语音，请刷新页面后再试。';
    }
    if (code === 'AUDIO_TOO_LARGE') return '这段语音太大，暂时无法处理。';
    if (code === 'AUDIO_HOST_UNSUPPORTED') return '暂不支持这个语音网址。';
    if (code === 'AUDIO_PERMISSION_REQUIRED') return '读取失败 F1：请在 Chrome 插件详情确认网站权限。';
    if (code === 'AUDIO_FETCH_FAILED') return '读取失败 F2：无法连接 Messenger 语音服务器。';
    if (code === 'AUDIO_FETCH_TIMEOUT') return '读取失败 F3：语音服务器回应超时。';
    if (code === 'AUDIO_REDIRECT_UNSUPPORTED') return '读取失败 F4：语音跳转到未授权的域名。';
    if (code === 'INVALID_AUDIO_TYPE') return '取得的文件不是语音。';
    if (code === 'AUDIO_CONVERSION_FAILED') return '这段 AAC 语音无法转换，请复制诊断联系管理员。';
    if (code === 'NO_API_CREDITS') return 'OpenAI API 暂无余额，请联系管理员充值。';
    return error?.message || '转写失败，请稍后再试。';
  }

  function bytesToBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const chunkSize = 0x8000;
    let binary = '';
    for (let offset = 0; offset < view.length; offset += chunkSize) {
      binary += String.fromCharCode(...view.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  globalThis.DwellVoiceCore = Object.freeze({
    normalizeMimeType,
    extensionForAudio,
    fileNameForAudio,
    isUsableAudioSource,
    isVoicePlaybackLabel,
    isPausedVoicePlaybackLabel,
    isFacebookVoiceMessageLabel,
    isClearlyChineseText,
    diagnoseCapture,
    userFacingError,
    bytesToBase64,
    base64ToBytes
  });
})();

