'use strict';

jest.mock('../postgres', () => ({
    postgres: {
        enabled: true,
        query: jest.fn(),
    },
}));

const { postgres } = require('../postgres');
const { ManagedAppStore } = require('./store');

describe('ManagedAppStore', () => {
    let store;

    beforeEach(() => {
        store = new ManagedAppStore();
        postgres.enabled = true;
        postgres.query.mockReset();
    });

    test('creates and maps a managed app', async () => {
        postgres.query.mockResolvedValueOnce({
            rows: [{
                id: 'app-1',
                owner_id: 'phill',
                session_id: 'session-1',
                slug: 'arcade-demo',
                app_name: 'Arcade Demo',
                repo_owner: 'agent-apps',
                repo_name: 'arcade-demo',
                repo_url: 'https://gitea.example/agent-apps/arcade-demo.git',
                repo_clone_url: 'https://gitea.example/agent-apps/arcade-demo.git',
                repo_ssh_url: 'ssh://git@gitea.example/agent-apps/arcade-demo.git',
                default_branch: 'main',
                image_repo: 'gitea.example/agent-apps/arcade-demo',
                namespace: 'app-arcade-demo',
                public_host: 'arcade-demo.demoserver2.buzz',
                status: 'building',
                source_prompt: 'Build an arcade demo.',
                metadata: { managedBy: 'kimibuilt' },
                created_at: '2026-04-18T10:00:00.000Z',
                updated_at: '2026-04-18T10:01:00.000Z',
            }],
        });

        const app = await store.createApp({
            ownerId: 'phill',
            sessionId: 'session-1',
            slug: 'arcade-demo',
            appName: 'Arcade Demo',
            repoOwner: 'agent-apps',
            repoName: 'arcade-demo',
            repoUrl: 'https://gitea.example/agent-apps/arcade-demo.git',
            repoCloneUrl: 'https://gitea.example/agent-apps/arcade-demo.git',
            repoSshUrl: 'ssh://git@gitea.example/agent-apps/arcade-demo.git',
            defaultBranch: 'main',
            imageRepo: 'gitea.example/agent-apps/arcade-demo',
            namespace: 'app-arcade-demo',
            publicHost: 'arcade-demo.demoserver2.buzz',
            status: 'building',
            sourcePrompt: 'Build an arcade demo.',
            metadata: { managedBy: 'kimibuilt' },
        });

        expect(app).toEqual(expect.objectContaining({
            id: 'app-1',
            ownerId: 'phill',
            slug: 'arcade-demo',
            status: 'building',
            publicHost: 'arcade-demo.demoserver2.buzz',
        }));
        expect(postgres.query).toHaveBeenCalledTimes(1);
        expect(postgres.query.mock.calls[0][0]).toContain('INSERT INTO managed_apps');
    });

    test('maps build runs with deploy and verification status fields', async () => {
        postgres.query.mockResolvedValueOnce({
            rows: [{
                id: 'run-1',
                app_id: 'app-1',
                owner_id: 'phill',
                session_id: 'session-1',
                source: 'gitea-webhook',
                requested_action: 'deploy',
                commit_sha: 'abcdef123456',
                image_tag: 'sha-abcdef123456',
                image_digest: '',
                build_status: 'success',
                deploy_requested: true,
                deploy_status: 'succeeded',
                verification_status: 'live',
                external_run_id: '42',
                external_run_url: 'https://gitea.example/agent-apps/arcade-demo/actions/runs/42',
                error: {},
                metadata: { deployment: { namespace: 'app-arcade-demo' } },
                started_at: '2026-04-18T10:05:00.000Z',
                finished_at: '2026-04-18T10:06:00.000Z',
                created_at: '2026-04-18T10:05:00.000Z',
                updated_at: '2026-04-18T10:06:00.000Z',
            }],
        });

        const run = await store.createBuildRun({
            appId: 'app-1',
            ownerId: 'phill',
            requestedAction: 'deploy',
            commitSha: 'abcdef123456',
            imageTag: 'sha-abcdef123456',
            buildStatus: 'success',
            deployRequested: true,
            deployStatus: 'succeeded',
            verificationStatus: 'live',
        });

        expect(run).toEqual(expect.objectContaining({
            id: 'run-1',
            requestedAction: 'deploy',
            buildStatus: 'success',
            deployRequested: true,
            deployStatus: 'succeeded',
            verificationStatus: 'live',
        }));
        expect(postgres.query.mock.calls[0][0]).toContain('INSERT INTO managed_app_build_runs');
    });

    test('returns null when an external build run id has no persisted match', async () => {
        postgres.query.mockResolvedValueOnce({ rows: [] });

        await expect(store.getBuildRunByExternalRunId('89')).resolves.toBeNull();
        expect(postgres.query).toHaveBeenCalledWith(
            'SELECT * FROM managed_app_build_runs WHERE external_run_id = $1 LIMIT 1',
            ['89'],
        );
    });

    test('updates repo owner and repo name for an existing app', async () => {
        postgres.query
            .mockResolvedValueOnce({
                rows: [{
                    id: 'app-1',
                    owner_id: 'phill',
                    session_id: 'session-1',
                    slug: 'hello-stack',
                    app_name: 'Hello Stack',
                    repo_owner: '',
                    repo_name: '',
                    repo_url: 'https://gitea.example/agent-apps/hello-stack.git',
                    repo_clone_url: 'https://gitea.example/agent-apps/hello-stack.git',
                    repo_ssh_url: '',
                    default_branch: 'main',
                    image_repo: 'gitea.example/agent-apps/hello-stack',
                    namespace: 'app-hello-stack',
                    public_host: 'hello-stack.demoserver2.buzz',
                    status: 'draft',
                    source_prompt: '',
                    metadata: {},
                }],
            })
            .mockResolvedValueOnce({
                rows: [{
                    id: 'app-1',
                    owner_id: 'phill',
                    session_id: 'session-1',
                    slug: 'hello-stack',
                    app_name: 'Hello Stack',
                    repo_owner: 'agent-apps',
                    repo_name: 'hello-stack',
                    repo_url: 'https://gitea.example/agent-apps/hello-stack.git',
                    repo_clone_url: 'https://gitea.example/agent-apps/hello-stack.git',
                    repo_ssh_url: '',
                    default_branch: 'main',
                    image_repo: 'gitea.example/agent-apps/hello-stack',
                    namespace: 'app-hello-stack',
                    public_host: 'hello-stack.demoserver2.buzz',
                    status: 'provisioning',
                    source_prompt: '',
                    metadata: {},
                }],
            });

        const app = await store.updateApp('app-1', 'phill', {
            repoOwner: 'agent-apps',
            repoName: 'hello-stack',
            status: 'provisioning',
        });

        expect(app.repoOwner).toBe('agent-apps');
        expect(app.repoName).toBe('hello-stack');
        expect(postgres.query.mock.calls[1][1][4]).toBe('agent-apps');
        expect(postgres.query.mock.calls[1][1][5]).toBe('hello-stack');
    });

    test('updates an app without an owner scope when the caller passes null', async () => {
        postgres.query
            .mockResolvedValueOnce({
                rows: [{
                    id: 'app-1',
                    owner_id: 'phill',
                    session_id: 'session-1',
                    slug: 'hello-stack',
                    app_name: 'Hello Stack',
                    repo_owner: 'agent-apps',
                    repo_name: 'hello-stack',
                    repo_url: 'https://gitea.example/agent-apps/hello-stack.git',
                    repo_clone_url: 'https://gitea.example/agent-apps/hello-stack.git',
                    repo_ssh_url: '',
                    default_branch: 'main',
                    image_repo: 'gitea.example/agent-apps/hello-stack',
                    namespace: 'app-hello-stack',
                    public_host: 'hello-stack.demoserver2.buzz',
                    status: 'draft',
                    source_prompt: '',
                    metadata: {},
                }],
            })
            .mockResolvedValueOnce({
                rows: [{
                    id: 'app-1',
                    owner_id: 'phill',
                    session_id: 'session-1',
                    slug: 'hello-stack',
                    app_name: 'Hello Stack',
                    repo_owner: 'agent-apps',
                    repo_name: 'hello-stack',
                    repo_url: 'https://gitea.example/agent-apps/hello-stack.git',
                    repo_clone_url: 'https://gitea.example/agent-apps/hello-stack.git',
                    repo_ssh_url: '',
                    default_branch: 'main',
                    image_repo: 'gitea.example/agent-apps/hello-stack',
                    namespace: 'app-hello-stack',
                    public_host: 'hello-stack.demoserver2.buzz',
                    status: 'provisioning',
                    source_prompt: '',
                    metadata: {},
                }],
            });

        const app = await store.updateApp('app-1', null, {
            status: 'provisioning',
        });

        expect(app.id).toBe('app-1');
        expect(postgres.query.mock.calls[1][0]).not.toContain('owner_id = $2');
        expect(postgres.query.mock.calls[1][1][0]).toBe('app-1');
        expect(postgres.query.mock.calls[1][1][12]).toBe('provisioning');
    });

    test('rejects build run creation without an app id', async () => {
        await expect(store.createBuildRun({
            ownerId: 'phill',
            requestedAction: 'deploy',
        })).rejects.toThrow('Managed app build runs require an appId.');
        expect(postgres.query).not.toHaveBeenCalled();
    });
});
