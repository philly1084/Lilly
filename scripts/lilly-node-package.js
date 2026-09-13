'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
require('../src/agent-computer/node-service');
require('../src/agent-computer/node-rbac');
const files = Object.keys(require.cache).filter(p => p.startsWith(root + path.sep) && !p.includes('node_modules') && p !== __filename)
  .map(p => path.relative(root, p).replaceAll('\\', '/'));
files.push('bin/lilly-node-service.js', 'deploy/lilly-node/lilly-node.service');
const manifest = Object.fromEntries(files.map(p => [p, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex')]));
fs.writeFileSync(path.join(root, 'local/lilly-node-install-hashes.json'), JSON.stringify(manifest, null, 2));
execFileSync('tar', ['-czf', 'local/lilly-node-install.tgz', ...files], { cwd: root });
console.log(JSON.stringify({ files: files.length, archive: 'local/lilly-node-install.tgz' }));
