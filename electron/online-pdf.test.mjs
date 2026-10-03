import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createOnlinePdfSessions } from './online-pdf.mjs';

const URL = 'https://arxiv.org/pdf/2401.12345';
const OTHER_URL = 'https://arxiv.org/pdf/2402.12345v1';
const PDF = new TextEncoder().encode('%PDF-1.7\nA test paper\n%%EOF');
const HASH = createHash('sha256').update(PDF).digest('hex');
const source = (paperId = 'paper-1', url = URL, sha256 = null) => ({ paperId, url, sha256, filePath: '/private/papers/secret.pdf' });
const request = (paperId = 'paper-1') => ({ paperId, requestId: randomUUID() });
const response = () => new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, overrides = {}) {
  const calls = { get: [], pin: [], fetch: [] };
  const sessions = createOnlinePdfSessions({
    getSource(paperId) {
      calls.get.push(paperId);
      return overrides.getSource ? overrides.getSource(paperId) : source(paperId);
    },
    pinSource(info) {
      calls.pin.push(info);
      return overrides.pinSource ? overrides.pinSource(info) : { ...info, filePath: '/private/native.pdf' };
    },
    fetchPdf(url, options) {
      calls.fetch.push({ url, options });
      return overrides.fetchPdf ? overrides.fetchPdf(url, options) : response();
    },
  });
  t.after(() => sessions.close());
  return { sessions, calls };
}

test('only open reads the requested paper; saves reuse memory and renderer detachment is harmless', async t => {
  const { sessions, calls } = fixture(t);
  const input = request('paper-library:old_1');
  assert.deepEqual(calls, { get: [], pin: [], fetch: [] });
  assert.throws(() => sessions.get(input.requestId), /not available/);
  sessions.release(randomUUID());
  sessions.close();
  const result = await sessions.open({ ...input, url: 'https://localhost/evil.pdf' });
  assert.deepEqual(calls.get, [input.paperId]);
  assert.deepEqual(calls.pin, [{ paperId: input.paperId, url: URL, sha256: HASH }]);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].url, URL);
  assert.deepEqual(Object.keys(calls.fetch[0].options).sort(), ['cache', 'credentials', 'redirect', 'signal']);
  const { signal, ...options } = calls.fetch[0].options;
  assert.deepEqual(options, { redirect: 'manual', credentials: 'omit', cache: 'no-store' });
  assert.equal(signal.aborted, false);
  assert.deepEqual(result, { requestId: input.requestId, bytes: PDF, sourceUrl: URL, documentKey: HASH });
  assert.equal(Object.getPrototypeOf(result.bytes), Uint8Array.prototype);
  const saved = sessions.get(input.requestId);
  assert.deepEqual(saved, { paperId: input.paperId, bytes: PDF, url: URL, sha256: HASH });
  assert.notEqual(saved.bytes.buffer, result.bytes.buffer);
  structuredClone(result.bytes, { transfer: [result.bytes.buffer] });
  assert.equal(result.bytes.byteLength, 0);
  saved.url = 'changed by caller';
  assert.deepEqual(sessions.get(input.requestId).bytes, PDF);
  assert.equal(sessions.get(input.requestId).url, URL);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.pin.length, 1);
  sessions.release(randomUUID());
  assert.deepEqual(sessions.get(input.requestId).bytes, PDF);
  sessions.close();
  assert.equal(signal.aborted, true);
  assert.throws(() => sessions.get(input.requestId), /not available/);
  sessions.close();
});

test('bounded paper IDs and UUID request IDs are checked before any native or network call', async t => {
  const { sessions, calls } = fixture(t);
  for (const paperId of ['', ' ', 'a'.repeat(201), '../secret', 'https://arxiv.org/pdf/2401.12345', 'a\n', 'a\0', {}, 1]) {
    await assert.rejects(sessions.open({ ...request(), paperId }), /paperId/);
  }
  for (const requestId of ['', 'request-1', randomUUID() + '\n', {}, null]) {
    await assert.rejects(sessions.open({ paperId: 'paper-1', requestId }), /requestId/);
  }
  assert.deepEqual(calls, { get: [], pin: [], fetch: [] });
  await sessions.open(request('a'.repeat(200)));
});

