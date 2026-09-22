import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateChecker, isNewerVersion } from './updates.mjs';

const latest = { tag_name: 'v1.10.0', draft: false, prerelease: false };

function setup({ version = '1.9.9', isPackaged = true, smoke = false, release = latest,
  fetch, choice = 1, showMessageBox } = {}) {
  const requests = [];
  const dialogs = [];
  const opened = [];
  const updates = new UpdateChecker({
    version, isPackaged, smoke,
    fetch: async (...args) => {
      requests.push(args);
      return fetch ? fetch(...args) : { ok: true, json: async () => release };
    },
    showMessageBox: async (options) => {
      dialogs.push(options);
      return showMessageBox ? showMessageBox(options) : { response: choice };
    },
    openExternal: async (url) => { opened.push(url); },
  });
  return { updates, requests, dialogs, opened };
}

test('stable versions compare numeric components and ignore build metadata', () => {
  for (const [next, current, expected] of [
    ['v1.10.0', '1.9.9', true], ['1.9.10', '1.9.9', true],
    ['2.0.0', '1.100.100', true], ['0.2.0', '0.1.99', true],
    ['1.9.9', '1.10.0', false], ['1.99.99', '2.0.0', false],
    ['v1.10.0', '1.10.0', false], ['1.10.0+build.2', 'v1.10.0+build.1', false],
  ]) assert.equal(isNewerVersion(next, current), expected, `${next} versus ${current}`);
});

test('unsupported or malformed versions cannot become update notifications', () => {
  for (const value of [null, 123, {}, [], '', '1.2', '1.2.3.4', 'release-1.2.3',
    '01.2.3', '1.02.3', '1.2.03', '1.2.3-beta.1', '1.2.3-', '1.2.3+',
    '1.2.3+build..1', '1.2.3\n', ' 1.2.3', '1.2.3 ', '9007199254740992.0.0']) {
    assert.throws(() => isNewerVersion(value, '1.2.3'));
    assert.throws(() => isNewerVersion('1.2.3', value));
  }
});

test('packaged startup checks once, offers Later, and makes only the public request', async () => {
  const { updates, requests, dialogs, opened } = setup();
  await updates.check();
  await updates.check();
  assert.equal(requests.length, 1);
  const [url, options] = requests[0];
  assert.equal(url, 'https://api.github.com/repos/Skystellan/PaperCanvas/releases/latest');
  assert.deepEqual(Object.keys(options).sort(), ['credentials', 'headers', 'redirect', 'signal']);
  assert.deepEqual(options.headers, { Accept: 'application/vnd.github+json', 'User-Agent': 'PaperCanvas' });
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].type, 'info');
  assert.match(dialogs[0].message, /v1\.10\.0/);
  assert.match(dialogs[0].detail, /1\.9\.9/);
  assert.deepEqual(dialogs[0].buttons, ['View release', 'Later']);
  assert.equal(dialogs[0].defaultId, 1);
  assert.equal(dialogs[0].cancelId, 1);
  assert.deepEqual(opened, []);
});

test('development and smoke startup never fetch or show dialogs', async () => {
  for (const flags of [{ isPackaged: false }, { smoke: true }, { isPackaged: false, smoke: true }]) {
    const { updates, requests, dialogs } = setup(flags);
    await updates.check();
    assert.deepEqual(requests, []);
    assert.deepEqual(dialogs, []);
  }
});

test('View release opens only the fixed trusted page, ignoring response URLs', async () => {
  for (const html_url of ['javascript:alert(1)', 'file:///private/data',
    'https://github.com.evil.test/Skystellan/PaperCanvas/releases/latest',
    'https://github.com/other/repo/releases/latest', 'https://github.com@evil.test/', null]) {
    const { updates, opened } = setup({ choice: 0, release: { ...latest, html_url } });
    await updates.check({ manual: true });
    assert.deepEqual(opened, ['https://github.com/Skystellan/PaperCanvas/releases/latest']);
  }
});

test('current or older releases are quiet automatically and report up to date manually', async () => {
  for (const tag_name of ['v1.9.9', 'v1.9.9+build.2', 'v1.9.8', 'v0.99.99']) {
    const { updates, dialogs, opened } = setup({ release: { ...latest, tag_name } });
    await updates.check();
    assert.deepEqual(dialogs, []);
    await updates.check({ manual: true });
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].message, 'PaperCanvas is up to date.');
    assert.deepEqual(opened, []);
  }
});

