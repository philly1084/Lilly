const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadBlocks(overrides = {}) {
    const source = fs.readFileSync(path.join(__dirname, 'blocks.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://localhost:3000/notes',
    });
    const windowObject = dom.window;
    Object.assign(windowObject, overrides.window || {});
    const context = {
        console,
        window: windowObject,
        document: windowObject.document,
        setTimeout,
        clearTimeout,
        Date,
        Math,
        URL,
    };
    context.global = context;
    context.globalThis = context;
    vm.runInNewContext(`${source}\nglobalThis.__Blocks = window.Blocks;`, context, { filename: 'blocks.js' });
    return context.__Blocks;
}

describe('Notes Blocks database normalization', () => {
    test('maps object rows onto declared database columns', () => {
        const Blocks = loadBlocks();

        const database = Blocks.normalizeDatabaseContent({
            columns: ['Venue', 'Area', 'Why it works'],
            rows: [
                {
                    Venue: 'The Noodle Guy',
                    Area: 'Port Williams',
                    'Why it works': 'Casual dinner stop',
                },
                {
                    venue: 'Lightfoot & Wolfville',
                    area: 'Wolfville',
                    'why it works': 'Wine and view',
                },
            ],
        });

        expect(database.rows).toEqual([
            ['The Noodle Guy', 'Port Williams', 'Casual dinner stop'],
            ['Lightfoot & Wolfville', 'Wolfville', 'Wine and view'],
        ]);
    });

    test('derives columns from object rows when the model omits columns', () => {
        const Blocks = loadBlocks();

        const database = Blocks.normalizeDatabaseContent({
            rows: [
                { Name: 'Dinner', Status: 'Booked' },
                { Name: 'Walk', Notes: 'Waterfront' },
            ],
        });

        expect(database.columns).toEqual(['Name', 'Status', 'Notes']);
        expect(database.rows).toEqual([
            ['Dinner', 'Booked', ''],
            ['Walk', '', 'Waterfront'],
        ]);
    });

    test('uses structured table headers and cell values for extracted databases', () => {
        const Blocks = loadBlocks();

        const database = Blocks.normalizeDatabaseContent({
            headers: [
                { id: 'c1', header: 'Patient Key', columnIndex: 0 },
                { id: 'c2', header: 'Patient Balance', columnIndex: 1 },
            ],
            rows: [{
                id: 'r1',
                cells: [
                    { columnId: 'c1', columnIndex: 0, header: 'Patient Key', value: 'P001' },
                    { columnId: 'c2', columnIndex: 1, header: 'Patient Balance', value: '250' },
                ],
            }],
        });

        expect(database.columns).toEqual(['Patient Key', 'Patient Balance']);
        expect(database.rows).toEqual([['P001', '250']]);
    });

    test('replaces duplicated generic output headers with readable column labels', () => {
        const Blocks = loadBlocks();

        const database = Blocks.normalizeDatabaseContent({
            columns: [{ output: 'Output' }, { output: 'Output' }],
            rows: [['Main body still works', 'Second value']],
        });

        expect(database.columns).toEqual(['Column 1', 'Column 2']);
        expect(database.rows).toEqual([['Main body still works', 'Second value']]);
    });
});

describe('Notes Blocks image rendering', () => {
    test('auto-searches Unsplash photo pages instead of treating them as renderable image URLs', () => {
        const searchUnsplash = jest.fn(() => new Promise(() => {}));
        const Blocks = loadBlocks({
            window: {
                API: { searchUnsplash },
                Editor: { savePage: jest.fn() },
            },
        });

        const block = {
            type: 'ai_image',
            content: {
                prompt: 'Penguins during daytime',
                imageUrl: null,
                source: 'unsplash',
                status: 'pending',
                downloadUrl: 'https://unsplash.com/photos/penguins-during-daytime-_FRAYdYmQCM',
            },
        };

        const rendered = Blocks.render.ai_image(block, false);

        expect(searchUnsplash).toHaveBeenCalledWith('Penguins during daytime', { perPage: 1 });
        expect(block.content.status).toBe('generating');
        expect(rendered.querySelector('.ai-image-loading-text')?.textContent).toBe('Searching Unsplash...');
        expect(rendered.querySelector('img')).toBeNull();
    });

    test('renders direct Unsplash image CDN URLs without forcing a search', () => {
        const searchUnsplash = jest.fn();
        const Blocks = loadBlocks({
            window: {
                API: { searchUnsplash },
                Editor: { savePage: jest.fn() },
            },
        });

        const block = {
            type: 'ai_image',
            content: {
                prompt: 'Paris art hero',
                imageUrl: 'https://images.unsplash.com/photo-12345',
                source: 'unsplash',
                status: 'done',
                downloadUrl: 'https://unsplash.com/photos/paris-art-12345',
            },
        };

        const rendered = Blocks.render.ai_image(block, false);
        const image = rendered.querySelector('img.ai-image');

        expect(searchUnsplash).not.toHaveBeenCalled();
        expect(image).not.toBeNull();
        expect(image.getAttribute('src')).toBe('https://images.unsplash.com/photo-12345');
    });
});
