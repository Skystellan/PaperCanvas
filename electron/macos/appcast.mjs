import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSparkle, SPARKLE_PUBLIC_KEY } from './sparkle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Only stable versions can be released.');
const directory = path.resolve(process.argv[2] || path.join(root, 'release'));
const name = `PaperCanvas-${version}-macOS-arm64.zip`;
const archive = path.join(directory, name);
const sparkle = await prepareSparkle();
const signingArguments = process.env.SPARKLE_PRIVATE_KEY ? ['--ed-key-file', '-'] : ['--account', 'PaperCanvas'];
const sign = (file, extra = []) => execFileSync(path.join(sparkle, 'bin/sign_update'), [...signingArguments, ...extra, file], {
  encoding: 'utf8', input: process.env.SPARKLE_PRIVATE_KEY,
}).trim();
const signature = sign(archive, ['-p']);
const key = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(SPARKLE_PUBLIC_KEY, 'base64'),
]) });
if (!verify(null, await readFile(archive), key, Buffer.from(signature, 'base64'))) {
  throw new Error('Signing key does not match the public key embedded in PaperCanvas.');
}
const feed = path.join(directory, 'appcast.xml');
await writeFile(feed, `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
<title>PaperCanvas</title><link>https://github.com/Skystellan/PaperCanvas</link><description>PaperCanvas updates</description>
<item><title>PaperCanvas ${version}</title><pubDate>${new Date().toUTCString()}</pubDate>
<sparkle:version>${version}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString>
<sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
<description>PaperCanvas ${version}. Your local papers, notes, and sign-in data are preserved.</description>
<enclosure url="https://github.com/Skystellan/PaperCanvas/releases/download/v${version}/${name}"
length="${(await stat(archive)).size}" type="application/octet-stream" sparkle:edSignature="${signature}"/>
</item></channel></rss>\n`);
sign(feed);
console.log(`Signed ${name} and appcast.xml`);
