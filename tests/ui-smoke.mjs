import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/junwe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const outputDir = new URL('../tmp/ui-smoke/', import.meta.url);
const projectDir = fileURLToPath(new URL('../', import.meta.url));
await mkdir(outputDir, { recursive: true });

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wav': 'audio/wav'
};
const server = createServer(async (request, response) => {
  try {
    const relativePath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '');
    const filePath = normalize(join(projectDir, relativePath));
    if (!filePath.startsWith(normalize(projectDir))) throw new Error('Invalid path');
    const body = await readFile(filePath);
    response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const popupPage = await browser.newPage({ viewport: { width: 340, height: 480 } });
  popupPage.setDefaultTimeout(10000);
  await popupPage.addInitScript(() => {
    globalThis.chrome = {
      runtime: {
        lastError: null,
        getManifest() { return { name: "D'WELL Voice Transcriber" }; },
        sendMessage(_message, callback) {
          callback({ ok: true, data: { signedIn: false, user: null } });
        }
      }
    };
  });
  await popupPage.goto(`${baseUrl}/extension/popup.html`);
  await popupPage.waitForSelector('#login-form');
  assert.equal(await popupPage.locator('body').evaluate((body) => body.scrollWidth <= document.documentElement.clientWidth), true);
  await popupPage.screenshot({ path: fileURLToPath(new URL('popup.png', outputDir)) });
  console.log('Popup layout passed.');

  const chatPage = await browser.newPage({ viewport: { width: 420, height: 720 } });
  chatPage.setDefaultTimeout(10000);
  await chatPage.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
  const pageErrors = [];
  chatPage.on('pageerror', (error) => pageErrors.push(error.message));
  await chatPage.addInitScript(() => {
    globalThis.chrome = {
      runtime: {
        lastError: null,
        getManifest() { return { name: "D'WELL Voice Transcriber" }; },
        sendMessage(message, callback) {
          if (message.type === 'VOICE_PROBE_MESSENGER_RANGE') {
            callback({ ok: true, data: {
              include: { status: 206, finalHostAllowed: true, contentType: 'video/mp4', totalBytes: 1024 },
              omit: { errorName: 'TypeError' }
            } });
            return;
          }
          if (message.type === 'VOICE_FETCH_MESSENGER_AUDIO') {
            globalThis.networkRequests = (globalThis.networkRequests || 0) + 1;
            globalThis.networkSource = message.sourceUrl;
            if (globalThis.networkFailure) {
              callback({ ok: false, error: {
                code: 'AUDIO_FETCH_FAILED',
                message: 'Network fetch failed',
                diagnosticData: { phase: 'network-fetch', host: 'scontent.xx.fbcdn.net', errorName: 'TypeError' }
              } });
              return;
            }
            callback({ ok: true, data: {
              audioBase64: btoa('RIFF\0\0\0\0WAVE123'),
              audioByteLength: 15,
              mimeType: 'audio/wav',
              fileName: 'voice-message.wav'
            } });
            return;
          }
          globalThis.voiceRequests = (globalThis.voiceRequests || 0) + 1;
          globalThis.lastVoicePayload = message;
          callback({
            ok: true,
            data: globalThis.voiceRequests === 2 ? {
              transcript: '我最近的关节已经好多了。',
              language: null,
              translation_zh: '我的关节最近改善了很多。'
            } : {
              transcript: 'Hello, this is a D WELL voice transcription test.',
              language: 'en',
              translation_zh: '你好，这是 D\u2019WELL 语音转文字测试。'
            }
          });
        }
      }
    };
  });
  await chatPage.goto(`${baseUrl}/tests/fixtures/chat.html`);
  await chatPage.evaluate(async () => {
    const source = `self.onmessage = async (event) => {
      try {
        const blob = await fetch(event.data).then((response) => response.blob());
        self.postMessage({ url: URL.createObjectURL(blob) });
      } catch (error) {
        self.postMessage({ error: String(error) });
      }
    };`;
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    window.detachedVoiceWorker = worker;
    window.detachedVoiceUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Synthetic worker timed out')), 5000);
      worker.onmessage = (event) => {
        clearTimeout(timeout);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.url);
      };
      worker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message)); };
      worker.postMessage(`${location.origin}/tests/fixtures/synthetic-test.wav`);
    });
  });
  assert.equal(await chatPage.locator('.dwell-voice-panel').count(), 6);
  await chatPage.locator('.dwell-voice-transcribe').first().click();
  await chatPage.waitForTimeout(750);
  const panelState = await chatPage.locator('.dwell-voice-panel').first().getAttribute('data-state');
  const panelStatus = await chatPage.locator('.dwell-voice-status').first().innerText();
  assert.equal(panelState, 'done', `Transcript panel state=${panelState}, status=${panelStatus}, errors=${pageErrors.join(' | ')}`);
  assert.equal(await chatPage.getByText('中文翻译').isVisible(), true);
  await chatPage.locator('.dwell-voice-toggle').first().click();
  assert.equal(await chatPage.locator('.dwell-voice-result').first().isVisible(), false);
  await chatPage.locator('.dwell-voice-toggle').first().click();
  assert.equal(await chatPage.locator('.dwell-voice-result').first().isVisible(), true);
  assert.equal(await chatPage.evaluate(() => window.voiceRequests), 1);
  await chatPage.locator('.dwell-voice-transcribe').nth(1).click();
  await chatPage.waitForTimeout(1600);
  assert.equal(await chatPage.locator('.dwell-voice-panel').nth(1).getAttribute('data-state'), 'done');
  assert.equal(await chatPage.locator('.dwell-voice-panel').nth(1).locator('.dwell-voice-text-block').count(), 1);
  assert.equal(await chatPage.locator('.dwell-voice-panel').count(), 6);
  await chatPage.locator('.dwell-voice-transcribe').nth(2).click();
  await chatPage.waitForTimeout(1600);
  assert.equal(await chatPage.locator('.dwell-voice-panel').nth(2).getAttribute('data-state'), 'done');
  assert.equal(await chatPage.evaluate(() => window.detachedVoice.paused), true);
  assert.equal(await chatPage.evaluate(() => window.lastVoicePayload.audioByteLength > 0), true);
  assert.equal(await chatPage.locator('.dwell-voice-panel').count(), 6);
  await chatPage.locator('.dwell-voice-transcribe').nth(3).click();
  await chatPage.waitForTimeout(1600);
  assert.equal(await chatPage.locator('.dwell-voice-panel').nth(3).getAttribute('data-state'), 'done');
  await chatPage.locator('.dwell-voice-transcribe').nth(4).click();
  await chatPage.waitForTimeout(1600);
  assert.equal(await chatPage.locator('.dwell-voice-panel').nth(4).getAttribute('data-state'), 'done');
  assert.match(await chatPage.evaluate(() => window.networkSource), /^https:\/\/scontent\.xx\.fbcdn\.net\//);
  assert.equal(await chatPage.evaluate(() => window.networkRequests), 1);
  const requestsBeforeDiagnosticMode = await chatPage.evaluate(() => window.voiceRequests);
  await chatPage.evaluate(() => {
    chrome.runtime.getManifest = () => ({ name: "[TEST] D'WELL Voice Transcriber" });
  });
  await chatPage.locator('.dwell-voice-transcribe').nth(4).click();
  await chatPage.waitForTimeout(1600);
  assert.match(await chatPage.locator('.dwell-voice-panel').nth(4).locator('.dwell-voice-status').innerText(), /未上传/);
  assert.equal(await chatPage.evaluate(() => window.voiceRequests), requestsBeforeDiagnosticMode);
  const requestsBeforeFailure = await chatPage.evaluate(() => window.voiceRequests);
  await chatPage.locator('.dwell-voice-transcribe').last().click();
  await chatPage.waitForTimeout(7400);
  assert.equal(await chatPage.locator('.dwell-voice-panel').last().getAttribute('data-state'), 'error');
  assert.match(await chatPage.locator('.dwell-voice-status').last().innerText(), /M1/);
  assert.equal(await chatPage.locator('.dwell-voice-panel').last().locator('.dwell-voice-diagnostic').isVisible(), true);
  const diagnostic = await chatPage.locator('.dwell-voice-panel').last().evaluate((panel) =>
    JSON.parse(panel.dwellVoiceDiagnostic)
  );
  assert.equal(diagnostic.code, 'AUDIO_NOT_READY');
  assert.equal(diagnostic.detail, 'M1');
  assert.equal(diagnostic.candidates.length, 2);
  assert.equal(diagnostic.candidates.filter((candidate) => candidate.selected).length, 1);
  assert.equal(JSON.stringify(diagnostic).includes('http'), true);
  await chatPage.locator('.dwell-voice-panel').last().locator('.dwell-voice-diagnostic').click();
  const copiedDiagnostic = await chatPage.evaluate(() => navigator.clipboard.readText());
  assert.deepEqual(JSON.parse(copiedDiagnostic), diagnostic);
  assert(!copiedDiagnostic.includes('synthetic-test.wav'));
  assert.equal(await chatPage.evaluate(() => window.voiceRequests), requestsBeforeFailure);

  await chatPage.route('https://scontent.xx.fbcdn.net/**', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': baseUrl,
        'access-control-allow-credentials': 'true',
        'content-type': 'audio/wav'
      },
      body: 'RIFF\0\0\0\0WAVE123'
    });
  });
  await chatPage.evaluate(() => { window.networkFailure = true; });
  await chatPage.locator('.dwell-voice-transcribe').nth(4).click();
  await chatPage.waitForTimeout(1700);
  const fetchDiagnostic = await chatPage.locator('.dwell-voice-panel').nth(4).evaluate((panel) =>
    JSON.parse(panel.dwellVoiceDiagnostic)
  );
  assert.equal(fetchDiagnostic.code, 'AUDIO_FETCH_FAILED');
  assert.equal(fetchDiagnostic.pageProbe.status, 200);
  assert.equal(fetchDiagnostic.pageProbe.finalHost, 'scontent.xx.fbcdn.net');
  assert.equal(fetchDiagnostic.rangeProbe.include.status, 206);
  assert.equal(fetchDiagnostic.rangeProbe.omit.errorName, 'TypeError');
  assert(!JSON.stringify(fetchDiagnostic).includes('synthetic-voice.m4a'));
  assert.equal(await chatPage.evaluate(() => window.voiceRequests), requestsBeforeFailure);
  assert.equal(await chatPage.locator('body').evaluate((body) => body.scrollWidth <= document.documentElement.clientWidth), true);
  await chatPage.screenshot({ path: fileURLToPath(new URL('chat-transcript.png', outputDir)), fullPage: true });
  console.log('Transcript layout passed.');

  const adjacentPage = await browser.newPage({ viewport: { width: 420, height: 720 } });
  adjacentPage.setDefaultTimeout(10000);
  await adjacentPage.addInitScript(() => {
    globalThis.chrome = {
      runtime: {
        lastError: null,
        getManifest() { return { name: "[QA] D'WELL Voice Transcriber" }; },
        sendMessage(message, callback) {
          if (message.type === 'VOICE_FETCH_MESSENGER_AUDIO') {
            window.audioSources = [...(window.audioSources || []), message.sourceUrl];
            if (window.failNextAudio) {
              window.failNextAudio = false;
              callback({ ok: false, error: { code: 'AUDIO_FETCH_FAILED', message: 'Synthetic read failure' } });
              return;
            }
            const audioBytes = `RIFF\0\0\0\0WAVE${message.sourceUrl.includes('/upper.') ? 'UPPER' : 'LOWER'}`;
            callback({ ok: true, data: {
              audioBase64: btoa(audioBytes),
              audioByteLength: audioBytes.length,
              mimeType: 'audio/wav',
              fileName: 'voice-message.wav'
            } });
            return;
          }
          if (message.type === 'VOICE_TRANSCRIBE') {
            window.transcribeRequests = (window.transcribeRequests || 0) + 1;
            const source = window.audioSources?.at(-1) || '';
            callback({ ok: true, data: {
              transcript: source.includes('/upper.') ? 'Upper voice only' : 'Lower voice only',
              language: 'en',
              translation_zh: source.includes('/upper.') ? '只有上面的语音' : '只有下面的语音'
            } });
            return;
          }
          callback({ ok: false, error: { code: 'UNEXPECTED' } });
        }
      }
    };
  });
  await adjacentPage.goto(`${baseUrl}/tests/fixtures/adjacent-facebook.html`);
  assert.equal(await adjacentPage.locator('.dwell-voice-panel').count(), 2);
  await adjacentPage.locator('.dwell-voice-transcribe').nth(1).click();
  await adjacentPage.locator('.dwell-voice-panel').nth(1).locator('.dwell-voice-status')
    .getByText('已完成').waitFor();
  assert.match(await adjacentPage.locator('.dwell-voice-panel').nth(1).innerText(), /Lower voice only/);
  await adjacentPage.evaluate(() => {
    const staleAudio = document.createElement('audio');
    staleAudio.src = `${location.origin}/tests/fixtures/synthetic-test.wav`;
    Object.defineProperty(staleAudio, 'currentTime', { get: () => 1 });
    document.body.append(staleAudio);
    window.staleAudio = staleAudio;
  });
  assert(await adjacentPage.evaluate(() => window.staleAudio.currentTime > 0));
  await adjacentPage.evaluate(() => { window.staleFirstUpper = true; });
  await adjacentPage.locator('.dwell-voice-transcribe').first().click();
  await adjacentPage.locator('.dwell-voice-panel').first().locator('.dwell-voice-status')
    .getByText('已完成').waitFor();
  assert.match(await adjacentPage.locator('.dwell-voice-panel').first().innerText(), /Upper voice only/);
  assert.deepEqual(await adjacentPage.evaluate(() => window.audioSources), [
    'https://cdn.fbsbx.com/lower.m4a',
    'https://cdn.fbsbx.com/lower.m4a',
    'https://cdn.fbsbx.com/upper.m4a'
  ]);
  assert.equal(await adjacentPage.evaluate(() => window.transcribeRequests), 2);
  await adjacentPage.evaluate(() => { window.failNextAudio = true; });
  await adjacentPage.locator('.dwell-voice-transcribe').first().click();
  await adjacentPage.locator('.dwell-voice-panel').first().locator('.dwell-voice-status')
    .getByText(/读取失败/).waitFor();
  assert.equal(await adjacentPage.locator('.dwell-voice-panel').first()
    .locator('.dwell-voice-text-block').count(), 0);
  await adjacentPage.reload();
  await adjacentPage.locator('.dwell-voice-transcribe').nth(1).click();
  await adjacentPage.locator('.dwell-voice-panel').nth(1).locator('.dwell-voice-status')
    .getByText('已完成').waitFor();
  await adjacentPage.evaluate(() => { window.alwaysStaleUpper = true; });
  await adjacentPage.locator('.dwell-voice-transcribe').first().click();
  await adjacentPage.locator('.dwell-voice-panel').first().locator('.dwell-voice-status')
    .getByText(/无法确认对应关系/).waitFor();
  assert.equal(await adjacentPage.evaluate(() => window.transcribeRequests), 1);
  assert.equal(await adjacentPage.locator('.dwell-voice-panel').first()
    .locator('.dwell-voice-text-block').count(), 0);
  await adjacentPage.reload();
  assert.equal(await adjacentPage.locator('.dwell-voice-batch').count(), 1);
  assert.match(await adjacentPage.locator('.dwell-voice-batch').innerText(), /2 条/);
  await adjacentPage.locator('.dwell-voice-batch').click();
  await adjacentPage.locator('.dwell-voice-panel').first().locator('.dwell-voice-status')
    .getByText('已完成').waitFor();
  await adjacentPage.locator('.dwell-voice-panel').nth(1).locator('.dwell-voice-status')
    .getByText('已完成').waitFor();
  assert.match(await adjacentPage.locator('.dwell-voice-panel').first().innerText(), /Upper voice only/);
  assert.match(await adjacentPage.locator('.dwell-voice-panel').nth(1).innerText(), /Lower voice only/);
  assert.equal(await adjacentPage.evaluate(() => window.transcribeRequests), 2);
  assert.equal(await adjacentPage.locator('.dwell-voice-batch').isDisabled(), true);
  await adjacentPage.screenshot({ path: fileURLToPath(new URL('adjacent-batch.png', outputDir)), fullPage: true });
  assert.equal(await adjacentPage.locator('body').evaluate((body) =>
    body.scrollWidth <= document.documentElement.clientWidth), true);
  console.log('Adjacent Messenger voice association passed.');

  const whatsappBatchPage = await browser.newPage({ viewport: { width: 360, height: 640 } });
  whatsappBatchPage.setDefaultTimeout(10000);
  await whatsappBatchPage.addInitScript(() => {
    globalThis.chrome = {
      runtime: {
        lastError: null,
        getManifest() { return { name: "[QA] D'WELL Voice Transcriber" }; },
        sendMessage(message, callback) {
          if (message.type !== 'VOICE_TRANSCRIBE') {
            callback({ ok: false, error: { code: 'UNEXPECTED' } });
            return;
          }
          window.whatsappTranscriptions = (window.whatsappTranscriptions || 0) + 1;
          callback({ ok: true, data: {
            transcript: `Voice ${window.whatsappTranscriptions}`,
            language: 'en',
            translation_zh: `语音 ${window.whatsappTranscriptions}`
          } });
        }
      }
    };
  });
  await whatsappBatchPage.goto(`${baseUrl}/tests/fixtures/whatsapp-batch.html`);
  assert.equal(await whatsappBatchPage.locator('.dwell-voice-panel').count(), 2);
  await whatsappBatchPage.locator('.dwell-voice-batch').click();
  await whatsappBatchPage.locator('.dwell-voice-panel').nth(1).locator('.dwell-voice-status')
    .getByText('已完成').waitFor();
  assert.equal(await whatsappBatchPage.evaluate(() => window.whatsappTranscriptions), 2);
  assert.match(await whatsappBatchPage.locator('.dwell-voice-panel').first().innerText(), /Voice 1/);
  assert.match(await whatsappBatchPage.locator('.dwell-voice-panel').nth(1).innerText(), /Voice 2/);
  assert.equal(await whatsappBatchPage.locator('body').evaluate((body) =>
    body.scrollWidth <= document.documentElement.clientWidth), true);
  console.log('WhatsApp batch transcription passed.');

  const diagnosticPage = await browser.newPage({ viewport: { width: 420, height: 720 } });
  diagnosticPage.setDefaultTimeout(10000);
  await diagnosticPage.addInitScript(() => {
    window.mediaMessages = [];
    window.addEventListener('message', (event) => {
      if (event.data?.source === 'dwell-voice-main' &&
          ['captured', 'source-url'].includes(event.data.type)) window.mediaMessages.push(event.data.type);
    });
    globalThis.chrome = {
      runtime: {
        lastError: null,
        getManifest() { return { name: "[TEST] D'WELL Voice Transcriber" }; },
        sendMessage(message, callback) {
          if (message.type === 'VOICE_START_NETWORK_DIAGNOSTIC') {
            window.setTimeout(() => callback({ ok: true, data: { durationMs: 900 } }), 120);
          } else if (message.type === 'VOICE_FINISH_NETWORK_DIAGNOSTIC') {
            callback({ ok: true, data: {
              requestCount: 1,
              samples: [{ host: 'cdn.fbsbx.com', type: 'media', status: 206, contentType: 'audio/mp4' }]
            } });
          } else {
            window.unexpectedDiagnosticRequests = (window.unexpectedDiagnosticRequests || 0) + 1;
            callback({ ok: false, error: { code: 'UNEXPECTED' } });
          }
        }
      }
    };
  });
  await diagnosticPage.goto(`${baseUrl}/tests/fixtures/chat.html`);
  await diagnosticPage.locator('.dwell-voice-panel').nth(3).locator('.dwell-voice-observe').click();
  assert.match(await diagnosticPage.locator('.dwell-voice-panel').nth(3)
    .locator('.dwell-voice-status').innerText(), /正在准备验证/);
  await diagnosticPage.waitForFunction(() => document.querySelectorAll('.dwell-voice-status')[3]
    ?.textContent.includes('现在点'));
  await diagnosticPage.locator('[data-test-audio="facebook"]').click();
  await diagnosticPage.evaluate(async () => {
    document.querySelector('audio').dispatchEvent(new Event('play'));
    const context = new AudioContext();
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 1, 8000);
    source.start();
    await context.close();
  });
  await diagnosticPage.waitForTimeout(1900);
  const mediaDiagnostic = await diagnosticPage.locator('.dwell-voice-panel').nth(3).evaluate((panel) =>
    JSON.parse(panel.dwellVoiceDiagnostic)
  );
  assert.equal(mediaDiagnostic.code, 'MEDIA_PATH_CHECK');
  assert.equal(mediaDiagnostic.network.samples[0].status, 206);
  assert(mediaDiagnostic.player.blobCreates > 0);
  assert(mediaDiagnostic.player.mediaPlayEvents > 0);
  assert(mediaDiagnostic.player.audioSourceStarts > 0);
  assert.equal(mediaDiagnostic.clicks.trusted, 1);
  assert.equal(mediaDiagnostic.clicks.inGroup, 1);
  assert.deepEqual(mediaDiagnostic.clicks.controlIndices, [0]);
  assert.deepEqual(await diagnosticPage.evaluate(() => window.mediaMessages), []);
  assert.equal(await diagnosticPage.evaluate(() => window.unexpectedDiagnosticRequests || 0), 0);
  assert.equal(await diagnosticPage.locator('body').evaluate((body) =>
    body.scrollWidth <= document.documentElement.clientWidth), true);
  await diagnosticPage.screenshot({ path: fileURLToPath(new URL('messenger-diagnostic.png', outputDir)) });
  console.log('Messenger metadata-only diagnostic passed.');
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('Popup and transcript panel UI smoke tests passed.');
