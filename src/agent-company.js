'use strict';

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { getStateDirectory } = require('./runtime-state-paths');
const {
    normalizeDailyAlignmentConfig,
    runDailyFeedbackAlignment,
    shouldRunDailyAlignment,
} = require('./alignment/daily-feedback-loop');

const DEFAULT_STATE_FILENAME = 'agent-company-state.json';
const DEFAULT_OWNER_ID = 'system';
const DEFAULT_SESSION_ID = 'agent-company';
const MIN_HEARTBEAT_MINUTES = 15;

function sanitizeText(value = '') {
    return String(value || '').trim();
}

function sanitizeErrorMessage(error) {
    return sanitizeText(error?.message || error || 'Unknown error').slice(0, 240);
}

function clampInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.max(min, Math.min(Math.trunc(numeric), max));
}

function hashGoal(goal = '') {
    return crypto.createHash('sha256')
        .update(sanitizeText(goal).toLowerCase())
        .digest('hex')
        .slice(0, 16);
}

function getWeekStart(date = new Date()) {
    const current = new Date(date);
    const day = current.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    current.setUTCDate(current.getUTCDate() + diff);
    current.setUTCHours(0, 0, 0, 0);
    return current;
}

function getWeekKey(date = new Date()) {
    return getWeekStart(date).toISOString().slice(0, 10);
}

function addDays(date, days) {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
}

