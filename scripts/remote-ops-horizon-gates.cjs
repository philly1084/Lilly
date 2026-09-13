'use strict';
const assert=require('node:assert/strict');
const {config}=require('/app/src/config');
const {createAuthToken}=require('/app/src/auth/service');
const token=createAuthToken(config.auth.username).token;
const base='https://lilly.secdevsolutions.help';
async function call(path,body,auth=token){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{...(auth?{Authorization:`Bearer ${auth}`} :{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});return {status:r.status,data:await r.json()};}
(async()=>{
assert.equal((await call('/api/tools/remote-ops',null,null)).status,401);
const session=(await call('/api/sessions',{mode:'chat'})).data.id;
const foreign=createAuthToken('remote-ops-foreign-proof').token;
assert.equal((await call('/api/tools/invoke/remote-ops',{tool:'artifact-store',sessionId:'20abc857-2ecb-4ad2-88a8-0e98c7897d40',params:{action:'list'}},foreign)).status,404);
const rejected=await call('/api/tools/invoke/remote-ops',{tool:'artifact-store',sessionId:session,params:{action:'get',artifactIds:['f7622e2f-b13c-4c83-9b9b-9bf26eb51279']}});assert.equal(rejected.status,404);
const direct=await call('/api/tools/invoke/remote-ops',{tool:'k3s-deploy',sessionId:session,params:{targetId:'k3s-secondary',action:'rollout-status',namespace:'agent-platform',deployment:'kimibuilt-remote-runner',timeoutSeconds:20}});
assert.equal(direct.status,200);assert.equal(direct.data.data.success,true,JSON.stringify(direct.data).slice(0,1000));
const primary=await call('/api/tools/invoke/remote-ops',{tool:'k3s-deploy',sessionId:session,params:{targetId:'k3s-primary',action:'rollout-status',namespace:'kimibuilt',deployment:'backend',timeoutSeconds:20}});assert.equal(primary.status,503);
console.log(JSON.stringify({anonymousRejected:true,foreignSessionRejected:true,foreignArtifactRejected:true,secondaryRollout:direct.data.data,primaryCredentialGate:primary.status}));
})().then(()=>process.exit(0)).catch(e=>{console.error(e.stack);process.exit(1)});
