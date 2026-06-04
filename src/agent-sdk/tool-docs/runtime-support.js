const { spawn } = require('child_process');
const settingsController = require('../../routes/admin/settings.controller');
const { remoteRunnerService } = require('../../remote-runner/service');
const { remoteCliAgentsSdkRunner } = require('../../remote-cli/agents-sdk-runner');

const CACHE_TTL_MS = 15000;

let cachedSnapshot = null;
let cachedAt = 0;
let pendingSnapshot = null;

function appendNote(notes, message) {
    if (!message) return;
    if (!notes.includes(message)) {
        notes.push(message);
    }
}

function getRunnerCliTools(runner = null) {
    const metadata = runner?.metadata || {};
    const cliTools = Array.isArray(metadata.cliTools) ? metadata.cliTools : [];
    if (cliTools.length > 0) {
        return cliTools
            .map((tool) => ({
                name: String(tool?.name || '').trim(),
                available: tool?.available !== false,
                path: String(tool?.path || '').trim(),
            }))
            .filter((tool) => tool.name);
    }

    return (Array.isArray(metadata.availableCliTools) ? metadata.availableCliTools : [])
        .map((name) => String(name || '').trim())
        .filter(Boolean)
        .map((name) => ({
            name,
            available: true,
            path: '',
        }));
}

function formatRunnerCliToolsNote(cliTools = []) {
    const available = cliTools
        .filter((tool) => tool.available)
        .map((tool) => tool.path ? `${tool.name}=${tool.path}` : tool.name)
        .slice(0, 18);
    const missing = cliTools
        .filter((tool) => tool.available === false)
        .map((tool) => tool.name)
        .slice(0, 10);
    if (available.length === 0 && missing.length === 0) {
        return '';
    }

    return [
        available.length > 0 ? `Remote runner CLI tools available: ${available.join(', ')}.` : '',
        missing.length > 0 ? `Common CLI tools not reported on the runner: ${missing.join(', ')}.` : '',
    ].filter(Boolean).join(' ');
}

function buildK3sRunnerFeedback(runner = null) {
    const runnerCliTools = getRunnerCliTools(runner);
    const availableCliTools = runnerCliTools
        .filter((tool) => tool.available)
        .map((tool) => tool.name);
    const availableNames = new Set(availableCliTools.map((name) => name.toLowerCase()));
    const buildkitReady = Boolean(runner?.metadata?.buildkitHostConfigured && availableNames.has('buildctl'));
    const kubernetesReady = Boolean(runner?.metadata?.kubernetesConfigured && availableNames.has('kubectl'));
    const imagePushReady = Boolean(buildkitReady && runner?.metadata?.imagePrefix);
    const buildToK3sReady = Boolean(runner && buildkitReady && kubernetesReady && imagePushReady && availableNames.has('git'));

    return {
        runnerReady: Boolean(runner),
        deployReady: Boolean(runner && kubernetesReady),
        buildkitReady,
        kubernetesReady,
        imagePushReady,
        buildToK3sReady,
        requiredCliTools: ['git', 'buildctl', 'kubectl'],
        availableCliTools,
        imagePrefix: runner?.metadata?.imagePrefix || '',
        blockers: [
            !runner ? 'No online deploy-capable remote runner is registered.' : '',
            runner && !availableNames.has('git') ? 'Runner did not report git.' : '',
            runner && !availableNames.has('buildctl') ? 'Runner did not report buildctl.' : '',
            runner && !runner?.metadata?.buildkitHostConfigured ? 'Runner did not report BUILDKIT_HOST.' : '',
            runner && !availableNames.has('kubectl') ? 'Runner did not report kubectl.' : '',
            runner && !runner?.metadata?.kubernetesConfigured ? 'Runner did not report Kubernetes configuration.' : '',
            runner && !runner?.metadata?.imagePrefix ? 'Runner did not report DIRECT_CLI_IMAGE_PREFIX.' : '',
        ].filter(Boolean),
    };
}

function probeCommand(command, args = [], options = {}) {
    const timeout = options.timeout || 5000;

    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(command, args, {
                env: options.env || process.env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            resolve({
                ok: false,
                code: error.code || 'ERROR',
                stdout: '',
                stderr: '',
                message: error.message,
            });
            return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGTERM');
            resolve({
                ok: false,
                code: 'ETIMEDOUT',
                stdout,
                stderr,
                message: `${command} timed out after ${timeout}ms`,
            });
        }, timeout);

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
                ok: false,
                code: error.code || 'ERROR',
                stdout,
                stderr,
                message: error.message,
            });
        });

        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
                ok: code === 0,
                code,
                stdout,
                stderr,
                message: (stderr || stdout || '').trim(),
            });
        });
    });
}

