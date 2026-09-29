import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNativeUpdater } from './native-updates.mjs';

async function setup(t, { available = true, choice = 1, config = true, uninstaller = true, packageType, ...options } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'papercanvas-native-update-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const resourcesPath = path.join(directory, 'resources');
  await mkdir(resourcesPath);
  if (config) await writeFile(path.join(resourcesPath, 'app-update.yml'), 'provider: github\n');
  if (uninstaller) await writeFile(path.join(directory, 'Uninstall PaperCanvas.exe'), 'fixture');
  if (packageType) await writeFile(path.join(resourcesPath, 'package-type'), packageType);
  const dialogs = [], progress = [], installs = [], requests = [], installErrors = [];
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => ({ isUpdateAvailable: available, updateInfo: { version: '0.2.7' } });
  updater.downloadUpdate = async () => {
    updater.emit('download-progress', { percent: 25 });
    updater.emit('download-progress', { percent: 100 });
    return ['verified-installer.exe'];
  };
  updater.quitAndInstall = (...args) => installs.push(args);
  const nativeUpdate = createNativeUpdater({
    platform: 'win32', isPackaged: true, resourcesPath, env: {}, updater,
    showMessageBox: async (dialog) => { dialogs.push(dialog); return { response: choice }; },
    setProgress: (value) => progress.push(value),
    requestInstall: (handler) => requests.push(handler),
    onInstallError: () => installErrors.push(true),
    ...options,
  });
  return { nativeUpdate, updater, dialogs, progress, installs, requests, installErrors };
}

test('only an installed NSIS app enables native updates', async (t) => {
  for (const options of [
    { platform: 'darwin' }, { platform: 'linux' }, { isPackaged: false },
    { config: false }, { uninstaller: false }, { config: false, uninstaller: false },
    { env: { PORTABLE_EXECUTABLE_DIR: 'C:\\Portable' } },
    { env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Portable\\PaperCanvas.exe' } },
  ]) {
    const { nativeUpdate, updater, dialogs } = await setup(t, options);
    assert.equal(nativeUpdate, undefined, JSON.stringify(options));
    assert.deepEqual(updater.eventNames(), []);
    assert.deepEqual(dialogs, []);
  }
  assert.equal(typeof (await setup(t)).nativeUpdate, 'function');
});

test('Linux enables DEB and AppImage updates but leaves unpacked builds alone', async (t) => {
  for (const options of [
    { platform: 'linux', packageType: 'deb' },
    { platform: 'linux', env: { APPIMAGE: '/home/user/PaperCanvas.AppImage' } },
    { platform: 'linux', packageType: 'deb', env: { APPIMAGE: '/home/user/PaperCanvas.AppImage' } },
  ]) {
    const { nativeUpdate, requests, installs, dialogs } = await setup(t, { ...options, choice: 0 });
    await nativeUpdate();
    assert.equal(requests.length, 1);
    assert.deepEqual(installs, []);
    assert.match(dialogs[0].detail, options.env ? /folder you can write/ : /system password/);
    requests[0]();
    assert.deepEqual(installs, [[false, true]]);
  }
  for (const options of [{}, { packageType: 'rpm' }, { env: { APPIMAGE: 'relative.AppImage' } },
    { packageType: 'deb', config: false }, { packageType: 'deb', isPackaged: false }]) {
    assert.equal((await setup(t, { platform: 'linux', ...options })).nativeUpdate, undefined);
  }
});

test('downloads with taskbar progress and defers restart until the parent has saved', async (t) => {
  const { nativeUpdate, updater, dialogs, progress, installs, requests } = await setup(t, { choice: 0 });
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.autoRunAppAfterInstall, true);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.disableWebInstaller, true);
  const downloaded = Promise.withResolvers();
  const started = Promise.withResolvers();
  updater.downloadUpdate = () => { started.resolve(); return downloaded.promise; };
  const pending = nativeUpdate();
  await started.promise;
  assert.deepEqual(dialogs, []);
  assert.deepEqual(requests, []);
  updater.emit('download-progress', { percent: 42 });
  downloaded.resolve(['verified-installer.exe']);
  await pending;
  assert.deepEqual(progress, [2, 0, 0.42, -1]);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /0\.2\.7/);
  assert.deepEqual(dialogs[0].buttons, ['Restart and install', 'Later']);
  assert.equal(dialogs[0].defaultId, 1);
  assert.equal(dialogs[0].cancelId, 1);
  assert.deepEqual(installs, []);
  assert.equal(requests.length, 1);
  // Simulate window_destroy after the parent's save-on-close completes.
  requests[0]();
  assert.deepEqual(installs, [[false, true]]);
});

