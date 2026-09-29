import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export async function prepareUpdaterStage(stage) {
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

