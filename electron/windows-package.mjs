import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// output is the directory returned by @electron/packager, not the release root.
export async function packageWindows(output) {
  const { build, Platform, Arch } = require('electron-builder');
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const stage = await mkdtemp(path.join(tmpdir(), 'papercanvas-nsis-'));
  try {
    const prepackaged = path.join(stage, 'app');
    // Builder can add resources; keep its installer input separate from the portable ZIP.
    await cp(output, prepackaged, { recursive: true });
    const publish = {
      provider: 'github', owner: 'Skystellan', repo: 'PaperCanvas', protocol: 'https', private: false,
    };
    // prepackaged skips builder's afterPack hook. JSON is valid YAML; this is its
    // standard update config, with the same cache name used by the NSIS installer.
    await writeFile(path.join(prepackaged, 'resources/app-update.yml'), JSON.stringify({
      ...publish, updaterCacheDirName: `${manifest.name}-updater`,
    }, null, 2));
    return await build({
      projectDir: root,
      prepackaged, targets: Platform.WINDOWS.createTarget('nsis', Arch[process.arch]), publish: 'never',
      config: {
        extends: null, appId: 'com.papercanvas.chromium', productName: 'PaperCanvas',
        electronVersion: manifest.devDependencies.electron,
        directories: { output: path.resolve(output, '..'), buildResources: path.join(root, 'src-tauri/icons') },
        win: { icon: path.join(root, 'src-tauri/icons/icon.ico') },
        nsis: {
          oneClick: true, perMachine: false,
          artifactName: 'PaperCanvas-${version}-Windows-${arch}-Setup.${ext}',
          uninstallDisplayName: 'PaperCanvas',
          deleteAppDataOnUninstall: false,
        },
        publish,
      },
    });
  } finally { await rm(stage, { recursive: true, force: true }); }
}
