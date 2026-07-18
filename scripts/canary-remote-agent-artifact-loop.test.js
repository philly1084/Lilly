'use strict';

const crypto = require('crypto');
const JSZip = require('jszip');
const {
    buildLanePlan,
    createHttpClient,
    createFixtures,
    runCanary,
    validateCompactToolResult,
} = require('./canary-remote-agent-artifact-loop');

function jsonResponse(payload, status = 200) {
    return new Response(status === 204 ? null : JSON.stringify(payload), {
        status,
        headers: status === 204 ? {} : { 'Content-Type': 'application/json' },
    });
}

function bufferResponse(buffer, contentType = 'application/octet-stream') {
    return new Response(buffer, { status: 200, headers: { 'Content-Type': contentType } });
}

function buildCompactResult(plan, prefix) {
    const provider = plan.lane === 'kimi'
        ? 'kimi-code-cli'
        : (plan.lane === 'grok' ? 'grok-build-cli' : 'codex');
    const providerModel = plan.lane === 'kimi'
        ? 'k3'
        : (plan.lane === 'grok' ? 'grok-build' : null);
    const resultFiles = plan.fixtures.map((fixture, index) => ({
        artifactId: `artifact-${prefix}-component-${index + 1}`,
        filename: fixture.filename,
        relativePath: `${plan.outputRoot}/${fixture.outputPath}`,
        mimeType: fixture.mimeType,
        role: fixture.role,
        sizeBytes: fixture.sizeBytes,
        sha256: fixture.sha256,
    }));
    const siteBundleArtifactId = `artifact-${prefix}-site-bundle`;
    return {
        adapter: 'remote-cli-agent',
        success: true,
        completionStatus: 'completed',
        provider,
        ...(providerModel ? { providerModel } : {}),
        model: plan.model,
        transport: plan.transport,
        artifactIds: [...resultFiles.map((file) => file.artifactId), siteBundleArtifactId],
        resultFiles,
        siteBundleArtifactId,
        artifactQuality: {
            version: 'ArtifactStructuralQuality/v1',
            status: 'passed',
            blockers: [],
            site: { enabled: true, entries: [`${plan.outputRoot}/index.html`], checkedReferences: 3 },
        },
        artifacts: [
            ...resultFiles.map((file) => ({
                id: file.artifactId,
                filename: file.filename,
                mimeType: file.mimeType,
                downloadUrl: `/api/artifacts/${file.artifactId}/download`,
            })),
            {
                id: siteBundleArtifactId,
                filename: 'remote-agent-site.zip',
                mimeType: 'application/zip',
                downloadUrl: `/api/artifacts/${siteBundleArtifactId}/download`,
                bundleDownloadUrl: `/api/artifacts/${siteBundleArtifactId}/bundle`,
                previewUrl: `/api/artifacts/${siteBundleArtifactId}/preview`,
            },
        ],
    };
}

function managedAppFingerprintFromRequest(body) {
    return {
        artifactId: 'artifact-hop-2-site-bundle',
        contentEligible: true,
        controlPlaneAvailable: true,
        pushToWebEligible: true,
        sourceType: 'native-site-archive',
        fileCount: body.expectedFiles.length,
        sizeBytes: body.expectedFiles.reduce((total, file) => total + file.sizeBytes, 0),
        sha256: body.expectedSourceSha256,
        files: body.expectedFiles.map((file) => ({
            path: `public/${file.path}`,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
        })).sort((left, right) => left.path.localeCompare(right.path)),
        blockers: [],
    };
}

