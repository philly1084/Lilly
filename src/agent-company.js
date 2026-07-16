'use strict';

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const {
    advanceSurfaceAgentRun,
    attachAgentRunMetadata,
    beginSurfaceAgentRun,
} = require('./agent-runs/runtime-bridge');
const { getStateDirectory } = require('./runtime-state-paths');
const {
    normalizeDailyAlignmentConfig,
    runDailyFeedbackAlignment,
    shouldRunDailyAlignment,
} = require('./alignment/daily-feedback-loop');
const {
    buildAgentQualityContractText,
    buildQualityProfileMetadata,
} = require('./agent-quality-contract');

const DEFAULT_STATE_FILENAME = 'agent-company-state.json';
const DEFAULT_OWNER_ID = 'system';
const DEFAULT_SESSION_ID = 'agent-company';
const MIN_HEARTBEAT_MINUTES = 15;
const SHARED_WHITEBOARD_REFRESH_REASON = 'shared-whiteboard-refresh';
const COMPANY_LONG_AGENT_MAX_AUTO_STEPS = 4;
const COMPANY_LONG_AGENT_COMPACTION_TRIGGER_CHARS = 10000;
const COMPANY_LONG_AGENT_RETAIN_CHARS = 4500;
const COMPANY_WORKLOAD_MAX_ROUNDS = 5;
const COMPANY_WORKLOAD_MAX_TOOL_CALLS = 14;
const DEFAULT_MODEL_CANDIDATES = [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.4-pro',
    'gpt-5.4',
    'gpt-5.3-chat-latest',
    'gemini-3.1-pro-preview',
    'deepseek-reasoner',
    'deepseek-v4-pro',
    'kimi-k2.7-code-highspeed',
    'gemini-3.5-flash',
    'deepseek-v4-flash',
];
const MODEL_SELECTION_PROFILES = {
    strategy: {
        competency: 'strategy-planning',
        preferred: [
            'gpt-5.6-sol',
            'deepseek-reasoner',
            'gemini-3.1-pro-preview',
            'deepseek-v4-pro',
        ],
    },
    production: {
        competency: 'production-deliverable',
        preferred: [
            'gpt-5.6-terra',
            'gemini-3.1-pro-preview',
            'deepseek-v4-pro',
            'kimi-k2.7-code-highspeed',
        ],
    },
    operations: {
        competency: 'operations-verification',
        preferred: [
            'gpt-5.6-terra',
            'gpt-5.4-pro',
            'kimi-k2.7-code-highspeed',
            'gemini-3.1-pro-preview',
            'deepseek-v4-pro',
        ],
    },
    refresh: {
        competency: 'coordination-repair',
        preferred: [
            'gpt-5.6-sol',
            'gpt-5.4',
            'kimi-k2.7-code-highspeed',
            'deepseek-v4-pro',
            'gemini-3.1-pro-preview',
        ],
    },
};
const KNOWN_UNAVAILABLE_MODEL_IDS = new Set([
    'codex-latest',
]);

function sanitizeText(value = '') {
    return String(value || '').trim();
}

function normalizeModelIdentifier(value = '') {
    return sanitizeText(value)
        .toLowerCase()
        .replace(/[–—]/g, '-')
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-');
}

function sanitizeProjectStateKey(value = '') {
    return sanitizeText(value)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100) || DEFAULT_SESSION_ID;
}

function sanitizeErrorMessage(error) {
    return sanitizeText(error?.message || error || 'Unknown error').slice(0, 240);
}

