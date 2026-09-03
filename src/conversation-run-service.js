'use strict';

const { ensureRuntimeToolManager } = require('./runtime-tool-manager');
const { executeConversationRuntime } = require('./runtime-execution');
const { buildCompanyExecutionGuide, createCompanySessionView } = require('./agent-ops/execution-contract');
const {
    buildInstructionsWithArtifacts,
    buildArtifactCompletionMessage,
    canonicalizeRemoteToolId,
    extractSshSessionMetadataFromToolEvents,
    formatSshToolResult,
    inferRequestedOutputFormat,
    maybeGenerateOutputArtifact,
    maybePrepareImagesForArtifactPrompt,
    resolveArtifactContextIds,
} = require('./ai-route-utils');
const { extractResponseText } = require('./artifacts/artifact-service');
const { buildProjectMemoryUpdate, mergeProjectMemory } = require('./project-memory');
const { buildContinuityInstructions } = require('./runtime-prompts');
const { extractArtifactsFromToolEvents, mergeRuntimeArtifacts } = require('./runtime-artifacts');
const { buildScopedMemoryMetadata, isSessionIsolationEnabled, resolveSessionScope } = require('./session-scope');
const {
    buildAgentJournalInstructions,
    loadAgentJournalEntries,
    recordAgentJournalTurn,
    stripAgentJournalBlocks,
} = require('./agent-journal');
const {
    buildRequestDecisionFrame,
    buildRequestDecisionMetadata,
    formatRequestDecisionFrameForPrompt,
} = require('./request-decision-frame');

class ConversationRunService {
    constructor({
        app,
        sessionStore,
        memoryService,
    }) {
        this.app = app;
        this.sessionStore = sessionStore;
        this.memoryService = memoryService;
    }

    buildMemoryMetadata(ownerId = null, metadata = {}, session = null) {
        const memoryScope = resolveSessionScope({
            mode: metadata?.taskType || metadata?.mode || 'chat',
            taskType: metadata?.taskType || metadata?.mode || 'chat',
            clientSurface: metadata?.clientSurface || metadata?.client_surface || '',
            memoryScope: metadata?.memoryScope || metadata?.memory_scope || '',
            metadata,
        }, session || null);

        return buildScopedMemoryMetadata({
            ...(ownerId ? { ownerId } : {}),
            ...(memoryScope ? { memoryScope } : {}),
            ...(metadata?.memoryKeywords ? { memoryKeywords: metadata.memoryKeywords } : {}),
            ...(metadata?.clientSurface ? { sourceSurface: metadata.clientSurface } : {}),
        }, session || null);
    }

    buildAssistantArtifactMessage(artifacts = []) {
        const normalizedArtifacts = mergeRuntimeArtifacts(artifacts);
        if (normalizedArtifacts.length === 0) {
            return null;
        }

        return {
            artifacts: normalizedArtifacts,
            metadata: {
                artifacts: normalizedArtifacts,
            },
        };
    }

    async persistArtifactOutcome({
        sessionId,
        ownerId = null,
        session = null,
        message = '',
        outputText = '',
        artifacts = [],
        outputFormat = '',
        metadata = {},
    }) {
        const normalizedArtifacts = mergeRuntimeArtifacts(artifacts);
        if (!sessionId || normalizedArtifacts.length === 0) {
            return {
                artifacts: [],
                artifactMessage: '',
            };
        }

        const primaryArtifact = normalizedArtifacts[normalizedArtifacts.length - 1];
        const effectiveFormat = String(
            outputFormat
            || primaryArtifact?.format
            || inferRequestedOutputFormat(message)
            || '',
        ).trim();
        const artifactMessage = buildArtifactCompletionMessage(effectiveFormat, primaryArtifact);
        const memoryMetadata = this.buildMemoryMetadata(ownerId, metadata, session);
        const assistantMessagePayload = this.buildAssistantArtifactMessage(normalizedArtifacts);

        if (this.sessionStore?.update) {
            await this.sessionStore.update(sessionId, {
                metadata: {
                    ...(effectiveFormat ? { lastOutputFormat: effectiveFormat } : {}),
                    lastGeneratedArtifactId: primaryArtifact.id,
                },
            });
        }

        await this.appendSyntheticMessage(sessionId, 'assistant', artifactMessage, assistantMessagePayload);

        if (artifactMessage && this.memoryService?.rememberResponse) {
            this.memoryService.rememberResponse(sessionId, artifactMessage, memoryMetadata);
        }

        if (this.memoryService?.rememberArtifactResult) {
            await Promise.all(normalizedArtifacts.map((artifact) => this.memoryService.rememberArtifactResult(sessionId, {
                artifact,
                summary: artifactMessage,
                sourceText: outputText,
                metadata: {
                    ...memoryMetadata,
                    sourcePrompt: message,
                },
            })));
        }

        await this.updateProjectMemory(sessionId, ownerId, {
            userText: message,
            assistantText: artifactMessage,
            artifacts: normalizedArtifacts,
        });

        return {
            artifacts: normalizedArtifacts,
            artifactMessage,
        };
    }

