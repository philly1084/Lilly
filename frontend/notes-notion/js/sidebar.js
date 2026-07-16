/**
 * Sidebar Module - Page tree, navigation, and workspace management
 */

const Sidebar = (function() {
    let sidebarEl = null;
    let pageTreeEl = null;
    let outlineSectionEl = null;
    let outlineToggleEl = null;
    let sidebarToggleEl = null;
    let sidebarHandleEl = null;
    let mobileToggleEl = null;
    let themeToggleEl = null;
    let pageIconPickerTrigger = null;
    let expandedPages = new Set();
    let pageIconDelegationBound = false;
    let coverDelegationBound = false;
    const legacyPageIcons = {
        note: '📝',
        page: '📄',
        document: '📄',
        doc: '📄'
    };
    const pageIconCatalog = {
        recent: ['📝', '📄', '📔', '📌', '✨', '⭐', '💡', '✅', '🎯', '🚀', '🔎', '📅', '🧠', '🧩', '🛠️', '📊', '💬', '🎨', '🌱', '☕', '💖', '🌙', '🌈', '🍓'],
        smileys: ['😀', '😄', '😁', '😊', '🙂', '😍', '🤩', '😎', '🥳', '🤔', '😌', '🤗', '😇', '🙃', '😉', '😋', '😺', '😸', '😻', '🙌', '👏', '💪', '🫶', '✌️'],
        people: ['👋', '🧑‍💻', '👩‍💻', '🧑‍🎨', '👩‍🔬', '🧑‍🏫', '👩‍🍳', '🧑‍🚀', '🧙', '🧚', '👑', '🎓', '🧘', '🏃', '💃', '🕺', '🤝', '👥', '🗣️', '🧵', '🪄', '🎤', '🎧', '📣'],
        animals: ['🐱', '🐶', '🐰', '🦊', '🐻', '🐼', '🐨', '🐸', '🐢', '🦋', '🐝', '🐞', '🐙', '🐠', '🐳', '🦉', '🦄', '🐧', '🦕', '🦖', '🐿️', '🦔', '🐾', '🌸'],
        food: ['🍓', '🍒', '🍑', '🍋', '🍊', '🍉', '🍇', '🥑', '🥐', '🥨', '🧁', '🍰', '🍩', '🍪', '🍯', '🍵', '☕', '🧋', '🍜', '🍱', '🍕', '🍣', '🥗', '🍿'],
        activities: ['🎨', '🎵', '🎬', '📷', '🎮', '🧸', '🪁', '🎲', '♟️', '🏆', '🏅', '🎪', '🎭', '🎧', '🎹', '🎸', '🛼', '🚲', '🏕️', '🗺️', '🧭', '✈️', '🧳', '🎟️'],
        travel: ['🏡', '🏙️', '🌆', '🌉', '🏔️', '⛱️', '🏝️', '🌋', '🏜️', '🌲', '🌊', '🛶', '🚗', '🚆', '🚀', '🛸', '🗽', '🗼', '⛩️', '🕌', '🏰', '🛤️', '🛣️', '🧭'],
        objects: ['📓', '📒', '📚', '📎', '✏️', '🖊️', '🖍️', '📐', '📏', '🗂️', '🗃️', '🧾', '💼', '💻', '⌨️', '🖥️', '📱', '📸', '🔬', '🔭', '🧪', '🧰', '🪴', '🕯️'],
        symbols: ['✨', '💫', '🌟', '⭐', '⚡', '🔥', '💎', '🔮', '🎀', '💌', '💖', '💚', '💙', '💜', '🧡', '🤍', '🖤', '☀️', '🌙', '☁️', '🌈', '🍀', '🔔', '🏷️']
    };
    const coverPresets = [
        { name: 'Cozy Desk', value: 'radial-gradient(circle at 14% 20%, rgba(255, 255, 255, 0.95) 0 8%, transparent 9%), radial-gradient(circle at 82% 26%, rgba(255, 237, 213, 0.92) 0 10%, transparent 11%), linear-gradient(135deg, #fef3c7 0%, #fecaca 48%, #ddd6fe 100%)' },
        { name: 'Mint Meadow', value: 'radial-gradient(circle at 22% 70%, rgba(187, 247, 208, 0.95) 0 12%, transparent 13%), radial-gradient(circle at 76% 28%, rgba(204, 251, 241, 0.9) 0 14%, transparent 15%), linear-gradient(135deg, #f0fdfa 0%, #dcfce7 50%, #dbeafe 100%)' },
        { name: 'Lavender Notes', value: 'linear-gradient(90deg, rgba(124, 58, 237, 0.08) 1px, transparent 1px), linear-gradient(0deg, rgba(124, 58, 237, 0.08) 1px, transparent 1px), linear-gradient(135deg, #faf5ff 0%, #ede9fe 48%, #fce7f3 100%)' },
        { name: 'Peach Picnic', value: 'radial-gradient(circle at 18% 18%, rgba(255, 255, 255, 0.75) 0 8%, transparent 9%), radial-gradient(circle at 72% 72%, rgba(254, 205, 211, 0.92) 0 12%, transparent 13%), linear-gradient(135deg, #ffedd5 0%, #fed7aa 46%, #fbcfe8 100%)' },
        { name: 'Blue Stationery', value: 'linear-gradient(115deg, rgba(255, 255, 255, 0.74) 0 18%, transparent 19% 100%), radial-gradient(circle at 75% 28%, rgba(191, 219, 254, 0.95) 0 15%, transparent 16%), linear-gradient(135deg, #eff6ff 0%, #bfdbfe 52%, #a7f3d0 100%)' },
        { name: 'Starry Study', value: 'radial-gradient(circle at 18% 28%, rgba(250, 204, 21, 0.95) 0 2px, transparent 3px), radial-gradient(circle at 72% 36%, rgba(255, 255, 255, 0.9) 0 2px, transparent 3px), radial-gradient(circle at 48% 72%, rgba(165, 180, 252, 0.85) 0 3px, transparent 4px), linear-gradient(135deg, #172554 0%, #312e81 52%, #701a75 100%)' },
        { name: 'Strawberry Milk', value: 'radial-gradient(circle at 24% 30%, rgba(251, 113, 133, 0.55) 0 7%, transparent 8%), radial-gradient(circle at 76% 62%, rgba(252, 165, 165, 0.72) 0 10%, transparent 11%), linear-gradient(135deg, #fff1f2 0%, #fecdd3 48%, #fbcfe8 100%)' },
        { name: 'Sunny Planner', value: 'radial-gradient(circle at 78% 24%, rgba(253, 224, 71, 0.9) 0 16%, transparent 17%), linear-gradient(135deg, #fefce8 0%, #fde68a 45%, #bae6fd 100%)' },
        { name: 'Ocean Tabs', value: 'linear-gradient(120deg, rgba(255, 255, 255, 0.4) 0 18%, transparent 18% 36%, rgba(255, 255, 255, 0.26) 36% 54%, transparent 54%), linear-gradient(135deg, #e0f2fe 0%, #7dd3fc 52%, #0f766e 100%)' },
        { name: 'Forest Margin', value: 'radial-gradient(circle at 18% 86%, rgba(22, 163, 74, 0.52) 0 14%, transparent 15%), radial-gradient(circle at 44% 86%, rgba(21, 128, 61, 0.44) 0 18%, transparent 19%), linear-gradient(135deg, #ecfdf5 0%, #bbf7d0 48%, #86efac 100%)' },
        { name: 'Candy Grid', value: 'linear-gradient(90deg, rgba(236, 72, 153, 0.12) 1px, transparent 1px), linear-gradient(0deg, rgba(14, 165, 233, 0.12) 1px, transparent 1px), linear-gradient(135deg, #fdf2f8 0%, #cffafe 100%)' },
        { name: 'Moon Journal', value: 'radial-gradient(circle at 78% 26%, #f8fafc 0 11%, transparent 12%), radial-gradient(circle at 72% 22%, #1e1b4b 0 10%, transparent 11%), linear-gradient(135deg, #0f172a 0%, #3730a3 52%, #0f766e 100%)' }
    ];
    
    /**
     * Initialize sidebar
     */
    async function init() {
        sidebarEl = document.getElementById('sidebar');
        pageTreeEl = document.getElementById('page-tree');
        outlineSectionEl = document.getElementById('sidebar-outline-section');
        outlineToggleEl = document.getElementById('sidebar-outline-toggle');
        sidebarToggleEl = document.getElementById('sidebar-toggle');
        sidebarHandleEl = document.getElementById('sidebar-handle');
        
        setupEventListeners();
        refreshPageTree();
        
        // Restore sidebar state
        const isCollapsed = localStorage.getItem('notes_notion_sidebar_collapsed') === 'true';
        setSidebarCollapsed(window.innerWidth <= 768 ? false : isCollapsed, { persist: false });

        const isOutlineCollapsed = localStorage.getItem('notes_notion_sidebar_outline_collapsed') === 'true';
        setOutlineCollapsed(isOutlineCollapsed);
        syncThemeToggleState(Storage.getTheme());
        
        // Setup mobile toggle
        setupMobileToggle();
    }
    
    /**
     * Add custom model input field (placeholder for future use)
     */
    function addCustomModelInput() {
        const container = document.querySelector('.model-selector-wrapper');
        if (!container || container.querySelector('.custom-model-input')) return;
        
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'custom-model-input';
        input.placeholder = 'e.g., lilly-for-coding';
        input.style.cssText = 'margin-top: 8px; padding: 6px; border: 1px solid var(--border); border-radius: 4px; width: 100%;';
        
        input.addEventListener('change', () => {
            const page = window.Editor?.getCurrentPage?.();
            if (page && input.value) {
                page.defaultModel = input.value;
                window.Editor?.savePage?.();
                showToast(`Model set to: ${input.value}`, 'success');
            }
        });
        
        container.appendChild(input);
    }
    
    /**
     * Setup event listeners
     */
    function setupEventListeners() {
        // New page button
        const newPageBtn = document.getElementById('new-page-btn');
        if (newPageBtn) {
            newPageBtn.addEventListener('click', () => {
                showTemplateModal();
            });
        }
        
        // Search functionality - Ctrl/Cmd + Shift + F
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key?.toLowerCase() === 'f') {
                e.preventDefault();
                showSearchModal(document.activeElement);
            }
        });
        
        // Sidebar toggle
        if (sidebarToggleEl) {
            sidebarToggleEl.addEventListener('click', toggleSidebar);
        }

        if (sidebarHandleEl) {
            sidebarHandleEl.addEventListener('click', () => setSidebarCollapsed(false));
            sidebarHandleEl.addEventListener('keydown', handleSidebarHandleKeydown);
        }

        if (outlineToggleEl) {
            outlineToggleEl.addEventListener('click', toggleOutlineSection);
        }
        
        // Theme toggle
        themeToggleEl = document.getElementById('theme-toggle');
        if (themeToggleEl) {
            themeToggleEl.addEventListener('click', toggleTheme);
        }
        
        // Settings button
        const settingsBtn = document.getElementById('settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', openSettings);
        }
        
        // Import button
        const importBtn = document.getElementById('import-btn');
        if (importBtn) {
            importBtn.addEventListener('click', (e) => showImportModal(e.currentTarget));
        }
        
        // Export button
        setupExportButton();
        
        // Trash button
        const trashBtn = document.getElementById('trash-btn');
        if (trashBtn) {
            trashBtn.addEventListener('click', showTrash);
        }
        
        // Cover buttons
        const addCoverBtn = document.getElementById('add-cover-btn');
        if (addCoverBtn) {
            addCoverBtn.addEventListener('click', showCoverPicker);
        }
        
        const changeCoverBtn = document.getElementById('cover-change-btn');
        if (changeCoverBtn) {
            changeCoverBtn.addEventListener('click', showCoverPicker);
        }
        
        const removeCoverBtn = document.getElementById('cover-remove-btn');
        if (removeCoverBtn) {
            removeCoverBtn.addEventListener('click', removeCover);
        }

        if (!coverDelegationBound) {
            document.addEventListener('click', (e) => {
                const addOrChange = e.target.closest?.('#add-cover-btn, #cover-change-btn');
                const remove = e.target.closest?.('#cover-remove-btn');
                if (!addOrChange && !remove) return;

                e.preventDefault();
                e.stopPropagation();

                if (remove) {
                    removeCover();
                } else {
                    showCoverPicker();
                }
            }, true);
            coverDelegationBound = true;
        }
        
        // Page icon button
        const pageIconBtn = document.getElementById('page-icon-btn');
        if (pageIconBtn) {
            pageIconBtn.addEventListener('click', handlePageIconButtonClick);
        }

        if (!pageIconDelegationBound) {
            document.addEventListener('click', (e) => {
                const iconButton = e.target.closest?.('#page-icon-btn');
                if (!iconButton) return;
                handlePageIconButtonClick(e, iconButton);
            }, true);
            pageIconDelegationBound = true;
        }
        
        // Page title input
        const pageTitleInput = document.getElementById('page-title');
        if (pageTitleInput) {
            pageTitleInput.addEventListener('input', debounce(() => {
                if (window.Editor) {
                    window.Editor.savePage();
                }
                // Update breadcrumbs
                const breadcrumbCurrent = document.getElementById('breadcrumb-current');
                if (breadcrumbCurrent) {
                    breadcrumbCurrent.textContent = pageTitleInput.value || 'Untitled';
                }
                // Update page title in sidebar tree
                updatePageTitleInTree(window.Editor?.getCurrentPage?.()?.id, pageTitleInput.value);
            }, 100));
        }
        
        // Page model selector
        const pageModelDropdown = document.getElementById('page-model-dropdown');
        if (pageModelDropdown) {
            pageModelDropdown.addEventListener('change', () => {
                const page = window.Editor?.getCurrentPage?.();
                if (page) {
                    page.defaultModel = pageModelDropdown.value || null;
                    window.Editor?.savePage?.();
                    showToast(`Default model updated for this page`, 'success');
                }
            });
        }

        setupEmojiPickerEvents();
    }
    
    /**
     * Setup mobile menu toggle
     */
    function setupMobileToggle() {
        // Create mobile toggle button if on mobile
        if (window.innerWidth <= 768) {
            createMobileToggleButton();
        }
        
        // Listen for resize to add/remove mobile toggle
        window.addEventListener('resize', debounce(() => {
            if (window.innerWidth <= 768) {
                setSidebarCollapsed(false, { persist: false });
                createMobileToggleButton();
            } else {
                removeMobileToggleButton();
                setSidebarCollapsed(localStorage.getItem('notes_notion_sidebar_collapsed') === 'true', { persist: false });
            }
            syncMobileSidebarState();
        }, 100));
    }
    
    /**
     * Create mobile toggle button
     */
    function createMobileToggleButton() {
        let mobileToggle = document.querySelector('.mobile-menu-toggle');
        if (mobileToggle) {
            mobileToggleEl = mobileToggle;
            syncMobileSidebarState();
            return;
        }
        
        mobileToggle = document.createElement('button');
        mobileToggle.className = 'mobile-menu-toggle';
        mobileToggle.setAttribute('aria-label', 'Toggle menu');
        mobileToggle.setAttribute('aria-controls', 'sidebar');
        mobileToggle.setAttribute('aria-expanded', 'false');
        mobileToggle.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
        `;
        mobileToggle.addEventListener('click', toggleMobileSidebar);
        document.body.appendChild(mobileToggle);
        mobileToggleEl = mobileToggle;
        syncMobileSidebarState();
    }
    
    /**
     * Remove mobile toggle button
     */
    function removeMobileToggleButton() {
        const mobileToggle = document.querySelector('.mobile-menu-toggle');
        if (mobileToggle) {
            mobileToggle.remove();
        }
        mobileToggleEl = null;
        // Also close sidebar and remove backdrop
        if (sidebarEl) {
            sidebarEl.classList.remove('open');
        }
        syncMobileSidebarState();
        const backdrop = document.querySelector('.sidebar-backdrop');
        if (backdrop) {
            backdrop.remove();
        }
    }
    
    /**
     * Toggle mobile sidebar with backdrop
     */
    function toggleMobileSidebar() {
        if (!sidebarEl) return;
        
        const isOpen = sidebarEl.classList.toggle('open');
        sidebarEl.classList.remove('collapsed');
        syncMobileSidebarState();
        
        // Create/remove backdrop
        let backdrop = document.querySelector('.sidebar-backdrop');
        if (isOpen) {
            if (!backdrop) {
                backdrop = document.createElement('div');
                backdrop.className = 'sidebar-backdrop';
                backdrop.setAttribute('role', 'button');
                backdrop.setAttribute('aria-label', 'Close sidebar');
                backdrop.addEventListener('click', () => {
                    sidebarEl.classList.remove('open');
                    syncMobileSidebarState();
                    backdrop.classList.remove('active');
                    setTimeout(() => backdrop.remove(), 300);
                });
                document.body.appendChild(backdrop);
                // Trigger animation
                requestAnimationFrame(() => {
                    backdrop.classList.add('active');
                });
            }
        } else if (backdrop) {
            backdrop.classList.remove('active');
            setTimeout(() => backdrop.remove(), 300);
        }
    }
    
    /**
     * Show template modal for new pages
     */
    function getPageTemplateBlueprints() {
        const today = new Date();
        const journalTitle = today.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });

        return {
            blank: {
                id: 'blank',
                name: 'Blank Page',
                icon: '📝',
                desc: 'Start from scratch',
                title: 'Untitled',
                pageIcon: '📝',
                properties: [],
                blocks: [
                    { type: 'text', content: '' }
                ]
            },
            brief: {
                id: 'brief',
                name: 'Executive Brief',
                icon: '📌',
                desc: 'Lead, takeaways, next steps',
                title: 'Executive Brief',
                pageIcon: '📌',
                properties: [
                    { key: 'Format', value: 'Brief' },
                    { key: 'Status', value: 'Draft' }
                ],
                blocks: [
                    { type: 'heading_1', content: 'Executive Brief' },
                    { type: 'callout', content: { text: 'Lead with the bottom line, then make the page easy to scan.', icon: '⚡' }, options: { color: 'yellow' } },
                    { type: 'heading_2', content: 'Context', options: { textColor: 'blue' } },
                    { type: 'text', content: 'Add the short setup or decision context here.' },
                    { type: 'heading_2', content: 'Key Takeaways', options: { textColor: 'blue' } },
                    { type: 'bulleted_list', content: 'Main takeaway' },
                    { type: 'bulleted_list', content: 'Supporting point' },
                    { type: 'heading_2', content: 'Next Steps', options: { textColor: 'green' } },
                    { type: 'todo', content: { text: 'Action item', checked: false } }
                ]
            },
            research: {
                id: 'research',
                name: 'Research Page',
                icon: '🔎',
                desc: 'Summary, findings, sources',
                title: 'Research Page',
                pageIcon: '🔎',
                properties: [
                    { key: 'Evidence', value: 'Source-linked' },
                    { key: 'Status', value: 'Draft' }
                ],
                blocks: [
                    { type: 'heading_1', content: 'Research Page' },
                    { type: 'callout', content: { text: 'Summarize the topic, why it matters, and what the reader should notice first.', icon: '🧭' }, options: { color: 'blue' } },
                    { type: 'heading_2', content: 'Quick Facts', options: { textColor: 'blue' } },
                    {
                        type: 'database',
                        content: {
                            columns: ['Fact', 'Detail'],
                            rows: [
                                ['Scope', 'Define the topic'],
                                ['Question', 'State the main question'],
                                ['Why it matters', 'Add the payoff']
                            ],
                            sortColumn: null,
                            sortDirection: 'asc'
                        }
                    },
                    { type: 'heading_2', content: 'Findings', options: { textColor: 'blue' } },
                    { type: 'bulleted_list', content: 'Finding or theme' },
                    { type: 'bulleted_list', content: 'Evidence or example' },
                    { type: 'heading_2', content: 'Sources', options: { textColor: 'gray' } },
                    { type: 'toggle', content: 'Add bookmarks, verification notes, and supporting source details here.', options: { color: 'gray' } }
                ]
            },
            project: {
                id: 'project',
                name: 'Project Board',
                icon: '🚀',
                desc: 'Goals, owners, next moves',
                title: 'Project Board',
                pageIcon: '🚀',
                properties: [
                    { key: 'Status', value: 'Planning' },
                    { key: 'Owner', value: 'TBD' }
                ],
                blocks: [
                    { type: 'heading_1', content: 'Project Board' },
                    { type: 'callout', content: { text: 'Keep the goal, current status, and immediate next moves visible near the top.', icon: '📍' }, options: { color: 'green' } },
                    {
                        type: 'database',
                        content: {
                            columns: ['Workstream', 'Owner', 'Status'],
                            rows: [
                                ['Planning', 'TBD', 'Active'],
                                ['Execution', 'TBD', 'Queued']
                            ],
                            sortColumn: null,
                            sortDirection: 'asc'
                        }
                    },
                    { type: 'heading_2', content: 'Goals', options: { textColor: 'green' } },
                    { type: 'bulleted_list', content: 'Primary goal' },
                    { type: 'heading_2', content: 'Next Moves', options: { textColor: 'green' } },
                    { type: 'todo', content: { text: 'Immediate action', checked: false } },
                    { type: 'todo', content: { text: 'Owner follow-up', checked: false } }
                ]
            },
            sales: {
                id: 'sales',
                name: 'Sales Pitch',
                icon: 'ðŸŽ¯',
                desc: 'Value prop, proof, CTA',
                title: 'Sales Pitch',
                pageIcon: 'ðŸŽ¯',
                properties: [
                    { key: 'Stage', value: 'Draft' },
                    { key: 'Audience', value: 'Prospect' }
                ],
                blocks: [
                    { type: 'heading_1', content: 'Sales Pitch' },
                    { type: 'callout', content: { text: 'Lead with the value proposition and keep the promised outcome obvious.', icon: 'ðŸ’¼' }, options: { color: 'orange' } },
                    { type: 'heading_2', content: 'Problem', options: { textColor: 'orange' } },
                    { type: 'text', content: 'Describe the customer pain, missed opportunity, or friction point.' },
                    { type: 'heading_2', content: 'Solution', options: { textColor: 'orange' } },
                    { type: 'bulleted_list', content: 'Core offer or differentiator' },
                    { type: 'bulleted_list', content: 'How the solution changes the outcome' },
                    { type: 'heading_2', content: 'Proof', options: { textColor: 'green' } },
                    { type: 'quote', content: 'Use a testimonial, metric, or proof point here.' },
                    { type: 'heading_2', content: 'Next Step', options: { textColor: 'green' } },
                    { type: 'todo', content: { text: 'Call to action or proposed next move', checked: false } }
                ]
            },
            notes: {
                id: 'notes',
                name: 'Meeting Notes',
                icon: '🗒️',
                desc: 'Agenda, notes, actions',
                title: 'Meeting Notes',
                pageIcon: '🗒️',
                properties: [
                    { key: 'Date', value: today.toLocaleDateString() },
                    { key: 'Owner', value: 'TBD' }
                ],
                blocks: [
                    { type: 'heading_1', content: 'Meeting Notes' },
                    { type: 'callout', content: { text: 'Capture the headline takeaway before the detailed discussion notes.', icon: '👥' }, options: { color: 'gray' } },
                    { type: 'heading_2', content: 'Agenda', options: { textColor: 'brown' } },
                    { type: 'numbered_list', content: 'Agenda item' },
                    { type: 'heading_2', content: 'Notes', options: { textColor: 'brown' } },
                    { type: 'text', content: 'Add the main discussion points here.' },
                    { type: 'heading_2', content: 'Decisions', options: { textColor: 'brown' } },
                    { type: 'bulleted_list', content: 'Decision or takeaway' },
                    { type: 'heading_2', content: 'Action Items', options: { textColor: 'green' } },
                    { type: 'todo', content: { text: 'Follow-up item', checked: false } }
                ]
            },
            doc: {
                id: 'doc',
                name: 'Documentation',
                icon: '🧩',
                desc: 'Overview, steps, examples',
                title: 'Documentation',
                pageIcon: '🧩',
                properties: [
                    { key: 'Audience', value: 'Internal' },
                    { key: 'Status', value: 'Draft' }
                ],
                blocks: [
                    { type: 'heading_1', content: 'Documentation' },
                    { type: 'callout', content: { text: 'Clarify the scope, audience, and prerequisites before the main steps.', icon: 'ℹ️' }, options: { color: 'blue' } },
                    { type: 'heading_2', content: 'Overview', options: { textColor: 'blue' } },
                    { type: 'text', content: 'Describe what this document covers and who it is for.' },
                    { type: 'heading_2', content: 'Steps', options: { textColor: 'blue' } },
                    { type: 'numbered_list', content: 'Step one' },
                    { type: 'numbered_list', content: 'Step two' },
                    { type: 'heading_2', content: 'Example', options: { textColor: 'blue' } },
                    { type: 'code', content: { language: 'javascript', text: '// Add a real example here' } },
                    { type: 'heading_2', content: 'FAQ', options: { textColor: 'gray' } },
                    { type: 'toggle', content: 'Use this section for troubleshooting or deeper detail.', options: { color: 'gray' } }
                ]
            },
            journal: {
                id: 'journal',
                name: 'Daily Journal',
                icon: '📔',
                desc: 'Highlights, reflections, tomorrow',
                title: journalTitle,
                pageIcon: '📔',
                properties: [
                    { key: 'Focus', value: 'Daily check-in' }
                ],
                blocks: [
                    { type: 'heading_1', content: journalTitle },
                    { type: 'callout', content: { text: 'Start with the mood, focus, or theme for the day.', icon: '🌤️' }, options: { color: 'purple' } },
                    { type: 'heading_2', content: 'Highlights', options: { textColor: 'purple' } },
                    { type: 'text', content: 'What stood out today?' },
                    { type: 'heading_2', content: 'Reflections', options: { textColor: 'purple' } },
                    { type: 'text', content: 'What felt important, difficult, or worth remembering?' },
                    { type: 'heading_2', content: 'Tomorrow', options: { textColor: 'green' } },
                    { type: 'todo', content: { text: 'Priority for tomorrow', checked: false } }
                ]
            }
        };
    }

    function showTemplateModal(triggerElement = document.activeElement) {
        let templates = [
            { id: 'blank', name: 'Blank Page', icon: '📄', desc: 'Start from scratch' },
            { id: 'todo', name: 'To-do List', icon: '☑️', desc: 'Track tasks' },
            { id: 'notes', name: 'Meeting Notes', icon: '📝', desc: 'Meeting agenda & notes' },
            { id: 'doc', name: 'Documentation', icon: '📚', desc: 'Product documentation' },
            { id: 'journal', name: 'Daily Journal', icon: '📔', desc: 'Daily reflections' },
            { id: 'project', name: 'Project Plan', icon: '🎯', desc: 'Project planning' }
        ];
        templates = Object.values(getPageTemplateBlueprints());
        
        const modal = document.createElement('div');
        modal.className = 'template-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'template-modal-title');
        modal.innerHTML = `
            <div class="template-modal-content">
                <div class="template-modal-header">
                    <span id="template-modal-title" class="template-modal-title">Choose a template</span>
                    <button class="template-modal-close" type="button" aria-label="Close template chooser">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>
                <div class="template-grid">
                    ${templates.map(t => `
                        <button class="template-card" type="button" data-template="${t.id}">
                            <div class="template-card-icon" aria-hidden="true">${t.icon}</div>
                            <div class="template-card-title">${t.name}</div>
                            <div class="template-card-desc">${t.desc}</div>
                        </button>
                    `).join('')}
                </div>
            </div>
        `;

        const closeTemplateModal = () => {
            modal.remove();
            if (triggerElement?.isConnected) {
                triggerElement.focus({ preventScroll: true });
            }
        };
        
        // Handle template selection
        modal.querySelectorAll('.template-card').forEach(card => {
            card.addEventListener('click', () => {
                const templateId = card.dataset.template;
                createNewPageWithTemplate(templateId);
                closeTemplateModal();
            });
        });
        
        // Close handlers
        modal.querySelector('.template-modal-close').addEventListener('click', () => {
            closeTemplateModal();
        });
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeTemplateModal();
        });

        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeTemplateModal();
                return;
            }

            if (e.key !== 'Tab') return;
            const focusable = Array.from(modal.querySelectorAll('button:not(:disabled)'));
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first?.focus();
            }
        });
        
        document.body.appendChild(modal);
        modal.querySelector('.template-card')?.focus({ preventScroll: true });
    }
    
    /**
     * Create new page with template
     */
    function createNewPageWithTemplate(templateId) {
        const blueprints = getPageTemplateBlueprints();
        const blueprint = blueprints[templateId];
        if (blueprint) {
            const page = Storage.createPage(blueprint.title || 'Untitled');
            page.title = blueprint.title || page.title;
            page.icon = blueprint.pageIcon || '';
            page.properties = Array.isArray(blueprint.properties) ? blueprint.properties : [];
            page.blocks = (blueprint.blocks || [{ type: 'text', content: '' }]).map((block) =>
                Blocks.createBlock(block.type, block.content, block.options || {})
            );
            Storage.updatePage(page.id, page);

            refreshPageTree();
            loadPage(page.id);

            showToast(`Created ${blueprint.name}`, 'success');
            return;
        }

        const templateBlocks = {
            blank: [
                { type: 'text', content: '' }
            ],
            todo: [
                { type: 'heading_1', content: 'To-do List' },
                { type: 'text', content: 'Here are the tasks to complete:' },
                { type: 'todo', content: { text: 'Task 1', checked: false } },
                { type: 'todo', content: { text: 'Task 2', checked: false } },
                { type: 'todo', content: { text: 'Task 3', checked: false } }
            ],
            notes: [
                { type: 'heading_1', content: 'Meeting Notes' },
                { type: 'text', content: 'Date: ' + new Date().toLocaleDateString() },
                { type: 'divider', content: '' },
                { type: 'heading_2', content: 'Attendees' },
                { type: 'bulleted_list', content: 'Person 1' },
                { type: 'heading_2', content: 'Agenda' },
                { type: 'numbered_list', content: 'Item 1' },
                { type: 'heading_2', content: 'Notes' },
                { type: 'text', content: '' },
                { type: 'heading_2', content: 'Action Items' },
                { type: 'todo', content: { text: 'Action item', checked: false } }
            ],
            doc: [
                { type: 'heading_1', content: 'Documentation' },
                { type: 'text', content: 'Overview' },
                { type: 'heading_2', content: 'Getting Started' },
                { type: 'text', content: '' },
                { type: 'heading_2', content: 'Features' },
                { type: 'bulleted_list', content: 'Feature 1' },
                { type: 'heading_2', content: 'API Reference' },
                { type: 'code', content: { language: 'javascript', text: '// Example code' } }
            ],
            journal: [
                { type: 'heading_1', content: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) },
                { type: 'text', content: 'Today I...' },
                { type: 'heading_2', content: '🌟 Highlights' },
                { type: 'text', content: '' },
                { type: 'heading_2', content: '🤔 Reflections' },
                { type: 'text', content: '' },
                { type: 'heading_2', content: '🎯 Goals for Tomorrow' },
                { type: 'todo', content: { text: '', checked: false } }
            ],
            project: [
                { type: 'heading_1', content: 'Project Plan' },
                { type: 'callout', content: 'Project overview and key details', icon: '💡' },
                { type: 'heading_2', content: 'Goals' },
                { type: 'todo', content: { text: 'Define project goals', checked: false } },
                { type: 'heading_2', content: 'Timeline' },
                { type: 'text', content: '' },
                { type: 'heading_2', content: 'Resources' },
                { type: 'bulleted_list', content: 'Resource 1' },
                { type: 'heading_2', content: 'Notes' },
                { type: 'text', content: '' }
            ]
        };
        
        const blocks = templateBlocks[templateId] || templateBlocks.blank;
        
        const page = Storage.createPage();
        page.blocks = blocks.map(b => Blocks.createBlock(b.type, b.content));
        Storage.updatePage(page.id, page);
        
        refreshPageTree();
        loadPage(page.id);
        
        showToast(`Created from template`, 'success');
    }
    
    /**
     * Refresh the page tree
     */
    function refreshPageTree() {
        if (!pageTreeEl) return;
        
        const pages = Storage.getPages();
        pageTreeEl.innerHTML = '';
        
        // Build tree structure
        const pageMap = new Map();
        const rootPages = [];
        
        pages.forEach(page => {
            pageMap.set(page.id, { ...page, children: [] });
        });
        
        pages.forEach(page => {
            const node = pageMap.get(page.id);
            if (page.parentId && pageMap.has(page.parentId)) {
                pageMap.get(page.parentId).children.push(node);
            } else {
                rootPages.push(node);
            }
        });
        
        // Render tree
        rootPages.forEach(page => {
            renderPageNode(page, pageTreeEl, 0);
        });
        
        // Highlight current page
        const currentId = Storage.getCurrentPageId();
        if (currentId) {
            const currentEl = pageTreeEl.querySelector(`[data-page-id="${currentId}"]`);
            if (currentEl) {
                currentEl.classList.add('active');
            }
        }
    }
    
    /**
     * Render a page node
     */
    function renderPageNode(page, container, depth) {
        const pageEl = document.createElement('div');
        pageEl.className = 'page-tree-item';
        pageEl.dataset.pageId = page.id;
        pageEl.style.paddingLeft = `${14 + depth * 12}px`;
        
        // Expand button
        const hasChildren = page.children && page.children.length > 0;
        const isExpanded = expandedPages.has(page.id);
        
        const expandBtn = document.createElement('span');
        expandBtn.className = `expand-btn ${hasChildren ? '' : 'hidden'} ${isExpanded ? 'expanded' : ''}`;
        expandBtn.innerHTML = '▶';
        
        if (hasChildren) {
            expandBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                togglePageExpand(page.id);
            });
        }
        
        pageEl.appendChild(expandBtn);
        
        // Icon
        const icon = document.createElement('span');
        icon.className = 'page-icon';
        icon.textContent = normalizePageIcon(page.icon) || '📄';
        pageEl.appendChild(icon);
        
        // Title
        const title = document.createElement('span');
        title.className = 'page-title-text';
        title.textContent = page.title || 'Untitled';
        pageEl.appendChild(title);
        
        // Click to load page
        pageEl.addEventListener('click', () => loadPage(page.id));
        
        // Right-click menu
        pageEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showPageContextMenu(page.id, e);
        });
        
        container.appendChild(pageEl);
        
        // Render children if expanded
        if (hasChildren && isExpanded) {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'page-tree-children';
            page.children.forEach(child => {
                renderPageNode(child, childrenContainer, depth + 1);
            });
            container.appendChild(childrenContainer);
        }
    }
    
    /**
     * Toggle page expand/collapse
     */
    function togglePageExpand(pageId) {
        if (expandedPages.has(pageId)) {
            expandedPages.delete(pageId);
        } else {
            expandedPages.add(pageId);
        }
        refreshPageTree();
    }
    
    /**
     * Load a page
     */
    function loadPage(pageId) {
        const currentPageId = window.Editor?.getCurrentPage?.()?.id || null;
        if (currentPageId && currentPageId !== pageId) {
            window.Editor?.savePage?.();
        }

        const page = Storage.getPage(pageId);
        if (!page) return;
        
        Storage.setCurrentPageId(pageId);

        // Load into editor first so any internal page-switch save logic still
        // sees the previous page header values, not the next page's values.
        if (window.Editor) {
            window.Editor.loadPage(page);
        }

        if (window.Agent?.syncConversationWithCurrentPage) {
            window.Agent.syncConversationWithCurrentPage({ pageId: page.id });
        } else {
            if (window.notesAPIClient?.setSessionId) {
                window.notesAPIClient.setSessionId(page.id);
            }
            if (window.API?.setSessionId) {
                window.API.setSessionId(page.id);
            }
        }

        // Update UI
        updatePageHeader(page);
        
        // Update active state in sidebar
        document.querySelectorAll('.page-tree-item').forEach(el => {
            el.classList.remove('active');
        });
        const activeEl = document.querySelector(`.page-tree-item[data-page-id="${pageId}"]`);
        if (activeEl) {
            activeEl.classList.add('active');
        }
        
        // On mobile, close sidebar
        if (window.innerWidth < 768) {
            sidebarEl.classList.remove('open');
            syncMobileSidebarState();
            const backdrop = document.querySelector('.sidebar-backdrop');
            if (backdrop) backdrop.remove();
        }
    }
    
    /**
     * Create a new page (blank)
     */
    function createNewPage() {
        showTemplateModal();
    }
    
    /**
     * Update page header UI
     */
    function updatePageHeader(page) {
        // Title
        const titleInput = document.getElementById('page-title');
        if (titleInput) {
            titleInput.value = page.title || '';
        }
        
        // Breadcrumbs
        const breadcrumbCurrent = document.getElementById('breadcrumb-current');
        if (breadcrumbCurrent) {
            breadcrumbCurrent.textContent = page.title || 'Untitled';
        }
        
        // Icon
        const iconEl = document.getElementById('page-icon');
        const addIconHint = document.querySelector('.add-icon-hint');
        const normalizedIcon = normalizePageIcon(page.icon);
        if (page.icon !== normalizedIcon) {
            page.icon = normalizedIcon;
        }
        if (iconEl) {
            iconEl.textContent = normalizedIcon;
            if (normalizedIcon) {
                iconEl.style.display = 'inline';
                if (addIconHint) addIconHint.style.display = 'none';
            } else {
                iconEl.style.display = 'none';
                if (addIconHint) addIconHint.style.display = 'inline';
            }
        }
        
        // Cover
        const coverArea = document.getElementById('cover-area');
        const coverImage = document.getElementById('cover-image');
        const addCoverBtn = document.getElementById('add-cover-btn');
        
        if (page.cover) {
            coverArea.style.display = 'block';
            applyCoverBackground(coverImage, page.cover);
            if (addCoverBtn) addCoverBtn.style.display = 'none';
        } else {
            coverArea.style.display = 'none';
            coverImage.style.backgroundImage = '';
            if (addCoverBtn) addCoverBtn.style.display = 'flex';
        }
        
        // Properties
        const propertiesArea = document.getElementById('properties-area');
        if (propertiesArea) {
            propertiesArea.innerHTML = '';
            page.properties?.forEach(prop => {
                addPropertyRow(prop.key, prop.value);
            });
        }
        
        // Model selector
        const pageModelDropdown = document.getElementById('page-model-dropdown');
        if (pageModelDropdown) {
            pageModelDropdown.value = page.defaultModel || '';
        }
        
        // Update document title
        document.title = page.title ? `${page.title} - Notes` : 'Notes - Lilly Style';
    }
    
    /**
     * Update page title in the sidebar tree
     */
    function updatePageTitleInTree(pageId, title) {
        if (!pageId) return;
        const pageEl = document.querySelector(`.page-tree-item[data-page-id="${pageId}"]`);
        if (pageEl) {
            const titleEl = pageEl.querySelector('.page-title-text');
            if (titleEl) {
                titleEl.textContent = title || 'Untitled';
            }
        }
    }
    
    /**
     * Add a property row
     */
    function addPropertyRow(key = '', value = '') {
        const propertiesArea = document.getElementById('properties-area');
        if (!propertiesArea) return;
        
        const row = document.createElement('div');
        row.className = 'property-row';
        
        const keyInput = document.createElement('input');
        keyInput.className = 'property-key';
        keyInput.placeholder = 'Property';
        keyInput.value = key;
        
        const valueInput = document.createElement('input');
        valueInput.className = 'property-value';
        valueInput.placeholder = 'Value';
        valueInput.value = value;
        
        row.appendChild(keyInput);
        row.appendChild(valueInput);
        
        propertiesArea.appendChild(row);
    }
    
    /**
     * Toggle sidebar collapse
     */
    function toggleSidebar() {
        if (!sidebarEl) return;

        if (window.innerWidth <= 768) {
            toggleMobileSidebar();
            return;
        }

        setSidebarCollapsed(!sidebarEl.classList.contains('collapsed'));
    }

    function setSidebarCollapsed(collapsed, options = {}) {
        if (!sidebarEl) return;

        const shouldPersist = options.persist !== false;
        if (window.innerWidth <= 768) {
            sidebarEl.classList.remove('collapsed');
            if (shouldPersist) {
                localStorage.setItem('notes_notion_sidebar_collapsed', 'false');
            }
            syncSidebarToggleState(false);
            syncMobileSidebarState();
            return;
        }

        sidebarEl.classList.toggle('collapsed', Boolean(collapsed));
        if (shouldPersist) {
            localStorage.setItem('notes_notion_sidebar_collapsed', collapsed ? 'true' : 'false');
        }

        if (sidebarHandleEl) {
            sidebarHandleEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        }
        syncSidebarToggleState(collapsed);
    }

    function syncSidebarToggleState(collapsed) {
        if (!sidebarToggleEl) return;

        const isCollapsed = Boolean(collapsed);
        sidebarToggleEl.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
        sidebarToggleEl.setAttribute('aria-label', isCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
        sidebarToggleEl.setAttribute('title', isCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
    }

    function syncMobileSidebarState() {
        if (!sidebarEl) return;

        const isMobile = window.innerWidth <= 768;
        const isOpen = isMobile && sidebarEl.classList.contains('open');
        const toggle = mobileToggleEl || document.querySelector('.mobile-menu-toggle');
        if (toggle) {
            toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            toggle.classList.toggle('is-open', isOpen);
        }
        document.body.classList.toggle('notes-sidebar-open', isOpen);
    }

    function handleSidebarHandleKeydown(e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;

        e.preventDefault();
        setSidebarCollapsed(false);
    }

    function setOutlineCollapsed(collapsed) {
        if (!outlineSectionEl || !outlineToggleEl) return;

        outlineSectionEl.classList.toggle('collapsed', Boolean(collapsed));
        outlineToggleEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }

    function toggleOutlineSection() {
        if (!outlineSectionEl) return;

        const collapsed = !outlineSectionEl.classList.contains('collapsed');
        setOutlineCollapsed(collapsed);
        localStorage.setItem('notes_notion_sidebar_outline_collapsed', collapsed ? 'true' : 'false');
    }
    
    /**
     * Toggle theme
     */
    function toggleTheme() {
        const currentTheme = Storage.getTheme();
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        Storage.setTheme(newTheme);

        syncThemeToggleState(newTheme);
    }

    function syncThemeToggleState(theme) {
        const isDark = theme === 'dark';
        const actionLabel = isDark ? 'Switch to light mode' : 'Switch to dark mode';
        const themeText = themeToggleEl?.querySelector?.('.theme-text') || document.querySelector('.theme-text');

        if (themeText) {
            themeText.textContent = isDark ? 'Light mode' : 'Dark mode';
        }

        if (themeToggleEl) {
            themeToggleEl.setAttribute('aria-pressed', isDark ? 'true' : 'false');
            themeToggleEl.setAttribute('aria-label', actionLabel);
            themeToggleEl.setAttribute('title', actionLabel);
        }
    }

    function handlePageIconButtonClick(e, buttonOverride = null) {
        const button = buttonOverride || e.currentTarget;
        if (!button) return;

        e.preventDefault();
        e.stopPropagation();
        showEmojiPicker(button);
    }
    
    /**
     * Show emoji picker
     */
    function showEmojiPicker(target) {
        const picker = document.getElementById('emoji-picker');
        if (!picker) return;
        
        const rect = target.getBoundingClientRect();
        const pickerWidth = Math.min(320, window.innerWidth - 16);
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - pickerWidth - 8));
        const top = Math.min(rect.bottom + 8, window.innerHeight - 260);
        picker.style.left = `${left}px`;
        picker.style.top = `${Math.max(8, top)}px`;
        picker.style.display = 'block';
        picker.classList.add('is-open');
        picker.setAttribute('aria-hidden', 'false');
        pageIconPickerTrigger = target;
        target.setAttribute('aria-expanded', 'true');
        
        // Render emojis
        renderEmojiGrid('recent');
        document.getElementById('emoji-search')?.focus();
        
        // Close on outside click
        const closePicker = (e) => {
            if (!picker.contains(e.target) && !target.contains(e.target)) {
                hideEmojiPicker();
                document.removeEventListener('click', closePicker);
            }
        };
        
        setTimeout(() => {
            document.addEventListener('click', closePicker);
        }, 0);
    }

    function hideEmojiPicker(restoreFocus = false) {
        const picker = document.getElementById('emoji-picker');
        if (!picker) return;

        picker.classList.remove('is-open');
        picker.style.display = 'none';
        picker.setAttribute('aria-hidden', 'true');
        pageIconPickerTrigger?.setAttribute('aria-expanded', 'false');
        if (restoreFocus) pageIconPickerTrigger?.focus();
        pageIconPickerTrigger = null;
    }

    function setupEmojiPickerEvents() {
        const picker = document.getElementById('emoji-picker');
        if (!picker || picker.dataset.sidebarEventsBound === 'true') return;

        picker.dataset.sidebarEventsBound = 'true';

        const categories = Array.from(picker.querySelectorAll('.emoji-category'));
        const focusCategory = (categoryIndex) => {
            categories.forEach((item, index) => {
                item.setAttribute('tabindex', index === categoryIndex ? '0' : '-1');
            });
            categories[categoryIndex]?.focus();
        };
        categories.forEach((category, categoryIndex) => {
            const selectCategory = () => {
                categories.forEach(item => {
                    item.classList.remove('active');
                    item.setAttribute('aria-pressed', 'false');
                });
                category.classList.add('active');
                category.setAttribute('aria-pressed', 'true');
                renderEmojiGrid(category.dataset.category || 'recent');
            };
            category.addEventListener('click', selectCategory);
            category.addEventListener('keydown', (e) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                e.preventDefault();
                const nextIndex = e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                        ? categories.length - 1
                        : (categoryIndex + (e.key === 'ArrowRight' ? 1 : -1) + categories.length) % categories.length;
                focusCategory(nextIndex);
            });
        });

        const searchInput = document.getElementById('emoji-search');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                renderEmojiSearch(searchInput.value);
            });
        }

        picker.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            hideEmojiPicker(true);
        });
    }

    function appendEmojiChoice(grid, emoji) {
        const span = document.createElement('span');
        span.textContent = emoji;
        span.setAttribute('role', 'button');
        span.setAttribute('tabindex', '0');
        span.setAttribute('aria-label', `Use ${emoji} as page icon`);
        span.addEventListener('click', () => {
            selectEmoji(emoji);
            hideEmojiPicker(true);
        });
        span.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            span.click();
        });
        grid.appendChild(span);
    }
    
    /**
     * Render emoji grid
     */
    function renderEmojiGrid(category) {
        const grid = document.getElementById('emoji-grid');
        if (!grid) return;
        
        const emojis = pageIconCatalog[category] || Blocks.getEmojis(category);
        grid.innerHTML = '';
        
        emojis.forEach(emoji => {
            appendEmojiChoice(grid, emoji);
        });
    }

    function renderEmojiSearch(query) {
        const grid = document.getElementById('emoji-grid');
        if (!grid) return;

        const normalizedQuery = String(query || '').trim().toLowerCase();
        if (!normalizedQuery) {
            renderEmojiGrid('recent');
            return;
        }

        const emojiNames = {
            note: '📝',
            document: '📄',
            page: '📄',
            book: '📔',
            pin: '📌',
            search: '🔎',
            rocket: '🚀',
            target: '🎯',
            calendar: '📅',
            light: '💡',
            check: '✅',
            star: '⭐',
            heart: '❤️',
            fire: '🔥',
            cute: '✨',
            idea: '💡',
            work: '💼',
            code: '🧑‍💻',
            art: '🎨',
            coffee: '☕',
            garden: '🌱',
            moon: '🌙',
            ocean: '🌊',
            music: '🎵',
            camera: '📷'
        };
        const matches = Object.entries(emojiNames)
            .filter(([name]) => name.includes(normalizedQuery))
            .map(([, emoji]) => emoji);

        const all = [
            ...Object.values(pageIconCatalog).flat(),
            ...Blocks.getEmojiCategories().flatMap(category => Blocks.getEmojis(category))
        ];
        const results = [...new Set([...matches, ...all])].slice(0, 64);

        grid.innerHTML = '';
        results.forEach(emoji => {
            appendEmojiChoice(grid, emoji);
        });
    }
    
    /**
     * Select emoji for page
     */
    function selectEmoji(emoji) {
        const page = window.Editor?.getCurrentPage?.();
        if (!page) return;
        
        page.icon = normalizePageIcon(emoji);
        
        const iconEl = document.getElementById('page-icon');
        const addIconHint = document.querySelector('.add-icon-hint');
        if (iconEl) {
            iconEl.textContent = page.icon;
            iconEl.style.display = 'inline';
            if (addIconHint) addIconHint.style.display = 'none';
        }
        
        window.Editor?.savePage?.();
        refreshPageTree();
    }

    function normalizePageIcon(icon) {
        const value = String(icon || '').trim();
        if (!value) return '';

        return legacyPageIcons[value.toLowerCase()] || value;
    }
    
    /**
     * Show cover picker
     */
    function showCoverPicker() {
        const page = window.Editor?.getCurrentPage?.();
        if (!page) return;

        const activeCover = String(page.cover || '').trim();

        document.getElementById('cover-picker-modal')?.remove();

        const modal = document.createElement('div');
        modal.id = 'cover-picker-modal';
        modal.className = 'cover-picker-modal is-open';
        modal.innerHTML = `
            <div class="cover-picker-backdrop" data-cover-action="close"></div>
            <section class="cover-picker-panel" role="dialog" aria-modal="true" aria-labelledby="cover-picker-title">
                <header class="cover-picker-header">
                    <div>
                        <h2 id="cover-picker-title">Pick a top image</h2>
                        <p>Choose a cute preset or paste an image URL.</p>
                    </div>
                    <button class="cover-picker-close" type="button" data-cover-action="close" aria-label="Close cover picker">&times;</button>
                </header>
                <div class="cover-preset-grid">
                    ${coverPresets.map((cover, index) => {
                        const isCurrent = String(cover.value || '').trim() === activeCover;
                        return `
                        <button class="cover-preset${isCurrent ? ' is-current' : ''}" type="button" data-cover-index="${index}" aria-pressed="${isCurrent}">
                            <span class="cover-preset-preview" style="background-image: ${escapeHtmlAttribute(formatCoverBackground(cover.value))};">${isCurrent ? '<span class="cover-preset-state">Current</span>' : ''}</span>
                            <span class="cover-preset-name">${escapeHtml(cover.name)}</span>
                        </button>
                    `;
                    }).join('')}
                </div>
                <form class="cover-url-form">
                    <label for="cover-url-input">Image URL</label>
                    <div class="cover-url-row">
                        <input id="cover-url-input" type="url" placeholder="https://example.com/cute-cover.jpg" autocomplete="off">
                        <button type="submit">Use URL</button>
                    </div>
                </form>
                <footer class="cover-picker-footer">
                    <button type="button" data-cover-action="random">Random cute cover</button>
                    <button type="button" data-cover-action="clear">Remove cover</button>
                </footer>
            </section>
        `;

        modal.querySelectorAll('[data-cover-index]').forEach(button => {
            button.addEventListener('click', () => {
                const cover = coverPresets[Number(button.dataset.coverIndex)];
                if (cover) {
                    setPageCover(cover.value);
                    modal.remove();
                }
            });
        });

        modal.querySelector('.cover-url-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = modal.querySelector('#cover-url-input');
            const value = String(input?.value || '').trim();
            if (!value) return;
            setPageCover(value);
            modal.remove();
        });

        modal.addEventListener('click', (e) => {
            const action = e.target.dataset.coverAction;
            if (!action) return;
            if (action === 'close') {
                modal.remove();
            } else if (action === 'random') {
                const cover = coverPresets[Math.floor(Math.random() * coverPresets.length)];
                setPageCover(cover.value);
                modal.remove();
            } else if (action === 'clear') {
                setPageCover(null);
                modal.remove();
            }
        });

        document.body.appendChild(modal);
    }

    function setPageCover(cover) {
        const page = window.Editor?.getCurrentPage?.();
        if (!page) return;

        page.cover = cover;
        updatePageHeader(page);
        window.Editor?.savePage?.();
    }

    function applyCoverBackground(element, cover) {
        if (!element) return;

        element.style.backgroundImage = formatCoverBackground(cover);
    }

    function formatCoverBackground(cover) {
        const value = String(cover || '').trim();
        if (!value) return '';
        if (/^(linear|radial|conic|repeating-linear|repeating-radial)-gradient\(/i.test(value)) {
            return value;
        }
        if (/^url\(/i.test(value)) {
            return value;
        }
        return `url("${value.replace(/"/g, '\\"')}")`;
    }

    function escapeHtmlAttribute(value) {
        return escapeHtml(value).replace(/"/g, '&quot;');
    }
    
    /**
     * Remove cover
     */
    function removeCover() {
        const page = window.Editor?.getCurrentPage?.();
        if (!page) return;
        
        page.cover = null;
        updatePageHeader(page);
        window.Editor?.savePage?.();
    }
    
    /**
     * Show page context menu
     */
    function showPageContextMenu(pageId, e) {
        const menu = document.createElement('div');
        menu.className = 'block-context-menu';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.innerHTML = `
            <div class="context-menu-item" data-action="duplicate">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                Duplicate
            </div>
            <div class="context-menu-item" data-action="delete" style="color: #ef4444;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                Delete
            </div>
        `;
        
        document.body.appendChild(menu);
        
        menu.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', () => {
                const action = item.dataset.action;
                if (action === 'delete') {
                    Storage.deletePage(pageId);
                    refreshPageTree();
                    
                    const pages = Storage.getPages();
                    if (pages.length > 0) {
                        loadPage(pages[0].id);
                    } else {
                        createNewPage();
                    }
                } else if (action === 'duplicate') {
                    const page = Storage.getPage(pageId);
                    if (page) {
                        const newPage = Storage.createPage(page.title + ' (Copy)');
                        newPage.blocks = Storage.cloneBlocksWithFreshIds(page.blocks);
                        newPage.icon = page.icon;
                        newPage.cover = page.cover || null;
                        newPage.properties = Array.isArray(page.properties)
                            ? JSON.parse(JSON.stringify(page.properties))
                            : [];
                        newPage.defaultModel = page.defaultModel || null;
                        newPage.parentId = page.parentId || null;
                        Storage.updatePage(newPage.id, newPage);
                        refreshPageTree();
                        loadPage(newPage.id);
                    }
                }
                menu.remove();
            });
        });
        
        setTimeout(() => {
            document.addEventListener('click', function closeMenu(ev) {
                if (!menu.contains(ev.target)) {
                    menu.remove();
                    document.removeEventListener('click', closeMenu);
                }
            });
        }, 0);
    }
    
    /**
     * Show trash
     */
    function showTrash() {
        const trash = Storage.getTrash();
        if (trash.length === 0) {
            showToast('Trash is empty', 'info');
            return;
        }
        
        const modal = document.createElement('div');
        modal.className = 'ai-modal';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="ai-modal-content" style="max-width: 400px;">
                <div class="ai-modal-header">
                    <span>🗑️</span>
                    <span>Trash</span>
                </div>
                <div style="padding: 20px;">
                    ${trash.map(p => `
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border-color);">
                            <span>${p.icon || '📄'} ${p.title || 'Untitled'}</span>
                            <button class="restore-btn" data-id="${p.id}" style="background: var(--bg-secondary); border: 1px solid var(--border-color); padding: 4px 12px; border-radius: var(--radius-sm); cursor: pointer;">Restore</button>
                        </div>
                    `).join('')}
                </div>
                <div style="padding: 0 20px 20px; display: flex; gap: 10px; justify-content: flex-end;">
                    <button class="ai-btn empty-trash">Empty Trash</button>
                    <button class="ai-btn primary close-modal">Close</button>
                </div>
            </div>
        `;
        
        modal.querySelector('.close-modal').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
        
        modal.querySelectorAll('.restore-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                Storage.restorePage(btn.dataset.id);
                refreshPageTree();
                modal.remove();
                showToast('Page restored', 'success');
            });
        });
        
        modal.querySelector('.empty-trash').addEventListener('click', () => {
            if (confirm('Empty trash permanently? This cannot be undone.')) {
                trash.forEach(p => Storage.permanentDeletePage(p.id));
                modal.remove();
                showToast('Trash emptied', 'success');
            }
        });
        
        document.body.appendChild(modal);
    }
    
    /**
     * Open settings
     */
    function openSettings(event) {
        const triggerElement = event?.currentTarget || document.activeElement;
        const modal = document.createElement('div');
        modal.className = 'ai-modal';
        modal.style.display = 'flex';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'settings-modal-title');
        modal.innerHTML = `
            <div class="ai-modal-content" style="max-width: 450px; max-height: 80vh; overflow-y: auto;">
                <div class="ai-modal-header">
                    <span aria-hidden="true">⚙️</span>
                    <span id="settings-modal-title">Settings</span>
                    <button class="settings-close" type="button" aria-label="Close settings" style="margin-left: auto; background: transparent; border: none; color: white; cursor: pointer; font-size: 18px;">✕</button>
                </div>
                <div style="padding: 20px; display: flex; flex-direction: column; gap: 4px;">
                    
                    <!-- Export Section -->
                    <div class="settings-section">
                        <div class="settings-section-title">📤 Export Current Page</div>
                        <div class="settings-btn-group">
                            <button class="settings-btn" type="button" data-action="export-docx">
                                <span>📄</span>
                                <div>
                                    <div>Word Document (.docx)</div>
                                    <div class="settings-btn-subtitle">Microsoft Word format with formatting</div>
                                </div>
                            </button>
                            <button class="settings-btn" type="button" data-action="export-pdf">
                                <span>📑</span>
                                <div>
                                    <div>PDF Document (.pdf)</div>
                                    <div class="settings-btn-subtitle">Print-ready PDF with page breaks</div>
                                </div>
                            </button>
                            <button class="settings-btn" type="button" data-action="export-html">
                                <span>🌐</span>
                                <div>
                                    <div>HTML Document (.html)</div>
                                    <div class="settings-btn-subtitle">Web-ready HTML with styling</div>
                                </div>
                            </button>
                            <button class="settings-btn" type="button" data-action="export-md">
                                <span>📝</span>
                                <div>
                                    <div>Markdown (.md)</div>
                                    <div class="settings-btn-subtitle">Plain text with formatting</div>
                                </div>
                            </button>
                            <button class="settings-btn" type="button" data-action="export-json">
                                <span>📋</span>
                                <div>
                                    <div>Lilly JSON (.json)</div>
                                    <div class="settings-btn-subtitle">LillyBuilt-compatible format</div>
                                </div>
                            </button>
                            <button class="settings-btn" type="button" data-action="export-txt">
                                <span>📃</span>
                                <div>
                                    <div>Plain Text (.txt)</div>
                                    <div class="settings-btn-subtitle">Simple text without formatting</div>
                                </div>
                            </button>
                        </div>
                    </div>
                    
                    <!-- Export All Section -->
                    <div class="settings-section">
                        <div class="settings-section-title">📦 Export All Pages</div>
                        <div class="settings-btn-group">
                            <button class="settings-btn" type="button" data-action="export-all-md">
                                <span>📚</span>
                                <div>
                                    <div>Export All as Markdown</div>
                                    <div class="settings-btn-subtitle">Single file with all pages</div>
                                </div>
                            </button>
                            <button class="settings-btn" type="button" data-action="backup">
                                <span>💾</span>
                                <div>
                                    <div>Full Backup (.json)</div>
                                    <div class="settings-btn-subtitle">Complete data backup with metadata</div>
                                </div>
                            </button>
                        </div>
                    </div>
                    
                    <!-- Import Section -->
                    <div class="settings-section">
                        <div class="settings-section-title">📥 Import</div>
                        <div class="settings-btn-group">
                            <button class="settings-btn" type="button" data-action="import-file">
                                <span>📂</span>
                                <div>
                                    <div>Import from File</div>
                                    <div class="settings-btn-subtitle">DOCX, PDF, HTML, MD, JSON, TXT</div>
                                </div>
                            </button>
                            <button class="settings-btn" type="button" data-action="import-md">
                                <span>📝</span>
                                <div>
                                    <div>Paste Markdown</div>
                                    <div class="settings-btn-subtitle">Copy & paste Markdown text</div>
                                </div>
                            </button>
                        </div>
                    </div>
                    
                    <!-- Data Management Section -->
                    <div class="settings-section">
                        <div class="settings-section-title">💿 Data Management</div>
                        <div class="settings-btn-group">
                            <button class="settings-btn" type="button" data-action="storage-info">
                                <span>💿</span>
                                <div>
                                    <div>Storage Information</div>
                                    <div class="settings-btn-subtitle">Check storage usage and status</div>
                                </div>
                            </button>
                            <button class="settings-btn danger" type="button" data-action="clear-all" style="color: #ef4444;">
                                <span>🗑️</span>
                                <div>
                                    <div>Clear All Data</div>
                                    <div class="settings-btn-subtitle">⚠️ This cannot be undone!</div>
                                </div>
                            </button>
                        </div>
                    </div>
                    
                </div>
            </div>
        `;
        
        // Style the buttons
        modal.querySelectorAll('.settings-btn').forEach(btn => {
            btn.style.cssText = `
                display: flex;
                align-items: flex-start;
                gap: 12px;
                padding: 12px 16px;
                background: var(--bg-secondary);
                border: 1px solid var(--border-color);
                border-radius: var(--radius-md);
                font-size: 14px;
                color: var(--text-primary);
                cursor: pointer;
                transition: all 0.15s;
                text-align: left;
                width: 100%;
            `;
            btn.addEventListener('mouseenter', () => {
                btn.style.background = 'var(--bg-hover)';
                btn.style.borderColor = 'var(--border-hover)';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.background = 'var(--bg-secondary)';
                btn.style.borderColor = 'var(--border-color)';
            });
        });
        
        const closeButton = modal.querySelector('.settings-close');
        const closeSettings = ({ restoreFocus = true } = {}) => {
            modal.remove();
            if (restoreFocus && triggerElement?.isConnected) {
                triggerElement.focus({ preventScroll: true });
            }
        };

        closeButton.addEventListener('click', () => closeSettings());
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeSettings();
        });
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeSettings();
                return;
            }

            if (e.key !== 'Tab') return;
            const focusable = Array.from(modal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        });
        
        modal.querySelectorAll('.settings-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                handleSettingsAction(action);
                const opensFollowup = ['export-all-md', 'import-file', 'import-md', 'storage-info'].includes(action);
                closeSettings({ restoreFocus: !opensFollowup });
            });
        });
        
        document.body.appendChild(modal);
        closeButton.focus({ preventScroll: true });
    }
    
    /**
     * Handle settings actions
     */
    function handleSettingsAction(action) {
        switch (action) {
            // Export current page - various formats
            case 'export-docx':
                exportCurrentPage('docx');
                break;
            case 'export-pdf':
                exportCurrentPage('pdf');
                break;
            case 'export-html':
                exportCurrentPage('html');
                break;
            case 'export-md':
                exportCurrentPage('md');
                break;
            case 'export-json':
                exportCurrentPage('json');
                break;
            case 'export-txt':
                exportCurrentPage('txt');
                break;
                
            // Export all pages
            case 'export-all-md':
                showExportAllModal();
                break;
                
            // Import
            case 'import-file':
                showImportModal(document.getElementById('import-btn'));
                break;
            case 'import-md':
                importFromMarkdown();
                break;
                
            // Backup
            case 'backup':
                Storage.exportToFile();
                showToast('Backup downloaded', 'success');
                break;
                
            // Data management
            case 'storage-info':
                showStorageInfo(document.getElementById('settings-btn'));
                break;
                
            case 'clear-all':
                if (confirm('Clear ALL data? This cannot be undone!')) {
                    Storage.clearAll();
                    location.reload();
                }
                break;
        }
    }
    
    /**
     * Persist a generated PDF as an artifact when backend storage is available.
     * Falls back to a blob URL for the current session if persistence is unavailable.
     */
    async function createPdfExportLink(blob, filename, page) {
        if (!(blob instanceof Blob)) {
            return null;
        }

        try {
            const formData = new FormData();
            formData.append('sessionId', page?.id || `notes-${Date.now()}`);
            formData.append('mode', 'notes');
            formData.append('label', `PDF export: ${page?.title || 'Untitled'}`);
            formData.append('file', new File([blob], filename, { type: 'application/pdf' }));

            const response = await fetch('/api/artifacts/upload', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`Artifact upload failed with status ${response.status}`);
            }

            const artifact = await response.json();
            if (artifact?.downloadUrl) {
                return new URL(artifact.downloadUrl, window.location.origin).toString();
            }
        } catch (error) {
            console.warn('Failed to persist PDF export artifact:', error);
        }

        return URL.createObjectURL(blob);
    }

    function isDurableExportUrl(value) {
        const url = String(value || '').trim();
        if (!url || url.startsWith('blob:')) {
            return false;
        }

        if (/^\/api\/artifacts\//.test(url)) {
            return true;
        }

        try {
            const parsed = new URL(url, window.location.origin);
            return parsed.protocol === 'https:' || parsed.protocol === 'http:';
        } catch (_error) {
            return false;
        }
    }

    function updatePdfExportBlock(downloadUrl, filename) {
        const page = window.Editor?.getCurrentPage?.();
        if (!page || !window.Blocks?.createBlock) {
            return;
        }

        const existingBlock = (page.blocks || []).find((block) => block?.exportMarker === 'notes-pdf-export-link');
        if (!isDurableExportUrl(downloadUrl)) {
            if (existingBlock?.content?.url && existingBlock.content.url.startsWith('blob:')) {
                URL.revokeObjectURL(existingBlock.content.url);
                window.Editor.replaceBlockWithBlocks?.(existingBlock.id, []);
            }
            return;
        }

        const bookmarkBlock = window.Blocks.createBlock('bookmark', {
            url: downloadUrl,
            title: `Download PDF export: ${filename}`,
            description: `Latest PDF export generated ${new Date().toLocaleString()}`,
            favicon: '',
            image: ''
        }, {
            exportMarker: 'notes-pdf-export-link'
        });

        if (existingBlock?.content?.url && existingBlock.content.url.startsWith('blob:') && existingBlock.content.url !== downloadUrl) {
            URL.revokeObjectURL(existingBlock.content.url);
        }

        if (existingBlock) {
            bookmarkBlock.id = existingBlock.id;
            window.Editor.replaceBlockWithBlocks?.(existingBlock.id, [bookmarkBlock]);
            return;
        }

        const blocks = page.blocks || [];
        const lastBlockId = blocks.length ? blocks[blocks.length - 1].id : null;
        window.Editor.insertBlocksAfter?.(lastBlockId, [bookmarkBlock]);
    }

    /**
     * Export current page to specific format
     */
    async function exportCurrentPage(format) {
        const page = window.Editor?.getCurrentPage?.();
        if (!page) {
            showToast('No page to export', 'error');
            return;
        }
        
        try {
            showToast(`Exporting to ${format.toUpperCase()}...`, 'info');
            const result = await ImportExport.exportPage(page, format);
            const formats = ImportExport.getFormats().export;
            const formatInfo = formats[format];
            const filename = result?.filename || `${page.title || 'page'}.${formatInfo.ext}`;
            const exportBlob = result?.blob instanceof Blob ? result.blob : result;

            ImportExport.download(exportBlob, filename, result?.mimeType || formatInfo.mime);

            if (format === 'pdf' && exportBlob instanceof Blob) {
                const downloadUrl = await createPdfExportLink(exportBlob, filename, page);
                if (downloadUrl) {
                    updatePdfExportBlock(downloadUrl, filename);
                }
            }

            showToast(`Exported as ${formatInfo.name}`, 'success');
        } catch (error) {
            console.error('Export error:', error);
            if (format === 'pdf' && ImportExport.openPrintFriendlyFallback?.(page)) {
                showToast('Server PDF export unavailable. Opened a printable fallback view.', 'info');
                return;
            }
            showToast(`Export failed: ${error.message}`, 'error');
        }
    }
    
    /**
     * Setup export button dropdown
     */
    function setupExportButton() {
        const exportBtn = document.getElementById('export-btn');
        const exportMenu = document.getElementById('export-menu');
        
        if (!exportBtn || !exportMenu) return;

        const exportItems = Array.from(exportMenu.querySelectorAll('.export-item'));
        const setExportMenuOpen = (isOpen, focusFirst = false) => {
            exportMenu.style.display = isOpen ? 'block' : 'none';
            exportBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

            if (isOpen && focusFirst && exportItems[0]) {
                exportItems[0].focus();
            }
        };

        const moveExportFocus = (currentItem, direction) => {
            const currentIndex = exportItems.indexOf(currentItem);
            const nextIndex = currentIndex < 0
                ? 0
                : (currentIndex + direction + exportItems.length) % exportItems.length;
            exportItems[nextIndex]?.focus();
        };
        
        exportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = exportMenu.style.display === 'block';
            setExportMenuOpen(!isVisible, !isVisible);
        });

        exportBtn.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            setExportMenuOpen(true, true);
        });
        
        // Close menu when clicking outside
        document.addEventListener('click', () => {
            setExportMenuOpen(false);
        });
        
        // Handle export format selection
        exportItems.forEach(item => {
            item.addEventListener('click', async (e) => {
                e.stopPropagation();
                const format = item.dataset.format;
                setExportMenuOpen(false);
                exportBtn.focus();
                await exportCurrentPage(format);
            });

            item.addEventListener('keydown', async (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    setExportMenuOpen(false);
                    exportBtn.focus();
                    return;
                }

                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    moveExportFocus(item, e.key === 'ArrowDown' ? 1 : -1);
                    return;
                }

                if (e.key === 'Home' || e.key === 'End') {
                    e.preventDefault();
                    exportItems[e.key === 'Home' ? 0 : exportItems.length - 1]?.focus();
                    return;
                }

                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                const format = item.dataset.format;
                setExportMenuOpen(false);
                exportBtn.focus();
                await exportCurrentPage(format);
            });
        });
    }
    
    /**
     * Show import modal
     */
    function showImportModal(triggerElement = document.activeElement) {
        const formats = ImportExport.getFormats().import;
        
        const modal = document.createElement('div');
        modal.className = 'import-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', 'Import page');
        modal.setAttribute('aria-describedby', 'import-modal-description');
        modal.innerHTML = `
            <div class="import-modal-content">
                <div class="import-modal-header">
                    <span class="import-modal-title">📥 Import Page</span>
                    <button class="import-modal-close" type="button" aria-label="Close import dialog">&times;</button>
                </div>
                <div class="import-modal-body">
                    <div class="file-drop-zone" id="file-drop-zone" role="button" tabindex="0" aria-describedby="import-modal-description">
                        <div class="file-drop-zone-icon">📁</div>
                        <div class="file-drop-zone-text">Drop a file here or click to browse</div>
                        <div class="file-drop-zone-hint" id="import-modal-description">Supports DOCX, PDF, HTML, Markdown, Lilly JSON, and TXT</div>
                        <input type="file" class="file-input" id="file-input" accept=".docx,.pdf,.html,.md,.json,.txt">
                    </div>
                    
                    <div class="import-formats">
                        <div class="import-formats-title">Supported Formats</div>
                        <div class="import-format-grid">
                            <div class="import-format-item" data-format="docx">
                                <span class="import-format-icon">📄</span>
                                <span class="import-format-name">Word</span>
                            </div>
                            <div class="import-format-item" data-format="pdf">
                                <span class="import-format-icon">📑</span>
                                <span class="import-format-name">PDF</span>
                            </div>
                            <div class="import-format-item" data-format="html">
                                <span class="import-format-icon">🌐</span>
                                <span class="import-format-name">HTML</span>
                            </div>
                            <div class="import-format-item" data-format="md">
                                <span class="import-format-icon">📝</span>
                                <span class="import-format-name">Markdown</span>
                            </div>
                            <div class="import-format-item" data-format="json">
                                <span class="import-format-icon">📋</span>
                                <span class="import-format-name">Lilly</span>
                            </div>
                            <div class="import-format-item" data-format="txt">
                                <span class="import-format-icon">📃</span>
                                <span class="import-format-name">Text</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        function closeImportModal() {
            modal.remove();
            if (triggerElement && document.contains(triggerElement) && typeof triggerElement.focus === 'function') {
                triggerElement.focus();
            }
        }

        function handleImportModalKeydown(e) {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            closeImportModal();
        }

        // Close handlers
        modal.querySelector('.import-modal-close').addEventListener('click', closeImportModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeImportModal();
        });
        modal.addEventListener('keydown', handleImportModalKeydown);
        
        // File drop zone handlers
        const dropZone = modal.querySelector('#file-drop-zone');
        const fileInput = modal.querySelector('#file-input');
        
        dropZone.addEventListener('click', () => fileInput.click());
        dropZone.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            fileInput.click();
        });
        
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleFileImport(e.target.files[0], modal);
            }
        });
        
        // Drag and drop handlers
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('drag-over');
        });
        
        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('drag-over');
        });
        
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            if (e.dataTransfer.files.length > 0) {
                handleFileImport(e.dataTransfer.files[0], modal);
            }
        });
        
        // Format item click handlers
        modal.querySelectorAll('.import-format-item').forEach(item => {
            item.setAttribute('role', 'button');
            item.setAttribute('tabindex', '0');
            item.addEventListener('click', () => {
                fileInput.click();
            });
            item.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                fileInput.click();
            });
        });
        
        document.body.appendChild(modal);
        modal.querySelector('.import-modal-close')?.focus({ preventScroll: true });
    }
    
    /**
     * Handle file import with enhanced PDF support
     */
    async function handleFileImport(file, modal) {
        const body = modal.querySelector('.import-modal-body');
        const isPDF = file.name.toLowerCase().endsWith('.pdf');
        
        // For PDFs, show enhanced import UI with preview and options
        if (isPDF && typeof PDFImport !== 'undefined') {
            await handlePDFImport(file, modal);
            return;
        }
        
        // Standard import for other formats
        body.innerHTML = `
            <div class="import-progress">
                <div class="import-progress-spinner"></div>
                <div class="import-progress-text">Importing ${file.name}...</div>
            </div>
        `;
        
        try {
            const page = await ImportExport.importFile(file);
            
            // Save the imported page
            const newPage = Storage.createPage(page.title || 'Imported Page');
            newPage.icon = page.icon || '📄';
            newPage.blocks = Storage.cloneBlocksWithFreshIds(page.blocks);
            
            Storage.updatePage(newPage.id, newPage);
            refreshPageTree();
            loadPage(newPage.id);
            
            modal.remove();
            showToast(`Imported "${newPage.title}" successfully!`, 'success');
        } catch (error) {
            console.error('Import error:', error);
            showImportError(body, error, modal);
        }
    }
    
    /**
     * Handle PDF import with preview and options
     */
    async function handlePDFImport(file, modal) {
        const body = modal.querySelector('.import-modal-body');
        
        // Show loading state
        body.innerHTML = `
            <div class="import-progress">
                <div class="import-progress-spinner"></div>
                <div class="import-progress-text">Analyzing PDF...</div>
            </div>
        `;
        
        try {
            // Read file
            const arrayBuffer = await file.arrayBuffer();
            
            // Initialize PDF.js
            if (!PDFImport.initialize || !PDFImport.initialize()) {
                await PDFImport.loadPDFJS();
            }
            
            // Get preview
            const preview = await PDFImport.previewPDF(arrayBuffer, { maxPages: 3 });
            
            // Check if scanned
            const scanInfo = await PDFImport.detectScannedPDF(arrayBuffer);
            
            // Show PDF import options UI
            body.innerHTML = `
                <div class="pdf-import-options">
                    <div class="pdf-preview-section">
                        <div class="pdf-preview-header">
                            <span class="pdf-preview-title">📄 ${file.name}</span>
                            <span class="pdf-preview-pages">${preview.totalPages} pages</span>
                        </div>
                        ${scanInfo.isScanned ? `
                        <div class="pdf-scanned-warning">
                            <span>⚠️</span>
                            <span>This appears to be a scanned/image-based PDF. Import may include page images.</span>
                        </div>
                        ` : ''}
                        <div class="pdf-preview-thumbnails">
                            ${preview.previews.map(p => `
                                <div class="pdf-preview-thumb">
                                    <img src="${p.thumbnail}" alt="Page ${p.pageNum}">
                                    <span class="pdf-preview-page-num">${p.pageNum}</span>
                                    ${!p.hasText ? '<span class="pdf-preview-no-text">Image</span>' : ''}
                                </div>
                            `).join('')}
                            ${preview.hasMore ? '<div class="pdf-preview-more">...</div>' : ''}
                        </div>
                    </div>
                    
                    <div class="pdf-import-settings">
                        <div class="pdf-setting-row">
                            <label class="pdf-setting-label">
                                <span>Pages to import</span>
                                <span class="pdf-setting-hint">Leave empty for all pages</span>
                            </label>
                            <input type="text" id="pdf-page-range" class="pdf-setting-input" 
                                placeholder="e.g., 1-5, 8, 10-12" 
                                title="Enter page numbers or ranges separated by commas">
                        </div>
                        
                        <div class="pdf-setting-row">
                            <label class="pdf-setting-label">
                                <span>Image quality</span>
                                <span class="pdf-setting-hint">For scanned pages</span>
                            </label>
                            <select id="pdf-image-quality" class="pdf-setting-select">
                                <option value="0.7">Standard (faster)</option>
                                <option value="0.92" selected>High (recommended)</option>
                                <option value="1.0">Maximum (slower)</option>
                            </select>
                        </div>
                        
                        <div class="pdf-setting-row checkbox">
                            <label class="pdf-setting-checkbox">
                                <input type="checkbox" id="pdf-extract-images" checked>
                                <span>Extract images from PDF</span>
                            </label>
                        </div>
                    </div>
                    
                    <div class="pdf-import-actions">
                        <button class="ai-btn cancel" id="pdf-cancel">Cancel</button>
                        <button class="ai-btn primary" id="pdf-import">
                            <span>Import PDF</span>
                            <span class="pdf-import-hint">${preview.totalPages} pages</span>
                        </button>
                    </div>
                </div>
            `;
            
            // Add styles for PDF import UI
            addPDFImportStyles();
            
            // Event handlers
            body.querySelector('#pdf-cancel').addEventListener('click', () => modal.remove());
            
            body.querySelector('#pdf-import').addEventListener('click', async () => {
                const pageRange = body.querySelector('#pdf-page-range').value.trim();
                const imageQuality = parseFloat(body.querySelector('#pdf-image-quality').value);
                const extractImages = body.querySelector('#pdf-extract-images').checked;
                
                // Show progress
                body.innerHTML = `
                    <div class="pdf-import-progress-container">
                        <div class="pdf-import-progress-header">Importing PDF...</div>
                        <div class="pdf-import-progress-bar">
                            <div class="pdf-import-progress-fill" id="pdf-progress-fill"></div>
                        </div>
                        <div class="pdf-import-progress-status" id="pdf-progress-status">Preparing...</div>
                        <div class="pdf-import-progress-detail" id="pdf-progress-detail"></div>
                    </div>
                `;
                
                const updateProgress = (progress) => {
                    const fill = document.getElementById('pdf-progress-fill');
                    const status = document.getElementById('pdf-progress-status');
                    const detail = document.getElementById('pdf-progress-detail');
                    
                    if (fill) {
                        fill.style.width = `${(progress.progress * 100).toFixed(0)}%`;
                    }
                    if (status) {
                        status.textContent = progress.message;
                    }
                    if (detail && progress.currentPage) {
                        detail.textContent = `Page ${progress.currentPage} of ${progress.totalPages}`;
                    }
                };
                
                try {
                    const options = {
                        title: file.name.replace(/\.pdf$/i, ''),
                        pageRange: pageRange || null,
                        imageQuality,
                        extractImages,
                        showProgress: true
                    };
                    
                    const page = await ImportExport.importFromPDF(arrayBuffer, options, updateProgress);
                    
                    // Save the imported page
                    const newPage = Storage.createPage(page.title || 'Imported PDF');
                    newPage.icon = '📄';
                    newPage.blocks = Storage.cloneBlocksWithFreshIds(page.blocks);
                    
                    Storage.updatePage(newPage.id, newPage);
                    refreshPageTree();
                    loadPage(newPage.id);
                    
                    modal.remove();
                    showToast(`Imported "${newPage.title}" successfully!`, 'success');
                } catch (error) {
                    console.error('PDF import error:', error);
                    showImportError(body, error, modal);
                }
            });
            
        } catch (error) {
            console.error('PDF preview error:', error);
            showImportError(body, error, modal);
        }
    }
    
    /**
     * Show import error with fallback option
     */
    function showImportError(body, error, modal) {
        body.innerHTML = `
            <div class="import-message error">
                <span>❌</span>
                <span>Import failed: ${error.message}</span>
            </div>
            <div class="import-error-actions">
                <button class="ai-btn" id="import-retry">Try Again</button>
                <button class="ai-btn secondary" id="import-help">Get Help</button>
            </div>
            <div class="import-error-hint" style="margin-top: 12px; padding: 12px; background: var(--bg-secondary); border-radius: var(--radius-md); font-size: 13px; color: var(--text-muted);">
                <strong>Tips:</strong>
                <ul style="margin: 8px 0 0 16px; padding: 0;">
                    <li>For scanned PDFs, consider using OCR tools first</li>
                    <li>Try converting to a different format (e.g., DOCX)</li>
                    <li>Check that the file isn't corrupted or password-protected</li>
                </ul>
            </div>
        `;
        
        body.querySelector('#import-retry').addEventListener('click', () => {
            showImportModal();
            modal.remove();
        });
        
        body.querySelector('#import-help').addEventListener('click', () => {
            alert('PDF Import Help:\n\n' +
                '• Text-based PDFs: Content is extracted as editable text\n' +
                '• Scanned PDFs: Pages are imported as images\n' +
                '• Mixed PDFs: Text and images are both extracted\n\n' +
                'For best results with scanned documents, use OCR software ' +
                '(like Adobe Acrobat, online OCR tools) before importing.');
        });
    }
    
    /**
     * Add PDF import UI styles
     */
    function addPDFImportStyles() {
        if (document.getElementById('pdf-import-styles')) return;
        
        const style = document.createElement('style');
        style.id = 'pdf-import-styles';
        style.textContent = `
            .pdf-import-options {
                padding: 16px;
            }
            
            .pdf-preview-section {
                margin-bottom: 20px;
            }
            
            .pdf-preview-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 12px;
            }
            
            .pdf-preview-title {
                font-weight: 500;
                font-size: 14px;
                color: var(--text-primary);
            }
            
            .pdf-preview-pages {
                font-size: 12px;
                color: var(--text-muted);
                background: var(--bg-secondary);
                padding: 4px 8px;
                border-radius: var(--radius-sm);
            }
            
            .pdf-scanned-warning {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 10px 12px;
                background: #fff8e1;
                border: 1px solid #ffe082;
                border-radius: var(--radius-md);
                margin-bottom: 12px;
                font-size: 13px;
                color: #f57c00;
            }
            
            .pdf-preview-thumbnails {
                display: flex;
                gap: 8px;
                overflow-x: auto;
                padding: 8px 0;
            }
            
            .pdf-preview-thumb {
                position: relative;
                flex-shrink: 0;
                width: 80px;
                height: 100px;
                border: 1px solid var(--border-color);
                border-radius: var(--radius-sm);
                overflow: hidden;
                background: var(--bg-secondary);
            }
            
            .pdf-preview-thumb img {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }
            
            .pdf-preview-page-num {
                position: absolute;
                bottom: 4px;
                right: 4px;
                font-size: 10px;
                background: rgba(0,0,0,0.7);
                color: white;
                padding: 2px 4px;
                border-radius: 2px;
            }
            
            .pdf-preview-no-text {
                position: absolute;
                top: 4px;
                left: 4px;
                font-size: 9px;
                background: #ff9800;
                color: white;
                padding: 2px 4px;
                border-radius: 2px;
            }
            
            .pdf-preview-more {
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
                width: 40px;
                height: 100px;
                font-size: 20px;
                color: var(--text-muted);
            }
            
            .pdf-import-settings {
                background: var(--bg-secondary);
                border-radius: var(--radius-md);
                padding: 16px;
                margin-bottom: 16px;
            }
            
            .pdf-setting-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 12px;
            }
            
            .pdf-setting-row:last-child {
                margin-bottom: 0;
            }
            
            .pdf-setting-row.checkbox {
                justify-content: flex-start;
                gap: 8px;
            }
            
            .pdf-setting-label {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            
            .pdf-setting-label span:first-child {
                font-size: 13px;
                font-weight: 500;
                color: var(--text-primary);
            }
            
            .pdf-setting-hint {
                font-size: 11px;
                color: var(--text-muted);
            }
            
            .pdf-setting-input,
            .pdf-setting-select {
                padding: 6px 10px;
                border: 1px solid var(--border-color);
                border-radius: var(--radius-sm);
                font-size: 13px;
                background: var(--bg-primary);
                color: var(--text-primary);
                min-width: 140px;
            }
            
            .pdf-setting-checkbox {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 13px;
                cursor: pointer;
            }
            
            .pdf-setting-checkbox input[type="checkbox"] {
                width: 16px;
                height: 16px;
            }
            
            .pdf-import-actions {
                display: flex;
                justify-content: flex-end;
                gap: 10px;
            }
            
            .pdf-import-hint {
                font-size: 11px;
                opacity: 0.8;
                margin-left: 6px;
            }
            
            .pdf-import-progress-container {
                padding: 32px;
                text-align: center;
            }
            
            .pdf-import-progress-header {
                font-size: 16px;
                font-weight: 500;
                margin-bottom: 20px;
                color: var(--text-primary);
            }
            
            .pdf-import-progress-bar {
                width: 100%;
                height: 8px;
                background: var(--bg-secondary);
                border-radius: 4px;
                overflow: hidden;
                margin-bottom: 16px;
            }
            
            .pdf-import-progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #2383e2, #4facfe);
                border-radius: 4px;
                transition: width 0.3s ease;
                width: 0%;
            }
            
            .pdf-import-progress-status {
                font-size: 14px;
                color: var(--text-primary);
                margin-bottom: 4px;
            }
            
            .pdf-import-progress-detail {
                font-size: 12px;
                color: var(--text-muted);
            }
            
            .import-error-actions {
                display: flex;
                gap: 10px;
                margin-top: 12px;
            }
            
            .ai-btn.secondary {
                background: var(--bg-secondary);
                color: var(--text-primary);
            }
            
            @keyframes pdf-pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }
            
            .pdf-import-progress-fill.indeterminate {
                animation: pdf-pulse 1.5s ease-in-out infinite;
                background: linear-gradient(90deg, #2383e2, #4facfe, #2383e2);
                background-size: 200% 100%;
            }
        `;
        
        document.head.appendChild(style);
    }
    
    /**
     * Show export all modal
     */
    function showExportAllModal() {
        const modal = document.createElement('div');
        modal.className = 'export-all-modal';
        modal.innerHTML = `
            <div class="export-all-content">
                <div class="export-all-header">
                    <h3 class="export-all-title">&#128228; Export All Pages</h3>
                </div>
                <div class="export-all-body">
                    <div class="export-all-options">
                        <div class="export-all-option" data-format="md">
                            <span class="export-all-option-icon">📝</span>
                            <div class="export-all-option-info">
                                <div class="export-all-option-title">Markdown</div>
                                <div class="export-all-option-desc">Export all pages as a single Markdown file</div>
                            </div>
                        </div>
                        <div class="export-all-option" data-format="json">
                            <span class="export-all-option-icon">📋</span>
                            <div class="export-all-option-info">
                                <div class="export-all-option-title">JSON Backup</div>
                                <div class="export-all-option-desc">Export all data as JSON (includes metadata)</div>
                            </div>
                        </div>
                        <div class="export-all-option" data-format="html">
                            <span class="export-all-option-icon">🌐</span>
                            <div class="export-all-option-info">
                                <div class="export-all-option-title">HTML</div>
                                <div class="export-all-option-desc">Export all pages as a single HTML document</div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="export-all-footer">
                    <button class="ai-btn" id="export-all-cancel">Cancel</button>
                </div>
            </div>
        `;
        
        modal.querySelector('#export-all-cancel').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
        
        modal.querySelectorAll('.export-all-option').forEach(option => {
            option.addEventListener('click', async () => {
                const format = option.dataset.format;
                await exportAllPages(format);
                modal.remove();
            });
        });
        
        document.body.appendChild(modal);
    }
    
    /**
     * Export all pages in a format
     */
    async function exportAllPages(format) {
        const allPages = Storage.getPages();
        
        try {
            showToast(`Exporting ${allPages.length} pages...`, 'info');
            
            if (format === 'json') {
                // Use storage backup
                Storage.exportToFile();
                showToast('Exported all pages as JSON', 'success');
                return;
            }
            
            if (format === 'md') {
                let allMarkdown = '';
                for (let index = 0; index < allPages.length; index += 1) {
                    const page = allPages[index];
                    allMarkdown += await ImportExport.exportPage(page, 'md');
                    if (index < allPages.length - 1) {
                        allMarkdown += '\n\n---\n\n';
                    }
                }
                downloadFile(allMarkdown, 'all-pages.md', 'text/markdown');
                showToast('Exported all pages as Markdown', 'success');
                return;
            }
            
            if (format === 'html') {
                let allHTML = `<!DOCTYPE html>
<html>
<head>
    <title>All Pages Export</title>
    <meta charset="UTF-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 900px; margin: 0 auto; padding: 40px 20px; color: #37352f; line-height: 1.6; }
        .page { margin-bottom: 60px; padding-bottom: 40px; border-bottom: 2px solid #eee; }
        h1 { font-size: 32px; margin-bottom: 8px; }
        .page-icon { font-size: 48px; }
        img { max-width: 100%; height: auto; border-radius: 8px; }
        figure { margin: 20px 0; }
        figcaption, .image-subtext, .image-source { text-align: center; color: #555; font-size: 14px; }
        table { width: 100%; border-collapse: collapse; margin: 16px 0; }
        th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
    </style>
</head>
<body>`;
                
                for (const page of allPages) {
                    const pageHTML = await ImportExport.exportPage(page, 'html');
                    const bodyMatch = String(pageHTML || '').match(/<body[^>]*>([\s\S]*?)<\/body>/i);
                    const bodyContent = bodyMatch ? bodyMatch[1] : pageHTML;
                    allHTML += `
    <div class="page">
        ${bodyContent}
    </div>`;
                }
                
                allHTML += '</body></html>';
                downloadFile(allHTML, 'all-pages.html', 'text/html');
                showToast('Exported all pages as HTML', 'success');
            }
        } catch (error) {
            console.error('Export all error:', error);
            showToast(`Export failed: ${error.message}`, 'error');
        }
    }
    
    /**
     * Export current page to PDF
     */
    function exportToPDF() {
        const page = window.Editor?.getCurrentPage?.();
        if (!page) return;
        
        // Create a print-friendly version
        const printWindow = window.open('', '_blank');
        const markdown = window.Editor.exportToMarkdown();
        
        // Simple HTML conversion (could be enhanced with marked.js)
        const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <title>${page.title || 'Untitled'}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            max-width: 800px;
            margin: 40px auto;
            padding: 20px;
            line-height: 1.6;
            color: #333;
        }
        h1, h2, h3 { margin-top: 1.5em; }
        pre {
            background: #f5f5f5;
            padding: 16px;
            border-radius: 8px;
            overflow-x: auto;
        }
        code {
            font-family: "SFMono-Regular", Consolas, monospace;
            font-size: 0.9em;
        }
        blockquote {
            border-left: 4px solid #2383e2;
            margin: 0;
            padding-left: 16px;
            color: #666;
        }
        ul, ol { padding-left: 24px; }
        .print-markdown { background: none; padding: 0; white-space: pre-wrap; word-wrap: break-word; }
        .print-meta { color: #999; font-size: 12px; }
        @media print {
            body { margin: 0; }
        }
    </style>
</head>
<body>
    <pre class="print-markdown">${escapeHtml(markdown)}</pre>
    <hr>
    <p class="print-meta">Exported from Notes - ${new Date().toLocaleString()}</p>
    <script>
        // Auto-print
        setTimeout(() => print(), 500);
    <\/script>
</body>
</html>`;
        
        printWindow.document.write(htmlContent);
        printWindow.document.close();
        
        showToast('PDF export window opened', 'success');
    }
    
    /**
     * Show storage information
     */
    function showStorageInfo(triggerElement = document.activeElement) {
        const status = Storage.getStorageStatus();

        const modal = document.createElement('div');
        modal.id = 'storage-status-modal';
        modal.className = 'ai-modal is-open';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'storage-status-title');
        modal.innerHTML = `
            <div class="ai-modal-content storage-status-content">
                <div class="ai-modal-header storage-status-header">
                    <span aria-hidden="true">&#128190;</span>
                    <span id="storage-status-title">Storage Information</span>
                    <button class="close-btn storage-status-close" type="button" aria-label="Close storage information">&times;</button>
                </div>
                <div class="storage-status-body">
                    <section class="storage-status-section">
                        <div class="storage-status-label">Storage Status</div>
                        <div class="storage-status-value ${status.available ? 'is-success' : 'is-error'}">
                            ${status.available ? 'Available' : 'Using Memory Fallback'}
                        </div>
                    </section>
                    ${status.error ? `
                    <section class="storage-status-section">
                        <div class="storage-status-label">Error</div>
                        <div class="storage-status-value is-error">${escapeHtml(status.error.message)}</div>
                    </section>
                    ` : ''}
                    <section class="storage-status-section">
                        <div class="storage-status-label">Memory Fallback</div>
                        <div class="storage-status-value">${status.memoryFallback ? 'Active' : 'Not needed'}</div>
                    </section>
                    ${status.usage ? `
                    <section class="storage-status-section">
                        <div class="storage-status-label">Storage Usage</div>
                        <div class="storage-status-value">${(status.usage / 1024 / 1024).toFixed(2)} MB</div>
                    </section>
                    ` : ''}
                    ${status.quota ? `
                    <section class="storage-status-section">
                        <div class="storage-status-label">Storage Quota</div>
                        <div class="storage-status-value">${(status.quota / 1024 / 1024).toFixed(2)} MB</div>
                    </section>
                    ` : ''}
                    <div class="storage-status-note">
                        Tip: If localStorage is unavailable, your data is saved in memory. Use "Backup all data" to save your work.
                    </div>
                </div>
            </div>
        `;

        const closeButton = modal.querySelector('.close-btn');
        const closeStorageInfo = () => {
            modal.remove();
            triggerElement?.focus?.({ preventScroll: true });
        };

        closeButton.addEventListener('click', closeStorageInfo);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeStorageInfo();
        });
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeStorageInfo();
                return;
            }

            if (e.key !== 'Tab') return;
            e.preventDefault();
            closeButton.focus();
        });

        document.body.appendChild(modal);
        closeButton.focus({ preventScroll: true });
    }

    /**
     * Import from Markdown
     */
    function importFromMarkdown() {
        const modal = document.createElement('div');
        modal.id = 'import-modal';
        modal.className = 'ai-modal is-open';
        modal.innerHTML = `
            <div class="ai-modal-content import-modal-content import-markdown-content">
                <div class="ai-modal-header import-modal-header">
                    <span>&#128229;</span>
                    <span>Import from Markdown</span>
                    <button class="import-close" aria-label="Close markdown import">&times;</button>
                </div>
                <div class="import-modal-body import-markdown-body">
                    <textarea id="import-text" class="input import-markdown-textarea" placeholder="Paste Markdown here..."></textarea>
                </div>
                <div class="import-modal-footer modal-actions import-markdown-actions">
                    <button class="btn btn-ghost cancel">Cancel</button>
                    <button class="btn btn-primary import">Import</button>
                </div>
            </div>
        `;

        modal.querySelector('.import-close').addEventListener('click', () => modal.remove());
        modal.querySelector('.cancel').addEventListener('click', () => modal.remove());
        modal.querySelector('.import').addEventListener('click', () => {
            const text = modal.querySelector('#import-text').value;
            if (text.trim()) {
                const page = parseMarkdownToPage(text);
                Storage.updatePage(page.id, page);
                refreshPageTree();
                loadPage(page.id);
                modal.remove();
                showToast('Imported successfully', 'success');
            }
        });
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });

        document.body.appendChild(modal);
        setTimeout(() => modal.querySelector('#import-text')?.focus(), 0);
    }
    function parseMarkdownToPage(markdown) {
        const page = Storage.createPage();
        const lines = markdown.split('\n');
        const blocks = [];
        let codeBlock = null;
        
        lines.forEach(line => {
            if (codeBlock) {
                if (line.startsWith('```')) {
                    codeBlock = null;
                } else {
                    codeBlock.content.text += (codeBlock.content.text ? '\n' : '') + line;
                }
                return;
            }
            
            if (line.startsWith('```')) {
                const lang = line.slice(3).trim();
                codeBlock = Blocks.createBlock('code', { language: lang || 'plain', text: '' });
                blocks.push(codeBlock);
                return;
            }
            
            if (line.startsWith('# ')) {
                blocks.push(Blocks.createBlock('heading_1', line.slice(2)));
            } else if (line.startsWith('## ')) {
                blocks.push(Blocks.createBlock('heading_2', line.slice(3)));
            } else if (line.startsWith('### ')) {
                blocks.push(Blocks.createBlock('heading_3', line.slice(4)));
            } else if (line.startsWith('- [ ] ')) {
                blocks.push(Blocks.createBlock('todo', { text: line.slice(6), checked: false }));
            } else if (line.startsWith('- [x] ')) {
                blocks.push(Blocks.createBlock('todo', { text: line.slice(6), checked: true }));
            } else if (line.startsWith('- ')) {
                blocks.push(Blocks.createBlock('bulleted_list', line.slice(2)));
            } else if (line.match(/^\d+\. /)) {
                blocks.push(Blocks.createBlock('numbered_list', line.replace(/^\d+\. /, '')));
            } else if (line.startsWith('> ')) {
                blocks.push(Blocks.createBlock('quote', line.slice(2)));
            } else if (line === '---') {
                blocks.push(Blocks.createBlock('divider', ''));
            } else if (line.trim()) {
                blocks.push(Blocks.createBlock('text', line));
            }
        });
        
        // Extract title from first heading or use default
        const firstHeading = blocks.find(b => b.type === 'heading_1');
        if (firstHeading) {
            page.title = firstHeading.content;
            blocks.splice(blocks.indexOf(firstHeading), 1);
        }
        
        page.blocks = blocks.length > 0 ? blocks : [Blocks.createBlock('text', '')];
        return page;
    }
    
    /**
     * Download a file
     */
    function downloadFile(content, filename, type) {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    // Toast management
    const toastQueue = [];
    const MAX_TOASTS = 3;
    const TOAST_DURATION = 5000;
    
    /**
     * Show toast notification with stacking and auto-dismiss
     */
    function showToast(message, type = 'info', options = {}) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const {
            duration = TOAST_DURATION,
            action = null,
            onClose = null
        } = options;

        if (toastQueue.length >= MAX_TOASTS) {
            const oldest = toastQueue.shift();
            if (oldest && oldest.element) {
                if (oldest.timeout) {
                    clearTimeout(oldest.timeout);
                }
                oldest.element.remove();
            }
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type} toast-${type}${action ? ' toast--actionable' : ''}`;
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');

        let content = `<span class="toast-message">${escapeHtml(message)}</span>`;
        if (action) {
            content += `<button type="button" class="toast-action">${escapeHtml(action.label)}</button>`;
        }
        content += `<button type="button" class="toast-close${action ? '' : ' toast-close--solo'}" aria-label="Close notification">&times;</button>`;
        toast.innerHTML = content;

        const toastItem = {
            element: toast,
            timeout: setTimeout(() => {
                removeToast(toastItem);
                if (onClose) onClose();
            }, duration)
        };

        toast.querySelector('.toast-close').addEventListener('click', () => {
            removeToast(toastItem);
            if (onClose) onClose();
        });

        if (action) {
            toast.querySelector('.toast-action').addEventListener('click', () => {
                action.callback();
                removeToast(toastItem);
            });
        }

        container.appendChild(toast);
        toastQueue.push(toastItem);
    }

    /**
     * Remove a toast from the queue and DOM
     */
    function removeToast(toastItem) {
        const index = toastQueue.indexOf(toastItem);
        if (index > -1) {
            toastQueue.splice(index, 1);
        }

        if (toastItem.element) {
            toastItem.element.classList.add('is-removing');
            setTimeout(() => {
                toastItem.element.remove();
            }, 220);
        }

        if (toastItem.timeout) {
            clearTimeout(toastItem.timeout);
        }
    }
    function showUndoToast(message, undoCallback) {
        let undoPerformed = false;
        
        showToast(message, 'info', {
            duration: 5000,
            action: {
                label: 'Undo',
                callback: () => {
                    undoPerformed = true;
                    undoCallback();
                }
            },
            onClose: () => {
                // Toast closed without undo - finalize deletion
                if (!undoPerformed) {
                    // Optional: perform permanent cleanup
                }
            }
        });
    }
    
    /**
     * Show search modal for finding content across pages
     */
    function showSearchModal(triggerElement = document.activeElement) {
        const pages = Storage.getPages();

        const modal = document.createElement('div');
        modal.id = 'search-modal';
        modal.className = 'ai-modal is-open';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'search-modal-title');
        modal.setAttribute('aria-describedby', 'search-modal-description');
        modal.innerHTML = `
            <div class="ai-modal-content search-content search-modal-content">
                <div class="ai-modal-header search-header">
                    <span>&#128269;</span>
                    <span id="search-modal-title">Search Pages</span>
                    <button class="search-close" type="button" aria-label="Close search">&times;</button>
                </div>
                <div class="search-toolbar">
                    <p id="search-modal-description" class="sr-only">Search page titles and content, then use arrow keys to review results.</p>
                    <input type="text" id="search-input" placeholder="Search page titles and content..." class="input" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="search-results" aria-autocomplete="list">
                </div>
                <div id="search-results" class="search-results" role="listbox" aria-label="Search results">
                    <div class="search-results-empty search-results-placeholder">
                        Type to search across all pages...
                    </div>
                </div>
                <div class="search-results-footer">
                    <span id="search-results-status" role="status" aria-live="polite">Type to search across all pages</span>
                    <span class="search-results-shortcuts">Enter opens selected &middot; Esc closes</span>
                </div>
            </div>
        `;

        const searchInput = modal.querySelector('#search-input');
        const searchResults = modal.querySelector('#search-results');
        const searchResultsStatus = modal.querySelector('#search-results-status');

        function closeSearchModal() {
            modal.remove();
            const focusTarget = triggerElement && document.contains(triggerElement)
                ? triggerElement
                : document.querySelector('#page-title, #editor .block-input, #editor [contenteditable="true"], #editor');
            focusTarget?.focus?.({ preventScroll: true });
        }

        modal.querySelector('.search-close').addEventListener('click', closeSearchModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeSearchModal();
        });

        let selectedIndex = -1;
        let currentResults = [];

        const renderEmptyState = (message, isPlaceholder = false) => {
            searchInput.setAttribute('aria-expanded', 'false');
            searchInput.removeAttribute('aria-activedescendant');
            searchResultsStatus.textContent = isPlaceholder ? 'Type to search across all pages' : message;
            searchResults.innerHTML = `
                <div class="search-results-empty${isPlaceholder ? ' search-results-placeholder' : ''}">
                    ${message}
                </div>
            `;
        };

        const openResult = (result) => {
            loadPage(result.page.id);
            showToast(`Opened: ${result.page.title || 'Untitled'}`, 'success');
        };

        const renderResults = () => {
            const selectedResultId = selectedIndex >= 0 ? `search-result-${selectedIndex}` : '';
            const resultLabel = currentResults.length === 1 ? '1 result' : `${currentResults.length} results`;
            searchResultsStatus.textContent = `${resultLabel} found`;
            searchInput.setAttribute('aria-expanded', currentResults.length > 0 ? 'true' : 'false');
            if (selectedResultId) {
                searchInput.setAttribute('aria-activedescendant', selectedResultId);
            } else {
                searchInput.removeAttribute('aria-activedescendant');
            }

            searchResults.innerHTML = currentResults.map((result, index) => `
                <div id="search-result-${index}" class="search-result-item ${index === selectedIndex ? 'selected' : ''}" data-index="${index}" role="option" aria-selected="${index === selectedIndex ? 'true' : 'false'}">
                    <div class="search-result-row">
                        <span class="search-result-icon">${result.page.icon || '&#128196;'}</span>
                        <span class="search-result-title">${escapeHtml(result.page.title || 'Untitled')}</span>
                        ${result.type === 'content' ? `<span class="search-result-chip chip">${escapeHtml(result.blockType)}</span>` : ''}
                    </div>
                    <div class="search-result-preview">${escapeHtml(result.preview)}</div>
                </div>
            `).join('');

            searchResults.querySelectorAll('.search-result-item').forEach(item => {
                item.addEventListener('click', () => {
                    const index = parseInt(item.dataset.index, 10);
                    openResult(currentResults[index]);
                    closeSearchModal();
                });
                item.addEventListener('mouseenter', () => {
                    selectedIndex = parseInt(item.dataset.index, 10);
                    renderResults();
                });
            });

            const selected = searchResults.querySelector('.search-result-item.selected');
            if (selected) {
                selected.scrollIntoView({ block: 'nearest' });
            }
        };

        const performSearch = (query) => {
            if (!query.trim()) {
                currentResults = [];
                selectedIndex = -1;
                renderEmptyState('Type to search across all pages...', true);
                return;
            }

            const lowerQuery = query.toLowerCase();
            const results = [];

            pages.forEach(page => {
                if (page.title?.toLowerCase().includes(lowerQuery)) {
                    results.push({ page, type: 'title', preview: page.title });
                }

                if (page.blocks) {
                    page.blocks.forEach((block, index) => {
                        const content = typeof block.content === 'object'
                            ? block.content.text || block.content.prompt || JSON.stringify(block.content)
                            : block.content;

                        if (content?.toLowerCase().includes(lowerQuery)) {
                            const preview = content.substring(0, 100) + (content.length > 100 ? '...' : '');
                            results.push({
                                page,
                                type: 'content',
                                blockIndex: index,
                                preview,
                                blockType: block.type
                            });
                        }
                    });
                }
            });

            currentResults = results;
            selectedIndex = results.length > 0 ? 0 : -1;

            if (results.length === 0) {
                renderEmptyState(`No results found for "${escapeHtml(query)}"`);
                return;
            }

            renderResults();
        };

        let debounceTimer;
        searchInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => performSearch(searchInput.value), 200);
        });

        searchInput.addEventListener('keydown', (e) => {
            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    if (currentResults.length > 0) {
                        selectedIndex = (selectedIndex + 1) % currentResults.length;
                        renderResults();
                    }
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    if (currentResults.length > 0) {
                        selectedIndex = (selectedIndex - 1 + currentResults.length) % currentResults.length;
                        renderResults();
                    }
                    break;
                case 'Enter':
                    e.preventDefault();
                    if (selectedIndex >= 0 && currentResults[selectedIndex]) {
                        openResult(currentResults[selectedIndex]);
                        closeSearchModal();
                    }
                    break;
                case 'Escape':
                    e.preventDefault();
                    closeSearchModal();
                    break;
            }
        });

        document.body.appendChild(modal);
        searchInput.focus();
    }
    function escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
    
    /**
     * Debounce utility
     */
    function debounce(fn, delay) {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn(...args), delay);
        };
    }
    
    /**
     * Global PDF import progress callback
     */
    window.showPDFImportProgress = function(progress) {
        // This is handled within the modal, but can be customized here
        console.log('PDF Import Progress:', progress);
    };
    
    // Expose to window
    window.Sidebar = {
        init,
        refreshPageTree,
        loadPage,
        createNewPage,
        showTemplateModal,
        showToast,
        showUndoToast,
        showSearchModal,
        showImportModal,
        exportCurrentPage,
        showExportAllModal,
        toggle: toggleSidebar
    };
    
    return window.Sidebar;
})();
