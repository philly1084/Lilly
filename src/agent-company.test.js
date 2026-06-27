'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { AgentCompanyService, hashGoal, normalizeConfig } = require('./agent-company');

function buildConfig(overrides = {}) {
    return {
        enabled: true,
        companyGoal: 'Run a podcast company that ships episodes and keeps the website current.',
        heartbeatMinutes: 60,
        scheduleHorizonDays: 7,
        weeklyWorkloadLimit: 3,
        maxConcurrentWorkloads: 1,
        ownerId: 'system',
        sessionId: 'agent-company',
        primaryModel: 'gpt-5.5',
        escalationModels: ['gpt-5.5', 'codex-latest'],
        roles: [
            { id: 'strategy', name: 'Strategy Lead', mission: 'Plan the company week.' },
            { id: 'production', name: 'Production Lead', mission: 'Create the core deliverable.' },
            { id: 'operations', name: 'Operations Lead', mission: 'Verify and update the schedule.' },
        ],
        ...overrides,
    };
}

describe('AgentCompanyService', () => {
    let tempDir;
    let statePath;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-agent-company-'));
        statePath = path.join(tempDir, 'state.json');
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('normalizes heartbeat and company limits to conservative bounds', () => {
        const config = normalizeConfig({
            enabled: true,
            companyGoal: 'Build the show.',
            heartbeatMinutes: 1,
            weeklyWorkloadLimit: 50,
            maxConcurrentWorkloads: 20,
        });

        expect(config.heartbeatMinutes).toBe(15);
        expect(config.weeklyWorkloadLimit).toBe(12);
        expect(config.maxConcurrentWorkloads).toBe(4);
    });

    test('records standby state when persistence-backed workloads are unavailable', async () => {
        const service = new AgentCompanyService({
            statePath,
            now: () => new Date('2026-06-22T12:00:00.000Z'),
            settingsController: {
                getEffectiveAgentCompanyConfig: () => buildConfig(),
            },
            workloadService: {
                isAvailable: () => false,
            },
            sessionStore: {},
        });

        const result = await service.tick({ force: true, reason: 'test' });

        expect(result.available).toBe(false);
        expect(result.state.heartbeat.status).toBe('standby');
        expect(result.state.shortTermSchedule).toHaveLength(3);
        expect(JSON.parse(await fs.readFile(statePath, 'utf8')).heartbeat.status).toBe('standby');
    });

    test('runs daily alignment from heartbeat state even when company scheduling is disabled', async () => {
        const applySelfReflectionUpdate = jest.fn(() => ({
            id: 'self-reflection-daily',
            applied: true,
            actions: [{ type: 'model_card_note', status: 'recorded' }],
        }));
        const service = new AgentCompanyService({
            statePath,
            now: () => new Date('2026-06-22T12:00:00.000Z'),
            settingsController: {
                getEffectiveAgentCompanyConfig: () => buildConfig({
                    enabled: false,
                    companyGoal: '',
                    dailyAlignment: {
                        enabled: true,
                        autoApply: true,
                    },
                }),
            },
            workloadService: {
                isAvailable: () => false,
            },
            sessionStore: {},
            logsController: {
                logs: [{
                    timestamp: '2026-06-22T11:00:00.000Z',
                    level: 'error',
                    status: 'failed',
                    error: 'planner skipped browser proof',
                }],
            },
            collectAlignmentSuggestions: jest.fn(async () => ({
                suggestions: [{
                    id: 'daily-proof-note',
                    canApply: true,
                    applied: false,
                    rating: 'down',
                    input: {
                        source: 'alignment-evaluator',
                        trigger: 'model-card finding from alignment feedback',
                        actions: [{
                            type: 'model_card_note',
                            content: 'Durable lesson: run the required proof path before finalizing.',
                            reason: 'durable future routing guidance',
                        }],
                    },
                }],
                meta: { count: 1 },
            })),
            applySelfReflectionUpdate,
        });

        const result = await service.tick({ force: true, reason: 'test-daily-alignment' });

        expect(result.state.heartbeat.status).toBe('disabled');
        expect(result.state.dailyAlignment.status).toBe('applied');
        expect(result.state.dailyAlignment.evidence.logs.count).toBe(1);
        expect(result.state.dailyAlignment.applied).toEqual([expect.objectContaining({
            id: 'daily-proof-note',
            resultId: 'self-reflection-daily',
        })]);
        expect(applySelfReflectionUpdate).toHaveBeenCalledTimes(1);
    });

    test('creates one weekly set of long-agent workloads and skips duplicates on the next heartbeat', async () => {
        const createdWorkloads = [];
        const workloadService = {
            isAvailable: () => true,
            listAdminWorkloads: jest.fn(async () => createdWorkloads),
            createWorkload: jest.fn(async (payload, ownerId) => {
                const workload = {
                    id: `workload-${createdWorkloads.length + 1}`,
                    ownerId,
                    sessionId: payload.sessionId,
                    title: payload.title,
                    prompt: payload.prompt,
                    trigger: payload.trigger,
                    metadata: payload.metadata,
                    workloadSummary: {
                        queued: 1,
                        running: 0,
                        failed: 0,
                    },
                };
                createdWorkloads.push(workload);
                return workload;
            }),
        };
        const service = new AgentCompanyService({
            statePath,
            now: () => new Date('2026-06-22T12:00:00.000Z'),
            settingsController: {
                getEffectiveAgentCompanyConfig: () => buildConfig({
                    maxConcurrentWorkloads: 4,
                }),
            },
            workloadService,
            sessionStore: {
                getOrCreateOwned: jest.fn(async () => ({ id: 'agent-company' })),
            },
        });

        const first = await service.tick({ force: true, reason: 'test' });
        const second = await service.tick({ force: true, reason: 'test' });

        expect(first.createdWorkloads).toHaveLength(3);
        expect(second.createdWorkloads).toHaveLength(0);
        expect(workloadService.createWorkload).toHaveBeenCalledTimes(3);
        expect(createdWorkloads[0].metadata.longAgent.enabled).toBe(true);
        expect(createdWorkloads[0].metadata.longAgent.sharedWhiteboardFile).toBe('.kimibuilt/agent-company/2026-06-22-whiteboard.md');
        expect(createdWorkloads[0].metadata.requestedModel).toBe('gpt-5.5');
        expect(createdWorkloads[0].metadata.agentCompany.heartbeatManaged).toBe(true);
        expect(createdWorkloads[0].metadata.agentCompany.sharedWhiteboard).toEqual(expect.objectContaining({
            path: '.kimibuilt/agent-company/2026-06-22-whiteboard.md',
            purpose: 'agent-to-agent weekly coordination',
            sections: expect.arrayContaining([
                'Claims checked',
                'Files/artifacts changed',
                'Deployment/DNS state',
                'Next agent task',
            ]),
        }));
        expect(createdWorkloads[0].metadata.agentCompany.outputContract).toEqual(expect.objectContaining({
            communication: 'scratch-markdown',
            rejectPlanningOnlyHtml: true,
            productionWebHostRoot: 'demoserver2.buzz',
        }));
        expect(createdWorkloads.map((workload) => workload.title)).toContain('Operations Lead: Recursive improvement review');
        expect(createdWorkloads.find((workload) => workload.title.includes('Recursive improvement review')).prompt)
            .toContain('sense, plan, act, verify, learn');
        expect(createdWorkloads[0].prompt).toContain('Separate communication from deliverables');
        expect(createdWorkloads[0].prompt).toContain('Do not count an HTML file as a deliverable if it is only a plan');
        expect(createdWorkloads[0].prompt).toContain('Use managed-app create/iterate/reconcile/doctor');
        expect(createdWorkloads[0].prompt).toContain('Use a stable concrete hostname under demoserver2.buzz');
        expect(createdWorkloads[0].prompt).toContain('Shared whiteboard:');
        expect(createdWorkloads[0].prompt).toContain('.kimibuilt/agent-company/2026-06-22-whiteboard.md');
        expect(createdWorkloads[0].prompt).toContain('Claims checked, Decisions made, Files/artifacts changed, Deployment/DNS state, Blockers, Next agent task');
    });

    test('expands schedule across configured roles and templates', () => {
        const service = new AgentCompanyService({
            statePath,
            now: () => new Date('2026-06-22T12:00:00.000Z'),
        });
        const schedule = service.buildWeeklySchedule(buildConfig({
            weeklyWorkloadLimit: 6,
            roles: [
                { id: 'strategy', name: 'Strategy Lead', mission: 'Plan the company week.' },
                { id: 'production', name: 'Production Lead', mission: 'Create the core deliverable.' },
                { id: 'operations', name: 'Operations Lead', mission: 'Verify and update the schedule.' },
                { id: 'growth', name: 'Growth Lead', mission: 'Find audience growth opportunities.' },
            ],
        }));

        expect(schedule).toHaveLength(6);
        expect(new Set(schedule.map((item) => item.id)).size).toBe(6);
        expect(schedule.map((item) => item.roleId)).toContain('growth');
        expect(new Set(schedule.map((item) => item.title)).size).toBeGreaterThan(1);
        expect(schedule.map((item) => item.title)).toContain('Recursive improvement review');
    });

    test('respects queued workload capacity before scheduling more work', async () => {
        const now = new Date('2026-06-22T12:00:00.000Z');
        const config = buildConfig({
            maxConcurrentWorkloads: 2,
        });
        const goalHash = hashGoal(config.companyGoal);
        const weekKey = '2026-06-22';
        const service = new AgentCompanyService({
            statePath,
            now: () => now,
            settingsController: {
                getEffectiveAgentCompanyConfig: () => config,
            },
            workloadService: {
                isAvailable: () => true,
                listAdminWorkloads: jest.fn(async () => [{
                    id: 'existing-workload',
                    metadata: {
                        agentCompany: {
                            enabled: true,
                            companyGoalHash: goalHash,
                            weekKey,
                            planItemId: service.buildWeeklySchedule(config, now, goalHash)[0].id,
                        },
                    },
                    workloadSummary: {
                        queued: 1,
                        running: 0,
                        failed: 0,
                    },
                }]),
                createWorkload: jest.fn(async (payload, ownerId) => ({
                    id: 'new-workload',
                    ownerId,
                    title: payload.title,
                    trigger: payload.trigger,
                    metadata: payload.metadata,
                })),
            },
            sessionStore: {
                getOrCreateOwned: jest.fn(async () => ({ id: 'agent-company' })),
            },
        });

        const result = await service.tick({ force: true, reason: 'capacity-test' });

        expect(result.createdWorkloads).toHaveLength(1);
        expect(result.state.heartbeat.status).toBe('scheduled');
        expect(result.state.runningWork.queued).toBe(1);
        expect(service.workloadService.createWorkload).toHaveBeenCalledTimes(1);
    });

    test('records failed scheduled items and continues with the next open slot', async () => {
        const createWorkload = jest.fn()
            .mockRejectedValueOnce(new Error('scheduler rejected invalid trigger'))
            .mockImplementationOnce(async (payload, ownerId) => ({
                id: 'workload-after-failure',
                ownerId,
                title: payload.title,
                trigger: payload.trigger,
                metadata: payload.metadata,
            }));
        const service = new AgentCompanyService({
            statePath,
            now: () => new Date('2026-06-22T12:00:00.000Z'),
            settingsController: {
                getEffectiveAgentCompanyConfig: () => buildConfig({
                    maxConcurrentWorkloads: 2,
                }),
            },
            workloadService: {
                isAvailable: () => true,
                listAdminWorkloads: jest.fn(async () => []),
                createWorkload,
            },
            sessionStore: {
                getOrCreateOwned: jest.fn(async () => ({ id: 'agent-company' })),
            },
        });

        const result = await service.tick({ force: true, reason: 'partial-failure-test' });

        expect(createWorkload).toHaveBeenCalledTimes(2);
        expect(result.createdWorkloads).toHaveLength(1);
        expect(result.state.heartbeat.status).toBe('scheduled_with_errors');
        expect(result.state.heartbeat.failedWorkloads).toBe(1);
        expect(result.state.heartbeat.createFailures).toEqual([expect.objectContaining({
            message: 'scheduler rejected invalid trigger',
        })]);
        expect(JSON.parse(await fs.readFile(statePath, 'utf8')).heartbeat.createFailures).toHaveLength(1);
    });
});
