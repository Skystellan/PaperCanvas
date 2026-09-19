import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// A private pipe keeps the existing Rust storage and Codex implementation local.
export class Backend {
  constructor(binary, dataDirectory, resources, onEvent) {
    this.pending = new Map();
    this.sequence = 0;
    this.child = spawn(binary, ['--data-dir', dataDirectory, '--resources', resources], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error('The local PaperCanvas backend returned an invalid response.')); return; }
      if (message.event) { onEvent(message.event, message.payload); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    // Never forward potentially sensitive backend diagnostics to remote web pages.
    this.child.stderr.resume();
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('The local PaperCanvas backend stopped.')));
    this.child.stdin.on('error', (error) => this.fail(error));
  }

  call(command, args = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, command, args })}\n`, (error) => {
        if (error) { this.pending.delete(id); reject(error); }
      });
    });
  }

  fail(error) {
    this.failure = error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  close() {
    this.fail(new Error('PaperCanvas is closing.'));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 3000);
    timer.unref();
    this.child.once('exit', () => clearTimeout(timer));
  }
}
