'use strict';

const fs = require('fs');
const https = require('https');
const { config } = require('../config');
const settingsController = require('../routes/admin/settings.controller');
const { SSHExecuteTool } = require('../agent-sdk/tools/categories/ssh/SSHExecuteTool');
const { RunnerCommandTransport, getPreferredRemoteTransport } = require('../remote-runner/transport');

function normalizeText(value = '') {
    return String(value || '').trim();
}

const OCI_SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;

function normalizeOciSha256Digest(value = '') {
    const normalized = normalizeText(value);
    if (!normalized || /\s/.test(normalized)) {
        return '';
    }

    if (OCI_SHA256_DIGEST_PATTERN.test(normalized)) {
        return normalized.toLowerCase();
    }

    const imageRefDigest = extractOciSha256DigestFromImageRef(normalized);
    if (imageRefDigest) {
        return imageRefDigest;
    }

    const imageIdMatch = normalized.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@\s]+@)?(sha256:[a-f0-9]{64})$/i);
    return imageIdMatch?.[1] ? imageIdMatch[1].toLowerCase() : '';
}

function extractOciSha256DigestFromImageRef(value = '') {
    const normalized = normalizeText(value);
    if (!normalized || /\s/.test(normalized)) {
        return '';
    }

    const match = normalized.match(/@(sha256:[a-f0-9]{64})$/i);
    return match?.[1] ? match[1].toLowerCase() : '';
}

