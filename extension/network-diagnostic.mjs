const MAX_SAMPLES = 12;
const MAX_TRACKED = 200;
const WATCH_MS = 12000;

function contentType(headers = []) {
  const value = headers.find((header) => String(header.name).toLowerCase() === 'content-type')?.value || '';
  const type = String(value).split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type.slice(0, 64) : '';
}

export function createNetworkDiagnostic(now = Date.now, extensionId = '') {
  const watches = new Map();
  const fetchWatches = new Map();

  function startFetch(url) {
    if (!extensionId || typeof url !== 'string') return;
    fetchWatches.set(url, { startedAt: now(), requestIds: new Set(), requestCount: 0 });
  }

  function finishFetch(url) {
    const watch = fetchWatches.get(url);
    fetchWatches.delete(url);
    if (!watch) return { requestCount: 0 };
    const { requestCount, status, error } = watch;
    return { requestCount, ...(status ? { status } : {}), ...(error ? { error } : {}) };
  }

  function start(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) return false;
    watches.set(tabId, { startedAt: now(), requests: new Map(), requestCount: 0 });
    return true;
  }

  function observe(details, phase) {
    if (details.initiator === `chrome-extension://${extensionId}` && extensionId) {
      for (const [url, fetchWatch] of fetchWatches) {
        if (now() - fetchWatch.startedAt > WATCH_MS) {
          fetchWatches.delete(url);
          continue;
        }
        const requestId = String(details.requestId || '');
        if (!requestId || (details.url !== url && !fetchWatch.requestIds.has(requestId))) continue;
        if (!fetchWatch.requestIds.has(requestId)) {
          fetchWatch.requestIds.add(requestId);
          fetchWatch.requestCount += 1;
        }
        if (phase === 'headers') fetchWatch.status = Number(details.statusCode) || 0;
        if (phase === 'error') {
          const error = String(details.error || '');
          fetchWatch.error = /^net::ERR_[A-Z_]+$/.test(error) ? error : 'NetworkError';
        }
      }
    }
    const watch = watches.get(details.tabId);
    if (!watch) return;
    if (now() - watch.startedAt > WATCH_MS) {
      watches.delete(details.tabId);
      return;
    }
    const key = String(details.requestId || '');
    if (!key) return;
    let sample = watch.requests.get(key);
    if (!sample) {
      watch.requestCount += 1;
      if (watch.requests.size >= MAX_TRACKED) return;
      let host = '';
      try { host = new URL(details.url).hostname.toLowerCase(); } catch { return; }
      sample = { host, type: String(details.type || 'other').slice(0, 32) };
      watch.requests.set(key, sample);
    }
    if (phase === 'headers') {
      sample.status = Number(details.statusCode) || 0;
      sample.contentType = contentType(details.responseHeaders);
    } else if (phase === 'error') {
      const error = String(details.error || 'Unknown');
      sample.error = /^net::ERR_[A-Z_]+$/.test(error) ? error : 'NetworkError';
    }
  }

  function finish(tabId) {
    const watch = watches.get(tabId);
    watches.delete(tabId);
    const priority = (sample) => sample.contentType?.startsWith('audio/') ? 2 :
      sample.type === 'media' ? 1 : 0;
    return watch ? {
      requestCount: watch.requestCount,
      samples: Array.from(watch.requests.values())
        .sort((left, right) => priority(right) - priority(left))
        .slice(0, MAX_SAMPLES)
    } : { requestCount: 0, samples: [] };
  }

  return { start, observe, finish, startFetch, finishFetch };
}