    async runChatTurn({
        sessionId,
        ownerId = null,
        message,
        session = null,
        model = null,
        reasoningEffort = null,
        executionProfile = null,
        metadata = {},
        requestedToolIds = [],
        policy = null,
    }) {
        let resolvedSession = session || (ownerId
            ? await this.sessionStore.getOwned(sessionId, ownerId)
            : await this.sessionStore.get(sessionId));

        if (!resolvedSession) {
            const error = new Error('Session not found');
            error.statusCode = 404;
            throw error;
        }
        if (metadata.agentCompanyRun === true) resolvedSession = createCompanySessionView(resolvedSession);
        const sanitizedMessage = stripAgentJournalBlocks(message);
        const outputFormat = String(metadata?.outputFormat || '').trim().toLowerCase()
            || (metadata?.agentCompanyRun === true ? null : inferRequestedOutputFormat(sanitizedMessage));
        const requestFrame = buildRequestDecisionFrame({
            text: sanitizedMessage,
            session: resolvedSession,
            outputFormat,
            candidateOutputFormat: outputFormat,
            outputFormatProvided: Boolean(metadata?.outputFormat),
            artifactIds: metadata?.artifactIds || [],
            effectiveArtifactIds: [],
            executionProfile,
            taskType: metadata.taskType || 'chat',
            clientSurface: metadata.clientSurface || '',
            route: '/api/workloads',
        });
        const requestFrameMetadata = buildRequestDecisionMetadata(requestFrame);

        const runtimeToolManager = await ensureRuntimeToolManager(this.app);
        let companyTargets = [];
        let targetDiscoveryError = '';
        if (metadata.agentCompanyRun === true) {
            const runner = runtimeToolManager?.getTool?.('remote-cli-agent')?.runner;
            if (runner?.listRemoteAgentTargets) {
                try {
                    companyTargets = await runner.listRemoteAgentTargets();
                } catch (error) {
                    targetDiscoveryError = error.code || 'REMOTE_AGENT_TARGETS_UNAVAILABLE';
                }
            }
        }
        const sessionIsolation = isSessionIsolationEnabled(metadata, resolvedSession);
        const managedAppsSummary = this.app?.locals?.managedAppService?.buildPromptSummary
            ? await this.app.locals.managedAppService.buildPromptSummary({
                ownerId,
                maxApps: 4,
            })
            : '';
        const agentJournalInstructions = metadata.agentCompanyRun === true ? '' : buildAgentJournalInstructions(
            await loadAgentJournalEntries(this.sessionStore, resolvedSession, ownerId),
        );
        const instructions = await buildInstructionsWithArtifacts(
            resolvedSession,
            [
                formatRequestDecisionFrameForPrompt(requestFrame),
                agentJournalInstructions,
                buildContinuityInstructions(),
                metadata.agentCompanyRun === true ? buildCompanyExecutionGuide({
                    toolManager: runtimeToolManager, model, reasoningEffort, metadata, policy: policy || {},
                    targets: companyTargets, targetDiscoveryError,
                }) : '',
                metadata.agentCompanyRun === true ? metadata.companyRunContext || '' : '',
            ].filter(Boolean).join('\n\n'),
            [],
        );

        const execution = await executeConversationRuntime(this.app, {
            input: sanitizedMessage,
            session: resolvedSession,
            sessionId,
            memoryInput: sanitizedMessage,
            previousResponseId: resolvedSession.previousResponseId,
            instructions,
            stream: false,
            model,
            reasoningEffort,
            toolManager: runtimeToolManager,
            ...(metadata.agentCompanyRun === true ? { loadRecentMessages: false, loadContextMessages: false, previousResponseId: null } : {}),
            toolContext: {
                reasoningEffort,
                sessionId,
                runId: metadata?.agentRunId || null,
                agentRunId: metadata?.agentRunId || null,
                route: '/api/workloads',
                transport: 'worker',
                memoryService: this.memoryService,
                ownerId,
                managedAppsSummary,
                workloadService: this.app?.locals?.agentWorkloadService,
                managedAppService: this.app?.locals?.managedAppService || null,
                sessionIsolation,
                subAgentDepth: Number(metadata?.subAgentDepth || 0),
                subAgentOrchestrationId: metadata?.subAgentOrchestrationId || null,
            },
            executionProfile,
            enableAutomaticToolCalls: true,
            enableConversationExecutor: true,
            taskType: metadata.taskType || 'chat',
            metadata: {
                ...metadata,
                ...requestFrameMetadata,
            },
            ownerId,
            requestedToolIds,
            toolBudget: policy ? {
                maxRounds: policy.maxRounds,
                maxToolCalls: policy.maxToolCalls,
                maxDurationMs: policy.maxDurationMs,
            } : null,
        });

        const response = execution.response;
        const outputText = extractResponseText(response);
        const toolEvents = response?.metadata?.toolEvents || [];
        const toolArtifacts = extractArtifactsFromToolEvents(toolEvents);
        const memoryMetadata = this.buildMemoryMetadata(ownerId, metadata, resolvedSession);

        if (!execution.handledPersistence) {
            await this.sessionStore.recordResponse(
                sessionId,
                response.id,
                response?.metadata?.promptState ? { promptState: response.metadata.promptState } : null,
            );
            if (outputText) {
                this.memoryService.rememberResponse(sessionId, outputText, memoryMetadata);
            }
            await this.sessionStore.appendMessages(sessionId, [
                { role: 'user', content: sanitizedMessage },
                { role: 'assistant', content: outputText, metadata: requestFrameMetadata },
            ]);
        }
        const sshMetadata = extractSshSessionMetadataFromToolEvents(toolEvents);
        if (sshMetadata) {
            await this.sessionStore.update(sessionId, { metadata: sshMetadata });
        }

        const deferredArtifact = await this.maybeGenerateDeferredArtifact({
            runtimeToolManager,
            sessionId,
            ownerId,
            session: resolvedSession,
            message: sanitizedMessage,
            mode: metadata.taskType || 'chat',
            responseId: response?.id || null,
            outputText,
            model,
            reasoningEffort,
            metadata,
        });
        const persistedDeferredArtifacts = mergeRuntimeArtifacts(deferredArtifact.artifacts || []);
        let artifactMessage = String(deferredArtifact.artifactMessage || '').trim();
        const missingToolArtifacts = toolArtifacts.filter((artifact) => !persistedDeferredArtifacts.some((entry) => (
            (entry?.id && artifact?.id && entry.id === artifact.id)
            || (entry?.downloadUrl && artifact?.downloadUrl && entry.downloadUrl === artifact.downloadUrl)
        )));

        if (missingToolArtifacts.length > 0 || (!artifactMessage && toolArtifacts.length > 0)) {
            const surfacedArtifactOutcome = await this.persistArtifactOutcome({
                sessionId,
                ownerId,
                session: resolvedSession,
                message: sanitizedMessage,
                outputText,
                artifacts: missingToolArtifacts.length > 0 ? missingToolArtifacts : toolArtifacts,
                outputFormat: missingToolArtifacts[missingToolArtifacts.length - 1]?.format
                    || toolArtifacts[toolArtifacts.length - 1]?.format
                    || '',
                metadata,
            });
            artifactMessage = artifactMessage || surfacedArtifactOutcome.artifactMessage;
        }
        const runtimeArtifacts = mergeRuntimeArtifacts(toolArtifacts, persistedDeferredArtifacts);

        const updatedProjectSession = await this.updateProjectMemory(sessionId, ownerId, {
            userText: sanitizedMessage,
            assistantText: outputText,
            toolEvents,
            artifacts: runtimeArtifacts,
        });
        try {
            await recordAgentJournalTurn(this.sessionStore, resolvedSession, {
                ownerId,
                responseId: response?.id || '',
                userText: sanitizedMessage,
                assistantText: artifactMessage || outputText,
                toolEvents,
                artifacts: runtimeArtifacts,
            });
        } catch (error) {
            console.warn('[ConversationRunService] Failed to update agent journal:', error.message);
        }
        if (this.sessionStore?.maybeCompactSession) {
            await this.sessionStore.maybeCompactSession(sessionId, {
                ownerId,
                workflow: null,
                projectMemory: updatedProjectSession?.metadata?.projectMemory || null,
            });
        }

        return {
            execution,
            response,
            outputText,
            toolEvents,
            artifacts: runtimeArtifacts,
            artifactMessage,
        };
    }

