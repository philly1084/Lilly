const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadApiClient(fetchMock = jest.fn(), locationOverrides = {}) {
    const source = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
    const window = {
        location: {
            hostname: 'localhost',
            protocol: 'http:',
            host: 'localhost:3000',
            port: '3000',
            href: 'http://localhost:3000/web-chat/app.html',
            ...locationOverrides,
        },
        KimiBuiltGatewaySSE: null,
        KimiBuiltWebChatWorkspace: null,
        sessionManager: null,
    };
    const context = {
        window,
        fetch: fetchMock,
        console,
        EventTarget,
        AbortController,
        URL,
        URLSearchParams,
        Intl,
        Date,
        setTimeout,
        clearTimeout,
    };
    window.window = window;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'api.js' });

    return {
        apiClient: context.window.apiClient,
        fetchMock,
    };
}

describe('web-chat stream cancellation', () => {
    test('does not start a request when the caller signal is already aborted', async () => {
        const fetchMock = jest.fn();
        const { apiClient } = loadApiClient(fetchMock);
        const controller = new AbortController();
        controller.abort();

        const events = [];
        for await (const event of apiClient.streamChat(
            [{ role: 'user', content: 'Stop before sending' }],
            'auto',
            controller.signal,
        )) {
            events.push(event);
        }

        expect(fetchMock).not.toHaveBeenCalled();
        expect(events).toEqual([
            expect.objectContaining({
                type: 'error',
                cancelled: true,
                error: 'Request cancelled',
            }),
        ]);
    });

    test('stops retry backoff immediately when the caller aborts', async () => {
        jest.useFakeTimers();

        try {
            const fetchMock = jest.fn().mockRejectedValueOnce(new TypeError('fetch failed'));
            const { apiClient } = loadApiClient(fetchMock);
            const controller = new AbortController();
            const iterator = apiClient.streamChatWithFetch(
                { messages: [{ role: 'user', content: 'Cancel the retry' }] },
                controller.signal,
                'request-1',
            );

            await expect(iterator.next()).resolves.toEqual({
                value: expect.objectContaining({
                    type: 'retry',
                    attempt: 2,
                }),
                done: false,
            });

            const pendingResult = iterator.next();
            controller.abort();

            await expect(pendingResult).resolves.toEqual({
                value: expect.objectContaining({
                    type: 'error',
                    cancelled: true,
                    error: 'Request cancelled',
                }),
                done: false,
            });
            expect(fetchMock).toHaveBeenCalledTimes(1);
            await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('web-chat image API client', () => {
    test('omits response_format by default for GPT image requests', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                created: 123,
                data: [{ url: '/generated/example.png' }],
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await apiClient.generateImage({
            prompt: 'developer tools banner',
            model: 'gpt-image-2',
            size: 'auto',
            n: 1,
            sessionId: 'session-1',
        });

        expect(fetchMock).toHaveBeenCalledWith(
            'http://localhost:3000/v1/images/generations',
            expect.objectContaining({
                method: 'POST',
                credentials: 'same-origin',
            }),
        );
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).toEqual(expect.objectContaining({
            prompt: 'developer tools banner',
            model: 'gpt-image-2',
            size: 'auto',
            n: 1,
            sessionId: 'session-1',
            taskType: 'image',
            clientSurface: 'web-chat',
        }));
        expect(body).not.toHaveProperty('response_format');
    });

    test('preserves an explicit response_format override', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                created: 123,
                data: [{ b64_json: 'aGVsbG8=' }],
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await apiClient.generateImage({
            prompt: 'developer tools banner',
            model: 'gpt-image-2',
            response_format: 'b64_json',
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).toEqual(expect.objectContaining({
            model: 'gpt-image-2',
            response_format: 'b64_json',
        }));
    });
});

describe('web-chat API origin selection', () => {
    test('uses the current local port-3000 origin instead of hard-coding localhost', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                data: [],
                meta: {},
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock, {
            hostname: '127.0.0.1',
            host: '127.0.0.1:3000',
            port: '3000',
            href: 'http://127.0.0.1:3000/web-chat/app.html',
        });

        await apiClient.getAvailableTools(null, { includeAll: true });

        expect(fetchMock.mock.calls[0][0]).toContain('http://127.0.0.1:3000/api/tools/available');
    });

    test('uses the current origin for served non-3000 local routes', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                data: [],
                meta: {},
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock, {
            hostname: '127.0.0.1',
            host: '127.0.0.1:3100',
            port: '3100',
            href: 'http://127.0.0.1:3100/web-chat/app.html',
        });

        await apiClient.getAvailableTools(null, { includeAll: true });

        expect(fetchMock.mock.calls[0][0]).toContain('http://127.0.0.1:3100/api/tools/available');
    });

    test('keeps the backend fallback for file previews', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                data: [],
                meta: {},
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock, {
            hostname: '',
            protocol: 'file:',
            host: '',
            port: '',
            href: 'file:///C:/Users/phill/KimiBuilt/frontend/web-chat/app.html',
        });

        await apiClient.getAvailableTools(null, { includeAll: true });

        expect(fetchMock.mock.calls[0][0]).toContain('http://localhost:3000/api/tools/available');
    });
});

