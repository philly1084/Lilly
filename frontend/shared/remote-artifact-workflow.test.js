'use strict';

const workflow = require('./remote-artifact-workflow');

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
    };
}

describe('remote artifact workflow normalization', () => {
    test('normalizes canonical artifact aliases and confines artifact URLs to safe same-origin routes', () => {
        const secret = 'do-not-expose';
        const artifact = workflow.normalizeArtifact({
            artifact_id: 'artifact-safe-full-id',
            session_id: 'session-1',
            parent_artifact_id: 'artifact-parent-full-id',
            name: 'design.svg',
            extension: '.SVG',
            mime_type: 'image/svg+xml',
            size_bytes: '42',
            download_url: `https://app.example.test/api/artifacts/artifact-safe-full-id/download?token=${secret}&view=1`,
            preview_url: `https://evil.example.test/api/artifacts/artifact-safe-full-id/preview?key=${secret}`,
            sandbox_url: `javascript:alert('${secret}')`,
            bundle_download_url: '/api/artifacts/artifact-other-full-id/bundle',
        }, { baseOrigin: 'https://app.example.test' });

        expect(artifact).toEqual(expect.objectContaining({
            id: 'artifact-safe-full-id',
            artifactId: 'artifact-safe-full-id',
            sessionId: 'session-1',
            parentArtifactId: 'artifact-parent-full-id',
            filename: 'design.svg',
            format: 'svg',
            mimeType: 'image/svg+xml',
            sizeBytes: 42,
            downloadUrl: '/api/artifacts/artifact-safe-full-id/download?view=1',
            previewUrl: '/api/artifacts/artifact-safe-full-id/preview',
            sandboxUrl: '/api/artifacts/artifact-safe-full-id/sandbox',
            bundleDownloadUrl: '/api/artifacts/artifact-safe-full-id/bundle',
        }));
        expect(JSON.stringify(artifact)).not.toContain(secret);
        expect(JSON.stringify(artifact)).not.toContain('evil.example.test');
        expect(JSON.stringify(artifact)).not.toContain('artifact-other-full-id');
        expect(JSON.stringify(artifact)).not.toContain('javascript:');
    });

    test('collects result-file descriptors and separates the aggregate site bundle', () => {
        const collected = workflow.collectRemoteAgentArtifacts({
            artifactIds: ['artifact-diagram-full-id', 'artifact-site-bundle-full-id'],
            resultFiles: [{
                artifactId: 'artifact-diagram-full-id',
                storedFilename: 'design.svg',
                role: 'editable-source',
                relativePath: 'design/design.svg',
            }],
            artifacts: [{
                id: 'artifact-diagram-full-id',
                filename: 'design.svg',
                previewUrl: '/api/artifacts/artifact-diagram-full-id/preview',
            }],
            siteBundleArtifactId: 'artifact-site-bundle-full-id',
        }, { baseOrigin: 'https://app.example.test' });

        expect(collected.siteBundle).toEqual(expect.objectContaining({
            id: 'artifact-site-bundle-full-id',
            filename: 'Website bundle.zip',
            previewUrl: '/api/artifacts/artifact-site-bundle-full-id/preview',
            bundleDownloadUrl: '/api/artifacts/artifact-site-bundle-full-id/bundle',
        }));
        expect(collected.artifacts).toEqual([
            expect.objectContaining({
                id: 'artifact-diagram-full-id',
                filename: 'design.svg',
                role: 'editable-source',
                relativePath: 'design/design.svg',
            }),
        ]);
    });

    test('unwraps remote results, redacts credentials, and marks completed result-file errors blocked', () => {
        const secret = 'do-not-print';
        const result = workflow.normalizeRemoteAgentResult({
            data: {
                completionStatus: 'completed',
                finalOutput: `Published https://deploy-user:${secret}@demo.example.test/?token=${secret}&view=1 key=${secret}`,
                resultFilesError: `client_secret=${secret} invalid SVG`,
                providerId: 'kimi',
                providerModel: 'k3',
                publicUrl: `https://demo.example.test/?X-Amz-Signature=${secret}&view=1#token=${secret}`,
                artifactIds: ['artifact-result-full-id'],
            },
        });

        expect(result).toEqual(expect.objectContaining({
            completionStatus: 'completed',
            effectiveStatus: 'blocked',
            provider: 'kimi',
            providerModel: 'k3',
            publicUrl: 'https://demo.example.test/?view=1',
            artifactIds: ['artifact-result-full-id'],
        }));
        expect(result.finalOutput).toContain('https://demo.example.test/?view=1');
        expect(result.finalOutput).toContain('key=[redacted]');
        expect(result.resultFilesError).toContain('client_secret=[redacted]');
        expect(JSON.stringify(result)).not.toContain(secret);
    });
});

