jest.mock('./session-store', () => ({
    sessionStore: {
        getRecentMessages: jest.fn(),
    },
}));

jest.mock('./memory/memory-service', () => ({
    memoryService: {
        process: jest.fn(),
    },
}));

jest.mock('./openai-client', () => ({
    createResponse: jest.fn(),
}));

const { sessionStore } = require('./session-store');
const { memoryService } = require('./memory/memory-service');
const { createResponse } = require('./openai-client');
const {
    executeConversationRuntime,
    resolveConversationExecutorFlag,
    inferExecutionProfile,
} = require('./runtime-execution');

describe('runtime-execution', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sessionStore.getRecentMessages.mockResolvedValue([
            { role: 'assistant', content: 'Earlier reply' },
        ]);
        memoryService.process.mockResolvedValue(['Remembered context']);
        createResponse.mockResolvedValue({ id: 'resp_direct' });
    });

    test('uses the conversation orchestrator by default when it is available', async () => {
        const executeConversation = jest.fn().mockResolvedValue({
            success: true,
            response: { id: 'resp_executor' },
        });
        const documentService = { id: 'documents' };
        const managedAppService = { id: 'managed-apps' };
        const workloadService = { id: 'workloads' };

        const result = await executeConversationRuntime({
            locals: {
                documentService,
                managedAppService,
                agentWorkloadService: workloadService,
                conversationOrchestrator: {
                    executeConversation,
                },
            },
        }, {
            sessionId: 'session-1',
            input: 'Answer directly.',
            memoryInput: 'Answer directly.',
        });

        expect(executeConversation).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            input: 'Answer directly.',
            executionProfile: 'default',
            toolContext: expect.objectContaining({
                documentService,
                managedAppService,
                workloadService,
            }),
        }));
        expect(createResponse).not.toHaveBeenCalled();
        expect(result.handledPersistence).toBe(true);
        expect(result.runtimeMode).toBe('orchestrated');
    });

    test('passes explicit executor flags through to the orchestrator without needing a separate runtime mode', async () => {
        const executeConversation = jest.fn().mockResolvedValue({
            success: true,
            response: { id: 'resp_executor' },
        });

        const result = await executeConversationRuntime({
            locals: {
                conversationOrchestrator: {
                    executeConversation,
                },
            },
        }, {
            sessionId: 'session-2',
            input: 'Use the executor.',
            enableConversationExecutor: true,
            taskType: 'chat',
        });

        expect(executeConversation).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-2',
            input: 'Use the executor.',
            enableConversationExecutor: true,
            taskType: 'chat',
        }));
        expect(createResponse).not.toHaveBeenCalled();
        expect(result.handledPersistence).toBe(true);
        expect(result.runtimeMode).toBe('orchestrated');
    });

    test('routes remote build requests to the executor even without the explicit flag', async () => {
        const executeConversation = jest.fn().mockResolvedValue({
            success: true,
            response: { id: 'resp_executor_remote' },
        });

        const result = await executeConversationRuntime({
            locals: {
                conversationOrchestrator: {
                    executeConversation,
                },
            },
        }, {
            sessionId: 'session-remote-1',
            input: 'SSH into the remote server and deploy the latest build.',
            taskType: 'chat',
        });

        expect(executeConversation).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-remote-1',
            executionProfile: 'remote-build',
        }));
        expect(createResponse).not.toHaveBeenCalled();
        expect(result.runtimeMode).toBe('orchestrated');
    });

    test('falls back to agentOrchestrator only when conversationOrchestrator is unavailable', async () => {
        const executeConversation = jest.fn().mockResolvedValue({
            success: true,
            response: { id: 'resp_agent_fallback' },
        });

        const result = await executeConversationRuntime({
            locals: {
                agentOrchestrator: {
                    executeConversation,
                },
            },
        }, {
            sessionId: 'session-agent-fallback',
            input: 'Fallback to the legacy executor.',
        });

        expect(executeConversation).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-agent-fallback',
            executionProfile: 'default',
        }));
        expect(createResponse).not.toHaveBeenCalled();
        expect(result.runtimeMode).toBe('orchestrated');
    });

    test('falls back to direct runtime if the executor is requested but unavailable', async () => {
        const result = await executeConversationRuntime({
            locals: {},
        }, {
            sessionId: 'session-3',
            input: 'Fallback cleanly.',
            enableConversationExecutor: true,
            reasoningEffort: 'high',
            memoryInput: 'Fallback cleanly.',
        });

        expect(createResponse).toHaveBeenCalledTimes(1);
        expect(createResponse).toHaveBeenCalledWith(expect.objectContaining({
            reasoningEffort: 'high',
        }));
        expect(result.handledPersistence).toBe(false);
        expect(result.runtimeMode).toBe('direct');
    });

    test('expands referential follow-ups against recent transcript before memory recall in direct mode', async () => {
        sessionStore.getRecentMessages.mockResolvedValue([
            { role: 'user', content: 'Research Halifax vacation pricing for a presentation.' },
            { role: 'assistant', content: 'I can do that.' },
        ]);

        await executeConversationRuntime({
            locals: {},
        }, {
            sessionId: 'session-5',
            input: 'yes do deep research on that',
            memoryInput: 'yes do deep research on that',
        });

        expect(memoryService.process).toHaveBeenCalledWith(
            'session-5',
            'yes do deep research on that',
            expect.objectContaining({
                recallQuery: 'Research Halifax vacation pricing for a presentation. yes do deep research on that',
                objective: 'Research Halifax vacation pricing for a presentation. yes do deep research on that',
                recentMessages: [
                    { role: 'user', content: 'Research Halifax vacation pricing for a presentation.' },
                    { role: 'assistant', content: 'I can do that.' },
                ],
            }),
        );
    });

    test('passes prior prompt state from the session into direct runtime responses', async () => {
        await executeConversationRuntime({
            locals: {},
        }, {
            sessionId: 'session-4',
            input: 'Continue.',
            memoryInput: 'Continue.',
            session: {
                metadata: {
                    promptState: {
                        instructionsFingerprint: 'abc123',
                    },
                },
            },
        });

        expect(createResponse).toHaveBeenCalledWith(expect.objectContaining({
            previousPromptState: {
                instructionsFingerprint: 'abc123',
            },
        }));
    });

    test('accepts legacy and compatibility executor flags', () => {
        expect(resolveConversationExecutorFlag({ useAgentExecutor: true })).toBe(true);
        expect(resolveConversationExecutorFlag({ use_agent_executor: true })).toBe(true);
        expect(resolveConversationExecutorFlag({ enable_conversation_executor: true })).toBe(true);
        expect(resolveConversationExecutorFlag({})).toBe(false);
    });

    test('infers the remote build execution profile from explicit routing or remote-ops prompts', () => {
        expect(inferExecutionProfile({ executionProfile: 'remote-builder' })).toBe('remote-build');
        expect(inferExecutionProfile({ input: 'Use kubectl to inspect the cluster and restart the deployment.' })).toBe('remote-build');
        expect(inferExecutionProfile({ input: 'Run a remote command on root@77.42.44.98 to check its health.' })).toBe('remote-build');
        expect(inferExecutionProfile({ input: 'Use remote CLI into root@77.42.44.98 to check its health.' })).toBe('remote-build');
        expect(inferExecutionProfile({ input: 'Use this server as the sandbox and build environment to create and develop the web app through Gitea.' })).toBe('remote-build');
        expect(inferExecutionProfile({ input: 'what address did you deploy too?. it did not work on either. try again' })).toBe('remote-build');
        expect(inferExecutionProfile({ input: 'Answer directly.' })).toBe('default');
    });

    test('keeps notes-surface requests on the notes execution profile even when the prompt mentions remote operations', () => {
        expect(inferExecutionProfile({
            taskType: 'notes',
            input: 'Can you reach the remote build now?',
        })).toBe('notes');
        expect(inferExecutionProfile({
            taskType: 'notes',
            executionProfile: 'remote-build',
            input: 'Use kubectl to inspect the cluster.',
        })).toBe('notes');
    });

    test('keeps podcast surfaces out of remote-build even with sticky remote session state', () => {
        const remoteSession = {
            metadata: {
                lastToolIntent: 'remote-command',
                lastSshTarget: {
                    host: '162.55.163.199',
                },
            },
        };

        expect(inferExecutionProfile({
            taskType: 'podcast',
            input: 'Research battery storage and make a podcast.',
            session: remoteSession,
        })).toBe('podcast');

        expect(inferExecutionProfile({
            taskType: 'podcast-video',
            input: 'Research battery storage and make a video podcast.',
            session: remoteSession,
        })).toBe('podcast-video');

        expect(inferExecutionProfile({
            executionProfile: 'podcast-video',
            input: 'Research battery storage and make a video podcast.',
            session: remoteSession,
        })).toBe('podcast-video');
    });

    test('uses the latest user turn instead of stale remote transcript content when inferring execution profile', () => {
        expect(inferExecutionProfile({
            input: [
                { role: 'user', content: 'SSH into the remote server and check kubectl.' },
                { role: 'assistant', content: 'I can inspect the cluster over SSH.' },
                { role: 'user', content: 'Create a React component for a todo list.' },
            ],
        })).toBe('default');
    });

    test('keeps sticky remote sessions in remote-build mode for deployment-style follow-ups without explicit ssh keywords', () => {
        expect(inferExecutionProfile({
            input: 'replace the current html with the tic tac toe game and get it live on game.demoserver2.buzz',
            session: {
                metadata: {
                    lastToolIntent: 'remote-command',
                    lastSshTarget: {
                        host: '162.55.163.199',
                    },
                },
            },
        })).toBe('remote-build');
    });

    test('keeps active deploy workflows in remote-build mode for yes-style continuation replies', () => {
        expect(inferExecutionProfile({
            input: 'Yes. We can continue the penguin research paper deployment for penguin.demoserver2.buzz.',
            session: {
                metadata: {
                    controlState: {
                        workflow: {
                            kind: 'end-to-end-builder',
                            lane: 'deploy-only',
                            status: 'active',
                            stage: 'deploying',
                            objective: 'Deploy the penguin research paper site to penguin.demoserver2.buzz and verify TLS.',
                        },
                        activeTaskFrame: {
                            objective: 'Deploy the penguin research paper site to penguin.demoserver2.buzz and verify TLS.',
                        },
                        foregroundContinuationGate: {
                            paused: true,
                        },
                        lastRemoteObjective: 'Deploy the penguin research paper site to penguin.demoserver2.buzz and verify TLS.',
                    },
                },
            },
        })).toBe('remote-build');
    });

    test('keeps active remote workflows in remote-build mode for status and blocker follow-ups', () => {
        const session = {
            metadata: {
                controlState: {
                    workflow: {
                        kind: 'end-to-end-builder',
                        lane: 'deploy-only',
                        status: 'active',
                        stage: 'verifying',
                        objective: 'Deploy the penguin research paper site to penguin.demoserver2.buzz and verify ingress, DNS, and HTTPS.',
                    },
                    activeTaskFrame: {
                        objective: 'Deploy the penguin research paper site to penguin.demoserver2.buzz and verify ingress, DNS, and HTTPS.',
                    },
                    lastRemoteObjective: 'Deploy the penguin research paper site to penguin.demoserver2.buzz and verify ingress, DNS, and HTTPS.',
                },
            },
        };

        expect(inferExecutionProfile({
            input: 'What is the current deployment status?',
            session,
        })).toBe('remote-build');

        expect(inferExecutionProfile({
            input: 'What is the current blocker?',
            session,
        })).toBe('remote-build');

        expect(inferExecutionProfile({
            input: 'Why is it failing?',
            session,
        })).toBe('remote-build');
    });

    test('routes status-style follow-ups for active remote workflows through the executor in remote-build mode', async () => {
        const executeConversation = jest.fn().mockResolvedValue({
            success: true,
            response: { id: 'resp_executor_remote_status' },
        });

        const result = await executeConversationRuntime({
            locals: {
                conversationOrchestrator: {
                    executeConversation,
                },
            },
        }, {
            sessionId: 'session-remote-status',
            input: 'What is the current deployment status?',
            taskType: 'chat',
            session: {
                metadata: {
                    controlState: {
                        workflow: {
                            kind: 'end-to-end-builder',
                            lane: 'deploy-only',
                            status: 'active',
                            stage: 'verifying',
                            objective: 'Deploy the penguin research paper site to penguin.demoserver2.buzz and verify ingress, DNS, and HTTPS.',
                        },
                        activeTaskFrame: {
                            objective: 'Deploy the penguin research paper site to penguin.demoserver2.buzz and verify ingress, DNS, and HTTPS.',
                        },
                        lastRemoteObjective: 'Deploy the penguin research paper site to penguin.demoserver2.buzz and verify ingress, DNS, and HTTPS.',
                    },
                },
            },
        });

        expect(executeConversation).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-remote-status',
            executionProfile: 'remote-build',
        }));
        expect(createResponse).not.toHaveBeenCalled();
        expect(result.runtimeMode).toBe('orchestrated');
    });

    test('does not force generic local content creation into remote-build just because a remote session exists', () => {
        expect(inferExecutionProfile({
            input: 'Make me a page about dolphins.',
            session: {
                metadata: {
                    lastToolIntent: 'remote-command',
                    lastSshTarget: {
                        host: '162.55.163.199',
                    },
                },
            },
        })).toBe('default');
    });
});
