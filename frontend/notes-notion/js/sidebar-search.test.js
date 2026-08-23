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

describe('Notes mobile sidebar accessibility', () => {
    test('names the mobile trigger from its current state', () => {
        const source = readSidebarSource();

        expect(source).toContain("mobileToggle.setAttribute('aria-label', 'Open sidebar')");
        expect(source).toContain("toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false')");
        expect(source).toContain("toggle.setAttribute('aria-label', isOpen ? 'Close sidebar' : 'Open sidebar')");
        expect(source).toContain("toggle.setAttribute('title', isOpen ? 'Close sidebar' : 'Open sidebar')");
    });

    test('uses a native button for the mobile dismiss backdrop', () => {
        const source = readSidebarSource();

        expect(source).toContain("backdrop = document.createElement('button')");
        expect(source).toContain("backdrop.type = 'button'");
        expect(source).toContain("backdrop.setAttribute('aria-label', 'Close sidebar')");
        expect(source).not.toContain("backdrop.setAttribute('role', 'button')");
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

describe('Notes template chooser accessibility', () => {
    test('opens a named modal with keyboard-operable template choices and focus return', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const source = readSidebarSource();
        const styles = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');

        expect(source).toContain('showTemplateModal(triggerElement = document.activeElement)');
        expect(source).toContain("modal.setAttribute('role', 'dialog')");
        expect(source).toContain("modal.setAttribute('aria-modal', 'true')");
        expect(source).toContain("modal.setAttribute('aria-labelledby', 'template-modal-title')");
        expect(source).toContain('id="template-modal-title" class="template-modal-title"');
        expect(source).toContain('class="template-modal-close" type="button" aria-label="Close template chooser"');
        expect(source).toContain('class="template-card" type="button" data-template="${t.id}"');
        expect(source).toContain("if (e.key === 'Escape')");
        expect(source).toContain("if (e.key !== 'Tab') return;");
        expect(source).toContain('triggerElement.focus({ preventScroll: true })');
        expect(source).toContain("modal.querySelector('.template-card')?.focus({ preventScroll: true })");
        expect(styles).toContain('.template-card:focus-visible');
        expect(styles).toMatch(/@media \(max-width: 600px\)[\s\S]*\.template-grid\s*{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
        expect(html).toContain('css/styles.css?v=20260823a');
        expect(html).toContain('js/sidebar.js?v=20260823-trash-state');
    });
});

describe('Notes storage information accessibility', () => {
    test('opens as a named modal and returns keyboard focus when closed', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const source = readSidebarSource();

        expect(source).toContain('showStorageInfo(triggerElement = document.activeElement)');
        expect(source).toContain("showStorageInfo(document.getElementById('settings-btn'))");
        expect(source).toContain("modal.setAttribute('role', 'dialog')");
        expect(source).toContain("modal.setAttribute('aria-modal', 'true')");
        expect(source).toContain("modal.setAttribute('aria-labelledby', 'storage-status-title')");
        expect(source).toContain('id="storage-status-title">Storage Information</span>');
        expect(source).toContain('class="close-btn storage-status-close" type="button" aria-label="Close storage information"');
        expect(source).toContain("if (e.key === 'Escape')");
        expect(source).toContain("if (e.key !== 'Tab') return;");
        expect(source).toContain('triggerElement?.focus?.({ preventScroll: true })');
        expect(source).toContain('closeButton.focus({ preventScroll: true })');
        expect(html).toContain('js/sidebar.js?v=20260823-trash-state');
    });
});

describe('Notes settings dialog accessibility', () => {
    test('opens as a named modal, contains focus, and restores the launcher', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const source = readSidebarSource();

        expect(html).toContain('id="settings-btn" class="footer-btn" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="settings-modal"');
        expect(html).toContain('js/sidebar.js?v=20260823-trash-state');
        expect(source).toMatch(/function openSettings\(event\)[\s\S]*?modal\.id = 'settings-modal';\s*modal\.className = 'ai-modal is-open'/);
        expect(source).toContain("triggerElement?.setAttribute?.('aria-expanded', 'true')");
        expect(source).toContain("triggerElement?.setAttribute?.('aria-expanded', 'false')");
        expect(source).toContain("modal.setAttribute('role', 'dialog')");
        expect(source).toContain("modal.setAttribute('aria-modal', 'true')");
        expect(source).toContain("modal.setAttribute('aria-labelledby', 'settings-modal-title')");
        expect(source).toContain('id="settings-modal-title">Settings</span>');
        expect(source).toContain('class="settings-close" type="button" aria-label="Close settings"');
        expect(source).toContain("if (e.key === 'Escape')");
        expect(source).toContain("if (e.key !== 'Tab') return;");
        expect(source).toContain('triggerElement.focus({ preventScroll: true })');
        expect(source).toContain('closeButton.focus({ preventScroll: true })');
    });
});

describe('Notes trash dialog accessibility', () => {
    test('opens as a named modal, contains focus, and restores the launcher', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const source = readSidebarSource();

        expect(html).toContain('id="trash-btn" class="footer-btn" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="trash-modal"');
        expect(html).toContain('js/sidebar.js?v=20260823-trash-state');
        expect(source).toContain('function showTrash(event)');
        expect(source).toContain("modal.id = 'trash-modal'");
        expect(source).toContain("triggerElement?.setAttribute?.('aria-expanded', 'true')");
        expect(source).toContain("triggerElement?.setAttribute?.('aria-expanded', 'false')");
        expect(source).toContain("modal.setAttribute('role', 'dialog')");
        expect(source).toContain("modal.setAttribute('aria-modal', 'true')");
        expect(source).toContain("modal.setAttribute('aria-labelledby', 'trash-modal-title')");
        expect(source).toContain('id="trash-modal-title">Trash</span>');
        expect(source).toContain('class="ai-btn primary close-modal" type="button"');
        expect(source).toContain('const closeTrash = () => {');
        expect(source).toContain("if (e.key === 'Escape')");
        expect(source).toContain("if (e.key !== 'Tab') return;");
        expect(source).toContain('triggerElement.focus({ preventScroll: true })');
        expect(source).toContain('closeButton.focus({ preventScroll: true })');
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
        expect(html).toContain('<button class="emoji-category active" type="button" data-category="recent" aria-label="Recent icons" aria-pressed="true" tabindex="0">');
        expect(html).toContain('data-category="smileys" aria-label="Smileys" aria-pressed="false" tabindex="-1"');
        expect(html).toContain('css/styles.css?v=20260823a');
        expect(html).toContain('js/sidebar.js?v=20260823-trash-state');
        expect(source).toContain("target.setAttribute('aria-expanded', 'true')");
        expect(source).toContain("picker.setAttribute('aria-hidden', 'false')");
        expect(source).toContain("['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)");
        expect(source).toContain("item.setAttribute('tabindex', index === categoryIndex ? '0' : '-1')");
        expect(source).toContain('focusCategory(nextIndex)');
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

    test('opens the block style picker as a keyboard-operable named dialog', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const source = fs.readFileSync(path.join(__dirname, 'selection.js'), 'utf8');
        const styles = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');

        expect(html).toContain('id="color-picker" class="color-picker" role="dialog" aria-modal="false" aria-labelledby="color-picker-title" aria-hidden="true"');
        expect(html).toContain('id="color-picker-title" class="sr-only">Block style</div>');
        expect(html).toContain('js/selection.js?v=20260715-block-style-picker-v3');
        expect(source).toContain('showColorPicker(blockId, menu.returnFocusTarget)');
        expect(source).toContain("picker.classList.add('is-open')");
        expect(source).toContain("picker.classList.remove('is-open')");
        expect(source).toContain("picker.setAttribute('aria-hidden', 'false')");
        expect(source).toContain("returnFocusTarget.setAttribute('tabindex', '-1')");
        expect(source).toContain("option.setAttribute('role', 'button')");
        expect(source).toContain("option.setAttribute('tabindex', '0')");
        expect(source).toContain("if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.color-option, .style-option'))");
        expect(source).toContain('closeColorPicker(true)');
        expect(styles).toContain('.color-option:focus-visible,');
        expect(styles).toContain('.style-option:focus-visible');
        expect(html).toContain('css/notion-refinements.css?v=20260715-block-style-picker');
        expect(fs.readFileSync(path.join(__dirname, '..', 'css', 'notion-refinements.css'), 'utf8')).toContain('.color-picker.is-open');
    });
});

describe('Notes page title accessibility', () => {
    test('gives the editable title a stable purpose-based name', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

        expect(html).toContain('id="page-title"');
        expect(html).toContain('placeholder="Untitled"');
        expect(html).toContain('aria-label="Page title"');
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
        expect(html).toContain('js/sidebar.js?v=20260823-trash-state');
        expect(html).toContain('css/notion-refinements.css?v=20260715-block-style-picker');
    });
});

describe('Notes cover action keyboard visibility', () => {
    test('reveals hover-only cover actions when keyboard focus enters their region', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const styles = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');

        expect(html).toContain('css/styles.css?v=20260823a');
        expect(styles).toMatch(/\.cover-area:focus-within \.cover-change-btn,\s*\.cover-area:focus-within \.cover-remove-btn\s*{\s*opacity:\s*1;/s);
        expect(styles).toMatch(/\.page-header:hover \.add-cover-btn,\s*\.page-header:focus-within \.add-cover-btn\s*{\s*opacity:\s*1;/s);
    });
});

describe('Notes mobile content containment', () => {
    test('keeps wide blocks inside the editor while preserving local horizontal scrolling', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const baseStyles = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');
        const responsiveStyles = fs.readFileSync(path.join(__dirname, '..', 'css', 'notion-refinements.css'), 'utf8');

        expect(html).toContain('css/styles.css?v=20260823a');
        expect(html).toContain('css/notion-refinements.css?v=20260715-block-style-picker');
        expect(baseStyles).toMatch(/\.main-content\s*{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow-x:\s*hidden;/s);
        expect(baseStyles).toMatch(/\.chart-scroll-region\s*{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;[^}]*touch-action:\s*pan-x pan-y;/s);
        expect(responsiveStyles).toMatch(/\.database-scroll-region,\s*\.chart-scroll-region\s*{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;[^}]*touch-action:\s*pan-x pan-y;/s);
        expect(responsiveStyles).toMatch(/\.image-wrapper img,\s*\.ai-image\s*{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*height:\s*auto;/s);
    });
});
