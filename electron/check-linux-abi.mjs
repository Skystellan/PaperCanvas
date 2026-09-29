import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';

// Check every shipped ELF, including Electron helpers and shared libraries.
// A newer build host can otherwise silently break Ubuntu 20.04 again.
async function check(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { count += await check(file); continue; }
    if (!entry.isFile()) continue;
    const handle = await open(file);
    const magic = Buffer.alloc(4);
    try { await handle.read(magic, 0, 4, 0); } finally { await handle.close(); }
    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
    const info = execFileSync('objdump', ['-p', file], { encoding: 'utf8' });
    const versions = [...info.matchAll(/\bGLIBC_(\d+)\.(\d+)(?:\.(\d+))?\b/g)]
      .map(match => match.slice(1).map(value => Number(value || 0)))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const maximum = versions.at(-1);
    if (maximum) {
      assert.ok(maximum[0] < 2 || (maximum[0] === 2 && maximum[1] <= 31),
        `${file} needs GLIBC_${maximum.join('.')}, above the Ubuntu 20.04 baseline (2.31)`);
      console.log(`${entry.name}: GLIBC_${maximum.join('.')}`);
    }
    count++;
  }
  return count;
}

const count = await check(path.resolve(process.argv[2] || 'release/PaperCanvas-linux-x64'));
assert.ok(count > 0, 'No Linux ELF binaries found');
console.log(`${count} ELF binaries meet the glibc 2.31 baseline`);
