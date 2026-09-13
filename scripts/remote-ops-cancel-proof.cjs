'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {config}=require('/app/src/config');const {token}=require('/app/src/auth/service').createAuthToken(config.auth.username);
const base='https://lilly.secdevsolutions.help';
async function api(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(90000)});return {status:r.status,retry:r.headers.get('retry-after'),body:await r.json()};}
(async()=>{
const contract=await api('/api/tools/remote-ops');assert.equal(contract.body.revision,3);
const sid=(await api('/api/sessions',{mode:'chat'})).body.id;assert.ok(sid);
const invoke=(params,tool='remote-cli-agent',requestId)=>api('/api/tools/invoke/remote-ops',{tool,sessionId:sid,params,...(requestId?{requestId}:{})});
const marker='CANCEL_PRESERVE_'+crypto.randomUUID();
const put=await invoke({action:'put',files:[{filename:'cancel-preserve.txt',content:marker}]},'artifact-store','cancel-proof-upload');assert.equal(put.status,200);
const artifactId=put.body.data.data.files[0].id; fs.writeFileSync('/tmp/remote-ops-cancel-proof.json',JSON.stringify({sessionId:sid,artifactId,marker}));
const running=invoke({action:'run',model:'gpt-6-astra',targetId:'k3s-primary',observationTimeoutMs:45000,artifactIds:[artifactId],task:'Cancellation integration canary only. Do not change any project or deploy anything. Read the supplied input. Run sleep 120 and wait. The operator will cancel this test. Do not create other agents.'},'remote-cli-agent','cancel-proof-start');
await new Promise(r=>setTimeout(r,8000));
const saved=(await api('/api/sessions/'+sid)).body;const jobId=saved.metadata?.remoteOps?.job?.jobId;assert.ok(jobId,'No early saved job handle');fs.writeFileSync('/tmp/remote-ops-cancel-proof.json',JSON.stringify({sessionId:sid,artifactId,marker,jobId}));
const handoff=saved.controlState?.remoteCliAgent?.remoteAgentHandoff||saved.metadata?.remoteCliAgent?.remoteAgentHandoff;
const overlap=await invoke({action:'status'});assert.ok([409,429].includes(overlap.status));assert.ok(overlap.retry);
const cancel=await invoke({action:'cancel',jobId});assert.equal(cancel.status,200,JSON.stringify(cancel.body));assert.ok(['terminated','completed','cancellation_requested'].includes(cancel.body.data.status));
const replay=await invoke({action:'cancel',jobId});assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);
const observed=await running;assert.equal(observed.status,200,JSON.stringify(observed.body));
const output=await invoke({action:'get',artifactIds:[artifactId]},'artifact-store');assert.equal(Buffer.from(output.body.data.data.files[0].contentBase64,'base64').toString(),marker);
const proof={sessionId:sid,jobId,artifactId,cancelStatus:cancel.body.data.status,cancelReplayed:replay.body.replayed,overlapStatus:overlap.status,retryAfter:overlap.retry,artifactBytesPreserved:true,runStatus:observed.body.data?.data?.completionStatus,handoff};
fs.writeFileSync('/tmp/remote-ops-cancel-proof.json',JSON.stringify(proof));
console.log(JSON.stringify(proof));
})().then(()=>process.exit(0)).catch(e=>{console.error(e.stack);process.exit(1)});
