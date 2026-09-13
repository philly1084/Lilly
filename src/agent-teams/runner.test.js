'use strict';

const { TeamRunner } = require('./runner');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
};
const setup = () => {
  const service = {
    store: { listRunnable: jest.fn(async () => [{ id: 'team', ownerId: 'owner' }]) },
    claimEnabled: jest.fn(async () => []), recordResult: jest.fn(async () => {}),
    heartbeat: jest.fn(async () => ({ cancelled: false })), unobserved: jest.fn(async () => {}),
  };
  const execute = jest.fn();
  return { service, execute, runner: new TeamRunner({ service, execute, workerId: 'worker' }) };
};

test('one immutable owner is acquired before admission and reused for this runner', async () => {
  const { runner, service } = setup();
  const original = runner.resolveExecutionOwner;
  runner.resolveExecutionOwner = jest.fn(original);
  const owner = await runner.prepareOwner();
  await runner.tick(); await runner.tick();
  expect(runner.resolveExecutionOwner).toHaveBeenCalledTimes(1);
  expect(service.claimEnabled).toHaveBeenCalledWith('team', 'owner', 'worker', 8, owner);
  expect(Object.isFrozen(owner)).toBe(true);
  expect(() => { owner.pid = 1; }).toThrow();
});

test('ownership acquisition failure prevents admission and cannot silently select another owner', async () => {
  const { runner, service, execute } = setup();
  runner.resolveExecutionOwner = jest.fn(async () => { throw new Error('Owner unavailable'); });
  await expect(runner.tick()).rejects.toThrow('Owner unavailable');
  await expect(runner.tick()).rejects.toThrow('Owner unavailable');
  expect(runner.resolveExecutionOwner).toHaveBeenCalledTimes(1);
  expect(service.claimEnabled).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  expect(runner.admissionUncertain).toBe(false);
});

test('concurrent owner preparation and tick share one acquisition and immutable result', async () => {
  const { runner, service } = setup();
  const owner = await runner.resolveExecutionOwner(); const acquiring = deferred();
  runner.resolveExecutionOwner = jest.fn(() => acquiring.promise);
  const first = runner.prepareOwner(); const second = runner.prepareOwner();
  const tick = runner.tick();
  expect(second).toBe(first);
  acquiring.resolve(owner);
  await tick;
  expect(await first).toBe(await second);
  expect(Object.isFrozen(await first)).toBe(true);
  expect(runner.resolveExecutionOwner).toHaveBeenCalledTimes(1);
  expect(service.claimEnabled).toHaveBeenCalledWith('team', 'owner', 'worker', 8, await first);
});

test('stop during owner observation prevents late admission', async () => {
  const { runner, service } = setup();
  const acquiring = deferred(); const entered = deferred();
  const owner = await runner.resolveExecutionOwner();
  runner.resolveExecutionOwner = () => { entered.resolve(); return acquiring.promise; };
  const tick = runner.tick(); await entered.promise;
  runner.stop(); acquiring.resolve(owner); await tick;
  expect(service.claimEnabled).not.toHaveBeenCalled();
});

test('stop during inventory prevents admission, including an old tick after restart', async () => {
  const { service, runner } = setup();
  const inventory = deferred();
  service.store.listRunnable.mockReturnValueOnce(inventory.promise);
  const tick = runner.tick();
  runner.stop();
  runner.start();
  inventory.resolve([{ id: 'team', ownerId: 'owner' }]);
  await tick;
  expect(service.claimEnabled).not.toHaveBeenCalled();
  runner.stop();
});

test('claim committed during shutdown is cancelled before any executor starts', async () => {
  const { service, execute, runner } = setup();
  const claims = deferred();
  const entered = deferred();
  service.claimEnabled.mockImplementationOnce(() => { entered.resolve(); return claims.promise; });
  const tick = runner.tick();
  await entered.promise;
  runner.stop();
  claims.resolve([{ id: 'task', worker: { claimId: 'claim' } }]);
  await tick;
  expect(execute).not.toHaveBeenCalled();
  expect(service.recordResult).toHaveBeenCalledWith('team', 'owner',
    { taskId: 'task', workerId: 'worker', claimId: 'claim' }, expect.objectContaining({ status: 'cancelled' }));
  await runner.tick();
  expect(service.store.listRunnable).toHaveBeenCalledTimes(1);
});

