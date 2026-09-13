'use strict';

const express = require('express');
const request = require('supertest');
const { createTeamRouter } = require('./agent-teams');

function app(service, user = { username: 'phil' }) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, res, next) => { req.user = user; next(); });
  instance.use('/teams', createTeamRouter({ service }));
  return instance;
}

test('requires authentication before invoking team services', async () => {
  const service = { list: jest.fn() };
  expect((await request(app(service, null)).get('/teams')).status).toBe(401);
  expect(service.list).not.toHaveBeenCalled();
});

test('commands bind owner to session and ignore sender impersonation fields', async () => {
  const service = { ownerCommand: jest.fn().mockResolvedValue({ id: 'message' }) };
  const response = await request(app(service)).post('/teams/team-1/commands').set('Idempotency-Key', 'once').send({
    ownerId: 'someone-else', agentId: 'fake', action: 'send_message', input: { kind: 'note', body: 'Hello' },
  });
  expect(response.status).toBe(200);
  expect(service.ownerCommand).toHaveBeenCalledWith('team-1', 'phil', 'send_message', { kind: 'note', body: 'Hello' }, 'once');
});

test('creation forwards retry identity with authenticated owner, not a body-selected identity', async () => {
  const service = { create: jest.fn().mockResolvedValue({ id: 'team' }) };
  const input = { name: 'Team', objective: 'Build.', ownerId: 'someone-else' };
  expect((await request(app(service)).post('/teams').set('Idempotency-Key', 'create-once').send(input)).status).toBe(201);
  expect(service.create).toHaveBeenCalledWith('phil', input, 'create-once');
});

test('foreign team is a scoped 404', async () => {
  const service = { get: jest.fn().mockRejectedValue(Object.assign(new Error('Team not found.'), { code: 'team_not_found', statusCode: 404 })) };
  expect((await request(app(service)).get('/teams/foreign')).status).toBe(404);
  expect(service.get).toHaveBeenCalledWith('foreign', 'phil');
});

test('workroom is owner-scoped, noncached and does not expose raw team state', async () => {
  const service = { get: jest.fn().mockResolvedValue({ id: 'team-1', name: 'Team', receipts: ['PRIVATE'], agents: [], tasks: [] }) };
  const response = await request(app(service)).get('/teams/team-1/workroom');
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(service.get).toHaveBeenCalledWith('team-1', 'phil');
  expect(response.body.schemaVersion).toBe(1);
  expect(response.body.team.name).toBe('Team');
  expect(JSON.stringify(response.body)).not.toContain('PRIVATE');
  expect((await request(app(service, null)).get('/teams/team-1/workroom')).status).toBe(401);
  expect(service.get).toHaveBeenCalledTimes(1);
});

test('workroom cannot read a foreign team', async () => {
  const service = { get: jest.fn().mockRejectedValue(Object.assign(new Error('Team not found.'), { code: 'team_not_found', statusCode: 404 })) };
  expect((await request(app(service)).get('/teams/foreign/workroom')).status).toBe(404);
});

test('private memory management binds authenticated owner and excludes internal fields', async () => {
  const service = { get: jest.fn().mockResolvedValue({ memories: [
    { id: 'memory', agentId: 'agent', scope: 'private', content: 'Preference', source: 'Owner', internal: 'HIDDEN' },
  ], receipts: ['HIDDEN'] }) };
  const response = await request(app(service)).get('/teams/team-1/memories?ownerId=other');
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(service.get).toHaveBeenCalledWith('team-1', 'phil');
  expect(response.body).toEqual({ memories: [{ id: 'memory', agentId: 'agent', scope: 'private', content: 'Preference', source: 'Owner' }] });
  expect((await request(app(service, null)).get('/teams/team-1/memories')).status).toBe(401);
  expect(service.get).toHaveBeenCalledTimes(1);
});

test('private memories of a foreign team are not disclosed', async () => {
  const service = { get: jest.fn().mockRejectedValue(Object.assign(new Error('Team not found.'), { code: 'team_not_found', statusCode: 404 })) };
  expect((await request(app(service)).get('/teams/foreign/memories')).status).toBe(404);
  expect(service.get).toHaveBeenCalledWith('foreign', 'phil');
});
