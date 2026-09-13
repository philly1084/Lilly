'use strict';

const { createSupervisedComputerRuntime } = require('./supervised-runtime');
const identity = { ownerId: 'owner', teamId: 'team', agentId: 'agent', claim: { taskId: 'task', workerId: 'worker', claimId: 'claim' } };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const computer = { open: jest.fn(async () => ({ computerId: 'fixture' })), observe: jest.fn(async () => ({})),
    dispose: jest.fn(async () => []), isPreDispatchFailure: jest.fn(() => false) };
  const lease = { computer, close: jest.fn(async () => {}) };
  const createLease = jest.fn(async () => lease); const authorize = jest.fn(async () => true);
  const runtime = createSupervisedComputerRuntime({ createLease, authorize });
  return { runtime, lease, computer, createLease, authorize };
}

test('one acquisition serves the exact claim; a different claim cannot steal a live profile', async () => {
  const f = fixture();
  await Promise.all([f.runtime.open(identity, { url: 'https://fixture/' }), f.runtime.open(identity, { url: 'https://fixture/' })]);
  expect(f.createLease).toHaveBeenCalledTimes(1);
  const other = { ...identity, claim: { ...identity.claim, taskId: 'next' } };
  await expect(f.runtime.open(other, {})).rejects.toMatchObject({ code: 'computer_claim_denied' });
  expect(await f.createLease.mock.calls[0][0].authorize({ identity })).toBe(true);
  expect(await f.createLease.mock.calls[0][0].authorize({ identity: other })).toBe(false);
  await f.runtime.releaseClaim(identity);
  expect(f.computer.dispose).toHaveBeenCalledTimes(1); expect(f.lease.close).toHaveBeenCalledTimes(1);
  await f.runtime.open(other, {}); expect(f.createLease).toHaveBeenCalledTimes(2);
  await f.runtime.dispose();
});

test('stop before acquisition invokes no supervisor and has no resource cleanup debt', async () => {
  const f = fixture();
  const opening = f.runtime.open(identity, {}).catch(error => error);
  const stop = f.runtime.dispose(); expect(f.runtime.dispose()).toBe(stop);
  expect((await opening).code).toBe('computer_disposed');
  expect((await stop).every(result => result.status === 'fulfilled')).toBe(true);
  expect(f.createLease).not.toHaveBeenCalled();
});

test('shutdown waits for late acquisition and disposes it without dispatching an open', async () => {
  const f = fixture(); let finish;
  f.createLease.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const opening = f.runtime.open(identity, {}).catch(error => error); await tick();
  let stopped = false; const stop = f.runtime.dispose().then(result => { stopped = true; return result; });
  await tick(); expect(stopped).toBe(false); finish(f.lease);
  expect((await opening).code).toBe('computer_disposed'); await stop;
  expect(f.computer.open).not.toHaveBeenCalled(); expect(f.lease.close).toHaveBeenCalledTimes(1);
});

test('unknown factory outcome remains occupied without automatic reacquisition', async () => {
  const f = fixture(); f.createLease.mockRejectedValue(new Error('Create response lost'));
  const error = await f.runtime.open(identity, {}).catch(error => error);
  expect(error.message).toBe('Create response lost');
  expect(f.runtime.isPreDispatchFailure(error)).toBe(false);
  await expect(f.runtime.open(identity, {})).rejects.toThrow('Create response lost');
  expect(f.createLease).toHaveBeenCalledTimes(1);
  expect((await f.runtime.dispose()).some(result => result.status === 'rejected')).toBe(true);
});

test('failed graceful cleanup still invokes exact termination and remains failed on later disposal', async () => {
  const f = fixture(); await f.runtime.open(identity, {});
  f.computer.dispose.mockResolvedValue([{ status: 'rejected' }]);
  await expect(f.runtime.releaseClaim(identity)).rejects.toMatchObject({ code: 'computer_cleanup_unconfirmed' });
  expect(f.lease.close).toHaveBeenCalledTimes(1);
  const stop = f.runtime.dispose(); expect((await stop).some(result => result.status === 'rejected')).toBe(true);
  expect(f.runtime.dispose()).toBe(stop); expect(f.lease.close).toHaveBeenCalledTimes(1);
});

