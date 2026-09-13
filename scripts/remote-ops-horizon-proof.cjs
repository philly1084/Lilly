'use strict';
const fs = require('node:fs'); const assert = require('node:assert/strict'); const crypto = require('node:crypto');
const { config } = require('/app/src/config');
const { token } = require('/app/src/auth/service').createAuthToken(config.auth.username);
const base = 'https://lilly.secdevsolutions.help'; const receiptPath = '/tmp/lilly-horizon-proof.json';
async function api(path, body, expected) {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90000) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  if (expected) assert.equal(r.status, expected, JSON.stringify(data).slice(0,500)); else assert.ok(r.ok, `HTTP ${r.status} ${JSON.stringify(data).slice(0,500)}`);
  return data;
}
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
(async () => {
  const contract = await api('/api/tools/remote-ops'); assert.equal(contract.revision, 2);
  assert.ok(contract.modelSelection.models.some(m => m.id === 'gpt-6-astra'));
  let receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath)) : {};
  const save = () => fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  if (!receipt.sessionId) { receipt.sessionId = (await api('/api/sessions', { mode: 'chat' })).id; receipt.stage = 'primary'; save(); }
  const invoke = (params, extra = {}) => api('/api/tools/invoke/remote-ops', { tool: 'remote-cli-agent', sessionId: receipt.sessionId, params, ...extra });
  const shelf = (params, extra = {}) => invoke(params, { tool: 'artifact-store', ...extra });
  if (!receipt.bundleId) {
    const files = [
      { filename: 'site/index.html', mimeType: 'text/html', content: '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Astra shared website proof</title><link rel="stylesheet" href="styles.css"><main><h1>Astra shared website proof</h1><p>Version one</p><img src="assets/icon.svg" alt="Blue square"></main></html>' },
      { filename: 'site/styles.css', mimeType: 'text/css', content: 'body{margin:0;background:#f8fafc;color:#172033;font:18px system-ui}main{max-width:64rem;margin:auto;padding:2rem}img{width:48px;height:48px}' },
      { filename: 'site/assets/icon.svg', mimeType: 'image/svg+xml', content: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#2457a6"/></svg>' },
      { filename: 'site/assets/pixel.png', mimeType: 'image/png', contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' },
      ...Array.from({ length: 17 }, (_,i) => ({ filename: `site/src/module-${i}.js`, mimeType: 'text/javascript', content: `export const value${i} = ${i};\n` })),
    ];
    const put = await shelf({ action: 'put', files }, { requestId: 'proof-upload-1' }); assert.equal(put.data.data.files.length,21);
    const replay = await shelf({ action: 'put', files }, { requestId: 'proof-upload-1' }); assert.equal(replay.replayed,true);
    assert.deepEqual(replay.data.data.files.map(f => f.id),put.data.data.files.map(f => f.id));
    const ids = put.data.data.files.map(f => f.id);
    const got = await shelf({ action: 'get', artifactIds: ids });
    got.data.data.files.forEach((f,i) => assert.equal(hash(Buffer.from(f.contentBase64,'base64')),hash(files[i].content === undefined ? Buffer.from(files[i].contentBase64,'base64') : Buffer.from(files[i].content))));
    const listed = await shelf({ action:'list', offset:0, limit:10 }); assert.equal(listed.data.data.nextOffset,10);
    const bundle = await shelf({ action:'bundle', filename:'website-source.zip', artifactIds:ids },{requestId:'proof-bundle-1'});
    receipt.bundleId = bundle.data.data.artifact.id; receipt.inputIds = ids; receipt.bulkByteProof = true; save();
  }
  if (receipt.stage === 'done') { console.log(JSON.stringify(receipt)); return; }
  let result;
  if (receipt.active) result = await invoke({ action:'status', observationTimeoutMs:5000 });
  else {
    let params;
    if (receipt.stage === 'primary') params = { action:'run', model:'gpt-6-astra', reasoningEffort:'high', targetId:'k3s-primary', adminMode:true, observationTimeoutMs:5000, artifactIds:[receipt.bundleId], collectResultFiles:true,
      task:'Bounded integration proof in an isolated .kimibuilt/horizon-proof project under the workspace. Inspect incoming website-source.zip safely, verify all 21 relative files and PNG bytes, and extract only into your isolated proof directory. Run hostname and a read-only kubectl deployment/ingress inventory proving the primary host. Do not deploy or alter any existing project/cluster resources. Save CHECKPOINT.md and primary-proof.json containing host, file count, selected domain and verification. Simulate one long build with sleep 65, reporting progress before and after, then return a complete website ZIP plus primary-proof.json and CHECKPOINT.md via the supplied output manifest. Do not launch any agents. Finish with SUPPORT_AGENT_REQUIRED asking the caller for the website heading revision.' };
    else if (receipt.stage === 'feedback') params = { action:'continue', adminMode:true, observationTimeoutMs:5000, collectResultFiles:true, task:'Continue this exact proof workspace. Apply the calling bot feedback, return revised-website.zip, feedback-proof.json and CHECKPOINT.md through the new supplied manifest. Verify the HTML heading in the ZIP. Do not deploy or alter other files.', supportAgentResponse:'Change the main heading to Astra feedback round trip. Include that exact heading and hostname in feedback-proof.json.' };
    else params = { action:'run', model:'gpt-6-astra', reasoningEffort:'high', adminMode:true, observationTimeoutMs:5000, artifactIds:[receipt.bundleId], collectResultFiles:true, task:'Bounded secondary integration proof for demoserver2.buzz. Use an isolated .kimibuilt/horizon-proof directory. Inspect the supplied website-source.zip safely and verify its 21 files, code, SVG and PNG. Run hostname and read-only kubectl deployment/ingress inventory to prove the selected secondary server and domain. Return secondary-proof.json containing host, fileCount and domain plus CHECKPOINT.md via the supplied output manifest. Do not deploy, modify other projects or launch agents.' };
    receipt.intent = { tool:'remote-cli-agent', sessionId:receipt.sessionId, requestId:`horizon-${receipt.stage}-1`, params }; save();
    result = await api('/api/tools/invoke/remote-ops',receipt.intent);
    const replay = await api('/api/tools/invoke/remote-ops',receipt.intent); assert.equal(replay.replayed,true);
    receipt.replayedStages ||= []; receipt.replayedStages.push(receipt.stage);
  }
  assert.equal(result.success,true,JSON.stringify(result)); assert.equal(result.data?.success,true,JSON.stringify(result).slice(0,1000));
  const d = result.data.data; receipt.progressObserved ||= Boolean(d.progressOutput); assert.equal(d.providerModel,'gpt-6-astra');
  if(receipt.active) assert.equal(d.remoteCodeJobId,receipt.active);
  else receipt.active=d.remoteCodeJobId;
  receipt.results ||= {}; receipt.results[receipt.stage] = d; save();
  const artifacts = await shelf({action:'list'}); receipt.artifacts = artifacts.data.data.files;
  if(['complete','blocked','failed'].includes(d.completionStatus)) {
    const name = receipt.stage === 'primary' ? 'primary-proof.json' : receipt.stage === 'feedback' ? 'feedback-proof.json' : 'secondary-proof.json';
    const file = receipt.artifacts.find(f => f.filename.endsWith(name)); assert.ok(file,`Missing ${name}: ${JSON.stringify({blocker:d.blocker,error:d.resultFilesError,output:d.finalOutput}).slice(0,1500)}`);
    const bytes = await shelf({ action:'get',artifactIds:[file.id] });
    const contents=Buffer.from(bytes.data.data.files[0].contentBase64,'base64').toString();
    receipt.proofs ||= {}; receipt.proofs[receipt.stage] = {artifactId:file.id,contents};
    receipt.active=null; receipt.stage=receipt.stage==='primary'?'feedback':receipt.stage==='feedback'?'secondary':'done'; save();
  }
  console.log(JSON.stringify({ sessionId:receipt.sessionId, stage:receipt.stage, jobId:d.remoteCodeJobId, status:d.completionStatus, model:d.providerModel, target:d.targetId, cwd:d.cwd, bulkByteProof:receipt.bulkByteProof, blocker:d.blocker, resultFilesError:d.resultFilesError, progressObserved:receipt.progressObserved,artifactCount:receipt.artifacts.length, output:String(d.finalOutput||d.output||'').slice(-3000), proofs:Object.fromEntries(Object.entries(receipt.proofs||{}).map(([k,v])=>[k,{artifactId:v.artifactId,host:JSON.parse(v.contents).host}])) }));
})().then(()=>process.exit(0)).catch(e=>{ console.error(e.stack); process.exit(1); });
