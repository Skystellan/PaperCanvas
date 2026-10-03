import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const MAX_RESEARCH_MESSAGE_BYTES = 4 * 1024 * 1024;
export const RESEARCH_DESCRIPTOR = 'research-bridge.json';

export function researchDataDirectory() {
  const appData = process.platform === 'darwin' ? path.join(homedir(), 'Library/Application Support')
    : process.platform === 'win32' ? process.env.APPDATA || path.join(homedir(), 'AppData/Roaming')
      : process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return process.env.PAPERCANVAS_DATA_DIR || path.join(appData, 'com.papercanvas.desktop');
}

// Only the small result of the explicitly requested tool crosses this connection.
export async function callResearchTool(tool, args, { dataDirectory = researchDataDirectory() } = {}) {
  let descriptor;
  try { descriptor = JSON.parse(await readFile(path.join(dataDirectory, RESEARCH_DESCRIPTOR), 'utf8')); }
  catch { throw new Error('APP_NOT_RUNNING: Open PaperCanvas before using its research tools.'); }
  if (descriptor.version !== 1 || typeof descriptor.socket !== 'string' || typeof descriptor.token !== 'string') {
    throw new Error('INVALID_CONNECTION: Restart PaperCanvas to refresh its local connection.');
  }
  const request = JSON.stringify({ token: descriptor.token, tool, args });
  if (Buffer.byteLength(request) > MAX_RESEARCH_MESSAGE_BYTES) throw new Error('Research request is too large.');
  return new Promise((resolve, reject) => {
    const socket = connect(descriptor.socket);
    let buffer = '';
    let bytes = 0;
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(30_000, () => finish(new Error('APP_TIMEOUT: PaperCanvas did not respond. Retry imports with the same requestId.')));
    socket.on('connect', () => socket.write(`${request}\n`));
    socket.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_RESEARCH_MESSAGE_BYTES) return finish(new Error('Research response is too large.'));
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        finish(response.error ? new Error(response.error) : null, response.result);
      } catch { finish(new Error('INVALID_RESPONSE: PaperCanvas returned an invalid response.')); }
    });
    socket.on('error', () => finish(new Error('APP_NOT_RUNNING: Open PaperCanvas and retry.')));
    socket.on('end', () => { if (!finished) finish(new Error('APP_DISCONNECTED: Retry imports with the same requestId.')); });
  });
}