describe('remote artifact workflow request building', () => {
    test('normalizes subdomains and full public hosts consistently across surfaces', () => {
        expect(workflow.getSuggestedDnsLabel({ filename: 'Launch Brief.html' })).toBe('launch-brief');
        expect(workflow.resolveRequestedPublicHost('launch')).toEqual({
            dnsName: 'launch',
            publicHost: 'launch.demoserver2.buzz',
            slug: 'launch',
        });
        expect(workflow.resolveRequestedPublicHost('https://Docs.Example.com/path')).toEqual({
            dnsName: 'docs',
            publicHost: 'docs.example.com',
            slug: 'docs',
        });
        expect(workflow.resolveRequestedPublicHost('---')).toBeNull();
    });

    test('builds one model-bound remote agent request with deduplicated artifact and result paths', () => {
        const contextFiles = [{
            filename: 'brief.xml',
            content: '<brief/>',
            mimeType: 'application/xml',
        }];
        const body = workflow.buildRemoteAgentInvokeBody('Refine the selected design.', {
            browserSessionId: 'session-browser-1',
            clientSurface: 'canvas-excalidraw',
            taskType: 'canvas',
            model: 'kimi-k3',
            artifactIds: ['artifact-source-full-id', 'artifact-source-full-id', 'artifact-style-full-id'],
            contextFiles,
            resultFileGlobs: ['dist/*.html', 'dist/*.html', 'design/*.svg'],
            collectResultFiles: true,
            continuitySummary: 'Continue revision 3.',
            adminMode: true,
            targetId: 'k3s-prod',
            cwd: '/srv/apps/demo',
            metadata: { source: 'canvas-build-with-agent' },
        });

        expect(body).toEqual({
            tool: 'remote-cli-agent',
            params: {
                task: 'Refine the selected design.',
                model: 'kimi-k3',
                cwd: '/srv/apps/demo',
                targetId: 'k3s-prod',
                continuitySummary: 'Continue revision 3.',
                artifactIds: ['artifact-source-full-id', 'artifact-style-full-id'],
                contextFiles,
                resultFileGlobs: ['dist/*.html', 'design/*.svg'],
                collectResultFiles: true,
                adminMode: true,
            },
            sessionId: 'session-browser-1',
            model: 'kimi-k3',
            taskType: 'canvas',
            clientSurface: 'canvas-excalidraw',
            executionProfile: 'remote-build',
            metadata: {
                clientSurface: 'canvas-excalidraw',
                source: 'canvas-build-with-agent',
            },
        });
    });

    test('rejects missing tasks and truncated local file identifiers before invocation', () => {
        expect(() => workflow.buildRemoteAgentParams('', {})).toThrow(expect.objectContaining({
            code: 'REMOTE_AGENT_TASK_REQUIRED',
        }));
        expect(() => workflow.buildRemoteAgentParams('Build it', {
            artifactIds: ['12'],
        })).toThrow(expect.objectContaining({
            code: 'REMOTE_ARTIFACT_ID_INVALID',
        }));
    });
});