test('Later never installs, and another manual check can use the cached download', async (t) => {
  const { nativeUpdate, updater, dialogs, progress, installs, requests } = await setup(t);
  await nativeUpdate();
  assert.deepEqual(progress, [2, 0, 0.25, 1, -1]);
  assert.deepEqual(installs, []);
  assert.deepEqual(requests, []);
  assert.equal(updater.autoInstallOnAppQuit, false);
  await nativeUpdate();
  assert.equal(dialogs.length, 2);
  assert.deepEqual(installs, []);
  assert.deepEqual(requests, []);
  assert.equal(updater.listenerCount('download-progress'), 1);
  assert.equal(updater.listenerCount('error'), 1);
});

test('a current version reports no update without downloading or closing', async (t) => {
  const { nativeUpdate, updater, dialogs, progress, requests } = await setup(t, { available: false, choice: 0 });
  updater.downloadUpdate = () => assert.fail('No update must not download');
  await nativeUpdate();
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].message, 'PaperCanvas is up to date.');
  assert.deepEqual(progress, [2, -1]);
  assert.deepEqual(requests, []);
});

test('check/download/checksum failures clear progress, report once, and allow retry', async (t) => {
  for (const method of ['checkForUpdates', 'downloadUpdate']) {
    const { nativeUpdate, updater, dialogs, progress, requests, installs } = await setup(t, { choice: 0 });
    const original = updater[method];
    updater[method] = async () => {
      const error = new Error('Private path or checksum mismatch');
      updater.emit('error', error);
      throw error;
    };
    await nativeUpdate();
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].type, 'error');
    assert.doesNotMatch(JSON.stringify(dialogs), /Private path/);
    assert.equal(progress.at(-1), -1);
    assert.deepEqual(installs, []);
    assert.deepEqual(requests, []);
    updater[method] = original;
    await nativeUpdate();
    assert.equal(requests.length, 1);
    assert.deepEqual(installs, []);
  }
});

test('a skipped update check reports failure, not up to date', async (t) => {
  const { nativeUpdate, updater, dialogs, requests } = await setup(t);
  updater.checkForUpdates = async () => null;
  await nativeUpdate();
  assert.equal(dialogs[0].type, 'error');
  assert.deepEqual(requests, []);
});

test('failed parent save/close never invokes installation', async (t) => {
  const { nativeUpdate, dialogs, installs } = await setup(t, {
    choice: 0, requestInstall: async () => { throw new Error('Save failed'); },
  });
  await nativeUpdate();
  assert.equal(dialogs.at(-1).type, 'error');
  assert.deepEqual(installs, []);
});

test('installer errors arriving after save/close restore the close guard before reporting', async (t) => {
  const { nativeUpdate, updater, dialogs, requests, installErrors } = await setup(t, { choice: 0 });
  await nativeUpdate();
  requests[0]();
  updater.emit('error', new Error('Could not launch installer'));
  assert.deepEqual(installErrors, [true]);
  assert.equal(dialogs.length, 2);
  assert.equal(dialogs[1].type, 'error');
});

test('a synchronous installer failure restores the parent close guard and rethrows', async (t) => {
  const { nativeUpdate, updater, requests, installErrors } = await setup(t, { choice: 0 });
  await nativeUpdate();
  updater.quitAndInstall = () => { throw new Error('Launch failed'); };
  assert.throws(() => requests[0](), /Launch failed/);
  assert.deepEqual(installErrors, [true]);
});

test('the updater cancels authentication without credentials', async (t) => {
  const { updater } = await setup(t);
  let credentials;
  updater.emit('login', {}, (...args) => { credentials = args; });
  assert.deepEqual(credentials, []);
});
