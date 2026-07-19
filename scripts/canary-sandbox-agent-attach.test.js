'use strict';

const {
    CANARY_VERSION,
    PROGRESS_VERSION,
    SURFACES,
    buildAgentPlan,
    buildAsyncRunPayload,
    createFixtureFiles,
    createHttpClient,
    createSandboxToolPayload,
    parseArguments,
    pollRun,
    runCanary,
    validateCompactAgentResult,
    validateSandboxBundle,
} = require('./canary-sandbox-agent-attach');
const { createZip } = require('../src/utils/zip');

function jsonResponse(payload, status = 200) {
    return new Response(status === 204 ? null : JSON.stringify(payload), {
        status,
        headers: status === 204 ? {} : { 'Content-Type': 'application/json' },
    });
}

function bufferResponse(buffer, contentType = 'application/octet-stream') {
    return new Response(buffer, {
        status: 200,
        headers: {
            'Content-Type': contentType,
            'Content-Length': String(buffer.length),
        },
    });
}

function textResponse(text, contentType = 'text/html; charset=utf-8') {
    return new Response(text, {
        status: 200,
        headers: { 'Content-Type': contentType },
    });
}

function sha256(buffer) {
    return require('crypto').createHash('sha256').update(buffer).digest('hex');
}

function buildSandboxBundle(overrides = {}) {
    const fixtures = createFixtureFiles().map((fixture) => ({
        ...fixture,
        ...(overrides[fixture.path] ? {
            buffer: Buffer.from(overrides[fixture.path], 'utf8'),
        } : {}),
    }));
    return createZip([
        ...fixtures.map((fixture) => ({ name: fixture.path, data: fixture.buffer })),
        {
            name: 'assets/images.json',
            data: `${JSON.stringify({
                images: [{
                    src: './design/design.svg',
                    alt: 'Connected sandbox, CLI, Canvas, and Notes nodes',
                    source: 'html',
                }],
            }, null, 2)}\n`,
        },
        {
            name: 'README.md',
            data: [
                '# Sandbox Agent Attach Canary',
                '',
                `Contract: ${CANARY_VERSION}`,
                '',
                '- index.html',
                '- styles.css',
                '- design/design.xml',
                '- design/design.svg',
                '',
            ].join('\n'),
        },
    ]);
}

function serializeArtifact(record) {
    return {
        id: record.id,
        sessionId: record.sessionId,
        parentArtifactId: record.parentArtifactId ?? null,
        direction: record.direction || 'generated',
        sourceMode: record.sourceMode || 'remote-cli-agent',
        filename: record.filename,
        format: record.format || 'zip',
        mimeType: record.mimeType || 'application/zip',
        sizeBytes: record.buffer.length,
        downloadUrl: `/api/artifacts/${record.id}/download`,
        bundleDownloadUrl: record.bundle ? `/api/artifacts/${record.id}/bundle` : null,
        metadata: record.metadata || {},
    };
}

