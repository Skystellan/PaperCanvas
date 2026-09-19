import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electron from 'electron';

const directory = await mkdtemp(path.join(tmpdir(), 'papercanvas-smoke-'));
console.log(`Smoke artifacts: ${directory}`);
const env = { ...process.env, PAPERCANVAS_DATA_DIR: directory, PAPERCANVAS_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['electron/main.mjs'], { env, stdio: 'inherit' });
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 90_000);
child.on('exit', (code) => { clearTimeout(timeout); process.exitCode = code ?? 1; });
