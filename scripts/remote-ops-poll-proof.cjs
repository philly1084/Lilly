'use strict';
const fs = require('node:fs'); const assert = require('node:assert/strict');
const { config } = require('/app/src/config');
const { token } = require('/app/src/auth/service').createAuthToken(config.auth.username);
const receipt = JSON.parse(fs.readFileSync('/tmp/lilly-remote-ops-proof.json'));
const base = 'https://lilly.secdevsolutions.help';
(async () => {
  const jobId = receipt.result.data.data.remoteCodeJobId;
  const response = await fetch(base + '/api/tools/invoke/remote-ops', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'remote-cli-agent', sessionId: receipt.sessionId, params: { task: 'Check status', jobId, cwd: '/opt/lilly-agent-workbench' } }), signal: AbortSignal.timeout(100000) });
  const result = await response.json();
  receipt.result = result; fs.writeFileSync('/tmp/lilly-remote-ops-proof.json', JSON.stringify(receipt));
  console.log(JSON.stringify({ phase: 'poll', result }));
  const listing = await (await fetch(base + `/api/sessions/${receipt.sessionId}/artifacts`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const output = listing.artifacts.find(a => a.filename === 'proof-output.xml');
  if (output) {
    const bytes = await (await fetch(base + `/api/artifacts/${output.id}/download`, { headers: { Authorization: `Bearer ${token}` } })).text();
    assert.equal(bytes, receipt.marker);
    console.log(JSON.stringify({ artifactRoundTripVerified: true, sessionId: receipt.sessionId, artifactId: output.id, exactBytesMatch: true }));
  } else console.log(JSON.stringify({ artifactRoundTripVerified: false, artifactNames: listing.artifacts.map(a => a.filename) }));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
