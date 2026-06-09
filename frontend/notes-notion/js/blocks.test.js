const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadBlocks() {
    const source = fs.readFileSync(path.join(__dirname, 'blocks.js'), 'utf8');
    const context = {
        console,
        window: {},
        setTimeout,
        clearTimeout,
        Date,
        Math,
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
});
