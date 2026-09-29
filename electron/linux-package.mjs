import { chmod, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export async function packageLinux(output) {
  // Packager preserves mkdtemp's 0700 on the bundle root. DEB/AppImage installs
  // it as root, so ordinary desktop users need read/traverse permission.
  await chmod(output, 0o755);
  const { build, Platform, Arch } = require('electron-builder');
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  return build({
    projectDir: root, prepackaged: output,
    targets: Platform.LINUX.createTarget(['deb', 'AppImage'], Arch[process.arch]), publish: 'never',
    config: {
      extends: null, appId: 'com.papercanvas.chromium', productName: 'PaperCanvas',
      electronVersion: manifest.devDependencies.electron,
      extraMetadata: {
        homepage: 'https://github.com/Skystellan/PaperCanvas',
        description: 'A local-first paper whiteboard, PDF reader and discussion workspace',
        desktopName: 'paper-canvas.desktop',
      },
      directories: { output: path.resolve(output, '..'), buildResources: path.join(root, 'src-tauri/icons') },
      linux: {
        executableName: 'paper-canvas', category: 'Office',
        icon: path.join(root, 'src-tauri/icons/icon.png'),
        maintainer: 'Skystellan <Skystellan@users.noreply.github.com>',
        artifactName: 'PaperCanvas-${version}-Linux-${arch}.${ext}',
        syncDesktopName: true,
      },
      // The legacy AppImage launcher otherwise adds --no-sandbox to its desktop entry.
      appImage: { executableArgs: [] },
      // Add the authorization helper without replacing builder's runtime dependencies.
      deb: { fpm: ['--depends', 'policykit-1 | pkexec'] },
      publish: {
        provider: 'github', owner: 'Skystellan', repo: 'PaperCanvas', protocol: 'https', private: false,
      },
    },
  });
}
