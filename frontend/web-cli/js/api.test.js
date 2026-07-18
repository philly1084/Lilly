const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadWebCliApi(fetchMock = jest.fn()) {
    const source = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
    const localStorage = {
        getItem: jest.fn(() => null),
        setItem: jest.fn(),
        removeItem: jest.fn(),
    };
    const window = {
        location: {
            protocol: 'http:',
            origin: 'http://localhost:3000',
            host: 'localhost:3000',
            href: 'http://localhost:3000/web-cli/',
        },
        KimiBuiltGatewaySSE: null,
    };
    const context = {
        window,
        localStorage,
        fetch: fetchMock,
        console,
        setTimeout,
        clearTimeout,
        AbortController,
        TextDecoder,
        URL,
        URLSearchParams,
    };
    window.window = window;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'api.js' });

    return {
        api: context.window.webCliApiClient,
        fetchMock,
        localStorage,
    };
}

function createJsonResponse(data = {}, options = {}) {
    return {
        ok: options.ok !== false,
        status: options.status || 200,
        json: async () => data,
        text: async () => JSON.stringify(data),
        headers: {
            get: jest.fn(() => null),
        },
    };
}

function createSseResponse(events = [], options = {}) {
    const payload = events
        .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
        .join('');
    const chunks = [Buffer.from(payload, 'utf8')];

    return {
        ok: true,
        status: 200,
        headers: {
            get: jest.fn((name) => (
                String(name || '').toLowerCase() === 'x-session-id'
                    ? (options.sessionId || null)
                    : null
            )),
        },
        body: {
            getReader: () => ({
                read: jest.fn(async () => {
                    if (chunks.length === 0) {
                        return { done: true };
                    }
                    return { done: false, value: chunks.shift() };
                }),
            }),
        },
    };
}

describe('web-cli API artifact metadata normalization', () => {
    test('normalizes snake_case artifact metadata from stream payloads', () => {
        const { api } = loadWebCliApi();

        const artifacts = api.extractArtifacts({
            artifacts: [{
                artifact_id: 'artifact-1',
                name: 'brief.html',
                mime_type: 'text/html',
                size_bytes: 2048,
                download_url: '/api/artifacts/artifact-1/download',
                preview_url: '/api/artifacts/artifact-1/preview',
                sandbox_url: '/sandbox/artifact-1/',
                bundle_download_url: '/api/artifacts/artifact-1/bundle',
            }],
        });

        expect(artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-1',
                filename: 'brief.html',
                mimeType: 'text/html',
                sizeBytes: 2048,
                downloadUrl: '/api/artifacts/artifact-1/download',
                previewUrl: '/api/artifacts/artifact-1/preview',
                sandboxUrl: '/sandbox/artifact-1/',
                bundleDownloadUrl: '/api/artifacts/artifact-1/bundle',
            }),
        ]);
    });

    test('normalizes gateway assistant artifact metadata before storing pending done state', () => {
        const { api } = loadWebCliApi();
        const pendingDone = {};

        api.applyNormalizedStreamMetadata({
            artifacts: [{
                id: 'artifact-2',
                filename: 'report.pdf',
                download_url: '/api/artifacts/artifact-2/download',
                size_bytes: 4096,
            }],
            assistantMetadata: {
                artifacts: [{
                    id: 'artifact-2',
                    filename: 'report.pdf',
                    preview_url: '/api/artifacts/artifact-2/preview',
                    download_url: '/api/artifacts/artifact-2/download',
                    size_bytes: 4096,
                }],
            },
        }, pendingDone);

        expect(pendingDone.artifacts[0]).toEqual(expect.objectContaining({
            downloadUrl: '/api/artifacts/artifact-2/download',
            sizeBytes: 4096,
        }));
        expect(pendingDone.assistantMetadata.artifacts[0]).toEqual(expect.objectContaining({
            previewUrl: '/api/artifacts/artifact-2/preview',
            downloadUrl: '/api/artifacts/artifact-2/download',
            sizeBytes: 4096,
        }));
    });

    test('normalizes persisted session artifacts returned by the backend', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                artifacts: [{
                    artifact_id: 'artifact-3',
                    filename: 'slides.pdf',
                    download_url: '/api/artifacts/artifact-3/download',
                    size_bytes: 512,
                }],
            }),
        }));
        const { api } = loadWebCliApi(fetchMock);

        const artifacts = await api.getSessionArtifacts('session-1');

        expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3000/api/sessions/session-1/artifacts');
        expect(artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-3',
                downloadUrl: '/api/artifacts/artifact-3/download',
                sizeBytes: 512,
            }),
        ]);
    });
});

