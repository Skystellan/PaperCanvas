export const RELEASE_API_URL = 'https://api.github.com/repos/Skystellan/PaperCanvas/releases/latest';
export const RELEASE_URL = 'https://github.com/Skystellan/PaperCanvas/releases/latest';
const CHECK_TIMEOUT_MS = 10_000;

function stableVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || match[0] !== value) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function isNewerVersion(latest, current) {
  const next = stableVersion(latest);
  const installed = stableVersion(current);
  if (!next || !installed) throw new Error('Expected stable semantic versions.');
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

export class UpdateChecker {
  constructor({ version, isPackaged, smoke = false, showMessageBox, openExternal, fetch = globalThis.fetch }) {
    Object.assign(this, { version, isPackaged, smoke, showMessageBox, openExternal, fetch });
    this.automaticChecked = false;
    this.manualRequested = false;
    this.pending = null;
  }

  check({ manual = false } = {}) {
    if (!manual) {
      if (!this.isPackaged || this.smoke || this.automaticChecked) return Promise.resolve();
      this.automaticChecked = true;
    }
    // A menu click during startup reuses the request, but still gets manual feedback.
    this.manualRequested ||= manual;
    if (!this.pending) {
      this.pending = this.run().finally(() => {
        this.pending = null;
        this.manualRequested = false;
      });
    }
    return this.pending;
  }

  async run() {
    try {
      // Node's fetch has no browser cookie jar; no app data or version is sent.
      const response = await this.fetch(RELEASE_API_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PaperCanvas' },
        credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error('Release check failed.');
      const release = await response.json();
      if (!release || typeof release !== 'object' || Array.isArray(release) ||
          release.draft !== false || release.prerelease !== false || !stableVersion(release.tag_name)) {
        throw new Error('Invalid stable release.');
      }
      if (isNewerVersion(release.tag_name, this.version)) {
        const { response: choice } = await this.showMessageBox({
          type: 'info', title: 'PaperCanvas update available',
          message: `PaperCanvas ${release.tag_name} is available.`,
          detail: `You are using ${this.version}. View the release notes and download the update in your browser.`,
          buttons: ['View release', 'Later'], defaultId: 1, cancelId: 1,
        });
        // Never pass a URL from the network response to the OS.
        if (choice === 0) await this.openExternal(RELEASE_URL);
      } else if (this.manualRequested) {
        await this.showMessageBox({
          type: 'info', title: 'PaperCanvas updates', message: 'PaperCanvas is up to date.',
          detail: `You are using ${this.version}. No newer stable release is available.`, buttons: ['OK'],
        });
      }
    } catch {
      if (this.manualRequested) {
        await this.showMessageBox({
          type: 'info', title: 'PaperCanvas updates', message: 'Could not check for updates.',
          detail: 'Check your connection and try again later. GitHub may be unavailable or have no published stable release.',
          buttons: ['OK'],
        }).catch(() => {}); // The window may have closed while the check was running.
      }
    }
  }
}
