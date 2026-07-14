const fs = require('fs');
const path = require('path');

function readSidebarSource() {
    return fs.readFileSync(path.join(__dirname, 'sidebar.js'), 'utf8');
}

describe('Notes search modal accessibility semantics', () => {
    test('opens search as a labeled dialog and restores focus when closed', () => {
        const source = readSidebarSource();

        expect(source).toContain('showSearchModal(triggerElement = document.activeElement)');
        expect(source).toContain("e.key?.toLowerCase() === 'f'");
        expect(source).toContain("modal.setAttribute('role', 'dialog')");
        expect(source).toContain("modal.setAttribute('aria-modal', 'true')");
        expect(source).toContain("modal.setAttribute('aria-labelledby', 'search-modal-title')");
        expect(source).toContain("modal.setAttribute('aria-describedby', 'search-modal-description')");
        expect(source).toContain('id="search-modal-title"');
        expect(source).toContain('id="search-modal-description" class="sr-only"');
        expect(source).toContain('type="button" aria-label="Close search"');
        expect(source).toContain('function closeSearchModal()');
        expect(source).toContain("document.querySelector('#page-title, #editor .block-input, #editor [contenteditable=\"true\"], #editor')");
        expect(source).toContain('focusTarget?.focus?.({ preventScroll: true })');
    });

    test('keeps the search input and results wired as a combobox listbox', () => {
        const source = readSidebarSource();

        expect(source).toContain('role="combobox"');
        expect(source).toContain('aria-controls="search-results"');
        expect(source).toContain('aria-autocomplete="list"');
        expect(source).toContain('role="listbox" aria-label="Search results"');
        expect(source).toContain('id="search-results-status" role="status" aria-live="polite"');
    });

    test('renders search results as selectable options with active descendant state', () => {
        const source = readSidebarSource();

        expect(source).toContain('searchInput.setAttribute(\'aria-activedescendant\', selectedResultId)');
        expect(source).toContain('searchInput.removeAttribute(\'aria-activedescendant\')');
        expect(source).toContain('role="option"');
        expect(source).toContain('aria-selected="${index === selectedIndex ? \'true\' : \'false\'}"');
    });

    test('announces search result state without stealing combobox focus', () => {
        const source = readSidebarSource();

        expect(source).toContain("searchResultsStatus.textContent = isPlaceholder ? 'Type to search across all pages' : message");
        expect(source).toContain("const resultLabel = currentResults.length === 1 ? '1 result' : `${currentResults.length} results`");
        expect(source).toContain('searchResultsStatus.textContent = `${resultLabel} found`');
    });
});

describe('Notes collapsed sidebar handle accessibility', () => {
    test('keeps the main sidebar toggle stateful and tied to the sidebar region', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const source = readSidebarSource();

        expect(html).toContain('id="sidebar-toggle"');
        expect(html).toContain('type="button" title="Collapse sidebar" aria-label="Collapse sidebar" aria-controls="sidebar" aria-expanded="true"');
        expect(source).toContain('let sidebarToggleEl = null;');
        expect(source).toContain("sidebarToggleEl = document.getElementById('sidebar-toggle')");
        expect(source).toContain('function syncSidebarToggleState(collapsed)');
        expect(source).toContain("sidebarToggleEl.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true')");
        expect(source).toContain("sidebarToggleEl.setAttribute('aria-label', isCollapsed ? 'Expand sidebar' : 'Collapse sidebar')");
        expect(source).toContain("sidebarToggleEl.setAttribute('title', isCollapsed ? 'Expand sidebar' : 'Collapse sidebar')");
    });

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

describe('Notes export menu accessibility', () => {
    test('wires the export dropdown as an announced keyboard menu', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const source = readSidebarSource();

        expect(html).toContain('id="export-btn"');
        expect(html).toContain('aria-haspopup="menu"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('aria-controls="export-menu"');
        expect(html).toContain('id="export-menu"');
        expect(html).toContain('role="menu"');
        expect(html).toContain('aria-label="Export formats"');
        ['docx', 'pdf', 'html', 'md', 'json', 'txt'].forEach((format) => {
            expect(html).toContain(`data-format="${format}" role="menuitem" tabindex="-1"`);
        });

        expect(source).toContain('const setExportMenuOpen = (isOpen, focusFirst = false) => {');
        expect(source).toContain('exportBtn.setAttribute(\'aria-expanded\', isOpen ? \'true\' : \'false\')');
        expect(source).toContain('if (e.key !== \'ArrowDown\' && e.key !== \'ArrowUp\') return;');
        expect(source).toContain('if (e.key === \'Escape\')');
        expect(source).toContain('moveExportFocus(item, e.key === \'ArrowDown\' ? 1 : -1)');
    });
});

describe('Notes page icon picker accessibility', () => {
    test('announces the picker and keeps its keyboard state synchronized', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const source = readSidebarSource();

        expect(html).toContain('id="page-icon-btn"');
        expect(html).toContain('aria-haspopup="dialog" aria-expanded="false" aria-controls="emoji-picker"');
        expect(html).toContain('id="emoji-picker" class="emoji-picker" role="dialog"');
        expect(html).toContain('aria-label="Choose a page icon" aria-hidden="true"');
        expect(html).toContain('id="emoji-search" placeholder="Search emoji..." aria-label="Search page icons"');
        expect(html).toContain('css/styles.css?v=20260714-page-icon-picker');
        expect(source).toContain("target.setAttribute('aria-expanded', 'true')");
        expect(source).toContain("picker.setAttribute('aria-hidden', 'false')");
        expect(source).toContain("span.setAttribute('role', 'button')");
        expect(source).toContain("span.setAttribute('aria-label', `Use ${emoji} as page icon`)");
        expect(source).toContain("if (e.key !== 'Escape') return;");
        expect(source).toContain('hideEmojiPicker(true)');
    });
});

