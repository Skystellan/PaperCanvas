const { contextBridge, ipcRenderer, webUtils } = require('electron');

const events = new Set(['paper-web-chat-updated', 'paper-web-chat-error', 'paper-web-chat-login-required', 'paper-web-chat-load-state', 'codex-stream', 'native-close-requested']);
contextBridge.exposeInMainWorld('paperCanvas', {
  async invoke(command, args = {}) {
    const response = await ipcRenderer.invoke('paper-canvas:invoke', command, args);
    // Preserve Rust's string errors (including NOTE_FILE_CHANGED) across IPC.
    if (response.error !== undefined) throw response.error;
    return response.result;
  },
  on(event, callback) {
    if (!events.has(event)) throw new Error('Unknown PaperCanvas event.');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
  getPathForFile(file) {
    const filePath = webUtils.getPathForFile(file);
    if (filePath && ipcRenderer.sendSync('paper-canvas:grant-file', filePath)) return filePath;
    return '';
  },
});
