'use strict';

const {
    KubernetesClient,
    buildManagedAppImageEvidence,
    normalizeOciSha256Digest,
} = require('./kubernetes-client');

const TEST_IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;

function createDeploySshTool({
    applyStdout = '',
    inspectionStdout = '',
    applyExitCode = 0,
    inspectionExitCode = 0,
    host = 'deploy.example:22',
} = {}) {
    return {
        handler: jest.fn()
            .mockResolvedValueOnce({
                stdout: applyStdout,
                stderr: '',
                exitCode: applyExitCode,
                host,
            })
            .mockResolvedValueOnce({
                stdout: inspectionStdout,
                stderr: '',
                exitCode: inspectionExitCode,
                host,
            }),
    };
}

function buildInspectionStdout(overrides = {}) {
    const values = {
        expectedHost: 'demo.demoserver2.buzz',
        expectedService: 'demo',
        expectedServicePort: '80',
        expectedContainerPort: '80',
        deploymentPresent: 'true',
        servicePresent: 'true',
        ingressPresent: 'true',
        deploymentImage: `registry.gitlab.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
        deploymentContainerPort: '80',
        servicePort: '80',
        serviceTargetPort: '80',
        podName: 'demo-abc123',
        podImage: `registry.gitlab.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
        podImageID: `docker-pullable://registry.gitlab.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
        podPhase: 'Running',
        podWaitingReason: '',
        podWaitingMessage: '',
        podTerminatedReason: '',
        podTerminatedMessage: '',
        ingressHost: 'demo.demoserver2.buzz',
        ingressBackendService: 'demo',
        ingressBackendPort: '80',
        ingressClass: 'traefik',
        ingressAddress: '10.0.0.10',
        ingressHostMatches: 'true',
        ingressBackendMatches: 'true',
        serviceTargetMatches: 'true',
        tlsSecret: 'true',
        certificateName: 'demo-cert',
        certificateReady: 'true',
        certificateStatus: 'True',
        certificateMessage: '',
        traefikReady: 'true',
        appProbeAttempted: 'true',
        appProbeOk: 'true',
        appProbeStatus: '200',
        appProbeError: '',
        appProbeBody: '',
        ...overrides,
    };
    const lines = [
        `__KIMIBUILT_EXPECTED_HOST__=${values.expectedHost}`,
        `__KIMIBUILT_EXPECTED_SERVICE__=${values.expectedService}`,
        `__KIMIBUILT_EXPECTED_SERVICE_PORT__=${values.expectedServicePort}`,
        `__KIMIBUILT_EXPECTED_CONTAINER_PORT__=${values.expectedContainerPort}`,
        `__KIMIBUILT_DEPLOYMENT_PRESENT__=${values.deploymentPresent}`,
        `__KIMIBUILT_SERVICE_PRESENT__=${values.servicePresent}`,
        `__KIMIBUILT_INGRESS_PRESENT__=${values.ingressPresent}`,
        `__KIMIBUILT_DEPLOYMENT_IMAGE__=${values.deploymentImage}`,
        `__KIMIBUILT_DEPLOYMENT_CONTAINER_PORT__=${values.deploymentContainerPort}`,
        `__KIMIBUILT_SERVICE_PORT__=${values.servicePort}`,
        `__KIMIBUILT_SERVICE_TARGET_PORT__=${values.serviceTargetPort}`,
        `__KIMIBUILT_POD_NAME__=${values.podName}`,
        `__KIMIBUILT_POD_IMAGE__=${values.podImage}`,
        `__KIMIBUILT_POD_IMAGE_ID__=${values.podImageID}`,
        `__KIMIBUILT_POD_PHASE__=${values.podPhase}`,
        `__KIMIBUILT_POD_WAITING_REASON__=${values.podWaitingReason}`,
        `__KIMIBUILT_POD_WAITING_MESSAGE__=${values.podWaitingMessage}`,
        `__KIMIBUILT_POD_TERMINATED_REASON__=${values.podTerminatedReason}`,
        `__KIMIBUILT_POD_TERMINATED_MESSAGE__=${values.podTerminatedMessage}`,
        `__KIMIBUILT_INGRESS_HOST__=${values.ingressHost}`,
        `__KIMIBUILT_INGRESS_BACKEND_SERVICE__=${values.ingressBackendService}`,
        `__KIMIBUILT_INGRESS_BACKEND_PORT__=${values.ingressBackendPort}`,
        `__KIMIBUILT_INGRESS_CLASS__=${values.ingressClass}`,
        `__KIMIBUILT_INGRESS_ADDRESS__=${values.ingressAddress}`,
        `__KIMIBUILT_INGRESS_HOST_MATCHES__=${values.ingressHostMatches}`,
        `__KIMIBUILT_INGRESS_BACKEND_MATCHES__=${values.ingressBackendMatches}`,
        `__KIMIBUILT_SERVICE_TARGET_MATCHES__=${values.serviceTargetMatches}`,
        `__KIMIBUILT_TLS_SECRET__=${values.tlsSecret}`,
        `__KIMIBUILT_CERTIFICATE_NAME__=${values.certificateName}`,
        `__KIMIBUILT_CERTIFICATE_READY__=${values.certificateReady}`,
        `__KIMIBUILT_CERTIFICATE_STATUS__=${values.certificateStatus}`,
        `__KIMIBUILT_CERTIFICATE_MESSAGE__=${values.certificateMessage}`,
        `__KIMIBUILT_TRAEFIK_READY__=${values.traefikReady}`,
        `__KIMIBUILT_APP_PROBE_ATTEMPTED__=${values.appProbeAttempted}`,
        `__KIMIBUILT_APP_PROBE_OK__=${values.appProbeOk}`,
        `__KIMIBUILT_APP_PROBE_STATUS__=${values.appProbeStatus}`,
        `__KIMIBUILT_APP_PROBE_ERROR__=${values.appProbeError}`,
        `__KIMIBUILT_APP_PROBE_BODY__=${values.appProbeBody}`,
    ];
    for (const item of Array.isArray(values.challengeSummary) ? values.challengeSummary : []) {
        lines.push(`__KIMIBUILT_CHALLENGE__=${item}`);
    }
    for (const item of Array.isArray(values.ingressEvents) ? values.ingressEvents : []) {
        lines.push(`__KIMIBUILT_INGRESS_EVENT__=${item}`);
    }
    for (const item of Array.isArray(values.traefikLogExcerpt) ? values.traefikLogExcerpt : []) {
        lines.push(`__KIMIBUILT_TRAEFIK_LOG__=${item}`);
    }
    return lines.join('\n');
}

describe('KubernetesClient', () => {
    test('normalizes only OCI sha256 digests from runtime image IDs', () => {
        expect(normalizeOciSha256Digest(`containerd://${TEST_IMAGE_DIGEST}`)).toBe(TEST_IMAGE_DIGEST);
        expect(normalizeOciSha256Digest(`docker-pullable://registry.example.test/team/app@${TEST_IMAGE_DIGEST}`)).toBe(TEST_IMAGE_DIGEST);
        expect(normalizeOciSha256Digest('sha-abcdef123456')).toBe('');
        expect(normalizeOciSha256Digest('a'.repeat(64))).toBe('');
        expect(normalizeOciSha256Digest(`prefix ${TEST_IMAGE_DIGEST}`)).toBe('');
    });

    test('rejects a runtime digest that conflicts with a digest-pinned request', () => {
        const expectedDigest = `sha256:${'b'.repeat(64)}`;
        const evidence = buildManagedAppImageEvidence({
            requestedImage: `registry.example.test/team/app@${expectedDigest}`,
            deploymentImage: `registry.example.test/team/app@${expectedDigest}`,
            podImage: `registry.example.test/team/app@${expectedDigest}`,
            podImageID: `containerd://${TEST_IMAGE_DIGEST}`,
        });

        expect(evidence).toEqual(expect.objectContaining({
            expectedDigest,
            observedDigest: TEST_IMAGE_DIGEST,
            digestPinnedRequest: true,
            matchesExpectedDigest: false,
            verified: false,
        }));
        expect(evidence.error).toContain('conflict with requested image digest');
    });

    test('rejects a tag-only request even when the running pod exposes an OCI digest', () => {
        const requestedImage = 'registry.example.test/team/app:sha-abcdef123456';
        const evidence = buildManagedAppImageEvidence({
            requestedImage,
            deploymentImage: requestedImage,
            podImage: requestedImage,
            podImageID: `containerd://${TEST_IMAGE_DIGEST}`,
        });

        expect(evidence).toEqual(expect.objectContaining({
            expectedDigest: '',
            observedDigest: TEST_IMAGE_DIGEST,
            digestPinnedRequest: false,
            matchesExpectedDigest: false,
            verified: false,
        }));
        expect(evidence.error).toContain('not pinned');
    });

    test('deployManagedApp uses SSH when the deployment target is ssh', async () => {
        const sshTool = createDeploySshTool({
            inspectionStdout: buildInspectionStdout(),
        });
        const client = new KubernetesClient({
            managedAppsConfig: {
                deployTarget: 'ssh',
                httpsVerifyTimeoutMs: 5000,
            },
            sshTool,
            deployConfigProvider: () => ({
                ingressClassName: 'traefik',
                tlsClusterIssuer: 'letsencrypt-prod',
            }),
        });

        client.waitForHttps = jest.fn(async () => ({
            ok: true,
            status: 200,
            attemptsCompleted: true,
        }));
        client.isSshConfigured = jest.fn(() => true);

        const result = await client.deployManagedApp({
            slug: 'demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            image: `registry.gitlab.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            containerPort: 80,
            registryPullSecretName: 'gitlab-registry-credentials',
            registryHost: 'registry.gitlab.demoserver2.buzz',
            registryUsername: 'builder',
            registryPassword: 'secret',
            deploymentTarget: 'ssh',
        });

        expect(sshTool.handler).toHaveBeenNthCalledWith(1, expect.objectContaining({
            command: expect.stringContaining('kubectl_cmd apply -f -'),
            timeout: 180000,
        }), {}, expect.any(Object));
        expect(sshTool.handler).toHaveBeenNthCalledWith(2, expect.objectContaining({
            command: expect.stringContaining('__KIMIBUILT_EXPECTED_HOST__'),
        }), {}, expect.any(Object));
        expect(result.rollout.ok).toBe(true);
        expect(result.verification.ingress).toBe(true);
        expect(result.verification.tls).toBe(true);
        expect(result.verification.imageDigest).toBe(true);
        expect(result.verification.publicHttps).toBe(true);
        expect(result.verification.https).toBe(true);
        expect(result.imageDigest).toBe(TEST_IMAGE_DIGEST);
        expect(result.diagnostics).toEqual(expect.objectContaining({
            deploymentImage: `registry.gitlab.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            imageDigest: TEST_IMAGE_DIGEST,
            podStatus: expect.objectContaining({
                image: `registry.gitlab.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
                imageID: `docker-pullable://registry.gitlab.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            }),
        }));
        expect(result.executionHost).toBe('deploy.example:22');
    });

    test('deployManagedApp does not mark HTTPS verified without an observed pod image digest', async () => {
        const sshTool = createDeploySshTool({
            inspectionStdout: buildInspectionStdout({
                podImageID: '',
            }),
        });
        const client = new KubernetesClient({
            managedAppsConfig: {
                deployTarget: 'ssh',
                httpsVerifyTimeoutMs: 5000,
            },
            sshTool,
        });

        client.waitForHttps = jest.fn(async () => ({
            ok: true,
            status: 200,
            attemptsCompleted: true,
        }));
        client.isSshConfigured = jest.fn(() => true);

        const result = await client.deployManagedApp({
            slug: 'demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            image: `registry.gitlab.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            deploymentTarget: 'ssh',
        });

        expect(result.verification).toEqual(expect.objectContaining({
            rollout: true,
            publicHttps: true,
            imageDigest: false,
            https: false,
        }));
        expect(result.imageDigest).toBe('');
        expect(result.diagnostics.imageDigestError).toContain('pod imageID');
    });

    test('deployManagedApp fails digest verification when a pinned image resolves to another digest', async () => {
        const expectedDigest = `sha256:${'b'.repeat(64)}`;
        const requestedImage = `registry.gitlab.demoserver2.buzz/agent-apps/demo@${expectedDigest}`;
        const sshTool = createDeploySshTool({
            inspectionStdout: buildInspectionStdout({
                deploymentImage: requestedImage,
                podImage: requestedImage,
                podImageID: `containerd://${TEST_IMAGE_DIGEST}`,
            }),
        });
        const client = new KubernetesClient({
            managedAppsConfig: {
                deployTarget: 'ssh',
                httpsVerifyTimeoutMs: 5000,
            },
            sshTool,
        });

        client.waitForHttps = jest.fn(async () => ({
            ok: true,
            status: 200,
            attemptsCompleted: true,
        }));
        client.isSshConfigured = jest.fn(() => true);

        const result = await client.deployManagedApp({
            slug: 'demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            image: requestedImage,
            deploymentTarget: 'ssh',
        });

        expect(result.verification.imageDigest).toBe(false);
        expect(result.verification.https).toBe(false);
        expect(result.imageEvidence).toEqual(expect.objectContaining({
            expectedDigest,
            observedDigest: TEST_IMAGE_DIGEST,
            matchesExpectedDigest: false,
        }));
    });

    test('deployManagedApp normalizes legacy namespaces to the managed app namespace prefix', async () => {
        const sshTool = createDeploySshTool({
            inspectionStdout: buildInspectionStdout(),
        });
        const client = new KubernetesClient({
            managedAppsConfig: {
                deployTarget: 'ssh',
                namespacePrefix: 'app-',
                httpsVerifyTimeoutMs: 5000,
            },
            sshTool,
            deployConfigProvider: () => ({
                ingressClassName: 'traefik',
                tlsClusterIssuer: 'letsencrypt-prod',
            }),
        });

        client.waitForHttps = jest.fn(async () => ({
            ok: true,
            status: 200,
            attemptsCompleted: true,
        }));
        client.isSshConfigured = jest.fn(() => true);

        const result = await client.deployManagedApp({
            slug: 'demo',
            namespace: 'managed-app',
            publicHost: 'demo.demoserver2.buzz',
            image: `registry.gitlab.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            containerPort: 80,
            registryPullSecretName: 'gitlab-registry-credentials',
            registryHost: 'registry.gitlab.demoserver2.buzz',
            registryUsername: 'builder',
            registryPassword: 'secret',
            deploymentTarget: 'ssh',
        });

        expect(sshTool.handler).toHaveBeenNthCalledWith(1, expect.objectContaining({
            command: expect.stringContaining('"name": "app-demo"'),
        }), {}, expect.any(Object));
        expect(result.namespace).toBe('app-demo');
    });

    test('deployManagedApp builds the pull secret from the remote platform runtime secret', async () => {
        const sshTool = createDeploySshTool({
            inspectionStdout: buildInspectionStdout(),
        });
        const client = new KubernetesClient({
            managedAppsConfig: {
                platformNamespace: 'agent-platform',
                httpsVerifyTimeoutMs: 5000,
            },
            sshTool,
        });

        client.waitForHttps = jest.fn(async () => ({
            ok: true,
            status: 200,
            attemptsCompleted: true,
        }));
        client.isSshConfigured = jest.fn(() => true);

        await client.deployManagedApp({
            slug: 'demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            image: `registry.gitlab.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            registryPullSecretName: 'gitlab-registry-credentials',
            registryHost: 'registry.gitlab.demoserver2.buzz',
            registryUsername: 'stale-user',
            registryPassword: 'stale-password',
            deploymentTarget: 'ssh',
        });

        const applyCommand = sshTool.handler.mock.calls[0][0].command;
        expect(applyCommand).toContain('runtime_secret_name=\'agent-platform-runtime\'');
        expect(applyCommand).toContain('secret_value gitlab-registry-password');
        expect(applyCommand).toContain('kubectl_cmd create secret docker-registry "$registry_secret_name"');
        expect(applyCommand.indexOf('kubectl_cmd create secret docker-registry "$registry_secret_name"')).toBeLessThan(
            applyCommand.indexOf('"kind": "Deployment"'),
        );
        expect(applyCommand).not.toContain('.dockerconfigjson');
    });

    test('deployManagedApp ignores legacy in-cluster targets and still uses SSH', async () => {
        const sshTool = createDeploySshTool({
            inspectionStdout: buildInspectionStdout(),
        });
        const client = new KubernetesClient({
            managedAppsConfig: {
                deployTarget: 'in-cluster',
                httpsVerifyTimeoutMs: 5000,
            },
            sshTool,
            deployConfigProvider: () => ({
                ingressClassName: 'traefik',
                tlsClusterIssuer: 'letsencrypt-prod',
            }),
        });

        client.waitForHttps = jest.fn(async () => ({
            ok: true,
            status: 200,
            attemptsCompleted: true,
        }));
        client.isSshConfigured = jest.fn(() => true);

        const result = await client.deployManagedApp({
            slug: 'demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            image: `registry.gitlab.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            deploymentTarget: 'in-cluster',
        });

        expect(sshTool.handler).toHaveBeenCalledTimes(2);
        expect(sshTool.handler).toHaveBeenNthCalledWith(2, expect.objectContaining({
            command: expect.stringContaining('__KIMIBUILT_TRAEFIK_READY__'),
        }), {}, expect.any(Object));
        expect(result.rollout.ok).toBe(true);
    });

    test('deployManagedApp treats public HTTPS 404 as a failed verification with diagnostics', async () => {
        const sshTool = createDeploySshTool({
            inspectionStdout: buildInspectionStdout({
                tlsSecret: 'true',
                certificateReady: 'true',
                appProbeOk: 'true',
                appProbeStatus: '200',
            }),
        });
        const client = new KubernetesClient({
            managedAppsConfig: {
                deployTarget: 'ssh',
            },
            sshTool,
        });

        client.waitForHttps = jest.fn(async () => ({
            ok: false,
            status: 404,
            bodyPreview: 'not found',
            attemptsCompleted: true,
        }));
        client.isSshConfigured = jest.fn(() => true);

        const result = await client.deployManagedApp({
            slug: 'demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            image: `registry.gitlab.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            deploymentTarget: 'ssh',
        });

        expect(result.verification.rollout).toBe(true);
        expect(result.verification.ingress).toBe(true);
        expect(result.verification.tls).toBe(true);
        expect(result.verification.https).toBe(false);
        expect(result.diagnostics.httpsStatus).toBe(404);
        expect(result.diagnostics.appProbe.ok).toBe(true);
        expect(result.diagnostics.ingressHostMatches).toBe(true);
    });

    test('deployManagedApp surfaces missing TLS secret and cert-manager diagnostics', async () => {
        const sshTool = createDeploySshTool({
            inspectionStdout: buildInspectionStdout({
                tlsSecret: 'false',
                certificateReady: 'false',
                certificateStatus: 'False',
                certificateMessage: 'Waiting for DNS-01 challenge propagation',
                challengeSummary: ['demo-tls|pending|Waiting for DNS propagation'],
                ingressEvents: ['Warning PresentError challenge not yet valid'],
            }),
        });
        const client = new KubernetesClient({
            managedAppsConfig: {
                deployTarget: 'ssh',
            },
            sshTool,
        });

        client.waitForHttps = jest.fn(async () => ({
            ok: false,
            error: 'certificate not available',
            attemptsCompleted: true,
        }));
        client.isSshConfigured = jest.fn(() => true);

        const result = await client.deployManagedApp({
            slug: 'demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            image: `registry.gitlab.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            deploymentTarget: 'ssh',
        });

        expect(result.verification.tls).toBe(false);
        expect(result.tlsStatus.certificateReady).toBe(false);
        expect(result.tlsStatus.challengeSummary).toEqual(expect.arrayContaining([
            expect.stringContaining('pending'),
        ]));
        expect(result.tlsStatus.ingressEvents).toEqual(expect.arrayContaining([
            expect.stringContaining('PresentError'),
        ]));
    });

    test('deployManagedApp marks ingress verification false when host or backend mismatches', async () => {
        const sshTool = createDeploySshTool({
            inspectionStdout: buildInspectionStdout({
                ingressHost: 'wrong.demoserver2.buzz',
                ingressBackendService: 'other-service',
                ingressHostMatches: 'false',
                ingressBackendMatches: 'false',
                appProbeOk: 'false',
                appProbeStatus: '404',
            }),
        });
        const client = new KubernetesClient({
            managedAppsConfig: {
                deployTarget: 'ssh',
            },
            sshTool,
        });

        client.waitForHttps = jest.fn(async () => ({
            ok: false,
            status: 404,
            attemptsCompleted: true,
        }));
        client.isSshConfigured = jest.fn(() => true);

        const result = await client.deployManagedApp({
            slug: 'demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            image: `registry.gitlab.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            deploymentTarget: 'ssh',
        });

        expect(result.verification.ingress).toBe(false);
        expect(result.diagnostics.ingressHost).toBe('wrong.demoserver2.buzz');
        expect(result.diagnostics.ingressBackendService).toBe('other-service');
        expect(result.diagnostics.ingressHostMatches).toBe(false);
        expect(result.diagnostics.ingressBackendMatches).toBe(false);
    });

    test('deployManagedApp still inspects pod state when rollout fails so image pull errors are visible', async () => {
        const sshTool = createDeploySshTool({
            applyExitCode: 1,
            inspectionStdout: buildInspectionStdout({
                deploymentPresent: 'true',
                servicePresent: 'true',
                ingressPresent: 'true',
                podPhase: 'Pending',
                podWaitingReason: 'ErrImagePull',
                podWaitingMessage: 'failed to authorize: unexpected status from GET request to https://registry.gitlab.demoserver2.buzz/v2/token: 401 Unauthorized',
                tlsSecret: 'false',
                certificateReady: 'false',
                appProbeAttempted: 'false',
                appProbeOk: 'false',
                appProbeStatus: '0',
            }),
        });
        const client = new KubernetesClient({
            managedAppsConfig: {
                deployTarget: 'ssh',
            },
            sshTool,
        });

        client.waitForHttps = jest.fn(async () => ({
            ok: false,
            error: 'Rollout failed before HTTPS verification started.',
            attemptsCompleted: false,
        }));
        client.isSshConfigured = jest.fn(() => true);

        const result = await client.deployManagedApp({
            slug: 'demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            image: `registry.gitlab.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            deploymentTarget: 'ssh',
        });

        expect(result.rollout.ok).toBe(false);
        expect(result.diagnostics.podStatus).toEqual(expect.objectContaining({
            phase: 'Pending',
            waitingReason: 'ErrImagePull',
            waitingMessage: expect.stringContaining('401 Unauthorized'),
        }));
    });

    test('inspectManagedAppPlatform reads remote GitLab runner health from the SSH target', async () => {
        const sshTool = {
            handler: jest.fn(async () => ({
                stdout: [
                    '__KIMIBUILT_HOSTNAME__=deploy-node-1',
                    '__KIMIBUILT_REMOTE_USER__=ubuntu',
                    '__KIMIBUILT_REMOTE_ARCH__=aarch64',
                    '__KIMIBUILT_OS_SUMMARY__=Ubuntu 24.04.2 LTS',
                    '__KIMIBUILT_K3S_VERSION__=k3s version v1.30.6+k3s1',
                    '__KIMIBUILT_NODE__=deploy-node-1',
                    '__KIMIBUILT_PLATFORM_INGRESS_CLASS__=traefik',
                    '__KIMIBUILT_PLATFORM_TRAEFIK__=true',
                    '__KIMIBUILT_PLATFORM_CERT_MANAGER__=true',
                    '__KIMIBUILT_PLATFORM_NAMESPACE__=agent-platform',
                    '__KIMIBUILT_PLATFORM_NAMESPACE_EXISTS__=true',
                    '__KIMIBUILT_DEPLOYMENT__=gitlab|present|1|1|1|1',
                    '__KIMIBUILT_DEPLOYMENT__=buildkitd|present|1|1|1|1',
                    '__KIMIBUILT_DEPLOYMENT__=gitlab-runner|present|1|0|0|0',
                    '__KIMIBUILT_SECRET__=gitlab-runner|present',
                    '__KIMIBUILT_RUNNER_TOKEN__=placeholder',
                    '__KIMIBUILT_RUNNER_LABELS__=kimibuilt,buildkit',
                    '__KIMIBUILT_GITLAB_INSTANCE_URL__=https://gitlab.demoserver2.buzz',
                    '__KIMIBUILT_GITLAB_INGRESS_HOST__=gitlab.demoserver2.buzz',
                    '__KIMIBUILT_RUNNER_LOG__=registration token invalid',
                ].join('\n'),
                stderr: '',
                exitCode: 0,
                host: 'deploy.example:22',
            })),
        };
        const client = new KubernetesClient({
            managedAppsConfig: {
                platformNamespace: 'agent-platform',
            },
            sshTool,
        });

        client.isSshConfigured = jest.fn(() => true);

        const result = await client.inspectManagedAppPlatform({
            platformNamespace: 'agent-platform',
            deploymentTarget: 'ssh',
        });

        expect(sshTool.handler).toHaveBeenCalledWith(expect.objectContaining({
            command: expect.stringContaining('deployment_status gitlab-runner'),
            timeout: 120000,
        }), {}, expect.any(Object));
        expect(result.platformNamespace).toBe('agent-platform');
        expect(result.namespaceExists).toBe(true);
        expect(result.deployments.gitlab.ready).toBe(true);
        expect(result.deployments['gitlab-runner'].ready).toBe(false);
        expect(result.runnerTokenState).toBe('placeholder');
        expect(result.runnerLabels).toBe('kimibuilt,buildkit');
        expect(result.gitlabInstanceUrl).toBe('https://gitlab.demoserver2.buzz');
        expect(result.runnerLogExcerpt).toContain('registration token invalid');
        expect(result.executionHost).toBe('deploy.example:22');
        expect(result.serverContext).toEqual(expect.objectContaining({
            hostname: 'deploy-node-1',
            remoteUser: 'ubuntu',
            arch: 'aarch64',
            osSummary: 'Ubuntu 24.04.2 LTS',
            k3sVersion: 'k3s version v1.30.6+k3s1',
            ingressClasses: expect.arrayContaining(['traefik']),
            nodeNames: expect.arrayContaining(['deploy-node-1']),
            traefikInstalled: true,
            certManagerInstalled: true,
        }));
    });

    test('reconcileManagedAppPlatform updates the runner secret and restarts gitlab-runner over SSH', async () => {
        const sshTool = {
            handler: jest.fn(async () => ({
                stdout: [
                    '__KIMIBUILT_PLATFORM_NAMESPACE__=agent-platform',
                    '__KIMIBUILT_RECONCILE_ACTION__=gitlab-runner-secret-applied',
                    '__KIMIBUILT_RECONCILE_ACTION__=gitlab-runner-tags-set',
                    '__KIMIBUILT_RECONCILE_ACTION__=gitlab-runner-instance-url-set',
                    '__KIMIBUILT_RECONCILE_ACTION__=gitlab-runner-scaled-1',
                    '__KIMIBUILT_RECONCILE_ACTION__=gitlab-runner-restarted',
                ].join('\n'),
                stderr: '',
                exitCode: 0,
                host: 'deploy.example:22',
            })),
        };
        const client = new KubernetesClient({
            managedAppsConfig: {
                platformNamespace: 'agent-platform',
            },
            sshTool,
        });

        client.isSshConfigured = jest.fn(() => true);

        const result = await client.reconcileManagedAppPlatform({
            platformNamespace: 'agent-platform',
            deploymentTarget: 'ssh',
            desiredRunnerReplicas: 1,
            runnerRegistrationToken: 'runner-token-123',
            runnerLabels: 'kimibuilt,buildkit',
            gitlabInstanceUrl: 'https://gitlab.demoserver2.buzz',
        });

        expect(sshTool.handler).toHaveBeenCalledWith(expect.objectContaining({
            command: expect.stringContaining('"runner-token": "runner-token-123"'),
            timeout: 180000,
        }), {}, expect.any(Object));
        expect(result.actions).toEqual(expect.arrayContaining([
            'gitlab-runner-secret-applied',
            'gitlab-runner-scaled-1',
            'gitlab-runner-restarted',
        ]));
        expect(result.executionHost).toBe('deploy.example:22');
    });
});
