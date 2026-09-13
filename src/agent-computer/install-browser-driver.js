'use strict';

// Image-build input only: no runtime downloads or mutable package resolution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const VERSION = '1.63.0';
const INTEGRITY = 'rYCsBF/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC/bxgspzkjSfU+MweEMmPM8KJebG6nnyxo5mCg==';

function verifyArchive(buffer) {
  assert(Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length <= 16 * 1024 * 1024);
  assert.equal(createHash('sha512').update(buffer).digest('base64'), INTEGRITY, 'Pinned Playwright archive integrity mismatch.');
}

async function install() {
  assert.equal(process.cwd(), '/opt/lilly-browser');
  const response = await fetch(`https://registry.npmjs.org/playwright-core/-/playwright-core-${VERSION}.tgz`,
    { signal: AbortSignal.timeout(60000), redirect: 'error' });
  assert(response.ok); assert(Number(response.headers.get('content-length')) <= 16 * 1024 * 1024);
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length; assert(length <= 16 * 1024 * 1024); chunks.push(chunk);
  }
  const archive = Buffer.concat(chunks); verifyArchive(archive);
  const archivePath = '/opt/lilly-browser/driver.tgz';
  const packagePath = '/opt/lilly-browser/node_modules/playwright-core';
  fs.mkdirSync(packagePath, { recursive: true }); fs.writeFileSync(archivePath, archive, { flag: 'wx' });
  execFileSync('/bin/tar', ['-xzf', archivePath, '--strip-components=1', '-C', packagePath], { timeout: 30000, stdio: 'inherit' });
  assert.equal(require(`${packagePath}/package.json`).version, VERSION);
  fs.unlinkSync(archivePath);
}

if (require.main === module) install().catch(() => { process.stderr.write('Pinned browser driver installation failed.\n'); process.exitCode = 1; });
module.exports = { VERSION, INTEGRITY, verifyArchive };