test('Later allows an explicit recheck without another automatic prompt', async () => {
  const { updates, requests, dialogs } = setup();
  await updates.check();
  await updates.check({ manual: true });
  await updates.check();
  assert.equal(requests.length, 2);
  assert.equal(dialogs.length, 2);
});

test('manual checks work in development without enabling automatic checks', async () => {
  const { updates, requests, dialogs } = setup({ isPackaged: false });
  await updates.check({ manual: true });
  await updates.check();
  assert.equal(requests.length, 1);
  assert.equal(dialogs.length, 1);
});

test('external JSON must describe a stable release with explicit boolean flags', async () => {
  for (const release of [null, [], 'v2.0.0', {}, { tag_name: 'v2.0.0' },
    { ...latest, draft: true }, { ...latest, prerelease: true },
    { ...latest, draft: 'false' }, { ...latest, prerelease: 0 },
    { ...latest, tag_name: 200 }, { ...latest, tag_name: 'v2.0.0-beta.1' },
    { ...latest, tag_name: '<script>alert(1)</script>' }]) {
    const { updates, dialogs, opened } = setup({ release });
    await updates.check();
    assert.deepEqual(dialogs, []);
    await updates.check({ manual: true });
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].message, 'Could not check for updates.');
    assert.deepEqual(opened, []);
  }
});

test('network, rate limit, missing release and JSON errors are quiet automatically, visible manually', async () => {
  for (const fetch of [
    async () => { throw new Error('Offline: private diagnostic'); },
    ...[404, 403, 429, 503].map((status) => async () => ({ ok: false, status })),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('Not JSON'); } }),
  ]) {
    const { updates, requests, dialogs, opened } = setup({ fetch });
    await updates.check();
    await updates.check();
    assert.equal(requests.length, 1);
    assert.deepEqual(dialogs, []);
    await updates.check({ manual: true });
    assert.equal(requests.length, 2);
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].message, 'Could not check for updates.');
    assert.doesNotMatch(dialogs[0].detail, /private diagnostic/);
    assert.deepEqual(opened, []);
  }
});

test('overlapping automatic/manual requests share one fetch and retain manual feedback', async () => {
  for (const fail of [false, true]) {
    const result = Promise.withResolvers();
    const { updates, requests, dialogs } = setup({ fetch: () => result.promise });
    const automatic = updates.check();
    const manual = updates.check({ manual: true });
    const repeated = updates.check({ manual: true });
    assert.equal(automatic, manual);
    assert.equal(manual, repeated);
    assert.equal(requests.length, 1);
    assert.deepEqual(dialogs, []);
    if (fail) result.reject(new Error('Offline'));
    else result.resolve({ ok: true, json: async () => ({ ...latest, tag_name: 'v1.9.9' }) });
    await Promise.all([automatic, manual, repeated]);
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].message, fail ? 'Could not check for updates.' : 'PaperCanvas is up to date.');
  }
});

test('an open async dialog does not cause duplicate checks or dialogs', async () => {
  const dismissed = Promise.withResolvers();
  const displayed = Promise.withResolvers();
  const { updates, requests, dialogs } = setup({ showMessageBox: () => {
    displayed.resolve();
    return dismissed.promise;
  } });
  const check = updates.check();
  await displayed.promise;
  assert.equal(updates.check({ manual: true }), check);
  assert.equal(requests.length, 1);
  assert.equal(dialogs.length, 1);
  dismissed.resolve({ response: 1 });
  await check;
});

test('the 10-second abort signal covers both the fetch and response body, without retries', async (t) => {
  for (const manual of [false, true]) {
    for (const body of [false, true]) {
      await t.test(`${manual ? 'manual' : 'automatic'} ${body ? 'body' : 'fetch'} timeout`, async (t) => {
        const controller = new AbortController();
        t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
          assert.equal(milliseconds, 10_000);
          return controller.signal;
        });
        const waiting = Promise.withResolvers();
        const { updates, requests, dialogs } = setup({ fetch: async (_url, { signal }) => {
          const stalled = () => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            waiting.resolve();
          });
          return body ? { ok: true, json: stalled } : stalled();
        } });
        const check = updates.check({ manual });
        await waiting.promise;
        controller.abort(new DOMException('Timed out', 'TimeoutError'));
        await check;
        assert.equal(requests.length, 1);
        assert.equal(dialogs.length, manual ? 1 : 0);
        if (manual) assert.equal(dialogs[0].message, 'Could not check for updates.');
      });
    }
  }
});