    async createArtifactFromContent({
        sessionId,
        ownerId = null,
        session = null,
        content = '',
        outputFormat = '',
        message = '',
        mode = 'chat',
        model = null,
        reasoningEffort = null,
        metadata = {},
    }) {
        const resolvedSession = session || (ownerId
            ? await this.sessionStore.getOwned(sessionId, ownerId)
            : await this.sessionStore.get(sessionId));

        if (!resolvedSession) {
            const error = new Error('Session not found');
            error.statusCode = 404;
            throw error;
        }

        const outputText = String(content || '').trim();
        if (!outputText) {
            const error = new Error('Artifact stages need source content from a prior stage.');
            error.statusCode = 400;
            throw error;
        }

        const runtimeToolManager = await ensureRuntimeToolManager(this.app);
        const deferredArtifact = await this.maybeGenerateDeferredArtifact({
            runtimeToolManager,
            sessionId,
            ownerId,
            session: resolvedSession,
            message: message || `Create a ${outputFormat || 'document'} artifact from the prior stage output.`,
            mode,
            responseId: null,
            outputText,
            model,
            reasoningEffort,
            metadata: {
                ...metadata,
                workloadRun: true,
                outputFormat,
            },
        });

        return {
            outputText,
            toolEvents: [],
            artifacts: deferredArtifact.artifacts,
            artifactMessage: deferredArtifact.artifactMessage,
        };
    }