describe('web-chat model filtering', () => {
    test('keeps image-input chat models while excluding image generators', () => {
        const { apiClient } = loadApiClient();

        const models = apiClient.filterChatModels([
            { id: 'gpt-4o-image-input-preview' },
            { id: 'router-image-input-chat', capabilities: ['chat', 'image_input'] },
            { id: 'custom-image-router', capabilities: ['image_generation'] },
            { id: 'gpt-image-2', capabilities: ['image_generation'] },
        ]);

        expect(models.map((model) => model.id)).toEqual([
            'gpt-4o-image-input-preview',
            'router-image-input-chat',
        ]);
    });

    test('normalizes string and nested capability metadata in the fallback filter', () => {
        const { apiClient } = loadApiClient();

        const models = apiClient.filterChatModels([
            { id: 'gpt-image-2', capabilities: 'image_generation' },
            { id: 'custom-render-router', capabilities: [], metadata: { capabilities: { image_generation: { supported: true } } } },
            { id: 'gpt-5.5-tools', capabilities: [], metadata: { capabilities: { tools: { supported: true }, streaming: 'available' } } },
            { id: 'custom-basic-chat', contract: { capabilities: { chat: true } } },
        ]);

        expect(models.map((model) => model.id)).toEqual([
            'gpt-5.5-tools',
            'custom-basic-chat',
        ]);
    });
});

describe('web-chat artifact metadata normalization', () => {
    test('normalizes snake_case artifact IDs and URLs from stream done payloads', () => {
        const { apiClient } = loadApiClient();

        const events = apiClient.normalizeStreamPayload({
            type: 'done',
            session_id: 'session-1',
            artifacts: [{
                artifact_id: 'artifact-1',
                filename: 'report.pdf',
                format: 'pdf',
                download_url: '/api/artifacts/artifact-1/download',
                preview_url: '/api/artifacts/artifact-1/preview',
                bundle_download_url: '/api/artifacts/artifact-1/bundle',
            }],
            metadata: {
                artifacts: [{
                    artifact_id: 'artifact-1',
                    filename: 'report.pdf',
                    format: 'pdf',
                    download_url: '/api/artifacts/artifact-1/download',
                    preview_url: '/api/artifacts/artifact-1/preview',
                    bundle_download_url: '/api/artifacts/artifact-1/bundle',
                }],
            },
        }, {});

        const done = events.find((event) => event.type === 'done');
        expect(done.artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-1',
                downloadUrl: '/api/artifacts/artifact-1/download',
                previewUrl: '/api/artifacts/artifact-1/preview',
                bundleDownloadUrl: '/api/artifacts/artifact-1/bundle',
            }),
        ]);
        expect(done.assistantMetadata.artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-1',
                downloadUrl: '/api/artifacts/artifact-1/download',
                previewUrl: '/api/artifacts/artifact-1/preview',
                bundleDownloadUrl: '/api/artifacts/artifact-1/bundle',
            }),
        ]);
    });

    test('keeps preview-only assistant metadata artifacts from stream done payloads', () => {
        const { apiClient } = loadApiClient();

        const events = apiClient.normalizeStreamPayload({
            type: 'done',
            metadata: {
                artifacts: [{
                    artifact_id: 'sandbox-artifact-1',
                    filename: 'site.html',
                    format: 'html',
                    preview_url: '/api/artifacts/sandbox-artifact-1/preview',
                    sandbox_url: '/api/artifacts/sandbox-artifact-1/sandbox',
                }],
            },
        }, {});

        const done = events.find((event) => event.type === 'done');
        expect(done.assistantMetadata.artifacts).toEqual([
            expect.objectContaining({
                id: 'sandbox-artifact-1',
                previewUrl: '/api/artifacts/sandbox-artifact-1/preview',
                sandboxUrl: '/api/artifacts/sandbox-artifact-1/sandbox',
                downloadUrl: '',
            }),
        ]);
    });
});

