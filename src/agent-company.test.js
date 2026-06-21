'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { AgentCompanyService, normalizeConfig } = require('./agent-company');

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
                getEffectiveAgentCompanyConfig: () => buildConfig(),
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
        expect(createdWorkloads[0].metadata.requestedModel).toBe('gpt-5.5');
        expect(createdWorkloads[0].metadata.agentCompany.heartbeatManaged).toBe(true);
    });
});
