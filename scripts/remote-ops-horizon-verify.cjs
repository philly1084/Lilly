'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {config}=require('/app/src/config');const {token}=require('/app/src/auth/service').createAuthToken(config.auth.username);
const {readZipEntries}=require('/app/src/utils/zip');
const receipt=require('/tmp/lilly-horizon-proof.json');
async function get(id){const r=await fetch(`https://lilly.secdevsolutions.help/api/artifacts/${id}/download`,{headers:{Authorization:`Bearer ${token}`}});assert.equal(r.status,200);return Buffer.from(await r.arrayBuffer())}
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
const source=readZipEntries(await get(receipt.bundleId));
const outputArtifact=receipt.artifacts.find(a=>a.filename==='website-complete.zip');
const output=readZipEntries(await get(outputArtifact.id));assert.equal(output.size,source.size);
for(const [name,bytes] of source) assert.equal(hash(output.get(name)),hash(bytes),name);
for(const name of ['mobile.png','desktop.png']) {const a=receipt.artifacts.find(a=>a.filename===name);if(a)fs.writeFileSync('/tmp/horizon-'+name,await get(a.id));}
const revised=receipt.artifacts.find(a=>a.filename==='revised-website.zip');
let feedbackVerified=false;if(revised){const entries=readZipEntries(await get(revised.id));const html=[...entries.entries()].find(([name])=>name.endsWith('index.html'));assert.ok(html[1].toString().includes('Astra feedback round trip'));feedbackVerified=true;}
assert.equal(receipt.results.primary.remoteCodeSessionId,receipt.results.feedback.remoteCodeSessionId);if(receipt.stage==='done'){assert.notEqual(receipt.results.primary.remoteCodeSessionId,receipt.results.secondary.remoteCodeSessionId);assert.ok(receipt.proofs.secondary.contents.includes('162.55.163.199'));assert.ok(receipt.proofs.secondary.contents.includes('demoserver2.buzz'));} const result={progressObserved:receipt.progressObserved,secondaryProofArtifactId:receipt.proofs.secondary?.artifactId,sessionId:receipt.sessionId,sourceFileCount:source.size,returnedFileCount:output.size,allReturnedBytesMatch:true,outputArtifactId:outputArtifact.id,feedbackVerified,revisedArtifactId:revised?.id,stage:receipt.stage,providerSessions:Object.fromEntries(Object.entries(receipt.results).map(([k,d])=>[k,{jobId:d.remoteCodeJobId,sessionId:d.remoteCodeSessionId,model:d.providerModel,target:d.targetId,cwd:d.cwd,status:d.completionStatus,reasoning:d.reasoningEffortReceipt}]))};
fs.writeFileSync('/tmp/horizon-verified.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().then(()=>process.exit(0)).catch(e=>{console.error(e.stack);process.exit(1)});
