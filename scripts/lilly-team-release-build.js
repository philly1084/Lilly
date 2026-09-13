'use strict';
const fs = require('node:fs'); const crypto = require('node:crypto'); const { execFileSync } = require('node:child_process');
const { checkReleaseStorage } = require('./lilly-release-storage-preflight');
const baseImage = 'ghcr.io/philly1084/lilly:sha-0fad485';
const inspected = JSON.parse(execFileSync('/usr/local/bin/k3s', ['crictl', 'inspecti', baseImage], { encoding: 'utf8', timeout: 30000 }));
const storage = checkReleaseStorage({ imageBytes: Number(inspected.status?.size) });
const root = fs.mkdtempSync('/tmp/lilly-team-release.');
function run(bin, args) { execFileSync(bin, args, { stdio: 'inherit', timeout: 600000 }); }
run('/usr/local/bin/k3s', ['ctr', 'images', 'export', '--platform', 'linux/arm64', `${root}/base.tar`, 'ghcr.io/philly1084/lilly:sha-0fad485']);
run('/usr/bin/docker', ['load', '-i', `${root}/base.tar`]);
fs.mkdirSync(`${root}/context`);
run('/usr/bin/tar', ['-xzf', '/tmp/lilly-team-release.tgz', '-C', `${root}/context`]);
const hashes = JSON.parse(fs.readFileSync('/tmp/lilly-team-release-hashes.json'));
for (const [file, hash] of Object.entries(hashes)) {
  if (crypto.createHash('sha256').update(fs.readFileSync(`${root}/context/${file}`)).digest('hex') !== hash) throw new Error('Source hash mismatch');
}
fs.writeFileSync(`${root}/context/Dockerfile`, 'FROM ghcr.io/philly1084/lilly:sha-0fad485\nCOPY --chown=1001:1001 src/ /app/src/\nCOPY --chown=1001:1001 frontend/ /app/frontend/\n');
const tag = `localhost/lilly-team-release:${crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex').slice(0, 16)}`;
run('/usr/bin/docker', ['build', '--network=none', '-t', tag, `${root}/context`]);
run('/usr/bin/docker', ['save', '--format', 'oci-archive', '-o', `${root}/release.tar`, tag]);
run('/usr/local/bin/k3s', ['ctr', 'images', 'import', `${root}/release.tar`]);
fs.writeFileSync('/tmp/lilly-team-release-built.json', JSON.stringify({ root, tag, files: Object.keys(hashes).length }));
console.log(JSON.stringify({ root, tag, files: Object.keys(hashes).length, storage, deployed: false }));
