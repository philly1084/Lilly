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

describe('Notes collapsed sidebar handle accessibility', () => {
    test('wires the collapsed sidebar handle as a stateful controlled button', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const source = readSidebarSource();

        expect(html).toContain('id="sidebar-handle"');
        expect(html).toContain('role="button"');
        expect(html).toContain('aria-controls="sidebar"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('tabindex="0"');
        expect(html).not.toContain('onclick="Sidebar.toggle()"');
        expect(source).toContain('sidebarHandleEl.addEventListener(\'click\', () => setSidebarCollapsed(false))');
        expect(source).toContain('sidebarHandleEl.addEventListener(\'keydown\', handleSidebarHandleKeydown)');
        expect(source).toContain('sidebarHandleEl.setAttribute(\'aria-expanded\', collapsed ? \'false\' : \'true\')');
    });

    test('supports Enter and Space keyboard activation for the sidebar handle', () => {
        const source = readSidebarSource();

        expect(source).toContain('function handleSidebarHandleKeydown(e)');
        expect(source).toContain('if (e.key !== \'Enter\' && e.key !== \' \') return;');
        expect(source).toContain('e.preventDefault();');
        expect(source).toContain('setSidebarCollapsed(false);');
    });
});
