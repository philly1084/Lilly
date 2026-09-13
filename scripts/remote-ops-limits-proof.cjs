'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const {config}=require('/app/src/config');const {token}=require('/app/src/auth/service').createAuthToken(config.auth.username);
const {sessionStore}=require('/app/src/session-store');
const base='https://lilly.secdevsolutions.help';
async function api(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(45000)});return {status:r.status,retry:r.headers.get('retry-after'),body:await r.json()};}
(async()=>{
const p=JSON.parse(fs.readFileSync('/tmp/remote-ops-cancel-proof.json'));
const call=sid=>api('/api/tools/invoke/remote-ops',{tool:'remote-cli-agent',sessionId:sid,params:{action:'status'}});
let status=await call(p.sessionId);if(status.status===429){await new Promise(r=>setTimeout(r,(Number(status.retry)+1)*1000));status=await call(p.sessionId);}
assert.equal(status.status,200,JSON.stringify(status));assert.equal(status.body.stopPolling,true);
const cached=await call(p.sessionId);assert.equal(cached.body.cached,true);
const sid=(await api('/api/sessions',{mode:'chat'})).body.id;
await sessionStore.update(sid,{metadata:{remoteOps:{receipts:[],job:{jobId:'ragent_synthetic_limit_probe',targetId:'k3s-primary',cwd:'/opt/lilly-agent-workbench',model:'gpt-6-astra',status:'running'},poll:{jobId:'ragent_synthetic_limit_probe',count:1,nextAt:Date.now()+30000}}}});
const first=await call(sid),second=await call(sid);assert.equal(first.status,429);assert.equal(second.status,429);assert.ok(Number(first.retry)>0);
const preserved=await sessionStore.getOwned(sid,config.auth.username);assert.equal(preserved.metadata.remoteOps.poll.count,1);
// Retire only this synthetic guard fixture; it never represented a gateway task.
await sessionStore.update(sid,{metadata:{remoteOps:{receipts:[],job:{...preserved.metadata.remoteOps.job,status:'complete'}}}});
console.log(JSON.stringify({sessionId:p.sessionId,jobId:p.jobId,cancellationStatus:p.cancelStatus,artifactBytesPreserved:p.artifactBytesPreserved,terminalCached:true,rateLimitStatus:first.status,retryAfter:first.retry,rejectedPollsDidNotConsumeGatewayBudget:true}));
})().then(()=>process.exit(0)).catch(e=>{console.error(e.stack);process.exit(1)});
