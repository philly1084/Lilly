'use strict';

// Explicit in-memory transaction fixture. Production uses TeamStore/Postgres.
class TestStore {
  constructor({ now = () => new Date().toISOString() } = {}) { this.rows = new Map(); this.tail = Promise.resolve(); this.now = now; }
  async create(team) { this.rows.set(team.id, structuredClone(team)); return team; }
  async createOnce(team) {
    if (!this.rows.has(team.id)) this.rows.set(team.id, structuredClone(team));
    return this.get(team.id, team.ownerId);
  }
  async get(id, owner) {
    const team = this.rows.get(id);
    if (!team || team.ownerId !== owner) throw Object.assign(new Error('Team not found'), { code: 'team_not_found', statusCode: 404 });
    // Match JSONB deserialization in this realm. Node's structuredClone can
    // return host-realm prototypes under Jest, unlike the production pg parser.
    return JSON.parse(JSON.stringify(team));
  }
  async listRunnable() {
    return [...this.rows.values()].filter((team) => team.execution?.enabled).map(({ id, ownerId }) => ({ id, ownerId }));
  }
  async listUnsettled({ afterId = null } = {}) {
    return [...this.rows.values()].filter(team => Array.isArray(team.tasks)
      && (afterId === null || team.id > afterId)
      && team.tasks.some(task => ['running', 'reconciling'].includes(task?.status)))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .slice(0, 100).map(({ id, ownerId }) => ({ id, ownerId }));
  }
  async mutate(id, owner, fn, { databaseTime = false } = {}) {
    const work = this.tail.then(async () => {
      const team = await this.get(id, owner);
      const result = fn(team, databaseTime ? { now: this.now() } : undefined);
      this.rows.set(id, structuredClone(team));
      return structuredClone(result);
    });
    this.tail = work.catch(() => {});
    return work;
  }
}

module.exports = { TestStore };
