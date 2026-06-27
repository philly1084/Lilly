const fs = require('fs/promises');
const os = require('os');
const path = require('path');

describe('TracesController persistence', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  test('does not seed demo traces by default and reloads persisted traces', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-traces-'));
    process.env = {
      ...originalEnv,
      KIMIBUILT_STATE_DIR: stateDir,
    };

    try {
      const initialModule = require('./traces.controller');
      const { TracesController, getTracesStoragePath } = initialModule;
      const controller = new TracesController({ storagePath: getTracesStoragePath() });
      expect(controller.traces.size).toBe(0);

      controller.addTrace({
        id: 'trace-runtime-1',
        taskId: 'task-1',
        sessionId: 'session-1',
        status: 'completed',
        startTime: '2026-05-03T00:00:00.000Z',
        endTime: '2026-05-03T00:00:01.000Z',
        duration: 1000,
        model: 'gpt-test',
        input: 'hello',
        output: 'world',
        timeline: [],
        metrics: {},
        createdAt: '2026-05-03T00:00:00.000Z',
      });

      const reloaded = new TracesController({ storagePath: getTracesStoragePath() });
      expect(reloaded.traces.get('trace-runtime-1')).toEqual(expect.objectContaining({
        taskId: 'task-1',
        status: 'completed',
      }));
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  test('includes agent company workload runs in admin traces', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-company-traces-'));
    const { TracesController } = require('./traces.controller');
    const controller = new TracesController({ storagePath: path.join(stateDir, 'traces.jsonl') });
    const res = {
      json: jest.fn(),
      status: jest.fn(() => res),
    };
    const req = {
      query: { page: '1', limit: '20' },
      app: {
        locals: {
          agentCompanyService: {
            getStatus: jest.fn(async () => ({
              config: { sessionId: 'agent-company' },
            })),
          },
          agentWorkloadService: {
            isAvailable: jest.fn(() => true),
            listAdminWorkloads: jest.fn(async () => [{
              id: 'company-workload',
              sessionId: 'agent-company',
              title: 'Strategy Lead: Weekly market review',
              prompt: 'Inspect company work and ship the next proof.',
              metadata: {
                requestedModel: 'gpt-test',
                agentCompany: {
                  roleName: 'Strategy Lead',
                  planItemId: 'weekly-market-review',
                },
              },
            }]),
            listAdminRuns: jest.fn(async () => [{
              id: 'company-run',
              workloadId: 'company-workload',
              sessionId: 'agent-company',
              status: 'completed',
              reason: 'heartbeat',
              prompt: 'Inspect company work and ship the next proof.',
              startedAt: '2026-06-27T10:00:00.000Z',
              finishedAt: '2026-06-27T10:00:02.000Z',
              trace: {
                executionTrace: [{
                  type: 'tool_call',
                  name: 'Tool call (repo-check)',
                  status: 'completed',
                  start_time: '2026-06-27T10:00:00.500Z',
                  end_time: '2026-06-27T10:00:01.000Z',
                  details: { reason: 'Collect company evidence' },
                }],
              },
              metadata: {
                output: {
                  text: 'Company proof shipped.',
                  artifacts: [{ id: 'artifact-1', filename: 'brief.md' }],
                },
              },
              createdAt: '2026-06-27T09:59:00.000Z',
              updatedAt: '2026-06-27T10:00:02.000Z',
            }]),
          },
        },
      },
    };

    try {
      await controller.getAll(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: expect.arrayContaining([
          expect.objectContaining({
            id: 'trace-workload-run-company-run',
            source: 'agent-company-workload',
            status: 'completed',
            name: 'Strategy Lead: Weekly market review',
            workloadId: 'company-workload',
            runId: 'company-run',
            timeline: expect.arrayContaining([
              expect.objectContaining({
                name: 'Tool call (repo-check)',
                type: 'tool_call',
              }),
            ]),
            metadata: expect.objectContaining({
              agentCompany: expect.objectContaining({
                roleName: 'Strategy Lead',
              }),
              output: expect.objectContaining({
                text: 'Company proof shipped.',
              }),
            }),
          }),
        ]),
      }));
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