describe('web-cli remote agent and managed-app API contracts', () => {
    test('invokes the remote CLI agent with full de-duplicated artifact ids, selected model, and result collection', async () => {
        const fetchMock = jest.fn().mockResolvedValue(createJsonResponse({
            sessionId: 'session-remote-1',
            data: {
                completionStatus: 'complete',
                artifactIds: ['artifact-result-1'],
            },
        }));
        const { api } = loadWebCliApi(fetchMock);
        api.setSessionId('session-remote-1');
        api.setModel('kimi-k3');

        const result = await api.invokeRemoteCliAgent('  improve the selected design  ', {
            artifactIds: [
                ' artifact-full-123456789 ',
                'artifact-full-123456789',
                '',
                '7',
                'artifact-svg-987654321',
            ],
            cwd: '/srv/apps/design',
            adminMode: true,
        });

        expect(result).toEqual(expect.objectContaining({
            sessionId: 'session-remote-1',
            result: expect.objectContaining({
                artifactIds: ['artifact-result-1'],
            }),
        }));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('http://localhost:3000/api/tools/invoke');
        expect(options.credentials).toBe('same-origin');
        const body = JSON.parse(options.body);
        expect(body).toEqual(expect.objectContaining({
            tool: 'remote-cli-agent',
            sessionId: 'session-remote-1',
            model: 'kimi-k3',
            executionProfile: 'remote-build',
            clientSurface: 'web-cli',
        }));
        expect(body.params).toEqual(expect.objectContaining({
            task: 'improve the selected design',
            model: 'kimi-k3',
            cwd: '/srv/apps/design',
            adminMode: true,
            collectResultFiles: true,
            artifactIds: [
                'artifact-full-123456789',
                'artifact-svg-987654321',
            ],
        }));
        expect(body.metadata).toEqual(expect.objectContaining({
            clientSurface: 'web-cli',
            remoteBuildAutonomyApproved: true,
            remoteCommandSource: 'web-cli',
        }));
    });

    test('does not pass auto as an explicit remote provider model and honors an explicit collection opt-out', async () => {
        const fetchMock = jest.fn().mockResolvedValue(createJsonResponse({ data: {} }));
        const { api } = loadWebCliApi(fetchMock);
        api.setSessionId('session-remote-auto');
        api.setModel('auto');

        await api.invokeRemoteCliAgent('inspect the build', {
            collectResultFiles: false,
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.params).not.toHaveProperty('model');
        expect(body.params.collectResultFiles).toBe(false);
    });

    test('preflights final managed-app bytes with the active session and no mutation fields', async () => {
        const sourceSha256 = 'a'.repeat(64);
        const fetchMock = jest.fn().mockResolvedValue(createJsonResponse({
            pushToWebEligible: true,
            sha256: sourceSha256,
            blockers: [],
        }));
        const { api } = loadWebCliApi(fetchMock);
        api.setSessionId('session-deploy-1');

        const result = await api.preflightManagedAppArtifact('artifact/site bundle');

        expect(result).toEqual(expect.objectContaining({
            pushToWebEligible: true,
            sha256: sourceSha256,
        }));
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('http://localhost:3000/api/artifacts/artifact%2Fsite%20bundle/managed-app/preflight');
        expect(options).toEqual(expect.objectContaining({
            method: 'POST',
            credentials: 'same-origin',
        }));
        expect(JSON.parse(options.body)).toEqual({
            sessionId: 'session-deploy-1',
            validateOnly: true,
        });
    });

    test('deploys with the active session and preserves the exact accepted source hash', async () => {
        const expectedSourceSha256 = 'b'.repeat(64);
        const fetchMock = jest.fn().mockResolvedValue(createJsonResponse({
            publicHost: 'design.demoserver2.buzz',
            asyncRuntime: { run: { id: 'run-deploy-1' } },
        }));
        const { api } = loadWebCliApi(fetchMock);
        api.setSessionId('session-deploy-2');

        await api.deployManagedAppArtifact('artifact-site-bundle', {
            sessionId: 'untrusted-session-override',
            requestedAction: 'deploy',
            deployRequested: true,
            dnsName: 'design',
            publicHost: 'design.demoserver2.buzz',
            expectedSourceSha256,
        });

        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('http://localhost:3000/api/artifacts/artifact-site-bundle/managed-app');
        expect(options.credentials).toBe('same-origin');
        expect(JSON.parse(options.body)).toEqual(expect.objectContaining({
            sessionId: 'session-deploy-2',
            requestedAction: 'deploy',
            deployRequested: true,
            publicHost: 'design.demoserver2.buzz',
            expectedSourceSha256,
        }));
    });

    test('surfaces typed preflight blockers and source-hash mismatch errors', async () => {
        const blocker = {
            code: 'ARTIFACT_MANAGED_APP_UNSUPPORTED_BINARY_ASSETS',
            message: 'Binary assets cannot be preserved by this deployment lane.',
        };
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(createJsonResponse({
                error: {
                    code: blocker.code,
                    message: blocker.message,
                },
                blockers: [blocker],
            }, { ok: false, status: 422 }))
            .mockResolvedValueOnce(createJsonResponse({
                error: {
                    code: 'ARTIFACT_MANAGED_APP_SOURCE_HASH_MISMATCH',
                    message: 'Push to Web stopped because the prepared website bytes changed after preflight.',
                },
            }, { ok: false, status: 412 }));
        const { api } = loadWebCliApi(fetchMock);
        api.setSessionId('session-deploy-errors');

        await expect(api.preflightManagedAppArtifact('artifact-binary')).rejects.toMatchObject({
            status: 422,
            code: blocker.code,
            blocker,
            blockers: [blocker],
            details: expect.objectContaining({ blockers: [blocker] }),
        });
        await expect(api.deployManagedAppArtifact('artifact-changed', {
            expectedSourceSha256: 'c'.repeat(64),
        })).rejects.toMatchObject({
            status: 412,
            code: 'ARTIFACT_MANAGED_APP_SOURCE_HASH_MISMATCH',
            message: 'Push to Web stopped because the prepared website bytes changed after preflight.',
        });
    });

    test('rejects missing task and artifact ids before making a request', async () => {
        const { api, fetchMock } = loadWebCliApi();

        await expect(api.invokeRemoteCliAgent('   ')).rejects.toMatchObject({
            code: 'REMOTE_AGENT_TASK_REQUIRED',
        });
        await expect(api.preflightManagedAppArtifact('')).rejects.toMatchObject({
            code: 'ARTIFACT_ID_REQUIRED',
        });
        await expect(api.deployManagedAppArtifact('')).rejects.toMatchObject({
            code: 'ARTIFACT_ID_REQUIRED',
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('web-cli API request cancellation', () => {
    test('honors caller cancellation without retrying or reporting a timeout', async () => {
        const fetchMock = jest.fn((_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                const error = new Error('The operation was aborted.');
                error.name = 'AbortError';
                reject(error);
            }, { once: true });
        }));
        const { api } = loadWebCliApi(fetchMock);
        const controller = new AbortController();

        const request = api.fetchWithRetry('/api/slow', {
            signal: controller.signal,
        }, 3, 30000);
        controller.abort();

        await expect(request).rejects.toMatchObject({
            name: 'AbortError',
            message: 'The operation was aborted.',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('interrupts retry backoff when the caller cancels', async () => {
        const { api } = loadWebCliApi();
        const controller = new AbortController();
        const delay = api.waitForRetryDelay(30000, controller.signal);

        controller.abort();

        await expect(delay).rejects.toMatchObject({
            name: 'AbortError',
            message: 'The operation was aborted.',
        });
    });

    test('surfaces chat cancellation as a cancelled stream event', async () => {
        let markChatStarted;
        const chatStarted = new Promise((resolve) => {
            markChatStarted = resolve;
        });
        const fetchMock = jest.fn((url, options) => {
            if (String(url).endsWith('/api/sessions')) {
                return Promise.resolve(createJsonResponse({ id: 'session-cancel-1' }));
            }

            markChatStarted();
            return new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                    const error = new Error('The operation was aborted.');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            });
        });
        const { api } = loadWebCliApi(fetchMock);
        const controller = new AbortController();
        const stream = api.streamChat('stop this request', null, 'chat', [], {
            signal: controller.signal,
        });
        const nextEvent = stream.next();

        await chatStarted;
        controller.abort();

        await expect(nextEvent).resolves.toEqual({
            done: false,
            value: {
                type: 'error',
                error: 'Request cancelled.',
                cancelled: true,
            },
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('passes caller cancellation through image generation', async () => {
        const { api } = loadWebCliApi();
        api.ensureSession = jest.fn().mockResolvedValue('session-image-cancel-1');
        api.fetchWithRetry = jest.fn().mockResolvedValue(createJsonResponse({ data: [] }));
        const controller = new AbortController();

        await api.generateImage('A long-running image request', {
            signal: controller.signal,
        });

        expect(api.ensureSession.mock.calls[0][0].signal === controller.signal).toBe(true);
        expect(api.fetchWithRetry.mock.calls[0][1].signal === controller.signal).toBe(true);
    });
});

describe('web-cli API request retries', () => {
    test.each([429, 503])('retries transient HTTP %i responses', async (status) => {
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(createJsonResponse({ message: 'Try again shortly.' }, {
                ok: false,
                status,
            }))
            .mockResolvedValueOnce(createJsonResponse({ ok: true }));
        const { api } = loadWebCliApi(fetchMock);
        api.waitForRetryDelay = jest.fn().mockResolvedValue();

        const response = await api.fetchWithRetry('/api/transient', {}, 1, 30000);

        expect(response.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(api.waitForRetryDelay).toHaveBeenCalledTimes(1);
    });

    test('returns non-retryable client responses immediately', async () => {
        const fetchMock = jest.fn().mockResolvedValue(createJsonResponse({
            message: 'Invalid request payload.',
        }, {
            ok: false,
            status: 400,
        }));
        const { api } = loadWebCliApi(fetchMock);
        api.waitForRetryDelay = jest.fn().mockResolvedValue();

        const response = await api.fetchWithRetry('/api/invalid', {}, 3, 30000);

        expect(response.status).toBe(400);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(api.waitForRetryDelay).not.toHaveBeenCalled();
        await expect(response.json()).resolves.toEqual({
            message: 'Invalid request payload.',
        });
    });
});

describe('web-cli API tool event metadata normalization', () => {
    test('promotes assistant metadata tool events from fallback stream payloads', async () => {
        const fetchMock = jest.fn(async (url) => {
            if (String(url).endsWith('/api/sessions')) {
                return createJsonResponse({ id: 'session-tool-1' });
            }

            return createSseResponse([
                {
                    type: 'response.completed',
                    response: {
                        assistant_metadata: {
                            reasoning_summary: 'Checked the live command result.',
                            tool_events: [
                                {
                                    toolName: 'remote-command',
                                    stage: 'completed',
                                    detail: 'Finished remote command',
                                },
                            ],
                        },
                    },
                },
            ], { sessionId: 'session-tool-1' });
        });
        const { api } = loadWebCliApi(fetchMock);

        const response = await api.sendMessage('check status');

        expect(response.toolEvents).toEqual([
            expect.objectContaining({
                toolName: 'remote-command',
                stage: 'completed',
            }),
        ]);
        expect(response.assistantMetadata).toEqual(expect.objectContaining({
            reasoningSummary: 'Checked the live command result.',
            toolEvents: [
                expect.objectContaining({
                    toolName: 'remote-command',
                    stage: 'completed',
                }),
            ],
        }));
    });
});

describe('web-cli API reasoning metadata normalization', () => {
    test('preserves response refusal deltas when streaming without the shared gateway helper', async () => {
        const fetchMock = jest.fn(async (url) => {
            if (String(url).endsWith('/api/sessions')) {
                return createJsonResponse({ id: 'session-1' });
            }

            return createSseResponse([
                {
                    type: 'response.refusal.delta',
                    delta: 'I can help with a safer version instead.',
                },
                '[DONE]',
            ], { sessionId: 'session-1' });
        });
        const { api } = loadWebCliApi(fetchMock);

        const chunks = [];
        for await (const chunk of api.streamChat('unsafe request')) {
            chunks.push(chunk);
        }

        expect(chunks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'delta',
                content: 'I can help with a safer version instead.',
            }),
        ]));
    });

    test('preserves provider reasoning aliases when streaming without the shared gateway helper', async () => {
        const fetchMock = jest.fn(async (url) => {
            if (String(url).endsWith('/api/sessions')) {
                return createJsonResponse({ id: 'session-1' });
            }

            return createSseResponse([
                {
                    choices: [{
                        delta: {
                            content: 'Done.',
                            thought_text: 'Checked the command shape before answering.',
                        },
                    }],
                },
                '[DONE]',
            ], { sessionId: 'session-1' });
        });
        const { api } = loadWebCliApi(fetchMock);

        const chunks = [];
        for await (const chunk of api.streamChat('status please')) {
            chunks.push(chunk);
        }

        expect(chunks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'reasoning_summary_delta',
                content: 'Checked the command shape before answering.',
            }),
            expect.objectContaining({ type: 'delta', content: 'Done.' }),
        ]));
        expect(chunks[chunks.length - 1]).toEqual(expect.objectContaining({
            type: 'done',
            assistantMetadata: expect.objectContaining({
                reasoningSummary: 'Checked the command shape before answering.',
                reasoningAvailable: true,
            }),
        }));
    });

    test('preserves camel-case reasoning summaries in choice deltas without the shared helper', async () => {
        const fetchMock = jest.fn(async (url) => {
            if (String(url).endsWith('/api/sessions')) {
                return createJsonResponse({ id: 'session-1' });
            }

            return createSseResponse([
                {
                    choices: [{
                        delta: {
                            content: 'Ready.',
                            reasoningSummary: 'Verified the deployment state first.',
                        },
                    }],
                },
                '[DONE]',
            ], { sessionId: 'session-1' });
        });
        const { api } = loadWebCliApi(fetchMock);

        const chunks = [];
        for await (const chunk of api.streamChat('is it ready?')) {
            chunks.push(chunk);
        }

        expect(chunks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'reasoning_summary_delta',
                content: 'Verified the deployment state first.',
            }),
            expect.objectContaining({ type: 'delta', content: 'Ready.' }),
        ]));
        expect(chunks[chunks.length - 1]).toEqual(expect.objectContaining({
            type: 'done',
            assistantMetadata: expect.objectContaining({
                reasoningSummary: 'Verified the deployment state first.',
                reasoningAvailable: true,
            }),
        }));
    });
});