test('stop aborts active executor but does not release its occupancy prematurely', async () => {
  const { service, execute, runner } = setup();
  const work = deferred();
  execute.mockReturnValue(work.promise);
  service.claimEnabled.mockResolvedValue([{ id: 'task', worker: { claimId: 'claim' } }]);
  await runner.tick();
  const entry = runner.active.get('task');
  runner.stop();
  expect(entry.controller.signal.aborted).toBe(true);
  expect(runner.active.size).toBe(1);
  work.resolve({ status: 'cancelled', summary: 'Stopped.', artifactIds: [] });
  await entry.done;
  expect(runner.active.size).toBe(0);
});

test.each([0, -1, 65, NaN, 1.5])('invalid capacity %s is rejected', (maxActive) => {
  expect(() => new TeamRunner({ service: {}, execute: jest.fn(), maxActive })).toThrow('configuration');
});

test('drain waits for executor AND result persistence, then permits explicit restart', async () => {
  const { runner, service, execute } = setup();
  const work = deferred(); const saved = deferred(); const saving = deferred();
  execute.mockReturnValue(work.promise);
  service.recordResult.mockImplementation(() => { saving.resolve(); return saved.promise; });
  service.claimEnabled.mockResolvedValueOnce([{ id: 'task', worker: { claimId: 'claim' } }]);
  await runner.tick();
  let completed = false;
  const drain = runner.drain({ timeoutMs: 1000 }).then(value => { completed = true; return value; });
  expect(runner.active.get('task').controller.signal.aborted).toBe(true);
  expect(() => runner.start()).toThrow('drain remains unsettled');
  work.resolve({ status: 'cancelled', summary: 'Observed cancellation.', artifactIds: [] });
  await saving.promise;
  expect(completed).toBe(false);
  expect(runner.active.has('task')).toBe(true);
  saved.resolve();
  expect(await drain).toEqual({ settled: true, pendingTaskIds: [], admissionPending: false, admissionUncertain: false, unobservedTaskIds: [] });
  expect(service.unobserved).not.toHaveBeenCalled();
  runner.start(); expect(runner.stopped).toBe(false); runner.stop();
});

test('timed-out drain retains active occupancy and restart barrier until a later clean drain', async () => {
  const { runner, service, execute } = setup(); const work = deferred();
  execute.mockReturnValue(work.promise);
  service.claimEnabled.mockResolvedValueOnce([{ id: 'task', worker: { claimId: 'claim' } }]);
  await runner.tick(); const entry = runner.active.get('task');
  expect(await runner.drain({ timeoutMs: 5 })).toMatchObject({ settled: false, pendingTaskIds: ['task'] });
  expect(runner.active.get('task')).toBe(entry);
  expect(service.recordResult).not.toHaveBeenCalled();
  expect(() => runner.start()).toThrow('drain remains unsettled');
  work.resolve({ status: 'cancelled', summary: 'Observed cancellation.', artifactIds: [] });
  await entry.done;
  expect(() => runner.start()).toThrow('drain remains unsettled');
  expect((await runner.drain({ timeoutMs: 100 })).settled).toBe(true);
  runner.start(); runner.stop();
});

test('drain includes unresolved inventory and joins tick completion without claiming it settled', async () => {
  const { runner, service } = setup(); const inventory = deferred();
  service.store.listRunnable.mockReturnValueOnce(inventory.promise);
  const tick = runner.tick();
  expect(runner.tick()).toBe(tick);
  expect(await runner.drain({ timeoutMs: 5 })).toMatchObject({ settled: false, admissionPending: true, pendingTaskIds: [] });
  inventory.resolve([{ id: 'team', ownerId: 'owner' }]); await tick;
  expect(service.claimEnabled).not.toHaveBeenCalled();
  expect((await runner.drain({ timeoutMs: 100 })).settled).toBe(true);
});