describe('managed-app promotion client', () => {
    test('preflights exact final bytes and binds the accepted SHA into the confirmed deploy', async () => {
        const sha256 = 'a'.repeat(64);
        const order = [];
        const fetchImpl = jest.fn(async (url, options) => {
            const pathname = new URL(url).pathname;
            order.push(pathname);
            if (pathname.endsWith('/managed-app/preflight')) {
                return jsonResponse({
                    artifactId: 'artifact-site-bundle-full-id',
                    contentEligible: true,
                    controlPlaneAvailable: true,
                    pushToWebEligible: true,
                    sourceType: 'native-site-archive',
                    targetPaths: ['public/index.html'],
                    fileCount: 1,
                    sizeBytes: 15,
                    sha256,
                    files: [{ path: 'public/index.html', sizeBytes: 15, sha256: 'b'.repeat(64) }],
                    blockers: [],
                });
            }
            if (pathname.endsWith('/managed-app')) {
                return jsonResponse({
                    artifactId: 'artifact-site-bundle-full-id',
                    sourceSha256: sha256,
                    publicHost: 'launch.demoserver2.buzz',
                }, 202);
            }
            throw new Error(`Unexpected URL: ${url}`);
        });
        const client = workflow.createManagedAppClient({
            baseUrl: 'https://app.example.test',
            fetchImpl,
            getSessionId: () => 'session-1',
        });

        const preflight = await client.preflightArtifact('artifact-site-bundle-full-id');
        const deployment = await client.deployArtifact('artifact-site-bundle-full-id', {
            preflight,
            confirmed: true,
            dnsName: 'launch',
            publicBaseDomain: 'demoserver2.buzz',
            publicHost: 'launch.demoserver2.buzz',
        });

        expect(order).toEqual([
            '/api/artifacts/artifact-site-bundle-full-id/managed-app/preflight',
            '/api/artifacts/artifact-site-bundle-full-id/managed-app',
        ]);
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
            sessionId: 'session-1',
            validateOnly: true,
        });
        expect(fetchImpl.mock.calls[0][1]).toEqual(expect.objectContaining({
            credentials: 'same-origin',
            cache: 'no-store',
        }));
        expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
            sessionId: 'session-1',
            requestedAction: 'deploy',
            deployRequested: true,
            expectedSourceSha256: sha256,
            dnsName: 'launch',
            publicBaseDomain: 'demoserver2.buzz',
            publicHost: 'launch.demoserver2.buzz',
        });
        expect(deployment.sourceSha256).toBe(sha256);
    });

    test('does not deploy a blocked, unconfirmed, mismatched, or unhashed preflight', async () => {
        const fetchImpl = jest.fn();
        const client = workflow.createManagedAppClient({
            baseUrl: 'https://app.example.test',
            fetchImpl,
        });
        const eligible = {
            artifactId: 'artifact-site-bundle-full-id',
            pushToWebEligible: true,
            sha256: 'a'.repeat(64),
        };
        const blocked = {
            artifactId: 'artifact-site-bundle-full-id',
            pushToWebEligible: false,
            blockers: [{
                code: 'ARTIFACT_MANAGED_APP_UNSUPPORTED_BINARY_ASSETS',
                message: 'Replace the PNG before deployment.',
                blocker: 'unsupported_binary_assets',
            }],
        };

        await expect(client.deployArtifact('artifact-site-bundle-full-id', {
            preflight: eligible,
        })).rejects.toEqual(expect.objectContaining({
            code: 'MANAGED_APP_DEPLOY_CONFIRMATION_REQUIRED',
        }));
        await expect(client.deployArtifact('artifact-site-bundle-full-id', {
            preflight: blocked,
            confirmed: true,
        })).rejects.toEqual(expect.objectContaining({
            code: 'ARTIFACT_MANAGED_APP_UNSUPPORTED_BINARY_ASSETS',
            blocker: 'unsupported_binary_assets',
        }));
        await expect(client.deployArtifact('artifact-site-bundle-full-id', {
            preflight: eligible,
            expectedSourceSha256: 'b'.repeat(64),
            confirmed: true,
        })).rejects.toEqual(expect.objectContaining({
            code: 'MANAGED_APP_EXPECTED_SOURCE_SHA256_MISMATCH',
        }));
        await expect(client.deployArtifact('artifact-site-bundle-full-id', {
            preflight: {
                artifactId: 'artifact-site-bundle-full-id',
                pushToWebEligible: true,
            },
            confirmed: true,
        })).rejects.toEqual(expect.objectContaining({
            code: 'MANAGED_APP_PREFLIGHT_SHA256_INVALID',
        }));
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('preserves typed auth and stale-source errors from the backend', async () => {
        const sha256 = 'a'.repeat(64);
        const responses = [
            jsonResponse({
                error: {
                    code: 'AUTH_REQUIRED',
                    message: 'Authentication required',
                },
            }, 401),
            jsonResponse({
                error: {
                    code: 'ARTIFACT_MANAGED_APP_SOURCE_CHANGED',
                    message: 'Prepared bytes changed.',
                    blocker: 'managed_app_source_changed',
                    details: {
                        expectedSha256: sha256,
                        actualSha256: 'b'.repeat(64),
                    },
                },
            }, 412),
        ];
        const client = workflow.createManagedAppClient({
            baseUrl: 'https://app.example.test',
            fetchImpl: jest.fn(async () => responses.shift()),
        });

        await expect(client.preflightArtifact('artifact-site-bundle-full-id')).rejects.toEqual(expect.objectContaining({
            code: 'AUTH_REQUIRED',
            status: 401,
            authRequired: true,
        }));
        await expect(client.deployArtifact('artifact-site-bundle-full-id', {
            preflight: {
                artifactId: 'artifact-site-bundle-full-id',
                pushToWebEligible: true,
                sha256,
            },
            confirmed: true,
        })).rejects.toEqual(expect.objectContaining({
            code: 'ARTIFACT_MANAGED_APP_SOURCE_CHANGED',
            status: 412,
            blocker: 'managed_app_source_changed',
            sourceChanged: true,
            details: expect.objectContaining({ expectedSha256: sha256 }),
        }));
    });
});