async function buildRuntimeSnapshot() {
    const [dockerProbe, sshProbe, gitProbe] = await Promise.all([
        probeCommand('docker', ['info'], { timeout: 8000 }),
        probeCommand('ssh', ['-V'], { timeout: 5000 }),
        probeCommand('git', ['--version'], { timeout: 5000 }),
    ]);

    const sshConfig = settingsController.getEffectiveSshConfig();
    const sshNotes = [];
    const dockerNotes = [];
    const gitNotes = [];

    if (!sshProbe.ok) {
        appendNote(sshNotes, `SSH client is unavailable in the backend runtime: ${sshProbe.message || 'unknown error'}`);
    }

    if (sshConfig.enabled === false) {
        appendNote(sshNotes, 'SSH defaults are disabled in Admin Settings.');
    }
    if (!sshConfig.host) {
        appendNote(sshNotes, 'Missing SSH host.');
    }
    if (!sshConfig.username) {
        appendNote(sshNotes, 'Missing SSH username.');
    }
    if (!sshConfig.password && !sshConfig.privateKeyPath) {
        appendNote(sshNotes, 'Missing SSH password or private key path.');
    }

    const sshReady = sshProbe.ok
        && sshConfig.enabled !== false
        && Boolean(sshConfig.host)
        && Boolean(sshConfig.username)
        && Boolean(sshConfig.password || sshConfig.privateKeyPath);

    if (sshReady) {
        appendNote(sshNotes, `SSH is configured for ${sshConfig.username}@${sshConfig.host}:${sshConfig.port || 22}.`);
    }

    if (!dockerProbe.ok) {
        appendNote(dockerNotes, `Docker runtime is unavailable: ${dockerProbe.message || 'unknown error'}`);
        appendNote(dockerNotes, 'Ensure the backend container has Docker CLI access and a reachable Docker daemon or socket.');
    } else {
        appendNote(dockerNotes, 'Docker CLI and daemon are reachable from the backend runtime.');
    }

    const dockerReady = dockerProbe.ok;

    if (!gitProbe.ok) {
        appendNote(gitNotes, `Git CLI is unavailable in the backend runtime: ${gitProbe.message || 'unknown error'}`);
    } else {
        appendNote(gitNotes, 'Git CLI is available in the backend runtime.');
    }

    const gitReady = gitProbe.ok;

    return {
        checkedAt: new Date().toISOString(),
        docker: {
            ready: dockerReady,
            notes: dockerNotes,
        },
        git: {
            ready: gitReady,
            notes: gitNotes,
        },
        ssh: {
            ready: sshReady,
            notes: sshNotes,
        },
    };
}

async function getRuntimeSnapshot() {
    const now = Date.now();
    if (cachedSnapshot && now - cachedAt < CACHE_TTL_MS) {
        return cachedSnapshot;
    }

    if (!pendingSnapshot) {
        pendingSnapshot = buildRuntimeSnapshot()
            .then((snapshot) => {
                cachedSnapshot = snapshot;
                cachedAt = Date.now();
                return snapshot;
            })
            .finally(() => {
                pendingSnapshot = null;
            });
    }

    return pendingSnapshot;
}

