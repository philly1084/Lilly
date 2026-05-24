const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadNotesApi(fetchMock = jest.fn()) {
    const source = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
    const window = {
        location: {
            protocol: 'https:',
            host: 'notes.example.test',
            origin: 'https://notes.example.test',
        },
        KimiBuiltGatewaySSE: null,
    };
    const context = {
        window,
        fetch: fetchMock,
        console,
        URL,
        OpenAI: undefined,
    };

    vm.runInNewContext(`${source}\nglobalThis.__API = API;`, context, { filename: 'api.js' });
    return {
        API: context.__API,
        fetchMock,
    };
}

describe('Notes image API client', () => {
    test('does not force response_format and normalizes empty image options', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                data: [{ url: '/api/artifacts/image-1/download' }],
            }),
        }));
        const { API } = loadNotesApi(fetchMock);

        await API.generateImage({
            prompt: 'editorial model comparison poster',
            model: 'gpt-image-2',
            size: '',
            quality: '',
            style: '',
            sessionId: 'page-1',
        });

        expect(fetchMock).toHaveBeenCalledWith(
            'https://notes.example.test/v1/images/generations',
            expect.objectContaining({
                method: 'POST',
                credentials: 'same-origin',
            }),
        );
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).toEqual(expect.objectContaining({
            prompt: 'editorial model comparison poster',
            model: 'gpt-image-2',
            size: 'auto',
            taskType: 'image',
            clientSurface: 'notes',
            session_id: 'page-1',
        }));
        expect(body).not.toHaveProperty('response_format');
        expect(body).not.toHaveProperty('quality');
        expect(body).not.toHaveProperty('style');
    });

    test('preserves an explicit response_format override', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                data: [{ b64_json: 'aGVsbG8=' }],
            }),
        }));
        const { API } = loadNotesApi(fetchMock);

        await API.generateImage({
            prompt: 'editorial model comparison poster',
            model: 'gpt-image-2',
            response_format: 'b64_json',
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).toEqual(expect.objectContaining({
            model: 'gpt-image-2',
            response_format: 'b64_json',
        }));
    });

    test('summarizes image route failures without leaking raw diagnostic JSON', async () => {
        const fetchMock = jest.fn(async () => ({
            ok: false,
            status: 500,
            text: async () => JSON.stringify({
                error: 'Provider returned a blank assistant completion.',
                diagnostics: {
                    imageGeneration: {
                        code: 'provider_or_backend_error',
                        responseShape: { keys: ['error'] },
                    },
                },
                diagnosticSummary: 'provider_or_backend_error | stage=route_error | provider=gateway | parsed=0',
            }),
        }));
        const { API } = loadNotesApi(fetchMock);

        await expect(API.generateImage({
            prompt: 'editorial model comparison poster',
            model: 'gpt-image-2',
        })).rejects.toThrow('HTTP 500: Provider returned a blank assistant completion. provider_or_backend_error | stage=route_error | provider=gateway | parsed=0');

        await expect(API.generateImage({
            prompt: 'editorial model comparison poster',
            model: 'gpt-image-2',
        })).rejects.not.toThrow('responseShape');
    });
});