describe('cross-surface artifact handoff client', () => {
    test('attaches owned source bytes into the destination surface session and adopts its stable id', async () => {
        const sha256 = 'd'.repeat(64);
        const fetchImpl = jest.fn(async () => jsonResponse({
            targetSessionId: 'canvas-session-1',
            sourceArtifactId: 'artifact-source-full-id',
            artifact: {
                id: 'artifact-attached-full-id',
                sessionId: 'canvas-session-1',
                filename: 'design.svg',
                format: 'svg',
                mimeType: 'image/svg+xml',
                downloadUrl: '/api/artifacts/artifact-attached-full-id/download',
            },
            sha256,
            reused: false,
            importCapability: {
                surface: 'canvas-excalidraw',
                format: 'svg',
                disposition: 'context-only',
                browserImportAllowed: false,
                fidelity: 'source-preserved',
                reason: 'SVG remains exact agent context.',
            },
        }, 201));
        const setSessionId = jest.fn();
        const client = workflow.createArtifactHandoffClient({
            baseUrl: 'https://app.example.test',
            fetchImpl,
            getSessionId: () => 'canvas-session-1',
            setSessionId,
        });

        const result = await client.attachArtifact('artifact-source-full-id', {
            mode: 'canvas',
            taskType: 'canvas',
            clientSurface: 'canvas-excalidraw',
        });

        expect(fetchImpl).toHaveBeenCalledWith(
            'https://app.example.test/api/artifacts/artifact-source-full-id/attach',
            expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store' }),
        );
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
            targetSessionId: 'canvas-session-1',
            mode: 'canvas',
            taskType: 'canvas',
            clientSurface: 'canvas-excalidraw',
        });
        expect(result.artifact).toEqual(expect.objectContaining({
            id: 'artifact-attached-full-id',
            sessionId: 'canvas-session-1',
            downloadUrl: '/api/artifacts/artifact-attached-full-id/download',
        }));
        expect(result.importCapability).toEqual(expect.objectContaining({
            disposition: 'context-only',
            browserImportAllowed: false,
        }));
        expect(setSessionId).toHaveBeenCalledWith('canvas-session-1');
    });

    test('rejects a response that silently substitutes a different explicit destination session', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({
            targetSessionId: 'notes-session-fallback',
            sourceArtifactId: 'artifact-source-full-id',
            artifact: {
                id: 'artifact-attached-full-id',
                sessionId: 'notes-session-fallback',
                filename: 'brief.md',
                format: 'md',
            },
            sha256: 'e'.repeat(64),
            reused: false,
        }, 201));
        const setSessionId = jest.fn();
        const client = workflow.createArtifactHandoffClient({
            baseUrl: 'https://app.example.test',
            fetchImpl,
            getSessionId: () => 'notes-session-requested',
            setSessionId,
        });

        await expect(client.attachArtifact('artifact-source-full-id', {
            mode: 'notes',
            taskType: 'notes',
            clientSurface: 'notes-notion',
        })).rejects.toEqual(expect.objectContaining({
            code: 'ARTIFACT_ATTACH_TARGET_SESSION_MISMATCH',
            status: 502,
        }));
        expect(setSessionId).not.toHaveBeenCalled();
    });

    test('preserves typed privacy and integrity failures without exposing source bytes', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({
            error: {
                code: 'ARTIFACT_ATTACH_PRIVACY_SUPPRESSED',
                message: 'Privacy-protected bytes cannot be attached.',
            },
        }, 422));
        const client = workflow.createArtifactHandoffClient({
            baseUrl: 'https://app.example.test',
            fetchImpl,
        });

        await expect(client.attachArtifact('artifact-private-full-id', {
            clientSurface: 'notes-notion',
        })).rejects.toEqual(expect.objectContaining({
            status: 422,
            code: 'ARTIFACT_ATTACH_PRIVACY_SUPPRESSED',
        }));
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty('content');
    });
});
