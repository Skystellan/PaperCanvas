import { WebContentsView, session } from 'electron';
import { chatBounds, isGoogleSignIn, isHttps } from './security.mjs';

export const CHAT_PARTITION = 'persist:paper-chatgpt';
const webPreferences = {
  partition: CHAT_PARTITION, nodeIntegration: false, contextIsolation: true,
  sandbox: true, webSecurity: true, backgroundThrottling: true,
};

// Remote content has no preload and cannot reach the local PaperCanvas bridge.
export function secureRemote(contents, onGoogleSignIn) {
  const canNavigate = (url) => {
    if (!isHttps(url)) return false;
    // Google disallows embedded OAuth. Keep the user at ChatGPT and offer a
    // browser conversation, not an OAuth URL whose state belongs to this guest.
    if (isGoogleSignIn(url)) { onGoogleSignIn(); return false; }
    return true;
  };
  for (const event of ['will-navigate', 'will-redirect']) {
    contents.on(event, (event, url) => {
      if (!canNavigate(url)) event.preventDefault();
    });
  }
  contents.setWindowOpenHandler(({ url }) => canNavigate(url)
    ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences, autoHideMenuBar: true } }
    : { action: 'deny' });
  contents.on('did-create-window', (popup) => secureRemote(popup.webContents, onGoogleSignIn));
}

export class Chats {
  constructor(window, backend, emit) {
    this.window = window;
    this.backend = backend;
    this.emit = emit;
    this.views = new Map();
    this.active = null;
    this.loadStates = new Map();
    this.loadTimers = new Map();
    this.session = session.fromPartition(CHAT_PARTITION);
    this.session.webRequest.onResponseStarted({ urls: ['https://chatgpt.com/*'] }, (details) => {
      if (details.resourceType !== 'mainFrame') return;
      const challenge = Object.entries(details.responseHeaders || {}).some(([name, values]) =>
        name.toLowerCase() === 'cf-mitigated' && values.includes('challenge'));
      if (!challenge) return;
      for (const [id, view] of this.views) {
        if (view.webContents.id === details.webContentsId) this.setLoadState(id, 'verification', 'ChatGPT 正在进行网站验证。如果页面一直空白，请重新加载网页。');
      }
    });
  }

  setLoadState(id, status, message = '') {
    if (!this.views.has(id)) return;
    clearTimeout(this.loadTimers.get(id));
    this.loadTimers.delete(id);
    const state = { id, status, message };
    this.loadStates.set(id, state);
    this.emit('paper-web-chat-load-state', state);
    if (status === 'loading') this.loadTimers.set(id, setTimeout(() =>
      this.setLoadState(id, 'slow', 'ChatGPT 加载时间较长，请重新加载网页；也可以在浏览器中继续。'), 20_000));
  }

  load(id, contents, url) {
    this.setLoadState(id, 'loading');
    void contents.loadURL(url).catch((error) => {
      if (error.code !== 'ERR_ABORTED' && !contents.isDestroyed()) this.setLoadState(id, 'failed', `聊天网页加载失败（${error.code || '网络错误'}），请重新加载。`);
    });
  }

  capture(id, contents, title) {
    if (contents.isDestroyed()) return;
    if (this.loadStates.get(id)?.status === 'verification') return;
    void this.backend.call('capture_paper_web_chat', { id, url: contents.getURL(), title })
      .then((chat) => { if (chat) this.emit('paper-web-chat-updated', chat); })
      .catch((error) => this.emit('paper-web-chat-error', error.message));
  }

  async layout(id, bounds) {
    if (bounds === null) {
      this.views.get(id)?.setVisible(false);
      if (this.active === id) this.active = null;
      return;
    }
    const rectangle = chatBounds(bounds);
    const zoom = this.window.webContents.getZoomFactor();
    for (const key of ['x', 'y', 'width', 'height']) rectangle[key] = Math.round(rectangle[key] * zoom);
    let view = this.views.get(id);
    if (!view) {
      const chat = await this.backend.call('get_paper_web_chat', { id });
      const url = chat.url || 'https://chatgpt.com/';
      if (!isHttps(url)) throw new Error('Invalid conversation URL.');
      view = new WebContentsView({ webPreferences });
      this.views.set(id, view);
      this.window.contentView.addChildView(view);
      view.setVisible(false);
      const contents = view.webContents;
      secureRemote(contents, () => this.emit('paper-web-chat-login-required', { id }));
      contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) this.setLoadState(id, 'loading');
      });
      contents.on('did-stop-loading', () => {
        if (!['verification', 'failed'].includes(this.loadStates.get(id)?.status)) this.setLoadState(id, 'ready');
      });
      contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) this.setLoadState(id, 'failed', `聊天网页加载失败（${description}），请重新加载。`);
      });
      contents.on('did-navigate', () => this.capture(id, contents));
      contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
        if (isMainFrame) this.capture(id, contents);
      });
      contents.on('page-title-updated', (_event, title) => this.capture(id, contents, title));
      contents.on('render-process-gone', () => this.setLoadState(id, 'failed', '聊天网页进程已退出，请重新加载网页。'));
      this.load(id, contents, url);
    }
    if (this.active !== id) {
      if (this.active) this.views.get(this.active)?.setVisible(false);
      view.setBounds(rectangle);
      view.setVisible(true);
      this.active = id;
      const loadState = this.loadStates.get(id);
      if (loadState) this.emit('paper-web-chat-load-state', loadState);
      await this.backend.call('touch_paper_web_chat', { id });
    } else {
      view.setBounds(rectangle);
    }
  }

  async restore(id) {
    const chat = await this.backend.call('get_paper_web_chat', { id });
    const url = chat.url || 'https://chatgpt.com/';
    if (!isHttps(url)) throw new Error('Invalid conversation URL.');
    const view = this.views.get(id);
    if (view) this.load(id, view.webContents, url);
  }

  reload(id) {
    const view = this.views.get(id);
    if (!view) return;
    this.setLoadState(id, 'loading');
    view.webContents.reloadIgnoringCache();
  }

  removePaper(ids) {
    for (const id of ids) {
      const view = this.views.get(id);
      if (!view) continue;
      this.window.contentView.removeChildView(view);
      view.webContents.close();
      this.views.delete(id);
      clearTimeout(this.loadTimers.get(id));
      this.loadTimers.delete(id);
      this.loadStates.delete(id);
      if (this.active === id) this.active = null;
    }
  }

  close() {
    this.session.webRequest.onResponseStarted(null);
    for (const timer of this.loadTimers.values()) clearTimeout(timer);
    this.loadTimers.clear();
    this.loadStates.clear();
    for (const view of this.views.values()) {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    this.views.clear();
  }
}
