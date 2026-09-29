import { execFileSync } from 'node:child_process';

export function createLinuxUpdater(format, { DebUpdater, AppImageUpdater }, run = execFileSync) {
  if (format === 'AppImage') return new AppImageUpdater();
  // Retain electron-updater's feed, download, SHA512 checks and quit lifecycle.
  // Use argv for apt (paths may contain spaces/quotes), and request authorization
  // once. Cancelling must not fall through to a second installation command.
  class UbuntuUpdater extends DebUpdater {
    doInstall({ isForceRunAfter }) {
      run('/usr/bin/pkexec', [
        '/usr/bin/apt-get', 'install', '--reinstall', '--no-remove', '-y', '--', this.downloadedUpdateHelper.file,
      ]);
      if (isForceRunAfter) this.app.relaunch();
      return true;
    }
  }
  return new UbuntuUpdater();
}