describe('Notes block action menu accessibility', () => {
    test('exposes focusable menu items with standard keyboard navigation', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const source = fs.readFileSync(path.join(__dirname, 'selection.js'), 'utf8');

        expect(html).toContain('id="block-context-menu"');
        expect(html).toContain('role="menu" aria-label="Block actions"');
        expect(html).toContain('data-action="ask-ai" role="menuitem" tabindex="-1"');
        expect(html).toContain('data-action="color" role="menuitem" tabindex="-1"');
        expect(source).toContain("menu.querySelectorAll('[role=\"menuitem\"]')");
        expect(source).toContain("if (e.key === 'Escape')");
        expect(source).toContain('menu.returnFocusTarget?.focus?.()');
        expect(source).toContain("if (e.key === 'Enter' || e.key === ' ')");
        expect(source).toContain("['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)");
        expect(source).toContain('items[nextIndex]?.focus()');
    });
});

describe('Notes theme toggle accessibility', () => {
    test('announces the target theme action while exposing pressed state', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const source = readSidebarSource();

        expect(html).toContain('id="theme-toggle"');
        expect(html).toContain('type="button" title="Switch to dark mode" aria-label="Switch to dark mode" aria-pressed="false"');
        expect(source).toContain('let themeToggleEl = null;');
        expect(source).toContain("themeToggleEl = document.getElementById('theme-toggle')");
        expect(source).toContain('syncThemeToggleState(Storage.getTheme())');
        expect(source).toContain('function syncThemeToggleState(theme)');
        expect(source).toContain("themeToggleEl.setAttribute('aria-pressed', isDark ? 'true' : 'false')");
        expect(source).toContain("themeToggleEl.setAttribute('aria-label', actionLabel)");
        expect(source).toContain("themeToggleEl.setAttribute('title', actionLabel)");
    });
});

describe('Notes import modal accessibility', () => {
    test('opens import as a described keyboard-friendly dialog', () => {
        const source = readSidebarSource();

        expect(source).toContain('showImportModal(triggerElement = document.activeElement)');
        expect(source).toContain("modal.setAttribute('role', 'dialog')");
        expect(source).toContain("modal.setAttribute('aria-modal', 'true')");
        expect(source).toContain("modal.setAttribute('aria-label', 'Import page')");
        expect(source).toContain("modal.setAttribute('aria-describedby', 'import-modal-description')");
        expect(source).toContain('type="button" aria-label="Close import dialog"');
        expect(source).toContain('id="file-drop-zone" role="button" tabindex="0" aria-describedby="import-modal-description"');
        expect(source).toContain('id="import-modal-description"');
    });

    test('supports Escape close, focus return, and keyboard file browsing', () => {
        const source = readSidebarSource();

        expect(source).toContain('function closeImportModal()');
        expect(source).toContain('triggerElement.focus()');
        expect(source).toContain('function handleImportModalKeydown(e)');
        expect(source).toContain("if (e.key !== 'Escape') return;");
        expect(source).toContain("if (e.key !== 'Enter' && e.key !== ' ') return;");
        expect(source).toContain("item.setAttribute('role', 'button')");
        expect(source).toContain("item.setAttribute('tabindex', '0')");
        expect(source).toContain("modal.querySelector('.import-modal-close')?.focus({ preventScroll: true })");
    });
});

describe('Notes cover picker selection state', () => {
    test('shows and announces the active preset when the picker reopens', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const source = readSidebarSource();
        const styles = fs.readFileSync(path.join(__dirname, '..', 'css', 'notion-refinements.css'), 'utf8');

        expect(source).toContain("const activeCover = String(page.cover || '').trim()");
        expect(source).toContain("const isCurrent = String(cover.value || '').trim() === activeCover");
        expect(source).toContain("aria-pressed=\"${isCurrent}\"");
        expect(source).toContain("${isCurrent ? '<span class=\"cover-preset-state\">Current</span>' : ''}</span>");
        expect(styles).toContain('.cover-preset.is-current');
        expect(styles).toContain('.cover-preset-state');
        expect(html).toContain('js/sidebar.js?v=20260714-page-icon-picker');
        expect(html).toContain('css/notion-refinements.css?v=20260714-mobile-overflow-v1');
    });
});

describe('Notes mobile content containment', () => {
    test('keeps wide blocks inside the editor while preserving local horizontal scrolling', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const baseStyles = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');
        const responsiveStyles = fs.readFileSync(path.join(__dirname, '..', 'css', 'notion-refinements.css'), 'utf8');

        expect(html).toContain('css/styles.css?v=20260714-page-icon-picker');
        expect(html).toContain('css/notion-refinements.css?v=20260714-mobile-overflow-v1');
        expect(baseStyles).toMatch(/\.main-content\s*{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow-x:\s*hidden;/s);
        expect(baseStyles).toMatch(/\.chart-scroll-region\s*{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;[^}]*touch-action:\s*pan-x pan-y;/s);
        expect(responsiveStyles).toMatch(/\.database-scroll-region,\s*\.chart-scroll-region\s*{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;[^}]*touch-action:\s*pan-x pan-y;/s);
        expect(responsiveStyles).toMatch(/\.image-wrapper img,\s*\.ai-image\s*{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*height:\s*auto;/s);
    });
});
