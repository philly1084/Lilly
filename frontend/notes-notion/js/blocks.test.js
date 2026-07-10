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
    if (overrides.withContext) {
        return {
            Blocks: context.__Blocks,
            window: windowObject,
            document: windowObject.document,
        };
    }
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

    test('renders databases as horizontal scroll regions with a computed table width', () => {
        const { Blocks } = loadBlocks({ withContext: true });

        const rendered = Blocks.render.database({
            type: 'database',
            content: {
                columns: ['Account', 'Owner', 'Status', 'Next Step', 'Notes'],
                rows: [
                    ['Northwind', 'Maya', 'Qualified', 'Send proposal', 'Long spreadsheet-like value'],
                ],
            },
        }, true);

        const region = rendered.querySelector('.database-scroll-region');
        const table = rendered.querySelector('.database-table');
        const scrollButtons = rendered.querySelectorAll('.database-scroll-button');
        const scrollSlider = rendered.querySelector('.database-scroll-slider');

        expect(rendered.classList.contains('database-block-shell')).toBe(true);
        expect(region.classList.contains('database-scroll-region')).toBe(true);
        expect(region.getAttribute('role')).toBe('region');
        expect(region.getAttribute('aria-label')).toContain('scroll horizontally');
        expect(region.tabIndex).toBe(0);
        expect(scrollButtons).toHaveLength(2);
        expect(scrollButtons[0].getAttribute('aria-label')).toContain('left');
        expect(scrollButtons[1].getAttribute('aria-label')).toContain('right');
        expect(scrollSlider).not.toBeNull();
        expect(scrollSlider.type).toBe('range');
        expect(scrollSlider.getAttribute('aria-label')).toContain('Horizontal position');
        expect(table.style.getPropertyValue('--database-table-min-width')).toMatch(/px$/);
        expect(Number.parseInt(table.style.getPropertyValue('--database-table-min-width'), 10)).toBeGreaterThan(480);
    });

    test('uses the database slider to set and reflect horizontal scroll position', () => {
        const { Blocks } = loadBlocks({ withContext: true });
        const rendered = Blocks.render.database({
            type: 'database',
            content: {
                columns: ['One', 'Two', 'Three', 'Four'],
                rows: [['A', 'B', 'C', 'D']],
            },
        }, true);
        const region = rendered.querySelector('.database-scroll-region');
        const slider = rendered.querySelector('.database-scroll-slider');

        Object.defineProperty(region, 'scrollWidth', { configurable: true, value: 1000 });
        Object.defineProperty(region, 'clientWidth', { configurable: true, value: 400 });
        slider.value = '50';
        const Event = region.ownerDocument.defaultView.Event;
        slider.dispatchEvent(new Event('input', { bubbles: true }));

        expect(region.scrollLeft).toBe(300);
        region.scrollLeft = 450;
        region.dispatchEvent(new Event('scroll'));
        expect(slider.value).toBe('75');
    });

    test('renders wide charts with a draggable horizontal position slider', () => {
        const { Blocks } = loadBlocks({ withContext: true });
        const rendered = Blocks.render.chart({
            type: 'chart',
            content: {
                title: 'Monthly totals',
                chartType: 'bar',
                labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'],
                values: [1, 2, 3, 4, 5, 6, 7, 8],
            },
        }, true);

        expect(rendered.classList.contains('chart-block-shell')).toBe(true);
        expect(rendered.querySelector('.chart-scroll-region')?.getAttribute('aria-label')).toContain('scroll horizontally');
        expect(rendered.querySelector('.chart-scroll-slider')?.type).toBe('range');
        expect(rendered.querySelector('.chart-body').style.getPropertyValue('--chart-content-min-width')).toBe('672px');
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

describe('Notes Blocks code copy', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('copies code blocks through the Clipboard API when available', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        const { Blocks, window, document } = loadBlocks({ withContext: true });
        Object.defineProperty(window.navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        });
        document.execCommand = jest.fn(() => true);

        const rendered = Blocks.render.code({
            id: 'code-1',
            type: 'code',
            content: { language: 'javascript', text: 'console.log("ready");' },
        }, false);

        rendered.querySelector('.code-copy').click();
        await writeText.mock.results[0].value;
        await Promise.resolve();

        expect(writeText).toHaveBeenCalledWith('console.log("ready");');
        expect(document.execCommand).not.toHaveBeenCalled();
    });

    test('falls back to a temporary textarea when Clipboard API is unavailable', async () => {
        const { Blocks, window, document } = loadBlocks({ withContext: true });
        Object.defineProperty(window.navigator, 'clipboard', {
            value: undefined,
            configurable: true,
        });
        document.execCommand = jest.fn(() => true);

        const rendered = Blocks.render.code({
            id: 'code-2',
            type: 'code',
            content: { language: 'bash', text: 'npm test' },
        }, false);

        rendered.querySelector('.code-copy').click();
        await Promise.resolve();
        await Promise.resolve();

        expect(document.execCommand).toHaveBeenCalledWith('copy');
        expect(document.querySelector('textarea')).toBeNull();
        expect(rendered.querySelector('.code-copy').textContent).toBe('Copied!');
    });
});
