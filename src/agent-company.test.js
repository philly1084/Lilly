'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { AgentCompanyService, hashGoal, normalizeConfig } = require('./agent-company');
const { AsyncLabStore } = require('./async-lab/store');
const { AgentRunService } = require('./agent-runs/service');

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
        reasoningEffort: 'high',
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
            primaryModel: 'Gpt-5.6 Sol',
            reasoningEffort: ' HIGH ',
            escalationModels: ['Gpt-5.6 Terra', 'gpt_5.6-luna'],
        });

        expect(config.heartbeatMinutes).toBe(15);
        expect(config.weeklyWorkloadLimit).toBe(12);
        expect(config.maxConcurrentWorkloads).toBe(4);
        expect(config.primaryModel).toBe('gpt-5.6-sol');
        expect(config.reasoningEffort).toBe('high');
        expect(config.escalationModels).toEqual(['gpt-5.6-terra', 'gpt-5.6-luna']);
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

    test('keeps runtime state separate for named project sessions', async () => {
        let config = buildConfig({ sessionId: 'agent-company-alpha' });
        const service = new AgentCompanyService({
            statePath,
            now: () => new Date('2026-06-22T12:00:00.000Z'),
            settingsController: {
                getEffectiveAgentCompanyConfig: () => config,
            },
            workloadService: {
                isAvailable: () => false,
            },
            sessionStore: {},
        });

        await service.tick({ force: true, reason: 'alpha' });
        const alphaPath = service.getStatePath(config);
        config = buildConfig({ sessionId: 'agent-company-beta', companyGoal: 'Build the beta project.' });
        const betaStatusBeforeTick = await service.getStatus();
        await service.tick({ force: true, reason: 'beta' });
        const betaPath = service.getStatePath(config);

        expect(betaStatusBeforeTick.state.heartbeat.status).toBe('idle');
        expect(alphaPath).not.toBe(betaPath);
        expect(JSON.parse(await fs.readFile(alphaPath, 'utf8')).companyGoal)
            .toContain('podcast company');
        expect(JSON.parse(await fs.readFile(betaPath, 'utf8')).companyGoal)
            .toBe('Build the beta project.');
    });

    test('returns a completed canonical AgentRun envelope for a heartbeat', async () => {
        const agentRunService = new AgentRunService({
            store: new AsyncLabStore({ persistToPostgres: false }),
        });
        const service = new AgentCompanyService({
            statePath,
            agentRunService,
            now: () => new Date('2026-06-22T12:00:00.000Z'),
            settingsController: {
                getEffectiveAgentCompanyConfig: () => buildConfig(),
            },
            workloadService: {
                isAvailable: () => false,
            },
            sessionStore: {},
        });

        const result = await service.tick({ force: true, reason: 'canonical-proof' });

        expect(result.runId).toMatch(/^agent-run-/);
        expect(result.agentRun).toMatchObject({
            version: 'AgentRun/v1',
            state: 'completed',
            surface: 'agent-company',
        });
        expect(result.agentRunEvent.type).toBe('agent_company.heartbeat_completed');
        const persisted = await agentRunService.getRun(result.runId, 'system');
        expect(persisted.state).toBe('completed');
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

    test('clears stale running work when company scheduling is disabled', async () => {
        await fs.writeFile(statePath, JSON.stringify({
            enabled: true,
            runningWork: {
                running: 1,
                queued: 3,
                companyWorkloads: 8,
            },
            createdWorkloads: [{
                id: 'stale-workload',
                title: 'Stale workload',
            }],
        }), 'utf8');
        const service = new AgentCompanyService({
            statePath,
            now: () => new Date('2026-06-22T12:00:00.000Z'),
            settingsController: {
                getEffectiveAgentCompanyConfig: () => buildConfig({
                    enabled: false,
                }),
            },
            workloadService: {
                isAvailable: () => true,
            },
            sessionStore: {},
        });

        const result = await service.tick({ force: true, reason: 'disabled-cleanup-test' });

        expect(result.state.enabled).toBe(false);
        expect(result.state.runningWork).toEqual({
            running: 0,
            queued: 0,
            companyWorkloads: 0,
        });
        expect(result.state.createdWorkloads).toEqual([]);
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
                    policy: payload.policy,
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
        expect(createdWorkloads[0].metadata.longAgent.maxAutoSteps).toBe(4);
        expect(createdWorkloads[0].metadata.longAgent.sharedWhiteboardFile).toBe('.kimibuilt/agent-company/2026-06-22-whiteboard.md');
        expect(createdWorkloads[0].metadata.longAgent.compaction).toEqual(expect.objectContaining({
            triggerCharCount: 10000,
            retainChars: 4500,
        }));
        expect(createdWorkloads[0].metadata.requestedModel).toBe('gpt-5.5');
        expect(createdWorkloads[0].metadata.reasoningEffort).toBe('high');
        expect(createdWorkloads[0].policy).toEqual(expect.objectContaining({
            maxRounds: 5,
            maxToolCalls: 14,
        }));
        expect(createdWorkloads[0].metadata.modelSelection).toEqual(expect.objectContaining({
            model: 'gpt-5.5',
            competency: 'strategy-planning',
            source: 'primaryModel',
        }));
        expect(createdWorkloads[0].metadata.agentCompany.heartbeatManaged).toBe(true);
        expect(createdWorkloads[0].metadata.agentCompany.modelPolicy.reasoningEffort).toBe('high');
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
            qualityProfiles: expect.arrayContaining([
                expect.objectContaining({
                    id: 'document-artifact',
                    requiredChecks: expect.arrayContaining(['format_locked', 'target_medium_checked']),
                }),
                expect.objectContaining({
                    id: 'website-experience',
                    requiredChecks: expect.arrayContaining(['public_or_preview_url', 'browser_proof']),
                }),
                expect.objectContaining({
                    id: 'remote-deployment',
                    requiredChecks: expect.arrayContaining(['change_continuity', 'verification_commands']),
                }),
            ]),
        }));
        expect(createdWorkloads.map((workload) => workload.title)).toContain('Operations Lead: Recursive improvement review');
        expect(createdWorkloads.find((workload) => workload.title.includes('Recursive improvement review')).prompt)
            .toContain('sense, plan, act, verify, learn');
        expect(createdWorkloads[0].prompt).toContain('Separate communication from deliverables');
        expect(createdWorkloads[0].prompt).toContain('Do not count an HTML file as a deliverable if it is only a plan');
        expect(createdWorkloads[0].prompt).toContain('Reuse verified prior outputs before generating replacements');
        expect(createdWorkloads[0].prompt).toContain('Use managed-app create/iterate/reconcile/doctor');
        expect(createdWorkloads[0].prompt).toContain('Use a stable concrete hostname under demoserver2.buzz');
        expect(createdWorkloads[0].prompt).toContain('Agent quality metrics:');
        expect(createdWorkloads[0].prompt).toContain('guardrails as release gates');
        expect(createdWorkloads[0].prompt).toContain('Start from current evidence, not a blank slate');
        expect(createdWorkloads[0].prompt).toContain('Save tokens: cite paths, IDs, URLs, and concise deltas');
        expect(createdWorkloads[0].prompt).toContain('Selected model lane: gpt-5.5 (strategy-planning, primaryModel).');
        expect(createdWorkloads[0].prompt).toContain('Shared whiteboard:');
        expect(createdWorkloads[0].prompt).toContain('.kimibuilt/agent-company/2026-06-22-whiteboard.md');
        expect(createdWorkloads[0].prompt).toContain('the admin-visible state is /home/kimibuilt/.kimibuilt');
        expect(createdWorkloads[0].prompt).toContain('repo source path /opt/kimibuilt/.kimibuilt');
        expect(createdWorkloads[0].prompt).toContain('overall goal complete');
        expect(createdWorkloads[0].prompt).toContain('Claims checked, Decisions made, Files/artifacts changed, Deployment/DNS state, Blockers, Next agent task');
        expect(createdWorkloads[0].metadata.agentCompany.outputContract).toEqual(expect.objectContaining({
            reuseBeforeRegenerate: true,
            adminVisibleStateRoot: '/home/kimibuilt/.kimibuilt',
            repoEvidenceStateRoot: '/opt/kimibuilt/.kimibuilt',
        }));
    });

    test('selects a competency-fit model and skips known unavailable defaults', async () => {
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
                    primaryModel: '',
                    escalationModels: ['codex-latest', 'deepseek-v4-pro'],
                    maxConcurrentWorkloads: 4,
                }),
            },
            workloadService,
            sessionStore: {
                getOrCreateOwned: jest.fn(async () => ({ id: 'agent-company' })),
            },
        });

        await service.tick({ force: true, reason: 'model-selection-test' });

        const operationsWorkload = createdWorkloads.find((workload) => workload.title.includes('Operations Lead'));
        expect(operationsWorkload.metadata.requestedModel).toBe('deepseek-v4-pro');
        expect(operationsWorkload.metadata.modelSelection).toEqual(expect.objectContaining({
            competency: 'operations-verification',
            excluded: ['codex-latest'],
            model: 'deepseek-v4-pro',
            source: 'competencyProfile',
        }));
        expect(operationsWorkload.metadata.agentCompany.modelPolicy).toEqual(expect.objectContaining({
            selectedModel: 'deepseek-v4-pro',
            selectedCompetency: 'operations-verification',
            excludedModels: ['codex-latest'],
        }));
        expect(operationsWorkload.prompt).toContain('Selected model lane: deepseek-v4-pro (operations-verification, competencyProfile).');
    });

    test('drops stale created workload state when Postgres has no matching company workloads', async () => {
        await fs.writeFile(statePath, JSON.stringify({
            createdWorkloads: [{
                id: 'stale-workload',
                title: 'Stale workload',
                planItemId: 'old-plan',
                scheduledFor: '2026-06-21T10:00:00.000Z',
            }],
        }), 'utf8');
        const createWorkload = jest.fn(async (payload, ownerId) => ({
            id: 'fresh-workload',
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
                    maxConcurrentWorkloads: 1,
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

        const result = await service.tick({ force: true, reason: 'stale-state-test' });

        expect(result.state.createdWorkloads).toEqual([expect.objectContaining({
            id: 'fresh-workload',
        })]);
        expect(result.state.createdWorkloads).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'stale-workload' }),
        ]));
    });

    test('schedules one focused shared whiteboard refresh workload for the refresh reason', async () => {
        const createdWorkloads = [];
        const workloadService = {
            isAvailable: () => true,
            listAdminWorkloads: jest.fn(async () => createdWorkloads),
            createWorkload: jest.fn(async (payload, ownerId) => {
                const workload = {
                    id: `workload-${createdWorkloads.length + 1}`,
                    ownerId,
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
                    maxConcurrentWorkloads: 2,
                }),
            },
            workloadService,
            sessionStore: {
                getOrCreateOwned: jest.fn(async () => ({ id: 'agent-company' })),
            },
        });

        const first = await service.tick({ force: true, reason: 'shared-whiteboard-refresh' });
        const second = await service.tick({ force: true, reason: 'shared-whiteboard-refresh' });

        expect(first.createdWorkloads).toHaveLength(1);
        expect(second.createdWorkloads).toHaveLength(0);
        expect(workloadService.createWorkload).toHaveBeenCalledTimes(1);
        expect(first.state.heartbeat.status).toBe('scheduled');
        expect(first.state.shortTermSchedule).toEqual([expect.objectContaining({
            id: `2026-06-22-${first.state.companyGoalHash}-shared-whiteboard-refresh`,
            title: 'Refresh shared whiteboard',
            roleName: 'Operations Lead',
            workloadReason: 'shared-whiteboard-refresh',
            workloadFocus: '.kimibuilt/agent-company/2026-06-22-whiteboard.md',
        })]);
        expect(createdWorkloads[0].title).toBe('Operations Lead: Refresh shared whiteboard');
        expect(createdWorkloads[0].metadata.agentCompany.planItemId).toBe(`2026-06-22-${first.state.companyGoalHash}-shared-whiteboard-refresh`);
        expect(createdWorkloads[0].metadata.agentCompany.workloadReason).toBe('shared-whiteboard-refresh');
        expect(createdWorkloads[0].metadata.agentCompany.workloadFocus).toBe('.kimibuilt/agent-company/2026-06-22-whiteboard.md');
        expect(createdWorkloads[0].prompt).toContain('Whiteboard refresh focus:');
        expect(createdWorkloads[0].prompt).toContain('Do not start a broad company cycle or create an unrelated deliverable.');
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

    test('fills available capacity after a scheduled item fails', async () => {
        const createWorkload = jest.fn()
            .mockRejectedValueOnce(new Error('scheduler rejected invalid trigger'))
            .mockImplementationOnce(async (payload, ownerId) => ({
                id: 'workload-after-failure-1',
                ownerId,
                title: payload.title,
                trigger: payload.trigger,
                metadata: payload.metadata,
            }))
            .mockImplementationOnce(async (payload, ownerId) => ({
                id: 'workload-after-failure-2',
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

        expect(createWorkload).toHaveBeenCalledTimes(3);
        expect(result.createdWorkloads).toHaveLength(2);
        expect(result.createdWorkloads.map((workload) => workload.id)).toEqual([
            'workload-after-failure-1',
            'workload-after-failure-2',
        ]);
        expect(result.state.heartbeat.status).toBe('scheduled_with_errors');
        expect(result.state.heartbeat.failedWorkloads).toBe(1);
        expect(result.state.heartbeat.createFailures).toEqual([expect.objectContaining({
            message: 'scheduler rejected invalid trigger',
        })]);
        expect(JSON.parse(await fs.readFile(statePath, 'utf8')).heartbeat.createFailures).toHaveLength(1);
    });
});
