import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { LoginPipe } from './login-pipe.mjs';

const CHAT_URL = 'https://chatgpt.com/';
// ChatGPT's web session is not a public OAuth API. Fail closed if its cookie format changes.
const SESSION_NAME = /^__Secure-next-auth\.session-token(?:\.\d+)?$/;
const sessionCookie = (cookie) => ['chatgpt.com', '.chatgpt.com'].includes(cookie.domain) &&
  cookie.path === '/' && SESSION_NAME.test(cookie.name);

export function browserCandidates(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'darwin') return ['/Applications', path.join(home, 'Applications')].flatMap((directory) => [
    { name: 'Chrome', executable: path.join(directory, 'Google Chrome.app/Contents/MacOS/Google Chrome') },
    { name: 'Edge', executable: path.join(directory, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge') },
  ]);
  if (platform === 'win32') return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
    .filter(Boolean).flatMap((directory) => [
      { name: 'Edge', executable: path.win32.join(directory, 'Microsoft/Edge/Application/msedge.exe') },
      { name: 'Chrome', executable: path.win32.join(directory, 'Google/Chrome/Application/chrome.exe') },
    ]);
  return [];
}

function cookieDetails(cookie) {
  const expirationDate = cookie.expirationDate ?? (cookie.expires > 0 ? cookie.expires : undefined);
  return {
    url: CHAT_URL, name: cookie.name, value: cookie.value, path: '/',
    ...(cookie.domain.startsWith('.') ? { domain: cookie.domain } : {}),
    secure: cookie.secure, httpOnly: cookie.httpOnly, expirationDate,
    sameSite: { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }[cookie.sameSite] ?? cookie.sameSite ?? 'unspecified',
  };
}

export function selectSessionCookies(cookies, now = Date.now() / 1000) {
  const selected = cookies.filter(sessionCookie);
  if (!selected.length) throw new Error('未找到可导入的 ChatGPT 登录会话。请在专用窗口用 Google 登录原账号，再点击导入；若已经登录，此版本可能不支持该会话格式。');
  if (selected.some((cookie) => !cookie.secure || !cookie.httpOnly || !cookie.value ||
    cookie.partitionKey || (cookie.expires !== -1 && cookie.expires <= now))) {
    throw new Error('登录会话已过期或格式不受支持，请在专用窗口重新登录。');
  }
  const names = selected.map((cookie) => cookie.name).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const base = '__Secure-next-auth.session-token';
  if (!(names.length === 1 && names[0] === base) &&
    !names.every((name, index) => name === `${base}.${index}`)) {
    throw new Error('登录会话不完整，请在专用窗口重新登录后再导入。');
  }
  return selected.map(cookieDetails);
}

export async function replaceSessionCookies(store, incoming) {
  const previous = (await store.get({ url: CHAT_URL })).filter(sessionCookie).map(cookieDetails);
  const names = new Set([...previous, ...incoming].map((cookie) => cookie.name));
  async function replace(cookies) {
    for (const name of names) await store.remove(CHAT_URL, name);
    for (const cookie of cookies) await store.set(cookie);
    await store.flushStore();
  }
  try { await replace(incoming); }
  catch {
    try { await replace(previous); }
    catch { throw new Error('会话导入和恢复均未完成，请在应用内重新登录。'); }
    throw new Error('会话导入失败，已恢复应用原来的登录数据。');
  }
}

export class BrowserLogin {
  constructor(dataDirectory) {
    this.directory = path.join(dataDirectory, 'browser-login');
    this.pipe = null;
    this.browser = null;
    this.starting = null;
  }

  start() {
    if (!this.starting) this.starting = this.open().finally(() => { this.starting = null; });
    return this.starting;
  }

  async open() {
    if (this.pipe && !this.pipe.closed) {
      const { targetInfos } = await this.pipe.send('Target.getTargets');
      const target = targetInfos.find((item) => item.type === 'page');
      if (target) await this.pipe.send('Target.activateTarget', { targetId: target.targetId });
      else await this.pipe.send('Target.createTarget', { url: CHAT_URL });
      return this.browser;
    }
    this.close();
    const candidates = browserCandidates();
    let browser;
    for (const candidate of candidates) {
      try { await access(candidate.executable); browser = candidate; break; } catch { /* Try the next installed browser. */ }
    }
    if (!browser) throw new Error('未找到 Chrome 或 Edge。请安装其中一个浏览器，或继续在系统浏览器中使用 ChatGPT。');
    const profile = path.join(this.directory, browser.name);
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const child = spawn(browser.executable, [
      `--user-data-dir=${profile}`, '--remote-debugging-pipe',
      '--no-first-run', '--no-default-browser-check', '--new-window', CHAT_URL,
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
    this.pipe = new LoginPipe(child);
    this.browser = browser.name;
    try { await this.pipe.send('Browser.getVersion'); }
    catch { this.close(); throw new Error('无法打开专用登录窗口。请关闭上一次的专用窗口后重试。'); }
    return this.browser;
  }

  async sessionCookies() {
    const pipe = this.pipe;
    if (!pipe || pipe.closed) throw new Error('请先打开专用登录窗口，并在其中完成 Google 登录。');
    const { targetInfos } = await pipe.send('Target.getTargets');
    const target = targetInfos.find((item) => item.type === 'page' && (() => {
      try { return new URL(item.url).origin === 'https://chatgpt.com'; } catch { return false; }
    })());
    if (!target) throw new Error('请先在专用窗口完成登录，并回到 ChatGPT 页面。');
    const { sessionId } = await pipe.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    try {
      // Scope the request to ChatGPT. Never query Google cookies or browser-wide storage.
      const { cookies } = await pipe.send('Network.getCookies', { urls: [CHAT_URL] }, sessionId);
      return selectSessionCookies(cookies);
    } finally { await pipe.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
  }

  close() {
    this.pipe?.close();
    this.pipe = null;
    this.browser = null;
  }
}
