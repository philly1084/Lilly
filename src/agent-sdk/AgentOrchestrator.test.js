const { AgentOrchestrator } = require('./AgentOrchestrator');
const { ToolDefinition } = require('./tools/ToolDefinition');
const settingsController = require('../routes/admin/settings.controller');
const config = require('../config');

describe('AgentOrchestrator', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('executes a string task input without requiring a vector store', async () => {
        const llmClient = {
            complete: jest.fn().mockResolvedValueOnce('done'),
        };
        const embedder = {
            embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
        };

        const orchestrator = new AgentOrchestrator({
            llmClient,
            embedder,
        });

        const result = await orchestrator.execute('Keep this conversation organized.', {
            sessionId: 'session-1',
        });

        expect(result.success).toBe(true);
        expect(result.output).toBe('done');
        expect(result.sessionId).toBe('session-1');
        expect(result.task.objective).toBe('Keep this conversation organized.');
        expect(result.task.type).toBe('chat');
        expect(result.trace).toEqual(expect.objectContaining({
            taskId: result.task.id,
        }));
    });

    test('routes conversation execution through the orchestrator runtime path', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue({
                id: 'resp_1',
                model: 'gpt-test',
                output: [
                    {
                        type: 'message',
                        content: [{ text: 'Runtime answer' }],
                    },
                ],
            }),
            complete: jest.fn().mockResolvedValue(JSON.stringify({
                complexity: 'low',
                requiredTools: [],
                estimatedSteps: 1,
                challenges: [],
            })),
        };
        const embedder = {
            embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
        };

        const orchestrator = new AgentOrchestrator({
            llmClient,
            embedder,
        });

        const result = await orchestrator.executeConversation({
            sessionId: 'session-2',
            input: 'Keep the same context.',
            recentMessages: [
                { role: 'assistant', content: 'Earlier answer' },
            ],
            instructions: 'Be concise.',
            stream: false,
        });

        expect(result.success).toBe(true);
        expect(result.output).toBe('Runtime answer');
        expect(llmClient.createResponse).toHaveBeenCalledWith(expect.objectContaining({
            input: 'Keep the same context.',
            recentMessages: [
                { role: 'assistant', content: 'Earlier answer' },
            ],
        }));
    });

    test('can execute a planned multi-step conversation with tool usage and synthesis', async () => {
        const llmClient = {
            createResponse: jest.fn(),
            complete: jest.fn()
                .mockResolvedValueOnce(JSON.stringify({
                    steps: [
                        {
                            type: 'tool-call',
                            description: 'Look up the current status',
                            tool: 'lookup-status',
                            params: { target: 'cluster-a' },
                            resultKey: 'status',
                        },
                        {
                            type: 'llm-call',
                            description: 'Write the final answer',
                            params: {
                                prompt: 'User request: {{currentTask.objective}}\nStatus: {{results.status}}\nRespond directly to the user.',
                            },
                            resultKey: 'finalResponse',
                        },
                    ],
                }))
                .mockResolvedValueOnce('Cluster A is healthy.'),
        };
        const embedder = {
            embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
        };

        const orchestrator = new AgentOrchestrator({
            llmClient,
            embedder,
            config: {
                enableConversationAgentExecutor: true,
            },
        });

        orchestrator.registerTool(new ToolDefinition({
            id: 'lookup-status',
            name: 'Lookup Status',
            description: 'Returns cluster status',
            inputSchema: {
                type: 'object',
                required: ['target'],
                properties: {
                    target: { type: 'string' },
                },
            },
            handler: async ({ target }) => ({ target, state: 'healthy' }),
        }));

        const result = await orchestrator.executeConversation({
            sessionId: 'session-agent-1',
            input: 'Is cluster-a healthy?',
            instructions: 'Be concise.',
            stream: false,
            useAgentExecutor: true,
        });

        expect(result.success).toBe(true);
        expect(result.output).toBe('Cluster A is healthy.');
        expect(llmClient.createResponse).not.toHaveBeenCalled();
        expect(llmClient.complete).toHaveBeenCalledTimes(2);
        expect(llmClient.complete.mock.calls[1][0]).toContain('User request: Is cluster-a healthy?');
        expect(llmClient.complete.mock.calls[1][0]).toContain('"target": "cluster-a"');
        expect(llmClient.complete.mock.calls[1][0]).toContain('"state": "healthy"');
        expect(result.response.metadata.agentExecutor).toBe(true);
        expect(result.response.metadata.toolEvents).toEqual(expect.arrayContaining([
            expect.objectContaining({
                toolCall: expect.objectContaining({
                    function: expect.objectContaining({
                        name: 'lookup-status',
                    }),
                }),
            }),
        ]));
    });

    test('builds tool events from nested execution trace steps', () => {
        const orchestrator = new AgentOrchestrator({
            llmClient: {
                complete: jest.fn(),
            },
            embedder: {
                embed: jest.fn(),
            },
        });

        const toolEvents = orchestrator.buildToolEventsFromTrace({
            steps: [
                {
                    id: 'plan-step',
                    type: 'plan',
                    substeps: [
                        {
                            id: 'nested-tool-step',
                            type: 'tool-call',
                            input: {
                                tool: 'web-fetch',
                                params: {
                                    url: 'https://example.com',
                                },
                            },
                            output: {
                                status: 200,
                            },
                            substeps: [],
                        },
                    ],
                },
            ],
        });

        expect(toolEvents).toEqual([
            expect.objectContaining({
                toolCall: expect.objectContaining({
                    id: 'nested-tool-step',
                    function: expect.objectContaining({
                        name: 'web-fetch',
                        arguments: JSON.stringify({ url: 'https://example.com' }),
                    }),
                }),
                result: expect.objectContaining({
                    success: true,
                    toolId: 'web-fetch',
                    data: {
                        status: 200,
                    },
                }),
            }),
        ]);
    });

    test('normalizes snake_case tool events from runtime responses', () => {
        const orchestrator = new AgentOrchestrator({
            llmClient: {
                complete: jest.fn(),
            },
            embedder: {
                embed: jest.fn(),
            },
        });
        const toolEvents = [{
            toolCall: {
                id: 'call_remote_1',
                function: {
                    name: 'remote-command',
                    arguments: '{"command":"kubectl get pods"}',
                },
            },
            result: {
                success: true,
                data: { stdout: 'pod/example Running' },
            },
        }];

        expect(orchestrator.extractToolEvents({
            metadata: {
                tool_events: toolEvents,
            },
        })).toBe(toolEvents);
        expect(orchestrator.extractToolEvents({
            tool_events: toolEvents,
        })).toBe(toolEvents);
    });

    test('ignores conversation agent executor unless it is explicitly enabled in config', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue({
                id: 'resp_runtime_only',
                model: 'gpt-test',
                output: [
                    {
                        type: 'message',
                        content: [{ text: 'Runtime path answer' }],
                    },
                ],
            }),
            complete: jest.fn(),
        };
        const embedder = {
            embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
        };

        const orchestrator = new AgentOrchestrator({
            llmClient,
            embedder,
        });

        const result = await orchestrator.executeConversation({
            sessionId: 'session-runtime-default',
            input: 'Answer directly.',
            stream: false,
            useAgentExecutor: true,
        });

        expect(result.success).toBe(true);
        expect(result.output).toBe('Runtime path answer');
        expect(llmClient.createResponse).toHaveBeenCalledTimes(1);
        expect(llmClient.complete).not.toHaveBeenCalled();
    });

    test('stores skill context in working memory for conversation execution', () => {
        const llmClient = {
            complete: jest.fn(),
        };
        const embedder = {
            embed: jest.fn(),
        };

        const orchestrator = new AgentOrchestrator({
            llmClient,
            embedder,
        });

        const workingMemory = orchestrator.getWorkingMemory('session-skill-context');

        orchestrator.seedConversationExecutionContext(workingMemory, {
            instructions: 'Be concise.',
            input: 'Check the cluster.',
            skillContext: 'Use kubectl describe before kubectl logs for CrashLoopBackOff triage.',
        });

        expect(workingMemory.get('skillContext')).toBe('Use kubectl describe before kubectl logs for CrashLoopBackOff triage.');
    });

    test('conversation tool selection exposes sandbox unconditionally without requiring regex match', () => {
        jest.spyOn(settingsController, 'getEffectiveSshConfig').mockReturnValue({
            enabled: false,
            host: '',
            port: 22,
            username: '',
            password: '',
            privateKeyPath: '',
        });

        const llmClient = {
            complete: jest.fn(),
        };
        const embedder = {
            embed: jest.fn(),
        };

        const orchestrator = new AgentOrchestrator({
            llmClient,
            embedder,
        });

        orchestrator.registerTool(new ToolDefinition({
            id: 'web-search',
            name: 'Web Search',
            description: 'Search the web',
            handler: async () => ({}),
        }));
        orchestrator.registerTool(new ToolDefinition({
            id: 'code-sandbox',
            name: 'Code Sandbox',
            description: 'Run code in a sandbox',
            handler: async () => ({}),
        }));
        orchestrator.registerTool(new ToolDefinition({
            id: 'docker-exec',
            name: 'Docker Exec',
            description: 'Run commands in a container',
            handler: async () => ({}),
        }));
        orchestrator.registerTool(new ToolDefinition({
            id: 'ssh-execute',
            name: 'SSH Execute',
            description: 'Run commands over SSH',
            handler: async () => ({}),
        }));
        orchestrator.registerTool(new ToolDefinition({
            id: 'remote-command',
            name: 'Remote Command',
            description: 'Run commands through the remote CLI lane',
            handler: async () => ({}),
        }));

        const toolIds = orchestrator.getConversationToolIds('Inspect the Traefik resources for this cluster.', 'Use the current setup.');

        expect(toolIds).toContain('web-search');
        expect(toolIds).toContain('code-sandbox');
        expect(toolIds).toContain('ssh-execute');
        expect(toolIds).not.toContain('docker-exec');
        expect(toolIds).not.toContain('remote-command'); // Remote CLI requires valid config
    });

    test('remote build profile narrows the available tool set and enables remote CLI only with usable config', () => {
        jest.spyOn(settingsController, 'getEffectiveSshConfig').mockReturnValue({
            enabled: true,
            host: '10.0.0.5',
            port: 22,
            username: 'ubuntu',
            password: 'secret',
            privateKeyPath: '',
        });

        const llmClient = {
            complete: jest.fn(),
        };
        const embedder = {
            embed: jest.fn(),
        };

        const orchestrator = new AgentOrchestrator({
            llmClient,
            embedder,
        });

        orchestrator.registerTool(new ToolDefinition({
            id: 'web-search',
            name: 'Web Search',
            description: 'Search the web',
            handler: async () => ({}),
        }));
        orchestrator.registerTool(new ToolDefinition({
            id: 'code-sandbox',
            name: 'Code Sandbox',
            description: 'Run code in a sandbox',
            handler: async () => ({}),
        }));
        orchestrator.registerTool(new ToolDefinition({
            id: 'docker-exec',
            name: 'Docker Exec',
            description: 'Run commands in a container',
            handler: async () => ({}),
        }));
        orchestrator.registerTool(new ToolDefinition({
            id: 'ssh-execute',
            name: 'SSH Execute',
            description: 'Run commands over SSH',
            handler: async () => ({}),
        }));
        orchestrator.registerTool(new ToolDefinition({
            id: 'remote-command',
            name: 'Remote Command',
            description: 'Run commands through the remote CLI lane',
            handler: async () => ({}),
        }));
        orchestrator.registerTool(new ToolDefinition({
            id: 'remote-workbench',
            name: 'Remote Workbench',
            description: 'Run structured remote repo, file, build, and deploy actions',
            handler: async () => ({}),
        }));
        orchestrator.registerTool(new ToolDefinition({
            id: 'architecture-design',
            name: 'Architecture Design',
            description: 'Generate design docs',
            handler: async () => ({}),
        }));

        const toolIds = orchestrator.getConversationToolIds(
            'Deploy the latest build to the remote host.',
            'Use the current server setup.',
            { executionProfile: 'remote-build' },
        );

        expect(toolIds).toContain('remote-command');
        expect(toolIds).toContain('remote-workbench');
        expect(toolIds).not.toContain('ssh-execute');
        expect(toolIds).not.toContain('docker-exec');
        expect(toolIds).toContain('web-search');
        expect(toolIds).not.toContain('architecture-design');
    });

    test('persists transcript and tool results through orchestrator-owned services', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue({
                id: 'resp_2',
                model: 'gpt-test',
                output: [
                    {
                        type: 'message',
                        content: [{ text: 'Here is the result.' }],
                    },
                ],
                metadata: {
                    toolEvents: [
                        {
                            toolCall: {
                                id: 'call_1',
                                function: {
                                    name: 'web-search',
                                    arguments: '{"query":"latest update"}',
                                },
                            },
                            result: {
                                success: true,
                                toolId: 'web-search',
                                data: { results: ['a', 'b'] },
                            },
                        },
                    ],
                },
            }),
            complete: jest.fn().mockResolvedValue(JSON.stringify({
                complexity: 'low',
                requiredTools: [],
                estimatedSteps: 1,
                challenges: [],
            })),
        };
        const embedder = {
            embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
        };
        const sessionStore = {
            getRecentMessages: jest.fn().mockResolvedValue([
                { role: 'assistant', content: 'Previous turn' },
            ]),
            recordResponse: jest.fn().mockResolvedValue(undefined),
            appendMessages: jest.fn().mockResolvedValue(undefined),
        };
        const memoryService = {
            recall: jest.fn().mockResolvedValue([
                '[Past assistant message] Earlier context',
            ]),
            rememberResponse: jest.fn().mockResolvedValue(undefined),
            remember: jest.fn().mockResolvedValue(undefined),
        };

        const orchestrator = new AgentOrchestrator({
            llmClient,
            embedder,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            sessionId: 'session-3',
            input: 'Search for the latest update.',
            stream: false,
        });

        expect(result.success).toBe(true);
        expect(memoryService.recall).toHaveBeenCalledWith('Search for the latest update.', expect.objectContaining({
            sessionId: 'session-3',
            ownerId: null,
            profile: 'research',
        }));
        expect(sessionStore.getRecentMessages).toHaveBeenCalledWith('session-3', config.memory.recentTranscriptLimit);
        expect(sessionStore.recordResponse).toHaveBeenCalledWith('session-3', 'resp_2');
        expect(sessionStore.appendMessages).toHaveBeenCalledWith('session-3', expect.arrayContaining([
            expect.objectContaining({ role: 'user', content: 'Search for the latest update.' }),
            expect.objectContaining({ role: 'tool' }),
            expect.objectContaining({ role: 'assistant', content: 'Here is the result.' }),
        ]));
        expect(memoryService.rememberResponse).toHaveBeenCalledWith('session-3', 'Here is the result.', {
            memoryScope: 'chat',
        });
        expect(memoryService.remember).toHaveBeenCalledWith(
            'session-3',
            'Search for the latest update.',
            'user',
            { memoryScope: 'chat' },
        );
        expect(memoryService.remember).toHaveBeenCalledWith(
            'session-3',
            expect.stringContaining('"tool":"web-search"'),
            'tool',
            { memoryScope: 'chat' },
        );
    });

    test('degrades gracefully when memory and session persistence fail', async () => {
        const llmClient = {
            createResponse: jest.fn().mockResolvedValue({
                id: 'resp_3',
                model: 'gpt-test',
                output: [
                    {
                        type: 'message',
                        content: [{ text: 'Still answered.' }],
                    },
                ],
            }),
            complete: jest.fn().mockResolvedValue(JSON.stringify({
                complexity: 'low',
                requiredTools: [],
                estimatedSteps: 1,
                challenges: [],
            })),
        };
        const embedder = {
            embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
        };
        const sessionStore = {
            getRecentMessages: jest.fn().mockRejectedValue(new Error('session offline')),
            recordResponse: jest.fn().mockRejectedValue(new Error('write failed')),
            appendMessages: jest.fn().mockRejectedValue(new Error('append failed')),
        };
        const memoryService = {
            recall: jest.fn().mockRejectedValue(new Error('qdrant offline')),
            rememberResponse: jest.fn().mockRejectedValue(new Error('remember response failed')),
            remember: jest.fn().mockRejectedValue(new Error('remember failed')),
        };

        const orchestrator = new AgentOrchestrator({
            llmClient,
            embedder,
            sessionStore,
            memoryService,
        });

        const result = await orchestrator.executeConversation({
            sessionId: 'session-4',
            input: 'Can you still answer?',
            stream: false,
        });

        expect(result.success).toBe(true);
        expect(result.output).toBe('Still answered.');
        expect(llmClient.createResponse).toHaveBeenCalledWith(expect.objectContaining({
            contextMessages: [],
            recentMessages: [],
        }));
    });

    test('normalizes legacy completion conditions to schema-valid values', () => {
        const llmClient = {
            complete: jest.fn(),
        };
        const embedder = {
            embed: jest.fn(),
        };

        const orchestrator = new AgentOrchestrator({
            llmClient,
            embedder,
        });

        const normalized = orchestrator.normalizeTaskInput({
            type: 'chat',
            objective: 'Keep talking coherently.',
            input: {
                content: 'Keep talking coherently.',
                format: 'text',
            },
            completionCriteria: {
                conditions: ['output-not-empty', 'no-errors', 'response-delivered'],
            },
        }, 'session-5');

        expect(normalized.completionCriteria.conditions).toEqual([
            { type: 'output-present' },
            { type: 'custom-check', check: 'no-errors', expected: true },
            { type: 'output-present' },
        ]);
    });

    test('keeps non-uuid runtime session IDs out of schema-validated task context', () => {
        const llmClient = {
            complete: jest.fn(),
        };
        const embedder = {
            embed: jest.fn(),
        };

        const orchestrator = new AgentOrchestrator({
            llmClient,
            embedder,
        });

        const normalized = orchestrator.normalizeTaskInput({
            type: 'chat',
            objective: 'Continue the session.',
            input: {
                content: 'Continue the session.',
                format: 'text',
            },
        }, 'web-cli-session');

        expect(normalized.context.sessionId).toBeUndefined();
        expect(normalized.context.metadata.runtimeSessionId).toBe('web-cli-session');
    });
});