describe('web-chat reasoning metadata normalization', () => {
    test('preserves adaptive reasoning and goal metadata from stream completion', () => {
        const { apiClient } = loadApiClient();
        const events = apiClient.normalizeStreamPayload({
            type: 'done',
            assistantMetadata: {
                contractVersion: 1,
                reasoningPolicy: {
                    mode: 'auto',
                    effectiveEffort: 'high',
                    complexityBand: 'complex',
                },
                goal: {
                    scope: 'turn',
                    objective: 'Return a verified comparison.',
                },
            },
        }, {});
        const done = events.find((event) => event.type === 'done');

        expect(done.assistantMetadata).toEqual(expect.objectContaining({
            contractVersion: 1,
            reasoningPolicy: expect.objectContaining({ effectiveEffort: 'high' }),
            goal: expect.objectContaining({ scope: 'turn' }),
        }));
    });

    test('preserves top-level metadata tool events from stream completion', () => {
        const { apiClient } = loadApiClient();

        const events = apiClient.normalizeStreamPayload({
            type: 'done',
            metadata: {
                tool_events: [{
                    toolCall: {
                        function: {
                            name: 'remote-command',
                            arguments: '{"command":"kubectl get pods"}',
                        },
                    },
                    result: {
                        success: true,
                        summary: 'Pods listed',
                    },
                }],
            },
        }, {});

        const done = events.find((event) => event.type === 'done');
        expect(done.toolEvents).toEqual([
            expect.objectContaining({
                toolCall: expect.objectContaining({
                    function: expect.objectContaining({ name: 'remote-command' }),
                }),
                result: expect.objectContaining({ success: true }),
            }),
        ]);
    });

    test('normalizes provider thinking aliases from stream done payloads', () => {
        const { apiClient } = loadApiClient();

        const events = apiClient.normalizeStreamPayload({
            type: 'done',
            assistant_metadata: {
                thinking_summary: 'Checked constraints and picked the direct fix.',
            },
        }, {});

        const done = events.find((event) => event.type === 'done');
        expect(done.assistantMetadata).toEqual(expect.objectContaining({
            reasoningAvailable: true,
            reasoningSummary: 'Checked constraints and picked the direct fix.',
        }));
    });

    test('preserves camel-case output text from provider responses', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                outputText: 'Recovered provider response.',
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        const response = await apiClient.chat([{
            role: 'user',
            content: 'Return the provider response.',
        }]);

        expect(response.content).toBe('Recovered provider response.');
    });

    test('renders response refusal deltas through the local stream fallback', () => {
        const { apiClient } = loadApiClient();

        const events = apiClient.normalizeStreamPayload({
            type: 'response.refusal.delta',
            delta: 'I can help with a safer version instead.',
        }, {});

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'text_delta',
                content: 'I can help with a safer version instead.',
            }),
        ]));
    });
});

describe('web-chat async runtime status', () => {
    test('normalizes the capability flags used by selected remote agent routing', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                status: {
                    requestedEnabled: true,
                    enabled: true,
                    webChatParallelEnabled: true,
                    allowLiveRemote: true,
                    workerEnabled: true,
                    workerRunning: false,
                },
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await expect(apiClient.getAsyncRuntimeStatus()).resolves.toEqual({
            requestedEnabled: true,
            enabled: true,
            webChatParallelEnabled: true,
            allowLiveRemote: true,
            workerEnabled: true,
            workerRunning: false,
        });
        expect(fetchMock).toHaveBeenCalledWith(
            'http://localhost:3000/api/async-lab/status',
            {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                credentials: 'same-origin',
                cache: 'no-store',
            },
        );
    });

    test('fails closed when status fields are absent or serialized truthy values', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                status: {
                    enabled: 'true',
                    webChatParallelEnabled: 1,
                    allowLiveRemote: null,
                },
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await expect(apiClient.getAsyncRuntimeStatus()).resolves.toEqual({
            requestedEnabled: false,
            enabled: false,
            webChatParallelEnabled: false,
            allowLiveRemote: false,
            workerEnabled: false,
            workerRunning: false,
        });
    });

    test('preserves authentication failures for the caller to distinguish from a disabled runtime', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: false,
            status: 401,
            headers: { get: () => 'application/json' },
            json: async () => ({ error: { message: 'Authentication required' } }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await expect(apiClient.getAsyncRuntimeStatus()).rejects.toMatchObject({
            message: 'Authentication required',
            status: 401,
        });
    });
});