function buildOutputQualityContract() {
    return [
        'Output quality contract:',
        '- Separate communication from deliverables: use the long-agent scratch Markdown only for status, reasoning summaries, blockers, and handoff notes.',
        '- Reuse verified prior outputs before generating replacements: inspect current deliverables, public URLs, source files, action history, and scratch/whiteboard notes, then update the smallest useful gap.',
        '- Final work must be a real deliverable in the right file family: Markdown or HTML for text-heavy briefs/runbooks/research notes, PDF/PPTX through the document/export path for presentation-quality reviews, XLSX only for genuinely tabular workbook data, source files for code, and index.html plus CSS/JS/assets for web previews.',
        '- Do not count an HTML file as a deliverable if it is only a plan, outline, placeholder page, TODO list, or prose about what should be built. HTML deliverables must render the requested finished content or usable interface.',
        '- For design or site work, include concrete visual structure, subject-specific copy, relevant assets or asset slots, responsive styling, and browser/UI verification evidence.',
        '- For production website/app/dashboard work, inventory existing managed apps, GitLab projects, k3s namespaces/services/ingresses, and candidate hostnames before creating anything new.',
        '- Use managed-app create/iterate/reconcile/doctor for explicit managed-app control-plane work; when deeper build/deploy work is needed, run it with executor:"remote-cli-agent" inside that evidence loop.',
        '- Use a stable concrete hostname under demoserver2.buzz for production web work unless a different domain is explicitly required; avoid wildcard ingress and verify DNS/TLS/public URL after deploy.',
        '- If the needed tool, export path, or deployment lane is unavailable, do not fake the final artifact. Return a blocker plus the exact next command/tool needed.',
        buildAgentQualityContractText(['document-artifact', 'website-experience', 'remote-deployment']),
    ].join('\n');
}

