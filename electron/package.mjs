import { packageSparkle, SPARKLE_FEED, SPARKLE_PUBLIC_KEY } from './macos/sparkle.mjs';
import { packageWindows } from './windows-package.mjs';
import { prepareUpdaterStage } from './updater-package.mjs';
import { packageLinux } from './linux-package.mjs';
import { packager } from '@electron/packager';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = await mkdtemp(path.join(tmpdir(), 'papercanvas-chromium-'));
try {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({
    name: manifest.name, version: manifest.version, main: 'electron/main.mjs',
    description: 'PaperCanvas desktop', author: 'PaperCanvas', license: manifest.license,
    desktopName: 'paper-canvas.desktop',
  }));
  await cp(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
  await cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
  await cp(path.join(root, 'electron'), path.join(stage, 'electron'), {
    recursive: true, filter: (source) => !source.endsWith('.test.mjs'),
  });
  const mcpBundle = path.join(stage, 'papercanvas-mcp.mjs');
  await build({ entryPoints: [path.join(root, 'mcp/server.mjs')], outfile: mcpBundle,
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  });
  // Packaged smoke tests exercise the shipped MCP entry without repository dependencies.
  await build({ entryPoints: [path.join(root, 'electron/research-smoke.mjs')],
    outfile: path.join(stage, 'electron/research-smoke.mjs'), bundle: true,
    platform: 'node', format: 'esm', target: 'node22', external: ['electron'],
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  });
  if (['win32', 'linux'].includes(process.platform)) await prepareUpdaterStage(stage);
  if (process.platform === 'linux') await cp(path.join(root, 'src-tauri/icons/icon.png'), path.join(stage, 'icon.png'));
  const paths = await packager({
    dir: stage, out: path.resolve(root, process.argv[2] || 'release'), overwrite: true,
    name: 'PaperCanvas', appBundleId: 'com.papercanvas.chromium',
    executableName: process.platform === 'linux' ? 'paper-canvas' : undefined,
    platform: process.platform, arch: process.arch, electronVersion: manifest.devDependencies.electron,
    icon: process.platform === 'linux' ? undefined : path.join(root, `src-tauri/icons/icon.${process.platform === 'win32' ? 'ico' : 'icns'}`),
    extendInfo: process.platform === 'darwin' ? {
      SUFeedURL: SPARKLE_FEED, SUPublicEDKey: SPARKLE_PUBLIC_KEY,
      SUEnableAutomaticChecks: false, SUSendProfileInfo: false,
      SUVerifyUpdateBeforeExtraction: true, SURequireSignedFeed: true,
    } : undefined,
    extraResource: [mcpBundle, path.join(root, 'src-tauri/target/release',
      `paper-canvas-backend${process.platform === 'win32' ? '.exe' : ''}`)],
  });
  for (const output of paths) {
    if (process.platform === 'darwin') await packageSparkle(output);
    if (process.platform === 'win32') await packageWindows(output);
    if (process.platform === 'linux') await packageLinux(output);
    console.log(output);
  }
} finally { await rm(stage, { recursive: true, force: true }); }
