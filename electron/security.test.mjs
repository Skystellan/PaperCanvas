import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_URL, assetPath, canWriteChatClipboard, chatBounds, isGoogleSignIn, isHttps, isLocalFrame } from './security.mjs';

test('ChatGPT can copy without granting remote clipboard reads or other permissions', () => {
  assert.equal(canWriteChatClipboard('clipboard-sanitized-write', 'https://chatgpt.com/c/test', true), true);
  assert.equal(canWriteChatClipboard('clipboard-sanitized-write', 'https://chatgpt.com/', false), false);
  for (const permission of ['clipboard-read', 'media', 'notifications']) {
    assert.equal(canWriteChatClipboard(permission, 'https://chatgpt.com/', true), false);
  }
  for (const url of ['https://chatgpt.com.evil.test/', 'http://chatgpt.com/', 'https://example.com/', 'invalid']) {
    assert.equal(canWriteChatClipboard('clipboard-sanitized-write', url, true), false);
  }
});

test('Google sign-in detection is scoped to the real HTTPS account host', () => {
  assert.equal(isGoogleSignIn('https://accounts.google.com/o/oauth2/v2/auth?state=private'), true);
  for (const url of ['https://accounts.google.com.evil.test/', 'https://chatgpt.com/', 'http://accounts.google.com/', 'invalid']) {
    assert.equal(isGoogleSignIn(url), false);
  }
});

test('only the reader main frame can invoke local commands', () => {
  const frame = { url: APP_URL };
  const contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents };
  assert.equal(isLocalFrame({ sender: contents, senderFrame: frame }, window), true);
  assert.equal(isLocalFrame({ sender: {}, senderFrame: frame }, window), false);
  assert.equal(isLocalFrame({ sender: contents, senderFrame: { url: APP_URL } }, window), false);
  frame.url = 'https://chatgpt.com/';
  assert.equal(isLocalFrame({ sender: contents, senderFrame: frame }, window), false);
});

test('asset paths and remote navigation do not escape their scopes', () => {
  assert.equal(assetPath('paper-canvas://app/assets/main.js', '/bundle/dist'), '/bundle/dist/assets/main.js');
  for (const url of ['paper-canvas://other/index.html', 'paper-canvas://app/%2e%2e%2fsecret', 'file:///secret']) {
    assert.throws(() => assetPath(url, '/bundle/dist'));
  }
  assert.equal(isHttps('https://chatgpt.com/c/example'), true);
  for (const url of ['file:///secret', 'javascript:alert(1)', 'https://user:pass@example.com', 'http://example.com']) {
    assert.equal(isHttps(url), false);
  }
  assert.deepEqual(chatBounds({ x: 1.2, y: 2.8, width: 500, height: 600 }), { x: 1, y: 3, width: 500, height: 600 });
  assert.throws(() => chatBounds({ x: 0, y: 0, width: Infinity, height: 10 }));
});