test('drain tracks late committed admission through unstarted-claim cancellation persistence', async () => {
  const { runner, service, execute } = setup(); const claims = deferred(); const entered = deferred(); const persisted = deferred(); const saving = deferred();
  service.claimEnabled.mockImplementationOnce(() => { entered.resolve(); return claims.promise; });
  service.recordResult.mockImplementationOnce(() => { saving.resolve(); return persisted.promise; });
  const tick = runner.tick(); await entered.promise;
  const drain = runner.drain({ timeoutMs: 1000 });
  claims.resolve([{ id: 'late-task', worker: { claimId: 'claim' } }]); await saving.promise;
  expect(await runner.drain({ timeoutMs: 5 })).toMatchObject({ settled: false, pendingTaskIds: ['late-task'], admissionPending: true });
  expect(execute).not.toHaveBeenCalled();
  persisted.resolve(); await tick;
  expect((await drain).settled).toBe(true);
  expect(runner.pendingAdmissions.size).toBe(0);
});

test('uncertain admission failure cannot produce settled drain or silent restart', async () => {
  const { runner, service } = setup(); const claims = deferred(); const entered = deferred();
  service.claimEnabled.mockImplementationOnce(() => { entered.resolve(); return claims.promise; });
  const tick = runner.tick(); const rejection = expect(tick).rejects.toThrow('unknown commit'); await entered.promise;
  const drain = runner.drain({ timeoutMs: 1000 });
  claims.reject(new Error('unknown commit')); await rejection;
  expect(await drain).toMatchObject({ settled: false, admissionUncertain: true, pendingTaskIds: [] });
  expect(() => runner.start()).toThrow('drain remains unsettled');
  expect(service.recordResult).not.toHaveBeenCalled();
});

test('failed persistence of unstarted cancellation retains every admitted task id', async () => {
  const { runner, service, execute } = setup(); const claims = deferred(); const entered = deferred();
  service.claimEnabled.mockImplementationOnce(() => { entered.resolve(); return claims.promise; });
  service.recordResult.mockRejectedValue(new Error('unknown result commit'));
  const tick = runner.tick(); const rejection = expect(tick).rejects.toThrow('unknown result commit'); await entered.promise;
  const drain = runner.drain({ timeoutMs: 1000 });
  claims.resolve([{ id: 'first', worker: { claimId: 'a' } }, { id: 'second', worker: { claimId: 'b' } }]);
  await rejection;
  expect(await drain).toMatchObject({ settled: false, pendingTaskIds: ['first', 'second'], unobservedTaskIds: ['first', 'second'] });
  expect(execute).not.toHaveBeenCalled();
  expect(service.recordResult).toHaveBeenCalledTimes(1);
  expect(() => runner.start()).toThrow('drain remains unsettled');
});

test('unobserved executor outcome remains pending after local executor promise ends', async () => {
  const { runner, service, execute } = setup(); const work = deferred();
  execute.mockReturnValue(work.promise);
  service.claimEnabled.mockResolvedValueOnce([{ id: 'unknown-task', worker: { claimId: 'claim' } }]);
  await runner.tick(); const entry = runner.active.get('unknown-task');
  const drain = runner.drain({ timeoutMs: 1000 }); work.reject(new Error('tool may still be running'));
  await entry.done;
  expect(await drain).toMatchObject({ settled: false, pendingTaskIds: ['unknown-task'], unobservedTaskIds: ['unknown-task'] });
  expect(service.unobserved).toHaveBeenCalledTimes(1);
  expect(service.recordResult).not.toHaveBeenCalled();
  expect(() => runner.start()).toThrow('drain remains unsettled');
});

test('concurrent drains honor separate deadlines and never start while another drain is active', async () => {
  const { runner, service, execute } = setup(); const work = deferred();
  execute.mockReturnValue(work.promise);
  service.claimEnabled.mockResolvedValueOnce([{ id: 'task', worker: { claimId: 'claim' } }]);
  await runner.tick();
  const longDrain = runner.drain({ timeoutMs: 1000 });
  expect((await runner.drain({ timeoutMs: 5 })).settled).toBe(false);
  runner.stop(); expect(() => runner.start()).toThrow('drain remains unsettled');
  work.resolve({ status: 'cancelled', summary: 'Observed cancellation.', artifactIds: [] });
  expect((await longDrain).settled).toBe(true);
  runner.start(); runner.stop();
});

test.each([0, -1, 60001, Infinity, NaN, 1.5])('invalid drain deadline %s does not change lifecycle', async timeoutMs => {
  const { runner } = setup();
  await expect(runner.drain({ timeoutMs })).rejects.toThrow('deadline');
  expect(runner.stopped).toBe(false); expect(runner.draining).toBe(0);
});
