const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadChatApp() {
    const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
        .replace(/\/\/ Initialize app when DOM is ready[\s\S]*$/, 'globalThis.ChatApp = ChatApp;');
    const context = {
        window: {
            location: { origin: 'https://chat.example.test' },
            KimiBuiltWebChatWorkspace: null,
            KimiBuiltWebChatWorkspaceEmbed: null,
            fileManager: { addFile: jest.fn() },
        },
        document: {
            getElementById: () => null,
            addEventListener: () => {},
        },
        URL,
        console,
    };

    vm.createContext(context);
    vm.runInContext(source, context);
    return { context, prototype: context.ChatApp.prototype };
}

describe('web-chat podcast launch kit conversation lifecycle', () => {
    test('finds the saved campaign card in the session where it started', () => {
        const { context, prototype } = loadChatApp();
        const campaignMessage = {
            id: 'launch-card-1',
            type: 'content-studio-campaign',
            campaign: { id: 'campaign-1', sessionId: 'session-1' },
        };
        context.sessionManager = {
            currentSessionId: 'session-2',
            getMessages: jest.fn((sessionId) => sessionId === 'session-1' ? [campaignMessage] : []),
        };
        const app = Object.create(prototype);

        expect(app.getPodcastLaunchKitMessage('campaign-1', 'session-1')).toBe(campaignMessage);
        expect(app.getPodcastLaunchKitCampaign('campaign-1', 'session-1')).toEqual(campaignMessage.campaign);
        expect(app.getPodcastLaunchKitMessage('campaign-1', 'session-2')).toBeNull();
    });

    test('updates the existing campaign card instead of adding duplicate messages', async () => {
        const { context, prototype } = loadChatApp();
        const existingMessage = {
            id: 'launch-card-1',
            type: 'content-studio-campaign',
            campaign: { id: 'campaign-1', status: 'planned' },
        };
        context.sessionManager = {
            currentSessionId: 'session-1',
            getMessages: jest.fn(() => [existingMessage]),
            syncMessageToBackend: jest.fn(),
        };
        context.uiHelpers = { generateMessageId: jest.fn(() => 'generated-1') };
        const app = Object.create(prototype);
        app.upsertSessionMessage = jest.fn((_sessionId, message) => message);
        app.isVisibleSession = jest.fn(() => false);

        const saved = await app.addPodcastLaunchKitMessage({
            id: 'campaign-1',
            sessionId: 'session-1',
            status: 'rendering',
            plan: { title: 'Launch day' },
            render: { stages: { episode: { status: 'running' } } },
        });

        expect(saved.id).toBe('launch-card-1');
        expect(saved.campaign.status).toBe('rendering');
        expect(app.upsertSessionMessage).toHaveBeenCalledWith('session-1', expect.objectContaining({
            id: 'launch-card-1',
            type: 'content-studio-campaign',
        }));
        expect(context.sessionManager.syncMessageToBackend).toHaveBeenCalledWith('session-1', saved);
    });

    test('polls saved render stages without reverting the card to planned state', async () => {
        const { context, prototype } = loadChatApp();
        let scheduledRefresh = null;
        context.window.setInterval = jest.fn((callback) => {
            scheduledRefresh = callback;
            return 17;
        });
        context.window.clearInterval = jest.fn();
        context.apiClient = {
            getPodcastLaunchKit: jest.fn()
                .mockResolvedValueOnce({ campaign: { id: 'campaign-1', status: 'planned' } })
                .mockResolvedValueOnce({ campaign: { id: 'campaign-1', status: 'rendering' } }),
        };
        const app = Object.create(prototype);
        app.addPodcastLaunchKitMessage = jest.fn();

        const stop = app.startPodcastLaunchKitProgressPolling('campaign-1', 'session-1', 'launch-card-1');
        await new Promise((resolve) => setImmediate(resolve));
        expect(app.addPodcastLaunchKitMessage).not.toHaveBeenCalled();

        await scheduledRefresh();
        expect(app.addPodcastLaunchKitMessage).toHaveBeenCalledWith(
            { id: 'campaign-1', status: 'rendering' },
            { sessionId: 'session-1', messageId: 'launch-card-1', persist: false },
        );

        stop();
        expect(context.window.clearInterval).toHaveBeenCalledWith(17);
    });
});