test.each(['rejected_reply', 'thrown_reply'])('independently confirmed closure releases capacity after %s without replay', async mode => {
  const f = fixture(); await f.runtime.open(identity, {});
  if (mode === 'rejected_reply') f.computer.dispose.mockResolvedValue([{ status: 'rejected' }]);
  else f.computer.dispose.mockRejectedValue(new Error('Browser reply lost'));
  f.lease.confirmClosed = jest.fn(async () => true);
  await expect(f.runtime.releaseClaim(identity)).resolves.toBeUndefined();
  expect(f.lease.close).toHaveBeenCalledTimes(1); expect(f.lease.confirmClosed).toHaveBeenCalledTimes(1);
  await f.runtime.releaseClaim(identity);
  expect(f.lease.close).toHaveBeenCalledTimes(1); expect(f.computer.open).toHaveBeenCalledTimes(1);
  const next = { ...identity, claim: { ...identity.claim, taskId: 'next', claimId: 'next-claim' } };
  f.computer.dispose.mockResolvedValue([]);
  await f.runtime.open(next, {}); expect(f.createLease).toHaveBeenCalledTimes(2);
  await f.runtime.dispose();
});

test.each(['false', 'unavailable', 'supervisor_failed'])('uncertain closure %s never releases the entry', async mode => {
  const f = fixture(); await f.runtime.open(identity, {});
  f.computer.dispose.mockRejectedValue(new Error('Lost reply'));
  f.lease.confirmClosed = jest.fn(async () => mode !== 'false');
  if (mode === 'unavailable') f.lease.confirmClosed.mockRejectedValue(new Error('Database unavailable'));
  if (mode === 'supervisor_failed') f.lease.close.mockRejectedValue(new Error('Stop unconfirmed'));
  await expect(f.runtime.releaseClaim(identity)).rejects.toMatchObject({ code: 'computer_cleanup_unconfirmed' });
  await expect(f.runtime.open({ ...identity, claim: { ...identity.claim, taskId: 'next' } }, {})).rejects.toMatchObject({ code: 'computer_claim_denied' });
  if (mode === 'supervisor_failed') expect(f.lease.confirmClosed).not.toHaveBeenCalled();
  expect(f.createLease).toHaveBeenCalledTimes(1);
  await f.runtime.dispose();
});

test('denied authority allocates no resources and does not leave an unknown cleanup debt', async () => {
  const f = fixture(); f.authorize.mockResolvedValue(false);
  const error = await f.runtime.open(identity, { url: 'https://denied.invalid/' }).catch(error => error);
  expect(error.code).toBe('computer_policy_denied');
  expect(f.runtime.isPreDispatchFailure(error)).toBe(true);
  expect(f.runtime.isPreDispatchFailure(Object.assign(new Error('forged'), { code: error.code }))).toBe(false);
  expect(f.createLease).not.toHaveBeenCalled();
  await expect(f.runtime.releaseClaim(identity)).resolves.toBeUndefined();
  f.authorize.mockResolvedValue({ allowed: true });
  await f.runtime.open(identity, { url: 'https://fixture/' });
  expect(f.createLease).toHaveBeenCalledTimes(1);
  await f.runtime.dispose();
});

test('shutdown while authorization is pending cannot allocate a late browser', async () => {
  const f = fixture(); let permit;
  f.authorize.mockImplementation(() => new Promise(resolve => { permit = resolve; }));
  const opening = f.runtime.open(identity, {}).catch(error => error); await tick();
  const stop = f.runtime.dispose(); permit(true);
  expect((await opening).code).toBe('computer_disposed');
  expect((await stop).every(result => result.status === 'fulfilled')).toBe(true);
  expect(f.createLease).not.toHaveBeenCalled();
});

test('pending acquisition counts toward capacity and cannot borrow another owners claim', async () => {
  let finish;
  const f = fixture();
  const createLease = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  const runtime = createSupervisedComputerRuntime({ createLease, authorize: f.authorize, maxComputers: 1 });
  const first = runtime.open(identity, {}); await tick();
  await expect(runtime.open({ ...identity, ownerId: 'different-owner' }, {})).rejects.toMatchObject({ code: 'computer_capacity' });
  expect(createLease).toHaveBeenCalledTimes(1);
  finish(f.lease); await first;
  expect(await createLease.mock.calls[0][0].authorize({ identity: { ...identity, ownerId: 'different-owner' } })).toBe(false);
  await runtime.dispose();
});
