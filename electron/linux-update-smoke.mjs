import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createLinuxUpdater } from './linux-updates.mjs';
import { createNativeUpdater } from './native-updates.mjs';

// Only invoked by the explicit, isolated desktop smoke mode.
export async function linuxUpdateSmoke({ dataDirectory, requestInstall }) {
  assert.match(dataDirectory, /papercanvas-smoke-/);
  const feed = new URL(process.env.PAPERCANVAS_UPDATE_SMOKE);
  assert.equal(feed.hostname, '127.0.0.1');
  const note = path.join(dataDirectory, 'retained-note.md');
  const installed = path.join(dataDirectory, 'install-requested');
  if (existsSync(installed)) {
    assert.equal(await readFile(note, 'utf8'), '# Retained across installation\n');
    await writeFile(path.join(dataDirectory, 'update-success'), 'download, install, relaunch, data retained');
    return;
  }
  await writeFile(note, '# Retained across installation\n');
  const library = createRequire(import.meta.url)('./vendor/update.cjs');
  const updater = createLinuxUpdater(process.env.APPIMAGE ? 'AppImage' : 'deb', library);
  updater.disableDifferentialDownload = true;
  const dialogs = [];
  const update = createNativeUpdater({
    updater, setProgress: () => {},
    showMessageBox: async (dialog) => { dialogs.push(dialog); return { response: 0 }; },
    requestInstall: async (install) => {
      await writeFile(installed, 'ready');
      await requestInstall(install);
    },
  });
  assert.equal(typeof update, 'function', 'The packaged format must enable native updates');
  updater.setFeedURL({ provider: 'generic', url: new URL('bad/', feed).href });
  await update();
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].type, 'error', 'SHA512 mismatch must block installation');
  assert.equal(existsSync(installed), false);
  dialogs.length = 0;
  updater.setFeedURL({ provider: 'generic', url: feed.href });
  await update();
  assert.equal(dialogs.length, 1, 'Download and installation should not report errors');
  assert.match(dialogs[0].message, /ready to install/);
  assert.equal(existsSync(installed), true);
}
