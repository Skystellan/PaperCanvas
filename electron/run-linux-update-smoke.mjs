import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const release = path.resolve(process.argv[2] || 'release');
const executable = process.argv[3];
assert.ok(executable, 'Pass the installed DEB executable or an AppImage');
const directory = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), "papercanvas-smoke-update-论文 O'Brien-"));
console.log(`Update smoke artifacts: ${directory}`);
const files = [];
for (const name of await readdir(release)) {
  if (!/\.(deb|AppImage)$/.test(name)) continue;
  const data = await readFile(path.join(release, name));
  files.push({ url: name, size: data.length, sha512: createHash('sha512').update(data).digest('base64') });
}
assert.equal(files.length, 2);
// Reinstall this build through a synthetic newer feed; never publish the fixture.
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname.endsWith('/latest-linux.yml')) {
    response.setHeader('Content-Type', 'application/yaml');
    response.end(JSON.stringify({ version: '99.0.0', files: files.map(file => ({
      ...file, ...(url.pathname.startsWith('/bad/') ? { sha512: Buffer.alloc(64).toString('base64') } : {}),
    })), releaseDate: new Date().toISOString() }));
    return;
  }
  const file = files.find(file => url.pathname === `/${file.url}` || url.pathname === `/bad/${file.url}`);
  if (!file) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Length', file.size);
  createReadStream(path.join(release, file.url)).pipe(response);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let child;
let timeout;
try {
  let command = path.resolve(executable);
  const env = {
    ...process.env, PAPERCANVAS_SMOKE: '1', PAPERCANVAS_DATA_DIR: directory,
    PAPERCANVAS_UPDATE_SMOKE: `http://127.0.0.1:${server.address().port}/`,
    XDG_CACHE_HOME: path.join(directory, 'cache'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (command.endsWith('.AppImage')) {
    const copy = path.join(directory, 'PaperCanvas.AppImage');
    await copyFile(command, copy);
    await chmod(copy, 0o755);
    command = copy;
    env.APPIMAGE_EXTRACT_AND_RUN = '1';
  }
  child = spawn(command, [], { env, stdio: 'inherit' });
  timeout = setTimeout(() => child.kill(), 180_000);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, 'Update process must finish successfully');
  const success = path.join(directory, 'update-success');
  for (let i = 0; i < 150 && !existsSync(success); i++) await delay(200);
  assert.ok(existsSync(success), 'Installed app must relaunch and verify its data');
  console.log(await readFile(success, 'utf8'));
} finally {
  clearTimeout(timeout);
  child?.kill();
  server.close();
}
