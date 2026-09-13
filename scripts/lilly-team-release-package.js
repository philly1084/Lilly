'use strict';
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = ['src/server.js', 'src/artifacts/artifact-service.js', 'src/artifacts/artifact-store.js', 'src/routes/agent-teams.js',
  'frontend/agent-ops/index.html', 'frontend/agent-ops/css/agent-ops.css', 'frontend/agent-ops/js/agent-ops.js',
  'frontend/agent-ops/js/team-client.js', 'frontend/agent-ops/js/team-manager.js'];
for (const dir of ['src/agent-teams', 'src/agent-computer', 'src/grok-build']) {
  for (const name of fs.readdirSync(path.join(root, dir))) {
    if (name.endsWith('.js') && !name.endsWith('.test.js')) files.push(`${dir}/${name}`);
  }
}
const hashes = Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
fs.writeFileSync(path.join(root, 'local/lilly-team-release-hashes.json'), JSON.stringify(hashes, null, 2));
execFileSync('tar', ['-czf', 'local/lilly-team-release.tgz', ...files], { cwd: root });
console.log(JSON.stringify({ files: files.length, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }));