test('source lookup failures and wrong-paper sources never fetch or pin', async t => {
  for (const getSource of [() => { throw new Error('Paper is missing.'); }, () => source('another-paper')]) {
    const { sessions, calls } = fixture(t, { getSource });
    const input = request();
    await assert.rejects(sessions.open(input), /missing|different paper/);
    assert.equal(calls.fetch.length, 0);
    assert.equal(calls.pin.length, 0);
    assert.throws(() => sessions.get(input.requestId), /not available/);
  }
});

const unsafeUrls = [
  'http://arxiv.org/pdf/2401.12345', 'https://localhost/pdf/2401.12345',
  'https://127.0.0.1/pdf/2401.12345', 'javascript:alert(1)',
  'https://arxiv.org.evil.test/pdf/2401.12345', 'https://www.arxiv.org/pdf/2401.12345',
  'https://user:pass@arxiv.org/pdf/2401.12345', 'https://@arxiv.org/pdf/2401.12345',
  'https://arxiv.org:443/pdf/2401.12345', 'https://arxiv.org:8443/pdf/2401.12345',
  `${URL}?download=1`, `${URL}?`, `${URL}#page=1`, `${URL}#`,
  `${URL}\n`, 'https://arxiv.org\\@localhost/pdf/2401.12345',
  'https://arxiv.org/abs/2401.12345', 'https://arxiv.org/pdf/../pdf/2401.12345',
  'https://arxiv.org/pdf/%32%34%30%31.12345', `${URL}/extra`, `${URL}v0`,
];

test('unsafe source URLs are rejected before fetch', async t => {
  for (const url of unsafeUrls) {
    const { sessions, calls } = fixture(t, { getSource: () => source('paper-1', url) });
    await assert.rejects(sessions.open(request()), /Only HTTPS arXiv/);
    assert.equal(calls.fetch.length, 0, url);
    assert.equal(calls.pin.length, 0, url);
  }
});

test('modern, legacy, versioned and .pdf source forms work on both allowed hosts', async t => {
  for (const host of ['arxiv.org', 'export.arxiv.org']) {
    for (const id of ['0704.0001', '2401.12345v12.pdf', 'hep-th/9901001', 'math.GT/0309136v2.pdf']) {
      const url = `https://${host}/pdf/${id}`;
      const { sessions } = fixture(t, { getSource: () => source('paper-1', url) });
      assert.equal((await sessions.open(request())).sourceUrl, `https://arxiv.org/pdf/${id.toLowerCase().replace(/\.pdf$/, '')}`);
    }
  }
});

test('at most three manual redirects can resolve an unversioned source to a pinned version', async t => {
  const targets = [`${URL}v2`, 'https://export.arxiv.org/pdf/2401.12345v2.pdf', `${URL}v2.pdf`];
  let index = 0;
  const { sessions, calls } = fixture(t, {
    fetchPdf: () => index < targets.length
      ? new Response(null, { status: [302, 307, 308][index], headers: { location: targets[index++] } }) : response(),
  });
  const result = await sessions.open(request());
  assert.equal(result.sourceUrl, `${URL}v2`);
  assert.deepEqual(calls.fetch.map(call => call.url), [URL, ...targets]);
  assert.ok(calls.fetch.every(call => call.options.redirect === 'manual' && call.options.signal === calls.fetch[0].options.signal));
  assert.deepEqual(calls.pin, [{ paperId: 'paper-1', url: `${URL}v2`, sha256: HASH }]);
});

test('relative and protocol-relative redirects preserve the paper identity, including legacy IDs', async t => {
  for (const [url, location, expected] of [
    [URL, '2401.12345v1.pdf', `${URL}v1.pdf`],
    [URL, '//export.arxiv.org/pdf/2401.12345v2', 'https://export.arxiv.org/pdf/2401.12345v2'],
    ['https://arxiv.org/pdf/hep-th/9901001', '/pdf/hep-th/9901001v3.pdf', 'https://arxiv.org/pdf/hep-th/9901001v3.pdf'],
  ]) {
    let count = 0;
    const { sessions, calls } = fixture(t, {
      getSource: () => source('paper-1', url),
      fetchPdf: () => count++ === 0 ? new Response(null, { status: 301, headers: { location } }) : response(),
    });
    assert.equal((await sessions.open(request())).sourceUrl, expected.replace('export.arxiv.org', 'arxiv.org').replace(/\.pdf$/, ''));
    assert.equal(calls.fetch.length, 2);
  }
});

