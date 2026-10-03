import { createServer } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_RESEARCH_MESSAGE_BYTES, RESEARCH_DESCRIPTOR } from './research-bridge-client.mjs';

const TOOLS = new Set(['import_research_batch', 'read_research_context', 'save_paper_code_reviews']);

export function validateResearchTool(tool, args) {
  if (!TOOLS.has(tool)) throw new Error('Unknown research tool.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  if (tool === 'read_research_context') {
    if (!['selected_papers', 'gap_analysis', 'code_review'].includes(args.intent)) throw new Error('Context requires an explicit selected_papers, gap_analysis or code_review intent.');
    if (args.paperIds !== undefined && (!Array.isArray(args.paperIds) || args.paperIds.length > 100 || args.paperIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 200))) {
      throw new Error('Invalid paperIds.');
    }
  }
}

export async function startResearchBridge({ dataDirectory, callTool }) {
  const nonce = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('hex');
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\papercanvas-${nonce}`
    : path.join(tmpdir(), `pc-${nonce}.sock`);
  const descriptorPath = path.join(dataDirectory, RESEARCH_DESCRIPTOR);
  const connections = new Set();
  let queue = Promise.resolve();
  const server = createServer(socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(30_000, () => socket.destroy());
    socket.setEncoding('utf8');
    let buffer = '';
    let bytes = 0;
    let received = false;
    socket.on('data', chunk => {
      if (received) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_RESEARCH_MESSAGE_BYTES) { socket.destroy(); return; }
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      received = true;
      const respond = response => { if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`); };
      let request;
      try {
        request = JSON.parse(buffer.slice(0, end));
        const supplied = Buffer.from(typeof request.token === 'string' ? request.token : '');
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Unauthorized local connection.');
        validateResearchTool(request.tool, request.args);
      } catch (error) { respond({ error: error.message }); return; }
      // Serialize research calls while the renderer coordinates its pending saves.
      const operation = queue.then(() => {
        if (socket.destroyed) throw new Error('Research caller disconnected.');
        return callTool(request.tool, request.args);
      });
      queue = operation.catch(() => {});
      void operation.then(result => respond({ result }), error => respond({ error: String(error.message || error) }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  try {
    if (process.platform !== 'win32') await chmod(socketPath, 0o600);
    await mkdir(dataDirectory, { recursive: true });
    const temporary = `${descriptorPath}.${nonce}`;
    await writeFile(temporary, JSON.stringify({ version: 1, socket: socketPath, token }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, descriptorPath);
  } catch (error) { server.close(); throw error; }
  return {
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await rm(descriptorPath, { force: true });
    },
  };
}

// Requests go only to the trusted reader frame. Its reply comes through the
// existing isLocalFrame IPC guard; neither the remote chat nor MCP can forge it.
export function createRendererResearchRequests(send) {
  let ready = false;
  const pending = new Map();
  return {
    setReady(value) { ready = value; },
    request(tool, args) {
      if (!ready) return Promise.reject(new Error('APP_NOT_READY: Wait for the PaperCanvas workspace to load.'));
      return new Promise((resolve, reject) => {
        const id = randomBytes(16).toString('hex');
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('APP_TIMEOUT: Retry imports with the same requestId.')); }, 25_000);
        pending.set(id, { resolve, reject, timer });
        send('research-tool-request', { id, tool, args });
      });
    },
    reply({ id, result, error }) {
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      clearTimeout(call.timer);
      if (error) call.reject(new Error(String(error))); else call.resolve(result);
    },
    reset() {
      ready = false;
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('APP_RELOADING: Retry imports with the same requestId.')); }
      pending.clear();
    },
  };
}
