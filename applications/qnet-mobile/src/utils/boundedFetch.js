/**
 * A GET of JSON whose answer may not be larger than `maxBytes` (MOBNET-R2-06). Reads from endpoints nobody vouches
 * for (read-pool nodes) must not be able to exhaust the phone's memory: a small gzip body can inflate to hundreds
 * of MB, and a plain chunked body can simply be huge, both before any JSON is parsed.
 *
 * In the app the request is an XMLHttpRequest with incremental events: it asks for no compression, refuses a declared
 * length above the cap as soon as the headers arrive, and aborts at the first chunk that takes the received text past
 * the cap, before the whole body is ever held; the length is that of the text received, never the progress figure
 * React Native reports (MOBNET-R3-02). Where there is no XMLHttpRequest, fetch is used with the same limits on the
 * declared and the read length.
 */

export class ResponseTooLargeError extends Error {
  constructor(url, limit) {
    super(`The answer of ${url} is larger than ${limit} bytes`);
    this.name = 'ResponseTooLargeError';
    this.code = 'RESPONSE_TOO_LARGE';
  }
}

const REQUEST_HEADERS = { Accept: 'application/json', 'Accept-Encoding': 'identity' };

function declaredTooLarge(value, maxBytes) {
  const n = Number(value);
  return value != null && value !== '' && Number.isFinite(n) && n > maxBytes;
}

function viaXhr(url, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); // eslint-disable-line no-undef
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const stop = (error) => finish(() => {
      try { xhr.abort(); } catch (_) { /* already over */ }
      reject(error);
    });
    const timer = setTimeout(() => stop(new Error('Timed out')), timeoutMs);
    xhr.open('GET', url);
    for (const [k, v] of Object.entries(REQUEST_HEADERS)) xhr.setRequestHeader(k, v);
    xhr.responseType = 'text';
    // What has actually arrived, measured on the text itself (MOBNET-R3-02). React Native on Android reports the same
    // progress value for every chunk, read before the body: 0, or -1 when it decodes a gzip body itself although
    // identity was asked for. So `loaded` alone never passes the cap; the text it appends to does.
    const received = () => {
      try { return typeof xhr.responseText === 'string' ? xhr.responseText.length : 0; } catch (_) { return 0; }
    };
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 2 && declaredTooLarge(xhr.getResponseHeader('content-length'), maxBytes)) {
        stop(new ResponseTooLargeError(url, maxBytes));
      } else if (xhr.readyState === 3 && received() > maxBytes) {
        stop(new ResponseTooLargeError(url, maxBytes)); // each chunk moves the request to LOADING again
      }
    };
    xhr.onprogress = (e) => {
      const loaded = Math.max(e && Number.isFinite(e.loaded) ? e.loaded : 0, received());
      if (loaded > maxBytes) stop(new ResponseTooLargeError(url, maxBytes));
    };
    xhr.onload = () => finish(() => {
      if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(`HTTP ${xhr.status}`)); return; }
      const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
      if (text.length > maxBytes) { reject(new ResponseTooLargeError(url, maxBytes)); return; }
      try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
    });
    xhr.onerror = () => finish(() => reject(new Error('Network request failed')));
    xhr.ontimeout = () => finish(() => reject(new Error('Timed out')));
    xhr.send();
  });
}

async function viaFetch(url, { timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'GET', headers: REQUEST_HEADERS, signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const length = resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get('content-length') : null;
    if (declaredTooLarge(length, maxBytes)) throw new ResponseTooLargeError(url, maxBytes);
    if (typeof resp.text !== 'function') return await resp.json();
    const text = await resp.text();
    if (text.length > maxBytes) throw new ResponseTooLargeError(url, maxBytes);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

/** JSON from `url`, or a throw: HTTP status, timeout, network, ResponseTooLargeError. */
export function boundedGetJson(url, { timeoutMs = 10000, maxBytes } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes is required');
  return typeof XMLHttpRequest === 'function' // eslint-disable-line no-undef
    ? viaXhr(url, { timeoutMs, maxBytes })
    : viaFetch(url, { timeoutMs, maxBytes });
}