test('every unsafe redirect and cross-paper redirect is rejected without requesting the target', async t => {
  for (const location of [...unsafeUrls.filter(url => !url.endsWith('\n')), OTHER_URL,
    '/pdf/hep-th/9901001', '//user@arxiv.org/pdf/2401.12345', '//arxiv.org:443/pdf/2401.12345', '?x=1', '#x']) {
    const { sessions, calls } = fixture(t, {
      fetchPdf: () => new Response(null, { status: 302, headers: { location } }),
    });
    await assert.rejects(sessions.open(request()), /arXiv|different paper/);
    assert.equal(calls.fetch.length, 1, location);
    assert.equal(calls.pin.length, 0, location);
  }
});

test('explicit versions cannot change or disappear, including versions first seen in redirects', async t => {
  for (const [initial, targets] of [
    [`${URL}v1`, [`${URL}v2`]], [`${URL}v1`, [URL]],
    [URL, [`${URL}v1`, `${URL}v2`]], [URL, [`${URL}v1`, URL]],
  ]) {
    let index = 0;
    const { sessions, calls } = fixture(t, {
      getSource: () => source('paper-1', initial),
      fetchPdf: () => new Response(null, { status: 303, headers: { location: targets[index++] } }),
    });
    await assert.rejects(sessions.open(request()), /different PDF version/);
    assert.equal(calls.fetch.length, targets.length);
    assert.equal(calls.pin.length, 0);
  }
});

test('redirect loops stop after three hops and missing Location is a friendly failure', async t => {
  for (const location of [URL, null]) {
    const { sessions, calls } = fixture(t, {
      fetchPdf: () => new Response(null, { status: 302, headers: location ? { location } : {} }),
    });
    await assert.rejects(sessions.open(request()), /redirect/);
    assert.equal(calls.fetch.length, location ? 4 : 1);
    assert.equal(calls.pin.length, 0);
  }
});

test('HTTP errors, HTML and invalid PDF signatures fail without retrying or pinning', async t => {
  for (const [makeResponse, expected] of [
    [() => new Response('Not found', { status: 404 }), /HTTP 404/],
    [() => new Response('Rate limited', { status: 429 }), /HTTP 429/],
    [() => new Response('Unavailable', { status: 503 }), /HTTP 503/],
    [() => new Response(PDF, { status: 206 }), /HTTP 206/],
    [() => new Response('<html>captcha</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }), /HTML page/],
    [() => new Response(PDF, { headers: { 'content-type': 'application/xhtml+xml' } }), /HTML page/],
    [() => new Response('<html>error</html>', { headers: { 'content-type': 'application/pdf' } }), /signature missing/],
    [() => new Response('%PDF'), /signature missing/],
    [() => new Response(null), /empty PDF/],
  ]) {
    const { sessions, calls } = fixture(t, { fetchPdf: makeResponse });
    const input = request();
    await assert.rejects(sessions.open(input), expected);
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.pin.length, 0);
    assert.equal(calls.fetch[0].options.signal.aborted, true);
    assert.throws(() => sessions.get(input.requestId), /not available/);
  }
});

test('Content-Length is checked before reading and rejected bodies are cancelled', async t => {
  for (const length of [String(50 * 1024 * 1024 + 1), 'invalid', '-1']) {
    let reads = 0, cancels = 0;
    const { sessions, calls } = fixture(t, {
      fetchPdf: () => new Response(new ReadableStream({
        pull() { reads++; }, cancel() { cancels++; },
      }, { highWaterMark: 0 }), { headers: { 'content-length': length } }),
    });
    await assert.rejects(sessions.open(request()), /50 MiB|Content-Length/);
    assert.equal(reads, 0);
    assert.equal(cancels, 1);
    assert.equal(calls.pin.length, 0);
  }
});

test('stream cap also applies to missing or dishonest Content-Length', async t => {
  const chunk = new Uint8Array(1024 * 1024);
  chunk.set(PDF);
  for (const headers of [{}, { 'content-length': '10' }]) {
    let reads = 0, cancels = 0;
    const { sessions, calls } = fixture(t, {
      fetchPdf: () => new Response(new ReadableStream({
        pull(controller) { reads++; controller.enqueue(chunk); },
        cancel() { cancels++; },
      }, { highWaterMark: 0 }), { headers }),
    });
    await assert.rejects(sessions.open(request()), /50 MiB/);
    assert.equal(reads, 51);
    assert.equal(cancels, 1);
    assert.equal(calls.pin.length, 0);
  }
});

test('exactly 50 MiB is accepted and PDF signatures may span stream chunks', async t => {
  const chunk = new Uint8Array(1024 * 1024);
  chunk.set(PDF);
  let remaining = 50 * 1024 * 1024;
  const { sessions } = fixture(t, {
    fetchPdf: () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(PDF.slice(0, 2)); remaining -= 2; },
      pull(controller) {
        if (remaining === 0) { controller.close(); return; }
        const next = remaining === 50 * 1024 * 1024 - 2 ? chunk.subarray(2) : chunk.subarray(0, Math.min(chunk.length, remaining));
        controller.enqueue(next);
        remaining -= next.byteLength;
      },
    }), { headers: { 'content-length': String(50 * 1024 * 1024) } }),
  });
  const result = await sessions.open(request());
  assert.equal(result.bytes.byteLength, 50 * 1024 * 1024);
  assert.deepEqual(result.bytes.slice(0, PDF.length), PDF);
});

