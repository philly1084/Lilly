'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { execute, parseArgs } = require('./k3s-deployment-coordinator');
const exec = promisify(execFile);

describe('release child process lifecycle', () => {
  test('writes stdin and preserves argument boundaries', async () => {
    expect(parseArgs(['run', '--', 'printf', 'a b']).command).toEqual(['printf', 'a b']);
    const result = await execute(process.execPath, ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(s))'], { input: 'lease body' });
    expect(result).toBe('lease body');
  });
  test('terminates a timed out child before returning', async () => {
    await expect(execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 50 })).rejects.toThrow('timed out');
  });
  test('cancellation rejects without running subsequent work', async () => {
    const controller = new AbortController();
    const pending = execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
    controller.abort(new Error('lost ownership'));
    await expect(pending).rejects.toThrow('lost ownership');
  });
});

// The production runner is Linux. Exercise the real CLI with subprocess kubectl,
// including JSON stdin and CAS, instead of mocking implementation functions.
(process.platform === 'win32' ? describe.skip : describe)('release CLI with Kubernetes fixture', () => {
  let root, env;
  const sha = 'a'.repeat(40);
  const cli = path.join(__dirname, 'k3s-deployment-coordinator.js');
  const invoke = (args, extra = {}) => exec(process.execPath, [cli, ...args], { env: { ...env, ...extra }, timeout: 15000 });
  const args = (action = 'deploy-backend') => [action, '--expected-image', 'old', '--source-sha', sha, '--image', 'new', '--wait-seconds', '1'];
  const read = () => JSON.parse(fs.readFileSync(path.join(root, 'state.json')));
  const write = (s) => fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(s));
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cli-test-'));
    env = { ...process.env, PATH: `${root}:${process.env.PATH}`, FIXTURE_ROOT: root };
    for (const key of Object.keys(env)) if (key.startsWith('KIMIBUILT_RELEASE_')) delete env[key];
    write({ version: 1, lease: null, patches: [], deployment: { metadata: { resourceVersion: '1', annotations: {} }, spec: { template: { metadata: { annotations: {} }, spec: { containers: [{ name: 'backend', image: 'old' }] } } } } });
    fs.writeFileSync(path.join(root, 'git'), `#!/bin/sh\nprintf '%s\\n' '${sha}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'kubectl'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(root, 'kubectl.js')}' "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'kubectl.js'), `
const fs=require('fs'),path=require('path'); const root=process.env.FIXTURE_ROOT;
const args=process.argv.slice(2),lock=path.join(root,'mutex'),file=path.join(root,'state.json');
if(args[0]==='rollout'){ if(process.env.FAIL_ROLLOUT){process.stderr.write('rollout failure');process.exit(1)} process.exit(0); }
let owned=false;for(let n=0;n<500;n++){try{fs.mkdirSync(lock);owned=true;break}catch{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}}
if(!owned)process.exit(9);
try{
const s=JSON.parse(fs.readFileSync(file));let out='';
const patch=(obj,ops)=>{for(const op of ops){const parts=op.path.slice(1).split('/').map(x=>x.replace(/~1/g,'/').replace(/~0/g,'~'));let p=obj;for(const k of parts.slice(0,-1))p=p[k];const k=parts.at(-1);if(op.op==='test'){if(JSON.stringify(p[k])!==JSON.stringify(op.value))throw Error('test failed')}else if(op.op==='remove')delete p[k];else p[k]=op.value;}};
if(args[0]==='get'&&args[1]==='lease')out=s.lease?JSON.stringify(s.lease):'';
else if(args[0]==='get'&&args[1]==='deployment')out=JSON.stringify(s.deployment);
else if(args[0]==='get'&&args[1]==='configmap')out=JSON.stringify({data:{TEST:'value'}});
else if(args[0]==='create'){if(s.lease)throw Error('AlreadyExists');s.lease=JSON.parse(fs.readFileSync(0,'utf8'));s.lease.metadata.resourceVersion=String(++s.version);s.patches.push({kind:'acquire',owner:s.lease.spec.holderIdentity});}
else if(args[0]==='patch'){const ops=JSON.parse(args[args.indexOf('-p')+1]);if(args[1]==='lease'){patch(s.lease,ops);s.lease.metadata.resourceVersion=String(++s.version);s.patches.push({kind:'lease',owner:s.lease.spec.holderIdentity});}else {patch(s.deployment,ops);s.deployment.metadata.resourceVersion=String(++s.version);s.patches.push({kind:'deployment',owner:s.lease?.spec?.holderIdentity});}}
else if(args[0]!=='apply')throw Error('unexpected '+args.join(' '));
if(s.lease){for(const key of ['acquireTime','renewTime']){if(s.lease.spec[key]&&!/\\.\\d{6}Z$/.test(s.lease.spec[key]))throw Error('Kubernetes MicroTime requires six decimal digits');}}
fs.writeFileSync(file,JSON.stringify(s));if(out)process.stdout.write(out);
}catch(e){process.stderr.write(e.message);process.exitCode=1}finally{fs.rmdirSync(lock)}
`);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  test('creates Lease from stdin, guards image, and releases after completed rollout', async () => {
    await invoke(args());
    const s = read();
    expect(s.deployment.spec.template.spec.containers[0].image).toBe('new');
    expect(s.patches.find((p) => p.kind === 'deployment').owner).toMatch(/^release-/);
    expect(s.lease.spec.holderIdentity).toBe('');
  });
  test('failed rollout releases the owner lock', async () => {
    await expect(invoke(args(), { FAIL_ROLLOUT: '1' })).rejects.toThrow();
    expect(read().lease.spec.holderIdentity).toBe('');
  });
  test('repeating the same release does not change the pod template', async () => {
    await invoke(args());
    const template = read().deployment.spec.template;
    const repeat = args(); repeat[repeat.indexOf('old')] = 'new';
    await invoke(repeat);
    expect(read().deployment.spec.template).toEqual(template);
  });
  test('failed image CAS releases without any deployment write', async () => {
    const a = args(); a[a.indexOf('old')] = 'different';
    await expect(invoke(a)).rejects.toThrow();
    expect(read().lease.spec.holderIdentity).toBe('');
    expect(read().patches.some((p) => p.kind === 'deployment')).toBe(false);
  });
  test('competing owner times out without stealing a live Lease', async () => {
    const s = read(); s.lease = { metadata: { resourceVersion: '2' }, spec: { holderIdentity: 'other', renewTime: new Date().toISOString().replace(/Z$/, '000Z'), leaseDurationSeconds: 120 } }; write(s);
    await expect(invoke(args())).rejects.toThrow();
    expect(read().lease.spec.holderIdentity).toBe('other');
    expect(read().patches).toHaveLength(0);
  });
  test('stale owner is replaced atomically before deployment', async () => {
    const s = read(); s.lease = { metadata: { resourceVersion: '2' }, spec: { holderIdentity: 'other', renewTime: '2000-01-01T00:00:00.000000Z', leaseDurationSeconds: 120 } }; write(s);
    await invoke(args());
    expect(read().deployment.spec.template.spec.containers[0].image).toBe('new');
    expect(read().lease.spec.holderIdentity).toBe('');
  });
  test('nested invocation cannot release the outer lock', async () => {
    const nested = [process.execPath, cli, ...args()];
    await invoke([...args('run'), '--', ...nested]);
    expect(read().patches.filter((p) => p.kind === 'lease' && p.owner === '')).toHaveLength(1);
  });
  test('run holds the lock throughout a child command failure', async () => {
    await expect(invoke([...args('run'), '--', process.execPath, '-e', 'process.exit(7)'])).rejects.toThrow();
    expect(read().lease.spec.holderIdentity).toBe('');
  });
  test('stale source performs no deployment writes and releases lock', async () => {
    const a = args(); a[a.indexOf(sha)] = 'b'.repeat(40);
    await expect(invoke(a)).rejects.toThrow();
    expect(read().patches.some((p) => p.kind === 'deployment')).toBe(false);
    expect(read().lease.spec.holderIdentity).toBe('');
  });
  test('renews while a child runs and releases only after it exits', async () => {
    await invoke([...args('run'), '--', process.execPath, '-e', 'setTimeout(()=>{},10500)']);
    const s = read();
    expect(s.patches.some((p) => p.kind === 'lease' && p.owner.startsWith('release-'))).toBe(true);
    expect(s.patches.at(-1)).toEqual({ kind: 'lease', owner: '' });
  }, 15000);
  test('ownership loss stops a running command and cannot release the new owner', async () => {
    const marker = path.join(root, 'should-not-exist');
    const pending = invoke([...args('run'), '--', process.execPath, '-e', `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),14000)`]).catch((e) => e);
    for (let i = 0; i < 100 && !read().lease; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const s = read(); s.lease.spec.holderIdentity = 'new-owner'; write(s);
    expect((await pending).stderr).toMatch(/ownership was lost/);
    expect(read().lease.spec.holderIdentity).toBe('new-owner');
    expect(fs.existsSync(marker)).toBe(false);
  }, 15000);
});