describe('remote agent artifact-loop canary', () => {
    test('defaults to a deterministic two-hop, three-lane dry run with zero network requests', async () => {
        const fetchImpl = jest.fn(() => {
            throw new Error('dry-run must not call fetch');
        });
        const result = await runCanary({ argv: [], env: {}, fetchImpl });

        expect(result).toEqual(expect.objectContaining({
            version: 'RemoteAgentArtifactLoopCanary/v1',
            mode: 'all',
            execution: 'dry-run',
            passed: true,
            networkRequestsMade: 0,
        }));
        expect(result.lanes.map((lane) => lane.lane)).toEqual(['codex', 'kimi', 'grok']);
        expect(result.lanes.every((lane) => lane.bidirectionalRoundTripPlanned && lane.hops.length === 2)).toBe(true);
        expect(result.lanes.every((lane) => lane.hops.every((hop) => hop.payloadValid && hop.adminMode === false))).toBe(true);
        expect(result.lanes.every((lane) => lane.hops.every((hop) => hop.fixtureCount === 4))).toBe(true);
        expect(result.lanes[0].hops[0].inputMode).toBe('inline-fixtures');
        expect(result.lanes[0].hops[1].inputMode).toBe('session-artifacts');
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain('<!doctype html>');
    });

    test('requires resolved provider-model evidence for the Kimi K3 lane', () => {
        const plan = buildLanePlan('kimi', {}, { hop: 1 });
        const result = buildCompactResult(plan, 'kimi-proof');

        expect(validateCompactToolResult(plan, result)).toEqual(expect.objectContaining({
            provider: 'kimi-code-cli',
            providerModel: 'k3',
            model: 'kimi-k3',
        }));
        delete result.providerModel;
        expect(() => validateCompactToolResult(plan, result)).toThrow(
            'The Kimi canary did not attest the resolved K3 provider model.',
        );
    });

    test('keeps the request abort deadline active while a response body is still streaming', async () => {
        let bodyAbortObserved = false;
        const fetchImpl = jest.fn(async (_url, options = {}) => new Response(new ReadableStream({
            start(controller) {
                options.signal.addEventListener('abort', () => {
                    bodyAbortObserved = true;
                    controller.error(new Error('body stream aborted'));
                }, { once: true });
                setTimeout(() => {
                    if (!options.signal.aborted) {
                        controller.enqueue(new TextEncoder().encode('{"success":true}'));
                        controller.close();
                    }
                }, 50);
            },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        const client = createHttpClient({
            baseUrl: new URL('https://kimibuilt.example.test'),
            apiKey: 'body-timeout-key',
            requestTimeoutMs: 10,
            fetchImpl,
        });

        await expect(client.requestJson('/api/auth/protected-check')).rejects.toThrow('body stream aborted');
        expect(bodyAbortObserved).toBe(true);
    });

    test('proves an authenticated two-hop live lane, final bytes, preview, preflight, and cleanup', async () => {
        const apiKey = 'frontend-api-key-for-test';
        const env = {
            KIMIBUILT_CANARY_BASE_URL: 'https://kimibuilt.example.test',
            KIMIBUILT_FRONTEND_API_KEY: apiKey,
            KIMIBUILT_CANARY_CODEX_MODEL: 'codex-canary',
            KIMIBUILT_CANARY_POLL_INTERVAL_MS: '100',
        };
        const firstPlan = buildLanePlan('codex', env, { hop: 1 });
        const firstResult = buildCompactResult(firstPlan, 'hop-1');
        const secondPlan = buildLanePlan('codex', env, {
            hop: 2,
            sourceArtifacts: firstResult.resultFiles,
        });
        const secondResult = buildCompactResult(secondPlan, 'hop-2');
        const resultsByRun = new Map([
            ['run-hop-1', { plan: firstPlan, result: firstResult }],
            ['run-hop-2', { plan: secondPlan, result: secondResult }],
        ]);
        const fixtureByArtifactId = new Map();
        for (const { plan, result } of resultsByRun.values()) {
            result.resultFiles.forEach((file, index) => fixtureByArtifactId.set(file.artifactId, plan.fixtures[index]));
        }
        const zip = new JSZip();
        firstPlan.fixtures.forEach((fixture) => zip.file(fixture.outputPath, fixture.buffer));
        const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
        const calls = [];
        let runPostCount = 0;

        const fetchImpl = jest.fn(async (url, options = {}) => {
            const parsed = new URL(url);
            const method = options.method || 'GET';
            const body = options.body ? JSON.parse(options.body) : null;
            calls.push({
                method,
                path: `${parsed.pathname}${parsed.search}`,
                headers: new Headers(options.headers),
                body,
                redirect: options.redirect,
            });
            if (method === 'GET' && parsed.pathname === '/api/auth/protected-check') {
                return jsonResponse({ success: true, user: { username: 'canary' } });
            }
            if (method === 'GET' && parsed.pathname === '/api/async-lab/status') {
                return jsonResponse({ status: { enabled: true, allowLiveRemote: true } });
            }
            if (method === 'POST' && parsed.pathname === '/api/sessions') {
                return jsonResponse({ id: 'session-canary-1' }, 201);
            }
            if (method === 'POST' && parsed.pathname === '/api/async-lab/runs') {
                runPostCount += 1;
                const id = `run-hop-${runPostCount}`;
                return jsonResponse({
                    run: {
                        id,
                        status: 'queued',
                        liveRemoteAllowed: true,
                        metadata: { remoteAdapter: true, dryRun: false },
                    },
                    events: [],
                }, 202);
            }
            const runMatch = parsed.pathname.match(/^\/api\/async-lab\/runs\/(run-hop-[12])$/);
            if (method === 'GET' && runMatch) {
                const record = resultsByRun.get(runMatch[1]);
                return jsonResponse({
                    run: {
                        id: runMatch[1],
                        status: 'completed',
                        liveRemoteAllowed: true,
                        metadata: { remoteAdapter: true, dryRun: false, toolResult: record.result },
                    },
                    events: [
                        { eventId: `${runMatch[1]}-started`, cursor: 1, type: 'tool_started', status: 'running' },
                        { eventId: `${runMatch[1]}-tool`, cursor: 2, type: 'tool_completed', status: 'running' },
                        { eventId: `${runMatch[1]}-done`, cursor: 3, type: 'completed', status: 'completed' },
                    ],
                });
            }
            const artifactLookup = parsed.pathname.match(/^\/api\/artifacts\/(artifact-hop-[12]-(?:component-\d+|site-bundle))$/);
            if (method === 'GET' && artifactLookup) {
                const id = artifactLookup[1];
                const isBundle = id.endsWith('site-bundle');
                return jsonResponse({
                    id,
                    sessionId: 'session-canary-1',
                    downloadUrl: `/api/artifacts/${id}/download`,
                    ...(isBundle ? {
                        bundleDownloadUrl: `/api/artifacts/${id}/bundle`,
                        previewUrl: `/api/artifacts/${id}/preview`,
                    } : {}),
                });
            }
            const componentDownload = parsed.pathname.match(/^\/api\/artifacts\/(artifact-hop-[12]-component-\d+)\/download$/);
            if (method === 'GET' && componentDownload) {
                const fixture = fixtureByArtifactId.get(componentDownload[1]);
                return bufferResponse(fixture.buffer, fixture.mimeType);
            }
            if (method === 'GET' && /^\/api\/artifacts\/artifact-hop-[12]-site-bundle\/bundle$/.test(parsed.pathname)) {
                return bufferResponse(zipBuffer, 'application/zip');
            }
            if (method === 'GET' && /^\/api\/artifacts\/artifact-hop-[12]-site-bundle\/preview$/.test(parsed.pathname)) {
                const rewrittenPreview = firstPlan.fixtures[0].content.replace(
                    '<head>',
                    '<head><base href="/api/artifacts/preview/">',
                );
                return bufferResponse(Buffer.from(rewrittenPreview), 'text/html');
            }
            if (method === 'POST' && parsed.pathname === '/api/artifacts/artifact-hop-2-site-bundle/managed-app/preflight') {
                return jsonResponse(managedAppFingerprintFromRequest(body));
            }
            if (method === 'DELETE' && parsed.pathname === '/api/sessions/session-canary-1') {
                return jsonResponse(null, 204);
            }
            throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
        });

        const result = await runCanary({
            argv: ['--run', '--mode', 'codex'],
            env,
            fetchImpl,
            sleep: jest.fn(),
        });

        expect(result).toEqual(expect.objectContaining({
            mode: 'codex',
            execution: 'live',
            passed: true,
            networkRequestsMade: 31,
            ephemeralSessionDeleted: true,
            bidirectionalRoundTrip: true,
        }));
        expect(result.lanes).toEqual([expect.objectContaining({
            lane: 'codex',
            bidirectionalRoundTrip: true,
            fixtureCount: 4,
            managedAppPreflight: 'passed',
            hops: [
                expect.objectContaining({ hop: 1, liveRemoteExecutionProved: true, componentDownloadsVerified: 4 }),
                expect.objectContaining({ hop: 2, liveRemoteExecutionProved: true, componentDownloadsVerified: 4, managedAppPreflight: 'passed' }),
            ],
        })]);
        expect(calls.every((call) => call.headers.get('X-API-Key') === apiKey)).toBe(true);
        expect(calls.every((call) => call.headers.get('Authorization') === null)).toBe(true);
        expect(calls.every((call) => call.redirect === 'manual')).toBe(true);
        const runCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/async-lab/runs');
        expect(runCalls).toHaveLength(2);
        expect(runCalls.every((call) => call.body.targetKey === 'k3s-prod')).toBe(true);
        expect(runCalls.every((call) => call.body.metadata.toolParams.adminMode === false)).toBe(true);
        expect(runCalls.every((call) => !Object.hasOwn(call.body.metadata.toolParams, 'sessionId'))).toBe(true);
        expect(runCalls.every((call) => !Object.hasOwn(call.body.metadata.toolParams, 'resultFileGlobs'))).toBe(true);
        expect(runCalls[0].body.metadata.toolParams.contextFiles).toHaveLength(4);
        expect(runCalls[1].body.metadata.toolParams.artifactIds).toEqual(firstResult.resultFiles.map((file) => file.artifactId));
        const preflightCall = calls.find((call) => call.path.endsWith('/managed-app/preflight'));
        expect(preflightCall.body.expectedSourceSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(preflightCall.body.expectedFiles).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'design/design.xml', role: 'site-file' }),
            expect.objectContaining({ path: 'design/design.svg', role: 'site-file' }),
        ]));
        expect(calls.at(-1)).toEqual(expect.objectContaining({
            method: 'DELETE',
            path: '/api/sessions/session-canary-1',
        }));
        expect(calls.some((call) => call.path === '/api/artifacts/artifact-hop-2-site-bundle/managed-app')).toBe(false);
    });

    test('cancels, polls terminal, then deletes the ephemeral session after a run polling error', async () => {
        const apiKey = 'cleanup-api-key-for-test';
        const env = {
            KIMIBUILT_CANARY_BASE_URL: 'https://kimibuilt.example.test',
            KIMIBUILT_FRONTEND_API_KEY: apiKey,
        };
        const calls = [];
        let runGetCount = 0;
        const fetchImpl = jest.fn(async (url, options = {}) => {
            const parsed = new URL(url);
            const method = options.method || 'GET';
            calls.push(`${method} ${parsed.pathname}`);
            if (method === 'GET' && parsed.pathname === '/api/auth/protected-check') {
                return jsonResponse({ success: true });
            }
            if (method === 'GET' && parsed.pathname === '/api/async-lab/status') {
                return jsonResponse({ status: { enabled: true, allowLiveRemote: true } });
            }
            if (method === 'POST' && parsed.pathname === '/api/sessions') {
                return jsonResponse({ id: 'session-cleanup-1' }, 201);
            }
            if (method === 'POST' && parsed.pathname === '/api/async-lab/runs') {
                return jsonResponse({
                    run: {
                        id: 'run-cleanup-1',
                        status: 'queued',
                        liveRemoteAllowed: true,
                        metadata: { remoteAdapter: true, dryRun: false },
                    },
                    events: [],
                }, 202);
            }
            if (method === 'GET' && parsed.pathname === '/api/async-lab/runs/run-cleanup-1') {
                runGetCount += 1;
                if (runGetCount === 1) {
                    throw new Error(`poll socket failed with token=${apiKey}`);
                }
                return jsonResponse({ run: { id: 'run-cleanup-1', status: 'cancelled' }, events: [] });
            }
            if (method === 'POST' && parsed.pathname === '/api/async-lab/runs/run-cleanup-1/cancel') {
                return jsonResponse({ run: { id: 'run-cleanup-1', status: 'running' }, changed: true });
            }
            if (method === 'DELETE' && parsed.pathname === '/api/sessions/session-cleanup-1') {
                return jsonResponse(null, 204);
            }
            throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
        });

        await expect(runCanary({
            argv: ['--run', '--mode=grok'],
            env,
            fetchImpl,
            sleep: jest.fn(),
        })).rejects.toThrow(/poll socket failed with token=\[redacted\]/);

        expect(calls).toEqual([
            'GET /api/auth/protected-check',
            'GET /api/async-lab/status',
            'POST /api/sessions',
            'POST /api/async-lab/runs',
            'GET /api/async-lab/runs/run-cleanup-1',
            'POST /api/async-lab/runs/run-cleanup-1/cancel',
            'GET /api/async-lab/runs/run-cleanup-1',
            'DELETE /api/sessions/session-cleanup-1',
        ]);
        expect(JSON.stringify(calls)).not.toContain(apiKey);
    });

    test('retains the session when cancellation cannot be proven terminal', async () => {
        const env = {
            KIMIBUILT_CANARY_BASE_URL: 'https://kimibuilt.example.test',
            KIMIBUILT_FRONTEND_API_KEY: 'retain-api-key',
        };
        const calls = [];
        const fetchImpl = jest.fn(async (url, options = {}) => {
            const parsed = new URL(url);
            const method = options.method || 'GET';
            calls.push(`${method} ${parsed.pathname}`);
            if (parsed.pathname === '/api/auth/protected-check') return jsonResponse({ success: true });
            if (parsed.pathname === '/api/async-lab/status') return jsonResponse({ status: { enabled: true, allowLiveRemote: true } });
            if (method === 'POST' && parsed.pathname === '/api/sessions') return jsonResponse({ id: 'session-retain-1' }, 201);
            if (method === 'POST' && parsed.pathname === '/api/async-lab/runs') {
                return jsonResponse({
                    run: { id: 'run-retain-1', liveRemoteAllowed: true, metadata: { remoteAdapter: true, dryRun: false } },
                    events: [],
                }, 202);
            }
            if (method === 'POST' && parsed.pathname.endsWith('/cancel')) {
                return jsonResponse({ run: { id: 'run-retain-1', status: 'running' }, changed: true });
            }
            if (method === 'GET' && parsed.pathname === '/api/async-lab/runs/run-retain-1') {
                throw new Error('run state unavailable');
            }
            throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
        });

        await expect(runCanary({
            argv: ['--run', '--mode=codex'],
            env,
            fetchImpl,
            sleep: jest.fn(),
        })).rejects.toThrow(/session session-retain-1 was retained/i);
        expect(calls).not.toContain('DELETE /api/sessions/session-retain-1');
    });

    test('keeps fixture bytes stable across repeated construction', () => {
        const first = createFixtures();
        const second = createFixtures();
        expect(second.map((fixture) => fixture.sha256)).toEqual(first.map((fixture) => fixture.sha256));
        expect(second.every((fixture, index) => fixture.buffer.equals(first[index].buffer))).toBe(true);
        expect(second.every((fixture) => crypto.createHash('sha256').update(fixture.buffer).digest('hex') === fixture.sha256)).toBe(true);
    });
});
