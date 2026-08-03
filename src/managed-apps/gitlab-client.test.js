'use strict';

jest.mock('../routes/admin/settings.controller', () => ({
    getEffectiveGitLabConfig: jest.fn(() => ({
        enabled: true,
        baseURL: 'https://gitlab.example.com',
        token: 'gitlab-token',
        org: 'agent-apps',
    })),
}));

const { GitLabClient } = require('./gitlab-client');

describe('GitLabClient', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    test('creates the managed app group when it does not exist', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 404,
                text: async () => '',
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 201,
                text: async () => JSON.stringify({
                    id: 12,
                    path: 'agent-apps',
                    full_path: 'agent-apps',
                }),
            });

        const client = new GitLabClient();
        const result = await client.ensureOrganization({
            name: 'agent-apps',
            fullName: 'KimiBuilt Managed Apps',
        });

        expect(result.created).toBe(true);
        expect(result.organization).toEqual(expect.objectContaining({
            path: 'agent-apps',
        }));
        expect(global.fetch).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                href: 'https://gitlab.example.com/api/v4/groups/agent-apps',
            }),
            expect.objectContaining({
                method: 'GET',
            }),
        );
        expect(global.fetch).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                href: 'https://gitlab.example.com/api/v4/groups',
            }),
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('"path":"agent-apps"'),
            }),
        );
    });

    test('adds actionable remediation when GitLab rejects the configured token', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 401,
                text: async () => JSON.stringify({ message: '401 Unauthorized' }),
            });

        const client = new GitLabClient();

        await expect(client.getOrganization('agent-apps')).rejects.toMatchObject({
            code: 'gitlab_auth_rejected',
            statusCode: 401,
            message: expect.stringContaining('Check integrations.gitlab.token / GITLAB_TOKEN'),
            remediation: expect.stringContaining('GET /api/v4/groups/<configured-group>'),
        });
    });

    test('creates a GitLab project in the managed app group', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 404,
                text: async () => '',
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    id: 12,
                    path: 'agent-apps',
                    full_path: 'agent-apps',
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 201,
                text: async () => JSON.stringify({
                    id: 42,
                    path: 'demo-app',
                    web_url: 'https://gitlab.example.com/agent-apps/demo-app',
                    http_url_to_repo: 'https://gitlab.example.com/agent-apps/demo-app.git',
                    ssh_url_to_repo: 'git@gitlab.example.com:agent-apps/demo-app.git',
                }),
            });

        const client = new GitLabClient();
        const result = await client.ensureRepository({
            owner: 'agent-apps',
            name: 'demo-app',
            defaultBranch: 'main',
        });

        expect(result.created).toBe(true);
        expect(result.repository).toEqual(expect.objectContaining({
            html_url: 'https://gitlab.example.com/agent-apps/demo-app',
            clone_url: 'https://gitlab.example.com/agent-apps/demo-app.git',
            ssh_url: 'git@gitlab.example.com:agent-apps/demo-app.git',
        }));
        expect(global.fetch).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                href: 'https://gitlab.example.com/api/v4/projects/agent-apps%2Fdemo-app',
            }),
            expect.objectContaining({
                method: 'GET',
            }),
        );
        expect(global.fetch).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                href: 'https://gitlab.example.com/api/v4/projects',
            }),
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('"initialize_with_readme":true'),
            }),
        );
    });

    test('commits multiple files in one GitLab commit', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 404,
                text: async () => '',
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    file_path: 'README.md',
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 201,
                text: async () => JSON.stringify({
                    id: 'abcdef1234567890',
                }),
            });

        const client = new GitLabClient();
        const result = await client.upsertFiles({
            owner: 'agent-apps',
            repo: 'demo-app',
            branch: 'main',
            files: [
                { path: '.gitlab-ci.yml', content: 'stages: [build]\n' },
                { path: 'README.md', content: '# Demo\n' },
            ],
            commitMessagePrefix: 'Seed managed app',
        });

        expect(result.commitSha).toBe('abcdef1234567890');
        expect(result.committedPaths).toEqual(['.gitlab-ci.yml', 'README.md']);
        expect(global.fetch).toHaveBeenLastCalledWith(
            expect.objectContaining({
                href: 'https://gitlab.example.com/api/v4/projects/agent-apps%2Fdemo-app/repository/commits',
            }),
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('"action":"create"'),
            }),
        );
        expect(global.fetch.mock.calls[2][1].body).toContain('"action":"update"');
    });

    test('marks binary repository actions as base64 without altering their content', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' })
            .mockResolvedValueOnce({ ok: true, status: 201, text: async () => JSON.stringify({ id: 'binary-commit-sha' }) });
        const client = new GitLabClient();
        const content = Buffer.from([0, 255, 17, 128]).toString('base64');
        await client.upsertFiles({ owner: 'agent-apps', repo: 'game', branch: 'main', files: [{ path: 'public/assets/model.glb', content, encoding: 'base64' }] });
        const body = JSON.parse(global.fetch.mock.calls[1][1].body);
        expect(body.actions).toEqual([{ action: 'create', file_path: 'public/assets/model.glb', content, encoding: 'base64' }]);
    });

    test('lists GitLab pipelines filtered by sha', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify([{
                id: 77,
                sha: 'abcdef1234567890',
                status: 'success',
                web_url: 'https://gitlab.example.com/agent-apps/demo-app/-/pipelines/77',
            }]),
        });

        const client = new GitLabClient();
        const result = await client.listRepositoryWorkflowRuns({
            owner: 'agent-apps',
            repo: 'demo-app',
            headSha: 'abcdef1234567890',
            limit: 5,
        });

        expect(result.workflowRuns).toEqual([expect.objectContaining({
            id: 77,
            head_sha: 'abcdef1234567890',
            conclusion: 'success',
        })]);
        expect(global.fetch).toHaveBeenCalledWith(
            expect.objectContaining({
                href: 'https://gitlab.example.com/api/v4/projects/agent-apps%2Fdemo-app/pipelines?sha=abcdef1234567890&page=1&per_page=5',
            }),
            expect.objectContaining({
                method: 'GET',
            }),
        );
    });
});