test('network and stream failures propagate once and never cache partial bytes', async t => {
  for (const fetchPdf of [
    () => Promise.reject(new Error('Network unavailable.')),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(PDF); controller.error(new Error('Stream failed.')); } })),
  ]) {
    const { sessions, calls } = fixture(t, { fetchPdf });
    const input = request();
    await assert.rejects(sessions.open(input), /Network unavailable|Stream failed/);
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.pin.length, 0);
    assert.throws(() => sessions.get(input.requestId), /not available/);
  }
});

test('stored hashes must match freshly fetched bytes; pin conflicts never publish a session', async t => {
  for (const sha256 of [HASH, '0'.repeat(64), 'invalid']) {
    const { sessions, calls } = fixture(t, { getSource: () => source('paper-1', `${URL}v1`, sha256) });
    const input = request();
    if (sha256 === HASH) {
      assert.equal((await sessions.open(input)).documentKey, HASH);
      assert.equal(calls.pin.length, 1);
    } else {
      await assert.rejects(sessions.open(input), /SHA-256/);
      assert.equal(calls.pin.length, 0);
      assert.equal(calls.fetch.length, sha256 === 'invalid' ? 0 : 1);
      assert.throws(() => sessions.get(input.requestId), /not available/);
    }
  }
  const { sessions, calls } = fixture(t, { pinSource: () => { throw new Error('Pinned PDF version conflict.'); } });
  const input = request();
  await assert.rejects(sessions.open(input), /version conflict/);
  assert.equal(calls.pin.length, 1);
  assert.throws(() => sessions.get(input.requestId), /not available/);
});

test('pin must finish before either renderer bytes or the save session becomes available', async t => {
  const entered = deferred(), pin = deferred();
  const { sessions } = fixture(t, { pinSource: () => { entered.resolve(); return pin.promise; } });
  const input = request();
  let completed = false;
  const opening = sessions.open(input).then(result => { completed = true; return result; });
  await entered.promise;
  assert.equal(completed, false);
  assert.throws(() => sessions.get(input.requestId), /not available/);
  pin.resolve(source());
  assert.deepEqual((await opening).bytes, PDF);
  assert.deepEqual(sessions.get(input.requestId).bytes, PDF);
});

