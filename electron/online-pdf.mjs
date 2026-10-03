import { createHash } from 'node:crypto';

const MAX_BYTES = 50 * 1024 * 1024;
const PDF_URL = /^https:\/\/(?:arxiv\.org|export\.arxiv\.org)\/pdf\/([0-9]{4}\.[0-9]{4,5}|[a-zA-Z][a-zA-Z0-9.-]*\/[0-9]{7})(v[1-9][0-9]*)?(?:\.pdf)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function pdfUrl(value) {
  // Check the raw URL: URL normalization would hide an explicit :443 or empty credentials.
  const match = typeof value === 'string' && value.length <= 512 &&
    !/[\s\\?#%]/.test(value) && PDF_URL.exec(value);
  if (!match) throw new Error('Only HTTPS arXiv PDF URLs without credentials, ports, query or fragment are allowed.');
  return { url: value, id: match[1], version: match[2] };
}

function redirectUrl(location, previous) {
  if (!location || /[\s\\?#%]/.test(location)) throw new Error('Invalid arXiv PDF redirect.');
  const target = pdfUrl(location.startsWith('//') ? `https:${location}`
    : /^[a-z][a-z0-9+.-]*:/i.test(location) ? location : new URL(location, previous.url).href);
  if (target.id !== previous.id) throw new Error('arXiv redirected to a different paper ID.');
  if (previous.version && target.version !== previous.version) {
    throw new Error('arXiv redirected to a different PDF version.');
  }
  return target;
}

async function abortable(promise, signal) {
  let onAbort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function cancelBody(body) {
  if (body && !body.locked) void body.cancel().catch(() => {});
}

async function readPdf(response, signal) {
  if (response.status !== 200) throw new Error(`arXiv PDF request failed (HTTP ${response.status}).`);
  if (/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
    throw new Error('arXiv returned an HTML page instead of a PDF. Please try again later.');
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BYTES)) {
    throw new Error('Online PDF exceeds the 50 MiB limit or has an invalid Content-Length.');
  }
  if (!response.body) throw new Error('arXiv returned an empty PDF response.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw new Error('Online PDF exceeds the 50 MiB limit.');
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (total < 5 || ![0x25, 0x50, 0x44, 0x46, 0x2d].every((byte, index) => bytes[index] === byte)) {
      throw new Error('arXiv did not return a valid PDF (%PDF- signature missing); it may be an HTML error page.');
    }
    return bytes;
  } finally {
    chunks.length = 0;
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function downloadPdf(source, fetchPdf, signal) {
  let target = source;
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    let response;
    try {
      const pending = Promise.resolve(fetchPdf(target.url, {
        redirect: 'manual', credentials: 'omit', cache: 'no-store', signal,
      })).then(result => {
        response = result;
        // An injected fetch (or an already resolved response) may ignore abort.
        if (signal.aborted) cancelBody(response.body);
        return response;
      });
      await abortable(pending, signal);
      signal.throwIfAborted();
      if (REDIRECTS.has(response.status)) {
        if (redirects === 3) throw new Error('Too many arXiv PDF redirects (maximum 3).');
        target = redirectUrl(response.headers.get('location'), target);
      } else {
        const bytes = await readPdf(response, signal);
        signal.throwIfAborted();
        // Native pins use one spelling across equivalent hosts and .pdf suffixes.
        return { bytes, url: `https://arxiv.org/pdf/${target.id.toLowerCase()}${target.version || ''}` };
      }
    } finally {
      cancelBody(response?.body);
    }
  }
}

// The parent owns transport isolation and native metadata. This module has no
// Electron, filesystem, or MCP dependency and retains PDF bytes only in memory.
export function createOnlinePdfSessions({ getSource, pinSource, fetchPdf = globalThis.fetch }) {
  let current = null;

  function close() {
    if (!current) return;
    const session = current;
    current = null;
    session.entry = null;
    session.controller.abort(new DOMException('Online PDF request was cancelled.', 'AbortError'));
  }

  return {
    async open({ paperId, requestId }) {
      if (typeof paperId !== 'string' || paperId.trim() !== paperId || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(paperId)) {
        throw new Error('Invalid paperId.');
      }
      if (typeof requestId !== 'string' || requestId.length !== 36 || !UUID.test(requestId)) {
        throw new Error('Invalid requestId; expected a UUID.');
      }
      close();
      const session = { requestId, controller: new AbortController(), entry: null };
      current = session;
      const { signal } = session.controller;
      const timer = setTimeout(() => {
        session.controller.abort(new DOMException('Online PDF request timed out after 60 seconds.', 'TimeoutError'));
      }, 60_000);
      timer.unref?.();
      try {
        const source = await abortable(getSource(paperId), signal);
        signal.throwIfAborted();
        if (source.paperId !== paperId) throw new Error('Online PDF source belongs to a different paper ID.');
        const url = pdfUrl(source.url);
        if (source.sha256 !== null && (typeof source.sha256 !== 'string' || source.sha256.length !== 64 || !/^[0-9a-f]{64}$/.test(source.sha256))) {
          throw new Error('Invalid stored PDF SHA-256.');
        }
        const { bytes, url: fetchedUrl } = await downloadPdf(url, fetchPdf, signal);
        signal.throwIfAborted();
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (source.sha256 !== null && source.sha256 !== sha256) {
          throw new Error('ONLINE_PDF_CHANGED: The online PDF content has changed (SHA-256 mismatch). Existing highlights cannot be reused.');
        }
        await abortable(pinSource({ paperId, url: fetchedUrl, sha256 }), signal);
        signal.throwIfAborted();
        session.entry = { paperId, bytes, url: fetchedUrl, sha256 };
        // PDF.js transfers/detaches its buffer. Keep the main-process bytes separate.
        return { requestId, bytes: bytes.slice(), sourceUrl: fetchedUrl, documentKey: sha256 };
      } catch (error) {
        session.entry = null;
        session.controller.abort(error);
        if (current === session) current = null;
        throw signal.reason;
      } finally {
        clearTimeout(timer);
      }
    },
    get(requestId) {
      if (!current || current.requestId !== requestId || !current.entry || current.controller.signal.aborted) {
        throw new Error('Online PDF session is not available. Open the paper again.');
      }
      return { ...current.entry };
    },
    release(requestId) {
      if (current?.requestId === requestId) close();
    },
    close,
  };
}
