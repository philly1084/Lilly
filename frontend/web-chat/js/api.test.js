const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadApiClient(fetchMock = jest.fn()) {
    const source = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
    const window = {
        location: {
            hostname: 'localhost',
            protocol: 'http:',
            host: 'localhost:3000',
            href: 'http://localhost:3000/web-chat/app.html',
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
