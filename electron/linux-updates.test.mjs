import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinuxUpdater } from './linux-updates.mjs';

const library = { DebUpdater: class {}, AppImageUpdater: class {} };

test('AppImage selection takes precedence over the shared DEB marker', () => {
  assert.ok(createLinuxUpdater('AppImage', library) instanceof library.AppImageUpdater);
});

test('Ubuntu installation passes the verified path literally to the system authorization helper', () => {
  const commands = [];
  const updater = createLinuxUpdater('deb', library, (...args) => commands.push(args));
  const file = "/home/论文 O'Brien/cache/$(literal) update.deb";
  updater.downloadedUpdateHelper = { file };
  let relaunched = false;
  updater.app = { relaunch: () => { relaunched = true; } };
  assert.equal(updater.doInstall({ isForceRunAfter: true }), true);
  assert.deepEqual(commands, [['/usr/bin/pkexec', ['/usr/bin/apt-get', 'install', '--reinstall', '--no-remove', '-y', '--', file]]]);
  assert.equal(relaunched, true);
});

test('cancelled authorization or failed apt installation never retries or relaunches', () => {
  let commands = 0;
  const updater = createLinuxUpdater('deb', library, () => { commands++; throw new Error('Cancelled'); });
  updater.downloadedUpdateHelper = { file: '/cache/update.deb' };
  updater.app = { relaunch: () => assert.fail('Must remain open') };
  assert.throws(() => updater.doInstall({ isForceRunAfter: true }), /Cancelled/);
  assert.equal(commands, 1);
});
