const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { AgentComputerRuntime, identityKey } = require('./runtime');

const identity = { ownerId: 'owner-a', teamId: 'team-a', agentId: 'agent-a' };

function fakeBrowser() {
  const locator = { click: jest.fn(), hover: jest.fn(), fill: jest.fn(), pressSequentially: jest.fn(), press: jest.fn() };
  const page = {
    currentUrl: 'about:blank',
    goto: jest.fn(async function go(url) { this.currentUrl = url; }),
    url: jest.fn(function url() { return this.currentUrl; }),
    title: jest.fn(async () => 'Fixture'),
    screenshot: jest.fn(async () => Buffer.from('private-pixels')),
    locator: jest.fn(() => locator),
    mouse: { click: jest.fn(), move: jest.fn(), wheel: jest.fn() },
    keyboard: { press: jest.fn() },
    waitForTimeout: jest.fn(),
    on: jest.fn(),
    setDefaultTimeout: jest.fn(),
  };
  const context = {
    pages: jest.fn(() => [page]),
    newPage: jest.fn(async () => page),
    route: jest.fn(),
    routeWebSocket: jest.fn(),
    on: jest.fn(),
    close: jest.fn(),
  };
  const chromium = { launchPersistentContext: jest.fn(async () => context) };
  return { chromium, context, page, locator };
}

function fakeSocket(url = 'wss://fixture.test/ws') {
  const makeSide = () => ({
    onMessage: jest.fn(function onMessage(handler) { this.message = handler; }),
    onClose: jest.fn(function onClose(handler) { this.closed = handler; }),
    close: jest.fn(async () => {}),
    send: jest.fn(),
  });
  const server = makeSide();
  const page = { ...makeSide(), url: () => url, connectToServer: jest.fn(() => server) };
  return { page, server };
}

