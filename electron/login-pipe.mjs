// Chrome's private debugging pipe: no TCP listener, browser extension or web endpoint.
// Messages are UTF-8 JSON separated by NUL, on the child's file descriptors 3/4.
export class LoginPipe {
  constructor(child, timeout = 15_000) {
    this.child = child;
    this.timeout = timeout;
    this.sequence = 0;
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', (data) => {
      this.buffer += data;
      let end;
      while ((end = this.buffer.indexOf('\0')) !== -1) {
        const message = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const reply = JSON.parse(message);
          const request = this.pending.get(reply.id);
          if (!request) continue;
          this.pending.delete(reply.id);
          clearTimeout(request.timer);
          // Protocol errors may contain request data. Never forward them to the UI/logs.
          if (reply.error) request.reject(new Error('无法读取专用登录窗口，请重新打开后再试。'));
          else request.resolve(reply.result);
        } catch { this.disconnect(); }
      }
    });
    for (const source of [child, child.stdio[3], child.stdio[4]]) {
      source.on('error', () => this.disconnect());
      source.on('close', () => this.disconnect());
    }
    child.on('exit', () => this.disconnect());
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('专用登录窗口已关闭，请重新打开。'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('专用登录窗口响应超时，请关闭该窗口后重试。'));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
  }

  disconnect() {
    this.closed = true;
    this.buffer = '';
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('专用登录窗口已关闭，请重新打开。'));
    }
    this.pending.clear();
  }

  close() {
    this.disconnect();
    this.child.stdio[3].destroy();
    this.child.stdio[4].destroy();
    // This process owns a separate profile. Never terminate the user's normal browser.
    if (this.child.exitCode === null) this.child.kill();
  }
}