async function createLiveHarness(options = {}) {
    const bundle = buildSandboxBundle();
    const state = {
        bundle,
        calls: [],
        sessions: new Map(),
        artifacts: new Map(),
        runs: new Map(),
        workspaces: new Set(),
        deletedWorkspaces: [],
        deletedSessions: [],
        runRequests: [],
        attachRequests: [],
        cancelRequests: [],
        pollRequests: [],
        nextRun: 0,
        pollThrowUsed: false,
    };

    function parseRequest(url, init = {}) {
        const parsed = new URL(url);
        let body = null;
        if (init.body) {
            body = JSON.parse(init.body);
        }
        const call = {
            method: String(init.method || 'GET').toUpperCase(),
            pathname: parsed.pathname,
            search: parsed.search,
            body,
            headers: init.headers || {},
        };
        state.calls.push(call);
        return call;
    }

    function buildRunResult(request, runId, artifactId, sourceArtifact) {
        const lane = request.metadata.lane;
        const scenario = request.metadata.scenario;
        const surface = request.metadata.surface || null;
        const origin = scenario === 'sandbox-origin';
        const outputFilename = origin ? 'sandbox-origin.zip' : 'attached-bundle.zip';
        const outputRole = origin ? 'sandbox-source-bundle' : `${surface}-attached-bundle`;
        const provider = lane === 'kimi'
            ? { provider: 'kimi-code-cli', providerModel: 'k3' }
            : {};
        return {
            adapter: 'remote-cli-agent',
            success: true,
            completionStatus: 'completed',
            transport: request.metadata.toolParams.transport,
            model: request.metadata.toolParams.model,
            ...provider,
            artifactIds: [artifactId],
            resultFiles: [{
                filename: outputFilename,
                relativePath: request.metadata.expectedOutputPath,
                mimeType: 'application/zip',
                role: outputRole,
                sizeBytes: sourceArtifact.buffer.length,
                sha256: sha256(sourceArtifact.buffer),
                persistedSha256: sha256(sourceArtifact.buffer),
                artifactId,
            }],
            artifacts: [serializeArtifact(state.artifacts.get(artifactId))],
            artifactQuality: {
                version: 'ArtifactStructuralQuality/v1',
                status: 'passed',
                blockers: [],
            },
            runId,
        };
    }

    async function fetchImpl(url, init = {}) {
        const call = parseRequest(url, init);
        const { method, pathname, body } = call;
        if (method === 'GET' && pathname === '/api/auth/protected-check') {
            expect(init.headers['X-API-Key']).toBe('test-api-key');
            return jsonResponse({ success: true });
        }
        if (method === 'GET' && pathname === '/api/async-lab/status') {
            return jsonResponse({ status: { enabled: true, allowLiveRemote: true } });
        }
        if (method === 'POST' && pathname === '/api/sessions') {
            const id = body.clientSurface === 'sandbox-agent-attach'
                ? 'session-source'
                : (body.clientSurface === 'canvas-excalidraw' ? 'session-canvas' : 'session-notes');
            const session = {
                id,
                scopeKey: body.clientSurface,
                metadata: {
                    ...(body.metadata || {}),
                    ownerId: 'canary-owner',
                    clientSurface: body.clientSurface,
                    taskType: body.taskType,
                    mode: body.mode,
                    memoryScope: body.clientSurface,
                },
            };
            state.sessions.set(id, session);
            return jsonResponse(session, 201);
        }
        if (method === 'DELETE' && /^\/api\/sessions\/[^/]+$/.test(pathname)) {
            const nonTerminal = [...state.runs.values()].filter((run) => !['completed', 'failed', 'cancelled'].includes(run.status));
            if (nonTerminal.length > 0) {
                throw new Error('test detected session cleanup before all runs were terminal');
            }
            const id = decodeURIComponent(pathname.split('/').pop());
            for (const artifact of state.artifacts.values()) {
                const workspaceId = artifact.sessionId === id
                    ? String(artifact.metadata?.sandboxWorkspaceId || '').trim()
                    : '';
                if (workspaceId && options.retainSandboxWorkspace !== true && state.workspaces.delete(workspaceId)) {
                    state.deletedWorkspaces.push(workspaceId);
                }
            }
            state.deletedSessions.push(id);
            state.sessions.delete(id);
            return jsonResponse(null, 204);
        }
        if (method === 'POST' && pathname === '/api/tools/invoke/code-sandbox') {
            expect(body).toMatchObject({
                sessionId: 'session-source',
                mode: 'project',
                language: 'html',
                projectName: 'sandbox-agent-attach-canary',
                entry: 'index.html',
                network: false,
            });
            expect(body.files).toHaveLength(4);
            const workspaceId = 'sandbox-agent-attach-canary-workspace';
            const record = {
                id: 'artifact-sandbox-source',
                sessionId: 'session-source',
                parentArtifactId: null,
                filename: 'sandbox-agent-attach-canary.zip',
                buffer: bundle,
                sourceMode: 'sandbox',
                bundle: true,
                metadata: {
                    createdByAgentTool: true,
                    projectMode: 'frontend',
                    toolId: 'code-sandbox',
                    sandboxWorkspaceId: workspaceId,
                },
            };
            state.artifacts.set(record.id, record);
            state.workspaces.add(workspaceId);
            if (options.sandboxToolFailure === true) {
                return jsonResponse({
                    success: true,
                    sessionId: 'session-source',
                    data: {
                        success: false,
                        error: 'schema failure details are intentionally not exposed by the canary',
                        errorCode: 'TOOL_OUTPUT_SCHEMA_VALIDATION_FAILED',
                        toolId: 'code-sandbox',
                    },
                });
            }
            return jsonResponse({
                success: true,
                sessionId: 'session-source',
                data: {
                    success: true,
                    data: {
                        mode: 'project',
                        exitCode: 0,
                        workspaceId,
                        workspacePreviewUrl: `/api/sandbox-workspaces/${workspaceId}/preview/`,
                        workspaceSandboxUrl: `/api/sandbox-workspaces/${workspaceId}/sandbox`,
                        artifact: serializeArtifact(record),
                        artifactError: null,
                    },
                    toolId: 'code-sandbox',
                },
            });
        }
        const workspacePreviewMatch = pathname.match(/^\/api\/sandbox-workspaces\/([^/]+)\/preview\/?$/);
        if (method === 'GET' && workspacePreviewMatch) {
            const workspaceId = decodeURIComponent(workspacePreviewMatch[1]);
            return state.workspaces.has(workspaceId)
                ? textResponse(`<!doctype html><html><head><meta name="sandbox-agent-attach-canary" content="${CANARY_VERSION}"></head><body>ready</body></html>`)
                : jsonResponse({ error: { message: 'Preview file not found' } }, 404);
        }
        if (method === 'POST' && pathname === '/api/async-lab/runs') {
            state.runRequests.push(body);
            expect(body.adapter).toBe('remote-cli-agent');
            expect(body.liveRemote).toBe(true);
            expect(body.metadata.toolParams).toMatchObject({
                adminMode: false,
                collectResultFiles: true,
            });
            expect(body.metadata.toolParams.artifactIds).toHaveLength(1);
            const sourceArtifactId = body.metadata.toolParams.artifactIds[0];
            const sourceArtifact = state.artifacts.get(sourceArtifactId);
            expect(sourceArtifact).toBeTruthy();
            expect(sourceArtifact.sessionId).toBe(body.sessionId);

            state.nextRun += 1;
            if (options.missingRunId === true && state.nextRun === 1) {
                return jsonResponse({
                    run: {
                        id: '',
                        sessionId: body.sessionId,
                        adapter: 'remote-cli-agent',
                        status: 'queued',
                        liveRemoteAllowed: true,
                        metadata: { remoteAdapter: true, dryRun: false },
                    },
                }, 202);
            }
            const runId = `run-${state.nextRun}`;
            const artifactId = `artifact-result-${state.nextRun}`;
            const resultArtifact = {
                id: artifactId,
                sessionId: body.sessionId,
                parentArtifactId: sourceArtifactId,
                filename: body.metadata.scenario === 'sandbox-origin' ? 'sandbox-origin.zip' : 'attached-bundle.zip',
                buffer: Buffer.from(sourceArtifact.buffer),
                metadata: {
                    remoteAgentHandoff: {
                        version: 'RemoteAgentHandoff/v1',
                        sourceArtifactIds: [sourceArtifactId],
                    },
                },
            };
            state.artifacts.set(artifactId, resultArtifact);
            const toolResult = buildRunResult(body, runId, artifactId, sourceArtifact);
            state.runs.set(runId, {
                id: runId,
                sessionId: body.sessionId,
                adapter: 'remote-cli-agent',
                status: 'queued',
                liveRemoteAllowed: true,
                metadata: { remoteAdapter: true, dryRun: false, toolResult },
                toolResult,
            });
            return jsonResponse({
                run: {
                    id: runId,
                    sessionId: body.sessionId,
                    adapter: 'remote-cli-agent',
                    status: 'queued',
                    liveRemoteAllowed: true,
                    metadata: { remoteAdapter: true, dryRun: false },
                },
            }, 202);
        }
        const runPoll = pathname.match(/^\/api\/async-lab\/runs\/([^/]+)$/);
        if (method === 'GET' && runPoll) {
            const runId = decodeURIComponent(runPoll[1]);
            state.pollRequests.push(runId);
            const run = state.runs.get(runId);
            if (options.pollThrowsOnce === true && !state.pollThrowUsed) {
                state.pollThrowUsed = true;
                throw new Error('simulated poll transport failure');
            }
            run.status = 'completed';
            return jsonResponse({
                run,
                events: [
                    { eventId: `${runId}:1`, cursor: 1, type: 'tool_started' },
                    { eventId: `${runId}:2`, cursor: 2, type: 'tool_completed', payload: { result: run.toolResult } },
                ],
            });
        }
        const runCancel = pathname.match(/^\/api\/async-lab\/runs\/([^/]+)\/cancel$/);
        if (method === 'POST' && runCancel) {
            const runId = decodeURIComponent(runCancel[1]);
            state.cancelRequests.push(runId);
            const run = state.runs.get(runId);
            run.status = 'cancelled';
            return jsonResponse({ run });
        }
        const attachMatch = pathname.match(/^\/api\/artifacts\/([^/]+)\/attach$/);
        if (method === 'POST' && attachMatch) {
            const sourceArtifactId = decodeURIComponent(attachMatch[1]);
            const sourceArtifact = state.artifacts.get(sourceArtifactId);
            const target = state.sessions.get(body.targetSessionId);
            state.attachRequests.push({ sourceArtifactId, ...body });
            if (!target || target.metadata.clientSurface !== body.clientSurface) {
                return jsonResponse({
                    error: {
                        code: 'ARTIFACT_ATTACH_TARGET_SESSION_MISMATCH',
                        message: 'The requested target session does not belong to the requested editing surface.',
                    },
                }, 409);
            }
            const surface = body.clientSurface === 'canvas-excalidraw' ? 'canvas' : 'notes';
            const attachedId = `attached-${sourceArtifactId}-${surface}`;
            const attached = {
                id: attachedId,
                sessionId: target.id,
                parentArtifactId: null,
                direction: 'attached',
                sourceMode: 'artifact-attach',
                filename: sourceArtifact.filename,
                buffer: Buffer.from(sourceArtifact.buffer),
                metadata: {
                    handoffSourceArtifactId: sourceArtifactId,
                    handoffSourceSha256: sha256(sourceArtifact.buffer),
                    provenance: {
                        sourceSessionId: sourceArtifact.sessionId,
                        targetSurface: body.clientSurface,
                    },
                },
            };
            state.artifacts.set(attachedId, attached);
            return jsonResponse({
                targetSessionId: target.id,
                sourceArtifactId,
                sha256: sha256(sourceArtifact.buffer),
                reused: false,
                artifact: serializeArtifact(attached),
                importCapability: {
                    surface: body.clientSurface,
                    disposition: 'context-only',
                    browserImportAllowed: false,
                },
            }, 201);
        }
        const downloadMatch = pathname.match(/^\/api\/artifacts\/([^/]+)\/(?:download|bundle)$/);
        if (method === 'GET' && downloadMatch) {
            const artifact = state.artifacts.get(decodeURIComponent(downloadMatch[1]));
            return artifact
                ? bufferResponse(artifact.buffer, 'application/zip')
                : jsonResponse({ error: { message: 'Artifact not found' } }, 404);
        }
        const artifactMatch = pathname.match(/^\/api\/artifacts\/([^/]+)$/);
        if (method === 'GET' && artifactMatch) {
            const artifact = state.artifacts.get(decodeURIComponent(artifactMatch[1]));
            return artifact
                ? jsonResponse(serializeArtifact(artifact))
                : jsonResponse({ error: { message: 'Artifact not found' } }, 404);
        }
        throw new Error(`Unhandled mock request: ${method} ${pathname}`);
    }

    return { fetchImpl, state };
}

