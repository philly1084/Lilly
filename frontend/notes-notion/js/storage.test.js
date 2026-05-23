const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadStorage() {
    const source = fs.readFileSync(path.join(__dirname, 'storage.js'), 'utf8');
    const localValues = new Map();
    const localStorage = {
        getItem: jest.fn((key) => localValues.has(key) ? localValues.get(key) : null),
        setItem: jest.fn((key, value) => {
            localValues.set(key, String(value));
        }),
        removeItem: jest.fn((key) => {
            localValues.delete(key);
        }),
    };
    const context = {
        console,
        document: {
            documentElement: {
                setAttribute: jest.fn(),
            },
        },
        window: {},
        localStorage,
        setTimeout,
        clearTimeout,
        Date,
        Math,
    };

    context.global = context;
    context.globalThis = context;
    vm.runInNewContext(`${source}\nglobalThis.__Storage = Storage;`, context, { filename: 'storage.js' });
    return {
        Storage: context.__Storage,
        localValues,
    };
}

function readStoredNotes(localValues) {
    return JSON.parse(localValues.get('notes_notion_data'));
}

describe('Notes Storage AI image normalization', () => {
    test('does not persist stale generating status after a refreshable save', () => {
        const { Storage, localValues } = loadStorage();

        Storage.saveAll({
            pages: [{
                id: 'page-1',
                title: 'Images',
                blocks: [{
                    id: 'image-1',
                    type: 'ai_image',
                    content: {
                        prompt: 'A mountain cabin',
                        status: 'generating',
                        _activeGeneration: true,
                        imageUrl: null,
                    },
                    children: [],
                }],
            }],
            trash: [],
            spaces: [{ id: 'private', name: 'Private' }],
            currentSpaceId: 'private',
        });

        const storedBlock = readStoredNotes(localValues).pages[0].blocks[0];
        expect(storedBlock.content.status).toBe('pending');
        expect(storedBlock.content).not.toHaveProperty('_activeGeneration');
    });

    test('keeps generated image artifacts recallable when local blob URLs cannot survive reload', () => {
        const { Storage, localValues } = loadStorage();

        Storage.saveAll({
            pages: [{
                id: 'page-1',
                title: 'Images',
                blocks: [{
                    id: 'image-1',
                    type: 'ai_image',
                    content: {
                        prompt: 'A bright product render',
                        status: 'done',
                        imageUrl: '',
                        artifactId: 'artifact-image-1',
                        generatedImages: [{
                            artifactId: 'artifact-image-1',
                            inlineUrl: '/api/artifacts/artifact-image-1/download?inline=1',
                            downloadUrl: '/api/artifacts/artifact-image-1/download',
                        }],
                    },
                    children: [],
                }],
            }],
            trash: [],
            spaces: [{ id: 'private', name: 'Private' }],
            currentSpaceId: 'private',
        });

        const storedBlock = readStoredNotes(localValues).pages[0].blocks[0];
        expect(storedBlock.content.status).toBe('done');
        expect(storedBlock.content.imageUrl).toBe('/api/artifacts/artifact-image-1/download?inline=1');
    });

    test('rewrites transient blob image URLs to durable asset references', () => {
        const { Storage, localValues } = loadStorage();

        Storage.saveAll({
            pages: [{
                id: 'page-1',
                title: 'Images',
                blocks: [{
                    id: 'image-1',
                    type: 'ai_image',
                    content: {
                        prompt: 'A saved local image',
                        status: 'done',
                        imageUrl: 'blob:http://localhost/not-for-storage',
                        imageAssetId: 'asset-123',
                    },
                    children: [],
                }],
            }],
            trash: [],
            spaces: [{ id: 'private', name: 'Private' }],
            currentSpaceId: 'private',
        });

        const storedBlock = readStoredNotes(localValues).pages[0].blocks[0];
        expect(storedBlock.content.status).toBe('done');
        expect(storedBlock.content.imageUrl).toBe('asset://asset-123');
    });
});
