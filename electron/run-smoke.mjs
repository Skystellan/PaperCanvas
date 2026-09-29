import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'papercanvas-smoke-论文 空格-'));
console.log(`Smoke artifacts: ${directory}`);
const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1', PAPERCANVAS_DATA_DIR: directory, PAPERCANVAS_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.argv[2];
const executable = packaged || (await import('electron')).default;
const child = spawn(executable, packaged ? [] : ['electron/main.mjs'], { env, stdio: 'inherit' });
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  console.error('Desktop smoke test timed out after 90 seconds.');
  child.kill('SIGKILL');
}, 90_000);
child.on('error', (error) => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
child.on('exit', (code) => { clearTimeout(timeout); process.exitCode = timedOut ? 1 : code ?? 1; });
