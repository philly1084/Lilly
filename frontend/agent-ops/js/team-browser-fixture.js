'use strict';

// Local browser QA only: real team commands and presentation with explicit
// in-memory storage, no scheduler, model client, credentials, or worker runtime.
const express = require('express');
const path = require('path');
const { TeamService } = require('../../../src/agent-teams/service');
const { TestStore } = require('../../../src/agent-teams/test-store');
const { createTeamRouter } = require('../../../src/routes/agent-teams');

async function start() {
  const store = new TestStore();
  store.list = async (ownerId) => [...store.rows.values()].filter((team) => team.ownerId === ownerId)
    .map(({ id, name, objective }) => ({ id, name, objective }));
  const service = new TeamService({ store });
  const ownerId = 'local-browser-fixture';
  const team = await service.create(ownerId, { name: 'Lilly release crew', objective: 'Local UI integration fixture · tasks and messages are saved in memory; no live workers or models run.' });
  const people = [
    { name: 'Lilly', role: 'coordinator', job: 'Keep the outcome and crew aligned', persona: 'Clear, thoughtful, and practical. Ask focused questions when evidence is missing.' },
    { name: 'Mira', role: 'specialist', job: 'Build the verified release report', persona: 'Make the work inspectable. Share concrete results and preserve existing files.' },
    { name: 'Rex', role: 'reviewer', job: 'Read the saved output and verify acceptance checks', persona: 'Friendly but skeptical. Approval follows evidence, not confident summaries.' },
  ];
  let index = 0;
  for (const person of people) {
    const agent = await service.ownerCommand(team.id, ownerId, 'create_agent', person, `fixture-agent-${++index}`);
    await service.ownerCommand(team.id, ownerId, 'assign_task', { agentId: agent.id, title: person.job, instruction: 'UI fixture only. No execution is enabled.' }, `fixture-task-${index}`);
    if (person.role === 'coordinator') await service.ownerCommand(team.id, ownerId, 'remember', { agentId: agent.id, scope: 'team', content: 'A task is complete only after saved output is reviewed. Keep browser screens private.', source: 'Local fixture acceptance brief' }, 'fixture-note');
  }
  const firstAgent = (await service.get(team.id, ownerId)).agents[0];
  if (process.env.TEAM_UI_COMPUTER_FIXTURE === 'true') {
    // Authored display history only: no browser or worker is started.
    await store.mutate(team.id, ownerId, data => {
      for (const [index, [tool, type]] of [['computer_open', 'tool_started'], ['computer_open', 'tool_finished'],
        ['computer_act', 'tool_failed'], ['computer_observe', 'tool_finished']].entries()) {
        data.events.push({ id: `computer-display-${index}`, agentId: firstAgent.id, tool, type,
          at: new Date(Date.now() - (4 - index) * 1000).toISOString() });
      }
    });
  }
  await service.ownerCommand(team.id, ownerId, 'remember', { agentId: firstAgent.id, scope: 'private', content: 'Fixture-only owner note: prefer concise evidence-backed reports.', source: 'Local UI fixture; no user secrets' }, 'fixture-private-note');
  const skill = await service.ownerCommand(team.id, ownerId, 'save_skill', { name: 'Evidence review', instructions: 'Read each saved output. Compare the result against the requested outcome and report discrepancies.', acceptance: 'Recorded artifacts are inspected; unresolved checks are stated.' }, 'fixture-skill');
  await service.ownerCommand(team.id, ownerId, 'approve_skill', { skillId: skill.id }, 'fixture-skill-approve');
  await service.ownerCommand(team.id, ownerId, 'save_skill', { name: 'Release brief', instructions: 'Summarize verified changes and remaining blockers in a short report.', acceptance: 'Every completion claim links to evidence.' }, 'fixture-skill-draft');
  await service.ownerCommand(team.id, ownerId, 'create_routine', { agentId: firstAgent.id, skillId: skill.id, title: 'Daily evidence check', instruction: 'Check the saved release evidence. This fixture never executes.', intervalSeconds: 86400 }, 'fixture-routine');
  const activityClaims = [];
  if (process.env.TEAM_UI_ACTIVITY_FIXTURE === 'true') {
    // Explicit synthetic activity states. No executor, broker, browser runtime
    // or model is attached; the runtime endpoint still says unavailable.
    await service.ownerCommand(team.id, ownerId, 'configure_execution', { enabled: true }, 'fixture-display-enabled');
    const claimed = await service.claimEnabled(team.id, ownerId, 'fixture-only-no-worker', 3);
    for (const [index, task] of claimed.entries()) {
      const claim = { taskId: task.id, workerId: 'fixture-only-no-worker', claimId: task.worker.claimId };
      await service.heartbeat(team.id, ownerId, claim, { type: 'tool_started',
        tool: index === 0 ? 'team_wait' : 'artifact_write', callId: `fixture-call-${index}` });
      if (index < 2) activityClaims.push(claim);
      else await store.mutate(team.id, ownerId, data => { data.tasks.find(entry => entry.id === task.id).worker.heartbeatAt = '2000-01-01T00:00:00.000Z'; });
    }
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: ownerId, role: 'admin' }; next(); });
  app.locals.agentTeamRuntime = { service, status: () => ({ enabled: false, visionEnabled: false, runtime: 'local-ui-fixture' }) };
  app.use('/api/agent-teams/:teamId/workroom', async (req, _res, next) => {
    try {
      if (req.params.teamId === team.id) for (const claim of activityClaims) await service.heartbeat(team.id, ownerId, claim);
      next();
    } catch (error) { next(error); }
  });
  app.use('/api/agent-teams', createTeamRouter({ service }));
  if (process.env.TEAM_UI_ARTIFACT_FIXTURE === 'true') {
    // Display-only records for deliberately slow file-detail QA. These are not
    // durable outputs or completed work and no artifact write/worker is invoked.
    const files = [{ id: 'fixture-fast-file', filename: 'quick-fixture.md', delay: 0 },
      { id: 'fixture-slow-file', filename: 'slow-fixture.md', delay: 8000 }];
    await store.mutate(team.id, ownerId, data => {
      data.tasks[0].result = { summary: 'Authored file-display fixture only.',
        artifacts: files.map(file => ({ id: file.id, sha256: 'a'.repeat(64) })) };
    });
    app.get('/api/artifacts/:id', (req, res) => {
      const file = files.find(item => item.id === req.params.id);
      if (!file) return res.sendStatus(404);
      const timer = setTimeout(() => res.json({ id: file.id, filename: file.filename,
        sha256: 'a'.repeat(64), mimeType: 'text/markdown' }), file.delay);
      res.once('close', () => clearTimeout(timer));
    });
  }
  app.get('/api/admin/agent-ops/overview', (_req, res) => res.json({ project: { id: 'legacy-fixture', name: 'Existing company project', goal: 'Legacy project remains unchanged' }, projects: [{ id: 'legacy-fixture', name: 'Existing company project', active: true }], groups: {}, capabilities: { projects: true } }));
  app.use('/agent-ops', express.static(path.join(__dirname, '..')));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: { message: error.message } }));
  const server = app.listen(Number(process.env.TEAM_UI_FIXTURE_PORT || 3196), '127.0.0.1', () => {
    console.log(`Local UI fixture: http://127.0.0.1:${server.address().port}/agent-ops/?team=${team.id}`);
  });
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
}

start().catch((error) => { console.error(error.message); process.exitCode = 1; });
