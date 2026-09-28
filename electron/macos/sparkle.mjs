import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPARKLE_PUBLIC_KEY = 'nw/4r3hZptB1B4wkrMzIVtZW27/3cEhThf0NG42EHUk=';
export const SPARKLE_FEED = 'https://github.com/Skystellan/PaperCanvas/releases/latest/download/appcast.xml';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cache = path.join(root, 'release', 'sparkle');
const archive = path.join(cache, 'Sparkle-2.10.0.tar.xz');
const digest = 'c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c';

export async function prepareSparkle() {
  await mkdir(cache, { recursive: true });
  let bytes;
  try { bytes = await readFile(archive); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    execFileSync('curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
      '--max-time', '180', '--output', archive,
      'https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-2.10.0.tar.xz']);
    bytes = await readFile(archive);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Sparkle archive checksum mismatch.');
  execFileSync('tar', ['-xJf', archive, '-C', cache]);
  return cache;
}

export async function packageSparkle(output) {
  const source = await prepareSparkle();
  const contents = path.join(output, 'PaperCanvas.app', 'Contents');
  await cp(path.join(source, 'Sparkle.framework'), path.join(contents, 'Frameworks/Sparkle.framework'), {
    recursive: true, verbatimSymlinks: true,
  });
  const helper = path.join(contents, 'Helpers/PaperCanvas Updater.app/Contents');
  await mkdir(path.join(helper, 'MacOS'), { recursive: true });
  await mkdir(path.join(helper, 'Resources'), { recursive: true });
  await cp(path.join(root, 'src-tauri/icons/icon.icns'), path.join(helper, 'Resources/app.icns'));
  await writeFile(path.join(helper, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.papercanvas.updater</string>
<key>CFBundleName</key><string>PaperCanvas Updater</string>
<key>CFBundleExecutable</key><string>PaperCanvas Updater</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>app.icns</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>`);
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-mmacosx-version-min=13.0',
    '-F', source, '-framework', 'Cocoa', '-framework', 'Sparkle',
    '-Wl,-rpath,@executable_path/../../../../Frameworks',
    path.join(root, 'electron/macos/Updater.m'), '-o', path.join(helper, 'MacOS/PaperCanvas Updater')]);
  await cp(path.join(source, 'LICENSE'), path.join(contents, 'Resources/Sparkle-LICENSE'));
}
