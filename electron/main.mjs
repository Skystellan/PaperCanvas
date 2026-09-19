import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Backend } from './backend.mjs';
import { Chats, CHAT_PARTITION } from './chats.mjs';
import { APP_URL, assetPath, isHttps, isLocalFrame } from './security.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = process.env.PAPERCANVAS_DATA_DIR || path.join(
  app.getPath('appData'), 'com.papercanvas.desktop',
);
app.setName('PaperCanvas');
app.setPath('userData', path.join(dataDirectory, 'chromium'));
protocol.registerSchemesAsPrivileged([{ scheme: 'paper-canvas', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);

let mainWindow;
let backend;
let chats;
let allowClose = false;
let layoutQueue = Promise.resolve();
const fileGrants = new Set();
const commands = new Set([
  'database_load', 'database_select', 'database_execute',
  'load_markdown_note', 'save_markdown_note', 'list_paper_web_chats', 'save_paper_web_chat',
  'reconcile_pdf_storage', 'codex_runtime_status', 'start_codex_turn', 'cancel_codex_turn',
]);

function emit(event, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, payload);
}

async function invoke(command, args) {
  switch (command) {
    case 'read_file': {
      // Stream PDF bytes through Chromium rather than expanding them into a JSON number array.
      const file = await backend.call('resolve_pdf_path', args);
      const response = await net.fetch(pathToFileURL(file).href);
      if (!response.ok) throw new Error('The local PDF could not be read.');
      return new Uint8Array(await response.arrayBuffer());
    }
    case 'open_pdf_dialog': {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (result.canceled) return null;
      result.filePaths.forEach((file) => fileGrants.add(file));
      return result.filePaths;
    }
    case 'import_pdf':
      if (!fileGrants.has(args.sourcePath)) throw new Error('Choose or drop the PDF before importing.');
      return backend.call(command, args);
    case 'delete_paper': {
      const related = await backend.call('list_paper_web_chats', { paperId: args.paperId });
      await backend.call(command, args);
      chats.removePaper(related.map((chat) => chat.id));
      return;
    }
    case 'reveal_markdown_note': {
      const file = await backend.call(command, args);
      shell.showItemInFolder(file);
      return;
    }
    case 'layout_paper_web_chat': {
      const next = layoutQueue.then(() => chats.layout(args.id, args.bounds));
      layoutQueue = next.catch(() => {});
      return next;
    }
    case 'restore_paper_web_chat': return chats.restore(args.id);
    case 'reload_paper_web_chat': return chats.reload(args.id);
    case 'open_paper_web_chat_external': {
      const chat = await backend.call('get_paper_web_chat', { id: args.id });
      const url = chat.url || 'https://chatgpt.com/';
      if (!isHttps(url) || new URL(url).hostname !== 'chatgpt.com') throw new Error('Invalid conversation URL.');
      await shell.openExternal(url);
      return;
    }
    case 'window_destroy':
      allowClose = true;
      // Let the IPC response reach the save-on-close coordinator before destroying its renderer.
      setImmediate(() => mainWindow.close());
      return;
    default:
      if (!commands.has(command)) throw new Error('Unknown PaperCanvas command.');
      return backend.call(command, args);
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.on('before-quit', (event) => {
    if (mainWindow && !mainWindow.isDestroyed() && !allowClose) {
      event.preventDefault();
      mainWindow.close();
    }
  });
  app.on('window-all-closed', () => app.quit());

  // Do not await readiness at module scope: Electron waits for its ESM entry to finish first.
  void app.whenReady().then(async () => {
  await mkdir(app.getPath('userData'), { recursive: true });
  protocol.handle('paper-canvas', async (request) => {
    try {
      const response = await net.fetch(pathToFileURL(assetPath(request.url, path.join(root, 'dist'))).href);
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
      return new Response(response.body, { status: response.status, headers });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  const localClipboard = (contents, permission) => permission === 'clipboard-sanitized-write' &&
    contents === mainWindow?.webContents && contents.getURL() === APP_URL;
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(localClipboard(contents, permission)));
  session.defaultSession.setPermissionCheckHandler(localClipboard);
  const chatSession = session.fromPartition(CHAT_PARTITION);
  chatSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  chatSession.setPermissionCheckHandler(() => false);
  // Use the normal Chromium UA; Electron's product suffix needlessly selects unsupported-browser paths.
  chatSession.setUserAgent(chatSession.getUserAgent().replace(/\s(?:Electron|PaperCanvas|paper-canvas)\/\S+/g, ''));

  mainWindow = new BrowserWindow({
    title: 'PaperCanvas', width: 1280, height: 800, minWidth: 800, minHeight: 560,
    backgroundColor: '#fffdf8', show: false,
    webPreferences: { preload: path.join(root, 'electron/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  const resources = app.isPackaged ? process.resourcesPath : root;
  const binary = app.isPackaged
    ? path.join(resources, 'paper-canvas-backend')
    : path.join(root, 'src-tauri/target/debug/paper-canvas-backend');
  backend = new Backend(binary, dataDirectory, resources, emit);
  chats = new Chats(mainWindow, backend, emit);
  ipcMain.handle('paper-canvas:invoke', async (event, command, args = {}) => {
    if (!isLocalFrame(event, mainWindow)) return { error: 'Only the local reader can access PaperCanvas.' };
    try { return { result: await invoke(command, args) }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  });
  ipcMain.on('paper-canvas:grant-file', (event, file) => {
    const permitted = isLocalFrame(event, mainWindow) && typeof file === 'string' && path.isAbsolute(file);
    if (permitted) fileGrants.add(file);
    event.returnValue = permitted;
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== APP_URL) {
      event.preventDefault();
      if (isHttps(url)) void shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttps(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('close', (event) => {
    if (!allowClose) { event.preventDefault(); emit('native-close-requested'); }
  });
  mainWindow.on('closed', () => { chats.close(); backend.close(); });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { role: 'windowMenu' },
  ]));
  await mainWindow.loadURL(APP_URL);
  if (!app.isPackaged && process.env.PAPERCANVAS_SMOKE === '1') {
    try {
      const { smoke } = await import('./smoke.mjs');
      await smoke({ window: mainWindow, backend, chats, dataDirectory, chatSession });
      backend.close();
      app.exit(0);
    } catch (error) {
      console.error(error);
      backend.close();
      app.exit(1);
    }
  }
  }).catch((error) => {
    console.error(error);
    backend?.close();
    app.exit(1);
  });
}