    async runStructuredExecution({
        sessionId,
        ownerId = null,
        execution,
        session = null,
        metadata = {},
    }) {
        const resolvedSession = session || (ownerId
            ? await this.sessionStore.getOwned(sessionId, ownerId)
            : await this.sessionStore.get(sessionId));

        if (!resolvedSession) {
            const error = new Error('Session not found');
            error.statusCode = 404;
            throw error;
        }

        const toolId = canonicalizeRemoteToolId(execution?.tool || '');
        if (!toolId) {
            throw new Error('Structured workload execution is missing a tool id');
        }

        const params = execution?.params && typeof execution.params === 'object'
            ? { ...execution.params }
            : {};
        const runtimeToolManager = await ensureRuntimeToolManager(this.app);
        const sessionIsolation = isSessionIsolationEnabled(metadata, resolvedSession);
        const result = await runtimeToolManager.executeTool(toolId, params, {
            sessionId,
            runId: metadata?.agentRunId || null,
            agentRunId: metadata?.agentRunId || null,
            route: '/api/workloads',
            transport: 'worker',
            memoryService: this.memoryService,
            ownerId,
            sessionIsolation,
            workloadService: this.app?.locals?.agentWorkloadService,
            managedAppService: this.app?.locals?.managedAppService || null,
            executionProfile: metadata.executionProfile || null,
            model: String(metadata?.requestedModel || '').trim() || null,
            subAgentDepth: Number(metadata?.subAgentDepth || 0),
        });

        if (result?.success === false) {
            throw new Error(result.error || `Structured execution via ${toolId} failed`);
        }

        const toolEvents = [{
            toolCall: {
                function: {
                    name: toolId,
                    arguments: JSON.stringify(params),
                },
            },
            result,
        }];
        const sshMetadata = extractSshSessionMetadataFromToolEvents(toolEvents);
        if (sshMetadata) {
            await this.sessionStore.update(sessionId, { metadata: sshMetadata });
        }

        const outputText = toolId === 'remote-command' || toolId === 'ssh-execute'
            ? formatSshToolResult(result, {
                host: params.host || '',
                username: params.username || null,
                port: params.port || null,
            })
            : JSON.stringify(result.data || {}, null, 2);
        const memoryMetadata = this.buildMemoryMetadata(ownerId, metadata, resolvedSession);

        if (outputText) {
            if (this.memoryService?.rememberResponse) {
                this.memoryService.rememberResponse(sessionId, outputText, memoryMetadata);
            }
            await this.sessionStore.appendMessages(sessionId, [
                { role: 'assistant', content: outputText },
            ]);
        }

        const artifacts = extractArtifactsFromToolEvents(toolEvents);
        const artifactOutcome = artifacts.length > 0
            ? await this.persistArtifactOutcome({
                sessionId,
                ownerId,
                session: resolvedSession,
                message: metadata.prompt || `Deferred execution via ${toolId}`,
                outputText,
                artifacts,
                outputFormat: artifacts[artifacts.length - 1]?.format || '',
                metadata,
            })
            : { artifacts: [], artifactMessage: '' };

        const updatedProjectSession = await this.updateProjectMemory(sessionId, ownerId, {
            userText: metadata.prompt || `Deferred execution via ${toolId}`,
            assistantText: outputText,
            toolEvents,
            artifacts: artifactOutcome.artifacts,
        });
        if (this.sessionStore?.maybeCompactSession) {
            await this.sessionStore.maybeCompactSession(sessionId, {
                ownerId,
                workflow: null,
                projectMemory: updatedProjectSession?.metadata?.projectMemory || null,
            });
        }

        return {
            result,
            outputText,
            toolEvents,
            artifacts: artifactOutcome.artifacts,
            artifactMessage: artifactOutcome.artifactMessage,
        };
    }

