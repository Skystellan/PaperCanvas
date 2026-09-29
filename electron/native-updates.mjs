import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createLinuxUpdater } from './linux-updates.mjs';

const require = createRequire(import.meta.url);

// Returns undefined for the portable ZIP so UpdateChecker keeps its browser fallback.
// requestInstall must save through normal window close before invoking its handler.
export function createNativeUpdater({
  showMessageBox, setProgress, requestInstall, onInstallError = () => {},
  platform = process.platform, resourcesPath = process.resourcesPath, env = process.env,
  isPackaged = ['win32', 'linux'].includes(platform) && require('electron').app.isPackaged,
  updater,
}) {
  if (!isPackaged || !resourcesPath ||
      !existsSync(path.join(resourcesPath, 'app-update.yml'))) return undefined;
  let format;
  if (platform === 'win32' && !env.PORTABLE_EXECUTABLE_DIR && !env.PORTABLE_EXECUTABLE_FILE &&
      existsSync(path.join(resourcesPath, '..', 'Uninstall PaperCanvas.exe'))) format = 'nsis';
  if (platform === 'linux') {
    // APPIMAGE takes precedence: builder's shared staging directory can contain
    // the DEB package-type marker in both formats.
    if (env.APPIMAGE && path.isAbsolute(env.APPIMAGE)) format = 'AppImage';
    else if (existsSync(path.join(resourcesPath, 'package-type')) &&
        readFileSync(path.join(resourcesPath, 'package-type'), 'utf8').trim() === 'deb') format = 'deb';
  }
  if (!format) return undefined;

  if (!updater) {
    const library = require('./vendor/update.cjs');
    updater = format === 'nsis' ? library.autoUpdater : createLinuxUpdater(format, library);
  }
  updater.autoDownload = false;
  // Never let the library's quit hook bypass the parent's save/close coordinator.
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;

  const showFailure = () => showMessageBox({
    type: 'error', title: 'PaperCanvas updates', message: 'Could not update PaperCanvas.',
    detail: 'Check your connection and try again, or download the installer from the project releases page.',
    buttons: ['OK'],
  }).catch(() => {}); // The parent window may have closed while installing.
  let installing = false;
  const installFailed = () => {
    installing = false;
    onInstallError(); // Restore the parent's save-on-close guard if the app stays open.
    void showFailure();
  };
  updater.on('download-progress', ({ percent }) => setProgress(percent / 100));
  updater.on('error', () => {
    // Check/download errors also reject their promises; report those only in catch.
    // Installer launch errors can arrive after the callback has completed.
    if (installing) installFailed();
  });
  updater.on('login', (_authInfo, callback) => callback()); // No proxy/login credentials.

  // UpdateChecker owns deduplication and the startup Download/Later prompt.
  return async function nativeUpdate() {
    try {
      let update;
      try {
        setProgress(2); // Indeterminate taskbar progress while checking.
        const result = await updater.checkForUpdates();
        if (!result) throw new Error('Update check did not run.');
        if (result.isUpdateAvailable) {
          setProgress(0);
          await updater.downloadUpdate(); // Includes the library's SHA512 verification.
          update = result.updateInfo;
        }
      } finally { setProgress(-1); }
      if (!update) {
        await showMessageBox({
          type: 'info', title: 'PaperCanvas updates', message: 'PaperCanvas is up to date.',
          detail: 'No newer stable release is available.', buttons: ['OK'],
        });
        return;
      }
      const { response } = await showMessageBox({
        type: 'info', title: 'PaperCanvas update ready',
        message: `PaperCanvas ${update.version} is ready to install.`,
        detail: 'Restart to install the update after saving your work. Choose Later to keep working, then use Check for Updates to install it.' +
          (format === 'deb' ? '\nUbuntu will ask you to authorize installation with your system password.' : '') +
          (format === 'AppImage' ? '\nKeep the AppImage in a folder you can write to.' : ''),
        buttons: ['Restart and install', 'Later'], defaultId: 1, cancelId: 1,
      });
      if (response === 0) await requestInstall(() => {
        installing = true;
        try { updater.quitAndInstall(false, true); }
        catch (error) {
          if (installing) { installing = false; onInstallError(); }
          throw error;
        }
      });
    } catch { await showFailure(); }
  };
}
