'use strict';
const fs = require('node:fs'); const crypto = require('node:crypto'); const assert = require('node:assert/strict'); const { execFileSync } = require('node:child_process');
function run(bin, args, input) { return execFileSync(bin, args, { input, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
const hashes = JSON.parse(fs.readFileSync('/tmp/lilly-team-release-hashes.json'));
const built = JSON.parse(fs.readFileSync('/tmp/lilly-team-release-built.json'));
const probe = `const fs=require('fs'),crypto=require('crypto'),assert=require('assert'); const hashes=${JSON.stringify(hashes)};
for(const [file,hash] of Object.entries(hashes))assert.equal(crypto.createHash('sha256').update(fs.readFileSync('/app/'+file)).digest('hex'),hash);
assert.equal(process.env.LILLY_TEAMS_ENABLED,'false'); console.log('source_and_disabled_flags_verified');`;
assert.equal(run('/usr/local/bin/kubectl', ['exec', '-i', '-n', 'kimibuilt', 'deployment/backend', '--', 'node', '-'], probe), 'source_and_disabled_flags_verified');
const url = 'https://lilly.secdevsolutions.help';
const health = JSON.parse(run('/usr/bin/curl', ['-fsS', '--max-time', '15', `${url}/health`])); assert.equal(health.status, 'healthy');
for (const file of ['index.html', 'js/team-client.js', 'js/team-manager.js', 'js/agent-ops.js', 'css/agent-ops.css']) {
  const data = execFileSync('/usr/bin/curl', ['-fsS', '--max-time', '15', `${url}/agent-ops/${file}`], { timeout: 20000 });
  assert.equal(crypto.createHash('sha256').update(data).digest('hex'), hashes[`frontend/agent-ops/${file}`]);
}
const report = { at: new Date().toISOString(), tag: built.tag, sourceFilesVerified: Object.keys(hashes).length, publicAssetsVerified: 5,
  publicHealth: 'healthy', publicUrl: `${url}/agent-ops/`, executionDisabled: true, agentTaskTested: false, visualBrowserTested: false };
fs.writeFileSync('/tmp/lilly-team-release-proof.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
