const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadApiClient(fetchMock = jest.fn(), locationOverrides = {}) {
    const source = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
    const window = {
        location: {
            hostname: 'localhost',
            protocol: 'http:',
            host: 'localhost:3000',
            port: '3000',
            href: 'http://localhost:3000/web-chat/app.html',
            ...locationOverrides,
        },
        KimiBuiltGatewaySSE: null,
        KimiBuiltWebChatWorkspace: null,
        sessionManager: null,
    };
    const context = {
        window,
        fetch: fetchMock,
        console,
        EventTarget,
        URL,
        URLSearchParams,
        Intl,
        Date,
        setTimeout,
        clearTimeout,
    };
    window.window = window;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'api.js' });

    return {
        apiClient: context.window.apiClient,
        fetchMock,
    };
}

describe('web-chat image API client', () => {
    test('omits response_format by default for GPT image requests', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                created: 123,
                data: [{ url: '/generated/example.png' }],
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await apiClient.generateImage({
            prompt: 'developer tools banner',
            model: 'gpt-image-2',
            size: 'auto',
            n: 1,
            sessionId: 'session-1',
        });

        expect(fetchMock).toHaveBeenCalledWith(
            'http://localhost:3000/v1/images/generations',
            expect.objectContaining({
                method: 'POST',
                credentials: 'same-origin',
            }),
        );
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).toEqual(expect.objectContaining({
            prompt: 'developer tools banner',
            model: 'gpt-image-2',
            size: 'auto',
            n: 1,
            sessionId: 'session-1',
            taskType: 'image',
            clientSurface: 'web-chat',
        }));
        expect(body).not.toHaveProperty('response_format');
    });

    test('preserves an explicit response_format override', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                created: 123,
                data: [{ b64_json: 'aGVsbG8=' }],
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await apiClient.generateImage({
            prompt: 'developer tools banner',
            model: 'gpt-image-2',
            response_format: 'b64_json',
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).toEqual(expect.objectContaining({
            model: 'gpt-image-2',
            response_format: 'b64_json',
        }));
    });
});

describe('web-chat API origin selection', () => {
    test('uses the current local port-3000 origin instead of hard-coding localhost', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                data: [],
                meta: {},
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock, {
            hostname: '127.0.0.1',
            host: '127.0.0.1:3000',
            port: '3000',
            href: 'http://127.0.0.1:3000/web-chat/app.html',
        });

        await apiClient.getAvailableTools(null, { includeAll: true });

        expect(fetchMock.mock.calls[0][0]).toContain('http://127.0.0.1:3000/api/tools/available');
    });

    test('keeps the backend fallback for non-3000 local preview ports', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                data: [],
                meta: {},
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock, {
            hostname: '127.0.0.1',
            host: '127.0.0.1:3100',
            port: '3100',
            href: 'http://127.0.0.1:3100/web-chat/app.html',
        });

        await apiClient.getAvailableTools(null, { includeAll: true });

        expect(fetchMock.mock.calls[0][0]).toContain('http://localhost:3000/api/tools/available');
    });
});

describe('web-chat remote build metadata', () => {
    test('sends plugin menu execution profile and planned tools in chat requests', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'ok' } }],
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await apiClient.chat([{
            role: 'user',
            content: 'Make a source-backed launch plan.',
        }], 'auto', '', {
            executionProfile: 'remote-build',
            metadata: {
                toolSelectionSource: 'web-chat-plugin-menu',
                selectedPluginLanes: ['research', 'remote'],
                plannedTools: ['web-search', 'web-fetch', 'remote-cli-agent'],
                preferredTool: 'remote-cli-agent',
                userToolIntents: [
                    { id: 'research', tools: ['web-search', 'web-fetch'] },
                    { id: 'remote', tools: ['remote-cli-agent'] },
                ],
            },
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.executionProfile).toBe('remote-build');
        expect(body.metadata).toEqual(expect.objectContaining({
            toolSelectionSource: 'web-chat-plugin-menu',
            selectedPluginLanes: ['research', 'remote'],
            plannedTools: ['web-search', 'web-fetch', 'remote-cli-agent'],
            preferredTool: 'remote-cli-agent',
        }));
        expect(body.metadata.userToolIntents).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'research' }),
            expect.objectContaining({ id: 'remote' }),
        ]));
    });

    test('does not prefer managed-app for explicit remote-cli-agent chat requests', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'ok' } }],
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await apiClient.chat([{
            role: 'user',
            content: 'Use remote-cli-agent with adminMode true to update the website on the remote k3s server.',
        }]);

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.executionProfile).toBe('remote-build');
        expect(body.metadata).toEqual(expect.objectContaining({
            remoteBuildAutonomyApproved: true,
            frontendRemoteBuildAutonomyApproved: true,
            remoteBuildIntent: true,
            preferredTool: 'remote-cli-agent',
            plannedTools: ['remote-cli-agent'],
        }));
        expect(body.metadata.preferManagedApp).toBeUndefined();
    });

    test('prefers managed-app only for explicit managed or GitLab chat requests', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'ok' } }],
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await apiClient.chat([{
            role: 'user',
            content: 'Use the managed-app GitLab path to build and deploy a public website.',
        }]);

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.executionProfile).toBe('remote-build');
        expect(body.metadata.preferManagedApp).toBe(true);
    });

    test('marks selected-document managed-app deploy follow-ups as remote-build', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'ok' } }],
            }),
        }));
        const { apiClient } = loadApiClient(fetchMock);

        await apiClient.chat([{
            role: 'user',
            content: 'Update this document (light-it-up-event-holiday-architectural-405gr2.html): lets deploy this to the web, lightitup.demoserver2.buzz on our remote server using the managed app',
        }]);

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.executionProfile).toBe('remote-build');
        expect(body.metadata).toEqual(expect.objectContaining({
            remoteBuildAutonomyApproved: true,
            frontendRemoteBuildAutonomyApproved: true,
            remoteBuildIntent: true,
            preferManagedApp: true,
        }));
    });
});
