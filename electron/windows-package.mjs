import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export async function prepareWindowsStage(stage) {
  const { build } = await import('esbuild');
  const result = await build({
    absWorkingDir: root,
    entryPoints: [require.resolve('electron-updater')],
    outfile: path.join(stage, 'electron/vendor/update.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'],
    legalComments: 'eof', metafile: true,
  });
  const packages = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    let directory = path.dirname(path.resolve(root, input));
    while (!existsSync(path.join(directory, 'package.json'))) {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`Missing package metadata for ${input}`);
      directory = parent;
    }
    packages.add(directory);
  }
  const notices = [];
  for (const directory of packages) {
    const { name, version, license, author } = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^(licen[sc]e|copying|notice)([.-]|$)/i.test(entry.name))
      .map((entry) => entry.name).sort();
    const texts = await Promise.all(files.map((file) => readFile(path.join(directory, file), 'utf8')));
    // lazy-val declares MIT in its manifest but ships no LICENSE file.
    if (!texts.length && license === 'MIT') {
      const mit = await readFile(path.join(root, 'LICENSE'), 'utf8');
      texts.push(`Author: ${typeof author === 'string' ? author : author?.name}\n\n${mit.slice(mit.indexOf('Permission is hereby granted'))}`);
    }
    notices.push(`${name}@${version} (${license || 'see license below'})\n${texts.join('\n')}`);
  }
  await writeFile(path.join(stage, 'electron/vendor/update-LICENSES.txt'), notices.sort().join('\n\n---\n\n'));
}

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
