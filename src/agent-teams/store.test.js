'use strict';

const { TeamStore } = require('./store');
const { TestStore } = require('./test-store');

test('existing schema mode validates columns without DDL and retries failed checks', async () => {
  const database = { query: jest.fn().mockRejectedValueOnce(new Error('missing schema')).mockResolvedValue({ rows: [] }) };
  const store = new TeamStore({ database, schemaMode: 'existing' });
  await expect(store.initialize()).rejects.toThrow('missing schema');
  await store.initialize(); await store.initialize();
  expect(database.query).toHaveBeenCalledTimes(2);
  expect(database.query.mock.calls.every(([sql]) => sql === 'SELECT id, owner_id, state, updated_at FROM lilly_agent_teams LIMIT 0')).toBe(true);
  expect(() => new TeamStore({ database, schemaMode: 'unknown' })).toThrow('Invalid team schema mode.');
});

test('keyed creation uses conflict-do-nothing and never overwrites a preexisting team', async () => {
  const saved = { id: 'team', ownerId: 'owner', tasks: [{ id: 'existing-work' }] };
  const database = { query: jest.fn()
    .mockResolvedValueOnce({ rows: [] }) // initialize
    .mockResolvedValueOnce({ rows: [] }) // duplicate insert
    .mockResolvedValueOnce({ rows: [{ state: saved }] }) };
  const result = await new TeamStore({ database }).createOnce({ id: 'team', ownerId: 'owner', tasks: [] });
  expect(result).toEqual(saved);
  expect(database.query.mock.calls[1][0]).toContain('ON CONFLICT (id) DO NOTHING RETURNING state');
  expect(database.query.mock.calls[1][0]).not.toContain('DO UPDATE');
  expect(database.query.mock.calls[2][1]).toEqual(['team', 'owner']);
});

test('new keyed creation returns the inserted persisted state without a second lookup', async () => {
  const team = { id: 'team', ownerId: 'owner' };
  const database = { query: jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ state: team }] }) };
  expect(await new TeamStore({ database }).createOnce(team)).toEqual(team);
  expect(database.query).toHaveBeenCalledTimes(2);
});

test('unsettled SQL inventories both execution states with bounded identity-only rows', async () => {
  const rows = [{ id: 'disabled-team', ownerId: 'owner' }];
  const database = { query: jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows }) };
  expect(await new TeamStore({ database }).listUnsettled()).toEqual(rows);
  const sql = database.query.mock.calls[1][0];
  expect(sql).toContain('SELECT id, owner_id AS "ownerId"');
  expect(sql).toContain("IN ('running', 'reconciling')");
  expect(sql).toContain('EXISTS');
  expect(sql).toContain('jsonb_array_elements');
  expect(sql).toContain('ORDER BY id COLLATE "C" ASC LIMIT 100');
  expect(sql).toContain('id COLLATE "C" > $1::text COLLATE "C"');
  expect(database.query.mock.calls[1][1]).toEqual([null]);
  expect(sql).not.toContain('enabled');
  expect(sql).not.toMatch(/SELECT\s+(\*|state)/i);
  expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
});

test('unsettled fixture includes disabled and reconciling teams, excludes finished/queued, and never leaks state', async () => {
  const store = new TestStore();
  for (const [id, enabled, statuses] of [
    ['enabled', true, ['running']], ['disabled', false, ['reconciling', 'running']],
    ['queued', true, ['queued']], ['finished', false, ['completed', 'failed', 'cancelled', 'needs_review']],
    ['missing', false, []],
  ]) await store.create({ id, ownerId: `owner-${id}`, execution: { enabled }, tasks: statuses.map(status => ({ status, secret: 'private' })), updatedAt: '2026-01-01T00:00:00Z' });
  const before = structuredClone([...store.rows]);
  expect(await store.listUnsettled()).toEqual([{ id: 'disabled', ownerId: 'owner-disabled' }, { id: 'enabled', ownerId: 'owner-enabled' }]);
  expect([...store.rows]).toEqual(before);
});

test('unsettled inventory paginates beyond its 100-row budget without mutable timestamp ordering', async () => {
  const store = new TestStore();
  for (let i = 104; i >= 0; i -= 1) await store.create({ id: `team-${String(i).padStart(3, '0')}`, ownerId: 'owner', execution: { enabled: false },
    tasks: [{ status: 'running' }], updatedAt: '2026-01-01T00:00:00Z' });
  const rows = await store.listUnsettled();
  expect(rows).toHaveLength(100);
  expect(rows[0].id).toBe('team-000'); expect(rows.at(-1).id).toBe('team-099');
  const rest = await store.listUnsettled({ afterId: rows.at(-1).id });
  expect(rest.map(row => row.id)).toEqual(['team-100', 'team-101', 'team-102', 'team-103', 'team-104']);
  expect(await store.listUnsettled({ afterId: 'team-104' })).toEqual([]);
});

test('recovery inventory binds and validates its cursor before issuing SQL', async () => {
  const database = { query: jest.fn(async () => ({ rows: [] })) };
  const store = new TeamStore({ database });
  await expect(store.listUnsettled({ afterId: "'; DROP TABLE lilly_agent_teams" })).rejects.toBeDefined();
  expect(database.query).not.toHaveBeenCalled();
  await store.listUnsettled({ afterId: 'team-099' });
  expect(database.query.mock.calls[1][1]).toEqual(['team-099']);
});

test('recovery clock is read from PostgreSQL after the row lock and before mutation', async () => {
  const client = { query: jest.fn(async sql => {
    if (sql.includes('FOR UPDATE')) return { rows: [{ state: { id: 'team', ownerId: 'owner' } }] };
    if (sql.includes('clock_timestamp')) return { rows: [{ now: new Date('2026-09-07T01:00:00Z') }] };
    return { rows: [] };
  }), release: jest.fn() };
  const database = { query: jest.fn(async () => ({ rows: [] })), getPool: () => ({ connect: async () => client }) };
  const result = await new TeamStore({ database }).mutate('team', 'owner', (team, clock) => {
    expect(client.query.mock.calls.at(-1)[0]).toBe('SELECT clock_timestamp() AS now');
    team.observedAt = clock.now; return clock.now;
  }, { databaseTime: true });
  expect(result).toBe('2026-09-07T01:00:00.000Z');
  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
    'BEGIN', expect.stringContaining('FOR UPDATE'), 'SELECT clock_timestamp() AS now', expect.stringContaining('UPDATE lilly_agent_teams'), 'COMMIT',
  ]);
  expect(client.release).toHaveBeenCalledTimes(1);
});

test('missing database clock rolls back without invoking recovery mutation', async () => {
  const client = { query: jest.fn(async sql => ({ rows: sql.includes('FOR UPDATE') ? [{ state: { id: 'team' } }] : [] })), release: jest.fn() };
  const database = { query: jest.fn(async () => ({ rows: [] })), getPool: () => ({ connect: async () => client }) };
  const apply = jest.fn();
  await expect(new TeamStore({ database }).mutate('team', 'owner', apply, { databaseTime: true })).rejects.toMatchObject({ code: 'team_unavailable' });
  expect(apply).not.toHaveBeenCalled();
  expect(client.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
});
