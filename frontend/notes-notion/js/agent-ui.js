/**
 * AgentUI - UI controller for the notes AI assistant
 * Keeps the corner agent and model selector in sync with the Agent module.
 */
const AgentUI = (function() {
    const PROCESSING_STATES = [
        { label: 'Running', hint: 'Running through the page setup', motion: 'running' },
        { label: 'Jumping', hint: 'Jumping between related blocks', motion: 'jumping' },
        { label: 'Skipping', hint: 'Skipping across structure and tone', motion: 'skipping' },
        { label: 'Gliding', hint: 'Gliding through edits and context', motion: 'gliding' }
    ];
    const STARTER_ACTIONS = Object.freeze([
        { id: 'summarize', label: 'Summarize page', title: 'Summarize the entire page' },
        { id: 'restructure', label: 'Restructure sections', title: 'Rework the page section by section' },
        { id: 'polish_layout', label: 'Polish layout', title: 'Make the page feel more designed' },
        { id: 'layout_catalog', label: 'Pick layout', title: 'Show indexed page layout options' },
        { id: 'multi_pass', label: 'Work in passes', title: 'Plan, expand, and apply the page in multiple passes' },
        { id: 'section_agents', label: 'Section agents', title: 'Design the page, split it by headings, and build section chunks' },
        { id: 'brief', label: 'Turn into brief', title: 'Convert the page into an executive brief' },
        { id: 'grammar', label: 'Fix grammar', title: 'Fix grammar and spelling' }
    ]);

    let elements = {};
    let initialized = false;
    let processingTicker = null;
    let processingFrame = 0;
    let agentProcessing = false;
    let streamState = {
        active: false,
        content: '',
        reasoning: '',
        error: null
    };
    let selectedPageReferences = [];
    let referencePopoverOpen = false;
    let referenceSearchQuery = '';
    const MAX_SELECTED_REFERENCES = 6;
    const MAX_REFERENCE_RESULTS = 12;
    const MAX_REFERENCE_SEARCH_HITS = 16;
    const REFERENCE_TYPE_PAGE = 'page';
    const REFERENCE_TYPE_CHAT = 'chat';
    const REFERENCE_ICON_PAGE = '📄';
    const REFERENCE_ICON_CHAT = '💬';
    const LEGACY_MESSAGES_STORAGE_KEY = 'notes_agent_messages';
    const PAGE_MESSAGES_STORAGE_PREFIX = 'notes_agent_messages:';

    function cacheElements() {
        const widgetBtn = document.getElementById('agent-widget-btn');
        if (widgetBtn && !widgetBtn.querySelector('.agent-widget-copy')) {
            widgetBtn.innerHTML = `
                <span class="agent-avatar" aria-hidden="true"></span>
                <span class="agent-widget-copy">
                    <span class="agent-label">Ask AI</span>
                    <span class="agent-motion-text">Ready to work this page</span>
                </span>
            `;
        }

        const contextIndicator = document.querySelector('.context-indicator');
        let understandingCard = document.getElementById('agent-request-understanding');
        if (!understandingCard && contextIndicator?.parentElement) {
            understandingCard = document.createElement('div');
            understandingCard.id = 'agent-request-understanding';
            understandingCard.className = 'agent-request-understanding';
            contextIndicator.parentElement.appendChild(understandingCard);
        }

        let composerDesignTray = document.getElementById('agent-chat-design-tray');
        if (!composerDesignTray && contextIndicator?.parentElement) {
            composerDesignTray = document.createElement('div');
            composerDesignTray.id = 'agent-chat-design-tray';
            composerDesignTray.className = 'agent-composer-design-tray';
            composerDesignTray.hidden = true;
            contextIndicator.parentElement.appendChild(composerDesignTray);
        }

        elements = {
            widgetBtn,
            widgetLabel: document.querySelector('#agent-widget-btn .agent-label'),
            widgetMotionText: document.querySelector('#agent-widget-btn .agent-motion-text'),
            modal: document.getElementById('agent-chat-modal'),
            modalContent: document.querySelector('.agent-chat-container'),
            closeBtn: document.querySelector('.agent-chat-close'),
            messagesContainer: document.getElementById('agent-chat-messages'),
            inputArea: document.querySelector('.agent-chat-input-area'),
            input: document.getElementById('agent-chat-input'),
            sendBtn: document.getElementById('agent-chat-send'),
            modelSelectorDropdown: document.getElementById('model-selector-dropdown'),
            modelSelectorBtn: document.getElementById('model-selector-btn'),
            currentModelLabel: document.getElementById('current-model-label'),
            modelList: document.getElementById('model-list'),
            chatModelName: document.getElementById('agent-chat-model-name'),
            contextIndicator,
            referencePanel: document.getElementById('agent-reference-panel'),
            referenceBtn: document.getElementById('agent-reference-btn'),
            referencePopover: document.getElementById('agent-reference-popover'),
            referenceSearch: document.getElementById('agent-reference-search'),
            referenceClose: document.getElementById('agent-reference-close'),
            referenceResults: document.getElementById('agent-reference-results'),
            referenceChips: document.getElementById('agent-reference-chips'),
            profilePicker: document.getElementById('agent-profile-picker'),
            understandingCard,
            composerDesignTray,
            agentStatus: document.querySelector('.agent-status'),
            agentStatusText: document.querySelector('.agent-status-text')
        };
    }

    function init() {
        if (initialized) return;

        cacheElements();

        if (!elements.modal || !elements.messagesContainer) {
            console.warn('AgentUI: required chat elements not found, skipping initialization');
            return;
        }

        setupEventListeners();
        updateModelUI();
        renderProfilePicker();
        updateContextIndicator();
        renderReferencePicker();
        renderMessages();
        renderComposerDesignOptions();
        syncProcessingUI();
        initialized = true;
        console.log('AgentUI initialized');
    }

    function setupEventListeners() {
        if (elements.widgetBtn) {
            elements.widgetBtn.addEventListener('click', openChat);
        }

        if (elements.closeBtn) {
            elements.closeBtn.addEventListener('click', closeChat);
        }

        if (elements.modal) {
            elements.modal.addEventListener('click', (event) => {
                if (event.target === elements.modal) {
                    closeChat();
                }
            });
        }

        if (elements.sendBtn) {
            elements.sendBtn.addEventListener('click', sendMessage);
        }

        if (elements.input) {
            elements.input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                }
                // Escape key closes chat modal
                if (event.key === 'Escape') {
                    event.preventDefault();
                    closeChat();
                }
            });

            elements.input.addEventListener('input', () => {
                autoResizeInput();
                renderComposerDesignOptions();
                renderRequestUnderstanding();
                if (!streamState.active && !streamState.error && getVisibleMessages().length === 0) {
                    renderMessages();
                }
            });
        }

        if (elements.composerDesignTray) {
            elements.composerDesignTray.addEventListener('click', (event) => {
                const button = event.target.closest('.agent-composer-design-btn[data-prompt]');
                if (!button) return;

                applyDesignOptionPrompt(button.dataset.prompt || '');
            });
        }

        if (elements.referenceBtn) {
            elements.referenceBtn.addEventListener('click', () => {
                toggleReferencePopover();
            });
        }

        if (elements.referenceSearch) {
            elements.referenceSearch.addEventListener('input', () => {
                referenceSearchQuery = elements.referenceSearch.value || '';
                renderReferenceResults();
            });

            elements.referenceSearch.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    closeReferencePopover({ focusInput: true });
                }
                if (event.key === 'Enter') {
                    const firstResult = elements.referenceResults?.querySelector('.agent-reference-result[data-page-id]');
                    if (firstResult) {
                        event.preventDefault();
                        addPageReference(firstResult.dataset.pageId);
                    }
                }
            });
        }

        if (elements.referenceResults) {
            elements.referenceResults.addEventListener('click', (event) => {
                const button = event.target.closest('.agent-reference-result[data-page-id], .agent-reference-open[data-page-id]');
                if (!button) return;

                if (button.classList.contains('agent-reference-open')) {
                    openReferencedPage(button.dataset.pageId);
                    closeReferencePopover();
                    return;
                }

                addPageReference(button.dataset.pageId);
            });

            elements.referenceResults.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                const result = event.target.closest('.agent-reference-result[data-page-id]');
                if (!result) return;

                event.preventDefault();
                addPageReference(result.dataset.pageId);
            });
        }

        if (elements.referenceChips) {
            elements.referenceChips.addEventListener('click', (event) => {
                const removeButton = event.target.closest('.agent-reference-chip-remove[data-page-id]');
                if (removeButton) {
                    removePageReference(removeButton.dataset.pageId);
                    return;
                }

                const openButton = event.target.closest('.agent-reference-chip[data-page-id]');
                if (openButton) {
                    openReferencedPage(openButton.dataset.pageId);
                }
            });
        }

        if (elements.referenceClose) {
            elements.referenceClose.addEventListener('click', () => {
                closeReferencePopover({ focusInput: true });
            });
        }

        if (elements.profilePicker) {
            elements.profilePicker.addEventListener('click', (event) => {
                const button = event.target.closest('.agent-profile-option[data-profile-id]');
                if (!button) return;

                selectAgentProfile(button.dataset.profileId);
            });
        }

        document.addEventListener('keydown', (event) => {
            if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
                event.preventDefault();
                toggleChat();
            }

            // Global Escape key handler
            if (event.key === 'Escape') {
                // Close model selector if open
                if (elements.modelSelectorDropdown?.style.display === 'flex') {
                    event.preventDefault();
                    closeModelSelector();
                    return;
                }
                // Close chat if open
                if (elements.modal?.style.display === 'flex') {
                    if (referencePopoverOpen) {
                        event.preventDefault();
                        closeReferencePopover({ focusInput: true });
                        return;
                    }
                    event.preventDefault();
                    closeChat();
                    return;
                }
            }
        });

        document.addEventListener('click', (event) => {
            if (!elements.modelSelectorDropdown || !elements.modelSelectorBtn) return;

            const clickedInsideDropdown = elements.modelSelectorDropdown.contains(event.target);
            const clickedOnButton = elements.modelSelectorBtn.contains(event.target);

            if (!clickedInsideDropdown && !clickedOnButton) {
                closeModelSelector();
            }
        });

        document.addEventListener('click', (event) => {
            if (!referencePopoverOpen || !elements.referencePanel) return;
            if (!elements.referencePanel.contains(event.target)) {
                closeReferencePopover();
            }
        });

        window.addEventListener('modelChanged', updateModelUI);
        window.addEventListener('notes-agent-profile-changed', () => {
            renderProfilePicker();
            updateModelUI();
            updateContextIndicator();
        });
        window.addEventListener('notes-agent-processing', handleProcessingEvent);
        window.addEventListener('notes-agent-context-changed', handleConversationContextChange);
        document.addEventListener('click', scheduleContextRefresh, true);
        document.addEventListener('keyup', scheduleContextRefresh, true);
    }

    function autoResizeInput() {
        if (!elements.input) return;

        elements.input.style.height = 'auto';
        elements.input.style.height = `${Math.min(elements.input.scrollHeight, 140)}px`;
    }

    function openChat() {
        if (!elements.modal) return;

        document.body.classList.add('agent-chat-open');
        elements.modal.style.display = 'flex';
        elements.modal.setAttribute('aria-hidden', 'false');

        requestAnimationFrame(() => {
            elements.modal.classList.add('active');
            if (elements.modalContent) {
                elements.modalContent.style.opacity = '1';
                elements.modalContent.style.transform = 'scale(1)';
            }
        });

        updateContextIndicator();
        renderReferencePicker();
        renderRequestUnderstanding();
        renderMessages();
        renderComposerDesignOptions();

        if (elements.input) {
            setTimeout(() => elements.input.focus(), 50);
        }
    }

    function closeChat() {
        if (!elements.modal) return;

        document.body.classList.remove('agent-chat-open');
        elements.modal.classList.remove('active');
        elements.modal.setAttribute('aria-hidden', 'true');
        if (elements.modalContent) {
            elements.modalContent.style.opacity = '0';
            elements.modalContent.style.transform = 'scale(0.98)';
        }

        setTimeout(() => {
            if (elements.modal) {
                elements.modal.style.display = 'none';
            }
        }, 180);
    }

    function toggleChat() {
        if (!elements.modal) return;

        const isOpen = elements.modal.style.display === 'flex' || elements.modal.classList.contains('active');
        if (isOpen) {
            closeChat();
        } else {
            openChat();
        }
    }

    async function sendMessage() {
        if (!window.Agent || !elements.input || streamState.active) return;

        const text = elements.input.value.trim();
        if (!text) return;
        const pageReferences = getSelectedPageReferencesForPrompt();
        const referenceSearch = buildReferenceSearchPayload(text, pageReferences);

        elements.input.value = '';
        elements.input.style.height = 'auto';
        selectedPageReferences = [];
        closeReferencePopover({ clearSearch: true });
        renderReferencePicker();

        await runPrompt(text, { pageReferences, referenceSearch });
    }

    async function quickAction(action) {
        if (!window.Agent || streamState.active) return;

        const prompts = {
            summarize: 'Summarize this page.',
            continue: 'Continue writing from the current page content.',
            improve: 'Improve the current writing.',
            explain: 'Explain the current page content.',
            grammar: 'Fix grammar and spelling in the selected text or last paragraph.',
            shorter: 'Make the selected text or last paragraph shorter and more concise.',
            expand: 'Expand on the last paragraph with more details and examples.',
            restructure: 'Restructure this page section by section. Reuse strong blocks, replace weak ones, and improve the block flow.',
            polish_layout: 'Polish this page so it feels designed. Improve the hierarchy, add stronger support blocks where needed, and tighten the section rhythm.',
            layout_catalog: 'Show me 2-3 best-fit indexed design layouts from the Notes layout catalog, then recommend which one to apply to this page.',
            multi_pass: 'Work through this page in multiple passes. First decide the best section structure, then expand each section, then apply the final page edits.',
            section_agents: 'Make a design pass for this page, split the work into heading-based section chunks, assign each chunk to a focused section agent, then apply the finished section edits using section-level notes-actions.',
            brief: 'Turn this page into an executive brief with a clear lead, key takeaways, and next steps.'
        };

        if (action === 'outline') {
            const topic = prompt('What topic should the outline cover?');
            if (!topic) return;
            await runPrompt(`Create an outline for: ${topic}`);
            return;
        }

        const promptText = prompts[action];
        if (!promptText) return;

        await runPrompt(promptText);
    }

    async function runPrompt(promptText, askOptions = {}) {
        if (!window.Agent) return;

        setStreamState({ active: true, content: '', reasoning: '', error: null });

        try {
            const request = window.Agent.ask(promptText, {
                ...askOptions,
                onChunk: (chunk, fullResponse) => {
                    const nextContent = fullResponse || `${streamState.content}${chunk || ''}`;
                    setStreamState({ active: true, content: nextContent, error: null });
                    renderMessages();
                    scrollToBottom();
                },
                onReasoning: (_delta, summary) => {
                    setStreamState({ active: true, reasoning: String(summary || _delta || '').trim(), error: null });
                    renderMessages();
                    scrollToBottom();
                },
                onStreamComplete: () => {
                    setStreamState({ active: false, content: '', reasoning: '', error: null });
                    renderMessages();
                    scrollToBottom();
                },
                onComplete: () => {
                    setStreamState({ active: false, content: '', reasoning: '', error: null });
                    renderMessages();
                    scrollToBottom();
                },
                onError: (error) => {
                    console.error('AgentUI request failed:', error);
                    setStreamState({
                        active: false,
                        content: '',
                        reasoning: '',
                        error: error?.message || 'Something went wrong. Please try again.'
                    });
                    renderMessages();
                    scrollToBottom();
                }
            });

            renderMessages();
            scrollToBottom();
            await request;
        } catch (error) {
            console.error('AgentUI sendMessage error:', error);
            setStreamState({
                active: false,
                content: '',
                reasoning: '',
                error: error?.message || 'Something went wrong. Please try again.'
            });
            renderMessages();
        }
    }

    function normalizeText(value = '') {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeReferenceIcon(value = '', type = REFERENCE_TYPE_PAGE) {
        const fallback = type === REFERENCE_TYPE_CHAT ? REFERENCE_ICON_CHAT : REFERENCE_ICON_PAGE;
        const normalized = normalizeText(value);
        if (!normalized || normalized.toLowerCase() === 'page' || normalized.toLowerCase() === 'chat') {
            return fallback;
        }
        return normalized.length > 2 ? fallback : normalized;
    }

    function getNotesStorage() {
        if (window.NotesStorage?.loadAll) {
            return window.NotesStorage;
        }

        try {
            if (typeof Storage !== 'undefined' && Storage?.loadAll) {
                return Storage;
            }
        } catch (_error) {
            // The browser-native window.Storage object is not the notes database.
        }

        return window.Storage?.loadAll ? window.Storage : null;
    }

    function getCurrentSpaceName(data = null) {
        const notesStorage = getNotesStorage();
        const notesData = data || notesStorage?.loadAll?.() || {};
        const spaceId = notesData.currentSpaceId || 'private';
        const space = Array.isArray(notesData.spaces)
            ? notesData.spaces.find((candidate) => candidate?.id === spaceId)
            : null;
        return space?.name || 'Private';
    }

    function getPageText(page = null) {
        const parts = [];
        const visit = (blocks = []) => {
            blocks.forEach((block) => {
                if (!block) return;
                if (window.NotesQuery?.extractText) {
                    parts.push(window.NotesQuery.extractText(block));
                } else if (typeof block.content === 'string') {
                    parts.push(block.content);
                } else if (block.content && typeof block.content === 'object') {
                    parts.push(block.content.text || block.content.title || block.content.description || block.content.prompt || block.content.result || '');
                }

                if (Array.isArray(block.children) && block.children.length > 0) {
                    visit(block.children);
                }
            });
        };

        visit(page?.blocks || []);
        return normalizeText(parts.join(' '));
    }

    function getPageOutline(page = null) {
        if (window.NotesQuery?.buildIndex) {
            try {
                return window.NotesQuery.buildIndex(page).outline
                    .slice(0, 6)
                    .map((entry) => entry.text)
                    .filter(Boolean);
            } catch (error) {
                console.warn('AgentUI: failed to build reference outline', error);
            }
        }

        return (page?.blocks || [])
            .filter((block) => /^heading_/.test(String(block?.type || '')))
            .map((block) => normalizeText(typeof block.content === 'string' ? block.content : block.content?.text || ''))
            .filter(Boolean)
            .slice(0, 6);
    }

    function getPageProjectLabel(page = null, notesData = null) {
        const notesStorage = getNotesStorage();
        const data = notesData || notesStorage?.loadAll?.() || {};
        const spaceId = page?.spaceId || data.currentSpaceId || 'private';
        const space = Array.isArray(data.spaces)
            ? data.spaces.find((candidate) => candidate?.id === spaceId)
            : null;
        const parent = page?.parentId && Array.isArray(data.pages)
            ? data.pages.find((candidate) => candidate?.id === page.parentId)
            : null;
        const spaceName = space?.name || getCurrentSpaceName(data) || 'Private';
        const parentTitle = parent?.title && parent.title !== page?.title ? parent.title : '';

        return parentTitle ? `${spaceName} / ${parentTitle}` : spaceName;
    }

    function getPageById(pageId = '', notesData = null) {
        const normalizedPageId = String(pageId || '').trim();
        if (!normalizedPageId) return null;

        const currentPage = window.Editor?.getCurrentPage?.();
        if (currentPage?.id === normalizedPageId) {
            return currentPage;
        }

        const notesStorage = getNotesStorage();
        const data = notesData || notesStorage?.loadAll?.() || {};
        if (Array.isArray(data.pages)) {
            const page = data.pages.find((candidate) => candidate?.id === normalizedPageId);
            if (page) return page;
        }

        return notesStorage?.getPage?.(normalizedPageId) || null;
    }

    function collectReferencePages(data = null) {
        const notesStorage = getNotesStorage();
        const notesData = data || notesStorage?.loadAll?.() || {};
        const pageMap = new Map();
        const addPage = (page) => {
            if (page?.id && !pageMap.has(page.id)) {
                pageMap.set(page.id, page);
            }
        };

        if (Array.isArray(notesData.pages)) {
            notesData.pages.forEach(addPage);
        }
        if (notesStorage?.getPages) {
            notesStorage.getPages().forEach(addPage);
        }

        const currentPage = window.Editor?.getCurrentPage?.();
        if (currentPage?.id) {
            pageMap.set(currentPage.id, currentPage);
        }

        return Array.from(pageMap.values());
    }

    function buildPageReferenceRecord(page = null, options = {}) {
        if (!page?.id) return null;

        const notesStorage = getNotesStorage();
        const notesData = options.data || notesStorage?.loadAll?.() || {};
        const currentPage = window.Editor?.getCurrentPage?.();
        const effectivePage = currentPage?.id === page.id ? currentPage : page;
        const text = getPageText(effectivePage);
        const outline = getPageOutline(effectivePage);
        const spaceName = getPageProjectLabel(effectivePage, notesData);
        const title = effectivePage.title || 'Untitled';
        const searchText = normalizeText([
            title,
            effectivePage.icon || '',
            spaceName,
            outline.join(' '),
            text,
        ].join(' '));
        const blockCount = window.NotesQuery?.buildIndex
            ? (() => {
                try {
                    return window.NotesQuery.buildIndex(effectivePage).blockCount || 0;
                } catch (_error) {
                    return Array.isArray(effectivePage.blocks) ? effectivePage.blocks.length : 0;
                }
            })()
            : (Array.isArray(effectivePage.blocks) ? effectivePage.blocks.length : 0);

        return {
            pageId: effectivePage.id,
            title,
            type: REFERENCE_TYPE_PAGE,
            icon: normalizeReferenceIcon(effectivePage.icon, REFERENCE_TYPE_PAGE),
            spaceId: effectivePage.spaceId || notesData.currentSpaceId || 'private',
            spaceName,
            preview: findSnippet(searchText, tokenizeSearch(title), 320) || text.slice(0, 320),
            contentPreview: text.slice(0, 520),
            outline,
            searchText,
            blockCount,
            updatedAt: effectivePage.updatedAt || null,
        };
    }

    function readStoredMessagesForReference(key = '') {
        if (!key) return [];
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_error) {
            return [];
        }
    }

    function getMessageReferenceText(message = null) {
        if (!message || typeof message !== 'object') return '';
        const role = String(message.role || '').trim();
        const content = normalizeText(message.content || message.text || message.message || '');
        const reasoning = normalizeText(message.reasoningSummary || message.reasoning || '');
        return normalizeText([role, content, reasoning].filter(Boolean).join(': '));
    }

    function buildChatReferenceRecord(entry = {}, options = {}) {
        const messages = Array.isArray(entry.messages) ? entry.messages : [];
        const messageText = messages
            .map(getMessageReferenceText)
            .filter(Boolean)
            .join(' ');
        if (!messageText) return null;

        const notesStorage = getNotesStorage();
        const notesData = options.data || notesStorage?.loadAll?.() || {};
        const sourcePageId = String(entry.pageId || '').trim();
        const sourcePage = getPageById(sourcePageId, notesData);
        if (!sourcePageId || !sourcePage) return null;

        const titleBase = sourcePage.title || 'Untitled';
        const spaceName = getPageProjectLabel(sourcePage, notesData);
        const title = `Chat: ${titleBase}`;
        const updatedAt = messages
            .map((message) => Number(message?.timestamp || message?.updatedAt || 0) || 0)
            .sort((left, right) => right - left)[0] || null;
        const searchText = normalizeText([
            title,
            'chat conversation agent messages assistant user',
            spaceName,
            messageText,
        ].join(' '));

        return {
            pageId: `chat:${sourcePageId || 'legacy'}`,
            sourcePageId,
            type: REFERENCE_TYPE_CHAT,
            title,
            icon: REFERENCE_ICON_CHAT,
            spaceId: sourcePage.spaceId || notesData.currentSpaceId || 'private',
            spaceName: `${spaceName} / Chat`,
            preview: findSnippet(searchText, tokenizeSearch(titleBase), 320) || messageText.slice(0, 320),
            contentPreview: messageText.slice(0, 520),
            outline: ['Agent chat history'],
            searchText,
            blockCount: messages.length,
            updatedAt,
        };
    }

    function collectChatReferenceRecords(data = null) {
        const notesStorage = getNotesStorage();
        const notesData = data || notesStorage?.loadAll?.() || {};
        const entries = new Map();

        try {
            for (let index = 0; index < localStorage.length; index += 1) {
                const key = localStorage.key(index);
                if (!key) continue;
                if (key === LEGACY_MESSAGES_STORAGE_KEY) {
                    entries.set('legacy', { pageId: '', messages: readStoredMessagesForReference(key) });
                } else if (key.startsWith(PAGE_MESSAGES_STORAGE_PREFIX)) {
                    const pageId = key.slice(PAGE_MESSAGES_STORAGE_PREFIX.length);
                    entries.set(pageId || 'legacy', { pageId, messages: readStoredMessagesForReference(key) });
                }
            }
        } catch (_error) {
            // Some privacy modes block localStorage enumeration; the current Agent API still covers the open chat.
        }

        const currentPage = window.Editor?.getCurrentPage?.();
        const liveMessages = window.Agent?.getMessages?.();
        const agentState = window.Agent?.state || {};
        const activeConversationId = String(agentState.activePageId || '').trim();
        const sharedSessionId = String(agentState.sharedSessionId || '').trim();
        const liveConversationIsPageScoped = currentPage?.id
            && activeConversationId === currentPage.id
            && (!sharedSessionId || sharedSessionId === currentPage.id);
        if (liveConversationIsPageScoped && Array.isArray(liveMessages) && liveMessages.length) {
            entries.set(currentPage.id, { pageId: currentPage.id, messages: liveMessages });
        }

        if (entries.has('legacy')) {
            const legacyEntry = entries.get('legacy');
            if (currentPage?.id && !entries.has(currentPage.id)) {
                entries.set(currentPage.id, { pageId: currentPage.id, messages: legacyEntry.messages });
            }
            entries.delete('legacy');
        }

        return Array.from(entries.values())
            .map((entry) => buildChatReferenceRecord(entry, { data: notesData }))
            .filter(Boolean);
    }

    function mergeChatRecordsIntoPages(pageRecords = [], chatRecords = []) {
        const pageRecordMap = new Map(pageRecords.map((record) => [record.pageId, record]));
        const merged = pageRecords.map((record) => ({ ...record }));
        const mergedMap = new Map(merged.map((record) => [record.pageId, record]));
        const standaloneChats = [];

        chatRecords.forEach((chatRecord) => {
            const sourcePageId = String(chatRecord.sourcePageId || '').trim();
            const pageRecord = sourcePageId ? mergedMap.get(sourcePageId) : null;

            if (!pageRecord) {
                standaloneChats.push(chatRecord);
                return;
            }

            pageRecord.hasChat = true;
            pageRecord.chatPageId = chatRecord.pageId;
            pageRecord.chatSourcePageId = sourcePageId;
            pageRecord.chatPreview = chatRecord.preview || '';
            pageRecord.chatContentPreview = chatRecord.contentPreview || '';
            pageRecord.chatMessageCount = chatRecord.blockCount || 0;
            pageRecord.chatUpdatedAt = chatRecord.updatedAt || null;
            pageRecord.chatOutline = chatRecord.outline || [];
            pageRecord.searchText = normalizeText([
                pageRecord.searchText,
                'attached chat agent conversation messages',
                chatRecord.searchText,
            ].join(' '));
            pageRecord.contentPreview = normalizeText([
                pageRecord.contentPreview,
                chatRecord.contentPreview ? `Chat: ${chatRecord.contentPreview}` : '',
            ].join(' ')).slice(0, 760);

            if (!pageRecord.preview && chatRecord.preview) {
                pageRecord.preview = chatRecord.preview;
            }

            if (chatRecord.updatedAt && (!pageRecord.updatedAt || String(chatRecord.updatedAt).localeCompare(String(pageRecord.updatedAt)) > 0)) {
                pageRecord.updatedAt = chatRecord.updatedAt;
            }
        });

        return [
            ...merged.filter((record) => pageRecordMap.has(record.pageId)),
            ...standaloneChats,
        ];
    }

    function getAllReferenceRecords() {
        const notesStorage = getNotesStorage();
        const data = notesStorage?.loadAll?.() || {};
        const pageRecords = collectReferencePages(data)
            .map((page) => buildPageReferenceRecord(page, { data }))
            .filter(Boolean);
        return mergeChatRecordsIntoPages(pageRecords, collectChatReferenceRecords(data));
    }

    function tokenizeSearch(value = '') {
        const stopWords = new Set([
            'about', 'after', 'again', 'also', 'and', 'are', 'but', 'can', 'could', 'does',
            'for', 'from', 'have', 'help', 'how', 'into', 'make', 'need', 'notes', 'page',
            'pages', 'that', 'the', 'this', 'what', 'when', 'where', 'with', 'would', 'you',
        ]);
        return normalizeText(value)
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, ' ')
            .split(/\s+/)
            .filter((word) => word.length >= 2 && !stopWords.has(word))
            .slice(0, 12);
    }

    function scoreReferenceRecord(record, terms = []) {
        const title = normalizeText(record.title).toLowerCase();
        const spaceName = normalizeText(record.spaceName).toLowerCase();
        const outline = normalizeText((record.outline || []).join(' ')).toLowerCase();
        const haystack = normalizeText(record.searchText || `${title} ${spaceName} ${outline} ${record.preview || ''}`).toLowerCase();
        if (terms.length === 0) {
            return record.pageId === window.Editor?.getCurrentPage?.()?.id ? 20 : 1;
        }

        return terms.reduce((score, term) => {
            if (!term) return score;
            if (title === term) return score + 30;
            if (title.startsWith(term)) return score + 18;
            if (title.includes(term)) return score + 12;
            if (spaceName.includes(term)) return score + 8;
            if (outline.includes(term)) return score + 6;
            if (haystack.includes(term)) return score + 2;
            return score;
        }, 0);
    }

    function findSnippet(text = '', terms = [], limit = 220) {
        const source = normalizeText(text);
        if (!source) return '';
        const lower = source.toLowerCase();
        const firstIndex = terms
            .map((term) => lower.indexOf(term))
            .filter((index) => index >= 0)
            .sort((left, right) => left - right)[0];
        const start = firstIndex >= 0 ? Math.max(0, firstIndex - 70) : 0;
        const snippet = source.slice(start, start + limit).trim();
        return `${start > 0 ? '...' : ''}${snippet}${start + limit < source.length ? '...' : ''}`;
    }

    function searchReferenceRecords(query = '', options = {}) {
        const terms = tokenizeSearch(query);
        const records = getAllReferenceRecords();
        const selectedIds = new Set(selectedPageReferences.map((reference) => reference.pageId));
        const includeSelected = options.includeSelected !== false;

        return records
            .map((record) => ({
                ...record,
                score: scoreReferenceRecord(record, terms),
                matchedPreview: terms.length > 0
                    ? findSnippet(record.searchText || record.contentPreview || record.preview || '', terms, 360)
                    : (record.contentPreview || record.preview || ''),
            }))
            .filter((record) => includeSelected || !selectedIds.has(record.pageId))
            .filter((record) => terms.length === 0 || record.score > 0)
            .sort((left, right) => right.score - left.score || String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
            .slice(0, options.limit || MAX_REFERENCE_RESULTS);
    }

    function buildReferenceSearchPayload(promptText = '', pageReferences = []) {
        const terms = tokenizeSearch(promptText);
        const selectedIds = new Set((pageReferences || []).map((reference) => reference.pageId));
        const hits = getAllReferenceRecords()
            .map((record) => {
                const score = selectedIds.has(record.pageId)
                    ? scoreReferenceRecord(record, terms) + 6
                    : scoreReferenceRecord(record, terms);

                return {
                    pageId: record.pageId,
                    sourcePageId: record.sourcePageId || '',
                    type: record.type || REFERENCE_TYPE_PAGE,
                    hasChat: Boolean(record.hasChat),
                    chatPageId: record.chatPageId || '',
                    chatSourcePageId: record.chatSourcePageId || '',
                    chatSnippet: record.chatPreview || '',
                    chatMessageCount: record.chatMessageCount || 0,
                    title: record.title,
                    icon: record.icon,
                    spaceName: record.spaceName,
                    outline: record.outline,
                    snippet: findSnippet(record.searchText || record.contentPreview || record.preview || '', terms, 360),
                    score,
                    selected: selectedIds.has(record.pageId),
                };
            })
            .filter((hit) => hit && (terms.length === 0 ? hit.selected : hit.score > 0))
            .sort((left, right) => right.score - left.score)
            .slice(0, MAX_REFERENCE_SEARCH_HITS);

        return {
            query: terms.join(' '),
            policy: 'snippet_search_only',
            hits,
        };
    }

    function renderReferencePicker() {
        if (!elements.referencePanel) return;

        renderReferenceChips();
        renderReferenceResults();
        if (elements.referenceBtn) {
            elements.referenceBtn.setAttribute('aria-expanded', String(referencePopoverOpen));
        }
        if (elements.referencePopover) {
            elements.referencePopover.hidden = !referencePopoverOpen;
        }
        if (elements.inputArea) {
            elements.inputArea.classList.toggle('is-reference-open', referencePopoverOpen);
        }
    }

    function renderReferenceChips() {
        if (!elements.referenceChips) return;

        if (selectedPageReferences.length === 0) {
            elements.referenceChips.innerHTML = '';
            return;
        }

        elements.referenceChips.innerHTML = selectedPageReferences.map((reference) => `
            <span class="agent-reference-chip" data-page-id="${escapeHtmlAttr(reference.pageId)}" title="${escapeHtmlAttr(reference.title)}">
                <span class="agent-reference-chip-icon">${escapeHtml(normalizeReferenceIcon(reference.icon, reference.type))}</span>
                <span class="agent-reference-chip-title">${escapeHtml(reference.title || 'Untitled')}</span>
                <button
                    type="button"
                    class="agent-reference-chip-remove"
                    data-page-id="${escapeHtmlAttr(reference.pageId)}"
                    aria-label="Remove ${escapeHtmlAttr(reference.title || 'page')} reference"
                >x</button>
            </span>
        `).join('');
    }

    function renderReferenceResults() {
        if (!elements.referenceResults) return;

        const results = searchReferenceRecords(referenceSearchQuery, {
            includeSelected: false,
            limit: MAX_REFERENCE_RESULTS,
        });

        if (selectedPageReferences.length >= MAX_SELECTED_REFERENCES) {
            elements.referenceResults.innerHTML = '<div class="agent-reference-empty">Reference limit reached</div>';
            return;
        }

        if (results.length === 0) {
            elements.referenceResults.innerHTML = '<div class="agent-reference-empty">No matching pages or chats</div>';
            return;
        }

        elements.referenceResults.innerHTML = results.map((record) => {
            const isChat = record.type === REFERENCE_TYPE_CHAT;
            const typeLabel = isChat ? 'Chat' : 'Page';
            const countLabel = isChat
                ? `${record.blockCount || 0} messages`
                : `${record.blockCount || 0} blocks${record.hasChat ? ` + ${record.chatMessageCount || 0} chat messages` : ''}`;
            const openLabel = isChat ? 'Open page' : 'Open';
            const chatLabel = !isChat && record.hasChat
                ? '<span class="agent-reference-result-badge">Chat context</span>'
                : '';
            return `
            <div class="agent-reference-result" data-page-id="${escapeHtmlAttr(record.pageId)}" role="button" tabindex="0">
                <span class="agent-reference-result-icon">${escapeHtml(normalizeReferenceIcon(record.icon, record.type))}</span>
                <span class="agent-reference-result-body">
                    <span class="agent-reference-result-title">${escapeHtml(record.title || 'Untitled')}${chatLabel}</span>
                    <span class="agent-reference-result-meta">${escapeHtml(record.spaceName || 'Private')} - ${typeLabel} - ${countLabel}${record.outline?.length ? ` - ${escapeHtml(record.outline.slice(0, 2).join(' / '))}` : ''}</span>
                    <span class="agent-reference-result-preview">${escapeHtml(record.matchedPreview || record.preview || 'No text content yet')}</span>
                </span>
                <button type="button" class="agent-reference-open" data-page-id="${escapeHtmlAttr(record.pageId)}" title="${escapeHtmlAttr(openLabel)}">${escapeHtml(openLabel)}</button>
            </div>
        `;
        }).join('');
    }

    function toggleReferencePopover() {
        if (referencePopoverOpen) {
            closeReferencePopover();
            return;
        }

        referencePopoverOpen = true;
        renderReferencePicker();
        setTimeout(() => elements.referenceSearch?.focus(), 0);
    }

    function closeReferencePopover(options = {}) {
        const { clearSearch = true, focusInput = false } = options;
        referencePopoverOpen = false;
        if (clearSearch) {
            referenceSearchQuery = '';
            if (elements.referenceSearch) {
                elements.referenceSearch.value = '';
            }
        }
        renderReferencePicker();
        if (focusInput) {
            setTimeout(() => elements.input?.focus(), 0);
        }
    }

    function addPageReference(pageId = '') {
        const normalizedPageId = String(pageId || '').trim();
        if (!normalizedPageId || selectedPageReferences.some((reference) => reference.pageId === normalizedPageId)) return;
        if (selectedPageReferences.length >= MAX_SELECTED_REFERENCES) return;

        const reference = getAllReferenceRecords().find((record) => record.pageId === normalizedPageId)
            || buildPageReferenceRecord(getPageById(normalizedPageId));
        if (!reference) return;

        selectedPageReferences = [...selectedPageReferences, reference];
        closeReferencePopover({ clearSearch: true, focusInput: true });
    }

    function removePageReference(pageId = '') {
        selectedPageReferences = selectedPageReferences.filter((reference) => reference.pageId !== pageId);
        renderReferencePicker();
    }

    function getSelectedPageReferencesForPrompt() {
        return selectedPageReferences.map((reference) => ({
            pageId: reference.pageId,
            sourcePageId: reference.sourcePageId || '',
            type: reference.type || REFERENCE_TYPE_PAGE,
            chatPageId: reference.chatPageId || '',
            chatSourcePageId: reference.chatSourcePageId || '',
            chatPreview: reference.chatPreview || '',
            chatMessageCount: reference.chatMessageCount || 0,
            hasChat: Boolean(reference.hasChat),
            title: reference.title,
            icon: normalizeReferenceIcon(reference.icon, reference.type),
            spaceId: reference.spaceId,
            spaceName: reference.spaceName,
            preview: reference.preview,
            outline: reference.outline,
            blockCount: reference.blockCount,
            updatedAt: reference.updatedAt,
        }));
    }

    function openReferencedPage(pageId = '') {
        const normalizedPageId = String(pageId || '').trim();
        if (!normalizedPageId) return;
        const record = selectedPageReferences.find((reference) => reference.pageId === normalizedPageId)
            || getAllReferenceRecords().find((reference) => reference.pageId === normalizedPageId);
        const targetPageId = record?.sourcePageId || (normalizedPageId.startsWith('chat:') ? normalizedPageId.slice(5) : normalizedPageId);
        if (targetPageId && targetPageId !== 'legacy') {
            window.Sidebar?.loadPage?.(targetPageId);
        }
    }

    async function openWithPrompt(promptText, options = {}) {
        const {
            send = false,
            hiddenUserMessage = false,
            hiddenAssistantMessage = false
        } = options;

        openChat();
        if (!elements.input) return;

        if (send && promptText) {
            elements.input.value = '';
            autoResizeInput();
            await runPrompt(promptText, {
                hiddenUserMessage,
                hiddenAssistantMessage
            });
            return;
        }

        elements.input.value = promptText || '';
        autoResizeInput();

        setTimeout(() => {
            elements.input?.focus();
        }, 0);
    }

    function scheduleContextRefresh() {
        window.requestAnimationFrame(() => {
            updateContextIndicator();
            renderRequestUnderstanding();
            renderComposerDesignOptions();
        });
    }

    function updateContextIndicator() {
        if (!elements.contextIndicator || !window.Agent?.getPageContext) return;

        const pageContext = window.Agent.getPageContext();
        if (!pageContext) {
            elements.contextIndicator.textContent = 'No page loaded';
            return;
        }

        const selectedBlockId = window.Selection?.getSelectedBlockId?.();
        const selectedLabel = selectedBlockId ? `, selected ${selectedBlockId}` : '';
        const profile = window.Agent.getSelectedAgentProfile?.();
        const profileLabel = profile?.shortName ? ` - ${profile.shortName}` : '';
        elements.contextIndicator.textContent = `${pageContext.title || 'Untitled'} - ${pageContext.blockCount} blocks${selectedLabel}${profileLabel}`;
    }

    function renderProfilePicker() {
        if (!elements.profilePicker || !window.Agent?.getAgentProfiles) return;

        const profiles = window.Agent.getAgentProfiles();
        const selectedProfile = window.Agent.getSelectedAgentProfile?.() || profiles[0];

        elements.profilePicker.innerHTML = profiles.map((profile) => {
            const selected = profile.id === selectedProfile?.id;
            return `
                <button
                    type="button"
                    class="agent-profile-option${selected ? ' is-selected' : ''}"
                    data-profile-id="${escapeHtmlAttr(profile.id)}"
                    title="${escapeHtmlAttr(profile.bestFor || profile.tagline || '')}"
                    aria-pressed="${selected}"
                >
                    <span class="agent-profile-initials">${escapeHtml(profile.initials || profile.shortName || 'AI')}</span>
                    <span class="agent-profile-copy">
                        <strong>${escapeHtml(profile.shortName || profile.name)}</strong>
                        <small>${escapeHtml(profile.tagline || '')}</small>
                    </span>
                </button>
            `;
        }).join('');
    }

    function selectAgentProfile(profileId) {
        if (!window.Agent?.setSelectedAgentProfile(profileId)) {
            showToast('Failed to change AI buddy', 'error');
            return;
        }

        const profile = window.Agent.getSelectedAgentProfile?.();
        renderProfilePicker();
        updateModelUI();
        updateContextIndicator();
        renderRequestUnderstanding();
        renderComposerDesignOptions();
        showToast(`AI buddy changed to ${profile?.name || 'selected profile'}`, 'success');
    }

    function setStreamState(nextState) {
        streamState = {
            ...streamState,
            ...nextState
        };

        syncProcessingUI();
    }

    function renderStarterButtons() {
        return STARTER_ACTIONS.map((action) => `
            <button class="agent-quick-action-btn" data-action="${escapeHtmlAttr(action.id)}" title="${escapeHtmlAttr(action.title)}">
                ${escapeHtml(action.label)}
            </button>
        `).join('');
    }

    function getDraftUnderstanding() {
        if (!window.Agent?.getRequestUnderstanding) {
            return null;
        }

        const draftPrompt = elements.input?.value?.trim() || '';
        if (!draftPrompt) {
            return null;
        }

        try {
            return window.Agent.getRequestUnderstanding(draftPrompt, window.Agent.getPageContext?.() || null, {});
        } catch (error) {
            console.warn('AgentUI: failed to classify draft request', error);
            return null;
        }
    }

    function renderRequestUnderstanding() {
        if (!elements.understandingCard) return;

        const understanding = getDraftUnderstanding();
        if (!understanding) {
            elements.understandingCard.hidden = true;
            elements.understandingCard.innerHTML = '';
            return;
        }

        const confidence = Math.round((understanding.confidence || 0) * 100);
        const template = understanding.template?.name || 'General notes';
        const layout = understanding.layout?.name
            ? `#${understanding.layout.index} ${understanding.layout.name}`
            : 'Adaptive layout';
        const scheme = understanding.designScheme?.name || 'Current page scheme';
        const reasoning = Array.isArray(understanding.pageReasoningModes) && understanding.pageReasoningModes.length
            ? understanding.pageReasoningModes.map((mode) => mode.replace(/_/g, ' ')).join(', ')
            : 'General page context';

        elements.understandingCard.hidden = false;
        elements.understandingCard.innerHTML = `
            <div class="agent-understanding-topline">
                <span class="agent-understanding-kicker">Symphony read</span>
                <strong>${escapeHtml(understanding.label || 'Page-aware answer')}</strong>
                <span class="agent-understanding-confidence">${confidence}%</span>
            </div>
            <div class="agent-understanding-grid">
                <span>Template</span><b>${escapeHtml(template)}</b>
                <span>Layout</span><b>${escapeHtml(layout)}</b>
                <span>Design</span><b>${escapeHtml(scheme)}</b>
                <span>Reasoning</span><b>${escapeHtml(reasoning)}</b>
            </div>
            <p>${escapeHtml(understanding.strategy || '')}</p>
        `;
    }

    function getLiveDesignOptions(limit = 4) {
        if (!window.Agent?.getBlockDesignOptions) {
            return [];
        }

        const draftPrompt = elements.input?.value?.trim() || '';
        try {
            return window.Agent.getBlockDesignOptions(draftPrompt, null, { limit });
        } catch (error) {
            console.warn('AgentUI: failed to get live block design options', error);
            return [];
        }
    }

    function renderLiveDesignOptionButtons() {
        const options = getLiveDesignOptions();
        const layouts = getIndexedLayouts(4);
        if (!options.length) {
            return renderIndexedLayoutButtons(layouts);
        }

        return `
            <div class="agent-live-design-options">
                <p class="agent-empty-hint">Live design options</p>
                <div class="agent-quick-actions">
                    ${options.map((option) => `
                        <button
                            class="agent-quick-action-btn agent-design-option-btn"
                            data-prompt="${escapeHtmlAttr(option.prompt || '')}"
                            title="${escapeHtmlAttr(option.description || option.title || '')}"
                        >
                            ${escapeHtml(option.label || option.title || 'Pattern')}
                        </button>
                    `).join('')}
                </div>
            </div>
            ${renderIndexedLayoutButtons(layouts)}
        `;
    }

    function getIndexedLayouts(limit = 4) {
        try {
            return window.NotesLayoutCatalog?.getPageLayouts?.().slice(0, limit) || [];
        } catch (error) {
            console.warn('AgentUI: failed to read layout catalog', error);
            return [];
        }
    }

    function renderIndexedLayoutButtons(layouts = []) {
        if (!layouts.length) {
            return '';
        }

        return `
            <div class="agent-layout-library">
                <div class="agent-layout-library-header">
                    <span>Indexed layouts</span>
                    <small>Pick a starting structure</small>
                </div>
                <div class="agent-layout-grid">
                    ${layouts.map((layout) => `
                        <button
                            type="button"
                            class="agent-layout-card agent-design-option-btn"
                            data-prompt="${escapeHtmlAttr(layout.prompt || '')}"
                            title="${escapeHtmlAttr(layout.bestFor || '')}"
                        >
                            <span class="agent-layout-index">${layout.index}</span>
                            <span class="agent-layout-copy">
                                <strong>${escapeHtml(layout.name)}</strong>
                                <small>${escapeHtml(layout.bestFor)}</small>
                            </span>
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
    }

    function applyDesignOptionPrompt(promptText = '') {
        if (!elements.input || !promptText) {
            return;
        }

        const current = elements.input.value.trim();
        if (current.includes(promptText)) {
            renderComposerDesignOptions();
            elements.input.focus();
            return;
        }

        elements.input.value = current
            ? `${current}\n\n${promptText}`
            : promptText;
        autoResizeInput();
        renderComposerDesignOptions();
        renderRequestUnderstanding();

        if (!streamState.active && !streamState.error && getVisibleMessages().length === 0) {
            renderMessages();
        }

        elements.input.focus();
    }

    function bindEmptyStateActions() {
        elements.messagesContainer.querySelectorAll('.agent-quick-action-btn[data-action]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                quickAction(action);
            });
        });

        elements.messagesContainer.querySelectorAll('.agent-design-option-btn[data-prompt]').forEach((btn) => {
            btn.addEventListener('click', () => {
                applyDesignOptionPrompt(btn.dataset.prompt || '');
            });
        });
    }

    function getVisibleMessages() {
        return (window.Agent?.getMessages?.() || []).filter((message) => !message.hidden);
    }

    function shouldShowComposerDesignOptions(options = []) {
        if (!window.Agent?.getPageContext?.() || !options.length) {
            return false;
        }

        const hasDraft = Boolean(elements.input?.value?.trim());
        const hasConversation = getVisibleMessages().length > 0 || streamState.active || Boolean(streamState.error);
        return hasDraft || hasConversation;
    }

    function renderComposerDesignOptions() {
        if (!elements.composerDesignTray) return;

        const options = getLiveDesignOptions(3);
        const shouldShow = shouldShowComposerDesignOptions(options);
        elements.composerDesignTray.hidden = !shouldShow;

        if (!shouldShow) {
            elements.composerDesignTray.innerHTML = '';
            return;
        }

        const draftPrompt = elements.input?.value?.trim() || '';
        elements.composerDesignTray.innerHTML = `
            <div class="agent-composer-design-meta">
                <span class="agent-composer-design-label">Block patterns</span>
                <span class="agent-composer-design-hint">Add a reusable layout cue to the draft</span>
            </div>
            <div class="agent-composer-design-options">
                ${options.map((option) => {
                    const optionPrompt = option.prompt || '';
                    const isSelected = Boolean(optionPrompt) && draftPrompt.includes(optionPrompt);

                    return `
                        <button
                            type="button"
                            class="agent-composer-design-btn${isSelected ? ' is-selected' : ''}"
                            data-prompt="${escapeHtmlAttr(optionPrompt)}"
                            title="${escapeHtmlAttr(option.description || option.title || '')}"
                            aria-pressed="${isSelected}"
                        >
                            ${escapeHtml(option.label || option.title || 'Pattern')}
                        </button>
                    `;
                }).join('')}
            </div>
        `;
    }

    function renderMessages() {
        if (!elements.messagesContainer || !window.Agent) return;

        const messages = getVisibleMessages();
        elements.messagesContainer.innerHTML = '';

        if (messages.length === 0 && !streamState.active && !streamState.error) {
            elements.messagesContainer.innerHTML = `
                <div class="agent-empty-state">
                    <div class="agent-empty-icon">AI</div>
                    <p>Ask me anything about your notes</p>
                    <p class="agent-empty-hint">I can plan the page, work section by section, pick live block patterns, polish the layout, or turn rough notes into a stronger block flow.</p>
                    <div class="agent-quick-actions">
                        ${renderStarterButtons()}
                    </div>
                    ${renderLiveDesignOptionButtons()}
                </div>
            `;

            bindEmptyStateActions();
            renderComposerDesignOptions();
            return;
        }

        messages.forEach((message) => {
            const renderedMessage = renderMessage(message);
            if (renderedMessage) {
                elements.messagesContainer.appendChild(renderedMessage);
            }
        });

        if (streamState.active) {
            elements.messagesContainer.appendChild(renderStreamingMessage(streamState.content, streamState.reasoning));
        }

        if (streamState.error) {
            elements.messagesContainer.appendChild(renderMessage({
                role: 'assistant',
                content: `**Error:** ${streamState.error}`,
                timestamp: Date.now(),
                transient: true
            }));
        }

        scrollToBottom();
        renderComposerDesignOptions();
    }

    function renderStreamingMessage(content, reasoning = '') {
        const message = renderMessage({
            role: 'assistant',
            content: content || '...',
            timestamp: Date.now(),
            reasoningSummary: reasoning || '',
            reasoningLive: Boolean(reasoning)
        });

        message.classList.add('agent-message-streaming');
        return message;
    }

    function renderMessage(message) {
        const isUser = message.role === 'user';
        const displayContent = normalizeMessageContentForDisplay(message);
        const reasoningSummary = !isUser ? extractReasoningSummary(message) : '';
        const requestUnderstanding = !isUser ? extractRequestUnderstanding(message) : null;
        const pageReferences = extractPageReferences(message);

        if (!displayContent && !reasoningSummary && !requestUnderstanding && pageReferences.length === 0) {
            return null;
        }

        const div = document.createElement('div');
        div.className = `agent-message agent-message-${isUser ? 'user' : 'agent'}`;

        const avatar = isUser ? 'You' : 'AI';
        const timestamp = message.timestamp
            ? new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '';

        const reasoningMarkup = reasoningSummary ? `
            <details class="agent-reasoning-card" ${message.reasoningLive ? 'open' : ''}>
                <summary>
                    <span class="agent-reasoning-title">Reasoning</span>
                    <span class="agent-reasoning-preview">${escapeHtml(truncateText(reasoningSummary.replace(/\s+/g, ' '), 96))}</span>
                </summary>
                <div class="agent-reasoning-body">${escapeHtml(reasoningSummary).replace(/\n/g, '<br>')}</div>
            </details>
        ` : '';
        const understandingMarkup = requestUnderstanding ? `
            <div class="agent-understanding-chipset" title="${escapeHtmlAttr(requestUnderstanding.strategy || '')}">
                <span>${escapeHtml(requestUnderstanding.label || 'Symphony read')}</span>
                ${requestUnderstanding.template?.name ? `<span>${escapeHtml(requestUnderstanding.template.name)}</span>` : ''}
                ${requestUnderstanding.layout?.name ? `<span>#${escapeHtml(requestUnderstanding.layout.index)} ${escapeHtml(requestUnderstanding.layout.name)}</span>` : ''}
            </div>
        ` : '';
        const pageReferenceMarkup = renderMessagePageReferences(pageReferences);

        div.innerHTML = `
            <div class="agent-message-avatar">${avatar}</div>
            <div class="agent-message-content">
                ${understandingMarkup}
                ${reasoningMarkup}
                ${pageReferenceMarkup}
                ${displayContent ? `<div class="agent-message-text">${markdownToHtml(displayContent)}</div>` : ''}
                ${timestamp ? `<div class="agent-message-time">${timestamp}</div>` : ''}
            </div>
        `;

        div.querySelectorAll('.agent-message-reference-link[data-page-id]').forEach((button) => {
            button.addEventListener('click', () => openReferencedPage(button.dataset.pageId));
        });

        return div;
    }

    function normalizeMessageContentForDisplay(message = {}) {
        const source = String(message.content || '');
        const cleaned = stripDisplayOnlyToolMarkup(source).trim();

        if (!cleaned || isDisplayOnlyPlaceholder(cleaned) || looksLikeDisplayOnlyScaffold(cleaned)) {
            return '';
        }

        if (!message._displayNormalized && window.Agent?._extractNotesActionPlan) {
            try {
                const parsed = window.Agent._extractNotesActionPlan(cleaned);
                const parsedText = stripDisplayOnlyToolMarkup(parsed?.displayText || '').trim();
                if (parsed?.actions?.length || parsedText !== cleaned) {
                    return isDisplayOnlyPlaceholder(parsedText) || looksLikeDisplayOnlyScaffold(parsedText)
                        ? ''
                        : parsedText;
                }
            } catch (error) {
                console.warn('AgentUI: failed to normalize assistant message display:', error);
            }
        }

        return cleaned;
    }

    function stripDisplayOnlyToolMarkup(text = '') {
        let value = String(text || '').replace(/\u0000/g, '');
        if (!value) return '';

        value = value
            .replace(/<\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?tool_calls(?:\s*[|｜])?\s*>[\s\S]*?<\s*\/\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?tool_calls(?:\s*[|｜])?\s*>/gi, '')
            .replace(/<\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?tool_calls(?:\s*[|｜])?\s*>[\s\S]*$/i, '')
            .replace(/<\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?invoke\b[^>]*>[\s\S]*?<\s*\/\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?invoke(?:\s*[|｜])?\s*>/gi, '')
            .replace(/<\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?parameter\b[^>]*>[\s\S]*?<\s*\/\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?parameter(?:\s*[|｜])?\s*>/gi, '')
            .replace(/<\s*\/?\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?(?:tool_calls|invoke|parameter)(?:\b[^>]*)?>/gi, '');

        value = value
            .replace(/<\s*dsml[_-]?tool[_-]?calls\b[^>]*>[\s\S]*?<\s*\/\s*dsml[_-]?tool[_-]?calls\s*>/gi, '')
            .replace(/<\s*dsml[_-]?tool[_-]?calls\b[^>]*>[\s\S]*$/i, '')
            .replace(/<\s*dsml[_-]?invoke\b[^>]*>[\s\S]*?<\s*\/\s*dsml[_-]?invoke\s*>/gi, '')
            .replace(/<\s*dsml[_-]?parameter\b[^>]*>[\s\S]*?<\s*\/\s*dsml[_-]?parameter\s*>/gi, '')
            .replace(/<\s*\/?\s*dsml[_-]?(?:tool[_-]?calls|invoke|parameter)\b[^>]*>/gi, '');

        return value.trim();
    }

    function isDisplayOnlyPlaceholder(text = '') {
        const normalized = String(text || '').trim().toLowerCase();
        return /^<\s*assistant(?:\s+reply)?\s*\/?>$/i.test(normalized)
            || normalized === 'assistant reply'
            || normalized === 'assistant_reply';
    }

    function looksLikeDisplayOnlyScaffold(text = '') {
        const normalized = String(text || '').trim().toLowerCase();
        if (!normalized) return false;

        return (normalized.includes('original request:') && normalized.includes('approved page plan:'))
            || normalized.includes('interpret "page" as the current notes page shown in this editor')
            || normalized.includes('return notes-actions that apply the content to the current notes page')
            || normalized.includes('hidden planning pass for a substantial notes-writing request')
            || normalized.includes('hidden section-expansion pass for a substantial notes-writing request');
    }

    function extractReasoningSummary(message = {}) {
        return String(
            message.reasoningSummary
            || message.reasoning_summary
            || message.reasoning
            || message.assistantMetadata?.reasoningSummary
            || message.assistant_metadata?.reasoningSummary
            || message.metadata?.reasoningSummary
            || ''
        ).trim();
    }

    function extractRequestUnderstanding(message = {}) {
        const value = message.requestUnderstanding
            || message.request_understanding
            || message.assistantMetadata?.requestUnderstanding
            || message.assistant_metadata?.requestUnderstanding
            || message.metadata?.requestUnderstanding
            || null;

        return value && typeof value === 'object' ? value : null;
    }

    function extractPageReferences(message = {}) {
        const value = message.pageReferences
            || message.page_references
            || message.assistantMetadata?.pageReferences
            || message.assistant_metadata?.pageReferences
            || message.metadata?.pageReferences
            || [];

        if (!Array.isArray(value)) return [];

        const seen = new Set();
        return value
            .map((reference) => {
                if (!reference || typeof reference !== 'object') return null;
                const pageId = String(reference.pageId || reference.id || '').trim();
                if (!pageId || seen.has(pageId)) return null;
                seen.add(pageId);
                return {
                    pageId,
                    title: String(reference.title || 'Untitled').trim() || 'Untitled',
                    sourcePageId: String(reference.sourcePageId || '').trim(),
                    type: reference.type === REFERENCE_TYPE_CHAT ? REFERENCE_TYPE_CHAT : REFERENCE_TYPE_PAGE,
                    icon: normalizeReferenceIcon(reference.icon, reference.type),
                    spaceName: String(reference.spaceName || 'Private').trim() || 'Private',
                };
            })
            .filter(Boolean)
            .slice(0, MAX_SELECTED_REFERENCES);
    }

    function renderMessagePageReferences(pageReferences = []) {
        if (!pageReferences.length) return '';

        return `
            <div class="agent-message-references" aria-label="Referenced notes pages and chats">
                ${pageReferences.map((reference) => `
                    <button
                        type="button"
                        class="agent-message-reference-link"
                        data-page-id="${escapeHtmlAttr(reference.pageId)}"
                        title="${escapeHtmlAttr(`Open ${reference.title}`)}"
                    >
                        <span>${escapeHtml(normalizeReferenceIcon(reference.icon, reference.type))}</span>
                        <span>${escapeHtml(reference.title || 'Untitled')}</span>
                    </button>
                `).join('')}
            </div>
        `;
    }

    function truncateText(value = '', maxLength = 96) {
        const normalized = String(value || '').trim();
        if (normalized.length <= maxLength) {
            return normalized;
        }
        return `${normalized.slice(0, Math.max(24, maxLength - 1)).trimEnd()}...`;
    }

    function scrollToBottom() {
        if (!elements.messagesContainer) return;
        elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
    }

    function showTypingIndicator() {
        setStreamState({ active: true, content: '', error: null });
        renderMessages();
    }

    function hideTypingIndicator() {
        setStreamState({ active: false, content: '', error: null });
        renderMessages();
    }

    function handleProcessingEvent(event) {
        agentProcessing = Boolean(event?.detail?.isProcessing);
        syncProcessingUI();
    }

    function handleConversationContextChange() {
        updateContextIndicator();
        renderRequestUnderstanding();
        renderMessages();
        renderComposerDesignOptions();
    }

    function syncProcessingUI() {
        const processing = agentProcessing || streamState.active;

        if (processing) {
            startProcessingTicker();
        } else {
            stopProcessingTicker();
        }
    }

    function startProcessingTicker() {
        applyProcessingFrame(true);

        if (processingTicker) return;

        processingTicker = window.setInterval(() => {
            processingFrame = (processingFrame + 1) % PROCESSING_STATES.length;
            applyProcessingFrame(true);
        }, 1600);
    }

    function stopProcessingTicker() {
        if (processingTicker) {
            window.clearInterval(processingTicker);
            processingTicker = null;
        }

        processingFrame = 0;
        applyProcessingFrame(false);
    }

    function applyProcessingFrame(processing) {
        const frame = PROCESSING_STATES[processingFrame] || PROCESSING_STATES[0];

        if (elements.agentStatus) {
            elements.agentStatus.classList.toggle('processing', processing);
            elements.agentStatus.dataset.motion = processing ? frame.motion : 'idle';
            elements.agentStatus.style.setProperty('--agent-phase', String(processingFrame));
        }

        if (elements.agentStatusText) {
            elements.agentStatusText.textContent = processing ? frame.hint : 'AI Ready on this page';
        }

        if (elements.widgetBtn) {
            elements.widgetBtn.classList.toggle('processing', processing);
            elements.widgetBtn.dataset.motion = processing ? frame.motion : 'idle';
            elements.widgetBtn.style.setProperty('--agent-phase', String(processingFrame));
        }

        if (elements.widgetLabel) {
            elements.widgetLabel.textContent = processing ? frame.label : 'Ask AI';
        }

        if (elements.widgetMotionText) {
            elements.widgetMotionText.textContent = processing ? frame.hint : 'Ready to work this page';
        }
    }

    function clearChat() {
        if (!window.Agent) return;

        setStreamState({ active: false, content: '', error: null });
        window.Agent.clearConversation();
        renderMessages();
        renderComposerDesignOptions();
        showToast('Chat history cleared', 'success');
    }

    async function toggleModelSelector() {
        if (!elements.modelSelectorDropdown) return;

        if (elements.modelSelectorDropdown.style.display === 'flex') {
            closeModelSelector();
            return;
        }

        await openModelSelector();
    }

    async function openModelSelector() {
        if (!elements.modelSelectorDropdown) return;

        elements.modelSelectorDropdown.style.display = 'flex';
        elements.modelSelectorBtn?.classList.add('active');
        elements.modelSelectorBtn?.setAttribute('aria-expanded', 'true');

        try {
            await window.Agent?.getModelsAsync?.();
        } catch (error) {
            console.warn('AgentUI: failed to refresh models from API:', error);
        }

        renderModelList();
    }

    function closeModelSelector() {
        if (!elements.modelSelectorDropdown) return;

        elements.modelSelectorDropdown.style.display = 'none';
        elements.modelSelectorBtn?.classList.remove('active');
        elements.modelSelectorBtn?.setAttribute('aria-expanded', 'false');
    }

    function renderModelList() {
        if (!elements.modelList || !window.Agent) return;

        const models = window.Agent.getModels();
        if (!models.length) {
            // Show skeleton loading state
            elements.modelList.innerHTML = `
                <div class="model-group">
                    <div class="model-group-title">Loading models...</div>
                    ${Array(3).fill(0).map(() => `
                        <div class="model-item skeleton">
                            <div class="model-item-icon skeleton-icon"></div>
                            <div class="model-item-info">
                                <div class="model-item-name skeleton-text" style="width: 120px;"></div>
                                <div class="model-item-desc skeleton-text" style="width: 180px;"></div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
            return;
        }

        const grouped = groupModelsByProvider(models);
        elements.modelList.innerHTML = Object.entries(grouped).map(([provider, providerModels]) => `
            <div class="model-group">
                <div class="model-group-title">${provider}</div>
                ${providerModels.map((model) => renderModelItem(model)).join('')}
            </div>
        `).join('');

        elements.modelList.querySelectorAll('.model-item').forEach((item) => {
            item.addEventListener('click', () => {
                selectModel(item.dataset.modelId);
            });
        });
    }

    function renderModelItem(model) {
        const isActive = model.id === window.Agent.getSelectedModel();
        const provider = getModelProvider(model);
        const displayName = getModelDisplayName(model);
        const description = getModelDescription(model);

        return `
            <div class="model-item ${isActive ? 'active' : ''}" data-model-id="${escapeHtmlAttr(model.id)}" role="option" aria-selected="${isActive}">
                <div class="model-item-icon ${provider}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <rect x="4" y="4" width="16" height="16" rx="2"></rect>
                        <rect x="9" y="9" width="6" height="6"></rect>
                    </svg>
                </div>
                <div class="model-item-info">
                    <div class="model-item-name">${escapeHtml(displayName)}</div>
                    <div class="model-item-desc">${escapeHtml(description)}</div>
                </div>
                <div class="model-item-check" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                </div>
            </div>
        `;
    }

    function groupModelsByProvider(models) {
        return models.reduce((grouped, model) => {
            const providerName = getModelProviderName(model);
            if (!grouped[providerName]) {
                grouped[providerName] = [];
            }
            grouped[providerName].push(model);
            return grouped;
        }, {});
    }

    function getModelProvider(model) {
        const provider = String(model.provider || '').toLowerCase();
        if (provider) return provider;

        const id = String(model.id || '').toLowerCase();
        if (id.includes('claude')) return 'anthropic';
        if (id.includes('gpt') || id.includes('o1') || id.includes('o3') || id.includes('o4')) return 'openai';
        if (id.includes('kimi')) return 'kimi';
        if (id.includes('gemini') || id.includes('palm')) return 'google';
        if (id.includes('llama') || id.includes('meta')) return 'meta';
        if (id.includes('mistral')) return 'mistral';
        return 'other';
    }

    function getModelProviderName(model) {
        const provider = getModelProvider(model);
        const names = {
            anthropic: 'Anthropic',
            google: 'Google',
            kimi: 'Lilly',
            meta: 'Meta',
            mistral: 'Mistral',
            openai: 'OpenAI',
            other: 'Other'
        };

        return names[provider] || 'Other';
    }

    function getModelDisplayName(model) {
        return model.name || model.id;
    }

    function getModelDescription(model) {
        return model.description || model.owned_by || 'AI model';
    }

    function selectModel(modelId) {
        if (!window.Agent?.setSelectedModel(modelId)) {
            showToast('Failed to change model', 'error');
            return;
        }

        updateModelUI();
        closeModelSelector();
        showToast(`Model changed to ${getModelDisplayName(window.Agent.getModel(modelId))}`, 'success');
        window.dispatchEvent(new CustomEvent('modelChanged', { detail: { modelId } }));
    }

    function updateModelUI() {
        if (!window.Agent) return;

        const model = window.Agent.getModel(window.Agent.getSelectedModel());
        const displayName = getModelDisplayName(model);
        const profile = window.Agent.getSelectedAgentProfile?.();

        if (elements.currentModelLabel) {
            elements.currentModelLabel.textContent = displayName;
        }

        if (elements.chatModelName) {
            elements.chatModelName.textContent = `${profile?.name || 'AI Assistant'} - ${displayName}`;
        }
    }

    function showToast(message, type = 'info') {
        if (window.Sidebar?.showToast) {
            window.Sidebar.showToast(message, type);
            return;
        }

        const toast = document.createElement('div');
        toast.className = 'agent-toast';
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed;
            bottom: 100px;
            right: 30px;
            background: var(--surface-color, #2d2d2d);
            color: var(--text-primary, #e0e0e0);
            padding: 12px 20px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 10002;
            font-size: 14px;
            opacity: 0;
            transform: translateY(20px);
            transition: all 0.3s ease;
        `;

        document.body.appendChild(toast);
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateY(0)';
        });

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(20px)';
            setTimeout(() => toast.remove(), 300);
        }, 2500);
    }

    function markdownToHtml(text) {
        if (!text) return '';

        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*]+)\*/g, '<em>$1</em>')
            .replace(/^### (.+)$/gm, '<h3>$1</h3>')
            .replace(/^## (.+)$/gm, '<h2>$1</h2>')
            .replace(/^# (.+)$/gm, '<h1>$1</h1>')
            .replace(/^(\s*)- (.+)$/gm, '$1<li>$2</li>')
            .replace(/^(\s*)\d+\. (.+)$/gm, '$1<li>$2</li>')
            .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
            .replace(/\n/g, '<br>')
            .replace(/(<li>.*<\/li>)(<br>\s*)*(<li>)/g, '$1$3')
            .replace(/(<li>.*<\/li>)/g, '<ul>$1</ul>')
            .replace(/(<\/ul>)<ul>/g, '')
            .replace(/(<br>){3,}/g, '<br><br>');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
    }

    function escapeHtmlAttr(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    return {
        init,
        openChat,
        closeChat,
        toggleChat,
        sendMessage,
        quickAction,
        clearChat,
        renderMessages,
        renderMessage,
        scrollToBottom,
        showTypingIndicator,
        hideTypingIndicator,
        toggleModelSelector,
        openModelSelector,
        closeModelSelector,
        selectModel,
        updateModelUI,
        selectAgentProfile,
        renderProfilePicker,
        openWithPrompt,
        runPrompt
    };
})();

window.AgentUI = {
    init: AgentUI.init,
    openChat: AgentUI.openChat,
    closeChat: AgentUI.closeChat,
    toggleChat: AgentUI.toggleChat,
    sendMessage: AgentUI.sendMessage,
    quickAction: AgentUI.quickAction,
    clearChat: AgentUI.clearChat,
    openWithPrompt: AgentUI.openWithPrompt,
    toggleModelSelector: AgentUI.toggleModelSelector,
    openModelSelector: AgentUI.openModelSelector,
    closeModelSelector: AgentUI.closeModelSelector,
    selectModel: AgentUI.selectModel,
    updateModelUI: AgentUI.updateModelUI,
    selectAgentProfile: AgentUI.selectAgentProfile,
    renderProfilePicker: AgentUI.renderProfilePicker
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', AgentUI.init);
} else {
    AgentUI.init();
}
