import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { BrowserLogin, browserCandidates, replaceSessionCookies, selectSessionCookies } from './browser-login.mjs';
import { LoginPipe } from './login-pipe.mjs';

const token = {
  name: '__Secure-next-auth.session-token', value: 'synthetic-session', domain: '.chatgpt.com',
  path: '/', secure: true, httpOnly: true, expires: 2_000_000_000, sameSite: 'Lax',
};

test('imports only complete, live ChatGPT authentication cookies and preserves their scope', () => {
  const imported = selectSessionCookies([token,
    { ...token, domain: '.google.com' }, { ...token, domain: 'chatgpt.com.attacker.test' },
    { ...token, name: 'cf_clearance' }, { ...token, name: 'unrelated' },
  ]);
  assert.equal(imported.length, 1);
  assert.deepEqual(imported[0], {
    url: 'https://chatgpt.com/', name: token.name, value: token.value, domain: token.domain,
    path: '/', secure: true, httpOnly: true, expirationDate: token.expires, sameSite: 'lax',
  });
  assert.equal(selectSessionCookies([{ ...token, domain: 'chatgpt.com' }])[0].domain, undefined);
  const chunks = [0, 1].map((index) => ({ ...token, name: `${token.name}.${index}` }));
  assert.equal(selectSessionCookies(chunks).length, 2);
  for (const cookies of [[], [{ ...token, expires: 1 }], [{ ...token, httpOnly: false }],
    [{ ...token, secure: false }], [{ ...token, value: '' }], [{ ...token, partitionKey: {} }],
    [chunks[1]], [token, ...chunks], [token, token], [{ ...token, name: 'changed-session-format' }]]) {
    assert.throws(() => selectSessionCookies(cookies));
  }
});

test('replaces old token chunks, preserves unrelated cookies, and rolls back failed writes', async () => {
  const old = [0, 1].map((index) => ({
    ...token, name: `${token.name}.${index}`, value: `old-${index}`, expires: undefined,
    expirationDate: token.expires, sameSite: 'strict',
  }));
  let data = [...old, { ...token, name: 'preference', value: 'keep' }];
  let fail = false;
  let flushed = 0;
  const store = {
    async get(filter) { assert.deepEqual(filter, { url: 'https://chatgpt.com/' }); return data; },
    async remove(url, name) { assert.equal(url, 'https://chatgpt.com/'); data = data.filter((item) => item.name !== name); },
    async set(cookie) {
      if (fail && cookie.value === token.value) { fail = false; throw new Error(`secret: ${cookie.value}`); }
      data.push({ ...cookie, domain: cookie.domain ?? 'chatgpt.com' });
    },
    async flushStore() { flushed++; },
  };
  fail = true;
  await assert.rejects(replaceSessionCookies(store, selectSessionCookies([token])), { message: '会话导入失败，已恢复应用原来的登录数据。' });
  assert.deepEqual(data.map((cookie) => cookie.value).sort(), ['keep', 'old-0', 'old-1']);
  assert.equal(data.find((cookie) => cookie.value === 'old-0').expirationDate, token.expires);
  await replaceSessionCookies(store, selectSessionCookies([token]));
  assert.deepEqual(data.map((cookie) => cookie.value).sort(), ['keep', token.value]);
  assert.equal(flushed, 2);
});

test('reads a ChatGPT page only after explicit import, never Google or browser-wide cookies', async () => {
  const login = new BrowserLogin('/synthetic/app-data');
  await assert.rejects(login.sessionCookies(), /请先打开专用登录窗口/);
  const calls = [];
  login.pipe = { closed: false, async send(method, params, sessionId) {
    calls.push({ method, params, sessionId });
    if (method === 'Target.getTargets') return { targetInfos: [
      { type: 'page', url: 'https://accounts.google.com/', targetId: 'google' },
      { type: 'page', url: 'https://chatgpt.com.attacker.test/', targetId: 'other' },
      { type: 'page', url: 'https://chatgpt.com/', targetId: 'chat' },
    ] };
    if (method === 'Target.attachToTarget') return { sessionId: 'chat-session' };
    if (method === 'Network.getCookies') return { cookies: [token] };
    return {};
  } };
  assert.equal(calls.length, 0);
  assert.equal((await login.sessionCookies()).length, 1);
  assert.deepEqual(calls.slice(1), [
    { method: 'Target.attachToTarget', params: { targetId: 'chat', flatten: true }, sessionId: undefined },
    { method: 'Network.getCookies', params: { urls: ['https://chatgpt.com/'] }, sessionId: 'chat-session' },
    { method: 'Target.detachFromTarget', params: { sessionId: 'chat-session' }, sessionId: undefined },
  ]);
  login.pipe.send = async () => ({ targetInfos: [{ type: 'page', url: 'https://accounts.google.com/', targetId: 'google' }] });
  await assert.rejects(login.sessionCookies(), /请先在专用窗口完成登录/);
});

test('finds standard macOS and Windows installations, including spaces and Chinese paths', () => {
  assert.ok(browserCandidates('darwin', {}, '/Users/测试').some((item) =>
    item.executable === '/Users/测试/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  const windows = browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\测试\\AppData\\Local' });
  assert.equal(windows[0].executable, 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.ok(windows.some((item) => item.executable === 'C:\\Users\\测试\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'));
});

function pipeHarness(timeout) {
  const child = new EventEmitter();
  child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit'); };
  return { child, pipe: new LoginPipe(child, timeout) };
}

test('private pipe handles fragmented UTF-8 replies, concurrent requests and secret-free errors', async () => {
  const { child, pipe } = pipeHarness();
  const first = pipe.send('Browser.getVersion');
  const second = pipe.send('Target.getTargets');
  const response = Buffer.from(`${JSON.stringify({ id: 2, result: { title: '中文' } })}\0${JSON.stringify({ id: 1, result: {} })}\0`);
  const split = response.indexOf(Buffer.from('中')) + 1;
  child.stdio[4].write(response.subarray(0, split));
  child.stdio[4].write(response.subarray(split));
  assert.deepEqual(await first, {});
  assert.deepEqual(await second, { title: '中文' });
  const failed = pipe.send('Network.getCookies');
  child.stdio[4].write(`${JSON.stringify({ id: 3, error: { message: 'synthetic-secret' } })}\0`);
  await assert.rejects(failed, { message: '无法读取专用登录窗口，请重新打开后再试。' });
  const closed = pipe.send('Target.getTargets');
  child.emit('exit');
  await assert.rejects(closed, /已关闭/);
  await assert.rejects(pipe.send('Target.getTargets'), /已关闭/);
  pipe.close();
});

test('an unresponsive login browser times out instead of leaving the UI busy', async () => {
  const { pipe } = pipeHarness(10);
  await assert.rejects(pipe.send('Browser.getVersion'), /响应超时/);
  assert.equal(pipe.pending.size, 0);
  pipe.close();
});