    async appendSyntheticMessage(sessionId, role, content, message = null) {
        if (!sessionId || !content) {
            return;
        }

        const baseMessage = message && typeof message === 'object' && !Array.isArray(message)
            ? message
            : {};
        await this.sessionStore.appendMessages(sessionId, [
            {
                role,
                content,
                ...baseMessage,
            },
        ]);
    }

    async updateProjectMemory(sessionId, ownerId, updates = {}) {
        const session = ownerId
            ? await this.sessionStore.getOwned(sessionId, ownerId)
            : await this.sessionStore.get(sessionId);
        if (!session) {
            return null;
        }

        return this.sessionStore.update(sessionId, {
            metadata: {
                projectMemory: mergeProjectMemory(
                    session?.metadata?.projectMemory || {},
                    buildProjectMemoryUpdate(updates),
                ),
            },
        });
    }

    async maybeGenerateDeferredArtifact({
        runtimeToolManager,
        sessionId,
        ownerId = null,
        session = null,
        message = '',
        mode = 'chat',
        responseId = null,
        outputText = '',
        model = null,
        reasoningEffort = null,
        metadata = {},
    }) {
        if (metadata?.workloadRun !== true || metadata?.agentCompanyRun === true) {
            return {
                artifacts: [],
                artifactMessage: '',
            };
        }

        const outputFormat = String(metadata?.outputFormat || '').trim().toLowerCase()
            || inferRequestedOutputFormat(message);
        if (!outputFormat || !String(outputText || '').trim()) {
            return {
                artifacts: [],
                artifactMessage: '',
            };
        }

        const latestSession = ownerId
            ? await this.sessionStore.getOwned(sessionId, ownerId)
            : await this.sessionStore.get(sessionId);
        const artifactSession = latestSession || session;
        const artifactIds = resolveArtifactContextIds(artifactSession, [], message);
        const preparedImages = await maybePrepareImagesForArtifactPrompt({
            toolManager: runtimeToolManager,
            sessionId,
            route: '/api/workloads',
            transport: 'worker',
            taskType: mode,
            text: message,
            outputFormat,
            artifactIds,
        });
        const artifactGenerationSession = preparedImages.resetPreviousResponse
            ? { ...(artifactSession || {}), previousResponseId: null }
            : artifactSession;
        const generatedArtifacts = await maybeGenerateOutputArtifact({
            sessionId,
            session: artifactGenerationSession,
            mode,
            outputFormat,
            content: outputText,
            prompt: '',
            title: `deferred-${outputFormat}-output`,
            responseId,
            artifactIds: preparedImages.artifactIds,
            model,
            reasoningEffort,
            missionId: metadata.missionId || null,
            parentArtifactId: metadata.parentArtifactId
                || metadata.artifactLineage?.parentArtifactId
                || null,
            provenance: {
                sourceSurface: metadata.clientSurface || 'workload',
                runId: metadata.agentRunId || null,
                sessionId,
            },
        });
        const artifacts = [
            ...(preparedImages.artifacts || []),
            ...(generatedArtifacts || []),
        ].filter((artifact, index, array) => {
            const artifactId = artifact?.id || '';
            return artifactId && array.findIndex((entry) => entry?.id === artifactId) === index;
        });

        if (artifacts.length === 0) {
            return {
                artifacts: [],
                artifactMessage: '',
            };
        }

        return this.persistArtifactOutcome({
            sessionId,
            ownerId,
            session: artifactSession,
            message,
            outputText,
            artifacts,
            outputFormat,
            metadata,
        });
    }
}

module.exports = {
    ConversationRunService,
};
