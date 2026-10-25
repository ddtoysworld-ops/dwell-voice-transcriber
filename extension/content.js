(() => {
  const {
    base64ToBytes,
    bytesToBase64,
    diagnoseCapture,
    fileNameForAudio,
    isClearlyChineseText,
    isFacebookVoiceMessageLabel,
    isUsableAudioSource,
    isVoicePlaybackLabel,
    userFacingError
  } = globalThis.DwellVoiceCore;
  const MARKER = 'data-dwell-voice-ready';
  const WHATSAPP_MESSAGE_SELECTOR = '[data-testid^="conv-msg-"], div[role="row"], div[data-id]';
  const WHATSAPP_VOICE_HINT_SELECTOR = '[data-icon="ptt-status"], [aria-label*="voice message" i], [aria-label*="voice note" i]';
  const FACEBOOK_VOICE_SELECTOR = '[aria-label="Voice Message" i]';
  const hostname = location.hostname.toLowerCase();
  const isFixturePage = hostname === '127.0.0.1' || hostname === 'localhost';
  const isWhatsAppPage = hostname === 'web.whatsapp.com' || isFixturePage;
  const isFacebookPage = hostname === 'business.facebook.com' || isFixturePage;
  const mountedPanels = new WeakMap();
  const trackedPanels = new Set();
  const recognizedAudio = new Map();
  let workQueue = Promise.resolve();
  let batchRunning = false;
  let batchButton;

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response?.ok) {
          const error = new Error(response?.error?.message || 'Request failed');
          error.code = response?.error?.code;
          error.diagnosticData = response?.error?.diagnosticData || null;
          return reject(error);
        }
        resolve(response.data);
      });
    });
  }

  function sourceFor(audio) {
    return audio.currentSrc || audio.src || audio.querySelector('source')?.src || '';
  }

  function insertionTarget(target) {
    if (!(target instanceof HTMLAudioElement)) {
      return target.querySelector('[data-testid="msg-container"]') || target;
    }

    let node = target;
    for (let depth = 0; depth < 7 && node.parentElement; depth += 1) {
      node = node.parentElement;
      const rect = node.getBoundingClientRect();
      if (rect.width >= 180 && rect.height >= 36 && node.querySelectorAll('audio').length === 1) return node;
    }
    return target.parentElement || target;
  }

  function messageSide(target) {
    const bubble = target.querySelector?.('[data-testid="msg-container"]') ||
      target.querySelector?.(WHATSAPP_VOICE_HINT_SELECTOR);
    const messageRect = target.getBoundingClientRect?.();
    const bubbleRect = bubble?.getBoundingClientRect?.();
    if (!messageRect || !bubbleRect) return 'incoming';
    return bubbleRect.left + bubbleRect.width / 2 > messageRect.left + messageRect.width / 2
      ? 'outgoing'
      : 'incoming';
  }

  function mountPanel(target, panel) {
    if (isWhatsAppPage && target.matches?.(WHATSAPP_MESSAGE_SELECTOR)) {
      const bubble = target.querySelector('[data-testid="msg-container"]');
      if (bubble?.parentElement) {
        panel.classList.add(`dwell-voice-panel--${messageSide(target)}`);
        bubble.insertAdjacentElement('afterend', panel);
        return;
      }
      panel.classList.add(`dwell-voice-panel--${messageSide(target)}`);
      target.append(panel);
      return;
    }

    if (target.querySelector?.(FACEBOOK_VOICE_SELECTOR)) {
      let column = target;
      for (let depth = 0; depth < 8 && column.parentElement; depth += 1) {
        const style = getComputedStyle(column);
        const rect = column.getBoundingClientRect();
        if (style.display === 'flex' && style.flexDirection === 'column' && rect.width >= 180 && rect.width <= 500) {
          column.append(panel);
          return;
        }
        column = column.parentElement;
      }
    }

    insertionTarget(target).insertAdjacentElement('afterend', panel);
  }

  function setStatus(panel, state, text) {
    panel.dataset.state = state;
    panel.querySelector('.dwell-voice-status').textContent = text;
  }

  function renderResult(panel, result) {
    setStatus(panel, 'done', '已完成');
    panel.dataset.collapsed = 'false';
    const body = panel.querySelector('.dwell-voice-result');
    body.hidden = false;
    panel.querySelector('.dwell-voice-toggle').setAttribute('aria-expanded', 'true');
    const original = String(result.transcript || '').trim();
    const translation = String(result.translation_zh || '').trim();
    body.replaceChildren();

    const makeBlock = (label, text, lang) => {
      const block = document.createElement('section');
      block.className = 'dwell-voice-text-block';
      const header = document.createElement('div');
      header.className = 'dwell-voice-text-header';
      const title = document.createElement('span');
      title.textContent = label;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'dwell-voice-copy';
      copy.textContent = '复制';
      copy.addEventListener('click', async () => {
        await navigator.clipboard.writeText(text);
        copy.textContent = '已复制';
        window.setTimeout(() => { copy.textContent = '复制'; }, 1200);
      });
      const paragraph = document.createElement('p');
      paragraph.lang = lang;
      paragraph.textContent = text;
      header.append(title, copy);
      block.append(header, paragraph);
      return block;
    };

    body.append(makeBlock(result.language ? `原文 · ${result.language}` : '原文', original, result.language || ''));
    if (translation && translation !== original && !isClearlyChineseText(original)) {
      body.append(makeBlock('中文翻译', translation, 'zh-Hans'));
    }
  }

  function sourceAudioFor(target) {
    if (target instanceof HTMLAudioElement) return target;

    const nested = target.querySelector('audio');
    if (nested && isUsableAudioSource(sourceFor(nested))) return nested;
    if (target.querySelector?.(FACEBOOK_VOICE_SELECTOR)) return null;

    const slider = target.querySelector('[role="slider"][aria-label="Voice note progress slider"]');
    const playback = whatsappTransportFor(target);
    const isCurrentMessage = Number(slider?.getAttribute('aria-valuenow') || 0) > 0 ||
      isVoicePlaybackLabel(playback?.getAttribute('aria-label')) && /^pause/i.test(playback.getAttribute('aria-label'));

    const ready = Array.from(document.querySelectorAll('audio')).filter((audio) =>
      isUsableAudioSource(sourceFor(audio))
    );
    if (isCurrentMessage) return ready.length === 1 ? ready[0] : null;

    return null;
  }

  function playbackControlFor(target) {
    const whatsapp = isWhatsAppPage ? whatsappTransportFor(target) : null;
    return whatsapp || target.querySelector?.(FACEBOOK_VOICE_SELECTOR) || null;
  }

  function pressPlayback(control) {
    const options = { bubbles: true, cancelable: true, composed: true };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const EventType = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      control.dispatchEvent(new EventType(type, options));
    }
    control.click();
  }

  function whatsappTransportFor(target) {
    const buttons = Array.from(target.querySelectorAll?.('button') || [])
      .filter((button) => !button.closest('.dwell-voice-panel'));
    const slider = target.querySelector?.('[role="slider"]');
    if (slider) {
      const before = buttons.filter((button) =>
        button.compareDocumentPosition(slider) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (before.length) return before[before.length - 1];
    }
    return buttons.find((button) => isVoicePlaybackLabel(button.getAttribute('aria-label')) ||
      /download voice/i.test(button.getAttribute('aria-label') || '')) || null;
  }

  function usableAudios() {
    return Array.from(document.querySelectorAll('audio')).filter((audio) =>
      isUsableAudioSource(sourceFor(audio))
    );
  }

  function preparedAudioFor(target, before) {
    const nested = target.querySelector?.('audio');
    if (nested && isUsableAudioSource(sourceFor(nested))) return nested;
    if (target.querySelector?.(FACEBOOK_VOICE_SELECTOR)) return null;

    const ready = usableAudios();
    const added = ready.filter((audio) => !before.has(audio));
    if (added.length === 1) return added[0];
    const active = ready.filter((audio) => !audio.paused || Number(audio.currentTime || 0) > 0);
    return active.length === 1 ? active[0] : null;
  }

  function probePageNetwork(sourceUrl) {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const timeoutId = window.setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve({ errorName: 'ProbeTimeout' });
      }, 4700);
      function onMessage(event) {
        const data = event.data;
        if (event.source !== window || data?.source !== 'dwell-voice-main' ||
            data.type !== 'network-probe' || data.requestId !== requestId) return;
        window.clearTimeout(timeoutId);
        window.removeEventListener('message', onMessage);
        resolve(data.result || { errorName: 'EmptyProbe' });
      }
      window.addEventListener('message', onMessage);
      window.postMessage({ source: 'dwell-voice-content', type: 'probe-network', requestId, sourceUrl }, '*');
    });
  }

  async function fetchMessengerSource(sourceUrl) {
    try {
      return await runtimeMessage({ type: 'VOICE_FETCH_MESSENGER_AUDIO', sourceUrl });
    } catch (error) {
      if (error?.code === 'AUDIO_FETCH_FAILED' &&
          chrome.runtime.getManifest().name.startsWith('[TEST]')) {
        const [pageProbe, rangeProbe] = await Promise.all([
          probePageNetwork(sourceUrl),
          runtimeMessage({ type: 'VOICE_PROBE_MESSENGER_RANGE', sourceUrl })
            .catch((probeError) => ({ errorName: String(probeError?.name || 'Unknown') }))
        ]);
        error.diagnosticData = {
          ...error.diagnosticData,
          pageProbe,
          rangeProbe
        };
      }
      throw error;
    }
  }

  function startBridgeCapture(diagnosticOnly = false) {
    const requestId = crypto.randomUUID();
    let resultResolve;
    let resultReject;
    let armedResolve;
    const result = new Promise((resolve, reject) => {
      resultResolve = resolve;
      resultReject = reject;
    });
    const armed = new Promise((resolve) => { armedResolve = resolve; });
    const timeoutId = window.setTimeout(() => {
      cleanup();
      if (!diagnosticOnly) {
        resultReject(Object.assign(new Error('Audio source is not ready'), { code: 'AUDIO_NOT_READY' }));
      }
    }, diagnosticOnly ? 13000 : 6500);

    function onMessage(event) {
      const data = event.data;
      if (event.source !== window || data?.source !== 'dwell-voice-main' || data.requestId !== requestId) return;
      if (data.type === 'armed') {
        armedResolve();
        return;
      }
      if (data.type === 'source-url' && typeof data.sourceUrl === 'string') {
        cleanup();
        resultResolve({ sourceUrl: data.sourceUrl });
        return;
      }
      if (data.type !== 'captured' || !(data.audioBuffer instanceof ArrayBuffer)) return;
      cleanup();
      resultResolve({
        audioBuffer: data.audioBuffer,
        mimeType: String(data.mimeType || 'audio/webm'),
        fileName: String(data.fileName || 'voice-message.webm')
      });
    }

    function cleanup() {
      window.clearTimeout(timeoutId);
      window.removeEventListener('message', onMessage);
    }

    function cancel() {
      cleanup();
      window.postMessage({ source: 'dwell-voice-content', type: 'disarm', requestId }, '*');
    }

    function probe() {
      return new Promise((resolve) => {
        const probeTimeout = window.setTimeout(() => {
          window.removeEventListener('message', onDiagnostics);
          resolve(null);
        }, 400);
        function onDiagnostics(event) {
          const data = event.data;
          if (event.source !== window || data?.source !== 'dwell-voice-main' ||
              data.type !== 'diagnostics' || data.requestId !== requestId) return;
          window.clearTimeout(probeTimeout);
          window.removeEventListener('message', onDiagnostics);
          resolve(data.metrics || null);
        }
        window.addEventListener('message', onDiagnostics);
        window.postMessage({ source: 'dwell-voice-content', type: 'probe', requestId }, '*');
      });
    }

    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'dwell-voice-content', type: diagnosticOnly ? 'observe' : 'arm', requestId }, '*');
    return { armed, result, cancel, probe };
  }

  async function waitForPreparedAudio(target, before) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const audio = preparedAudioFor(target, before);
      if (audio) return audio;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    return null;
  }

  async function prepareAudio(target) {
    const existing = sourceAudioFor(target);
    if (existing) return { audio: existing, restore: () => {} };

    const playback = playbackControlFor(target);
    if (!playback) throw Object.assign(new Error('Audio source is not ready'), { code: 'AUDIO_NOT_READY' });

    const controlInfo = isFacebookPage ? {
      phase: 'player',
      controlsInGroup: target.querySelectorAll?.(FACEBOOK_VOICE_SELECTOR).length || 0,
      targetTag: target.tagName,
      controlTag: playback.tagName,
      controlRole: playback.getAttribute('role') || '',
      controlVisible: playback.getBoundingClientRect().width > 0 && playback.getBoundingClientRect().height > 0,
      candidates: Array.from(target.querySelectorAll?.(FACEBOOK_VOICE_SELECTOR) || []).slice(0, 4)
        .map((candidate, index) => ({
          index,
          selected: candidate === playback,
          tag: candidate.tagName,
          role: candidate.getAttribute('role') || '',
          width: Math.round(candidate.getBoundingClientRect().width),
          height: Math.round(candidate.getBoundingClientRect().height),
          nestedInteractive: candidate.querySelectorAll('button, a, [role="button"]').length
        }))
    } : null;

    const before = new Set(document.querySelectorAll('audio'));
    const bridge = startBridgeCapture();
    let prepared;
    let clicked = false;
    let armed = false;
    try {
      await Promise.race([
        bridge.armed,
        new Promise((_, reject) => window.setTimeout(() =>
          reject(Object.assign(new Error('Page hook is not active'), { code: 'AUDIO_NOT_READY' })), 800))
      ]);
      armed = true;
      pressPlayback(playback);
      clicked = true;
      prepared = await Promise.race([
        waitForPreparedAudio(target, before).then((audio) => audio
          ? { kind: 'element', audio }
          : new Promise(() => {})),
        bridge.result.then((capture) => ({ kind: capture.sourceUrl ? 'url' : 'buffer', ...capture }))
      ]);
    } catch (error) {
      if (isFacebookPage && error?.code === 'AUDIO_NOT_READY') {
        const metrics = await bridge.probe();
        error.diagnostic = diagnoseCapture({
          armed,
          clicked,
          metrics,
          usableAudioCount: usableAudios().filter((audio) => !before.has(audio)).length
        });
        error.diagnosticData = {
          ...controlInfo,
          armed,
          clicked,
          playCalls: metrics?.playCalls || 0,
          srcSets: metrics?.srcSets || 0,
          blobCreates: metrics?.blobCreates || 0,
          decodeCalls: metrics?.decodeCalls || 0,
          sourceKinds: metrics?.sourceKinds || { blob: 0, http: 0, data: 0 }
        };
      }
      throw error;
    } finally {
      if (clicked && prepared) await new Promise((resolve) => window.setTimeout(resolve, 1200));
      bridge.cancel();
    }
    if (!prepared) throw Object.assign(new Error('Audio source is not ready'), { code: 'AUDIO_NOT_READY' });

    if (prepared.kind === 'buffer') {
      const label = playback.getAttribute('aria-label');
      if (/^pause voice message$/i.test(label || '')) playback.click();
      return {
        blob: new Blob([prepared.audioBuffer], { type: prepared.mimeType }),
        fileName: prepared.fileName,
        restore: () => {}
      };
    }

    if (prepared.kind === 'url') {
      return { sourceUrl: prepared.sourceUrl, restore: () => {} };
    }

    const { audio } = prepared;
    const previousMuted = audio.muted;
    audio.muted = true;
    const label = playback.getAttribute('aria-label');
    if (/^pause voice message$/i.test(label || '')) playback.click();
    else audio.pause();
    return {
      audio,
      restore: () => { audio.muted = previousMuted; }
    };
  }

  async function readAudio(target) {
    const prepared = await prepareAudio(target);
    try {
      const { audio } = prepared;
      let blob = prepared.blob;
      let source = prepared.sourceUrl || '';
      if (source && isFacebookPage) {
        return fetchMessengerSource(source);
      }
      if (!blob) {
        source = sourceFor(audio);
        if (!isUsableAudioSource(source)) {
          throw Object.assign(new Error('Audio source is not ready'), { code: 'AUDIO_NOT_READY' });
        }
        if (isFacebookPage && /^https:\/\//i.test(source)) {
          return fetchMessengerSource(source);
        }
        const response = await fetch(source, { credentials: 'include' });
        if (!response.ok) throw new Error(`无法读取语音 (${response.status})`);
        blob = await response.blob();
      }
      if (!blob.size) throw Object.assign(new Error('Audio is empty'), { code: 'AUDIO_NOT_READY' });
      return {
        audioBase64: bytesToBase64(await blob.arrayBuffer()),
        audioByteLength: blob.size,
        mimeType: blob.type || audio.getAttribute('type') || 'audio/webm',
        fileName: prepared.fileName || fileNameForAudio(blob.type || audio?.getAttribute('type'), source)
      };
    } finally {
      prepared.restore();
    }
  }

  function visibleVoiceEntries() {
    for (const entry of trackedPanels) {
      if (!entry.target.isConnected || !entry.panel.isConnected) trackedPanels.delete(entry);
    }
    return [...trackedPanels].filter(({ target }) => target.checkVisibility())
      .sort((left, right) => left.target.compareDocumentPosition(right.target) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  }

  function updateBatchButton() {
    const entries = visibleVoiceEntries();
    const pending = entries.filter(({ panel }) => panel.dataset.state !== 'done').length;
    if (!batchButton) return;
    const latest = entries.at(-1)?.panel;
    if (!latest) {
      batchButton.remove();
      return;
    }
    latest.querySelector('.dwell-voice-toolbar').append(batchButton);
    if (!batchRunning) batchButton.textContent = `批量转写 ${pending} 条`;
    batchButton.disabled = batchRunning || pending === 0;
  }

  async function audioFingerprint(payload) {
    const bytes = base64ToBytes(payload.audioBase64);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function uniqueAudioFor(target) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const payload = await readAudio(target);
      if (!target.querySelector?.(FACEBOOK_VOICE_SELECTOR)) return payload;
      const fingerprint = await audioFingerprint(payload);
      const owner = recognizedAudio.get(fingerprint);
      if (!owner || !owner.isConnected || owner === target) {
        recognizedAudio.set(fingerprint, target);
        return payload;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
    throw Object.assign(new Error('这段语音与另一条重复，无法确认对应关系；请刷新页面后重试。'), {
      code: 'AUDIO_ASSOCIATION_UNCERTAIN'
    });
  }

  function enqueue(task) {
    const job = workQueue.then(task, task);
    workQueue = job.catch(() => {});
    return job;
  }

  async function transcribeEntry({ target, panel }) {
    const button = panel.querySelector('.dwell-voice-transcribe');
    const resultBody = panel.querySelector('.dwell-voice-result');
    const toggle = panel.querySelector('.dwell-voice-toggle');
    button.disabled = true;
    resultBody.replaceChildren();
    resultBody.hidden = true;
    panel.dataset.collapsed = 'false';
    toggle.setAttribute('aria-expanded', 'false');
    setStatus(panel, 'loading', '正在读取语音…');
    panel.dwellVoiceDiagnostic = null;
    try {
      const audioPayload = await uniqueAudioFor(target);
      if (isFacebookPage && chrome.runtime.getManifest().name.startsWith('[TEST]')) {
        setStatus(panel, 'error', '已取得音频；诊断版未上传');
        panel.dwellVoiceDiagnostic = JSON.stringify({
          code: 'AUDIO_READY', phase: 'ready', mimeType: audioPayload.mimeType,
          audioByteLength: audioPayload.audioByteLength
        });
        return;
      }
      setStatus(panel, 'loading', '正在转成文字…');
      const result = await runtimeMessage({ type: 'VOICE_TRANSCRIBE', ...audioPayload });
      renderResult(panel, result);
    } catch (error) {
      setStatus(panel, 'error', userFacingError(error));
      panel.dwellVoiceDiagnostic = JSON.stringify({
        code: error?.code || 'UNKNOWN', detail: error?.diagnostic || null,
        ...(error?.diagnosticData || {})
      });
    } finally {
      button.disabled = false;
      updateBatchButton();
    }
  }

  batchButton = document.createElement('button');
  batchButton.type = 'button';
  batchButton.className = 'dwell-voice-batch';
  batchButton.title = '依次转写当前对话中已加载、尚未完成的语音';
  batchButton.addEventListener('click', () => {
    if (batchRunning) return;
    batchRunning = true;
    const entries = visibleVoiceEntries().filter(({ panel }) => panel.dataset.state !== 'done');
    void enqueue(async () => {
      try {
        for (let index = 0; index < entries.length; index += 1) {
          if (!entries[index].target.isConnected || !entries[index].panel.isConnected) break;
          batchButton.textContent = `转写中 ${index + 1}/${entries.length}`;
          await transcribeEntry(entries[index]);
        }
      } finally {
        batchRunning = false;
        updateBatchButton();
      }
    });
    updateBatchButton();
  });

  function attach(target) {
    if (mountedPanels.get(target)?.isConnected) return;
    target.setAttribute(MARKER, 'true');

    const panel = document.createElement('div');
    panel.className = 'dwell-voice-panel';
    panel.dataset.state = 'idle';
    const toolbar = document.createElement('div');
    toolbar.className = 'dwell-voice-toolbar';
    const transcribe = document.createElement('button');
    transcribe.type = 'button';
    transcribe.className = 'dwell-voice-transcribe';
    transcribe.textContent = '转成文字';
    const status = document.createElement('span');
    status.className = 'dwell-voice-status';
    status.setAttribute('aria-live', 'polite');
    const copyDiagnostic = document.createElement('button');
    copyDiagnostic.type = 'button';
    copyDiagnostic.className = 'dwell-voice-diagnostic';
    copyDiagnostic.textContent = '复制诊断';
    copyDiagnostic.title = '仅复制错误阶段和播放器状态，不包含语音或顾客资料';
    const observe = document.createElement('button');
    observe.type = 'button';
    observe.className = 'dwell-voice-observe';
    observe.textContent = '验证读取';
    observe.title = '测试 Messenger 媒体请求；不会读取或上传语音内容';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'dwell-voice-toggle';
    toggle.setAttribute('aria-label', '收起文字');
    toggle.setAttribute('title', '收起文字');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.textContent = '⌃';
    const resultBody = document.createElement('div');
    resultBody.className = 'dwell-voice-result';
    resultBody.hidden = true;
    toolbar.append(transcribe, status, copyDiagnostic, toggle);
    if (isFacebookPage && chrome.runtime.getManifest().name.startsWith('[TEST]')) {
      toolbar.append(observe);
    }
    panel.append(toolbar, resultBody);
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'dblclick']) {
      panel.addEventListener(type, (event) => event.stopPropagation());
    }

    transcribe.addEventListener('click', () => {
      if (transcribe.disabled || batchRunning) return;
      transcribe.disabled = true;
      void enqueue(() => transcribeEntry({ target, panel }));
    });

    copyDiagnostic.addEventListener('click', async () => {
      if (!panel.dwellVoiceDiagnostic) return;
      await navigator.clipboard.writeText(panel.dwellVoiceDiagnostic);
      copyDiagnostic.textContent = '已复制';
      window.setTimeout(() => { copyDiagnostic.textContent = '复制诊断'; }, 1200);
    });

    observe.addEventListener('click', async () => {
      observe.disabled = true;
      transcribe.disabled = true;
      panel.dwellVoiceDiagnostic = null;
      setStatus(panel, 'loading', '正在准备验证…');
      let bridge;
      const clicks = { trusted: 0, inGroup: 0, controlIndices: [] };
      const controls = Array.from(target.querySelectorAll?.(FACEBOOK_VOICE_SELECTOR) || []);
      const onClick = (event) => {
        if (!event.isTrusted) return;
        clicks.trusted += 1;
        if (!target.contains(event.target)) return;
        clicks.inGroup += 1;
        const control = event.target.closest?.(FACEBOOK_VOICE_SELECTOR);
        const index = controls.indexOf(control);
        if (index >= 0 && clicks.controlIndices.length < 4) clicks.controlIndices.push(index);
      };
      try {
        bridge = startBridgeCapture(true);
        await Promise.race([
          bridge.armed,
          new Promise((_, reject) => window.setTimeout(() => reject(new Error('Page hook is not active')), 800))
        ]);
        const { durationMs } = await runtimeMessage({ type: 'VOICE_START_NETWORK_DIAGNOSTIC' });
        const audioElementsBefore = document.querySelectorAll('audio').length;
        document.addEventListener('click', onClick, true);
        setStatus(panel, 'loading', '现在点上方原播放键；不用播完');
        await new Promise((resolve) => window.setTimeout(resolve, isFixturePage ? 900 : durationMs));
        const [network, player] = await Promise.all([
          runtimeMessage({ type: 'VOICE_FINISH_NETWORK_DIAGNOSTIC' }),
          bridge.probe()
        ]);
        panel.dwellVoiceDiagnostic = JSON.stringify({
          code: 'MEDIA_PATH_CHECK', network, player, clicks,
          audioElementsBefore,
          audioElementsAfter: document.querySelectorAll('audio').length
        });
        setStatus(panel, 'diagnostic', '验证完成，可复制结果');
      } catch (error) {
        panel.dwellVoiceDiagnostic = JSON.stringify({ code: 'DIAGNOSTIC_FAILED', errorName: String(error?.name || 'Unknown') });
        setStatus(panel, 'diagnostic', '验证未完成，可复制结果');
      } finally {
        document.removeEventListener('click', onClick, true);
        bridge?.cancel();
        observe.disabled = false;
        transcribe.disabled = false;
      }
    });

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      resultBody.hidden = expanded;
      panel.dataset.collapsed = String(expanded);
      toggle.setAttribute('aria-expanded', String(!expanded));
      toggle.setAttribute('aria-label', expanded ? '展开文字' : '收起文字');
      toggle.setAttribute('title', expanded ? '展开文字' : '收起文字');
      toggle.textContent = expanded ? '⌄' : '⌃';
    });

    mountPanel(target, panel);
    mountedPanels.set(target, panel);
    trackedPanels.add({ target, panel });
    updateBatchButton();
  }

  function isWhatsAppVoiceMessage(element) {
    if (!element.matches?.(WHATSAPP_MESSAGE_SELECTOR)) return false;
    return Boolean(element.querySelector(WHATSAPP_VOICE_HINT_SELECTOR) && whatsappTransportFor(element));
  }

  function facebookVoiceGroup(element) {
    if (!isFacebookVoiceMessageLabel(element?.getAttribute?.('aria-label'))) return null;

    let node = element;
    for (let depth = 0; depth < 4 && node.parentElement; depth += 1) {
      node = node.parentElement;
      if (node.querySelectorAll(FACEBOOK_VOICE_SELECTOR).length >= 2) return node;
    }
    return element.parentElement || element;
  }

  function scan(root = document) {
    if (isFixturePage && root instanceof HTMLAudioElement && root.closest('.message')) attach(root);
    if (isWhatsAppPage && isWhatsAppVoiceMessage(root)) attach(root);

    if (isWhatsAppPage) {
      root.querySelectorAll?.(WHATSAPP_VOICE_HINT_SELECTOR).forEach((hint) => {
        const message = hint.closest('div[role="row"]') ||
          hint.closest('[data-testid^="conv-msg-"]') || hint.closest('div[data-id]');
        if (message && isWhatsAppVoiceMessage(message)) attach(message);
      });
    }

    const facebookGroups = new Set();
    if (isFacebookPage) {
      if (root.matches?.(FACEBOOK_VOICE_SELECTOR)) facebookGroups.add(facebookVoiceGroup(root));
      root.querySelectorAll?.(FACEBOOK_VOICE_SELECTOR).forEach((control) => {
        facebookGroups.add(facebookVoiceGroup(control));
      });
      facebookGroups.forEach((group) => {
        if (group) attach(group);
      });
    }

    root.querySelectorAll?.('audio').forEach((audio) => {
      const message = audio.closest(WHATSAPP_MESSAGE_SELECTOR);
      if (isWhatsAppPage && message && isWhatsAppVoiceMessage(message)) attach(message);
      else if (isFixturePage && audio.closest('.message')) attach(audio);
    });
  }

  scan();
  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    window.requestAnimationFrame(() => {
      scanScheduled = false;
      scan();
    });
  }
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.removedNodes.length && record.target instanceof Element &&
          record.target.closest(WHATSAPP_MESSAGE_SELECTOR)) scheduleScan();
      for (const node of record.addedNodes) {
        if (node instanceof Element) scan(node);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();