function getCompanyWhiteboardPath(weekKey = '') {
    const safeWeek = sanitizeText(weekKey).replace(/[^0-9-]/g, '') || 'current';
    return `.kimibuilt/agent-company/${safeWeek}-whiteboard.md`;
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

function isSharedWhiteboardRefresh(reason = '') {
    return sanitizeText(reason) === SHARED_WHITEBOARD_REFRESH_REASON;
}

function uniqueStrings(values = []) {
    const seen = new Set();
    return values
        .map(sanitizeText)
        .filter(Boolean)
        .filter((value) => {
            const key = value.toLowerCase();
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
}

function isKnownUnavailableModel(modelId = '') {
    return KNOWN_UNAVAILABLE_MODEL_IDS.has(sanitizeText(modelId).toLowerCase());
}

function classifyWorkItemCompetency(item = {}) {
    if (item.workloadReason === SHARED_WHITEBOARD_REFRESH_REASON) {
        return MODEL_SELECTION_PROFILES.refresh;
    }
    return MODEL_SELECTION_PROFILES[item.roleId] || MODEL_SELECTION_PROFILES.strategy;
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
        ? config.escalationModels.map(normalizeModelIdentifier).filter(Boolean)
        : String(config.escalationModels || '')
            .split(',')
            .map(normalizeModelIdentifier)
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
        primaryModel: normalizeModelIdentifier(config.primaryModel || ''),
        escalationModels: escalationModels.length > 0 ? escalationModels.slice(0, 8) : ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
        roles: roles.slice(0, 8),
        dailyAlignment: normalizeDailyAlignmentConfig(config.dailyAlignment),
        activeProjectId: sanitizeText(config.activeProjectId || ''),
        projects: Array.isArray(config.projects) ? config.projects.map((project) => ({ ...project })) : [],
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
        agentRunService = null,
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
        this.agentRunService = agentRunService;
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

    getStatePath(config = this.getConfig()) {
        const sessionId = sanitizeText(config?.sessionId || DEFAULT_SESSION_ID) || DEFAULT_SESSION_ID;
        if (sessionId === DEFAULT_SESSION_ID) {
            return this.statePath;
        }
        return path.join(
            path.dirname(this.statePath),
            'agent-company',
            'projects',
            `${sanitizeProjectStateKey(sessionId)}-state.json`,
        );
    }

    async readState(config = this.getConfig()) {
        const statePath = this.getStatePath(config);
        try {
            const raw = await fs.readFile(statePath, 'utf8');
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

    async writeState(state = {}, config = this.getConfig()) {
        const statePath = this.getStatePath(config);
        const nextState = {
            ...defaultState(),
            ...state,
            updatedAt: this.now().toISOString(),
            statePath,
        };
        await fs.mkdir(path.dirname(statePath), { recursive: true });
        const tempPath = `${statePath}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(nextState, null, 2), 'utf8');
        await fs.rename(tempPath, statePath);
        return nextState;
    }

    async getStatus() {
        const config = this.getConfig();
        const state = await this.readState(config);
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
            const state = await this.readState(config);
            if (!force && !this.shouldHeartbeat(state, config)) {
                return {
                    available: Boolean(this.workloadService?.isAvailable?.()),
                    config,
                    state,
                    skipped: true,
                };
            }
            const startedAt = this.now().toISOString();
            const agentRunShadow = await beginSurfaceAgentRun({
                agentRunService: this.agentRunService,
                conversationRunService: this.workloadService?.conversationRunService,
                allowSharedFallback: Boolean(
                    this.agentRunService
                    || this.workloadService?.conversationRunService?.app,
                ),
                surface: 'agent-company',
                mode: 'company-heartbeat',
                sourceId: `${config.sessionId || DEFAULT_SESSION_ID}:${reason}:${startedAt}`,
                sessionId: config.sessionId || DEFAULT_SESSION_ID,
                ownerId: config.ownerId || DEFAULT_OWNER_ID,
                objective: config.companyGoal || 'Agent Company heartbeat',
                state: 'executing',
                metadata: { reason, force },
            });
            try {
                const result = await this.heartbeat({ config, state, reason, force });
                await advanceSurfaceAgentRun(agentRunShadow, 'completed', {
                    reason: 'Agent Company heartbeat completed.',
                    details: {
                        heartbeatStatus: result?.state?.heartbeat?.status || null,
                        createdWorkloads: result?.createdWorkloads?.length
                            || result?.state?.heartbeat?.createdWorkloads
                            || 0,
                    },
                });
                return attachAgentRunMetadata(result, agentRunShadow, {
                    eventType: 'agent_company.heartbeat_completed',
                });
            } catch (error) {
                await advanceSurfaceAgentRun(agentRunShadow, 'failed', {
                    reason: error.message,
                    details: { errorCode: error.code || null },
                });
                throw error;
            }
        } finally {
            this.isTicking = false;
        }
    }

    async heartbeat({ config = this.getConfig(), state = null, reason = 'manual', force = false } = {}) {
        const currentState = state || await this.readState(config);
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
                runningWork: {
                    running: 0,
                    queued: 0,
                    companyWorkloads: 0,
                },
                createdWorkloads: [],
            }, config);
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
            }, config);
            return { available: false, config, state: saved };
        }

        await this.sessionStore.getOrCreateOwned(config.sessionId, {
            mode: 'chat',
            clientSurface: 'agent-company',
            ownerId: config.ownerId,
            title: 'Agent Company',
        }, config.ownerId);

        const weekKey = getWeekKey(now);
        const refreshWhiteboard = isSharedWhiteboardRefresh(reason);
        const schedule = refreshWhiteboard
            ? [this.buildSharedWhiteboardRefreshItem(config, weekKey, goalHash, now)]
            : this.buildWeeklySchedule(config, now, goalHash);
        let companyWorkloads = [];
        try {
            companyWorkloads = await this.listCompanyWorkloads(goalHash, weekKey, config.sessionId);
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
            }, config);
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
                .filter((item) => !existingPlanIds.has(item.id));
            for (const item of pendingItems) {
                if (created.length >= availableSlots) {
                    break;
                }
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
        const currentWorkloadIds = new Set(companyWorkloads.map((workload) => workload?.id).filter(Boolean));
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
                ...((currentState.createdWorkloads || [])
                    .filter((entry) => entry?.id && currentWorkloadIds.has(entry.id) && !createdIds.has(entry.id))
                    .slice(0, 50)),
            ],
        }, config);

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

    buildSharedWhiteboardRefreshItem(config = {}, weekKey = '', goalHash = '', now = this.now()) {
        const operationsRole = config.roles.find((role) => role.id === 'operations') || config.roles[0] || normalizeRole({
            id: 'operations',
            name: 'Operations Lead',
        });
        const plannedFor = new Date(now.getTime() + 60 * 1000);
        const whiteboardFile = getCompanyWhiteboardPath(weekKey);

        return {
            id: `${weekKey}-${goalHash}-shared-whiteboard-refresh`,
            weekKey,
            roleId: operationsRole.id,
            roleName: operationsRole.name,
            title: 'Refresh shared whiteboard',
            objective: `Inspect current Agent Company status, recent runs, and file/artifact evidence, then update ${whiteboardFile} with current coordination notes only.`,
            plannedFor: plannedFor.toISOString(),
            status: 'planned',
            workloadReason: SHARED_WHITEBOARD_REFRESH_REASON,
            workloadFocus: whiteboardFile,
        };
    }

    async listCompanyWorkloads(goalHash = '', weekKey = '', sessionId = '') {
        const workloads = await this.workloadService.listAdminWorkloads(200);
        return workloads.filter((workload) => {
            const metadata = workload?.metadata?.agentCompany || {};
            return metadata.enabled === true
                && (!sessionId || !workload.sessionId || workload.sessionId === sessionId)
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
        return this.buildModelSelection(config, item).model;
    }

    buildModelSelection(config = {}, item = {}) {
        const profile = classifyWorkItemCompetency(item);
        if (config.primaryModel) {
            return {
                model: config.primaryModel,
                competency: profile.competency,
                source: 'primaryModel',
                preferred: profile.preferred,
                candidates: uniqueStrings([config.primaryModel, ...(config.escalationModels || []), ...DEFAULT_MODEL_CANDIDATES]),
                excluded: [],
            };
        }

        const configuredCandidates = uniqueStrings(config.escalationModels || []);
        const allCandidates = uniqueStrings([
            ...configuredCandidates,
            ...DEFAULT_MODEL_CANDIDATES,
        ]);
        const excluded = allCandidates.filter(isKnownUnavailableModel);
        const usableConfiguredCandidates = configuredCandidates.filter((model) => !isKnownUnavailableModel(model));
        const usableCandidates = allCandidates.filter((model) => !isKnownUnavailableModel(model));
        const preferred = uniqueStrings([
            ...profile.preferred,
            ...usableCandidates,
        ]);
        const searchPool = usableConfiguredCandidates.length > 0 ? usableConfiguredCandidates : usableCandidates;
        const model = preferred.find((candidate) => searchPool.includes(candidate)) || searchPool[0] || null;

        return {
            model,
            competency: profile.competency,
            source: 'competencyProfile',
            preferred: profile.preferred,
            candidates: usableCandidates,
            excluded,
        };
    }

    formatModelSelection(selection = {}) {
        if (!selection?.model) {
            return 'No model selected; use the runtime default.';
        }
        return `${selection.model} (${selection.competency || 'general'}, ${selection.source || 'auto'})`;
    }

    buildWorkloadPrompt(config = {}, item = {}, weekKey = '') {
        const role = config.roles.find((candidate) => candidate.id === item.roleId) || {};
        const escalation = config.escalationModels.length > 0
            ? config.escalationModels.join(', ')
            : 'no configured escalation models';
        const modelSelection = this.buildModelSelection(config, item);
        const whiteboardFile = getCompanyWhiteboardPath(weekKey);
        const whiteboardRefreshLines = item.workloadReason === SHARED_WHITEBOARD_REFRESH_REASON
            ? [
                '',
                'Whiteboard refresh focus:',
                `- This workload is a dedicated coordination repair for ${item.workloadFocus || whiteboardFile}.`,
                '- Do not start a broad company cycle or create an unrelated deliverable.',
                '- Read current Agent Company status, recent run evidence, deliverables, and file/artifact signals, then update the shared whiteboard with concise current facts.',
                '- Make the next agent task specific enough that the following workload can continue without repeating discovery.',
            ]
            : [];

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
            '- Start from current evidence, not a blank slate: check existing deliverables, CEO action history, shared whiteboard state, source files, and live/public URLs before creating new work.',
            '- If a verified deliverable or live surface already satisfies the objective, improve one high-impact gap or stop with proof; do not regenerate a parallel artifact.',
            '- Keep side effects conservative unless the task explicitly has admin-approved tools.',
            '- If the selected model cannot complete the task because of context length, tool capability, or provider failure, record the smallest model-switch recommendation using the configured escalation models.',
            `- Escalation models: ${escalation}.`,
            `- Selected model lane: ${this.formatModelSelection(modelSelection)}.`,
            '- Do not create duplicate recurring jobs; inspect current work first and update the schedule or scratch summary instead.',
            '- Save tokens: cite paths, IDs, URLs, and concise deltas instead of pasting full prior plans, logs, source files, or unchanged prose.',
            buildOutputQualityContract(),
            '',
            'Shared whiteboard:',
            `- Use ${whiteboardFile} as the agent-to-agent whiteboard for this company week.`,
            '- Read it before acting if file tools are available; update it after acting so the next agent can continue without re-discovering the same facts.',
            '- For live KimiBuilt remote work, the admin-visible state is /home/kimibuilt/.kimibuilt. The repo source path /opt/kimibuilt/.kimibuilt is useful evidence, but it does not by itself satisfy the dashboard whiteboard check.',
            '- If a remote agent updates whiteboard or scratch files, verify the admin-visible state path or state the path mismatch as a blocker.',
            '- Keep whiteboard entries structured as: Claims checked, Decisions made, Files/artifacts changed, Deployment/DNS state, Blockers, Next agent task.',
            '- Keep plans in the whiteboard short and actionable; do not use it as the final deliverable or as a replacement for real files/artifacts.',
            ...whiteboardRefreshLines,
            '- End with "Stage scratch summary" containing done, changed files/artifacts, verification, blockers, next step, and schedule impact.',
            '- When the objective is satisfied and no follow-up stage is useful, include the exact phrase "overall goal complete" in the Stage scratch summary so the scheduler stops instead of spending another review pass.',
        ].filter(Boolean).join('\n');
    }

    async createScheduledWorkload(config = {}, item = {}, weekKey = '', goalHash = '') {
        const modelSelection = this.buildModelSelection(config, item);
        const requestedModel = modelSelection.model;
        const whiteboardFile = getCompanyWhiteboardPath(weekKey);
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
                maxRounds: COMPANY_WORKLOAD_MAX_ROUNDS,
                maxToolCalls: COMPANY_WORKLOAD_MAX_TOOL_CALLS,
                maxDurationMs: 900000,
                allowSideEffects: false,
            },
            ...(requestedModel ? { model: requestedModel } : {}),
            metadata: {
                requestedModel,
                modelSelection,
                longAgent: {
                    enabled: true,
                    goal: config.companyGoal,
                    scratchFile: `.kimibuilt/agent-company/${weekKey}-${item.roleId}.md`,
                    sharedWhiteboardFile: whiteboardFile,
                    maxAutoSteps: COMPANY_LONG_AGENT_MAX_AUTO_STEPS,
                    reviewPolicy: 'auto',
                    compaction: {
                        enabled: true,
                        triggerCharCount: COMPANY_LONG_AGENT_COMPACTION_TRIGGER_CHARS,
                        retainChars: COMPANY_LONG_AGENT_RETAIN_CHARS,
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
                    ...(item.workloadReason ? { workloadReason: item.workloadReason } : {}),
                    ...(item.workloadFocus ? { workloadFocus: item.workloadFocus } : {}),
                    sharedWhiteboard: {
                        path: whiteboardFile,
                        purpose: 'agent-to-agent weekly coordination',
                        sections: [
                            'Claims checked',
                            'Decisions made',
                            'Files/artifacts changed',
                            'Deployment/DNS state',
                            'Blockers',
                            'Next agent task',
                        ],
                    },
                    outputContract: {
                        communication: 'scratch-markdown',
                        deliverables: ['md', 'html', 'pdf', 'pptx', 'source', 'html-css-js-assets', 'xlsx'],
                        defaultTextFormats: ['md', 'html', 'pdf'],
                        xlsxUseCase: 'Only use XLSX for real spreadsheet/workbook data with rows, columns, formulas, or tables.',
                        rejectPlanningOnlyHtml: true,
                        productionWebHostRoot: 'demoserver2.buzz',
                        productionWebRequires: ['managed-app-inventory', 'stable-hostname', 'dns-tls-public-proof'],
                        reuseBeforeRegenerate: true,
                        adminVisibleStateRoot: '/home/kimibuilt/.kimibuilt',
                        repoEvidenceStateRoot: '/opt/kimibuilt/.kimibuilt',
                        qualityProfiles: buildQualityProfileMetadata([
                            'document-artifact',
                            'website-experience',
                            'remote-deployment',
                        ]),
                    },
                    modelPolicy: {
                        primaryModel: config.primaryModel || null,
                        escalationModels: config.escalationModels,
                        selectedModel: requestedModel,
                        selectedCompetency: modelSelection.competency,
                        selectionSource: modelSelection.source,
                        excludedModels: modelSelection.excluded,
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
