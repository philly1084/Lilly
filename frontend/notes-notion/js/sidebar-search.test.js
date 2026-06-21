const fs = require('fs');
const path = require('path');

function readSidebarSource() {
    return fs.readFileSync(path.join(__dirname, 'sidebar.js'), 'utf8');
}

describe('Notes search modal accessibility semantics', () => {
    test('keeps the search input and results wired as a combobox listbox', () => {
        const source = readSidebarSource();

        expect(source).toContain('role="combobox"');
        expect(source).toContain('aria-controls="search-results"');
        expect(source).toContain('aria-autocomplete="list"');
        expect(source).toContain('role="listbox" aria-label="Search results"');
    });

    test('renders search results as selectable options with active descendant state', () => {
        const source = readSidebarSource();

        expect(source).toContain('searchInput.setAttribute(\'aria-activedescendant\', selectedResultId)');
        expect(source).toContain('searchInput.removeAttribute(\'aria-activedescendant\')');
        expect(source).toContain('role="option"');
        expect(source).toContain('aria-selected="${index === selectedIndex ? \'true\' : \'false\'}"');
    });
});
