'use strict';

const settingsController = require('../routes/admin/settings.controller');

function normalizeText(value = '') {
    return String(value || '').trim();
}

function normalizeApiBaseUrl(value = '') {
    return normalizeText(value).replace(/\/+$/, '');
}

function safePath(value = '') {
    const normalized = normalizeText(value).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized || normalized.includes('..')) {
        throw new Error(`Invalid repository file path: ${value}`);
    }
    return normalized;
}

function encodeProjectPath(owner = '', repo = '') {
    const repoOwner = normalizeText(owner);
    const repoName = normalizeText(repo);
    if (!repoOwner || !repoName) {
        throw new Error('GitLab project operations require an owner/group and project name.');
    }
    return encodeURIComponent(`${repoOwner}/${repoName}`);
}

function normalizeVisibility(privateRepo = true) {
    return privateRepo === false ? 'internal' : 'private';
}

function normalizePipelineStatus(value = '') {
    const normalized = normalizeText(value).toLowerCase();
    if (normalized === 'success') {
        return 'success';
    }
    if (['failed', 'canceled', 'cancelled', 'skipped', 'manual'].includes(normalized)) {
        return 'failed';
    }
    if (['running'].includes(normalized)) {
        return 'running';
    }
    return normalized || 'queued';
}

function mapProject(payload = {}) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }
    return {
        ...payload,
        html_url: payload.web_url || payload.html_url || '',
        clone_url: payload.http_url_to_repo || payload.clone_url || payload.web_url || '',
        ssh_url: payload.ssh_url_to_repo || payload.ssh_url || '',
    };
}

function mapPipelineRun(pipeline = {}) {
    return {
        ...pipeline,
        id: pipeline.id,
        run_id: pipeline.id,
        status: normalizePipelineStatus(pipeline.status),
        conclusion: normalizePipelineStatus(pipeline.status),
        head_sha: pipeline.sha || pipeline.head_sha || '',
        html_url: pipeline.web_url || pipeline.html_url || '',
        run_url: pipeline.web_url || pipeline.html_url || '',
        created_at: pipeline.created_at,
        updated_at: pipeline.updated_at,
        started_at: pipeline.started_at,
        completed_at: pipeline.finished_at || pipeline.completed_at,
    };
}

class GitLabClient {
    getConfig() {
        if (typeof settingsController.getEffectiveGitLabConfig === 'function') {
            return settingsController.getEffectiveGitLabConfig();
        }
        if (typeof settingsController.getEffectiveGitProviderConfig === 'function') {
            return settingsController.getEffectiveGitProviderConfig();
        }
        return {};
    }

    isConfigured() {
        const config = this.getConfig();
        return Boolean(config.enabled !== false && config.baseURL && config.token && config.org);
    }

    buildApiUrl(pathname = '', query = null) {
        const config = this.getConfig();
        const baseURL = normalizeApiBaseUrl(config.baseURL);
        if (!baseURL) {
            throw new Error('Managed app repository operations require integrations.gitlab.baseURL.');
        }

        const url = new URL(`/api/v4${pathname.startsWith('/') ? pathname : `/${pathname}`}`, `${baseURL}/`);
        if (query && typeof query === 'object') {
            Object.entries(query).forEach(([key, value]) => {
                if (value === undefined || value === null || value === '') {
                    return;
                }
                url.searchParams.set(key, String(value));
            });
        }
        return url;
    }