async function getRuntimeSupport(toolId) {
    const snapshot = await getRuntimeSnapshot();
    const gitProviderConfig = typeof settingsController.getEffectiveGitProviderConfig === 'function'
        ? settingsController.getEffectiveGitProviderConfig()
        : (typeof settingsController.getEffectiveGitLabConfig === 'function'
            ? settingsController.getEffectiveGitLabConfig()
            : (typeof settingsController.getEffectiveGiteaConfig === 'function'
                ? { ...settingsController.getEffectiveGiteaConfig(), provider: 'gitea' }
                : {}));
    const managedAppsConfig = typeof settingsController.getEffectiveManagedAppsConfig === 'function'
        ? settingsController.getEffectiveManagedAppsConfig()
        : {};

    if (toolId === 'ssh-execute' || toolId === 'remote-command' || toolId === 'remote-workbench') {
        const runner = remoteRunnerService.getHealthyRunner();
        const runnerWorkspace = runner?.metadata?.defaultCwd || runner?.metadata?.workspace || '';
        const runnerCliTools = getRunnerCliTools(runner);
        const runnerCliToolsNote = formatRunnerCliToolsNote(runnerCliTools);
        const toolLabel = toolId === 'remote-workbench' ? 'Remote workbench' : 'Remote runner';
        return {
            status: (runner || snapshot.ssh.ready) ? 'stable' : 'requires_setup',
            notes: runner
                ? [
                    `${toolLabel} ${runner.runnerId} is online${runnerWorkspace ? ` with workspace ${runnerWorkspace}` : ''}.`,
                    runnerCliToolsNote,
                    ...snapshot.ssh.notes,
                ].filter(Boolean)
                : snapshot.ssh.notes,
            runtime: {
                ...snapshot.ssh,
                ready: Boolean(runner || snapshot.ssh.ready),
                runnerReady: Boolean(runner),
                runnerId: runner?.runnerId || '',
                runnerWorkspace,
                runnerShell: runner?.metadata?.shell || '',
                runnerCapabilities: runner?.capabilities || [],
                runnerCliTools,
                runnerAvailableCliTools: runnerCliTools.filter((tool) => tool.available).map((tool) => tool.name),
            },
        };
    }

    if (toolId === 'k3s-deploy') {
        const runner = remoteRunnerService.getHealthyRunner('', { requiredProfile: 'deploy' });
        const runnerWorkspace = runner?.metadata?.defaultCwd || runner?.metadata?.workspace || '';
        const runnerCliTools = getRunnerCliTools(runner);
        const runnerCliToolsNote = formatRunnerCliToolsNote(runnerCliTools);
        const k3sFeedback = buildK3sRunnerFeedback(runner);
        return {
            status: (runner || snapshot.ssh.ready) ? 'stable' : 'requires_setup',
            notes: runner
                ? [
                    `Remote runner ${runner.runnerId} is online for deploy operations${runnerWorkspace ? ` with workspace ${runnerWorkspace}` : ''}.`,
                    k3sFeedback.buildToK3sReady
                        ? 'K3s feedback check reports buildctl, kubectl, BuildKit, Kubernetes config, and image prefix are ready.'
                        : `K3s feedback blockers: ${k3sFeedback.blockers.join(' ')}`,
                    runnerCliToolsNote,
                    ...snapshot.ssh.notes,
                ].filter(Boolean)
                : snapshot.ssh.notes,
            runtime: {
                ...snapshot.ssh,
                ready: Boolean(runner || snapshot.ssh.ready),
                runnerReady: Boolean(runner),
                runnerId: runner?.runnerId || '',
                runnerWorkspace,
                runnerShell: runner?.metadata?.shell || '',
                runnerCapabilities: runner?.capabilities || [],
                runnerCliTools,
                runnerAvailableCliTools: runnerCliTools.filter((tool) => tool.available).map((tool) => tool.name),
                k3sFeedback,
            },
        };
    }

    if (toolId === 'remote-cli-agent') {
        const publicConfig = remoteCliAgentsSdkRunner.getPublicConfig();
        const ready = publicConfig.enabled !== false && publicConfig.configured;
        const runner = remoteRunnerService.getHealthyRunner('', { requiredProfile: 'deploy' });
        const runnerWorkspace = runner?.metadata?.defaultCwd || runner?.metadata?.workspace || '';
        const runnerCliTools = getRunnerCliTools(runner);
        const k3sFeedback = buildK3sRunnerFeedback(runner);
        return {
            status: ready ? 'stable' : 'requires_setup',
            notes: ready
                ? [
                    publicConfig.transport === 'codex-agent'
                        ? `Remote CLI Codex-agent API is configured at ${publicConfig.codexAgentBaseUrl}.`
                        : `Remote CLI MCP server ${publicConfig.name} is configured at ${publicConfig.url}.`,
                    `Default target is ${publicConfig.defaultTargetId}${publicConfig.defaultCwd ? ` with cwd ${publicConfig.defaultCwd}` : ''}.`,
                    runner
                        ? `Deploy-capable remote runner ${runner.runnerId} is online${runnerWorkspace ? ` with workspace ${runnerWorkspace}` : ''}.`
                        : 'No deploy-capable remote runner is online; remote-cli-agent can still use the configured gateway transport, but direct k3s build feedback is unavailable.',
                    k3sFeedback.buildToK3sReady
                        ? 'K3s feedback check reports buildctl, kubectl, BuildKit, Kubernetes config, and image prefix are ready.'
                        : `K3s feedback blockers: ${k3sFeedback.blockers.join(' ')}`,
                    gitProviderConfig?.baseURL ? `Configured Git provider is ${gitProviderConfig.provider || 'gitlab'} at ${gitProviderConfig.baseURL}.` : 'No configured GitLab base URL is visible to the runtime; remote builds should fall back to local git/direct runner and report the missing source-control automation.',
                    'Use adminMode for scoped remote software deployment loops that need real changes through the admin-capable CLI runner lane.',
                    publicConfig.transport === 'codex-agent'
                        ? 'Tool-call contract: backend callers should invoke remote-cli-agent; KimiBuilt will call POST /api/codex-agent/run and stream GET /api/codex-agent/runs/:runId/events progress.'
                        : 'Tool-call contract: backend callers should invoke remote-cli-agent; the inner agent should use remote_code_run, poll remote_code_status for in-progress jobs, and continue with returned session IDs.',
                    'Remote deployment contract: Git visibility is required even for local fallback repos; report GIT_BRANCH, GIT_BASE_COMMIT, GIT_COMMIT, CHANGED_FILES, verification markers, and rollback through git revert plus redeploy.',
                ]
                : [
                    'Remote CLI codex-agent transport needs REMOTE_CLI_CODEX_AGENT_BASE_URL, CODEX_AGENT_BASE_URL, or GATEWAY_URL.',
                    'Remote CLI codex-agent transport needs REMOTE_CLI_CODEX_AGENT_BEARER_TOKEN, CODEX_AGENT_API_KEY, FRONTEND_API_KEY, or a compatible gateway bearer token.',
                    'Legacy MCP fallback still needs REMOTE_CLI_MCP_URL and REMOTE_CLI_MCP_BEARER_TOKEN or N8N_API_KEY.',
                ],
            runtime: {
                ready,
                ...publicConfig,
                runnerReady: Boolean(runner),
                runnerId: runner?.runnerId || '',
                runnerWorkspace,
                runnerShell: runner?.metadata?.shell || '',
                runnerCapabilities: runner?.capabilities || [],
                runnerCliTools,
                runnerAvailableCliTools: runnerCliTools.filter((tool) => tool.available).map((tool) => tool.name),
                k3sFeedback,
            },
        };
    }

    if (toolId === 'git-safe') {
        return {
            status: snapshot.git.ready ? 'stable' : 'requires_setup',
            notes: snapshot.git.notes,
            runtime: snapshot.git,
        };
    }

    if (toolId === 'docker-exec' || toolId === 'code-sandbox') {
        return {
            status: snapshot.docker.ready ? 'stable' : 'requires_setup',
            notes: snapshot.docker.notes,
            runtime: snapshot.docker,
        };
    }

    if (toolId === 'managed-app') {
        const ready = Boolean(
            gitProviderConfig.enabled !== false
            && gitProviderConfig.baseURL
            && gitProviderConfig.token
            && managedAppsConfig.enabled !== false,
        );

        return {
            status: ready ? 'stable' : 'requires_setup',
            notes: ready
                ? [
                    `External Git provider (${gitProviderConfig.provider || 'gitlab'}) configured at ${gitProviderConfig.baseURL}.`,
                    `Managed app base domain is ${managedAppsConfig.appBaseDomain || 'demoserver2.buzz'}.`,
                    'Before creating a new app/site/project, inventory managed apps, Git projects, continuity facts, and live k3s resources for an existing match.',
                ]
                : [
                    'Managed app control plane needs integrations.gitlab baseURL and token.',
                    'Managed app control plane also needs integrations.managedApps defaults.',
                ],
            runtime: {
                ready,
                provider: gitProviderConfig.provider || 'gitlab',
                baseURL: gitProviderConfig.baseURL || '',
                org: gitProviderConfig.org || '',
                appBaseDomain: managedAppsConfig.appBaseDomain || '',
            },
        };
    }

    return null;
}

module.exports = {
    getRuntimeSupport,
    getRuntimeSnapshot,
};
