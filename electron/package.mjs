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
    description: 'PaperCanvas desktop', author: 'PaperCanvas',
  }));
  await cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
  await cp(path.join(root, 'electron'), path.join(stage, 'electron'), {
    recursive: true, filter: (source) => !source.endsWith('.test.mjs') && !source.endsWith('smoke.mjs'),
  });
  const paths = await packager({
    dir: stage, out: path.resolve(root, process.argv[2] || 'release'), overwrite: true,
    name: 'PaperCanvas', appBundleId: 'com.papercanvas.chromium',
    platform: 'darwin', arch: process.arch, electronVersion: manifest.devDependencies.electron,
    icon: path.join(root, 'src-tauri/icons/icon.icns'),
    download: { cacheRoot: '/private/tmp/papercanvas-electron-cache' },
    extraResource: [path.join(root, 'src-tauri/target/debug/paper-canvas-backend')],
  });
  for (const output of paths) console.log(output);
} finally { await rm(stage, { recursive: true, force: true }); }
