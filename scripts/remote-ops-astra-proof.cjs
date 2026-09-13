'use strict';
const fs = require('node:fs'); const assert = require('node:assert/strict'); const crypto = require('node:crypto');
const { config } = require('/app/src/config');
const { token } = require('/app/src/auth/service').createAuthToken(config.auth.username);
const base = 'https://lilly.secdevsolutions.help'; const receiptPath = '/tmp/lilly-remote-ops-astra-proof.json';
async function api(path, body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(100000) });
  assert.equal(response.status, 200 === response.status || response.status === 201 ? response.status : 200, `HTTP ${response.status}`);
  return response;
}
(async () => {
  const contract = await (await api('/api/tools/remote-ops')).json();
  assert.ok(contract.modelSelection.models.some(m => m.id === 'gpt-6-astra'));
  let receipt;
  if (fs.existsSync(receiptPath)) receipt = JSON.parse(fs.readFileSync(receiptPath));
  else {
    const session = await (await api('/api/sessions', { mode: 'chat' })).json();
    receipt = { sessionId: session.id, marker: `<proof>ASTRA_${crypto.randomUUID()}</proof>` };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  }
  const params = receipt.jobId ? { task: 'Check status', jobId: receipt.jobId } : {
    task: 'Bounded model verification only. Read astra-input.xml and return astra-output.xml with exactly identical bytes using the supplied handoff manifest. Do not modify project files, deploy, or launch any other agents. Report verification and BLOCKER=none when successful.',
    contextFiles: [{ filename: 'astra-input.xml', mimeType: 'application/xml', content: receipt.marker }], collectResultFiles: true,
  };
  Object.assign(params, { cwd: '/opt/lilly-agent-workbench', reasoningEffort: 'high', adminMode: false });
  const result = await (await api('/api/tools/invoke/remote-ops', { tool: 'remote-cli-agent', sessionId: receipt.sessionId, model: 'gpt-6-astra', params })).json();
  assert.equal(result.success, true); assert.equal(result.data.success, true, result.data.error);
  const data = result.data.data;
  assert.equal(data.providerModel, 'gpt-6-astra');
  receipt.jobId = data.remoteCodeJobId; receipt.result = data; fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const listing = await (await api(`/api/sessions/${receipt.sessionId}/artifacts`)).json();
  const output = listing.artifacts.find(a => a.filename === 'astra-output.xml');
  let verified = false;
  if (output) { assert.equal(await (await api(`/api/artifacts/${output.id}/download`)).text(), receipt.marker); verified = true; }
  console.log(JSON.stringify({ model: data.providerModel, status: data.completionStatus, blocker: data.blocker, resultFilesError: data.resultFilesError, sessionId: receipt.sessionId, jobId: receipt.jobId, artifactId: output?.id, exactArtifactBytesVerified: verified, reasoning: data.reasoningEffortReceipt }));
})().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