const LIVE_ENV = Object.freeze({
    KIMIBUILT_CANARY_BASE_URL: 'https://kimibuilt.example.test',
    KIMIBUILT_FRONTEND_API_KEY: 'test-api-key',
    KIMIBUILT_CANARY_POLL_INTERVAL_MS: '100',
    KIMIBUILT_CANARY_TIMEOUT_MS: '10000',
    KIMIBUILT_CANARY_REQUEST_TIMEOUT_MS: '30000',
});

describe('sandbox-origin remote agent attach canary', () => {
    test('defaults to a zero-network dry run with both active lanes and both surfaces', async () => {
        const fetchImpl = jest.fn(() => {
            throw new Error('dry run must not fetch');
        });

        const onProgress = jest.fn();
        const result = await runCanary({ argv: [], env: {}, fetchImpl, onProgress });

        expect(result).toMatchObject({
            version: CANARY_VERSION,
            mode: 'all',
            execution: 'dry-run',
            passed: true,
            networkRequestsMade: 0,
            plannedAsyncRuns: 6,
            sandbox: {
                mode: 'project',
                network: false,
                persistedArtifactRequired: true,
                exactDownloadAndBundleValidationRequired: true,
            },
        });
        expect(result.sandbox.requestedFiles.map((file) => file.path)).toEqual([
            'index.html',
            'styles.css',
            'design/design.xml',
            'design/design.svg',
        ]);
        expect(result.lanes.map((lane) => lane.lane)).toEqual(['codex', 'kimi']);
        expect(result.lanes.flatMap((lane) => lane.downstream.map((entry) => entry.surface)))
            .toEqual(['canvas', 'notes', 'canvas', 'notes']);
        expect(result.lanes.every((lane) => lane.origin.adminMode === false)).toBe(true);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(onProgress).not.toHaveBeenCalled();
    });

    test('emits bounded run heartbeats without exposing response payloads', async () => {
        const progress = [];
        const nowValues = [0, 0, 0, 6000, 6000, 12000, 12000];
        const now = jest.fn(() => nowValues.shift() ?? 12000);
        let polls = 0;
        const client = {
            requestJson: jest.fn(async () => {
                polls += 1;
                return {
                    run: { status: polls < 3 ? 'running' : 'completed' },
                    events: [],
                };
            }),
        };

        await expect(pollRun(client, 'run-heartbeat', {
            now,
            timeoutMs: 30000,
            pollIntervalMs: 100,
            progressIntervalMs: 5000,
            sleep: jest.fn(async () => {}),
            onProgress: (entry) => progress.push(entry),
        }, { lane: 'codex', scenario: 'sandbox-origin' })).resolves.toMatchObject({
            status: 'completed',
        });

        expect(progress).toHaveLength(3);
        expect(progress.every((entry) => entry.version === PROGRESS_VERSION)).toBe(true);
        expect(progress.map((entry) => entry.status)).toEqual(['running', 'running', 'completed']);
        expect(progress.map((entry) => entry.elapsedMs)).toEqual([0, 6000, 12000]);
        expect(JSON.stringify(progress)).not.toContain('payload');
    });

    test('parses explicit lane/run options and rejects unsupported arguments', () => {
        expect(parseArguments(['--run', '--mode=kimi'])).toEqual({ run: true, mode: 'kimi', help: false });
        expect(() => parseArguments(['--mode', 'grok'])).toThrow('Mode must be one of: codex, kimi, all.');
        expect(() => parseArguments(['--mode', 'other'])).toThrow('Mode must be one of');
        expect(() => parseArguments(['--deploy'])).toThrow('Unsupported argument');
    });

    test('builds project mode with deterministic files and a non-admin attached-ID agent plan', () => {
        const fixtures = createFixtureFiles();
        const sandboxPayload = createSandboxToolPayload('session-source', fixtures);
        const expectedSha = 'a'.repeat(64);
        const plan = buildAgentPlan({
            lane: 'kimi',
            scenario: 'surface-return',
            surface: SURFACES.canvas,
            sessionId: 'session-canvas',
            sourceArtifactId: 'artifact-attached-canvas',
            expectedSha256: expectedSha,
            expectedSizeBytes: 4096,
            env: {},
        });
        const runPayload = buildAsyncRunPayload(plan);

        expect(sandboxPayload).toMatchObject({
            sessionId: 'session-source',
            mode: 'project',
            language: 'html',
            network: false,
        });
        expect(sandboxPayload.files).toHaveLength(4);
        expect(plan.toolParams).toEqual(expect.objectContaining({
            adminMode: false,
            collectResultFiles: true,
            artifactIds: ['artifact-attached-canvas'],
            model: 'kimi-k3',
            transport: 'provider-agent',
        }));
        expect(plan.toolParams).not.toHaveProperty('contextFiles');
        expect(plan.toolParams).not.toHaveProperty('resultFileGlobs');
        expect(plan.task).toContain(expectedSha);
        expect(plan.task).toContain('Do not deploy, publish');
        expect(runPayload).toMatchObject({
            adapter: 'remote-cli-agent',
            liveRemote: true,
            sessionId: 'session-canvas',
            metadata: {
                scenario: 'surface-return',
                surface: 'canvas',
                sourceArtifactId: 'artifact-attached-canvas',
            },
        });
    });

    test('routes the default Codex canary through the shared provider-agent lane', () => {
        const plan = buildAgentPlan({
            lane: 'codex',
            scenario: 'sandbox-origin',
            sessionId: 'session-codex',
            sourceArtifactId: 'artifact-codex',
            expectedSha256: 'c'.repeat(64),
            expectedSizeBytes: 1024,
            env: {},
        });

        expect(plan.toolParams).toEqual(expect.objectContaining({
            model: 'gpt-5.6-sol',
            transport: 'provider-agent',
        }));
    });

    test('validates exact sandbox ZIP members and rejects one changed project byte stream', async () => {
        const good = buildSandboxBundle();
        await expect(validateSandboxBundle(good)).resolves.toMatchObject({
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            sizeBytes: good.length,
            paths: expect.arrayContaining([
                'index.html',
                'styles.css',
                'design/design.xml',
                'design/design.svg',
                'README.md',
                'assets/images.json',
            ]),
        });

        const changed = buildSandboxBundle({ 'styles.css': 'body { color: red; }\n' });
        await expect(validateSandboxBundle(changed)).rejects.toThrow('changed styles.css');
    });

    test('requires exact provider, role, checksum, path, and compact result fields', () => {
        const plan = buildAgentPlan({
            lane: 'kimi',
            scenario: 'sandbox-origin',
            sessionId: 'session-source',
            sourceArtifactId: 'artifact-source',
            expectedSha256: 'b'.repeat(64),
            expectedSizeBytes: 2048,
            env: {},
        });
        const valid = {
            adapter: 'remote-cli-agent',
            success: true,
            completionStatus: 'completed',
            model: 'kimi-k3',
            transport: 'provider-agent',
            provider: 'kimi-code-cli',
            providerModel: 'k3',
            artifactIds: ['artifact-result'],
            artifactQuality: { status: 'passed', blockers: [] },
            resultFiles: [{
                filename: 'sandbox-origin.zip',
                relativePath: plan.outputRelativePath,
                mimeType: 'application/zip',
                role: 'sandbox-source-bundle',
                sizeBytes: 2048,
                sha256: 'b'.repeat(64),
                persistedSha256: 'b'.repeat(64),
                artifactId: 'artifact-result',
            }],
        };

        expect(validateCompactAgentResult(plan, valid)).toEqual(expect.objectContaining({
            artifactId: 'artifact-result',
        }));
        expect(() => validateCompactAgentResult(plan, {
            ...valid,
            providerModel: 'kimi-other',
        })).toThrow('unexpected provider model');
        expect(() => validateCompactAgentResult(plan, {
            ...valid,
            resultFiles: [{ ...valid.resultFiles[0], sha256: 'c'.repeat(64) }],
        })).toThrow('failed exact-byte');
        expect(() => validateCompactAgentResult(plan, {
            ...valid,
            resultFiles: [{ ...valid.resultFiles[0], contentBase64: 'Zm9yYmlkZGVu' }],
        })).toThrow('forbidden field');
    });

    test('proves the full sandbox, two-lane, Canvas/Notes attach, and attached-ID return flow', async () => {
        const harness = await createLiveHarness();
        const progress = [];

        const result = await runCanary({
            argv: ['--run', '--mode', 'all'],
            env: LIVE_ENV,
            fetchImpl: harness.fetchImpl,
            sleep: jest.fn(async () => {}),
            now: (() => {
                let value = 0;
                return () => ++value;
            })(),
            onProgress: (entry) => progress.push(entry),
        });

        expect(result).toMatchObject({
            version: CANARY_VERSION,
            mode: 'all',
            execution: 'live',
            passed: true,
            authenticated: true,
            asyncRunsTerminal: true,
            ephemeralSessionsDeleted: 3,
            retainedSessionIds: [],
            ephemeralWorkspacesDeleted: 1,
            retainedWorkspaceIds: [],
            negativeAttachGates: {
                canaryOwnedForeignSession: {
                    status: 409,
                    code: 'ARTIFACT_ATTACH_TARGET_SESSION_MISMATCH',
                },
                canaryOwnedWrongSurface: {
                    status: 409,
                    code: 'ARTIFACT_ATTACH_TARGET_SESSION_MISMATCH',
                },
            },
        });
        expect(result.sandboxSource).toMatchObject({
            artifactId: 'artifact-sandbox-source',
            workspaceId: 'sandbox-agent-attach-canary-workspace',
            workspacePreviewVerified: true,
            sha256: sha256(harness.state.bundle),
            sizeBytes: harness.state.bundle.length,
        });
        expect(result.lanes).toHaveLength(2);
        expect(result.lanes.every((lane) => (
            lane.sandboxOrigin.sha256 === result.sandboxSource.sha256
            && lane.attached.canvas.sha256 === result.sandboxSource.sha256
            && lane.attached.notes.sha256 === result.sandboxSource.sha256
            && lane.downstream.canvas.sha256 === result.sandboxSource.sha256
            && lane.downstream.notes.sha256 === result.sandboxSource.sha256
        ))).toBe(true);

        expect(harness.state.runRequests).toHaveLength(6);
        expect(harness.state.runRequests.every((request) => (
            request.metadata.toolParams.adminMode === false
            && request.metadata.toolParams.artifactIds.length === 1
            && !Object.hasOwn(request.metadata.toolParams, 'contextFiles')
        ))).toBe(true);
        const originRequests = harness.state.runRequests.filter((request) => request.metadata.scenario === 'sandbox-origin');
        const downstreamRequests = harness.state.runRequests.filter((request) => request.metadata.scenario === 'surface-return');
        expect(originRequests).toHaveLength(2);
        expect(originRequests.every((request) => (
            request.sessionId === 'session-source'
            && request.metadata.toolParams.artifactIds[0] === 'artifact-sandbox-source'
        ))).toBe(true);
        expect(downstreamRequests).toHaveLength(4);
        expect(downstreamRequests.every((request) => {
            const sourceId = request.metadata.toolParams.artifactIds[0];
            const source = harness.state.artifacts.get(sourceId);
            return source?.direction === 'attached' && source.sessionId === request.sessionId;
        })).toBe(true);
        expect(harness.state.attachRequests).toHaveLength(6);
        expect(harness.state.attachRequests.slice(0, 2)).toEqual([
            expect.objectContaining({
                targetSessionId: 'session-source',
                clientSurface: 'notes',
            }),
            expect.objectContaining({
                targetSessionId: 'session-notes',
                clientSurface: 'canvas-excalidraw',
            }),
        ]);
        expect(harness.state.deletedSessions).toEqual(['session-notes', 'session-canvas', 'session-source']);
        expect(harness.state.deletedWorkspaces).toEqual(['sandbox-agent-attach-canary-workspace']);
        expect(harness.state.workspaces.size).toBe(0);
        expect(harness.state.cancelRequests).toEqual([]);
        expect(progress.filter((entry) => entry.event === 'run_started')).toHaveLength(6);
        expect(progress.filter((entry) => entry.event === 'run_progress')).toHaveLength(6);
        expect(progress.filter((entry) => entry.event === 'run_completed')).toHaveLength(6);
        expect(progress.filter((entry) => entry.event === 'attachment_completed')).toHaveLength(4);
        expect(progress.map((entry) => entry.event)).toEqual(expect.arrayContaining([
            'canary_started',
            'sandbox_source_verified',
            'cleanup_started',
            'cleanup_completed',
            'canary_completed',
        ]));
        expect(JSON.stringify(progress)).not.toContain(LIVE_ENV.KIMIBUILT_FRONTEND_API_KEY);
    });

    test('reports a safe sandbox failure code and cleans up before any agent run starts', async () => {
        const harness = await createLiveHarness({ sandboxToolFailure: true });

        await expect(runCanary({
            argv: ['--run', '--mode', 'codex'],
            env: LIVE_ENV,
            fetchImpl: harness.fetchImpl,
        })).rejects.toThrow(
            'tool-failed:TOOL_OUTPUT_SCHEMA_VALIDATION_FAILED',
        );

        expect(harness.state.runRequests).toEqual([]);
        expect(harness.state.deletedSessions).toEqual(['session-source']);
        expect(harness.state.workspaces.size).toBe(0);
    });

    test('fails cleanup when a proven sandbox workspace remains after its session is deleted', async () => {
        const harness = await createLiveHarness({ retainSandboxWorkspace: true });

        await expect(runCanary({
            argv: ['--run', '--mode', 'codex'],
            env: LIVE_ENV,
            fetchImpl: harness.fetchImpl,
            sleep: jest.fn(async () => {}),
            now: (() => {
                let value = 0;
                return () => ++value;
            })(),
        })).rejects.toThrow(/workspace .* preview remained available with HTTP 200/i);

        expect(harness.state.deletedSessions).toEqual(['session-notes', 'session-canvas', 'session-source']);
        expect(harness.state.workspaces).toEqual(new Set(['sandbox-agent-attach-canary-workspace']));
    });

    test('cancels and proves an active run terminal before deleting any canary session', async () => {
        const harness = await createLiveHarness({ pollThrowsOnce: true });

        await expect(runCanary({
            argv: ['--run', '--mode', 'codex'],
            env: LIVE_ENV,
            fetchImpl: harness.fetchImpl,
            sleep: jest.fn(async () => {}),
            now: (() => {
                let value = 0;
                return () => ++value;
            })(),
        })).rejects.toThrow('simulated poll transport failure');

        expect(harness.state.cancelRequests).toEqual(['run-1']);
        expect(harness.state.runs.get('run-1').status).toBe('cancelled');
        expect(harness.state.deletedSessions).toEqual(['session-source']);
        const cancelIndex = harness.state.calls.findIndex((call) => call.pathname === '/api/async-lab/runs/run-1/cancel');
        const deleteIndex = harness.state.calls.findIndex((call) => call.pathname === '/api/sessions/session-source');
        expect(cancelIndex).toBeGreaterThan(-1);
        expect(deleteIndex).toBeGreaterThan(cancelIndex);
    });

    test('retains all sessions when an accepted remote run cannot be tracked to terminal', async () => {
        const harness = await createLiveHarness({ missingRunId: true });

        await expect(runCanary({
            argv: ['--run', '--mode', 'codex'],
            env: LIVE_ENV,
            fetchImpl: harness.fetchImpl,
            sleep: jest.fn(async () => {}),
            now: () => 0,
        })).rejects.toThrow(/accepted without a trackable run ID.*sessions retained/i);

        expect(harness.state.deletedSessions).toEqual([]);
        expect(harness.state.calls.some((call) => call.method === 'DELETE')).toBe(false);
    });

    test('HTTP client confines calls to the configured API origin and refuses redirects', async () => {
        const baseUrl = new URL('https://kimibuilt.example.test');
        const redirectClient = createHttpClient({
            baseUrl,
            apiKey: 'secret-test-key',
            requestTimeoutMs: 1000,
            fetchImpl: jest.fn(async () => new Response(null, {
                status: 302,
                headers: { Location: 'https://evil.example.test/' },
            })),
        });

        await expect(redirectClient.requestJson('/api/auth/protected-check'))
            .rejects.toThrow('refused an HTTP redirect');
        await expect(redirectClient.requestJson('https://evil.example.test/api/auth/protected-check'))
            .rejects.toThrow('non-KimiBuilt or non-API URL');
        expect(redirectClient.networkRequestsMade).toBe(1);
    });
});
