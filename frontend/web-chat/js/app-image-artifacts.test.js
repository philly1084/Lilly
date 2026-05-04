const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadChatAppPrototype() {
    const sourcePath = path.join(__dirname, 'app.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/\/\/ Initialize app when DOM is ready[\s\S]*$/, 'globalThis.ChatApp = ChatApp;');

    const context = {
        window: {
            location: { origin: 'https://chat.example.test' },
            KimiBuiltWebChatWorkspace: null,
            KimiBuiltWebChatWorkspaceEmbed: null,
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
    return context.ChatApp.prototype;
}

describe('web-chat generated image artifact previews', () => {
    test('builds a multi-image selection message from artifact-backed final chunks', () => {
        const app = Object.create(loadChatAppPrototype());

        const message = app.buildGeneratedImageArtifactSelectionMessage('assistant-1', [
            {
                id: 'image-artifact-1',
                filename: 'first.png',
                format: 'png',
                mimeType: 'image/png',
            },
            {
                id: 'image-artifact-2',
                filename: 'second.png',
                format: 'png',
                mimeType: 'image/png',
                download_url: '/api/artifacts/image-artifact-2/download',
            },
        ], {
            prompt: 'dashboard hero',
            model: 'gpt-image-2',
        });

        expect(message).toEqual(expect.objectContaining({
            id: 'assistant-1-image-artifacts',
            type: 'image-selection',
            parentMessageId: 'assistant-1',
            prompt: 'dashboard hero',
            model: 'gpt-image-2',
        }));
        expect(message.results).toHaveLength(2);
        expect(message.results[0]).toEqual(expect.objectContaining({
            artifactId: 'image-artifact-1',
            filename: 'first.png',
            imageUrl: 'https://chat.example.test/api/artifacts/image-artifact-1/download?inline=1',
            thumbnailUrl: 'https://chat.example.test/api/artifacts/image-artifact-1/download?inline=1',
        }));
        expect(message.results[1].downloadUrl).toBe('https://chat.example.test/api/artifacts/image-artifact-2/download');
    });

    test('does not create a chooser for a single generated artifact', () => {
        const app = Object.create(loadChatAppPrototype());

        expect(app.buildGeneratedImageArtifactSelectionMessage('assistant-1', [{
            id: 'image-artifact-1',
            filename: 'first.png',
            mimeType: 'image/png',
        }])).toBeNull();
    });
});
