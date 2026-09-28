import { packageSparkle, SPARKLE_FEED, SPARKLE_PUBLIC_KEY } from './macos/sparkle.mjs';
import { prepareWindowsStage, packageWindows } from './windows-package.mjs';
import { packager } from '@electron/packager';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = await mkdtemp(path.join(tmpdir(), 'papercanvas-chromium-'));
try {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({
    name: manifest.name, version: manifest.version, main: 'electron/main.mjs',
    description: 'PaperCanvas desktop', author: 'PaperCanvas', license: manifest.license,
  }));
  await cp(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
  await cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
  await cp(path.join(root, 'electron'), path.join(stage, 'electron'), {
    recursive: true, filter: (source) => !source.endsWith('.test.mjs'),
  });
  if (process.platform === 'win32') await prepareWindowsStage(stage);
  const paths = await packager({
    dir: stage, out: path.resolve(root, process.argv[2] || 'release'), overwrite: true,
    name: 'PaperCanvas', appBundleId: 'com.papercanvas.chromium',
    platform: process.platform, arch: process.arch, electronVersion: manifest.devDependencies.electron,
    icon: path.join(root, `src-tauri/icons/icon.${process.platform === 'win32' ? 'ico' : 'icns'}`),
    extendInfo: process.platform === 'darwin' ? {
      SUFeedURL: SPARKLE_FEED, SUPublicEDKey: SPARKLE_PUBLIC_KEY,
      SUEnableAutomaticChecks: false, SUSendProfileInfo: false,
      SUVerifyUpdateBeforeExtraction: true, SURequireSignedFeed: true,
    } : undefined,
    extraResource: [path.join(root, 'src-tauri/target/release',
      `paper-canvas-backend${process.platform === 'win32' ? '.exe' : ''}`)],
  });
  for (const output of paths) {
    if (process.platform === 'darwin') await packageSparkle(output);
    if (process.platform === 'win32') await packageWindows(output);
    console.log(output);
  }
} finally { await rm(stage, { recursive: true, force: true }); }
