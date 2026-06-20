const originalFetch = globalThis.fetch;
const originalAccessKey = process.env.UNSPLASH_ACCESS_KEY;

describe('unsplash-client', () => {
    beforeEach(() => {
        jest.resetModules();
        process.env.UNSPLASH_ACCESS_KEY = 'test-access-key';
    });

    afterEach(() => {
        if (originalFetch === undefined) {
            delete globalThis.fetch;
        } else {
            globalThis.fetch = originalFetch;
        }

        if (originalAccessKey === undefined) {
            delete process.env.UNSPLASH_ACCESS_KEY;
        } else {
            process.env.UNSPLASH_ACCESS_KEY = originalAccessKey;
        }
    });

    test('uses the native runtime fetch when available', async () => {
        const nativeFetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                total: 1,
                total_pages: 1,
                results: [{
                    id: 'image-1',
                    description: 'A workspace',
                    alt_description: 'A calm workspace',
                    urls: {
                        raw: 'https://images.unsplash.com/photo-1',
                        full: 'https://images.unsplash.com/photo-1',
                        regular: 'https://images.unsplash.com/photo-1',
                        small: 'https://images.unsplash.com/photo-1',
                        thumb: 'https://images.unsplash.com/photo-1',
                    },
                    links: {
                        html: 'https://unsplash.com/photos/image-1',
                        download: 'https://unsplash.com/photos/image-1/download',
                        download_location: 'https://api.unsplash.com/photos/image-1/download',
                    },
                    user: {
                        id: 'user-1',
                        name: 'Example Photographer',
                        username: 'example',
                        portfolio_url: null,
                        profile_image: { small: 'https://images.unsplash.com/profile-1' },
                        links: { html: 'https://unsplash.com/@example' },
                    },
                    width: 1200,
                    height: 800,
                    color: '#ffffff',
                    likes: 10,
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-02T00:00:00Z',
                }],
            }),
        }));

        globalThis.fetch = nativeFetch;

        const { searchImages } = require('./unsplash-client');
        const result = await searchImages('workspace', { perPage: 3 });

        expect(nativeFetch).toHaveBeenCalledTimes(1);
        expect(nativeFetch.mock.calls[0][0]).toContain('https://api.unsplash.com/search/photos?');
        expect(nativeFetch.mock.calls[0][1].headers.Authorization).toBe('Client-ID test-access-key');
        expect(result.results[0].id).toBe('image-1');
    });
});
