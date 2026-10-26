(() => {
  const ARM_SOURCE = 'dwell-voice-content';
  const RESULT_SOURCE = 'dwell-voice-main';
  const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
  let activeCapture = null;

  function sourceKind(source) {
    const value = String(source || '');
    if (value.startsWith('blob:')) return 'blob';
    if (/^https?:\/\//i.test(value)) return 'http';
    if (value.startsWith('data:')) return 'data';
    return 'none';
  }

  function observeSource(source) {
    if (!activeCapture) return;
    const kind = sourceKind(source);
    if (kind !== 'none') activeCapture.metrics.sourceKinds[kind] += 1;
  }

  function sniffAudio(buffer, declaredType = '') {
    const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16));
    const text = String.fromCharCode(...bytes);
    if (text.startsWith('OggS')) return { mimeType: 'audio/ogg', fileName: 'voice-message.ogg' };
    if (text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE') return { mimeType: 'audio/wav', fileName: 'voice-message.wav' };
    if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
      return { mimeType: 'audio/aac', fileName: 'voice-message.aac' };
    }
    if (text.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
      return { mimeType: 'audio/mpeg', fileName: 'voice-message.mp3' };
    }
    if (text.slice(4, 8) === 'ftyp') return { mimeType: 'audio/mp4', fileName: 'voice-message.m4a' };
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return { mimeType: 'audio/webm', fileName: 'voice-message.webm' };
    }
    const mimeType = /^audio\//i.test(declaredType) ? declaredType : 'audio/webm';
    const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('mp4') ? 'm4a' : 'webm';
    return { mimeType, fileName: `voice-message.${extension}` };
  }

  function finishCapture(buffer, declaredType = '') {
    if (!activeCapture || activeCapture.diagnosticOnly || activeCapture.done || !(buffer instanceof ArrayBuffer)) return;
    if (!buffer.byteLength || buffer.byteLength > MAX_AUDIO_BYTES) return;
    const capture = activeCapture;
    capture.done = true;
    const copy = buffer.slice(0);
    const format = sniffAudio(copy, declaredType);
    window.postMessage({
      source: RESULT_SOURCE,
      type: 'captured',
      requestId: capture.requestId,
      audioBuffer: copy,
      ...format
    }, '*', [copy]);
  }

  async function captureBlob(blob) {
    if (!activeCapture || activeCapture.diagnosticOnly || activeCapture.done || !(blob instanceof Blob)) return;
    if (!blob.size || blob.size > MAX_AUDIO_BYTES) return;
    try {
      finishCapture(await blob.arrayBuffer(), blob.type);
    } catch {
      // The isolated content script will time out and show a concise retry message.
    }
  }

  async function captureSource(source) {
    observeSource(source);
    if (activeCapture?.diagnosticOnly) return;
    if (!activeCapture || activeCapture.done || activeCapture.fetching || !String(source).startsWith('blob:')) return;
    const capture = activeCapture;
    capture.fetching = true;
    try {
      const response = await fetch(source);
      if (response.ok && activeCapture === capture) await captureBlob(await response.blob());
    } catch {
      capture.metrics.blobFetchFailures += 1;
      // Another media path may still provide the bytes before the capture expires.
    } finally {
      capture.fetching = false;
    }
  }

  function offerNetworkSource(source) {
    if (!activeCapture || activeCapture.diagnosticOnly || activeCapture.done || sourceKind(source) !== 'http') return;
    const capture = activeCapture;
    capture.networkSource = String(source);
    window.clearTimeout(capture.networkTimer);
    capture.networkTimer = window.setTimeout(() => {
      if (activeCapture !== capture || capture.done) return;
      window.postMessage({
        source: RESULT_SOURCE,
        type: 'source-url',
        requestId: capture.requestId,
        sourceUrl: capture.networkSource
      }, '*');
    }, 300);
  }

  function allowedProbeUrl(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return url.protocol === 'https:' && !url.username && !url.password &&
        (host === 'business.facebook.com' || host === 'fbcdn.net' || host.endsWith('.fbcdn.net') ||
          host === 'fbsbx.com' || host.endsWith('.fbsbx.com'));
    } catch {
      return false;
    }
  }

  async function probeNetworkSource(requestId, sourceUrl) {
    const result = { allowed: allowedProbeUrl(sourceUrl) };
    if (result.allowed) {
      try {
        const response = await fetch(sourceUrl, {
          credentials: 'include',
          redirect: 'follow',
          signal: AbortSignal.timeout(4000)
        });
        result.status = response.status;
        result.type = response.type;
        result.finalHost = new URL(response.url).hostname;
        await response.body?.cancel();
      } catch (error) {
        result.errorName = String(error?.name || 'Unknown');
      }
    }
    window.postMessage({ source: RESULT_SOURCE, type: 'network-probe', requestId, result }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== ARM_SOURCE) return;
    const requestId = String(event.data.requestId || '');
    if (!requestId) return;
    if (event.data.type === 'probe-network') {
      void probeNetworkSource(requestId, String(event.data.sourceUrl || ''));
      return;
    }
    if (event.data.type === 'disarm') {
      if (activeCapture?.requestId === requestId) {
        window.clearTimeout(activeCapture.timeoutId);
        window.clearTimeout(activeCapture.networkTimer);
        activeCapture = null;
      }
      return;
    }
    if (event.data.type === 'probe') {
      window.postMessage({
        source: RESULT_SOURCE,
        type: 'diagnostics',
        requestId,
        metrics: activeCapture?.requestId === requestId ? activeCapture.metrics : null
      }, '*');
      return;
    }
    if (event.data.type !== 'arm' && event.data.type !== 'observe') return;
    if (activeCapture) {
      window.clearTimeout(activeCapture.timeoutId);
      window.clearTimeout(activeCapture.networkTimer);
    }
    activeCapture = {
      requestId,
      diagnosticOnly: event.data.type === 'observe',
      done: false,
      fetching: false,
      metrics: {
        playCalls: 0,
        mediaPlayEvents: 0,
        audioSourceStarts: 0,
        blobCreates: 0,
        decodeCalls: 0,
        srcSets: 0,
        blobFetchFailures: 0,
        sourceKinds: { blob: 0, http: 0, data: 0 }
      },
      timeoutId: window.setTimeout(() => {
        window.clearTimeout(activeCapture?.networkTimer);
        activeCapture = null;
      }, event.data.type === 'observe' ? 13000 : Math.min(20000, Math.max(7000, Number(event.data.timeoutMs) || 7000)))
    };
    window.postMessage({ source: RESULT_SOURCE, type: 'armed', requestId }, '*');
  });

  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function createObjectURL(value) {
    const url = originalCreateObjectURL(value);
    if (activeCapture && value instanceof Blob) {
      activeCapture.metrics.blobCreates += 1;
      void captureBlob(value);
    }
    return url;
  };

  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function play(...args) {
    if (!activeCapture) return originalPlay.apply(this, args);
    activeCapture.metrics.playCalls += 1;
    void captureSource(this.currentSrc || this.src);
    if (activeCapture.diagnosticOnly) return originalPlay.apply(this, args);
    if (this instanceof HTMLAudioElement) offerNetworkSource(this.currentSrc || this.src);
    try { this.pause(); } catch { /* The media element may not have loaded yet. */ }
    return Promise.resolve();
  };

  document.addEventListener('play', (event) => {
    if (activeCapture?.diagnosticOnly && event.target instanceof HTMLMediaElement) {
      activeCapture.metrics.mediaPlayEvents += 1;
      observeSource(event.target.currentSrc || event.target.src);
    }
  }, true);

  if (globalThis.AudioBufferSourceNode?.prototype?.start) {
    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function start(...args) {
      if (activeCapture?.diagnosticOnly) activeCapture.metrics.audioSourceStarts += 1;
      return originalStart.apply(this, args);
    };
  }

  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (srcDescriptor?.get && srcDescriptor?.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      enumerable: srcDescriptor.enumerable,
      get() { return srcDescriptor.get.call(this); },
      set(value) {
        if (activeCapture) activeCapture.metrics.srcSets += 1;
        void captureSource(value);
        if (this instanceof HTMLAudioElement) offerNetworkSource(value);
        return srcDescriptor.set.call(this, value);
      }
    });
  }

  const decodeOwners = [
    globalThis.BaseAudioContext?.prototype,
    globalThis.AudioContext?.prototype,
    globalThis.webkitAudioContext?.prototype,
    globalThis.OfflineAudioContext?.prototype
  ].filter(Boolean);
  for (const prototype of new Set(decodeOwners)) {
    const originalDecode = prototype.decodeAudioData;
    if (typeof originalDecode !== 'function' || originalDecode.__dwellVoiceWrapped) continue;
    const wrappedDecode = function decodeAudioData(audioData, ...args) {
      if (activeCapture && audioData instanceof ArrayBuffer) {
        activeCapture.metrics.decodeCalls += 1;
        finishCapture(audioData);
      }
      return originalDecode.call(this, audioData, ...args);
    };
    Object.defineProperty(wrappedDecode, '__dwellVoiceWrapped', { value: true });
    prototype.decodeAudioData = wrappedDecode;
  }
})();
