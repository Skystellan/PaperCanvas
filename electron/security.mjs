import path from 'node:path';

export const APP_URL = 'paper-canvas://app/index.html';

export function isHttps(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

export function isGoogleSignIn(value) {
  return isHttps(value) && new URL(value).hostname === 'accounts.google.com';
}

export function isLocalFrame(event, window) {
  return !!window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === APP_URL;
}

export function assetPath(url, root) {
  const target = new URL(url);
  if (target.protocol !== 'paper-canvas:' || target.host !== 'app') throw new Error('Invalid resource origin.');
  const file = path.resolve(root, `.${decodeURIComponent(target.pathname)}`);
  if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Invalid resource path.');
  return file;
}

export function chatBounds(value) {
  if (!value || !['x', 'y', 'width', 'height'].every((key) =>
    Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 100_000) ||
    value.width < 1 || value.height < 1) throw new Error('Invalid browser bounds.');
  return Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Math.round(value[key])]));
}
