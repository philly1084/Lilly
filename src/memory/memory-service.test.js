const {
    MemoryService,
    DEFAULT_RECALL_PROFILE,
    RESEARCH_RECALL_PROFILE,
} = require('./memory-service');
const {
    PROJECT_SHARED_MEMORY_NAMESPACE,
    SESSION_LOCAL_MEMORY_NAMESPACE,
    SURFACE_LOCAL_MEMORY_NAMESPACE,
    USER_GLOBAL_MEMORY_NAMESPACE,
} = require('../session-scope');
const config = require('../config');

describe('MemoryService recall profiles', () => {
    beforeEach(() => {
        config.config.runtime.judgmentV2Enabled = false;
    });

    test.each([
        ['fact', 0.6],
        ['artifact', 0.8],
        ['skill', 0.9],
    ])('uses the %s importance default when no numeric priority is supplied', (memoryType, expected) => {
        const service = new MemoryService();
        for (const importance of [undefined, null, '', '   ', false, true, [], [0], {}]) {
            expect(service.normalizeMetadata('user', 'Project context', {
                memoryType,
                importance,
            }).importance).toBe(expected);
        }
    });

    test.each([
        [0, 0], ['0', 0], [0.4, 0.4], [' 0.7 ', 0.7], [-1, 0], [2, 1],
        [NaN, 0.6], [Infinity, 0.6], ['unknown', 0.6],
    ])('preserves numeric importance and bounds for %p', (importance, expected) => {
        const service = new MemoryService();
        expect(service.normalizeMetadata('user', 'Project context', { importance }).importance).toBe(expected);
    });

    test('persists default priorities for new facts and generated artifact memories', async () => {
        const service = new MemoryService();
        service.store = { store: jest.fn().mockResolvedValue('point-1') };

        await service.remember('session-1', 'I prefer concise answers.');
        await service.rememberArtifactResult('session-1', {
            artifact: { id: 'artifact-1', filename: 'brief.md', format: 'markdown' },
            summary: 'A completed project brief.',
            sourceText: '# Project brief\nKeep the experience easy to use.',
        });

        expect(service.store.store.mock.calls.map((call) => call[2].importance)).toEqual([0.6, 0.8, 0.8]);
    });

    test('ranks memories without importance like default facts while respecting explicit zero', () => {
        const service = new MemoryService();
        const entry = { text: 'Project context', semanticScore: 0.75 };
        const defaultScore = service.scoreRecallEntry({ ...entry, metadata: { importance: 0.6 } });
        expect(service.scoreRecallEntry(entry)).toBe(defaultScore);
        expect(service.scoreRecallEntry({ ...entry, metadata: { importance: null } })).toBe(defaultScore);
        expect(service.scoreRecallEntry({ ...entry, metadata: { importance: 0 } })).toBeLessThan(defaultScore);
    });

    test('uses wider recall for normal conversations by default', () => {
        const service = new MemoryService();

        expect(service.getRecallOptions({
            profile: DEFAULT_RECALL_PROFILE,
        })).toEqual({
            topK: 12,
            scoreThreshold: 0.7,
        });
    });

    test('uses looser recall settings for research mode', () => {
        const service = new MemoryService();

        expect(service.getRecallOptions({
            profile: RESEARCH_RECALL_PROFILE,
        })).toEqual({
            topK: 16,
            scoreThreshold: 0.64,
        });
    });

    test('process forwards memory scope to persistence and recall', async () => {
        const service = new MemoryService();
        const rememberSpy = jest.spyOn(service, 'remember').mockResolvedValue('point-1');
        const recallSpy = jest.spyOn(service, 'recall').mockResolvedValue(['ctx']);

        const context = await service.process('session-1', 'hello world', {
            ownerId: 'phill',
            memoryScope: 'web-chat',
            profile: DEFAULT_RECALL_PROFILE,
        });

        expect(context).toEqual(['ctx']);
        expect(rememberSpy).toHaveBeenCalledWith('session-1', 'hello world', 'user', {
            ownerId: 'phill',
            memoryScope: 'web-chat',
            clientSurface: 'web-chat',
            memoryClass: 'conversation',
            memoryNamespace: 'session_local',
            shareAcrossSurfaces: false,
            sessionIsolation: true,
            sourceSurface: 'web-chat',
        });
        expect(recallSpy).toHaveBeenCalledWith('hello world', expect.objectContaining({
            sessionId: 'session-1',
            ownerId: null,
            memoryScope: 'web-chat',
            sessionIsolation: true,
            profile: DEFAULT_RECALL_PROFILE,
        }));
    });

    test('process keeps recall locked to the current session when session isolation is enabled', async () => {
        const service = new MemoryService();
        const recallSpy = jest.spyOn(service, 'recall').mockResolvedValue(['ctx']);
        jest.spyOn(service, 'remember').mockResolvedValue('point-1');

        const context = await service.process('session-1', 'hello world', {
            ownerId: 'phill',
            memoryScope: 'web-chat',
            sessionIsolation: true,
            profile: DEFAULT_RECALL_PROFILE,
        });

        expect(context).toEqual(['ctx']);
        expect(recallSpy).toHaveBeenCalledWith('hello world', expect.objectContaining({
            sessionId: 'session-1',
            ownerId: null,
            memoryScope: 'web-chat',
            sessionIsolation: true,
            profile: DEFAULT_RECALL_PROFILE,
        }));
    });

    test('process keeps web-chat workspace recall locked to the current session even if isolation is false', async () => {
        const service = new MemoryService();
        const recallSpy = jest.spyOn(service, 'recall').mockResolvedValue(['ctx']);
        const rememberSpy = jest.spyOn(service, 'remember').mockResolvedValue('point-1');

        await service.process('session-1', 'workspace follow-up', {
            ownerId: 'phill',
            memoryScope: 'web-chat-workspace-2',
            sourceSurface: 'web-chat',
            clientSurface: 'web-chat',
            sessionIsolation: false,
            profile: DEFAULT_RECALL_PROFILE,
        });

        expect(rememberSpy).toHaveBeenCalledWith('session-1', 'workspace follow-up', 'user', expect.objectContaining({
            memoryNamespace: SESSION_LOCAL_MEMORY_NAMESPACE,
            sessionIsolation: true,
        }));
        expect(recallSpy).toHaveBeenCalledWith('workspace follow-up', expect.objectContaining({
            sessionId: 'session-1',
            ownerId: null,
            memoryScope: 'web-chat-workspace-2',
            sessionIsolation: true,
        }));
    });

    test('recall keeps keyword matches isolated to the current frontend scope', async () => {
        const service = new MemoryService();
        jest.spyOn(service.store, 'search').mockResolvedValue([]);
        jest.spyOn(service.store, 'scroll').mockResolvedValue([
            {
                id: 'artifact-web-chat',
                payload: {
                    sessionId: 'session-1',
                    ownerId: 'phill',
                    memoryScope: 'web-chat',
                    memoryNamespace: 'session_local',
                    text: 'Previous HTML artifact for the chat frontend',
                    keywords: ['html', 'landing-page'],
                    memoryType: 'artifact',
                    artifactFilename: 'chat-landing.html',
                    artifactFormat: 'html',
                    timestamp: '2026-04-05T10:00:00.000Z',
                },
            },
            {
                id: 'artifact-canvas',
                payload: {
                    sessionId: 'session-2',
                    ownerId: 'phill',
                    memoryScope: 'canvas',
                    memoryNamespace: 'session_local',
                    text: 'Canvas-only HTML artifact memory',
                    keywords: ['html', 'landing-page'],
                    memoryType: 'artifact',
                    artifactFilename: 'canvas-landing.html',
                    artifactFormat: 'html',
                    timestamp: '2026-04-05T10:00:00.000Z',
                },
            },
        ]);

        const recall = await service.recall('revise the html landing page', {
            sessionId: 'session-1',
            ownerId: 'phill',
            memoryScope: 'web-chat',
            memoryKeywords: ['html', 'landing-page'],
            returnDetails: true,
        });

        expect(recall.contextMessages).toHaveLength(1);
        expect(recall.contextMessages[0]).toContain('chat-landing.html');
        expect(recall.contextMessages[0]).not.toContain('canvas-landing.html');
        expect(service.store.scroll).toHaveBeenCalledWith(service.store.collection, expect.objectContaining({
            filter: {
                must: expect.arrayContaining([
                    { key: 'sessionId', match: { value: 'session-1' } },
                    { key: 'memoryNamespace', match: { value: SESSION_LOCAL_MEMORY_NAMESPACE } },
                ]),
            },
        }));
    });

    test('does not recall another project for the same owner', async () => {
        const service = new MemoryService();
        jest.spyOn(service.store, 'search').mockResolvedValue([
            {
                id: 'artifact-alpha',
                score: 0.86,
                text: 'Artifact for the Alpha storefront.',
                sessionId: 'session-alpha',
                timestamp: '2026-04-08T10:00:00.000Z',
                metadata: {
                    ownerId: 'phill',
                    memoryScope: 'alpha-store',
                    projectKey: 'alpha-store',
                    memoryNamespace: PROJECT_SHARED_MEMORY_NAMESPACE,
                    memoryClass: 'artifact',
                    sourceSurface: 'web-chat',
                    memoryType: 'artifact',
                    artifactFilename: 'alpha-storefront.html',
                    artifactFormat: 'html',
                    keywords: ['storefront', 'landing-page'],
                },
            },
            {
                id: 'artifact-beta',
                score: 0.91,
                text: 'Artifact for the Beta storefront.',
                sessionId: 'session-beta',
                timestamp: '2026-04-08T10:00:00.000Z',
                metadata: {
                    ownerId: 'phill',
                    memoryScope: 'beta-store',
                    projectKey: 'beta-store',
                    memoryNamespace: PROJECT_SHARED_MEMORY_NAMESPACE,
                    memoryClass: 'artifact',
                    sourceSurface: 'web-chat',
                    memoryType: 'artifact',
                    artifactFilename: 'beta-storefront.html',
                    artifactFormat: 'html',
                    keywords: ['storefront', 'landing-page'],
                },
            },
        ]);
        jest.spyOn(service.store, 'scroll').mockResolvedValue([]);

        const recall = await service.recall('revise the storefront landing page', {
            ownerId: 'phill',
            memoryScope: 'alpha-store',
            projectKey: 'alpha-store',
            sourceSurface: 'web-chat',
            returnDetails: true,
        });

        expect(recall.contextMessages).toHaveLength(1);
        expect(recall.contextMessages[0]).toContain('alpha-storefront.html');
        expect(recall.contextMessages[0]).not.toContain('beta-storefront.html');
        expect(recall.trace.selected).toHaveLength(1);
        expect(recall.trace.selected[0]).toEqual(expect.objectContaining({
            projectKey: 'alpha-store',
            memoryNamespace: PROJECT_SHARED_MEMORY_NAMESPACE,
        }));
    });

    test('allows same-project project-shared artifact recall across frontends', async () => {
        const service = new MemoryService();
        jest.spyOn(service.store, 'search').mockResolvedValue([
            {
                id: 'artifact-cross-surface',
                score: 0.87,
                text: 'Artifact summary for the shared project brief.',
                sessionId: 'session-canvas',
                timestamp: '2026-04-08T10:00:00.000Z',
                metadata: {
                    ownerId: 'phill',
                    memoryScope: 'alpha-store',
                    projectKey: 'alpha-store',
                    memoryNamespace: PROJECT_SHARED_MEMORY_NAMESPACE,
                    memoryClass: 'artifact',
                    sourceSurface: 'canvas',
                    memoryType: 'artifact',
                    artifactFilename: 'brief.html',
                    artifactFormat: 'html',
                    keywords: ['brief', 'html'],
                },
            },
        ]);
        jest.spyOn(service.store, 'scroll').mockResolvedValue([]);

        const recall = await service.recall('continue the shared html brief', {
            ownerId: 'phill',
            memoryScope: 'alpha-store',
            projectKey: 'alpha-store',
            sourceSurface: 'web-chat',
            returnDetails: true,
        });

        expect(recall.contextMessages).toHaveLength(1);
        expect(recall.contextMessages[0]).toContain('brief.html');
        expect(recall.trace.selected[0]).toEqual(expect.objectContaining({
            projectKey: 'alpha-store',
            memoryNamespace: PROJECT_SHARED_MEMORY_NAMESPACE,
            sourceSurface: 'canvas',
        }));
    });

    test('blocks same-project surface-local recall from a different frontend lane', async () => {
        const service = new MemoryService();
        jest.spyOn(service.store, 'search').mockResolvedValue([
            {
                id: 'surface-local-canvas',
                score: 0.92,
                text: 'Canvas-only working note for the Alpha storefront.',
                sessionId: 'session-canvas',
                timestamp: '2026-04-08T10:00:00.000Z',
                metadata: {
                    ownerId: 'phill',
                    memoryScope: 'alpha-store',
                    projectKey: 'alpha-store',
                    memoryNamespace: SURFACE_LOCAL_MEMORY_NAMESPACE,
                    memoryClass: 'conversation',
                    sourceSurface: 'canvas',
                    memoryType: 'fact',
                    keywords: ['storefront', 'layout'],
                },
            },
        ]);
        jest.spyOn(service.store, 'scroll').mockResolvedValue([]);

        const recall = await service.recall('continue the storefront layout', {
            ownerId: 'phill',
            memoryScope: 'alpha-store',
            projectKey: 'alpha-store',
            sourceSurface: 'web-chat',
            returnDetails: true,
        });

        expect(recall.contextMessages).toEqual([]);
        expect(recall.trace.selected).toEqual([]);
    });

    test('recalls user-global preferences across projects', async () => {
        const service = new MemoryService();
        jest.spyOn(service.store, 'search').mockResolvedValue([
            {
                id: 'user-pref-1',
                score: 0.72,
                text: 'Phil prefers concise status updates.',
                sessionId: 'session-other',
                timestamp: '2026-04-08T10:00:00.000Z',
                metadata: {
                    ownerId: 'phill',
                    memoryScope: 'alpha-store',
                    projectKey: 'alpha-store',
                    memoryNamespace: USER_GLOBAL_MEMORY_NAMESPACE,
                    memoryClass: 'user_preference',
                    sourceSurface: 'web-chat',
                    memoryType: 'fact',
                    keywords: ['concise', 'status', 'updates'],
                },
            },
        ]);
        jest.spyOn(service.store, 'scroll').mockResolvedValue([]);

        const recall = await service.recall('give me a concise status update', {
            ownerId: 'phill',
            memoryScope: 'beta-store',
            projectKey: 'beta-store',
            sourceSurface: 'canvas',
            returnDetails: true,
        });

        expect(recall.contextMessages).toHaveLength(1);
        expect(recall.contextMessages[0]).toContain('Phil prefers concise status updates.');
        expect(recall.trace.selected[0]).toEqual(expect.objectContaining({
            memoryNamespace: USER_GLOBAL_MEMORY_NAMESPACE,
            memoryClass: 'user_preference',
        }));
    });

    test('rememberArtifactResult stores both a summary and chunked source memories', async () => {
        const service = new MemoryService();
        const rememberSpy = jest.spyOn(service, 'remember').mockResolvedValue('point-1');

        await service.rememberArtifactResult('session-1', {
            artifact: {
                id: 'artifact-1',
                filename: 'brief.html',
                format: 'html',
            },
            summary: 'Created the HTML artifact (brief.html).',
            sourceText: '<!DOCTYPE html><html><body><section>Alpha</section></body></html>',
            metadata: {
                ownerId: 'phill',
                memoryScope: 'web-chat',
                memoryKeywords: ['html', 'brief'],
            },
        });

        expect(rememberSpy).toHaveBeenCalledWith('session-1', 'Created the HTML artifact (brief.html).', 'artifact-summary', expect.objectContaining({
            artifactId: 'artifact-1',
            artifactFilename: 'brief.html',
            artifactFormat: 'html',
        }));
        expect(rememberSpy).toHaveBeenCalledWith('session-1', expect.stringContaining('<!DOCTYPE html>'), 'artifact-source', expect.objectContaining({
            artifactId: 'artifact-1',
            artifactFilename: 'brief.html',
            artifactFormat: 'html',
            chunkIndex: 0,
        }));
    });

    test('remember chunks oversized assistant output before embedding', async () => {
        const service = new MemoryService();
        const originalChunkChars = config.config.memory.storeChunkChars;
        const originalMaxChunks = config.config.memory.storeMaxChunks;
        config.config.memory.storeChunkChars = 20;
        config.config.memory.storeMaxChunks = 2;
        const storeSpy = jest.spyOn(service.store, 'store').mockResolvedValue('point-1');

        try {
            const result = await service.remember(
                'session-1',
                'Alpha sentence. Beta sentence. Gamma sentence. Delta sentence.',
                'assistant',
                { memoryClass: 'conversation' },
            );

            expect(result).toEqual(['point-1', 'point-1']);
            expect(storeSpy).toHaveBeenCalledTimes(2);
            expect(storeSpy.mock.calls[0][1].length).toBeLessThanOrEqual(20);
            expect(storeSpy.mock.calls[1][1].length).toBeLessThanOrEqual(20);
            expect(storeSpy.mock.calls[0][2]).toMatchObject({
                chunkIndex: 0,
                sourceCharLength: 62,
                sourceChunkCount: 2,
                memoryTruncated: true,
            });
        } finally {
            storeSpy.mockRestore();
            config.config.memory.storeChunkChars = originalChunkChars;
            config.config.memory.storeMaxChunks = originalMaxChunks;
        }
    });

    test('remember skips ongoing programming transcript memory', async () => {
        const service = new MemoryService();
        const storeSpy = jest.spyOn(service.store, 'store').mockResolvedValue('point-1');

        const result = await service.remember(
            'session-1',
            'Patched src/routes/chat.js and ran npm test for the route suite.',
            'assistant',
            { memoryClass: 'conversation' },
        );

        expect(result).toBeNull();
        expect(storeSpy).not.toHaveBeenCalled();
        storeSpy.mockRestore();
    });

    test('remember keeps explicit user preferences even when they mention code', async () => {
        const service = new MemoryService();
        const storeSpy = jest.spyOn(service.store, 'store').mockResolvedValue('point-1');

        await service.remember(
            'session-1',
            'I prefer small focused patches in src/routes/chat.js.',
            'user',
            { memoryClass: 'user_preference' },
        );

        expect(storeSpy).toHaveBeenCalledTimes(1);
        storeSpy.mockRestore();
    });

    test('remember keeps production continuity programming memory as project task memory', async () => {
        const service = new MemoryService();
        const storeSpy = jest.spyOn(service.store, 'store').mockResolvedValue('point-1');

        await service.remember(
            'session-1',
            'Patched src/routes/chat.js, ran npm test, and deployed the fix live.',
            'assistant',
            {
                ownerId: 'phill',
                memoryScope: 'acme-platform',
                projectKey: 'acme-platform',
                sourceSurface: 'web-chat',
                executionProfile: 'remote-build',
                memoryClass: 'conversation',
            },
        );

        expect(storeSpy).toHaveBeenCalledWith(
            'session-1',
            expect.stringContaining('Patched src/routes/chat.js'),
            expect.objectContaining({
                memoryClass: 'project_task',
                memoryNamespace: PROJECT_SHARED_MEMORY_NAMESPACE,
                projectKey: 'acme-platform',
                shareAcrossSurfaces: true,
            }),
        );
        storeSpy.mockRestore();
    });

    test('process can recall same-project continuity memory across web-chat sessions', async () => {
        const service = new MemoryService();
        const recallSpy = jest.spyOn(service, 'recall').mockResolvedValue(['ctx']);
        jest.spyOn(service, 'remember').mockResolvedValue('point-1');

        await service.process('session-1', 'continue the live deployment', {
            ownerId: 'phill',
            memoryScope: 'acme-platform',
            projectKey: 'acme-platform',
            sourceSurface: 'web-chat',
            sessionIsolation: true,
            executionProfile: 'remote-build',
            profile: DEFAULT_RECALL_PROFILE,
        });

        expect(recallSpy).toHaveBeenCalledWith('continue the live deployment', expect.objectContaining({
            sessionId: null,
            ownerId: 'phill',
            projectKey: 'acme-platform',
            sessionIsolation: false,
        }));
    });

    test('rememberLearnedSkill skips ongoing programming steps by default', async () => {
        const service = new MemoryService();
        const rememberSpy = jest.spyOn(service, 'remember').mockResolvedValue('skill-point-1');

        const result = await service.rememberLearnedSkill('session-1', {
            objective: 'Fix the failing chat route tests in this repo.',
            assistantText: 'Updated src/routes/chat.js and verified npm test passed.',
            toolEvents: [
                {
                    reason: 'Inspect the chat route implementation.',
                    toolCall: {
                        function: {
                            name: 'file-read',
                            arguments: JSON.stringify({ path: 'src/routes/chat.js' }),
                        },
                    },
                    result: {
                        success: true,
                        toolId: 'file-read',
                        data: 'router.post("/", validate(chatSchema), async (req, res) => {})',
                    },
                },
                {
                    reason: 'Run the route tests.',
                    toolCall: {
                        function: {
                            name: 'code-sandbox',
                            arguments: JSON.stringify({ command: 'npm test -- src/routes/chat.test.js' }),
                        },
                    },
                    result: {
                        success: true,
                        toolId: 'code-sandbox',
                        data: 'PASS src/routes/chat.test.js',
                    },
                },
            ],
            metadata: {
                memoryKeywords: ['chat-route'],
            },
        });

        expect(result).toBeNull();
        expect(rememberSpy).not.toHaveBeenCalled();
    });

    test('judgment v2 returns typed recall bundles and rationale details', async () => {
        config.config.runtime.judgmentV2Enabled = true;
        const service = new MemoryService();
        jest.spyOn(service.store, 'search').mockResolvedValue([
            {
                id: 'memory-artifact-1',
                score: 0.82,
                text: 'Created pricing-report.html for the latest GPU pricing brief.',
                sessionId: 'session-1',
                timestamp: '2026-04-08T10:00:00.000Z',
                metadata: {
                    sessionId: 'session-1',
                    memoryType: 'artifact',
                    memoryNamespace: SESSION_LOCAL_MEMORY_NAMESPACE,
                    artifactId: 'artifact-1',
                    artifactFilename: 'pricing-report.html',
                    artifactFormat: 'html',
                    keywords: ['gpu', 'pricing', 'report'],
                },
            },
        ]);
        jest.spyOn(service.store, 'scroll').mockResolvedValue([]);

        const recall = await service.recall('revise the latest GPU pricing report', {
            sessionId: 'session-1',
            profile: RESEARCH_RECALL_PROFILE,
            returnDetails: true,
        });

        expect(recall.bundles.artifact).toHaveLength(1);
        expect(recall.trace.bundles).toEqual(expect.objectContaining({
            artifact: 1,
        }));
        expect(recall.trace.selected[0].rationale).toEqual(expect.arrayContaining([
            expect.stringContaining('keyword overlap'),
        ]));
    });

    test('judgment v2 boosts workflow-summary skills when tool family matches the new objective', async () => {
        config.config.runtime.judgmentV2Enabled = true;
        const service = new MemoryService();
        jest.spyOn(service.store, 'search').mockResolvedValue([
            {
                id: 'skill-1',
                score: 0.35,
                text: 'Reusable workflow: Repair the remote k3s rollout. Verified steps: remote-command -> k3s-deploy.',
                sessionId: 'session-1',
                timestamp: '2026-04-08T10:00:00.000Z',
                metadata: {
                    sessionId: 'session-1',
                    memoryType: 'skill',
                    memoryNamespace: SESSION_LOCAL_MEMORY_NAMESPACE,
                    skillKind: 'workflow-summary',
                    learningOutcome: 'verified',
                    toolFamily: 'remote',
                    toolIds: ['remote-command', 'k3s-deploy'],
                    keywords: ['remote', 'k3s', 'rollout'],
                },
            },
        ]);
        jest.spyOn(service.store, 'scroll').mockResolvedValue([]);

        const recall = await service.recall('Continue the remote k3s rollout fix', {
            sessionId: 'session-1',
            returnDetails: true,
            preferredToolIds: ['remote-command'],
        });

        expect(recall.bundles.skill).toHaveLength(1);
        expect(recall.trace.selected[0]).toEqual(expect.objectContaining({
            typeGroup: 'skill',
            rationale: expect.arrayContaining([
                'workflow family match: remote',
                'matches preferred tools',
            ]),
        }));
    });

    test('generic reusable skills can transfer across projects when the tool family matches', async () => {
        config.config.runtime.judgmentV2Enabled = true;
        const service = new MemoryService();
        jest.spyOn(service.store, 'search').mockResolvedValue([
            {
                id: 'skill-global-remote',
                score: 0.33,
                text: 'Reusable workflow: Repair a remote rollout by checking pods, rollout status, and logs.',
                sessionId: 'session-alpha',
                timestamp: '2026-04-08T10:00:00.000Z',
                metadata: {
                    ownerId: 'phill',
                    memoryScope: 'alpha-store',
                    projectKey: 'alpha-store',
                    memoryNamespace: USER_GLOBAL_MEMORY_NAMESPACE,
                    memoryClass: 'reusable_skill',
                    memoryType: 'skill',
                    skillKind: 'workflow-summary',
                    learningOutcome: 'verified',
                    toolFamily: 'remote',
                    toolIds: ['remote-command'],
                    keywords: ['remote', 'rollout', 'pods', 'logs'],
                },
            },
        ]);
        jest.spyOn(service.store, 'scroll').mockResolvedValue([]);

        const recall = await service.recall('continue the remote rollout fix', {
            ownerId: 'phill',
            memoryScope: 'beta-store',
            projectKey: 'beta-store',
            sourceSurface: 'web-chat',
            preferredToolIds: ['remote-command'],
            objective: 'Continue the remote k3s rollout fix',
            returnDetails: true,
        });

        expect(recall.bundles.skill).toHaveLength(1);
        expect(recall.trace.selected[0]).toEqual(expect.objectContaining({
            memoryNamespace: USER_GLOBAL_MEMORY_NAMESPACE,
            memoryClass: 'reusable_skill',
            rationale: expect.arrayContaining([
                'workflow family match: remote',
                'matches preferred tools',
            ]),
        }));
    });
});