describe('web-cli API image model lookup', () => {
    test('accepts image generation capabilities from metadata and contract maps', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                data: [
                    {
                        id: 'gateway-image-model',
                        metadata: {
                            name: 'Gateway Image',
                            capabilities: { image_generation: { supported: true } },
                            sizes: ['auto'],
                        },
                    },
                    {
                        id: 'contract-image-model',
                        contract: {
                            capability_map: { image_generation: 'available' },
                        },
                    },
                    {
                        id: 'contract-supports-image-model',
                        contract: {
                            supports: { image_generation: true },
                        },
                    },
                    {
                        id: 'metadata-supports-image-model',
                        metadata: {
                            supports: { image_generation: { available: true } },
                        },
                    },
                    {
                        id: 'chat-only-model',
                        metadata: {
                            capabilities: { chat: true },
                        },
                    },
                ],
            }),
        }));
        const { api } = loadWebCliApi(fetchMock);

        const models = await api.getImageModels();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(models.map((model) => model.id)).toEqual([
            'gateway-image-model',
            'contract-image-model',
            'contract-supports-image-model',
            'metadata-supports-image-model',
        ]);
        expect(models[0]).toEqual(expect.objectContaining({
            name: 'Gateway Image',
            sizes: ['auto'],
        }));
    });
});