// The native callbacks deliberately ignore abort: late completion must be harmless.
for (const stage of ['getSource', 'fetch', 'stream', 'pin']) {
  for (const action of ['close', 'release', 'replace', 'timeout']) {
    test(`${action} during ${stage} aborts promptly and cannot publish or overwrite a newer session`, async t => {
      if (action === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
      const entered = deferred(), pending = deferred();
      let cancels = 0;
      const { sessions, calls } = fixture(t, {
        getSource(paperId) {
          if (paperId === 'paper-2') return source(paperId, OTHER_URL);
          if (stage === 'getSource') { entered.resolve(); return pending.promise; }
          return source(paperId);
        },
        fetchPdf(url) {
          if (url === OTHER_URL) return response();
          if (stage === 'fetch') { entered.resolve(); return pending.promise; }
          if (stage === 'stream') return new Response(new ReadableStream({
            start(controller) { controller.enqueue(PDF); },
            pull() { entered.resolve(); },
            cancel() { cancels++; },
          }, { highWaterMark: 0 }));
          return response();
        },
        pinSource(info) {
          if (info.paperId === 'paper-1' && stage === 'pin') { entered.resolve(); return pending.promise; }
          return info;
        },
      });
      const first = request(), second = request('paper-2');
      const failed = assert.rejects(sessions.open(first), { name: action === 'timeout' ? 'TimeoutError' : 'AbortError' });
      await entered.promise;
      assert.throws(() => sessions.get(first.requestId), /not available/);
      if (action === 'close') sessions.close();
      if (action === 'release') sessions.release(first.requestId);
      if (action === 'replace') await sessions.open(second);
      if (action === 'timeout') {
        t.mock.timers.tick(59_999);
        if (calls.fetch[0]) assert.equal(calls.fetch[0].options.signal.aborted, false);
        t.mock.timers.tick(1);
      }
      await failed;
      assert.throws(() => sessions.get(first.requestId), /not available/);
      const oldFetch = calls.fetch.find(call => call.url === URL);
      if (oldFetch) assert.equal(oldFetch.options.signal.aborted, true);
      if (stage === 'getSource') pending.resolve(source());
      if (stage === 'fetch') pending.resolve(new Response(new ReadableStream({
        start(controller) { controller.enqueue(PDF); }, cancel() { cancels++; },
      })));
      if (stage === 'pin') pending.resolve(source());
      await flush();
      assert.equal(calls.pin.filter(info => info.paperId === first.paperId).length, stage === 'pin' ? 1 : 0);
      if (stage === 'stream' || stage === 'fetch') assert.equal(cancels, 1);
      assert.throws(() => sessions.get(first.requestId), /not available/);
      if (action === 'replace') {
        sessions.release(first.requestId);
        assert.deepEqual(sessions.get(second.requestId), { paperId: 'paper-2', bytes: PDF, url: OTHER_URL, sha256: HASH });
        assert.equal(calls.fetch.find(call => call.url === OTHER_URL).options.signal.aborted, false);
      }
    });
  }
}

test('the 60 second deadline covers source lookup plus redirects and is not reset per fetch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lookup = deferred(), redirected = deferred();
  const { sessions, calls } = fixture(t, {
    getSource: () => lookup.promise,
    fetchPdf(url) {
      if (url === URL) return new Response(null, { status: 302, headers: { location: `${URL}v1` } });
      redirected.resolve();
      return new Promise(() => {});
    },
  });
  const failed = assert.rejects(sessions.open(request()), /timed out after 60 seconds/);
  t.mock.timers.tick(40_000);
  lookup.resolve(source());
  await redirected.promise;
  t.mock.timers.tick(20_000);
  await failed;
  assert.equal(calls.fetch.length, 2);
  assert.ok(calls.fetch.every(call => call.options.signal.aborted));
  assert.equal(calls.pin.length, 0);
});

test('a new open clears a completed session immediately, even if the replacement fails', async t => {
  let count = 0;
  const { sessions, calls } = fixture(t, {
    getSource(paperId) { if (count++ > 0) throw new Error('Paper is missing.'); return source(paperId); },
  });
  const first = request();
  await sessions.open(first);
  const failed = assert.rejects(sessions.open(request('paper-2')), /missing/);
  assert.throws(() => sessions.get(first.requestId), /not available/);
  assert.equal(calls.fetch[0].options.signal.aborted, true);
  await failed;
  sessions.release(first.requestId);
  sessions.close();
});
