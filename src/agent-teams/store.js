'use strict';

const { fail } = require('./domain');

// One row lock is the admission boundary for a team's mutations and task
// claims. It works across replicas; an in-process mutex would not.
class TeamStore {
  constructor({ database, schemaMode = 'create' } = {}) {
    // Explicit database injection must not initialize unrelated production
    // configuration/connections (including isolated PostgreSQL verification).
    this.database = database === undefined ? require('../postgres').postgres : database;
    if (!['create', 'existing'].includes(schemaMode)) throw new Error('Invalid team schema mode.');
    this.schemaMode = schemaMode;
    this.ready = null;
  }

  async initialize() {
    if (!this.ready) {
      this.ready = this.database.query(this.schemaMode === 'existing'
        ? 'SELECT id, owner_id, state, updated_at FROM lilly_agent_teams LIMIT 0'
        : `
        CREATE TABLE IF NOT EXISTS lilly_agent_teams (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          state JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `).catch((error) => { this.ready = null; throw error; });
    }
    await this.ready;
  }

  serialize(team) {
    const data = JSON.stringify(team);
    if (Buffer.byteLength(data) > 4 * 1024 * 1024) fail('Team storage budget reached.', 'team_storage_limit', 409);
    return data;
  }

  async create(team) {
    await this.initialize();
    await this.database.query('INSERT INTO lilly_agent_teams (id, owner_id, state) VALUES ($1, $2, $3::jsonb)',
      [team.id, team.ownerId, this.serialize(team)]);
    return team;
  }

  async createOnce(team) {
    await this.initialize();
    // A deterministic owner/key ID plus the PK is the cross-replica admission
    // boundary. Never upsert: retries must not reset a team's accumulated work.
    const result = await this.database.query(`INSERT INTO lilly_agent_teams (id, owner_id, state)
      VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING RETURNING state`,
    [team.id, team.ownerId, this.serialize(team)]);
    return result.rows[0]?.state || this.get(team.id, team.ownerId);
  }

  async list(ownerId) {
    await this.initialize();
    const result = await this.database.query(
      `SELECT id, state->>'name' AS name, state->>'objective' AS objective, updated_at
       FROM lilly_agent_teams WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT 100`, [ownerId]);
    return result.rows;
  }

  async get(id, ownerId) {
    await this.initialize();
    const result = await this.database.query('SELECT state FROM lilly_agent_teams WHERE id = $1 AND owner_id = $2', [id, ownerId]);
    return result.rows[0]?.state || fail('Team not found.', 'team_not_found', 404);
  }

  async listRunnable() {
    await this.initialize();
    const result = await this.database.query(`SELECT id, owner_id AS "ownerId"
      FROM lilly_agent_teams WHERE state->'execution'->>'enabled' = 'true'
      ORDER BY updated_at ASC LIMIT 100`);
    return result.rows;
  }

  // Recovery inventory is independent of execution opt-in: disabling a team
  // must not hide its old running/reconciling work. Internal identifiers only;
  // this is discovery, never authority to reclaim a claim or release capacity.
  async listUnsettled({ afterId = null } = {}) {
    if (afterId !== null && (typeof afterId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(afterId))) fail('Invalid recovery inventory cursor.');
    await this.initialize();
    const result = await this.database.query(`SELECT id, owner_id AS "ownerId"
      FROM lilly_agent_teams WHERE ($1::text IS NULL OR id COLLATE "C" > $1::text COLLATE "C") AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(state->'tasks') = 'array'
          THEN state->'tasks' ELSE '[]'::jsonb END) AS task
        WHERE task->>'status' IN ('running', 'reconciling')
      ) ORDER BY id COLLATE "C" ASC LIMIT 100`, [afterId]);
    return result.rows;
  }

  async mutate(id, ownerId, apply, { databaseTime = false } = {}) {
    await this.initialize();
    const pool = this.database.getPool();
    if (!pool) fail('Team persistence unavailable.', 'team_unavailable', 503);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT state FROM lilly_agent_teams WHERE id = $1 AND owner_id = $2 FOR UPDATE', [id, ownerId]);
      const team = result.rows[0]?.state || fail('Team not found.', 'team_not_found', 404);
      let context;
      if (databaseTime) {
        // Observe time AFTER acquiring the row lock, not before a lock wait.
        const clock = await client.query('SELECT clock_timestamp() AS now');
        const date = new Date(clock.rows[0]?.now);
        if (!clock.rows[0]?.now || !Number.isFinite(date.getTime())) fail('Database clock unavailable.', 'team_unavailable', 503);
        context = { now: date.toISOString() };
      }
      const output = apply(team, context);
      if (output && typeof output.then === 'function') fail('Team mutations must not perform asynchronous side effects.');
      await client.query('UPDATE lilly_agent_teams SET state = $3::jsonb, updated_at = NOW() WHERE id = $1 AND owner_id = $2',
        [id, ownerId, this.serialize(team)]);
      await client.query('COMMIT');
      return output;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* Retain original failure. */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { TeamStore };