    async request(method, pathname, { query = null, body = null, headers = {}, allowNotFound = false } = {}) {
        const config = this.getConfig();
        if (!this.isConfigured()) {
            throw new Error('Managed app repository operations require a configured external GitLab control plane.');
        }

        const response = await fetch(this.buildApiUrl(pathname, query), {
            method,
            headers: {
                'PRIVATE-TOKEN': config.token,
                Accept: 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...headers,
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });

        if (allowNotFound && response.status === 404) {
            return null;
        }

        if (!response.ok) {
            const errorText = await response.text();
            const authHint = [401, 403].includes(response.status)
                ? ' Check integrations.gitlab.token / GITLAB_TOKEN: it must be a GitLab API token with access to the configured group and the required api/write_repository permissions.'
                : '';
            const error = new Error(`GitLab API ${method} ${pathname} failed: HTTP ${response.status}${errorText ? ` ${errorText}` : ''}${authHint}`);
            error.statusCode = response.status;
            if (authHint) {
                error.code = response.status === 401 ? 'gitlab_auth_rejected' : 'gitlab_access_forbidden';
                error.remediation = 'Create or rotate the GitLab PAT/service token, save it as integrations.gitlab.token or GITLAB_TOKEN, and verify it can GET /api/v4/groups/<configured-group>.';
            }
            throw error;
        }

        const text = await response.text();
        if (!text) {
            return {};
        }

        try {
            return JSON.parse(text);
        } catch (_error) {
            return { raw: text };
        }
    }

    async getCurrentUser() {
        return this.request('GET', '/user');
    }

    async getOrganization(name = '') {
        const groupName = normalizeText(name);
        if (!groupName) {
            return null;
        }
        return this.request('GET', `/groups/${encodeURIComponent(groupName)}`, {
            allowNotFound: true,
        });
    }

    async ensureOrganization({
        name = '',
        fullName = '',
        description = '',
    } = {}) {
        const groupPath = normalizeText(name) || this.getConfig().org;
        if (!groupPath) {
            throw new Error('Managed app repository creation requires a GitLab group path.');
        }

        const existing = await this.getOrganization(groupPath);
        if (existing) {
            return {
                organization: existing,
                created: false,
            };
        }

        const created = await this.request('POST', '/groups', {
            body: {
                name: normalizeText(fullName) || groupPath,
                path: groupPath,
                description: normalizeText(description) || 'Managed applications provisioned by KimiBuilt.',
                visibility: 'private',
                project_creation_level: 'maintainer',
            },
        });

        return {
            organization: created,
            created: true,
        };
    }

    async getRepository(owner = '', repo = '') {
        return this.request('GET', `/projects/${encodeProjectPath(owner, repo)}`, {
            allowNotFound: true,
        }).then((project) => (project ? mapProject(project) : null));
    }

    async ensureRepository({
        owner = '',
        name = '',
        description = '',
        privateRepo = true,
        defaultBranch = 'main',
    } = {}) {
        const repoOwner = normalizeText(owner) || this.getConfig().org;
        const repoName = normalizeText(name);
        if (!repoOwner || !repoName) {
            throw new Error('Managed app repository creation requires an owner/group and project name.');
        }

        const existing = await this.getRepository(repoOwner, repoName);
        if (existing) {
            return {
                repository: existing,
                created: false,
            };
        }

        const group = await this.ensureOrganization({
            name: repoOwner,
            fullName: repoOwner,
        });
        const namespaceId = group?.organization?.id;
        const created = await this.request('POST', '/projects', {
            body: {
                name: repoName,
                path: repoName,
                description: normalizeText(description),
                visibility: normalizeVisibility(privateRepo),
                initialize_with_readme: true,
                default_branch: normalizeText(defaultBranch) || 'main',
                ...(namespaceId ? { namespace_id: namespaceId } : {}),
            },
        });

        return {
            repository: mapProject(created),
            created: true,
        };
    }

    async getContentMetadata({ owner = '', repo = '', filePath = '', ref = 'main' } = {}) {
        return this.request('GET', `/projects/${encodeProjectPath(owner, repo)}/repository/files/${encodeURIComponent(safePath(filePath))}`, {
            query: { ref },
            allowNotFound: true,
        });
    }

    async upsertFile({
        owner = '',
        repo = '',
        branch = 'main',
        filePath = '',
        content = '',
        message = '',
    } = {}) {
        const normalizedPath = safePath(filePath);
        const existing = await this.getContentMetadata({
            owner,
            repo,
            filePath: normalizedPath,
            ref: branch,
        });
        const method = existing ? 'PUT' : 'POST';
        const response = await this.request(method, `/projects/${encodeProjectPath(owner, repo)}/repository/files/${encodeURIComponent(normalizedPath)}`, {
            body: {
                branch: normalizeText(branch) || 'main',
                content,
                commit_message: normalizeText(message) || `Update ${normalizedPath}`,
            },
        });

        return {
            ...response,
            commit: {
                sha: response?.commit_id || response?.commit?.sha || '',
            },
        };
    }

    async upsertFiles({
        owner = '',
        repo = '',
        branch = 'main',
        files = [],
        commitMessagePrefix = 'Seed managed app repository',
    } = {}) {
        const normalizedFiles = (Array.isArray(files) ? files : [])
            .filter((entry) => entry && typeof entry === 'object' && normalizeText(entry.path))
            .map((entry) => ({
                path: safePath(entry.path),
                content: String(entry.content || ''),
            }))
            .sort((left, right) => left.path.localeCompare(right.path));

        if (normalizedFiles.length === 0) {
            return {
                commitSha: '',
                committedPaths: [],
            };
        }

        const actions = [];
        for (const file of normalizedFiles) {
            const existing = await this.getContentMetadata({
                owner,
                repo,
                filePath: file.path,
                ref: branch,
            });
            actions.push({
                action: existing ? 'update' : 'create',
                file_path: file.path,
                content: file.content,
            });
        }

        const response = await this.request('POST', `/projects/${encodeProjectPath(owner, repo)}/repository/commits`, {
            body: {
                branch: normalizeText(branch) || 'main',
                commit_message: commitMessagePrefix,
                actions,
            },
        });

        return {
            commitSha: normalizeText(response?.id || response?.short_id || response?.commit?.id),
            committedPaths: normalizedFiles.map((file) => file.path),
        };
    }

    async listRepositoryWorkflowRuns({
        owner = '',
        repo = '',
        branch = '',
        status = '',
        headSha = '',
        page = 1,
        limit = 20,
    } = {}) {
        const payload = await this.request('GET', `/projects/${encodeProjectPath(owner, repo)}/pipelines`, {
            query: {
                ref: normalizeText(branch),
                sha: normalizeText(headSha),
                status: normalizeText(status),
                page: Number.isFinite(Number(page)) ? Math.max(1, Number(page)) : 1,
                per_page: Number.isFinite(Number(limit)) ? Math.max(1, Math.min(Number(limit), 100)) : 20,
            },
        });

        const pipelines = Array.isArray(payload) ? payload : [];
        return {
            workflowRuns: pipelines.map(mapPipelineRun),
            totalCount: pipelines.length,
        };
    }

    async getRunnerRegistrationToken() {
        throw new Error('GitLab runner tokens are created in the GitLab UI or API and should be supplied as GITLAB_RUNNER_TOKEN.');
    }

    async listActionsRunners() {
        return {
            scope: 'gitlab',
            runners: [],
            totalCount: 0,
        };
    }
}

module.exports = {
    GitLabClient,
};