describe('AgentComputerRuntime', () => {
  let rootDir;
  const runtimes = [];
  beforeEach(async () => { rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilly-computer-test-')); });
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  function setup(options = {}) {
    const fake = fakeBrowser();
    const authorize = jest.fn(async () => true);
    const runtime = new AgentComputerRuntime({ rootDir, chromium: fake.chromium, authorize, ...options });
    runtimes.push(runtime);
    return { runtime, authorize, ...fake };
  }

  test('denies access by default without launching a browser', async () => {
    const { runtime, chromium } = setup({ authorize: undefined });
    await expect(runtime.open(identity, { url: 'https://fixture.test/' })).rejects.toMatchObject({ code: 'computer_policy_denied' });
    expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
  });

  test('supervised close retains task ownership and final disposal retires it after context closes', async () => {
    const profileLeaseId = require('node:crypto').randomUUID();
    const { runtime, context } = setup({ profileLeaseId });
    const frame = await runtime.open(identity, { url: 'https://fixture.test/' });
    const lease = path.join(rootDir, `${identityKey(identity)}.lease`);
    const owner = JSON.parse(await fs.readFile(path.join(lease, 'owner.json'), 'utf8'));
    expect(owner).toEqual({ version: 1, leaseId: profileLeaseId, profileKey: identityKey(identity) });
    expect(JSON.stringify(frame)).not.toContain(profileLeaseId);
    context.close.mockImplementation(async () => { expect((await fs.lstat(lease)).isDirectory()).toBe(true); });
    await runtime.close(identity, { computerId: frame.computerId });
    expect(JSON.parse(await fs.readFile(path.join(lease, 'owner.json'), 'utf8'))).toEqual(owner);
    expect((await runtime.dispose()).every(value => value.status === 'fulfilled')).toBe(true);
    await expect(fs.lstat(lease)).rejects.toMatchObject({ code: 'ENOENT' });
    const retired = path.join(rootDir, '.lilly-retired', profileLeaseId, `${identityKey(identity)}.lease`, 'owner.json');
    expect(JSON.parse(await fs.readFile(retired, 'utf8'))).toEqual(owner);
    expect((await fs.lstat(path.join(rootDir, identityKey(identity)))).isDirectory()).toBe(true);
  });

  test.each(['explicit', 'idle'])('supervised %s close reopens with the same owner generation and retires once', async mode => {
    const { readProfileOwner, retiredProfilePath } = require('./profile-lease');
    const profileLeaseId = require('node:crypto').randomUUID(); let time = 0;
    const { runtime, chromium } = setup({ profileLeaseId, now: () => time, idleMs: 1000 });
    const lease = path.join(rootDir, `${identityKey(identity)}.lease`);
    let owner;
    for (let i = 0; i < 3; i++) {
      const frame = await runtime.open(identity, { url: 'https://fixture.test/' });
      owner ||= await readProfileOwner(lease);
      expect(await readProfileOwner(lease)).toEqual(owner);
      if (mode === 'explicit') await runtime.close(identity, { computerId: frame.computerId });
      else { time += 1001; expect(await runtime.closeIdle()).toEqual([{ status: 'fulfilled', value: undefined }]); }
      expect(runtime.computers.size).toBe(0); expect(runtime.profiles.size).toBe(1);
      expect(await readProfileOwner(lease)).toEqual(owner);
    }
    expect(chromium.launchPersistentContext).toHaveBeenCalledTimes(3);
    expect((await runtime.dispose()).every(value => value.status === 'fulfilled')).toBe(true);
    expect(await readProfileOwner(retiredProfilePath(lease, owner.owner))).toEqual(owner);
    expect(runtime.profiles.size).toBe(0);
    const replacement = setup({ profileLeaseId });
    await expect(replacement.runtime.open(identity, { url: 'https://fixture.test/' })).rejects.toMatchObject({ code: 'computer_profile_leased' });
    expect(replacement.chromium.launchPersistentContext).not.toHaveBeenCalled();
  });

  test('closed supervised profiles reject another claim and another worker, but a fresh lease works after disposal', async () => {
    const profileLeaseId = require('node:crypto').randomUUID();
    const bound = { ...identity, claim: { taskId: 'task', workerId: 'worker', claimId: 'claim' } };
    const first = setup({ profileLeaseId });
    const frame = await first.runtime.open(bound, { url: 'https://fixture.test/' });
    await first.runtime.close(bound, { computerId: frame.computerId });
    await expect(first.runtime.open({ ...bound, claim: { ...bound.claim, claimId: 'other' } }, { url: 'https://fixture.test/' }))
      .rejects.toMatchObject({ code: 'computer_claim_denied' });
    const competing = setup({ profileLeaseId });
    await expect(competing.runtime.open(bound, { url: 'https://fixture.test/' })).rejects.toMatchObject({ code: 'computer_profile_leased' });
    expect(competing.chromium.launchPersistentContext).not.toHaveBeenCalled();
    await first.runtime.dispose();
    const next = setup({ profileLeaseId: require('node:crypto').randomUUID() });
    await next.runtime.open(bound, { url: 'https://fixture.test/' });
    expect(next.chromium.launchPersistentContext).toHaveBeenCalledTimes(1);
  });

  test('a replaced retained owner cannot reopen or retire the wrong filesystem generation', async () => {
    const profileLeaseId = require('node:crypto').randomUUID();
    const { runtime, chromium } = setup({ profileLeaseId });
    const frame = await runtime.open(identity, { url: 'https://fixture.test/' });
    await runtime.close(identity, { computerId: frame.computerId });
    const marker = path.join(rootDir, `${identityKey(identity)}.lease`, 'owner.json');
    const content = await fs.readFile(marker);
    await fs.rename(marker, path.join(rootDir, 'old-owner')); await fs.writeFile(marker, content);
    await expect(runtime.open(identity, { url: 'https://fixture.test/' })).rejects.toMatchObject({ code: 'computer_profile_ownership_unknown' });
    expect(chromium.launchPersistentContext).toHaveBeenCalledTimes(1);
    expect((await runtime.dispose()).some(value => value.status === 'rejected')).toBe(true);
    expect(await fs.readFile(marker)).toEqual(content);
  });

  test('failed browser closure retains its owned lock for exact recovery', async () => {
    const profileLeaseId = require('node:crypto').randomUUID();
    const { runtime, context } = setup({ profileLeaseId });
    const frame = await runtime.open(identity, { url: 'https://fixture.test/' });
    const marker = path.join(rootDir, `${identityKey(identity)}.lease`, 'owner.json');
    const before = await fs.readFile(marker, 'utf8');
    context.close.mockRejectedValue(new Error('Fixture close unconfirmed'));
    await expect(runtime.close(identity, { computerId: frame.computerId })).rejects.toThrow('Fixture close unconfirmed');
    expect(await fs.readFile(marker, 'utf8')).toBe(before);
    expect((await runtime.dispose()).some(value => value.status === 'rejected')).toBe(true);
  });

  test('dispose permanently fences queued and future browser admission with private no-dispatch provenance', async () => {
    const { runtime, chromium } = setup();
    const queued = runtime.open(identity, { url: 'https://fixture.test/' }).catch(error => error);
    const firstStop = runtime.dispose();
    expect(runtime.dispose()).toBe(firstStop);
    const rejected = await queued;
    expect(rejected.code).toBe('computer_disposed');
    expect(runtime.isPreDispatchFailure(rejected)).toBe(true);
    expect(await firstStop).toEqual([]);
    const late = await runtime.open(identity, { url: 'https://fixture.test/' }).catch(error => error);
    expect(late.code).toBe('computer_disposed');
    expect(runtime.isPreDispatchFailure(late)).toBe(true);
    expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
    expect(runtime.computers.size).toBe(0);
    expect(await runtime.closeIdle()).toEqual([]);
  });

  test('shutdown waits for pending profile acquisition and leaves no late lease or browser', async () => {
    const { runtime, chromium } = setup();
    let acquired; let finish;
    const entered = new Promise(resolve => { acquired = resolve; });
    const gate = new Promise(resolve => { finish = resolve; });
    const profile = runtime.profile.bind(runtime);
    jest.spyOn(runtime, 'profile').mockImplementation(async key => {
      const result = await profile(key); acquired(); await gate; return result;
    });
    const opening = runtime.open(identity, { url: 'https://fixture.test/' }).catch(error => error);
    await entered;
    let settled = false; const stopping = runtime.dispose().then(result => { settled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    try { expect((await fs.readdir(rootDir)).some(name => name.endsWith('.lease'))).toBe(true); }
    finally { finish(); }
    expect((await opening).code).toBe('computer_disposed');
    expect((await stopping).every(result => result.status === 'fulfilled')).toBe(true);
    expect((await fs.readdir(rootDir)).some(name => name.endsWith('.lease'))).toBe(false);
    expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
    expect(runtime.computers.size).toBe(0);
  });

  test('a late authorization cannot open a profile after shutdown begins', async () => {
    const { runtime, authorize, chromium } = setup();
    let enter; let finish;
    const entered = new Promise(resolve => { enter = resolve; });
    authorize.mockImplementationOnce(() => { enter(); return new Promise(resolve => { finish = resolve; }); });
    const opening = runtime.open(identity, { url: 'https://fixture.test/' }).catch(error => error);
    await entered; const stopping = runtime.dispose(); finish(true);
    expect((await opening).code).toBe('computer_disposed');
    await stopping;
    expect(await fs.readdir(rootDir)).toEqual([]);
    expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
  });

  test('timed-out profile acquisition still keeps disposal pending until the exact lease is released', async () => {
    const { runtime, chromium } = setup({ timeoutMs: 100 });
    let enter; let finish;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { finish = resolve; });
    const profile = runtime.profile.bind(runtime);
    jest.spyOn(runtime, 'profile').mockImplementation(async key => {
      const result = await profile(key); enter(); await gate; return result;
    });
    const opening = runtime.open(identity, { url: 'https://fixture.test/' }).catch(error => error);
    await entered;
    expect((await opening).code).toBe('computer_timeout');
    let settled = false;
    const stopping = runtime.dispose().then(result => { settled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    try { expect(settled).toBe(false); expect(runtime.computers.size).toBe(1); }
    finally { finish(); }
    expect((await stopping).every(result => result.status === 'fulfilled')).toBe(true);
    expect((await fs.readdir(rootDir)).some(name => name.endsWith('.lease'))).toBe(false);
    expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
    expect(runtime.computers.size).toBe(0);
  });

  test('late page-title completion cannot mint an observation after disposal', async () => {
    const { runtime, page } = setup();
    const view = await runtime.open(identity, { url: 'https://fixture.test/' });
    const state = runtime.computers.get(view.computerId);
    let enter; let finish;
    const entered = new Promise(resolve => { enter = resolve; });
    page.title.mockImplementationOnce(() => { enter(); return new Promise(resolve => { finish = resolve; }); });
    const observing = runtime.observe(identity, { computerId: view.computerId }).catch(error => error);
    await entered; const stopping = runtime.dispose(); finish('PRIVATE_LATE_TITLE');
    expect((await observing).code).toBe('computer_not_open');
    await stopping;
    expect(state.frameId).toBeNull(); expect(state.observation).toBeNull();
  });

  test('a failed context close remains a failed cleanup result on repeated dispose', async () => {
    const { runtime, context } = setup();
    await runtime.open(identity, { url: 'https://fixture.test/' });
    context.close.mockRejectedValue(new Error('Closure unconfirmed'));
    const stopping = runtime.dispose();
    expect((await stopping).some(result => result.status === 'rejected')).toBe(true);
    expect(runtime.dispose()).toBe(stopping);
    expect((await runtime.dispose()).some(result => result.status === 'rejected')).toBe(true);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect((await fs.readdir(rootDir)).some(name => name.endsWith('.lease'))).toBe(true);
  });

  test.each([
    ['No usable sandbox! PRIVATE_PROFILE_PATH', 'computer_sandbox_unavailable'],
    ['Failed to move to new namespace: Operation not permitted PRIVATE_TOKEN', 'computer_sandbox_unavailable'],
    ["Executable doesn't exist at PRIVATE_PATH", 'computer_browser_unavailable'],
    ['error while loading shared libraries PRIVATE_LIBRARY', 'computer_browser_dependencies_unavailable'],
    ['Unknown startup failure PRIVATE_URL', 'computer_browser_launch_failed'],
  ])('sanitizes browser launch diagnostics and preserves sandbox settings: %s', async (diagnostic, code) => {
    const { runtime, chromium } = setup();
    chromium.launchPersistentContext.mockRejectedValue(new Error(diagnostic));
    let received;
    try { await runtime.open(identity, { url: 'https://fixture.test/' }); } catch (error) { received = error; }
    expect(received).toMatchObject({ code });
    expect(received.message).not.toContain('PRIVATE'); expect(received.cause).toBeUndefined();
    expect(chromium.launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(chromium.launchPersistentContext.mock.calls[0][1]).toMatchObject({ chromiumSandbox: true, args: [] });
    await runtime.dispose();
    expect(runtime.computers.size).toBe(0);
    expect((await fs.readdir(rootDir)).some(name => name.endsWith('.lease'))).toBe(false);
  });

  test('private error provenance distinguishes a stale frame before dispatch from stale capture after an action', async () => {
    const { runtime, page } = setup();
    const view = await runtime.open(identity, { url: 'https://fixture.test/' });
    const before = await runtime.act(identity, { computerId: view.computerId, frameId: 'old-frame', action: { type: 'click', x: 1, y: 1 } }).catch(error => error);
    expect(before.code).toBe('computer_stale_frame');
    expect(runtime.isPreDispatchFailure(before)).toBe(true);
    expect(runtime.isPreDispatchFailure(Object.assign(new Error('Forged'), { code: before.code }))).toBe(false);
    expect(page.mouse.click).not.toHaveBeenCalled();
    page.screenshot.mockImplementationOnce(async () => { page.currentUrl = 'https://fixture.test/changed'; return Buffer.from('private-pixels'); });
    const after = await runtime.act(identity, { computerId: view.computerId, frameId: view.frameId, action: { type: 'click', x: 1, y: 1 } }).catch(error => error);
    expect(after.code).toBe('computer_stale_frame');
    expect(runtime.isPreDispatchFailure(after)).toBe(false);
    expect(page.mouse.click).toHaveBeenCalledTimes(1);
  });

  test('task claims reach background request policy while profile identity stays stable', async () => {
    const { runtime, authorize, context } = setup();
    const claim = { taskId: 'task-1', workerId: 'worker-1', claimId: 'claim-1' };
    const scoped = { ...identity, claim };
    const view = await runtime.open(scoped, { url: 'https://fixture.test/' });
    expect(view.computerId).toBe(identityKey(identity));
    const route = { request: () => ({ isNavigationRequest: () => false, url: () => 'https://fixture.test/background' }),
      continue: jest.fn(), abort: jest.fn(async () => {}) };
    const intercept = context.route.mock.calls[0][1];
    await intercept(route);
    expect(authorize).toHaveBeenLastCalledWith(expect.objectContaining({ identity: scoped, operation: 'request' }));
    authorize.mockResolvedValue(false);
    await intercept(route);
    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(JSON.stringify(view)).not.toContain('claim-1');
  });

  test('new claim closes the old context before reusing its profile and rejects old frames', async () => {
    const { runtime, chromium, context } = setup();
    const first = { ...identity, claim: { taskId: 'task-1', workerId: 'worker', claimId: 'claim-1' } };
    const second = { ...identity, claim: { taskId: 'task-2', workerId: 'worker', claimId: 'claim-2' } };
    const old = await runtime.open(first, { url: 'https://fixture.test/' });
    await expect(runtime.observe(second, { computerId: old.computerId })).rejects.toMatchObject({ code: 'computer_claim_denied' });
    await expect(runtime.getModelInput(identity, { computerId: old.computerId, frameId: old.frameId })).rejects.toMatchObject({ code: 'computer_claim_denied' });
    const current = await runtime.open(second, { url: 'https://fixture.test/' });
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(chromium.launchPersistentContext).toHaveBeenCalledTimes(2);
    expect(chromium.launchPersistentContext.mock.calls[0][0]).toBe(chromium.launchPersistentContext.mock.calls[1][0]);
    expect(current.computerId).toBe(old.computerId);
    expect(current.frameId).not.toBe(old.frameId);
    await expect(runtime.act(first, { computerId: old.computerId, frameId: old.frameId, action: { type: 'wait', ms: 0 } })).rejects.toMatchObject({ code: 'computer_claim_denied' });
  });

  test('a denied new claim cannot evict the current browser', async () => {
    const { runtime, authorize, context, chromium } = setup();
    const first = { ...identity, claim: { taskId: 'task', workerId: 'worker', claimId: 'current' } };
    const view = await runtime.open(first, { url: 'https://fixture.test/' });
    authorize.mockImplementation(async ({ identity: owner }) => owner.claim.claimId === 'current');
    await expect(runtime.open({ ...first, claim: { ...first.claim, claimId: 'foreign' } }, { url: 'https://fixture.test/' })).rejects.toMatchObject({ code: 'computer_policy_denied' });
    expect(context.close).not.toHaveBeenCalled();
    expect(chromium.launchPersistentContext).toHaveBeenCalledTimes(1);
    expect((await runtime.observe(first, { computerId: view.computerId })).computerId).toBe(view.computerId);
  });

  test('hung previous context close times out without launching a replacement or releasing its lease', async () => {
    const { runtime, context, chromium } = setup({ timeoutMs: 100 });
    const first = { ...identity, claim: { taskId: 'one', workerId: 'worker', claimId: 'one' } };
    const second = { ...identity, claim: { taskId: 'two', workerId: 'worker', claimId: 'two' } };
    const view = await runtime.open(first, { url: 'https://fixture.test/' });
    let finish;
    context.close.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    try {
      await expect(runtime.open(second, { url: 'https://fixture.test/' })).rejects.toMatchObject({ code: 'computer_timeout' });
      expect(chromium.launchPersistentContext).toHaveBeenCalledTimes(1);
      expect((await fs.stat(path.join(rootDir, `${view.computerId}.lease`))).isDirectory()).toBe(true);
    } finally { finish(); await runtime.dispose(); }
  });

  test('binds isolated identities and retains one resident browser across observation/action', async () => {
    const { runtime, chromium, page, context, locator } = setup();
    const first = await runtime.open(identity, { url: 'https://fixture.test/' });
    expect(first).toMatchObject({ private: true, computerId: identityKey(identity), image: { mimeType: 'image/png' } });
    expect(Buffer.isBuffer(first.image.buffer)).toBe(true);
    expect(first).not.toHaveProperty('downloadUrl');
    const second = await runtime.act(identity, { computerId: first.computerId, frameId: first.frameId, action: { type: 'fill', selector: '#entry', text: '  keep whitespace\n' } });
    expect(locator.fill).toHaveBeenCalledWith('  keep whitespace\n');
    expect(second.frameId).not.toBe(first.frameId);
    await runtime.observe(identity, { computerId: first.computerId });
    expect(chromium.launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(context.close).not.toHaveBeenCalled();
    const [directory, options] = chromium.launchPersistentContext.mock.calls[0];
    expect(directory).toBe(path.join(rootDir, identityKey(identity)));
    expect(options).toMatchObject({ ignoreHTTPSErrors: false, args: [], chromiumSandbox: true, serviceWorkers: 'block', acceptDownloads: false });
    expect(options).not.toHaveProperty('extraHTTPHeaders');
  });

  test.each(['ownerId', 'teamId', 'agentId'])('rejects another %s using a known computer id', async (key) => {
    const { runtime } = setup();
    const first = await runtime.open(identity, { url: 'https://fixture.test/' });
    await expect(runtime.observe({ ...identity, [key]: 'different' }, { computerId: first.computerId })).rejects.toMatchObject({ code: 'computer_scope_denied' });
  });

  test('requires current frame, bounds coordinates, and never replays a failed action', async () => {
    const { runtime, page, locator } = setup();
    const first = await runtime.open(identity, { url: 'https://fixture.test/' });
    const second = await runtime.observe(identity, { computerId: first.computerId });
    const params = { computerId: first.computerId, frameId: first.frameId, action: { type: 'click', x: 12, y: 13 } };
    await expect(runtime.act(identity, params)).rejects.toMatchObject({ code: 'computer_stale_frame' });
    await expect(runtime.act(identity, { ...params, frameId: second.frameId, action: { type: 'click', x: 9000, y: 1 } })).rejects.toMatchObject({ code: 'computer_invalid_action' });
    await runtime.act(identity, { ...params, frameId: second.frameId });
    expect(page.mouse.click).toHaveBeenCalledWith(12, 13);
    const frame = await runtime.observe(identity, { computerId: first.computerId });
    locator.click.mockRejectedValueOnce(new Error('partial action failed'));
    const failed = { computerId: first.computerId, frameId: frame.frameId, action: { type: 'click', selector: '#submit' } };
    await expect(runtime.act(identity, failed)).rejects.toThrow('partial action failed');
    await expect(runtime.act(identity, failed)).rejects.toMatchObject({ code: 'computer_stale_frame' });
    expect(locator.click).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  test('checks every network request independently and denies websocket connections', async () => {
    const { runtime, context, authorize } = setup();
    await runtime.open(identity, { url: 'https://fixture.test/' });
    const handler = context.route.mock.calls[0][1];
    const route = { request: () => ({ url: () => 'https://external.test/secret', isNavigationRequest: () => false }), continue: jest.fn(), abort: jest.fn(async () => {}) };
    authorize.mockImplementation(async ({ url }) => !url.includes('external.test'));
    await handler(route);
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(route.continue).not.toHaveBeenCalled();
    const socket = { close: jest.fn() };
    await context.routeWebSocket.mock.calls[0][1](socket);
    expect(socket.close).toHaveBeenCalled();
  });

  test('denies action before mutation and preserves observation', async () => {
    const { runtime, page, authorize } = setup();
    const first = await runtime.open(identity, { url: 'https://fixture.test/' });
    authorize.mockImplementation(async ({ operation }) => operation !== 'act');
    await expect(runtime.act(identity, { computerId: first.computerId, frameId: first.frameId, action: { type: 'click', x: 1, y: 1 } })).rejects.toMatchObject({ code: 'computer_policy_denied' });
    expect(page.mouse.click).not.toHaveBeenCalled();
    expect(runtime.computers.get(first.computerId).frameId).toBe(first.frameId);
  });

  test('serializes parallel actions so only the first can use a frame', async () => {
    const { runtime, page } = setup();
    const first = await runtime.open(identity, { url: 'https://fixture.test/' });
    const params = { computerId: first.computerId, frameId: first.frameId, action: { type: 'click', x: 1, y: 1 } };
    const results = await Promise.allSettled([runtime.act(identity, params), runtime.act(identity, params)]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1].reason.code).toBe('computer_stale_frame');
    expect(page.mouse.click).toHaveBeenCalledTimes(1);
  });

  test('uses a filesystem lease across runtime instances and retains profile after close', async () => {
    const first = setup();
    const second = setup();
    const frame = await first.runtime.open(identity, { url: 'https://fixture.test/' });
    await expect(second.runtime.open(identity, { url: 'https://fixture.test/' })).rejects.toMatchObject({ code: 'computer_profile_leased' });
    await first.runtime.close(identity, { computerId: frame.computerId });
    expect((await fs.stat(path.join(rootDir, frame.computerId))).isDirectory()).toBe(true);
    await expect(fs.stat(path.join(rootDir, `${frame.computerId}.lease`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('closes idle browser and reopens retained profile', async () => {
    let time = 10000;
    const { runtime, context, chromium } = setup({ now: () => time, idleMs: 1000 });
    const first = await runtime.open(identity, { url: 'https://fixture.test/' });
    time += 1001;
    await runtime.closeIdle();
    expect(context.close).toHaveBeenCalledTimes(1);
    const resumed = await runtime.open(identity, { url: 'https://fixture.test/' });
    expect(resumed.computerId).toBe(first.computerId);
    expect(chromium.launchPersistentContext.mock.calls[1][0]).toBe(chromium.launchPersistentContext.mock.calls[0][0]);
  });

  test('cancels a blocked operation and closes its browser without retry', async () => {
    const { runtime, page, context } = setup();
    const first = await runtime.open(identity, { url: 'https://fixture.test/' });
    page.screenshot.mockImplementation(() => new Promise(() => {}));
    const abort = new AbortController();
    const pending = runtime.observe(identity, { computerId: first.computerId, signal: abort.signal });
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'computer_aborted' });
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  test('retains lease while a timed-out Chromium launch has not resolved', async () => {
    const { runtime, chromium, context } = setup({ timeoutMs: 100 });
    let resolveLaunch;
    chromium.launchPersistentContext.mockImplementation(() => new Promise((resolve) => { resolveLaunch = resolve; }));
    await expect(runtime.open(identity, { url: 'https://fixture.test/' })).rejects.toMatchObject({ code: 'computer_timeout' });
    expect((await fs.stat(path.join(rootDir, `${identityKey(identity)}.lease`))).isDirectory()).toBe(true);
    resolveLaunch(context);
    await runtime.dispose();
    expect(context.close).toHaveBeenCalledTimes(1);
    await expect(fs.stat(path.join(rootDir, `${identityKey(identity)}.lease`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects invalid identities, embedded credentials, and unbounded image capture', async () => {
    const { runtime, page } = setup({ maxImageBytes: 1024 });
    await expect(runtime.open({ ...identity, ownerId: '' }, { url: 'https://fixture.test/' })).rejects.toMatchObject({ code: 'computer_identity_required' });
    await expect(runtime.open(identity, { url: 'https://user:password@fixture.test/' })).rejects.toMatchObject({ code: 'computer_invalid_url' });
    page.screenshot.mockResolvedValue(Buffer.alloc(1025));
    await expect(runtime.open(identity, { url: 'https://fixture.test/' })).rejects.toMatchObject({ code: 'computer_image_limit' });
  });

  test('tool event serialization and spread never expose pixels, title, or sensitive URLs', async () => {
    const { runtime } = setup();
    const first = await runtime.open(identity, { url: 'https://fixture.test/?token=private-token' });
    expect(first.url).toContain('private-token');
    expect(first.title).toBe('Fixture');
    expect(first.image.buffer.toString()).toBe('private-pixels');
    for (const serialized of [JSON.stringify(first), JSON.stringify({ ...first })]) {
      expect(serialized).not.toContain('private-pixels');
      expect(serialized).not.toContain('private-token');
      expect(serialized).not.toContain('Fixture');
      expect(serialized).not.toContain('image');
    }
  });

  test('model input uses internally stored current owned pixels, never supplied observations', async () => {
    const { runtime } = setup();
    const first = await runtime.open(identity, { url: 'https://fixture.test/' });
    first.image.buffer.fill(0); // Caller cannot tamper with the canonical frame.
    const input = await runtime.getModelInput(identity, { computerId: first.computerId, frameId: first.frameId, observation: { image: 'forged' } });
    expect(input[1]).toEqual({ type: 'input_image', image_url: `data:image/png;base64,${Buffer.from('private-pixels').toString('base64')}`, detail: 'high' });
    await expect(runtime.getModelInput({ ...identity, agentId: 'other' }, { computerId: first.computerId, frameId: first.frameId })).rejects.toMatchObject({ code: 'computer_scope_denied' });
    await runtime.observe(identity, { computerId: first.computerId });
    await expect(runtime.getModelInput(identity, { computerId: first.computerId, frameId: first.frameId })).rejects.toMatchObject({ code: 'computer_stale_frame' });
  });

  test('rejects navigation that races action authorization', async () => {
    const { runtime, page, authorize } = setup();
    const first = await runtime.open(identity, { url: 'https://fixture.test/' });
    authorize.mockImplementation(async ({ operation }) => {
      if (operation === 'act') page.on.mock.calls.find(([event]) => event === 'framenavigated')[1]();
      return true;
    });
    await expect(runtime.act(identity, { computerId: first.computerId, frameId: first.frameId, action: { type: 'click', x: 1, y: 1 } })).rejects.toMatchObject({ code: 'computer_stale_frame' });
    expect(page.mouse.click).not.toHaveBeenCalled();
  });

  test('fails closed if WebSocket routing is unavailable', async () => {
    const { runtime, context, page } = setup();
    context.routeWebSocket = undefined;
    await expect(runtime.open(identity, { url: 'https://fixture.test/' })).rejects.toMatchObject({ code: 'computer_unsupported_browser' });
    expect(page.goto).not.toHaveBeenCalled();
  });

  test('websockets remain denied without explicit opt-in even when generic policy permits', async () => {
    const { runtime, context, authorize } = setup();
    await runtime.open(identity, { url: 'https://fixture.test/' });
    const socket = fakeSocket();
    await context.routeWebSocket.mock.calls[0][1](socket.page);
    expect(socket.page.close).toHaveBeenCalled();
    expect(socket.page.connectToServer).not.toHaveBeenCalled();
    expect(authorize.mock.calls.some(([entry]) => entry.operation === 'websocket')).toBe(false);
  });

  test('opted-in sockets authorize connect and both directions without forwarding private payloads to policy', async () => {
    const { runtime, context, authorize } = setup({ allowWebSockets: true });
    const frame = await runtime.open(identity, { url: 'https://fixture.test/' });
    const fixture = fakeSocket();
    await context.routeWebSocket.mock.calls[0][1](fixture.page);
    const socket = [...runtime.computers.get(frame.computerId).sockets][0];
    fixture.page.message('private-outbound');
    fixture.server.message(Buffer.from('private-inbound'));
    await socket.chain;
    expect(fixture.page.connectToServer).toHaveBeenCalledWith();
    expect(fixture.server.send).toHaveBeenCalledWith('private-outbound');
    expect(fixture.page.send).toHaveBeenCalledWith(Buffer.from('private-inbound'));
    const checks = authorize.mock.calls.map(([entry]) => entry).filter((entry) => entry.operation === 'websocket');
    expect(checks.map((entry) => entry.action)).toEqual([
      { phase: 'connect' },
      { phase: 'message', direction: 'outbound', byteLength: 16 },
      { phase: 'message', direction: 'inbound', byteLength: 15 },
    ]);
    expect(checks.every((entry) => entry.url === 'wss://fixture.test/ws' && entry.identity.ownerId === identity.ownerId)).toBe(true);
    expect(JSON.stringify(checks)).not.toContain('private-outbound');
    expect(JSON.stringify(checks)).not.toContain('private-inbound');
  });

  test('denied websocket origin never opens an upstream socket', async () => {
    const { runtime, context, authorize } = setup({ allowWebSockets: true });
    await runtime.open(identity, { url: 'https://fixture.test/' });
    authorize.mockImplementation(async ({ operation, url }) => operation !== 'websocket' || new URL(url).host === 'fixture.test');
    const socket = fakeSocket('wss://denied.test/ws');
    await context.routeWebSocket.mock.calls[0][1](socket.page);
    expect(socket.page.connectToServer).not.toHaveBeenCalled();
    expect(socket.page.close).toHaveBeenCalled();
  });

  test.each(['inbound', 'outbound'])('revoked permission blocks next %s frame and closes both sides', async (direction) => {
    const { runtime, context, authorize } = setup({ allowWebSockets: true });
    const frame = await runtime.open(identity, { url: 'https://fixture.test/' });
    const fixture = fakeSocket();
    await context.routeWebSocket.mock.calls[0][1](fixture.page);
    const socket = [...runtime.computers.get(frame.computerId).sockets][0];
    authorize.mockImplementation(async ({ operation }) => operation !== 'websocket');
    (direction === 'inbound' ? fixture.server : fixture.page).message('must-not-forward');
    await socket.chain;
    expect(fixture.page.send).not.toHaveBeenCalled();
    expect(fixture.server.send).not.toHaveBeenCalled();
    expect(fixture.page.close).toHaveBeenCalled();
    expect(fixture.server.close).toHaveBeenCalled();
    expect(fixture.server.close).toHaveBeenCalledWith({ code: 4003, reason: 'Agent computer socket closed' });
  });

  test('serializes pending websocket frame authorization and waits before forwarding', async () => {
    const { runtime, context, authorize } = setup({ allowWebSockets: true });
    const frame = await runtime.open(identity, { url: 'https://fixture.test/' });
    const fixture = fakeSocket();
    await context.routeWebSocket.mock.calls[0][1](fixture.page);
    const socket = [...runtime.computers.get(frame.computerId).sockets][0];
    let permit;
    let checks = 0;
    authorize.mockImplementation(async ({ operation }) => {
      if (operation === 'websocket' && ++checks === 1) return new Promise((resolve) => { permit = resolve; });
      return true;
    });
    fixture.page.message('one');
    fixture.page.message('two');
    await new Promise((resolve) => setImmediate(resolve));
    expect(checks).toBe(1);
    expect(fixture.server.send).not.toHaveBeenCalled();
    permit(true);
    await socket.chain;
    expect(fixture.server.send.mock.calls.map(([message]) => message)).toEqual(['one', 'two']);
  });

  test.each([
    [{ maxSocketMessageBytes: 3 }, ['oversize']],
    [{ maxSocketQueueBytes: 5 }, ['one', 'two']],
    [{ maxSocketQueueMessages: 1 }, ['one', 'two']],
  ])('socket byte/count limits close the connection without forwarding queued frames', async (limits, messages) => {
    const { runtime, context } = setup({ allowWebSockets: true, ...limits });
    const frame = await runtime.open(identity, { url: 'https://fixture.test/' });
    const fixture = fakeSocket();
    await context.routeWebSocket.mock.calls[0][1](fixture.page);
    const socket = [...runtime.computers.get(frame.computerId).sockets][0];
    for (const message of messages) fixture.page.message(message);
    await socket.chain;
    await socket.closing;
    expect(fixture.page.close).toHaveBeenCalled();
    expect(fixture.server.close).toHaveBeenCalled();
    expect(fixture.server.send).not.toHaveBeenCalled();
  });

  test('computer dispose cancels an in-flight socket policy and drops private queued frames', async () => {
    const { runtime, context, authorize } = setup({ allowWebSockets: true });
    const frame = await runtime.open(identity, { url: 'https://fixture.test/' });
    const fixture = fakeSocket();
    await context.routeWebSocket.mock.calls[0][1](fixture.page);
    const socket = [...runtime.computers.get(frame.computerId).sockets][0];
    let policySignal;
    authorize.mockImplementation(async ({ operation, signal }) => {
      if (operation === 'websocket') { policySignal = signal; return new Promise(() => {}); }
      return true;
    });
    fixture.page.message('pending-private');
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.dispose();
    await socket.chain;
    expect(policySignal.aborted).toBe(true);
    expect(fixture.server.send).not.toHaveBeenCalled();
    expect(fixture.page.close).toHaveBeenCalled();
    expect(fixture.server.close).toHaveBeenCalled();
  });

  test('socket authorization timeout closes socket and prevents delayed forwarding', async () => {
    const { runtime, context, authorize } = setup({ allowWebSockets: true, timeoutMs: 100 });
    const frame = await runtime.open(identity, { url: 'https://fixture.test/' });
    const fixture = fakeSocket();
    await context.routeWebSocket.mock.calls[0][1](fixture.page);
    const socket = [...runtime.computers.get(frame.computerId).sockets][0];
    authorize.mockImplementation(async ({ operation }) => operation === 'websocket' ? new Promise(() => {}) : true);
    fixture.server.message('pending-private');
    await socket.chain;
    expect(fixture.page.send).not.toHaveBeenCalled();
    expect(fixture.page.close).toHaveBeenCalled();
  });

  test('socket count cap and embedded credentials cannot be bypassed', async () => {
    const { runtime, context } = setup({ allowWebSockets: true, maxWebSockets: 1 });
    await runtime.open(identity, { url: 'https://fixture.test/' });
    const route = context.routeWebSocket.mock.calls[0][1];
    const invalid = fakeSocket('wss://user:secret@fixture.test/ws');
    await route(invalid.page);
    expect(invalid.page.connectToServer).not.toHaveBeenCalled();
    const first = fakeSocket();
    await route(first.page);
    const second = fakeSocket();
    await route(second.page);
    expect(second.page.connectToServer).not.toHaveBeenCalled();
    expect(second.page.close).toHaveBeenCalled();
  });

  test('computer cancellation closes established sockets and stops a pending handshake', async () => {
    const { runtime, context, page, authorize } = setup({ allowWebSockets: true });
    const frame = await runtime.open(identity, { url: 'https://fixture.test/' });
    const route = context.routeWebSocket.mock.calls[0][1];
    const established = fakeSocket();
    await route(established.page);
    authorize.mockImplementation(async ({ operation }) => operation === 'websocket' ? new Promise(() => {}) : true);
    const pending = fakeSocket();
    const handshake = route(pending.page);
    page.screenshot.mockImplementation(() => new Promise(() => {}));
    const abort = new AbortController();
    const observation = runtime.observe(identity, { computerId: frame.computerId, signal: abort.signal });
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await expect(observation).rejects.toMatchObject({ code: 'computer_aborted' });
    await handshake;
    await runtime.dispose();
    expect(established.server.close).toHaveBeenCalled();
    expect(established.page.close).toHaveBeenCalled();
    expect(pending.page.connectToServer).not.toHaveBeenCalled();
  });
});