describe('web-chat remote build metadata', () => {
    test('sends plugin menu execution profile and planned tools in chat requests', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'ok' } }],
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await apiClient.chat([{
            role: 'user',
            content: 'Make a source-backed launch plan.',
        }], 'auto', '', {
            executionProfile: 'remote-build',
            metadata: {
                toolSelectionSource: 'web-chat-plugin-menu',
                selectedPluginLanes: ['research', 'remote'],
                plannedTools: ['web-search', 'web-fetch', 'remote-cli-agent'],
                preferredTool: 'remote-cli-agent',
                userToolIntents: [
                    { id: 'research', tools: ['web-search', 'web-fetch'] },
                    { id: 'remote', tools: ['remote-cli-agent'] },
                ],
            },
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.executionProfile).toBe('remote-build');
        expect(body.metadata).toEqual(expect.objectContaining({
            toolSelectionSource: 'web-chat-plugin-menu',
            selectedPluginLanes: ['research', 'remote'],
            plannedTools: ['web-search', 'web-fetch', 'remote-cli-agent'],
            preferredTool: 'remote-cli-agent',
        }));
        expect(body.metadata.userToolIntents).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'research' }),
            expect.objectContaining({ id: 'remote' }),
        ]));
    });

    test('does not prefer managed-app for explicit remote-cli-agent chat requests', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'ok' } }],
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await apiClient.chat([{
            role: 'user',
            content: 'Use remote-cli-agent with adminMode true to update the website on the remote k3s server.',
        }]);

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.executionProfile).toBe('remote-build');
        expect(body.metadata).toEqual(expect.objectContaining({
            remoteBuildAutonomyApproved: true,
            frontendRemoteBuildAutonomyApproved: true,
            remoteBuildIntent: true,
            preferredTool: 'remote-cli-agent',
            plannedTools: ['remote-cli-agent'],
        }));
        expect(body.metadata.preferManagedApp).toBeUndefined();
    });

    test('defaults ordinary remote-build chat requests to remote-cli-agent', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'ok' } }],
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await apiClient.chat([{
            role: 'user',
            content: 'Fix the web chat frontend on the remote server and verify it live.',
        }]);

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.executionProfile).toBe('remote-build');
        expect(body.metadata).toEqual(expect.objectContaining({
            remoteBuildAutonomyApproved: true,
            frontendRemoteBuildAutonomyApproved: true,
            remoteBuildIntent: true,
            preferredTool: 'remote-cli-agent',
            plannedTools: ['remote-cli-agent'],
        }));
        expect(body.metadata.preferManagedApp).toBeUndefined();
    });

    test('sends execution profile and metadata on direct tool invokes', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                success: true,
                data: { ok: true },
                sessionId: 'session-1',
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await apiClient.invokeTool('remote-cli-agent', { task: 'check status', adminMode: true }, {
            executionProfile: 'remote-build',
            metadata: {
                directToolCallSource: 'web-chat-tool-command',
                directToolId: 'remote-cli-agent',
                plannedTools: ['remote-cli-agent'],
                userSelectedToolIds: ['remote-cli-agent'],
            },
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(fetchMock.mock.calls[0][0]).toContain('/api/tools/invoke');
        expect(body).toEqual(expect.objectContaining({
            tool: 'remote-cli-agent',
            params: { task: 'check status', adminMode: true },
            executionProfile: 'remote-build',
            taskType: 'chat',
            clientSurface: 'web-chat',
        }));
        expect(body.metadata).toEqual(expect.objectContaining({
            directToolCallSource: 'web-chat-tool-command',
            directToolId: 'remote-cli-agent',
            plannedTools: ['remote-cli-agent'],
            userSelectedToolIds: ['remote-cli-agent'],
        }));
    });

    test('forwards remote CLI artifact handoff and continuation fields', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                success: true,
                data: { ok: true },
                sessionId: 'session-1',
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);
        const contextFiles = [{
            filename: 'design-brief.xml',
            content: '<brief><goal>Refine the landing page</goal></brief>',
            mimeType: 'application/xml',
        }];

        await apiClient.invokeRemoteCliAgent('Refine the selected artifact.', {
            transport: 'provider-agent',
            cwd: '/srv/apps/demo',
            workspacePath: '/srv/apps/demo',
            targetId: 'k3s-prod',
            sessionId: 'remote-session-1',
            threadId: 'thread-1',
            jobId: 'job-1',
            mcpSessionId: 'mcp-session-1',
            agentRunTimeoutMs: 180000,
            remoteCodeModel: 'kimi-k3',
            maxStatusPolls: 24,
            statusPollIntervalMs: 2500,
            instructions: 'Preserve the design system.',
            supportAgentResponse: 'Use the existing layout tokens.',
            artifactIds: ['artifact-1', 'artifact-1', 'artifact-2'],
            contextFiles,
            resultFileGlobs: ['dist/*.html', 'dist/*.html', 'assets/*.svg'],
            collectResultFiles: true,
            continuitySummary: 'Continue artifact-1 from revision 3.',
            adminMode: true,
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.params).toEqual(expect.objectContaining({
            task: 'Refine the selected artifact.',
            transport: 'provider-agent',
            cwd: '/srv/apps/demo',
            workspacePath: '/srv/apps/demo',
            targetId: 'k3s-prod',
            sessionId: 'remote-session-1',
            threadId: 'thread-1',
            jobId: 'job-1',
            mcpSessionId: 'mcp-session-1',
            agentRunTimeoutMs: 180000,
            remoteCodeModel: 'kimi-k3',
            maxStatusPolls: 24,
            statusPollIntervalMs: 2500,
            instructions: 'Preserve the design system.',
            supportAgentResponse: 'Use the existing layout tokens.',
            artifactIds: ['artifact-1', 'artifact-2'],
            contextFiles,
            resultFileGlobs: ['dist/*.html', 'assets/*.svg'],
            collectResultFiles: true,
            continuitySummary: 'Continue artifact-1 from revision 3.',
            adminMode: true,
        }));
    });

    test('loads the safe remote coding target catalog for runtime selection', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                success: true,
                data: [{
                    targetId: 'k3s-secondary-openrouter',
                    description: 'Secondary via OpenCode and OpenRouter',
                    defaultCwd: '/opt/kimibuilt',
                    defaultModel: 'openrouter/openrouter/free',
                }],
                meta: { source: 'remote-agent-targets' },
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await expect(apiClient.getRemoteAgentTargets()).resolves.toEqual({
            targets: [expect.objectContaining({
                targetId: 'k3s-secondary-openrouter',
                defaultModel: 'openrouter/openrouter/free',
            })],
            meta: { source: 'remote-agent-targets' },
        });
        expect(fetchMock.mock.calls[0][0]).toContain('/api/tools/remote-cli-agent/targets');
    });

    test('prefers managed-app only for explicit managed-app chat requests', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'ok' } }],
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await apiClient.chat([{
            role: 'user',
            content: 'Use the managed-app GitLab path to build and deploy a public website.',
        }]);

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.executionProfile).toBe('remote-build');
        expect(body.metadata.preferManagedApp).toBe(true);
    });

    test('keeps plain GitLab remote-build requests on remote-cli-agent', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'ok' } }],
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await apiClient.chat([{
            role: 'user',
            content: 'Use GitLab to commit the frontend fix, build the image, deploy it to k3s, and verify the public site.',
        }]);

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.executionProfile).toBe('remote-build');
        expect(body.metadata).toEqual(expect.objectContaining({
            preferredTool: 'remote-cli-agent',
            plannedTools: ['remote-cli-agent'],
        }));
        expect(body.metadata.preferManagedApp).toBeUndefined();
    });

    test('marks selected-document managed-app deploy follow-ups as remote-build', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'ok' } }],
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await apiClient.chat([{
            role: 'user',
            content: 'Update this document (light-it-up-event-holiday-architectural-405gr2.html): lets deploy this to the web, lightitup.demoserver2.buzz on our remote server using the managed app',
        }]);

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.executionProfile).toBe('remote-build');
        expect(body.metadata).toEqual(expect.objectContaining({
            remoteBuildAutonomyApproved: true,
            frontendRemoteBuildAutonomyApproved: true,
            remoteBuildIntent: true,
            preferManagedApp: true,
        }));
    });
});