function normalizeRole(role = {}, index = 0) {
    const name = sanitizeText(role.name || role.label || role.id || `Role ${index + 1}`);
    const id = sanitizeText(role.id || name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || `role-${index + 1}`;

    return {
        id,
        name: name.slice(0, 80),
        mission: sanitizeText(role.mission || role.description || '').slice(0, 500),
    };
}

function normalizeConfig(config = {}) {
    const roles = Array.isArray(config.roles) && config.roles.length > 0
        ? config.roles.map(normalizeRole).filter((role) => role.name)
        : [];
    const escalationModels = Array.isArray(config.escalationModels)
        ? config.escalationModels.map(sanitizeText).filter(Boolean)
        : String(config.escalationModels || '')
            .split(',')
            .map(sanitizeText)
            .filter(Boolean);

    return {
        enabled: config.enabled === true,
        companyGoal: sanitizeText(config.companyGoal || config.goal || ''),
        heartbeatMinutes: clampInteger(config.heartbeatMinutes, 60, {
            min: MIN_HEARTBEAT_MINUTES,
            max: 1440,
        }),
        scheduleHorizonDays: clampInteger(config.scheduleHorizonDays, 7, {
            min: 1,
            max: 30,
        }),
        weeklyWorkloadLimit: clampInteger(config.weeklyWorkloadLimit, 3, {
            min: 1,
            max: 12,
        }),
        maxConcurrentWorkloads: clampInteger(config.maxConcurrentWorkloads, 1, {
            min: 1,
            max: 4,
        }),
        ownerId: sanitizeText(config.ownerId || DEFAULT_OWNER_ID) || DEFAULT_OWNER_ID,
        sessionId: sanitizeText(config.sessionId || DEFAULT_SESSION_ID) || DEFAULT_SESSION_ID,
        primaryModel: sanitizeText(config.primaryModel || ''),
        escalationModels: escalationModels.length > 0 ? escalationModels.slice(0, 8) : ['gpt-5.5', 'codex-latest'],
        roles: roles.slice(0, 8),
        dailyAlignment: normalizeDailyAlignmentConfig(config.dailyAlignment),
        source: sanitizeText(config.source || ''),
    };
}

function defaultState() {
    return {
        version: 1,
        enabled: false,
        companyGoal: '',
        companyGoalHash: '',
        heartbeat: {
            status: 'idle',
            lastAt: null,
            nextAt: null,
            reason: 'not_started',
            createdWorkloads: 0,
            failedWorkloads: 0,
            skipped: 0,
            createFailures: [],
        },
        modelPolicy: {
            primaryModel: '',
            escalationModels: [],
        },
        roles: [],
        shortTermSchedule: [],
        longTermGoals: [],
        runningWork: {
            running: 0,
            queued: 0,
            companyWorkloads: 0,
        },
        dailyAlignment: {
            status: 'idle',
            lastAt: null,
            nextAt: null,
            lastDayKey: '',
            applied: [],
            rejected: [],
            evidence: {},
        },
        createdWorkloads: [],
        updatedAt: null,
    };
}

class AgentCompanyService {
    constructor({
        settingsController,
        workloadService,
        sessionStore,
        logsController = null,
        collectAlignmentSuggestions = null,
        applySelfReflectionUpdate = null,
        statePath = path.join(getStateDirectory(), DEFAULT_STATE_FILENAME),
        pollMs = 60000,
        now = () => new Date(),
    } = {}) {
        this.settingsController = settingsController;
        this.workloadService = workloadService;
        this.sessionStore = sessionStore;
        this.logsController = logsController;
        this.collectAlignmentSuggestions = collectAlignmentSuggestions;
        this.applySelfReflectionUpdate = applySelfReflectionUpdate;
        this.statePath = statePath;
        this.pollMs = pollMs;
        this.now = now;
        this.timer = null;
        this.isTicking = false;
    }

    start() {
        if (this.timer) {
            return true;
        }
        this.timer = setInterval(() => {
            this.tick().catch((error) => {
                console.warn('[AgentCompany] Heartbeat failed:', error.message);
            });
        }, this.pollMs);
        this.timer.unref?.();
        this.tick().catch((error) => {
            console.warn('[AgentCompany] Initial heartbeat failed:', error.message);
        });
        return true;
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    getConfig() {
        return normalizeConfig(
            this.settingsController?.getEffectiveAgentCompanyConfig?.()
            || this.settingsController?.settings?.agentCompany
            || {},
        );
    }

    async readState() {
        try {
            const raw = await fs.readFile(this.statePath, 'utf8');
            const parsed = JSON.parse(raw);
            return {
                ...defaultState(),
                ...(parsed && typeof parsed === 'object' ? parsed : {}),
            };
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn('[AgentCompany] Failed to read state:', error.message);
            }
            return defaultState();
        }
    }

    async writeState(state = {}) {
        const nextState = {
            ...defaultState(),
            ...state,
            updatedAt: this.now().toISOString(),
            statePath: this.statePath,
        };
        await fs.mkdir(path.dirname(this.statePath), { recursive: true });
        const tempPath = `${this.statePath}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(nextState, null, 2), 'utf8');
        await fs.rename(tempPath, this.statePath);
        return nextState;
    }

    async getStatus() {
        const config = this.getConfig();
        const state = await this.readState();
        return {
            available: Boolean(this.workloadService?.isAvailable?.()),
            config,
            state,
        };
    }

    shouldHeartbeat(state = {}, config = {}) {
        if (shouldRunDailyAlignment(state?.dailyAlignment || {}, config?.dailyAlignment || {}, this.now())) {
            return true;
        }
        if (!config.enabled || !config.companyGoal) {
            return false;
        }
        const nextAt = state?.heartbeat?.nextAt ? new Date(state.heartbeat.nextAt) : null;
        if (!nextAt || Number.isNaN(nextAt.getTime())) {
            return true;
        }
        return nextAt.getTime() <= this.now().getTime();
    }

    async buildDailyAlignmentState(config = {}, currentState = {}, heartbeat = {}, { force = false, reason = 'timer' } = {}) {
        return runDailyFeedbackAlignment({
            config: config.dailyAlignment,
            previousState: currentState.dailyAlignment || {},
            heartbeat,
            logs: this.logsController?.logs || [],
            sessionStore: this.sessionStore,
            collectSuggestions: this.collectAlignmentSuggestions || undefined,
            applyUpdate: this.applySelfReflectionUpdate || undefined,
            now: this.now(),
            force,
            reason,
        });
    }

    async tick({ force = false, reason = 'timer' } = {}) {
        if (this.isTicking) {
            return this.getStatus();
        }

        this.isTicking = true;
        try {
            const config = this.getConfig();
            const state = await this.readState();
            if (!force && !this.shouldHeartbeat(state, config)) {
                return {
                    available: Boolean(this.workloadService?.isAvailable?.()),
                    config,
                    state,
                    skipped: true,
                };
            }
            return this.heartbeat({ config, state, reason, force });
        } finally {
            this.isTicking = false;
        }
    }

    async heartbeat({ config = this.getConfig(), state = null, reason = 'manual', force = false } = {}) {
        const currentState = state || await this.readState();
        const now = this.now();
        const goalHash = hashGoal(config.companyGoal);
        const nextAt = new Date(now.getTime() + config.heartbeatMinutes * 60 * 1000).toISOString();

        if (!config.enabled || !config.companyGoal) {
            const heartbeat = {
                status: config.enabled ? 'waiting_for_goal' : 'disabled',
                lastAt: now.toISOString(),
                nextAt,
                reason,
                createdWorkloads: 0,
                skipped: 1,
            };
            const dailyAlignment = await this.buildDailyAlignmentState(config, currentState, heartbeat, { force, reason });
            const saved = await this.writeState({
                ...currentState,
                enabled: config.enabled,
                companyGoal: config.companyGoal,
                companyGoalHash: goalHash,
                roles: config.roles,
                modelPolicy: {
                    primaryModel: config.primaryModel,
                    escalationModels: config.escalationModels,
                },
                heartbeat,
                dailyAlignment,
            });
            return { available: false, config, state: saved };
        }

        if (
            !this.workloadService?.isAvailable?.()
            || !this.workloadService?.listAdminWorkloads
            || !this.workloadService?.createWorkload
            || !this.sessionStore?.getOrCreateOwned
        ) {
            const heartbeat = {
                status: 'standby',
                lastAt: now.toISOString(),
                nextAt,
                reason: 'workload_service_unavailable',
                createdWorkloads: 0,
                skipped: 1,
            };
            const dailyAlignment = await this.buildDailyAlignmentState(config, currentState, heartbeat, { force, reason });
            const saved = await this.writeState({
                ...currentState,
                enabled: true,
                companyGoal: config.companyGoal,
                companyGoalHash: goalHash,
                roles: config.roles,
                shortTermSchedule: this.buildWeeklySchedule(config, now, goalHash),
                modelPolicy: {
                    primaryModel: config.primaryModel,
                    escalationModels: config.escalationModels,
                },
                heartbeat,
                dailyAlignment,
            });
            return { available: false, config, state: saved };
        }

        await this.sessionStore.getOrCreateOwned(config.sessionId, {
            mode: 'chat',
            clientSurface: 'agent-company',
            ownerId: config.ownerId,
            title: 'Agent Company',
        }, config.ownerId);

        const weekKey = getWeekKey(now);
        const schedule = this.buildWeeklySchedule(config, now, goalHash);
        let companyWorkloads = [];
        try {
            companyWorkloads = await this.listCompanyWorkloads(goalHash, weekKey);
        } catch (error) {
            const heartbeat = {
                status: 'workload_list_failed',
                lastAt: now.toISOString(),
                nextAt,
                reason: 'workload_list_failed',
                createdWorkloads: 0,
                failedWorkloads: 1,
                skipped: schedule.length,
                createFailures: [{
                    stage: 'list',
                    message: sanitizeErrorMessage(error),
                }],
            };
            const dailyAlignment = await this.buildDailyAlignmentState(config, currentState, heartbeat, { force, reason });
            const saved = await this.writeState({
                ...currentState,
                enabled: true,
                companyGoal: config.companyGoal,
                companyGoalHash: goalHash,
                roles: config.roles,
                shortTermSchedule: schedule,
                longTermGoals: this.buildLongTermGoals(config, goalHash),
                modelPolicy: {
                    primaryModel: config.primaryModel,
                    escalationModels: config.escalationModels,
                },
                runningWork: {
                    running: 0,
                    queued: 0,
                    companyWorkloads: 0,
                },
                heartbeat,
                dailyAlignment,
            });
            return { available: false, config, state: saved };
        }
        const existingPlanIds = new Set(companyWorkloads
            .map((workload) => sanitizeText(workload?.metadata?.agentCompany?.planItemId))
            .filter(Boolean));
        const runningWork = this.summarizeRunningWork(companyWorkloads);
        const created = [];
        const createFailures = [];
        const activeWorkCount = runningWork.running + runningWork.queued;
        const availableSlots = Math.max(0, config.maxConcurrentWorkloads - activeWorkCount);

        if (availableSlots > 0) {
            const pendingItems = schedule
                .slice(0, config.weeklyWorkloadLimit)
                .filter((item) => !existingPlanIds.has(item.id))
                .slice(0, availableSlots);
            for (const item of pendingItems) {
                try {
                    const workload = await this.createScheduledWorkload(config, item, weekKey, goalHash);
                    if (!workload?.id) {
                        throw new Error('Workload service returned no workload id.');
                    }
                    created.push({
                        id: workload.id,
                        title: workload.title,
                        planItemId: item.id,
                        scheduledFor: item.plannedFor,
                    });
                    existingPlanIds.add(item.id);
                } catch (error) {
                    createFailures.push({
                        planItemId: item.id,
                        title: item.title,
                        roleId: item.roleId,
                        roleName: item.roleName,
                        message: sanitizeErrorMessage(error),
                    });
                }
            }
        }
        const createdIds = new Set(created.map((entry) => entry.id));
        const heartbeatStatus = (() => {
            if (availableSlots <= 0) {
                return 'active_limit';
            }
            if (created.length > 0 && createFailures.length > 0) {
                return 'scheduled_with_errors';
            }
            if (created.length > 0) {
                return 'scheduled';
            }
            if (createFailures.length > 0) {
                return 'creation_failed';
            }
            return 'steady';
        })();

        const heartbeat = {
            status: heartbeatStatus,
            lastAt: now.toISOString(),
            nextAt,
            reason,
            createdWorkloads: created.length,
            failedWorkloads: createFailures.length,
            skipped: schedule.length - created.length,
            createFailures,
        };
        const dailyAlignment = await this.buildDailyAlignmentState(config, currentState, heartbeat, { force, reason });

        const saved = await this.writeState({
            ...currentState,
            enabled: true,
            companyGoal: config.companyGoal,
            companyGoalHash: goalHash,
            roles: config.roles,
            shortTermSchedule: schedule,
            longTermGoals: this.buildLongTermGoals(config, goalHash),
            modelPolicy: {
                primaryModel: config.primaryModel,
                escalationModels: config.escalationModels,
            },
            runningWork,
            heartbeat,
            dailyAlignment,
            createdWorkloads: [
                ...created,
                ...((currentState.createdWorkloads || []).filter((entry) => !createdIds.has(entry?.id)).slice(0, 50)),
            ],
        });

        return {
            available: true,
            config,
            state: saved,
            createdWorkloads: created,
        };
    }

    buildWeeklySchedule(config = {}, now = this.now(), goalHash = hashGoal(config.companyGoal)) {
        const weekKey = getWeekKey(now);
        const start = getWeekStart(now);
        const roles = config.roles.length > 0 ? config.roles : [
            normalizeRole({ id: 'strategy', name: 'Strategy Lead' }),
            normalizeRole({ id: 'production', name: 'Production Lead' }),
            normalizeRole({ id: 'operations', name: 'Operations Lead' }),
        ];
        const templates = [
            {
                suffix: 'weekly-plan',
                title: 'Company weekly plan',
                objective: 'Set the weekly operating plan, decide priorities, and note what should not run yet.',
                dayOffset: 0,
                hour: 9,
            },
            {
                suffix: 'primary-deliverable',
                title: 'Primary company deliverable',
                objective: 'Create or materially advance the highest-leverage deliverable for the company goal.',
                dayOffset: 2,
                hour: 13,
            },
            {
                suffix: 'operations-review',
                title: 'Recursive improvement review',
                objective: 'Inspect recent company work, choose one small improvement, verify it, and update the next loop without creating duplicate automation.',
                dayOffset: 4,
                hour: 10,
            },
        ];
        const limit = Math.min(config.weeklyWorkloadLimit, roles.length * templates.length);
        const schedule = [];

        for (let round = 0; schedule.length < limit && round < templates.length; round += 1) {
            for (let roleIndex = 0; roleIndex < roles.length && schedule.length < limit; roleIndex += 1) {
                const role = roles[roleIndex] || normalizeRole({ name: 'Company Agent' });
                const template = templates[(roleIndex + round) % templates.length];
                const plannedFor = addDays(start, Math.min(
                    template.dayOffset + round,
                    config.scheduleHorizonDays - 1,
                ));
                plannedFor.setUTCHours(template.hour, roleIndex * 5, 0, 0);
                if (plannedFor.getTime() < now.getTime()) {
                    plannedFor.setTime(now.getTime() + (schedule.length + 1) * 2 * 60 * 1000);
                }

                schedule.push({
                    id: `${weekKey}-${goalHash}-${role.id}-${template.suffix}`,
                    weekKey,
                    roleId: role.id,
                    roleName: role.name,
                    title: template.title,
                    objective: template.objective,
                    plannedFor: plannedFor.toISOString(),
                    status: 'planned',
                });
            }
        }

        return schedule;
    }

    buildLongTermGoals(config = {}, goalHash = hashGoal(config.companyGoal)) {
        return [
            {
                id: `${goalHash}-company-outcome`,
                title: 'Company outcome',
                objective: config.companyGoal,
                horizon: 'long',
            },
            {
                id: `${goalHash}-weekly-operating-rhythm`,
                title: 'Weekly operating rhythm',
                objective: 'Keep a small schedule of agent work that advances the company goal without duplicate loops.',
                horizon: 'weekly',
            },
        ];
    }

    async listCompanyWorkloads(goalHash = '', weekKey = '') {
        const workloads = await this.workloadService.listAdminWorkloads(200);
        return workloads.filter((workload) => {
            const metadata = workload?.metadata?.agentCompany || {};
            return metadata.enabled === true
                && (!goalHash || metadata.companyGoalHash === goalHash)
                && (!weekKey || metadata.weekKey === weekKey);
        });
    }

    summarizeRunningWork(workloads = []) {
        return workloads.reduce((summary, workload) => {
            const runSummary = workload?.workloadSummary || {};
            summary.companyWorkloads += 1;
            summary.running += Number(runSummary.running || 0);
            summary.queued += Number(runSummary.queued || 0);
            return summary;
        }, {
            running: 0,
            queued: 0,
            companyWorkloads: 0,
        });
    }

    selectModelForItem(config = {}, item = {}) {
        if (config.primaryModel) {
            return config.primaryModel;
        }
        if (item.roleId === 'operations' && config.escalationModels.includes('codex-latest')) {
            return 'codex-latest';
        }
        return config.escalationModels[0] || null;
    }

    buildWorkloadPrompt(config = {}, item = {}, weekKey = '') {
        const role = config.roles.find((candidate) => candidate.id === item.roleId) || {};
        const escalation = config.escalationModels.length > 0
            ? config.escalationModels.join(', ')
            : 'no configured escalation models';

        return [
            '[Agent company work item]',
            `Company goal: ${config.companyGoal}`,
            `Week: ${weekKey}`,
            `Role: ${item.roleName}`,
            role.mission ? `Role mission: ${role.mission}` : null,
            `Objective: ${item.objective}`,
            '',
            'Operating rules:',
            '- Do one concrete, useful company step and verify it as far as the available tools allow.',
            '- Use a sense, plan, act, verify, learn rhythm: inspect existing work first, choose one bounded action, test the result, and record the next improvement.',
            '- Keep side effects conservative unless the task explicitly has admin-approved tools.',
            '- If the selected model cannot complete the task because of context length, tool capability, or provider failure, record the smallest model-switch recommendation using the configured escalation models.',
            `- Escalation models: ${escalation}.`,
            '- Do not create duplicate recurring jobs; inspect current work first and update the schedule or scratch summary instead.',
            '- End with "Stage scratch summary" containing done, verification, blockers, next step, and schedule impact.',
        ].filter(Boolean).join('\n');
    }

    async createScheduledWorkload(config = {}, item = {}, weekKey = '', goalHash = '') {
        const requestedModel = this.selectModelForItem(config, item);
        return this.workloadService.createWorkload({
            sessionId: config.sessionId,
            title: `${item.roleName}: ${item.title}`,
            mode: 'chat',
            prompt: this.buildWorkloadPrompt(config, item, weekKey),
            trigger: {
                type: 'once',
                runAt: item.plannedFor,
            },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 6,
                maxToolCalls: 18,
                maxDurationMs: 900000,
                allowSideEffects: false,
            },
            ...(requestedModel ? { model: requestedModel } : {}),
            metadata: {
                requestedModel,
                longAgent: {
                    enabled: true,
                    goal: config.companyGoal,
                    scratchFile: `.kimibuilt/agent-company/${weekKey}-${item.roleId}.md`,
                    maxAutoSteps: 6,
                    reviewPolicy: 'auto',
                    compaction: {
                        enabled: true,
                        triggerCharCount: 12000,
                        retainChars: 6000,
                    },
                },
                agentCompany: {
                    enabled: true,
                    companyGoalHash: goalHash,
                    weekKey,
                    planItemId: item.id,
                    roleId: item.roleId,
                    roleName: item.roleName,
                    plannedFor: item.plannedFor,
                    heartbeatManaged: true,
                    modelPolicy: {
                        primaryModel: config.primaryModel || null,
                        escalationModels: config.escalationModels,
                    },
                },
            },
        }, config.ownerId);
    }
}

module.exports = {
    AgentCompanyService,
    DEFAULT_STATE_FILENAME,
    hashGoal,
    normalizeConfig,
};
