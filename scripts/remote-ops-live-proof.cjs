'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { config } = require('/app/src/config');
const { createAuthToken } = require('/app/src/auth/service');
const { token } = createAuthToken(config.auth.username);
const base = 'https://lilly.secdevsolutions.help';
async function api(route, body, auth = token) {
  const headers = auth ? { Authorization: `Bearer ${auth}` } : {};
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(100000), redirect: 'error' });
  return response;
}
(async () => {
  assert.equal((await api('/api/tools/remote-ops', null, null)).status, 401);
  assert.equal((await api('/api/tools/remote-ops', null, 'invalid')).status, 401);
  const contract = await (await api('/api/tools/remote-ops')).json(); assert.equal(contract.schema, 'LillyRemoteOps/v1');
  const session = await (await api('/api/sessions', { mode: 'chat' })).json(); assert.ok(session.id);
  const marker = `<proof>LILLY_REMOTE_OPS_${crypto.randomUUID()}</proof>`;
  const form = new FormData(); form.set('sessionId', session.id); form.set('file', new Blob([marker], { type: 'application/xml' }), 'proof-input.xml');
  const uploadResponse = await api('/api/artifacts/upload', form); assert.equal(uploadResponse.status, 201);
  const artifact = await uploadResponse.json(); assert.ok(artifact.id);
  assert.equal(await (await api(`/api/artifacts/${artifact.id}/download`)).text(), marker);
  const foreign = createAuthToken(`remote-proof-other-${crypto.randomUUID()}`).token;
  assert.equal((await api(`/api/artifacts/${artifact.id}/download`, null, foreign)).status, 404);
  assert.equal((await api('/api/tools/invoke/remote-ops', { tool: 'remote-cli-agent', sessionId: session.id, params: { task: 'Inspect', targetId: 'k3s-secondary' } })).status, 400);
  console.log(JSON.stringify({ phase: 'auth-artifacts', passed: true, sessionId: session.id, inputArtifactId: artifact.id }));
  const deployment = await (await api('/api/tools/invoke/remote-ops', { tool: 'k3s-deploy', sessionId: session.id, params: { action: 'rollout-status', namespace: 'kimibuilt', deployment: 'backend', timeoutSeconds: 30 } })).json();
  console.log(JSON.stringify({ phase: 'deployment', result: deployment }));
  const task = 'Bounded API verification only. Read the supplied proof-input.xml artifact. Return proof-output.xml containing exactly the same bytes through the supplied RemoteAgentResultFiles/v1 output manifest. Do not change project files, deploy, launch other agents, or inspect credentials. Report WHAT_CHANGED, VERIFY_COMMANDS, VERIFY_RESULTS, PUBLIC_URL (none), BLOCKER (none).';
  let result = await (await api('/api/tools/invoke/remote-ops', { tool: 'remote-cli-agent', sessionId: session.id, params: { task, cwd: '/opt/lilly-agent-workbench', adminMode: false, artifactIds: [artifact.id], collectResultFiles: true } })).json();
  console.log(JSON.stringify({ phase: 'codex', result }));
  fs.writeFileSync('/tmp/lilly-remote-ops-proof.json', JSON.stringify({ sessionId: session.id, marker, deployment, result }));
})().catch(e => { console.error(JSON.stringify({ passed: false, error: e.message })); process.exitCode = 1; });