function buildManagedAppImageEvidence({
    requestedImage = '',
    deploymentImage = '',
    podImage = '',
    podImageID = '',
} = {}) {
    const normalizedRequestedImage = normalizeText(requestedImage);
    const normalizedDeploymentImage = normalizeText(deploymentImage);
    const normalizedPodImage = normalizeText(podImage);
    const expectedDigest = extractOciSha256DigestFromImageRef(normalizedRequestedImage);
    const deploymentDigest = extractOciSha256DigestFromImageRef(normalizedDeploymentImage);
    const podSpecDigest = extractOciSha256DigestFromImageRef(normalizedPodImage);
    const observedDigest = normalizeOciSha256Digest(podImageID);
    const deploymentImageMatches = Boolean(normalizedRequestedImage && normalizedDeploymentImage === normalizedRequestedImage);
    const podImageMatches = Boolean(normalizedDeploymentImage && normalizedPodImage === normalizedDeploymentImage);
    const conflictingDigests = [deploymentDigest, podSpecDigest, observedDigest]
        .filter(Boolean)
        .filter((digest) => expectedDigest && digest !== expectedDigest);
    let error = '';

    if (!deploymentImageMatches) {
        error = `Kubernetes Deployment image ${normalizedDeploymentImage || '(missing)'} does not match requested image ${normalizedRequestedImage || '(missing)'}.`;
    } else if (!podImageMatches) {
        error = `Kubernetes pod image ${normalizedPodImage || '(missing)'} does not match Deployment image ${normalizedDeploymentImage}.`;
    } else if (!expectedDigest) {
        error = 'Requested Kubernetes image was not pinned to a canonical OCI sha256 digest.';
    } else if (!observedDigest) {
        error = 'Kubernetes pod imageID did not contain an OCI sha256 digest.';
    } else if (conflictingDigests.length > 0) {
        error = `Observed Kubernetes image digests conflict with requested image digest ${expectedDigest}; pod imageID resolved to ${observedDigest}.`;
    }

    return {
        requestedImage: normalizedRequestedImage,
        deploymentImage: normalizedDeploymentImage,
        podImage: normalizedPodImage,
        podImageID: normalizeText(podImageID),
        observedDeploymentImage: normalizedDeploymentImage,
        observedPodImage: normalizedPodImage,
        observedImageID: normalizeText(podImageID),
        expectedDigest,
        observedDigest,
        observedImageDigest: observedDigest,
        digestPinnedRequest: Boolean(expectedDigest),
        deploymentImageMatches,
        podImageMatches,
        matchesExpectedDigest: Boolean(expectedDigest && observedDigest === expectedDigest && conflictingDigests.length === 0),
        verified: Boolean(expectedDigest && deploymentImageMatches && podImageMatches && observedDigest === expectedDigest && conflictingDigests.length === 0),
        error,
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeKubernetesName(value = '', fallback = 'managed-app') {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
    return normalized || fallback;
}

function buildDockerConfigJson({ registryHost = '', username = '', password = '' } = {}) {
    const auth = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    return JSON.stringify({
        auths: {
            [registryHost]: {
                username,
                password,
                auth,
            },
        },
    });
}

function normalizeDeployTarget(value = '') {
    const normalized = normalizeText(value).toLowerCase();
    if (['runner', 'remote-runner', 'remote_runner', 'agent-runner', 'agent_runner'].includes(normalized)) {
        return 'runner';
    }
    if (['ssh', 'remote', 'remote-ssh', 'remote_ssh'].includes(normalized)) {
        return 'ssh';
    }
    if (['in-cluster', 'in_cluster', 'cluster', 'local-cluster', 'local_cluster'].includes(normalized)) {
        return 'ssh';
    }
    return '';
}

function normalizeNamespacePrefix(value = 'app-') {
    const stem = sanitizeKubernetesName(String(value || '').replace(/-+$/g, ''), 'app');
    return stem ? `${stem}-` : 'app-';
}

function normalizeManagedAppNamespace(value = '', slug = '', namespacePrefix = 'app-') {
    const prefix = normalizeNamespacePrefix(namespacePrefix);
    const normalizedValue = sanitizeKubernetesName(value, '');
    if (normalizedValue && normalizedValue.startsWith(prefix)) {
        return normalizedValue;
    }

    const normalizedSlug = sanitizeKubernetesName(slug, '');
    const shouldUseSlug = normalizedSlug && (
        !normalizedValue
        || normalizedValue === 'managed-app'
        || normalizedValue === 'managed-apps'
        || normalizedValue === 'default'
    );
    const base = shouldUseSlug
        ? normalizedSlug
        : (normalizedValue || normalizedSlug || 'managed-app');
    return sanitizeKubernetesName(`${prefix}${base}`, 'managed-apps');
}

function parseInteger(value, fallback = 0) {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function escapeRegExp(value = '') {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readMarkerValue(text = '', marker = '') {
    const match = String(text || '').match(new RegExp(`^${escapeRegExp(marker)}=(.*)$`, 'm'));
    return match?.[1] ? String(match[1]).trim() : '';
}

function readMarkerValues(text = '', marker = '') {
    const prefix = `${String(marker || '').trim()}=`;
    return String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(prefix.length).trim())
        .filter(Boolean);
}

function createNoopTracker() {
    return {
        recordExecution() {},
        recordNetworkCall() {},
    };
}

function parseBooleanMarkerValue(text = '', marker = '') {
    return /^true$/i.test(readMarkerValue(text, marker));
}

function normalizeMarkerBoolean(value = '') {
    const normalized = normalizeText(value).toLowerCase();
    if (normalized === 'true') {
        return true;
    }
    if (normalized === 'false') {
        return false;
    }
    return null;
}

function summarizeShellPreview(value = '', maxLength = 200) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return '';
    }
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(32, maxLength - 1)).trimEnd()}…`;
}

class KubernetesClient {
    constructor(options = {}) {
        this.config = options.config || config.kubernetes;
        this.managedAppsConfig = options.managedAppsConfig || config.managedApps || {};
        this.deployConfig = options.deployConfigProvider || (() => (
            typeof settingsController.getEffectiveDeployConfig === 'function'
                ? settingsController.getEffectiveDeployConfig()
                : {}
        ));
        this.sshTool = options.sshTool || new SSHExecuteTool({
            id: 'ssh-execute-managed-app-internal',
            name: 'Managed App SSH Internal',
            description: 'Internal SSH helper for managed app deployments',
        });
        this.runnerTransport = options.runnerTransport || new RunnerCommandTransport();
    }

    resolveDeployTarget(value = '') {
        return normalizeDeployTarget(value) || getPreferredRemoteTransport() || 'ssh';
    }

    isInClusterConfigured() {
        return this.config.enabled !== false
            && Boolean(this.config.serviceHost)
            && fs.existsSync(this.config.tokenPath);
    }

    isSshConfigured() {
        const ssh = typeof settingsController.getEffectiveSshConfig === 'function'
            ? settingsController.getEffectiveSshConfig()
            : {};
        return Boolean(ssh.enabled && ssh.host && ssh.username && (ssh.password || ssh.privateKeyPath));
    }

    isConfigured(deploymentTarget = '') {
        const target = this.resolveDeployTarget(deploymentTarget);
        return target === 'runner'
            ? (this.runnerTransport.isAvailable() || this.isSshConfigured())
            : this.isSshConfigured();
    }

    async executeRemoteCommand(params = {}, context = {}, tracker = createNoopTracker()) {
        const target = this.resolveDeployTarget(params.deploymentTarget || params.deployTarget);
        if (target === 'runner' && this.runnerTransport.isAvailable()) {
            return this.runnerTransport.execute({
                ...params,
                profile: params.profile || 'deploy',
            }, context, tracker);
        }

        return this.sshTool.handler(params, context, tracker);
    }

    getApiBaseUrl() {
        const host = normalizeText(this.config.serviceHost || 'kubernetes.default.svc');
        const port = Number(this.config.servicePort) || 443;
        return `https://${host}:${port}`;
    }

    getAgent() {
        const ca = fs.existsSync(this.config.caPath)
            ? fs.readFileSync(this.config.caPath)
            : undefined;
        return new https.Agent({
            ca,
            rejectUnauthorized: this.config.verifyTls !== false,
        });
    }

    getAuthToken() {
        return fs.readFileSync(this.config.tokenPath, 'utf8').trim();
    }

    async request(method, pathname, body = null, { allowNotFound = false } = {}) {
        if (!this.isInClusterConfigured()) {
            throw new Error('Managed app deployment requires an in-cluster Kubernetes service account.');
        }

        const url = new URL(pathname, `${this.getApiBaseUrl()}/`);

        return new Promise((resolve, reject) => {
            const request = https.request(url, {
                method,
                agent: this.getAgent(),
                headers: {
                    Authorization: `Bearer ${this.getAuthToken()}`,
                    Accept: 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
            }, (response) => {
                let data = '';
                response.on('data', (chunk) => {
                    data += chunk.toString();
                });
                response.on('end', () => {
                    if (allowNotFound && response.statusCode === 404) {
                        resolve(null);
                        return;
                    }
                    if ((response.statusCode || 500) >= 400) {
                        reject(new Error(`Kubernetes API ${method} ${pathname} failed: HTTP ${response.statusCode}${data ? ` ${data}` : ''}`));
                        return;
                    }
                    if (!data) {
                        resolve({});
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (_error) {
                        resolve({ raw: data });
                    }
                });
            });

            request.on('error', reject);
            if (body) {
                request.write(JSON.stringify(body));
            }
            request.end();
        });
    }

    async getNamespace(name = '') {
        return this.request('GET', `/api/v1/namespaces/${encodeURIComponent(name)}`, null, {
            allowNotFound: true,
        });
    }

    async ensureNamespace(name = '') {
        const namespace = sanitizeKubernetesName(name, 'managed-apps');
        const existing = await this.getNamespace(namespace);
        if (existing) {
            return existing;
        }

        return this.request('POST', '/api/v1/namespaces', {
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: {
                name: namespace,
                labels: {
                    'kimibuilt.io/managed-app': 'true',
                },
            },
        });
    }

    async upsertNamespacedResource({ kind = '', apiPath = '', collectionPath = '', namespace = '', name = '', resource = {} } = {}) {
        const existing = await this.request('GET', `${apiPath}/${encodeURIComponent(name)}`, null, {
            allowNotFound: true,
        });
        if (!existing) {
            return this.request('POST', collectionPath, resource);
        }

        return this.request('PUT', `${apiPath}/${encodeURIComponent(name)}`, {
            ...resource,
            metadata: {
                ...(resource.metadata || {}),
                resourceVersion: existing.metadata?.resourceVersion,
            },
        });
    }

    async ensureRegistryPullSecret({
        namespace = '',
        name = '',
        registryHost = '',
        username = '',
        password = '',
    } = {}) {
        if (!normalizeText(registryHost) || !normalizeText(username) || !normalizeText(password)) {
            return null;
        }

        const secretName = sanitizeKubernetesName(name || 'gitlab-registry-credentials', 'gitlab-registry-credentials');
        return this.upsertNamespacedResource({
            kind: 'Secret',
            apiPath: `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`,
            collectionPath: `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`,
            namespace,
            name: secretName,
            resource: {
                apiVersion: 'v1',
                kind: 'Secret',
                metadata: {
                    name: secretName,
                    namespace,
                    labels: {
                        'kimibuilt.io/managed-app': 'true',
                    },
                },
                type: 'kubernetes.io/dockerconfigjson',
                data: {
                    '.dockerconfigjson': Buffer.from(buildDockerConfigJson({
                        registryHost,
                        username,
                        password,
                    }), 'utf8').toString('base64'),
                },
            },
        });
    }

    buildDeploymentManifest({
        namespace = '',
        deploymentName = '',
        image = '',
        containerPort = 80,
        registryPullSecretName = '',
        appLabels = {},
    } = {}) {
        return {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: {
                name: deploymentName,
                namespace,
                labels: appLabels,
            },
            spec: {
                replicas: 1,
                selector: {
                    matchLabels: appLabels,
                },
                template: {
                    metadata: {
                        labels: appLabels,
                    },
                    spec: {
                        ...(registryPullSecretName
                            ? {
                                imagePullSecrets: [{
                                    name: registryPullSecretName,
                                }],
                            }
                            : {}),
                        containers: [{
                            name: 'app',
                            image,
                            imagePullPolicy: 'Always',
                            ports: [{
                                name: 'http',
                                containerPort,
                            }],
                        }],
                    },
                },
            },
        };
    }

    buildServiceManifest({
        namespace = '',
        serviceName = '',
        containerPort = 80,
        appLabels = {},
    } = {}) {
        return {
            apiVersion: 'v1',
            kind: 'Service',
            metadata: {
                name: serviceName,
                namespace,
                labels: appLabels,
            },
            spec: {
                selector: appLabels,
                ports: [{
                    name: 'http',
                    port: 80,
                    targetPort: containerPort,
                }],
            },
        };
    }

    buildIngressManifest({
        namespace = '',
        ingressName = '',
        publicHost = '',
        serviceName = '',
        ingressClassName = '',
        tlsClusterIssuer = '',
        tlsSecretName = '',
        appLabels = {},
    } = {}) {
        return {
            apiVersion: 'networking.k8s.io/v1',
            kind: 'Ingress',
            metadata: {
                name: ingressName,
                namespace,
                labels: appLabels,
                annotations: {
                    'kubernetes.io/ingress.class': ingressClassName || 'traefik',
                    'traefik.ingress.kubernetes.io/router.entrypoints': 'web,websecure',
                    'traefik.ingress.kubernetes.io/router.tls': 'true',
                    ...(tlsClusterIssuer ? { 'cert-manager.io/cluster-issuer': tlsClusterIssuer } : {}),
                },
            },
            spec: {
                ingressClassName: ingressClassName || 'traefik',
                rules: [{
                    host: publicHost,
                    http: {
                        paths: [{
                            path: '/',
                            pathType: 'Prefix',
                            backend: {
                                service: {
                                    name: serviceName,
                                    port: {
                                        number: 80,
                                    },
                                },
                            },
                        }],
                    },
                }],
                ...(tlsSecretName
                    ? {
                        tls: [{
                            hosts: [publicHost],
                            secretName: tlsSecretName,
                        }],
                    }
                    : {}),
            },
        };
    }

    async waitForDeploymentReady(namespace = '', deploymentName = '', timeoutMs = 120000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const deployment = await this.request(
                'GET',
                `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(deploymentName)}`,
            );
            const desired = Number(deployment?.spec?.replicas || 1);
            const available = Number(deployment?.status?.availableReplicas || 0);
            const ready = Number(deployment?.status?.readyReplicas || 0);
            if (available >= desired && ready >= desired) {
                return {
                    ok: true,
                    desiredReplicas: desired,
                    availableReplicas: available,
                    readyReplicas: ready,
                };
            }
            await sleep(3000);
        }

        return {
            ok: false,
            error: `Timed out waiting for deployment ${namespace}/${deploymentName} to become ready.`,
        };
    }

    async secretExists(namespace = '', name = '') {
        const secret = await this.request(
            'GET',
            `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`,
            null,
            { allowNotFound: true },
        );
        return Boolean(secret);
    }

    async verifyHttps(publicHost = '', timeoutMs = 15000) {
        const host = normalizeText(publicHost);
        if (!host) {
            return {
                ok: false,
                error: 'No public host configured.',
            };
        }

        try {
            const response = await fetch(`https://${host}/`, {
                method: 'GET',
                redirect: 'manual',
                signal: AbortSignal.timeout(timeoutMs),
            });
            const location = normalizeText(response.headers?.get('location') || '');
            let bodyPreview = '';
            try {
                bodyPreview = summarizeShellPreview(await response.text(), 180);
            } catch (_error) {
                bodyPreview = '';
            }
            return {
                ok: response.ok || [301, 302, 307, 308].includes(response.status),
                status: response.status,
                location,
                bodyPreview,
            };
        } catch (error) {
            return {
                ok: false,
                error: error.message,
            };
        }
    }

    async waitForHttps(publicHost = '', {
        timeoutMs = 300000,
        intervalMs = 5000,
        requestTimeoutMs = 15000,
    } = {}) {
        const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 300000);
        let lastResult = {
            ok: false,
            error: 'HTTPS verification did not run.',
        };

        while (Date.now() < deadline) {
            lastResult = await this.verifyHttps(publicHost, requestTimeoutMs);
            if (lastResult.ok) {
                return {
                    ...lastResult,
                    attemptsCompleted: true,
                };
            }

            await sleep(Math.max(250, Number(intervalMs) || 5000));
        }

        return {
            ...lastResult,
            attemptsCompleted: true,
        };
    }

    buildRemoteDeployInspectionCommand({
        namespace = '',
        deploymentName = '',
        serviceName = '',
        ingressName = '',
        publicHost = '',
        servicePort = 80,
        containerPort = 80,
        tlsSecretName = '',
        timeoutSeconds = 300,
        pollIntervalSeconds = 5,
    } = {}) {
        const traefikPattern = ['404', 'error', 'Error', escapeRegExp(publicHost), escapeRegExp(ingressName)]
            .filter(Boolean)
            .join('|');
        return [
            'set -e',
            'kubectl_cmd() {',
            '  if command -v kubectl >/dev/null 2>&1; then kubectl "$@"; return; fi',
            '  if command -v k3s >/dev/null 2>&1; then k3s kubectl "$@"; return; fi',
            '  echo "kubectl or k3s is required on the remote host" >&2',
            '  exit 1',
            '}',
            'if [ -f /etc/rancher/k3s/k3s.yaml ] && [ -z "${KUBECONFIG:-}" ]; then export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; fi',
            `namespace=${this.quoteShellArg(namespace)}`,
            `deployment_name=${this.quoteShellArg(deploymentName)}`,
            `service_name=${this.quoteShellArg(serviceName)}`,
            `ingress_name=${this.quoteShellArg(ingressName)}`,
            `expected_host=${this.quoteShellArg(publicHost)}`,
            `expected_service_port=${this.quoteShellArg(String(Math.max(1, Number(servicePort) || 80)))}`,
            `expected_container_port=${this.quoteShellArg(String(Math.max(1, Number(containerPort) || 80)))}`,
            `tls_secret_name=${this.quoteShellArg(tlsSecretName)}`,
            `timeout_seconds=${this.quoteShellArg(String(Math.max(30, Number(timeoutSeconds) || 300)))}`,
            `poll_interval_seconds=${this.quoteShellArg(String(Math.max(1, Number(pollIntervalSeconds) || 5)))}`,
            'echo "__KIMIBUILT_EXPECTED_HOST__=${expected_host}"',
            'echo "__KIMIBUILT_EXPECTED_SERVICE__=${service_name}"',
            'echo "__KIMIBUILT_EXPECTED_SERVICE_PORT__=${expected_service_port}"',
            'echo "__KIMIBUILT_EXPECTED_CONTAINER_PORT__=${expected_container_port}"',
            'deployment_present=false',
            'service_present=false',
            'ingress_present=false',
            'if kubectl_cmd get deployment "$deployment_name" -n "$namespace" >/dev/null 2>&1; then deployment_present=true; fi',
            'if kubectl_cmd get service "$service_name" -n "$namespace" >/dev/null 2>&1; then service_present=true; fi',
            'if kubectl_cmd get ingress "$ingress_name" -n "$namespace" >/dev/null 2>&1; then ingress_present=true; fi',
            'echo "__KIMIBUILT_DEPLOYMENT_PRESENT__=${deployment_present}"',
            'echo "__KIMIBUILT_SERVICE_PRESENT__=${service_present}"',
            'echo "__KIMIBUILT_INGRESS_PRESENT__=${ingress_present}"',
            'deployment_image=$(kubectl_cmd get deployment "$deployment_name" -n "$namespace" -o jsonpath=\'{.spec.template.spec.containers[0].image}\' 2>/dev/null || true)',
            'deployment_container_port=$(kubectl_cmd get deployment "$deployment_name" -n "$namespace" -o jsonpath=\'{.spec.template.spec.containers[0].ports[0].containerPort}\' 2>/dev/null || true)',
            'if [ -n "${deployment_image:-}" ]; then echo "__KIMIBUILT_DEPLOYMENT_IMAGE__=${deployment_image}"; fi',
            'if [ -n "${deployment_container_port:-}" ]; then echo "__KIMIBUILT_DEPLOYMENT_CONTAINER_PORT__=${deployment_container_port}"; fi',
            'service_port=$(kubectl_cmd get service "$service_name" -n "$namespace" -o jsonpath=\'{.spec.ports[0].port}\' 2>/dev/null || true)',
            'service_target_port=$(kubectl_cmd get service "$service_name" -n "$namespace" -o jsonpath=\'{.spec.ports[0].targetPort}\' 2>/dev/null || true)',
            'if [ -n "${service_port:-}" ]; then echo "__KIMIBUILT_SERVICE_PORT__=${service_port}"; fi',
            'if [ -n "${service_target_port:-}" ]; then echo "__KIMIBUILT_SERVICE_TARGET_PORT__=${service_target_port}"; fi',
            'pod_name=$(kubectl_cmd get pods -n "$namespace" -l app.kubernetes.io/name="$deployment_name" --sort-by=.metadata.creationTimestamp -o jsonpath=\'{.items[-1].metadata.name}\' 2>/dev/null || true)',
            'pod_image=""',
            'pod_image_id=""',
            'pod_phase=""',
            'pod_waiting_reason=""',
            'pod_waiting_message=""',
            'pod_terminated_reason=""',
            'pod_terminated_message=""',
            'if [ -n "${pod_name:-}" ]; then',
            '  pod_image=$(kubectl_cmd get pod "$pod_name" -n "$namespace" -o jsonpath=\'{.spec.containers[0].image}\' 2>/dev/null || true)',
            '  pod_image_id=$(kubectl_cmd get pod "$pod_name" -n "$namespace" -o jsonpath=\'{.status.containerStatuses[0].imageID}\' 2>/dev/null || true)',
            '  pod_phase=$(kubectl_cmd get pod "$pod_name" -n "$namespace" -o jsonpath=\'{.status.phase}\' 2>/dev/null || true)',
            '  pod_waiting_reason=$(kubectl_cmd get pod "$pod_name" -n "$namespace" -o jsonpath=\'{.status.containerStatuses[0].state.waiting.reason}\' 2>/dev/null || true)',
            '  pod_waiting_message=$(kubectl_cmd get pod "$pod_name" -n "$namespace" -o jsonpath=\'{.status.containerStatuses[0].state.waiting.message}\' 2>/dev/null || true)',
            '  pod_terminated_reason=$(kubectl_cmd get pod "$pod_name" -n "$namespace" -o jsonpath=\'{.status.containerStatuses[0].state.terminated.reason}\' 2>/dev/null || true)',
            '  pod_terminated_message=$(kubectl_cmd get pod "$pod_name" -n "$namespace" -o jsonpath=\'{.status.containerStatuses[0].state.terminated.message}\' 2>/dev/null || true)',
            'fi',
            'if [ -n "${pod_name:-}" ]; then echo "__KIMIBUILT_POD_NAME__=${pod_name}"; fi',
            'if [ -n "${pod_image:-}" ]; then echo "__KIMIBUILT_POD_IMAGE__=${pod_image}"; fi',
            'if [ -n "${pod_image_id:-}" ]; then echo "__KIMIBUILT_POD_IMAGE_ID__=${pod_image_id}"; fi',
            'if [ -n "${pod_phase:-}" ]; then echo "__KIMIBUILT_POD_PHASE__=${pod_phase}"; fi',
            'if [ -n "${pod_waiting_reason:-}" ]; then echo "__KIMIBUILT_POD_WAITING_REASON__=${pod_waiting_reason}"; fi',
            'if [ -n "${pod_waiting_message:-}" ]; then echo "__KIMIBUILT_POD_WAITING_MESSAGE__=${pod_waiting_message}"; fi',
            'if [ -n "${pod_terminated_reason:-}" ]; then echo "__KIMIBUILT_POD_TERMINATED_REASON__=${pod_terminated_reason}"; fi',
            'if [ -n "${pod_terminated_message:-}" ]; then echo "__KIMIBUILT_POD_TERMINATED_MESSAGE__=${pod_terminated_message}"; fi',
            'ingress_host=$(kubectl_cmd get ingress "$ingress_name" -n "$namespace" -o jsonpath=\'{.spec.rules[0].host}\' 2>/dev/null || true)',
            'ingress_backend_service=$(kubectl_cmd get ingress "$ingress_name" -n "$namespace" -o jsonpath=\'{.spec.rules[0].http.paths[0].backend.service.name}\' 2>/dev/null || true)',
            'ingress_backend_port=$(kubectl_cmd get ingress "$ingress_name" -n "$namespace" -o jsonpath=\'{.spec.rules[0].http.paths[0].backend.service.port.number}\' 2>/dev/null || true)',
            'ingress_class=$(kubectl_cmd get ingress "$ingress_name" -n "$namespace" -o jsonpath=\'{.spec.ingressClassName}\' 2>/dev/null || true)',
            'if [ -z "${ingress_class:-}" ]; then ingress_class=$(kubectl_cmd get ingress "$ingress_name" -n "$namespace" -o jsonpath=\'{.metadata.annotations.kubernetes\\.io/ingress\\.class}\' 2>/dev/null || true); fi',
            'ingress_address=$(kubectl_cmd get ingress "$ingress_name" -n "$namespace" -o jsonpath=\'{range .status.loadBalancer.ingress[*]}{.ip}{.hostname}{" "}{end}\' 2>/dev/null || true)',
            'echo "__KIMIBUILT_INGRESS_HOST__=${ingress_host}"',
            'echo "__KIMIBUILT_INGRESS_BACKEND_SERVICE__=${ingress_backend_service}"',
            'echo "__KIMIBUILT_INGRESS_BACKEND_PORT__=${ingress_backend_port}"',
            'echo "__KIMIBUILT_INGRESS_CLASS__=${ingress_class}"',
            'echo "__KIMIBUILT_INGRESS_ADDRESS__=${ingress_address}"',
            'host_matches=false',
            'if [ -n "${expected_host:-}" ] && [ "${ingress_host:-}" = "${expected_host:-}" ]; then host_matches=true; fi',
            'backend_matches=false',
            'if [ "${ingress_backend_service:-}" = "${service_name:-}" ] && [ "${ingress_backend_port:-}" = "${expected_service_port:-}" ]; then backend_matches=true; fi',
            'service_target_matches=false',
            'if [ "${service_target_port:-}" = "${expected_container_port:-}" ]; then service_target_matches=true; fi',
            'echo "__KIMIBUILT_INGRESS_HOST_MATCHES__=${host_matches}"',
            'echo "__KIMIBUILT_INGRESS_BACKEND_MATCHES__=${backend_matches}"',
            'echo "__KIMIBUILT_SERVICE_TARGET_MATCHES__=${service_target_matches}"',
            'deadline=$(( $(date +%s) + timeout_seconds ))',
            'tls_ready=false',
            'while [ "$(date +%s)" -le "$deadline" ]; do',
            '  if kubectl_cmd get secret "$tls_secret_name" -n "$namespace" >/dev/null 2>&1; then',
            '    tls_ready=true',
            '    break',
            '  fi',
            '  sleep "$poll_interval_seconds"',
            'done',
            'echo "__KIMIBUILT_TLS_SECRET__=${tls_ready}"',
            'certificate_name=""',
            'certificate_ready=unknown',
            'certificate_message=""',
            'certificate_status=""',
            'certificate_lines=$(kubectl_cmd get certificate -n "$namespace" -o jsonpath=\'{range .items[*]}{.metadata.name}{"|"}{.spec.secretName}{"|"}{range .status.conditions[*]}{.type}{":"}{.status}{":"}{.message}{";"}{end}{"\\n"}{end}\' 2>/dev/null || true)',
            'matching_certificate=$(printf "%s\\n" "$certificate_lines" | awk -F"|" -v secret="$tls_secret_name" \'$2 == secret { print; exit }\')',
            'if [ -n "${matching_certificate:-}" ]; then',
            '  certificate_name=$(printf "%s" "$matching_certificate" | cut -d"|" -f1)',
            '  certificate_conditions=$(printf "%s" "$matching_certificate" | cut -d"|" -f3-)',
            '  certificate_status=$(printf "%s" "$certificate_conditions" | tr ";" "\\n" | grep "^Ready:" | head -n 1 | cut -d":" -f2 || true)',
            '  certificate_message=$(printf "%s" "$certificate_conditions" | tr ";" "\\n" | grep "^Ready:" | head -n 1 | cut -d":" -f3- || true)',
            '  if [ "${certificate_status:-}" = "True" ]; then certificate_ready=true; else certificate_ready=false; fi',
            'fi',
            'echo "__KIMIBUILT_CERTIFICATE_NAME__=${certificate_name}"',
            'echo "__KIMIBUILT_CERTIFICATE_READY__=${certificate_ready}"',
            'echo "__KIMIBUILT_CERTIFICATE_STATUS__=${certificate_status}"',
            'echo "__KIMIBUILT_CERTIFICATE_MESSAGE__=${certificate_message}"',
            'kubectl_cmd get challenge -n "$namespace" -o jsonpath=\'{range .items[*]}{.metadata.name}{"|"}{.status.state}{"|"}{.status.reason}{"\\n"}{end}\' 2>/dev/null | sed \'s/^/__KIMIBUILT_CHALLENGE__=/\' || true',
            'kubectl_cmd describe ingress "$ingress_name" -n "$namespace" 2>/dev/null | grep -E "cert-manager|Challenge|Issuer|TLS|Warning|Error" | tail -n 12 | sed \'s/^/__KIMIBUILT_INGRESS_EVENT__=/\' || true',
            'traefik_ready=false',
            'traefik_pods=$(kubectl_cmd get pods -n kube-system -l app.kubernetes.io/name=traefik -o jsonpath=\'{range .items[*]}{range .status.containerStatuses[*]}{.ready}{"\\n"}{end}{end}\' 2>/dev/null || true)',
            'if printf "%s\\n" "$traefik_pods" | grep -q "^true$"; then traefik_ready=true; fi',
            'echo "__KIMIBUILT_TRAEFIK_READY__=${traefik_ready}"',
            `kubectl_cmd logs -n kube-system deployment/traefik --tail=40 2>/dev/null | grep -E ${this.quoteShellArg(traefikPattern)} | tail -n 10 | sed 's/^/__KIMIBUILT_TRAEFIK_LOG__=/' || true`,
            'app_probe_attempted=false',
            'app_probe_ok=false',
            'app_probe_status=""',
            'app_probe_error=""',
            'app_probe_body=""',
            'pf_pid=""',
            'cleanup_pf() {',
            '  if [ -n "${pf_pid:-}" ]; then',
            '    kill "$pf_pid" >/dev/null 2>&1 || true',
            '    wait "$pf_pid" >/dev/null 2>&1 || true',
            '    pf_pid=""',
            '  fi',
            '}',
            'trap cleanup_pf EXIT',
            'if [ "$service_present" = "true" ]; then',
            '  app_probe_attempted=true',
            '  kubectl_cmd port-forward "svc/$service_name" -n "$namespace" 18080:"$expected_service_port" >/tmp/kimibuilt-app-port-forward.log 2>&1 &',
            '  pf_pid=$!',
            '  sleep 2',
            '  if command -v curl >/dev/null 2>&1; then',
            '    app_probe_status=$(curl -sS -o /tmp/kimibuilt-app-probe-body.txt -w "%{http_code}" --max-time 10 http://127.0.0.1:18080/ 2>/tmp/kimibuilt-app-probe.err || true)',
            '    app_probe_error=$(cat /tmp/kimibuilt-app-probe.err 2>/dev/null || true)',
            '    app_probe_body=$(head -c 160 /tmp/kimibuilt-app-probe-body.txt 2>/dev/null | tr "\\n" " " || true)',
            '  else',
            '    app_probe_error="curl is required for the internal service probe."',
            '  fi',
            '  if [ "${app_probe_status:-}" = "200" ] || [ "${app_probe_status:-}" = "301" ] || [ "${app_probe_status:-}" = "302" ] || [ "${app_probe_status:-}" = "307" ] || [ "${app_probe_status:-}" = "308" ]; then app_probe_ok=true; fi',
            '  cleanup_pf',
            'fi',
            'echo "__KIMIBUILT_APP_PROBE_ATTEMPTED__=${app_probe_attempted}"',
            'echo "__KIMIBUILT_APP_PROBE_OK__=${app_probe_ok}"',
            'echo "__KIMIBUILT_APP_PROBE_STATUS__=${app_probe_status}"',
            'echo "__KIMIBUILT_APP_PROBE_ERROR__=${app_probe_error}"',
            'echo "__KIMIBUILT_APP_PROBE_BODY__=${app_probe_body}"',
        ].join('\n');
    }

    async inspectRemoteManagedAppDeployment({
        namespace = '',
        deploymentName = '',
        serviceName = '',
        ingressName = '',
        publicHost = '',
        servicePort = 80,
        containerPort = 80,
        tlsSecretName = '',
        timeoutMs = 300000,
        deploymentTarget = '',
    } = {}) {
        const command = this.buildRemoteDeployInspectionCommand({
            namespace,
            deploymentName,
            serviceName,
            ingressName,
            publicHost,
            servicePort,
            containerPort,
            tlsSecretName,
            timeoutSeconds: Math.ceil(Math.max(1000, Number(timeoutMs) || 300000) / 1000),
        });
        const result = await this.executeRemoteCommand({
            command,
            timeout: Math.max(60000, Number(timeoutMs) || 300000),
            deploymentTarget,
        }, {}, createNoopTracker());
        const stdout = String(result.stdout || '');
        const certificateReadyValue = readMarkerValue(stdout, '__KIMIBUILT_CERTIFICATE_READY__');
        const deploymentImage = readMarkerValue(stdout, '__KIMIBUILT_DEPLOYMENT_IMAGE__');
        const podImage = readMarkerValue(stdout, '__KIMIBUILT_POD_IMAGE__');
        const podImageID = readMarkerValue(stdout, '__KIMIBUILT_POD_IMAGE_ID__');

        return {
            expectedHost: readMarkerValue(stdout, '__KIMIBUILT_EXPECTED_HOST__') || normalizeText(publicHost),
            expectedService: readMarkerValue(stdout, '__KIMIBUILT_EXPECTED_SERVICE__') || normalizeText(serviceName),
            expectedServicePort: parseInteger(readMarkerValue(stdout, '__KIMIBUILT_EXPECTED_SERVICE_PORT__'), Math.max(1, Number(servicePort) || 80)),
            expectedContainerPort: parseInteger(readMarkerValue(stdout, '__KIMIBUILT_EXPECTED_CONTAINER_PORT__'), Math.max(1, Number(containerPort) || 80)),
            deploymentPresent: parseBooleanMarkerValue(stdout, '__KIMIBUILT_DEPLOYMENT_PRESENT__'),
            servicePresent: parseBooleanMarkerValue(stdout, '__KIMIBUILT_SERVICE_PRESENT__'),
            ingressPresent: parseBooleanMarkerValue(stdout, '__KIMIBUILT_INGRESS_PRESENT__'),
            deploymentImage,
            deploymentContainerPort: parseInteger(readMarkerValue(stdout, '__KIMIBUILT_DEPLOYMENT_CONTAINER_PORT__'), 0),
            servicePort: parseInteger(readMarkerValue(stdout, '__KIMIBUILT_SERVICE_PORT__'), 0),
            serviceTargetPort: parseInteger(readMarkerValue(stdout, '__KIMIBUILT_SERVICE_TARGET_PORT__'), 0),
            podStatus: {
                name: readMarkerValue(stdout, '__KIMIBUILT_POD_NAME__'),
                image: podImage,
                imageID: podImageID,
                phase: readMarkerValue(stdout, '__KIMIBUILT_POD_PHASE__'),
                waitingReason: readMarkerValue(stdout, '__KIMIBUILT_POD_WAITING_REASON__'),
                waitingMessage: summarizeShellPreview(readMarkerValue(stdout, '__KIMIBUILT_POD_WAITING_MESSAGE__'), 220),
                terminatedReason: readMarkerValue(stdout, '__KIMIBUILT_POD_TERMINATED_REASON__'),
                terminatedMessage: summarizeShellPreview(readMarkerValue(stdout, '__KIMIBUILT_POD_TERMINATED_MESSAGE__'), 220),
            },
            ingressHost: readMarkerValue(stdout, '__KIMIBUILT_INGRESS_HOST__'),
            ingressBackendService: readMarkerValue(stdout, '__KIMIBUILT_INGRESS_BACKEND_SERVICE__'),
            ingressBackendPort: parseInteger(readMarkerValue(stdout, '__KIMIBUILT_INGRESS_BACKEND_PORT__'), 0),
            ingressClassName: readMarkerValue(stdout, '__KIMIBUILT_INGRESS_CLASS__'),
            ingressAddress: readMarkerValue(stdout, '__KIMIBUILT_INGRESS_ADDRESS__'),
            ingressHostMatches: parseBooleanMarkerValue(stdout, '__KIMIBUILT_INGRESS_HOST_MATCHES__'),
            ingressBackendMatches: parseBooleanMarkerValue(stdout, '__KIMIBUILT_INGRESS_BACKEND_MATCHES__'),
            serviceTargetMatches: parseBooleanMarkerValue(stdout, '__KIMIBUILT_SERVICE_TARGET_MATCHES__'),
            tlsSecretPresent: parseBooleanMarkerValue(stdout, '__KIMIBUILT_TLS_SECRET__'),
            certificateName: readMarkerValue(stdout, '__KIMIBUILT_CERTIFICATE_NAME__'),
            certificateReady: normalizeMarkerBoolean(certificateReadyValue),
            certificateReadyValue,
            certificateStatus: readMarkerValue(stdout, '__KIMIBUILT_CERTIFICATE_STATUS__'),
            certificateMessage: summarizeShellPreview(readMarkerValue(stdout, '__KIMIBUILT_CERTIFICATE_MESSAGE__')),
            challengeSummary: readMarkerValues(stdout, '__KIMIBUILT_CHALLENGE__').map((entry) => summarizeShellPreview(entry, 220)),
            ingressEvents: readMarkerValues(stdout, '__KIMIBUILT_INGRESS_EVENT__').map((entry) => summarizeShellPreview(entry, 220)),
            traefikReady: parseBooleanMarkerValue(stdout, '__KIMIBUILT_TRAEFIK_READY__'),
            traefikLogExcerpt: readMarkerValues(stdout, '__KIMIBUILT_TRAEFIK_LOG__').map((entry) => summarizeShellPreview(entry, 220)),
            appProbe: {
                attempted: parseBooleanMarkerValue(stdout, '__KIMIBUILT_APP_PROBE_ATTEMPTED__'),
                ok: parseBooleanMarkerValue(stdout, '__KIMIBUILT_APP_PROBE_OK__'),
                status: parseInteger(readMarkerValue(stdout, '__KIMIBUILT_APP_PROBE_STATUS__'), 0),
                error: summarizeShellPreview(readMarkerValue(stdout, '__KIMIBUILT_APP_PROBE_ERROR__')),
                bodyPreview: summarizeShellPreview(readMarkerValue(stdout, '__KIMIBUILT_APP_PROBE_BODY__')),
            },
            stdout,
            stderr: String(result.stderr || ''),
            exitCode: Number(result.exitCode || 0),
            host: result.host,
        };
    }

    buildRemoteTlsStatusCommand({
        namespace = '',
        ingressName = '',
        tlsSecretName = '',
        timeoutSeconds = 300,
        pollIntervalSeconds = 5,
    } = {}) {
        return [
            'set -e',
            'kubectl_cmd() {',
            '  if command -v kubectl >/dev/null 2>&1; then kubectl "$@"; return; fi',
            '  if command -v k3s >/dev/null 2>&1; then k3s kubectl "$@"; return; fi',
            '  echo "kubectl or k3s is required on the remote host" >&2',
            '  exit 1',
            '}',
            'if [ -f /etc/rancher/k3s/k3s.yaml ] && [ -z "${KUBECONFIG:-}" ]; then export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; fi',
            `namespace=${this.quoteShellArg(namespace)}`,
            `ingress_name=${this.quoteShellArg(ingressName)}`,
            `tls_secret_name=${this.quoteShellArg(tlsSecretName)}`,
            `timeout_seconds=${this.quoteShellArg(String(Math.max(30, Number(timeoutSeconds) || 300)))}`,
            `poll_interval_seconds=${this.quoteShellArg(String(Math.max(1, Number(pollIntervalSeconds) || 5)))}`,
            'deadline=$(( $(date +%s) + timeout_seconds ))',
            'tls_ready=false',
            'certificate_ready=unknown',
            'while [ "$(date +%s)" -le "$deadline" ]; do',
            '  if kubectl_cmd get secret "$tls_secret_name" -n "$namespace" >/dev/null 2>&1; then',
            '    tls_ready=true',
            '    break',
            '  fi',
            '  sleep "$poll_interval_seconds"',
            'done',
            'echo "__KIMIBUILT_TLS_SECRET__=${tls_ready}"',
            'ingress_host=$(kubectl_cmd get ingress "$ingress_name" -n "$namespace" -o jsonpath=\'{.spec.rules[0].host}\' 2>/dev/null || true)',
            'if [ -n "${ingress_host:-}" ]; then echo "__KIMIBUILT_INGRESS_HOST__=${ingress_host}"; fi',
            'ingress_address=$(kubectl_cmd get ingress "$ingress_name" -n "$namespace" -o jsonpath=\'{range .status.loadBalancer.ingress[*]}{.ip}{.hostname}{" "}{end}\' 2>/dev/null || true)',
            'if [ -n "${ingress_address:-}" ]; then echo "__KIMIBUILT_INGRESS_ADDRESS__=${ingress_address}"; fi',
            'if [ "$tls_ready" = "true" ]; then',
            '  certificate_ready=true',
            'else',
            '  certificate_ready=unknown',
            'fi',
            'echo "__KIMIBUILT_CERTIFICATE_READY__=${certificate_ready}"',
        ].join('\n');
    }

    async waitForRemoteTlsSecret({
        namespace = '',
        ingressName = '',
        tlsSecretName = '',
        timeoutMs = 300000,
        deploymentTarget = '',
    } = {}) {
        const command = this.buildRemoteTlsStatusCommand({
            namespace,
            ingressName,
            tlsSecretName,
            timeoutSeconds: Math.ceil(Math.max(1000, Number(timeoutMs) || 300000) / 1000),
        });
        const result = await this.executeRemoteCommand({
            command,
            timeout: Math.max(60000, Number(timeoutMs) || 300000),
            deploymentTarget,
        }, {}, createNoopTracker());

        return {
            ok: parseBooleanMarkerValue(result.stdout || '', '__KIMIBUILT_TLS_SECRET__'),
            certificateReady: parseBooleanMarkerValue(result.stdout || '', '__KIMIBUILT_CERTIFICATE_READY__'),
            ingressHost: readMarkerValue(result.stdout || '', '__KIMIBUILT_INGRESS_HOST__'),
            ingressAddress: readMarkerValue(result.stdout || '', '__KIMIBUILT_INGRESS_ADDRESS__'),
            stdout: String(result.stdout || ''),
            stderr: String(result.stderr || ''),
            exitCode: Number(result.exitCode || 0),
            host: result.host,
        };
    }

    async deployManagedApp({
        slug = '',
        namespace = '',
        publicHost = '',
        image = '',
        containerPort = 80,
        registryPullSecretName = '',
        registryHost = '',
        registryUsername = '',
        registryPassword = '',
        platformNamespace = '',
        platformRuntimeSecretName = '',
        deploymentTarget = '',
    } = {}) {
        return this.deployManagedAppViaSsh({
            slug,
            namespace,
            publicHost,
            image,
            containerPort,
            registryPullSecretName,
            registryHost,
            registryUsername,
            registryPassword,
            platformNamespace,
            platformRuntimeSecretName,
            deploymentTarget,
        });
    }

    buildNamespaceManifest(namespace = '') {
        return {
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: {
                name: namespace,
                labels: {
                    'kimibuilt.io/managed-app': 'true',
                },
            },
        };
    }

    buildRegistryPullSecretManifest({
        namespace = '',
        name = '',
        registryHost = '',
        username = '',
        password = '',
    } = {}) {
        if (!normalizeText(registryHost) || !normalizeText(username) || !normalizeText(password)) {
            return null;
        }

        const secretName = sanitizeKubernetesName(name || 'gitlab-registry-credentials', 'gitlab-registry-credentials');
        return {
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: {
                name: secretName,
                namespace,
                labels: {
                    'kimibuilt.io/managed-app': 'true',
                },
            },
            type: 'kubernetes.io/dockerconfigjson',
            data: {
                '.dockerconfigjson': Buffer.from(buildDockerConfigJson({
                    registryHost,
                    username,
                    password,
                }), 'utf8').toString('base64'),
            },
        };
    }

    buildOpaqueSecretManifest({
        namespace = '',
        name = '',
        labels = {},
        stringData = {},
    } = {}) {
        return {
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: {
                name: sanitizeKubernetesName(name, 'managed-app-secret'),
                namespace,
                labels,
            },
            type: 'Opaque',
            stringData: Object.fromEntries(
                Object.entries(stringData || {})
                    .map(([key, value]) => [String(key || '').trim(), String(value ?? '')])
                    .filter(([key]) => Boolean(key)),
            ),
        };
    }

    buildRemoteRegistryPullSecretCommand({
        namespace = '',
        secretName = '',
        platformNamespace = '',
        runtimeSecretName = '',
        registryHost = '',
        registryUsername = '',
        registryPassword = '',
    } = {}) {
        const normalizedSecretName = sanitizeKubernetesName(secretName || 'gitlab-registry-credentials', 'gitlab-registry-credentials');
        const normalizedNamespace = sanitizeKubernetesName(namespace, 'managed-apps');
        const normalizedPlatformNamespace = sanitizeKubernetesName(
            platformNamespace || this.managedAppsConfig.platformNamespace || 'agent-platform',
            'agent-platform',
        );
        const normalizedRuntimeSecretName = sanitizeKubernetesName(runtimeSecretName || 'agent-platform-runtime', 'agent-platform-runtime');

        return [
            `registry_secret_name=${this.quoteShellArg(normalizedSecretName)}`,
            `app_namespace=${this.quoteShellArg(normalizedNamespace)}`,
            `platform_namespace=${this.quoteShellArg(normalizedPlatformNamespace)}`,
            `runtime_secret_name=${this.quoteShellArg(normalizedRuntimeSecretName)}`,
            `fallback_registry_host=${this.quoteShellArg(normalizeText(registryHost))}`,
            `fallback_registry_username=${this.quoteShellArg(normalizeText(registryUsername))}`,
            `fallback_registry_password=${this.quoteShellArg(normalizeText(registryPassword))}`,
            'secret_value() {',
            '  key="$1"',
            '  raw="$(kubectl_cmd get secret "$runtime_secret_name" -n "$platform_namespace" -o "jsonpath={.data.${key}}" 2>/dev/null || true)"',
            '  if [ -n "${raw:-}" ]; then printf "%s" "$raw" | base64 -d 2>/dev/null || true; fi',
            '}',
            'resolved_registry_host="$(secret_value gitlab-registry-host)"',
            'resolved_registry_username="$(secret_value gitlab-registry-username)"',
            'resolved_registry_password="$(secret_value gitlab-registry-password)"',
            'if [ -z "${resolved_registry_host:-}" ]; then resolved_registry_host="$(secret_value gitea-registry-host)"; fi',
            'if [ -z "${resolved_registry_username:-}" ]; then resolved_registry_username="$(secret_value gitea-registry-username)"; fi',
            'if [ -z "${resolved_registry_password:-}" ]; then resolved_registry_password="$(secret_value gitea-registry-password)"; fi',
            'is_placeholder_value() { case "${1:-}" in ""|change-me|replace-me|replace-after-gitea-boot|replace-after-gitlab-boot) return 0 ;; *) return 1 ;; esac; }',
            'if is_placeholder_value "$resolved_registry_host"; then resolved_registry_host="$fallback_registry_host"; fi',
            'if is_placeholder_value "$resolved_registry_username"; then resolved_registry_username="$fallback_registry_username"; fi',
            'if is_placeholder_value "$resolved_registry_password"; then resolved_registry_password="$fallback_registry_password"; fi',
            'if is_placeholder_value "$resolved_registry_host" || is_placeholder_value "$resolved_registry_username" || is_placeholder_value "$resolved_registry_password"; then',
            '  echo "__KIMIBUILT_REGISTRY_PULL_SECRET__=missing-credentials"',
            '  echo "Managed app deployment requires registry credentials in ${platform_namespace}/${runtime_secret_name} or configured fallback credentials." >&2',
            '  exit 1',
            'fi',
            'kubectl_cmd create secret docker-registry "$registry_secret_name" \\',
            '  --namespace "$app_namespace" \\',
            '  --docker-server "$resolved_registry_host" \\',
            '  --docker-username "$resolved_registry_username" \\',
            '  --docker-password "$resolved_registry_password" \\',
            '  --dry-run=client -o yaml | kubectl_cmd apply -f -',
            'kubectl_cmd label secret "$registry_secret_name" -n "$app_namespace" kimibuilt.io/managed-app=true --overwrite >/dev/null 2>&1 || true',
            'echo "__KIMIBUILT_REGISTRY_PULL_SECRET__=${registry_secret_name}|${resolved_registry_host}|${resolved_registry_username}"',
        ].join('\n');
    }

    quoteShellArg(value) {
        return `'${String(value || '').replace(/'/g, `'"'"'`)}'`;
    }

    buildRemotePlatformDoctorCommand({ platformNamespace = '' } = {}) {
        const namespace = sanitizeKubernetesName(
            platformNamespace || this.managedAppsConfig.platformNamespace || 'agent-platform',
            'agent-platform',
        );

        return [
            'set -e',
            'kubectl_cmd() {',
            '  if command -v kubectl >/dev/null 2>&1; then kubectl "$@"; return; fi',
            '  if command -v k3s >/dev/null 2>&1; then k3s kubectl "$@"; return; fi',
            '  echo "kubectl or k3s is required on the remote host" >&2',
            '  exit 1',
            '}',
            'if [ -f /etc/rancher/k3s/k3s.yaml ] && [ -z "${KUBECONFIG:-}" ]; then export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; fi',
            `platform_namespace=${this.quoteShellArg(namespace)}`,
            'remote_hostname=$(hostname 2>/dev/null || true)',
            'remote_user=$(whoami 2>/dev/null || true)',
            'remote_arch=$(uname -m 2>/dev/null || true)',
            'os_summary=$((test -f /etc/os-release && . /etc/os-release && printf "%s" "${PRETTY_NAME:-${NAME:-}}") 2>/dev/null || true)',
            'uptime_summary=$(uptime -p 2>/dev/null || uptime 2>/dev/null || true)',
            'k3s_version=$(k3s --version 2>/dev/null | head -n 1 || true)',
            'kubectl_version=$(kubectl version --client=true 2>/dev/null | head -n 1 || k3s kubectl version --client=true 2>/dev/null | head -n 1 || true)',
            'if [ -n "${remote_hostname:-}" ]; then echo "__KIMIBUILT_HOSTNAME__=${remote_hostname}"; fi',
            'if [ -n "${remote_user:-}" ]; then echo "__KIMIBUILT_REMOTE_USER__=${remote_user}"; fi',
            'if [ -n "${remote_arch:-}" ]; then echo "__KIMIBUILT_REMOTE_ARCH__=${remote_arch}"; fi',
            'if [ -n "${os_summary:-}" ]; then echo "__KIMIBUILT_OS_SUMMARY__=${os_summary}"; fi',
            'if [ -n "${uptime_summary:-}" ]; then echo "__KIMIBUILT_UPTIME__=${uptime_summary}"; fi',
            'if [ -n "${k3s_version:-}" ]; then echo "__KIMIBUILT_K3S_VERSION__=${k3s_version}"; fi',
            'if [ -n "${kubectl_version:-}" ]; then echo "__KIMIBUILT_KUBECTL_VERSION__=${kubectl_version}"; fi',
            'kubectl_cmd get nodes -o jsonpath=\'{range .items[*]}{.metadata.name}{"\\n"}{end}\' 2>/dev/null | sed \'s/^/__KIMIBUILT_NODE__=/\' || true',
            'kubectl_cmd get ingressclass -o jsonpath=\'{range .items[*]}{.metadata.name}{"\\n"}{end}\' 2>/dev/null | sed \'s/^/__KIMIBUILT_PLATFORM_INGRESS_CLASS__=/\' || true',
            'if kubectl_cmd get deployment traefik -n kube-system >/dev/null 2>&1; then echo "__KIMIBUILT_PLATFORM_TRAEFIK__=true"; else echo "__KIMIBUILT_PLATFORM_TRAEFIK__=false"; fi',
            'if kubectl_cmd get deployment cert-manager -n cert-manager >/dev/null 2>&1; then echo "__KIMIBUILT_PLATFORM_CERT_MANAGER__=true"; else echo "__KIMIBUILT_PLATFORM_CERT_MANAGER__=false"; fi',
            'echo "__KIMIBUILT_PLATFORM_NAMESPACE__=${platform_namespace}"',
            'if kubectl_cmd get namespace "$platform_namespace" >/dev/null 2>&1; then',
            '  echo "__KIMIBUILT_PLATFORM_NAMESPACE_EXISTS__=true"',
            'else',
            '  echo "__KIMIBUILT_PLATFORM_NAMESPACE_EXISTS__=false"',
            '  exit 0',
            'fi',
            'deployment_status() {',
            '  name="$1"',
            '  if kubectl_cmd get deployment "$name" -n "$platform_namespace" >/dev/null 2>&1; then',
            "    desired=$(kubectl_cmd get deployment \"$name\" -n \"$platform_namespace\" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)",
            "    ready=$(kubectl_cmd get deployment \"$name\" -n \"$platform_namespace\" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)",
            "    available=$(kubectl_cmd get deployment \"$name\" -n \"$platform_namespace\" -o jsonpath='{.status.availableReplicas}' 2>/dev/null || true)",
            "    updated=$(kubectl_cmd get deployment \"$name\" -n \"$platform_namespace\" -o jsonpath='{.status.updatedReplicas}' 2>/dev/null || true)",
            '    echo "__KIMIBUILT_DEPLOYMENT__=${name}|present|${desired:-0}|${ready:-0}|${available:-0}|${updated:-0}"',
            '  else',
            '    echo "__KIMIBUILT_DEPLOYMENT__=${name}|missing|0|0|0|0"',
            '  fi',
            '}',
            'deployment_status gitlab',
            'deployment_status buildkitd',
            'deployment_status gitlab-runner',
            'if kubectl_cmd get secret gitlab-runner -n "$platform_namespace" >/dev/null 2>&1; then',
            '  echo "__KIMIBUILT_SECRET__=gitlab-runner|present"',
            "  runner_token_b64=$(kubectl_cmd get secret gitlab-runner -n \"$platform_namespace\" -o jsonpath='{.data.runner-token}' 2>/dev/null || true)",
            '  if [ -z "${runner_token_b64:-}" ]; then',
            '    echo "__KIMIBUILT_RUNNER_TOKEN__=missing"',
            '  else',
            '    runner_token=$(printf "%s" "$runner_token_b64" | base64 -d 2>/dev/null || true)',
            '    case "$runner_token" in',
            '      "" ) echo "__KIMIBUILT_RUNNER_TOKEN__=missing" ;;',
            '      "change-me"|"replace-me"|"replace-after-gitea-boot"|"replace-after-gitlab-boot" ) echo "__KIMIBUILT_RUNNER_TOKEN__=placeholder" ;;',
            '      * ) echo "__KIMIBUILT_RUNNER_TOKEN__=present" ;;',
            '    esac',
            '  fi',
            'else',
            '  echo "__KIMIBUILT_SECRET__=gitlab-runner|missing"',
            '  echo "__KIMIBUILT_RUNNER_TOKEN__=missing-secret"',
            'fi',
            "runner_env=$(kubectl_cmd get deployment gitlab-runner -n \"$platform_namespace\" -o jsonpath='{range .spec.template.spec.containers[*].env[*]}{.name}={.value}{\"\\n\"}{end}' 2>/dev/null || true)",
            'if [ -n "${runner_env:-}" ]; then',
            '  runner_labels=$(printf "%s\\n" "$runner_env" | grep "^RUNNER_TAG_LIST=" | head -n 1 | cut -d= -f2-)',
            '  gitlab_instance_url=$(printf "%s\\n" "$runner_env" | grep "^CI_SERVER_URL=" | head -n 1 | cut -d= -f2-)',
            '  if [ -n "${runner_labels:-}" ]; then echo "__KIMIBUILT_RUNNER_LABELS__=${runner_labels}"; fi',
            '  if [ -n "${gitlab_instance_url:-}" ]; then echo "__KIMIBUILT_GITLAB_INSTANCE_URL__=${gitlab_instance_url}"; fi',
            'fi',
            "gitlab_ingress_host=$(kubectl_cmd get ingress gitlab -n \"$platform_namespace\" -o jsonpath='{.spec.rules[0].host}' 2>/dev/null || true)",
            'if [ -n "${gitlab_ingress_host:-}" ]; then echo "__KIMIBUILT_GITLAB_INGRESS_HOST__=${gitlab_ingress_host}"; fi',
            'if kubectl_cmd get deployment gitlab-runner -n "$platform_namespace" >/dev/null 2>&1; then',
            '  kubectl_cmd logs deployment/gitlab-runner -n "$platform_namespace" --tail=40 2>/dev/null | sed \'s/^/__KIMIBUILT_RUNNER_LOG__=/\' || true',
            'fi',
        ].join('\n');
    }

    buildRemotePlatformReconcileCommand({
        platformNamespace = '',
        desiredRunnerReplicas = 1,
        runnerRegistrationToken = '',
        runnerLabels = '',
        gitlabInstanceUrl = '',
        giteaInstanceUrl = '',
    } = {}) {
        const namespace = sanitizeKubernetesName(
            platformNamespace || this.managedAppsConfig.platformNamespace || 'agent-platform',
            'agent-platform',
        );
        const gitlabRunnerDesiredReplicas = Math.max(0, parseInteger(desiredRunnerReplicas, 1));
        const secretManifest = normalizeText(runnerRegistrationToken)
            ? this.buildOpaqueSecretManifest({
                namespace,
                name: 'gitlab-runner',
                labels: {
                    'kimibuilt.io/managed-app-platform': 'true',
                },
                stringData: {
                    'runner-token': normalizeText(runnerRegistrationToken),
                },
            })
            : null;
        const desiredGitlabInstanceUrl = normalizeText(gitlabInstanceUrl || giteaInstanceUrl);

        return [
            'set -e',
            'kubectl_cmd() {',
            '  if command -v kubectl >/dev/null 2>&1; then kubectl "$@"; return; fi',
            '  if command -v k3s >/dev/null 2>&1; then k3s kubectl "$@"; return; fi',
            '  echo "kubectl or k3s is required on the remote host" >&2',
            '  exit 1',
            '}',
            'if [ -f /etc/rancher/k3s/k3s.yaml ] && [ -z "${KUBECONFIG:-}" ]; then export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; fi',
            `platform_namespace=${this.quoteShellArg(namespace)}`,
            `desired_runner_replicas=${this.quoteShellArg(String(gitlabRunnerDesiredReplicas))}`,
            `desired_runner_labels=${this.quoteShellArg(normalizeText(runnerLabels))}`,
            `desired_gitlab_instance_url=${this.quoteShellArg(desiredGitlabInstanceUrl)}`,
            'echo "__KIMIBUILT_PLATFORM_NAMESPACE__=${platform_namespace}"',
            'if ! kubectl_cmd get namespace "$platform_namespace" >/dev/null 2>&1; then',
            '  echo "__KIMIBUILT_RECONCILE_ACTION__=platform-namespace-missing"',
            '  exit 1',
            'fi',
            'scale_min_if_needed() {',
            '  name="$1"',
            '  minimum="$2"',
            '  if kubectl_cmd get deployment "$name" -n "$platform_namespace" >/dev/null 2>&1; then',
            "    current=$(kubectl_cmd get deployment \"$name\" -n \"$platform_namespace\" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)",
            '    if [ -z "${current:-}" ]; then current=0; fi',
            '    if [ "$current" -lt "$minimum" ]; then',
            '      kubectl_cmd scale deployment "$name" -n "$platform_namespace" --replicas="$minimum" >/dev/null',
            '      echo "__KIMIBUILT_RECONCILE_ACTION__=${name}-scaled-${minimum}"',
            '    fi',
            '  fi',
            '}',
            'scale_min_if_needed gitlab 1',
            'scale_min_if_needed buildkitd 1',
            secretManifest
                ? [
                    'cat <<\'EOF\' | kubectl_cmd apply -f -',
                    JSON.stringify(secretManifest, null, 2),
                    'EOF',
                    'echo "__KIMIBUILT_RECONCILE_ACTION__=gitlab-runner-secret-applied"',
                ].join('\n')
                : '',
            'if kubectl_cmd get deployment gitlab-runner -n "$platform_namespace" >/dev/null 2>&1; then',
            '  if [ -n "${desired_runner_labels:-}" ]; then',
            '    kubectl_cmd set env deployment/gitlab-runner -n "$platform_namespace" RUNNER_TAG_LIST="${desired_runner_labels}" >/dev/null',
            '    echo "__KIMIBUILT_RECONCILE_ACTION__=gitlab-runner-tags-set"',
            '  fi',
            '  if [ -n "${desired_gitlab_instance_url:-}" ]; then',
            '    kubectl_cmd set env deployment/gitlab-runner -n "$platform_namespace" CI_SERVER_URL="${desired_gitlab_instance_url}" >/dev/null',
            '    echo "__KIMIBUILT_RECONCILE_ACTION__=gitlab-runner-instance-url-set"',
            '  fi',
            '  kubectl_cmd scale deployment gitlab-runner -n "$platform_namespace" --replicas="${desired_runner_replicas}" >/dev/null',
            '  echo "__KIMIBUILT_RECONCILE_ACTION__=gitlab-runner-scaled-${desired_runner_replicas}"',
            '  kubectl_cmd rollout restart deployment/gitlab-runner -n "$platform_namespace" >/dev/null',
            '  echo "__KIMIBUILT_RECONCILE_ACTION__=gitlab-runner-restarted"',
            '  kubectl_cmd rollout status deployment/gitlab-runner -n "$platform_namespace" --timeout=180s',
            'else',
            '  echo "__KIMIBUILT_RECONCILE_ACTION__=gitlab-runner-missing"',
            'fi',
        ].filter(Boolean).join('\n');
    }

    async inspectManagedAppPlatform({
        platformNamespace = '',
        deploymentTarget = '',
    } = {}) {
        if (!this.isConfigured(deploymentTarget)) {
            throw new Error('Managed app platform inspection requires a healthy remote runner or SSH access to the remote deploy host.');
        }

        const target = this.resolveDeployTarget(deploymentTarget);
        const command = this.buildRemotePlatformDoctorCommand({ platformNamespace });
        const result = await this.executeRemoteCommand({
            command,
            timeout: 120000,
            deploymentTarget,
        }, {}, createNoopTracker());
        const stdout = String(result.stdout || '');
        const deployments = {};

        readMarkerValues(stdout, '__KIMIBUILT_DEPLOYMENT__').forEach((entry) => {
            const [name, status, desired, ready, available, updated] = String(entry || '').split('|');
            if (!name) {
                return;
            }

            deployments[name] = {
                name,
                present: status === 'present',
                desiredReplicas: parseInteger(desired, 0),
                readyReplicas: parseInteger(ready, 0),
                availableReplicas: parseInteger(available, 0),
                updatedReplicas: parseInteger(updated, 0),
            };
        });

        Object.values(deployments).forEach((deployment) => {
            deployment.ready = deployment.present && deployment.readyReplicas >= Math.max(1, deployment.desiredReplicas || 0);
        });

        const namespace = readMarkerValue(stdout, '__KIMIBUILT_PLATFORM_NAMESPACE__')
            || sanitizeKubernetesName(platformNamespace || this.managedAppsConfig.platformNamespace || 'agent-platform', 'agent-platform');
        const namespaceExists = /^true$/i.test(readMarkerValue(stdout, '__KIMIBUILT_PLATFORM_NAMESPACE_EXISTS__'));
        const secretStateLine = readMarkerValue(stdout, '__KIMIBUILT_SECRET__');
        const [secretName, secretStatus] = secretStateLine.split('|');
        const runnerLogs = readMarkerValues(stdout, '__KIMIBUILT_RUNNER_LOG__');
        const nodeNames = readMarkerValues(stdout, '__KIMIBUILT_NODE__');
        const ingressClasses = readMarkerValues(stdout, '__KIMIBUILT_PLATFORM_INGRESS_CLASS__');
        const serverContext = {
            hostname: readMarkerValue(stdout, '__KIMIBUILT_HOSTNAME__'),
            remoteUser: readMarkerValue(stdout, '__KIMIBUILT_REMOTE_USER__'),
            arch: readMarkerValue(stdout, '__KIMIBUILT_REMOTE_ARCH__'),
            osSummary: readMarkerValue(stdout, '__KIMIBUILT_OS_SUMMARY__'),
            uptimeSummary: readMarkerValue(stdout, '__KIMIBUILT_UPTIME__'),
            k3sVersion: readMarkerValue(stdout, '__KIMIBUILT_K3S_VERSION__'),
            kubectlVersion: readMarkerValue(stdout, '__KIMIBUILT_KUBECTL_VERSION__'),
            nodeNames,
            ingressClasses,
            traefikInstalled: parseBooleanMarkerValue(stdout, '__KIMIBUILT_PLATFORM_TRAEFIK__'),
            certManagerInstalled: parseBooleanMarkerValue(stdout, '__KIMIBUILT_PLATFORM_CERT_MANAGER__'),
            platformNamespaces: [namespace],
            lastRefreshedAt: new Date().toISOString(),
        };

        return {
            deploymentTarget: target || 'ssh',
            platformNamespace: namespace,
            namespaceExists,
            executionHost: result.host,
            deployments,
            secrets: {
                [secretName || 'gitlab-runner']: {
                    name: secretName || 'gitlab-runner',
                    present: secretStatus === 'present',
                },
            },
            runnerTokenState: readMarkerValue(stdout, '__KIMIBUILT_RUNNER_TOKEN__') || 'unknown',
            runnerLabels: readMarkerValue(stdout, '__KIMIBUILT_RUNNER_LABELS__'),
            gitlabInstanceUrl: readMarkerValue(stdout, '__KIMIBUILT_GITLAB_INSTANCE_URL__'),
            gitlabIngressHost: readMarkerValue(stdout, '__KIMIBUILT_GITLAB_INGRESS_HOST__'),
            giteaInstanceUrl: readMarkerValue(stdout, '__KIMIBUILT_GITLAB_INSTANCE_URL__'),
            giteaIngressHost: readMarkerValue(stdout, '__KIMIBUILT_GITLAB_INGRESS_HOST__'),
            runnerLogExcerpt: runnerLogs.slice(-20),
            serverContext,
            raw: {
                stdout,
                stderr: String(result.stderr || ''),
                exitCode: Number(result.exitCode || 0),
            },
        };
    }

    async reconcileManagedAppPlatform({
        platformNamespace = '',
        deploymentTarget = '',
        desiredRunnerReplicas = 1,
        runnerRegistrationToken = '',
        runnerLabels = '',
        gitlabInstanceUrl = '',
        giteaInstanceUrl = '',
    } = {}) {
        if (!this.isConfigured(deploymentTarget)) {
            throw new Error('Managed app platform reconciliation requires a healthy remote runner or SSH access to the remote deploy host.');
        }

        const target = this.resolveDeployTarget(deploymentTarget);
        const command = this.buildRemotePlatformReconcileCommand({
            platformNamespace,
            desiredRunnerReplicas,
            runnerRegistrationToken,
            runnerLabels,
            gitlabInstanceUrl,
            giteaInstanceUrl,
        });
        const result = await this.executeRemoteCommand({
            command,
            timeout: 180000,
            deploymentTarget,
        }, {}, createNoopTracker());

        return {
            deploymentTarget: target || 'ssh',
            platformNamespace: readMarkerValue(result.stdout || '', '__KIMIBUILT_PLATFORM_NAMESPACE__')
                || sanitizeKubernetesName(platformNamespace || this.managedAppsConfig.platformNamespace || 'agent-platform', 'agent-platform'),
            executionHost: result.host,
            actions: readMarkerValues(result.stdout || '', '__KIMIBUILT_RECONCILE_ACTION__'),
            raw: {
                stdout: String(result.stdout || ''),
                stderr: String(result.stderr || ''),
                exitCode: Number(result.exitCode || 0),
            },
        };
    }

    buildRemoteManifestApplyCommand(manifests = [], {
        namespace = '',
        deploymentName = '',
        tlsSecretName = '',
        timeoutSeconds = 120,
        registrySecret = null,
    } = {}) {
        const buildApplyBlocks = (items = []) => items
            .filter(Boolean)
            .map((manifest) => [
                'cat <<\'EOF\' | kubectl_cmd apply -f -',
                JSON.stringify(manifest, null, 2),
                'EOF',
            ].join('\n'))
            .join('\n');
        const namespaceManifests = manifests.filter((manifest) => manifest?.kind === 'Namespace');
        const resourceManifests = manifests.filter((manifest) => manifest?.kind !== 'Namespace');
        const namespaceApplyBlocks = buildApplyBlocks(namespaceManifests);
        const resourceApplyBlocks = buildApplyBlocks(resourceManifests);
        const registrySecretBlock = registrySecret
            ? this.buildRemoteRegistryPullSecretCommand({
                namespace,
                ...registrySecret,
            })
            : '';

        return [
            'set -e',
            'kubectl_cmd() {',
            '  if command -v kubectl >/dev/null 2>&1; then kubectl "$@"; return; fi',
            '  if command -v k3s >/dev/null 2>&1; then k3s kubectl "$@"; return; fi',
            '  echo "kubectl or k3s is required on the remote host" >&2',
            '  exit 1',
            '}',
            'if [ -f /etc/rancher/k3s/k3s.yaml ] && [ -z "${KUBECONFIG:-}" ]; then export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; fi',
            namespaceApplyBlocks,
            registrySecretBlock,
            resourceApplyBlocks,
            `kubectl_cmd rollout status deployment/${this.quoteShellArg(deploymentName)} -n ${this.quoteShellArg(namespace)} --timeout=${Math.max(30, Number(timeoutSeconds) || 120)}s`,
            `if kubectl_cmd get secret ${this.quoteShellArg(tlsSecretName)} -n ${this.quoteShellArg(namespace)} >/dev/null 2>&1; then echo "__KIMIBUILT_TLS_SECRET__=true"; else echo "__KIMIBUILT_TLS_SECRET__=false"; fi`,
        ].filter(Boolean).join('\n');
    }

    async deployManagedAppViaSsh({
        slug = '',
        namespace = '',
        publicHost = '',
        image = '',
        containerPort = 80,
        registryPullSecretName = '',
        registryHost = '',
        registryUsername = '',
        registryPassword = '',
        platformNamespace = '',
        platformRuntimeSecretName = '',
        deploymentTarget = '',
    } = {}) {
        if (!this.isConfigured(deploymentTarget)) {
            throw new Error('Managed app deployment requires a healthy remote runner or SSH access to the remote deploy host.');
        }

        const deployConfig = this.deployConfig();
        const appName = sanitizeKubernetesName(slug, 'managed-app');
        const appNamespace = normalizeManagedAppNamespace(
            namespace || appName,
            appName,
            this.managedAppsConfig.namespacePrefix || 'app-',
        );
        const host = normalizeText(publicHost);
        const appLabels = {
            'app.kubernetes.io/name': appName,
            'app.kubernetes.io/managed-by': 'kimibuilt',
            'kimibuilt.io/managed-app': 'true',
        };
        const tlsSecretName = sanitizeKubernetesName(`${appName}-tls`, `${appName}-tls`);
        const normalizedContainerPort = Math.max(1, Number(containerPort) || 80);
        const resolvedPlatformNamespace = sanitizeKubernetesName(
            platformNamespace || this.managedAppsConfig.platformNamespace || 'agent-platform',
            'agent-platform',
        );
        const resolvedPlatformRuntimeSecretName = sanitizeKubernetesName(
            platformRuntimeSecretName || this.managedAppsConfig.platformRuntimeSecretName || 'agent-platform-runtime',
            'agent-platform-runtime',
        );
        const manifests = [
            this.buildNamespaceManifest(appNamespace),
            this.buildDeploymentManifest({
                namespace: appNamespace,
                deploymentName: appName,
                image,
                containerPort: normalizedContainerPort,
                registryPullSecretName,
                appLabels,
            }),
            this.buildServiceManifest({
                namespace: appNamespace,
                serviceName: appName,
                containerPort: normalizedContainerPort,
                appLabels,
            }),
            this.buildIngressManifest({
                namespace: appNamespace,
                ingressName: appName,
                publicHost: host,
                serviceName: appName,
                ingressClassName: deployConfig.ingressClassName || '',
                tlsClusterIssuer: deployConfig.tlsClusterIssuer || '',
                tlsSecretName,
                appLabels,
            }),
        ];

        const command = this.buildRemoteManifestApplyCommand(manifests, {
            namespace: appNamespace,
            deploymentName: appName,
            tlsSecretName,
            timeoutSeconds: 120,
            registrySecret: registryPullSecretName
                ? {
                    secretName: registryPullSecretName,
                    platformNamespace: resolvedPlatformNamespace,
                    runtimeSecretName: resolvedPlatformRuntimeSecretName,
                    registryHost,
                    registryUsername,
                    registryPassword,
                }
                : null,
        });
        const result = await this.executeRemoteCommand({
            command,
            timeout: 180000,
            deploymentTarget,
        }, {}, createNoopTracker());
        const rolloutOk = Number(result.exitCode || 0) === 0;
        const deploymentInspection = await this.inspectRemoteManagedAppDeployment({
            namespace: appNamespace,
            deploymentName: appName,
            serviceName: appName,
            ingressName: appName,
            publicHost: host,
            servicePort: 80,
            containerPort: normalizedContainerPort,
            tlsSecretName,
            timeoutMs: rolloutOk
                ? (this.managedAppsConfig.tlsReadyTimeoutMs || 300000)
                : 1000,
            deploymentTarget,
        });
        const https = rolloutOk
            ? await this.waitForHttps(host, {
                timeoutMs: this.managedAppsConfig.httpsVerifyTimeoutMs || 300000,
                intervalMs: this.managedAppsConfig.httpsVerifyIntervalMs || 5000,
                requestTimeoutMs: this.managedAppsConfig.httpsRequestTimeoutMs || 15000,
            })
            : {
                ok: false,
                error: 'Rollout failed before HTTPS verification started.',
                attemptsCompleted: false,
            };
        const verificationIngress = Boolean(
            rolloutOk
            && deploymentInspection.deploymentPresent
            && deploymentInspection.servicePresent
            && deploymentInspection.ingressPresent
            && deploymentInspection.ingressHostMatches
            && deploymentInspection.ingressBackendMatches
            && deploymentInspection.serviceTargetMatches
            && deploymentInspection.traefikReady,
        );
        const verificationTls = Boolean(
            rolloutOk
            && deploymentInspection.tlsSecretPresent
            && deploymentInspection.certificateReady === true,
        );
        const imageEvidence = buildManagedAppImageEvidence({
            requestedImage: image,
            deploymentImage: deploymentInspection.deploymentImage,
            podImage: deploymentInspection.podStatus?.image,
            podImageID: deploymentInspection.podStatus?.imageID,
        });
        const verificationImageDigest = rolloutOk && imageEvidence.verified;
        const verificationPublicHttps = https.ok === true;
        const verificationHttps = verificationPublicHttps && verificationImageDigest;
        const tlsStatus = {
            ok: verificationTls,
            certificateReady: deploymentInspection.certificateReady === true,
            certificateReadyValue: deploymentInspection.certificateReadyValue,
            ingressHost: deploymentInspection.ingressHost || host,
            ingressAddress: deploymentInspection.ingressAddress,
            certificateName: deploymentInspection.certificateName,
            certificateStatus: deploymentInspection.certificateStatus,
            certificateMessage: deploymentInspection.certificateMessage,
            challengeSummary: deploymentInspection.challengeSummary,
            ingressEvents: deploymentInspection.ingressEvents,
            traefikReady: deploymentInspection.traefikReady,
            traefikLogExcerpt: deploymentInspection.traefikLogExcerpt,
            stdout: deploymentInspection.stdout,
            stderr: deploymentInspection.stderr,
            exitCode: deploymentInspection.exitCode,
            host: deploymentInspection.host,
        };
        const diagnostics = {
            ...deploymentInspection,
            imageDigest: imageEvidence.observedDigest,
            imageDigestError: imageEvidence.error,
            imageEvidence,
            httpsStatus: Number(https.status || 0),
            httpsOk: verificationPublicHttps,
            httpsError: summarizeShellPreview(https.error || ''),
            httpsLocation: normalizeText(https.location || ''),
            httpsBodyPreview: summarizeShellPreview(https.bodyPreview || ''),
        };

        return {
            namespace: appNamespace,
            deployment: appName,
            service: appName,
            ingress: appName,
            tlsSecretName,
            rollout: {
                ok: rolloutOk,
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                host: result.host,
            },
            verification: {
                rollout: rolloutOk,
                ingress: verificationIngress,
                tls: verificationTls,
                imageDigest: verificationImageDigest,
                publicHttps: verificationPublicHttps,
                https: verificationHttps,
            },
            imageDigest: imageEvidence.observedDigest,
            requestedImage: imageEvidence.requestedImage,
            deploymentImage: imageEvidence.deploymentImage,
            podImage: imageEvidence.podImage,
            podImageID: imageEvidence.podImageID,
            imageEvidence,
            tlsStatus,
            https,
            diagnostics,
            executionHost: result.host,
        };
    }
}

module.exports = {
    KubernetesClient,
    buildManagedAppImageEvidence,
    extractOciSha256DigestFromImageRef,
    normalizeOciSha256Digest,
};
