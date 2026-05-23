/**
 * Storage Module - LocalStorage persistence for Lilly-style notes
 * Enhanced with error handling for Tracking Prevention and quota limits
 */

const Storage = (function() {
    const STORAGE_KEY = 'notes_notion_data';
    const CURRENT_PAGE_KEY = 'notes_notion_current_page';
    const THEME_KEY = 'notes_notion_theme';
    const GLOBAL_MODEL_KEY = 'notes_notion_global_model';
    const ASSET_DB_NAME = 'notes_notion_assets';
    const ASSET_STORE_NAME = 'assets';
    const REMOTE_SYNC_DELAY_MS = 350;
    let storageAvailable = true;
    let storageError = null;
    let memoryFallback = null; // In-memory fallback when localStorage fails
    let remoteAvailable = false;
    let remoteError = null;
    let remoteInitialized = false;
    let remoteLoadPromise = null;
    let remoteSaveTimer = null;
    let suppressRemoteSave = false;
    let remoteDirty = false;
    let remoteDeletePending = false;
    
    // Default data structure
    const defaultData = {
        pages: [
            {
                id: 'welcome',
                title: 'Welcome to Notes',
                icon: 'note',
                cover: null,
                defaultModel: null,
                properties: [],
                blocks: [
                    {
                        id: 'block-1',
                        type: 'heading_1',
                        content: 'Welcome to your new notes app!',
                        children: [],
                        formatting: {},
                        color: null,
                        createdAt: Date.now()
                    },
                    {
                        id: 'block-2',
                        type: 'text',
                        content: 'This is a Lilly-style block-based editor with AI support. Here\'s what you can do:',
                        children: [],
                        formatting: {},
                        color: null,
                        createdAt: Date.now()
                    },
                    {
                        id: 'block-3',
                        type: 'bulleted_list',
                        content: 'Type "/" to see available block types including AI Image generation',
                        children: [],
                        formatting: {},
                        color: null,
                        createdAt: Date.now()
                    },
                    {
                        id: 'block-4',
                        type: 'bulleted_list',
                        content: 'Use markdown shortcuts like #, ##, ### for headings',
                        children: [],
                        formatting: {},
                        color: null,
                        createdAt: Date.now()
                    },
                    {
                        id: 'block-5',
                        type: 'bulleted_list',
                        content: 'Drag blocks using the block handle to reorder',
                        children: [],
                        formatting: {},
                        color: null,
                        createdAt: Date.now()
                    },
                    {
                        id: 'block-6',
                        type: 'bulleted_list',
                        content: 'Try the AI Assistant by typing "/ai" or selecting text',
                        children: [],
                        formatting: {},
                        color: null,
                        createdAt: Date.now()
                    },
                    {
                        id: 'block-7',
                        type: 'bulleted_list',
                        content: 'Generate images with "/ai_image" AI Image block',
                        children: [],
                        formatting: {},
                        color: null,
                        createdAt: Date.now()
                    },
                    {
                        id: 'block-8',
                        type: 'bulleted_list',
                        content: 'Use "/math" for LaTeX equation support',
                        children: [],
                        formatting: {},
                        color: null,
                        createdAt: Date.now()
                    },
                    {
                        id: 'block-9',
                        type: 'divider',
                        content: '',
                        children: [],
                        formatting: {},
                        color: null,
                        createdAt: Date.now()
                    },
                    {
                        id: 'block-10',
                        type: 'callout',
                        content: 'Tip: Select text and use the AI toolbar to transform it with different models. Each page can have its own default AI model!',
                        children: [],
                        formatting: {},
                        color: null,
                        createdAt: Date.now()
                    }
                ],
                createdAt: Date.now(),
                updatedAt: Date.now()
            }
        ],
        trash: [],
        spaces: [
            {
                id: 'private',
                name: 'Private',
                createdAt: Date.now(),
                updatedAt: Date.now()
            }
        ],
        currentSpaceId: 'private'
    };

    function getApiBaseUrl() {
        const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
        const currentHost = window.location.hostname;
        const currentOrigin = `${window.location.protocol}//${window.location.host}`;

        return localHostnames.has(currentHost)
            ? 'http://localhost:3000/api'
            : `${currentOrigin}/api`;
    }

    function getNotesEndpoint() {
        return `${getApiBaseUrl()}/notes`;
    }
    
    /**
     * Check if localStorage is available and working
     */
    function checkStorageAvailability() {
        try {
            const test = '__storage_test__';
            localStorage.setItem(test, test);
            localStorage.removeItem(test);
            storageAvailable = true;
            storageError = null;
            return true;
        } catch (e) {
            storageAvailable = false;
            storageError = e;
            console.warn('localStorage is not available:', e.message);
            return false;
        }
    }
    
    /**
     * Generate a unique ID
     */
    function generateId() {
        return 'page-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    }
    
    /**
     * Generate a unique block ID
     */
    function generateBlockId() {
        return 'block-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    }

    function openAssetDb() {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                reject(new Error('indexedDB unavailable'));
                return;
            }

            const request = window.indexedDB.open(ASSET_DB_NAME, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(ASSET_STORE_NAME)) {
                    db.createObjectStore(ASSET_STORE_NAME);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Failed to open asset database'));
        });
    }

    async function saveImageAsset(sourceUrl) {
        if (!sourceUrl) return null;
        if (String(sourceUrl).startsWith('asset://')) return String(sourceUrl);

        try {
            const response = await fetch(sourceUrl, {
                credentials: 'include',
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const blob = await response.blob();
            const assetId = 'asset-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            const db = await openAssetDb();

            await new Promise((resolve, reject) => {
                const tx = db.transaction(ASSET_STORE_NAME, 'readwrite');
                tx.objectStore(ASSET_STORE_NAME).put(blob, assetId);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('Failed to store image asset'));
            });

            db.close();
            return `asset://${assetId}`;
        } catch (error) {
            console.warn('Failed to save image asset:', error.message);
            return sourceUrl;
        }
    }

    async function resolveImageAsset(assetRef) {
        const ref = String(assetRef || '');
        if (!ref.startsWith('asset://')) {
            return ref || null;
        }

        const assetId = ref.slice('asset://'.length);

        try {
            const db = await openAssetDb();
            const blob = await new Promise((resolve, reject) => {
                const tx = db.transaction(ASSET_STORE_NAME, 'readonly');
                const request = tx.objectStore(ASSET_STORE_NAME).get(assetId);
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => reject(request.error || new Error('Failed to read image asset'));
            });
            db.close();

            if (!blob) return null;
            return URL.createObjectURL(blob);
        } catch (error) {
            console.warn('Failed to resolve image asset:', error.message);
            return null;
        }
    }

    function normalizeImageUrlValue(value) {
        const normalized = String(value || '').trim();
        return normalized || null;
    }

    function buildArtifactInlinePath(artifactId) {
        const normalizedId = String(artifactId || '').trim();
        return normalizedId ? `/api/artifacts/${encodeURIComponent(normalizedId)}/download?inline=1` : null;
    }

    function resolveSavedAIImageUrl(content = {}) {
        const directUrl = normalizeImageUrlValue(content.imageUrl || content.url);
        if (directUrl) return directUrl;

        const directFallback = normalizeImageUrlValue(
            content.inlineUrl
            || content.absoluteInlineUrl
            || content.downloadUrl
            || content.absoluteUrl
        );
        if (directFallback) return directFallback;

        const generatedImages = Array.isArray(content.generatedImages) ? content.generatedImages : [];
        for (const image of generatedImages) {
            const imageUrl = normalizeImageUrlValue(
                image?.inlineUrl
                || image?.imageUrl
                || image?.url
                || image?.downloadUrl
                || image?.absoluteInlineUrl
                || image?.absoluteUrl
            );
            if (imageUrl) return imageUrl;

            const imageArtifactPath = buildArtifactInlinePath(image?.artifactId || image?.artifact_id);
            if (imageArtifactPath) return imageArtifactPath;
        }

        return buildArtifactInlinePath(content.artifactId || content.selectedArtifactId);
    }

    function normalizeAIImageStatusForStorage(content = {}) {
        const hasImageUrl = Boolean(resolveSavedAIImageUrl(content) || content.imageAssetId);
        const hasSearchResults = (
            (Array.isArray(content.unsplashResults) && content.unsplashResults.length > 0)
            || (Array.isArray(content.artifactResults) && content.artifactResults.length > 0)
        );
        const status = String(content.status || '').trim();

        if (status === 'generating') {
            return hasImageUrl ? 'done' : 'pending';
        }

        if (status === 'search_results') {
            return hasSearchResults ? 'search_results' : (hasImageUrl ? 'done' : 'pending');
        }

        if (status === 'done') {
            return hasImageUrl ? 'done' : 'pending';
        }

        if (status === 'error') {
            return 'error';
        }

        return status || (hasSearchResults ? 'search_results' : (hasImageUrl ? 'done' : 'pending'));
    }

    function normalizeBlockForStorage(block) {
        if (!block || typeof block !== 'object') return block;

        const nextBlock = { ...block };
        if (Array.isArray(nextBlock.children)) {
            nextBlock.children = nextBlock.children.map(normalizeBlockForStorage);
        }

        if (nextBlock.type === 'ai_image' && nextBlock.content && typeof nextBlock.content === 'object') {
            const nextContent = { ...nextBlock.content };
            delete nextContent._resolvedImageUrl;
            delete nextContent._assetLoading;
            delete nextContent._assetPersisting;
            delete nextContent._activeGeneration;
            delete nextContent._unsplashAutoRequested;
            delete nextContent.unsplashResults;
            delete nextContent.errorMessage;

            if (nextContent.imageAssetId && (!nextContent.imageUrl || String(nextContent.imageUrl).startsWith('blob:'))) {
                nextContent.imageUrl = `asset://${nextContent.imageAssetId}`;
            }
            if (!nextContent.imageAssetId && typeof nextContent.imageUrl === 'string' && nextContent.imageUrl.startsWith('asset://')) {
                nextContent.imageAssetId = nextContent.imageUrl.slice('asset://'.length) || null;
            }
            if (!nextContent.imageUrl) {
                nextContent.imageUrl = resolveSavedAIImageUrl(nextContent);
            }
            nextContent.status = normalizeAIImageStatusForStorage(nextContent);

            nextBlock.content = nextContent;
        }

        return nextBlock;
    }

    function normalizeDataForStorage(data) {
        const clone = JSON.parse(JSON.stringify(data));
        clone.pages = (clone.pages || []).map((page) => ({
            ...page,
            blocks: (page.blocks || []).map(normalizeBlockForStorage),
        }));
        clone.trash = (clone.trash || []).map((page) => ({
            ...page,
            blocks: (page.blocks || []).map(normalizeBlockForStorage),
        }));
        return clone;
    }

    function cloneBlockWithFreshIds(block) {
        if (!block || typeof block !== 'object') return block;

        return {
            ...JSON.parse(JSON.stringify(block)),
            id: generateBlockId(),
            createdAt: Date.now(),
            children: Array.isArray(block.children)
                ? block.children.map(cloneBlockWithFreshIds)
                : [],
        };
    }

    function cloneBlocksWithFreshIds(blocks = []) {
        return Array.isArray(blocks) ? blocks.map(cloneBlockWithFreshIds) : [];
    }

    function ensureUniqueBlockIds(blocks = [], seenIds = new Set()) {
        let mutated = false;

        blocks.forEach((block) => {
            if (!block || typeof block !== 'object') return;

            const nextId = typeof block.id === 'string' ? block.id.trim() : '';
            if (!nextId || seenIds.has(nextId)) {
                block.id = generateBlockId();
                mutated = true;
            }

            seenIds.add(block.id);

            if (Array.isArray(block.children) && block.children.length > 0) {
                mutated = ensureUniqueBlockIds(block.children, seenIds) || mutated;
            }
        });

        return mutated;
    }

    function normalizeLoadedData(data) {
        const source = data && typeof data === 'object' && !Array.isArray(data)
            ? data
            : {};
        let didNormalize = false;

        if (!Array.isArray(source.pages)) {
            source.pages = [];
            didNormalize = true;
        }

        if (!Array.isArray(source.trash)) {
            source.trash = [];
            didNormalize = true;
        }

        if (!Array.isArray(source.spaces) || source.spaces.length === 0) {
            source.spaces = JSON.parse(JSON.stringify(defaultData.spaces));
            didNormalize = true;
        }

        if (!source.currentSpaceId) {
            source.currentSpaceId = source.spaces[0]?.id || 'private';
            didNormalize = true;
        }

        source.pages.forEach(page => {
            if (!('defaultModel' in page)) {
                page.defaultModel = null;
                didNormalize = true;
            }
            if (!page.spaceId) {
                page.spaceId = source.currentSpaceId || 'private';
                didNormalize = true;
            }
            didNormalize = ensureUniqueBlockIds(page.blocks || []) || didNormalize;
        });

        source.trash.forEach(page => {
            if (!page.spaceId) {
                page.spaceId = source.currentSpaceId || 'private';
                didNormalize = true;
            }
            didNormalize = ensureUniqueBlockIds(page.blocks || []) || didNormalize;
        });

        return { data: source, didNormalize };
    }

    function saveAllLocally(data) {
        const normalizedData = normalizeDataForStorage(data);
        memoryFallback = JSON.parse(JSON.stringify(normalizedData));
        if (!storageAvailable) {
            console.warn('Saving to memory only - localStorage unavailable');
            return { success: false, memoryOnly: true, error: storageError };
        }

        try {
            const serialized = JSON.stringify(normalizedData);
            const sizeInMB = serialized.length / 1024 / 1024;
            if (sizeInMB > 4.5) {
                console.warn('Data size is approaching localStorage limit:', sizeInMB.toFixed(2), 'MB');
            }

            localStorage.setItem(STORAGE_KEY, serialized);
            return { success: true, memoryOnly: false };
        } catch (e) {
            console.error('Error saving to localStorage:', e);

            let errorType = 'unknown';
            if (e.name === 'QuotaExceededError') {
                errorType = 'quota_exceeded';
            } else if (e.message && e.message.includes('denied')) {
                errorType = 'permission_denied';
            }

            storageError = e;
            if (errorType === 'quota_exceeded') {
                console.warn('Storage quota exceeded. Consider cleaning up old data.');
            }

            return { success: false, memoryOnly: true, error: e, errorType };
        }
    }

    function scheduleRemoteSave(data) {
        if (suppressRemoteSave) {
            return;
        }

        const snapshot = normalizeDataForStorage(data);
        remoteDirty = true;
        if (!remoteInitialized || !remoteAvailable) {
            return;
        }

        if (remoteSaveTimer) {
            clearTimeout(remoteSaveTimer);
        }

        remoteSaveTimer = setTimeout(() => {
            remoteSaveTimer = null;
            void saveRemoteData(snapshot);
        }, REMOTE_SYNC_DELAY_MS);
    }

    async function saveRemoteData(data, extra = {}) {
        if (!remoteAvailable && remoteInitialized) {
            return false;
        }

        try {
            const response = await fetch(getNotesEndpoint(), {
                method: 'PUT',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                credentials: 'same-origin',
                body: JSON.stringify({
                    data: normalizeDataForStorage(data),
                    currentPageId: getCurrentPageId(),
                    globalModel: getGlobalDefaultModel(),
                    ...extra,
                }),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }

            remoteAvailable = true;
            remoteError = null;
            remoteDirty = false;
            return true;
        } catch (error) {
            remoteAvailable = false;
            remoteError = error;
            remoteDirty = true;
            console.warn('Failed to sync notes to backend:', error.message);
            return false;
        }
    }

    async function initializeRemote() {
        if (remoteLoadPromise && (remoteAvailable || !remoteInitialized)) {
            return remoteLoadPromise;
        }

        remoteLoadPromise = (async () => {
            try {
                if (remoteDeletePending) {
                    const deleteResponse = await fetch(getNotesEndpoint(), {
                        method: 'DELETE',
                        credentials: 'same-origin',
                    });
                    if (!deleteResponse.ok) {
                        throw new Error(`HTTP ${deleteResponse.status}`);
                    }
                    remoteAvailable = true;
                    remoteError = null;
                    remoteDirty = false;
                    remoteDeletePending = false;
                    return { remoteAvailable, remoteError };
                }

                const response = await fetch(getNotesEndpoint(), {
                    headers: { 'Accept': 'application/json' },
                    credentials: 'same-origin',
                    cache: 'no-store',
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const payload = await response.json();
                remoteAvailable = true;
                remoteError = null;

                if (payload?.data && !remoteDirty) {
                    const { data } = normalizeLoadedData(payload.data);
                    suppressRemoteSave = true;
                    saveAllLocally(data);
                    suppressRemoteSave = false;

                    if (payload.currentPageId) {
                        setCurrentPageId(payload.currentPageId, { skipRemote: true });
                    }
                    if (payload.globalModel) {
                        setGlobalDefaultModel(payload.globalModel, { skipRemote: true });
                    }
                } else {
                    const localData = loadAll();
                    await saveRemoteData(localData);
                }
            } catch (error) {
                remoteAvailable = false;
                remoteError = error;
                console.warn('Notes backend persistence unavailable; using local notes storage:', error.message);
            } finally {
                remoteInitialized = true;
            }

            return {
                remoteAvailable,
                remoteError,
            };
        })();

        return remoteLoadPromise;
    }
    
    /**
     * Load all data from localStorage
     */
    function loadAll() {
        // First check if storage is available
        if (!storageAvailable && !checkStorageAvailability()) {
            // Use memory fallback
            if (memoryFallback) {
                return memoryFallback;
            }
            // Initialize with default data in memory
            memoryFallback = JSON.parse(JSON.stringify(defaultData));
            return memoryFallback;
        }
        
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            if (data) {
                const { data: parsed, didNormalize } = normalizeLoadedData(JSON.parse(data));
                if (didNormalize) {
                    saveAll(parsed);
                }
                return parsed;
            }
            // Initialize with default data
            saveAll(defaultData);
            return defaultData;
        } catch (e) {
            console.error('Error loading from localStorage:', e);
            storageAvailable = false;
            storageError = e;
            
            // Use memory fallback
            if (memoryFallback) {
                return memoryFallback;
            }
            memoryFallback = JSON.parse(JSON.stringify(defaultData));
            return memoryFallback;
        }
    }
    
    /**
     * Save all data to localStorage with error handling
     */
    function saveAll(data) {
        const normalizedData = normalizeDataForStorage(data);
        const result = saveAllLocally(normalizedData);
        scheduleRemoteSave(normalizedData);
        return result;
    }
    
    /**
     * Get storage status for diagnostics
     */
    function getStorageStatus() {
        let usage = null;
        let quota = null;
        
        // Try to get storage estimate (Chrome only)
        if (navigator.storage && navigator.storage.estimate) {
            navigator.storage.estimate().then(estimate => {
                usage = estimate.usage;
                quota = estimate.quota;
            }).catch(() => {});
        }
        
        return {
            available: storageAvailable,
            error: storageError,
            memoryOnly: !storageAvailable,
            memoryFallback: !!memoryFallback,
            remoteAvailable,
            remoteInitialized,
            remoteDirty,
            remoteDeletePending,
            remoteError,
            usage,
            quota
        };
    }
    
    /**
     * Export data to JSON file (for backup when storage fails)
     */
    function exportToFile() {
        const data = loadAll();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `notes-backup-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    /**
     * Import data from JSON file
     */
    function importFromFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    if (data.pages && Array.isArray(data.pages)) {
                        saveAll(data);
                        resolve(data);
                    } else {
                        reject(new Error('Invalid backup file format'));
                    }
                } catch (err) {
                    reject(err);
                }
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsText(file);
        });
    }
    
    /**
     * Get global default model
     */
    function getGlobalDefaultModel() {
        if (!storageAvailable) return 'gpt-4o';
        try {
            return localStorage.getItem(GLOBAL_MODEL_KEY) || 'gpt-4o';
        } catch (e) {
            return 'gpt-4o';
        }
    }
    
    /**
     * Set global default model
     */
    function setGlobalDefaultModel(model, options = {}) {
        if (!storageAvailable) {
            if (options.skipRemote !== true && remoteInitialized && remoteAvailable) {
                void saveRemoteData(loadAll(), { globalModel: model });
            }
            return false;
        }
        try {
            localStorage.setItem(GLOBAL_MODEL_KEY, model);
            if (options.skipRemote !== true && remoteInitialized && remoteAvailable) {
                void saveRemoteData(loadAll(), { globalModel: model });
            }
            return true;
        } catch (e) {
            return false;
        }
    }
    
    /**
     * Get all pages
     */
    function getPages() {
        const data = loadAll();
        return data.pages || [];
    }
    
    /**
     * Get a specific page by ID
     */
    function getPage(pageId) {
        const data = loadAll();
        return data.pages.find(p => p.id === pageId) || null;
    }
    
    /**
     * Create a new page
     */
    function createPage(title = 'Untitled', parentId = null) {
        const data = loadAll();
        const newPage = {
            id: generateId(),
            title: title,
            icon: '',
            cover: null,
            defaultModel: null, // Use global default
            properties: [],
            blocks: [
                {
                    id: generateBlockId(),
                    type: 'text',
                    content: '',
                    children: [],
                    formatting: {},
                    color: null,
                    createdAt: Date.now()
                }
            ],
            parentId: parentId,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        
        data.pages.push(newPage);
        saveAll(data);
        
        return newPage;
    }
    
    /**
     * Update a page
     */
    function updatePage(pageId, updates) {
        const data = loadAll();
        const pageIndex = data.pages.findIndex(p => p.id === pageId);
        
        if (pageIndex === -1) return null;
        
        data.pages[pageIndex] = {
            ...data.pages[pageIndex],
            ...updates,
            updatedAt: Date.now()
        };
        
        saveAll(data);
        return data.pages[pageIndex];
    }
    
    /**
     * Delete a page (move to trash)
     */
    function deletePage(pageId) {
        const data = loadAll();
        const pageIndex = data.pages.findIndex(p => p.id === pageId);
        
        if (pageIndex === -1) return false;
        
        const page = data.pages[pageIndex];
        page.deletedAt = Date.now();
        
        data.trash.push(page);
        data.pages.splice(pageIndex, 1);
        
        saveAll(data);
        return true;
    }
    
    /**
     * Permanently delete a page from trash
     */
    function permanentDeletePage(pageId) {
        const data = loadAll();
        data.trash = data.trash.filter(p => p.id !== pageId);
        saveAll(data);
        return true;
    }
    
    /**
     * Restore a page from trash
     */
    function restorePage(pageId) {
        const data = loadAll();
        const trashIndex = data.trash.findIndex(p => p.id === pageId);
        
        if (trashIndex === -1) return null;
        
        const page = data.trash[trashIndex];
        delete page.deletedAt;
        
        data.pages.push(page);
        data.trash.splice(trashIndex, 1);
        
        saveAll(data);
        return page;
    }
    
    /**
     * Get all pages in trash
     */
    function getTrash() {
        const data = loadAll();
        return data.trash || [];
    }
    
    /**
     * Get current page ID
     */
    function getCurrentPageId() {
        if (!storageAvailable) return null;
        try {
            return localStorage.getItem(CURRENT_PAGE_KEY) || null;
        } catch (e) {
            return null;
        }
    }
    
    /**
     * Set current page ID
     */
    function setCurrentPageId(pageId, options = {}) {
        if (!storageAvailable) {
            if (options.skipRemote !== true && remoteInitialized && remoteAvailable) {
                void saveRemoteData(loadAll(), { currentPageId: pageId });
            }
            return false;
        }
        try {
            localStorage.setItem(CURRENT_PAGE_KEY, pageId);
            if (options.skipRemote !== true && remoteInitialized && remoteAvailable) {
                void saveRemoteData(loadAll(), { currentPageId: pageId });
            }
            return true;
        } catch (e) {
            return false;
        }
    }
    
    /**
     * Get theme preference
     */
    function getTheme() {
        if (!storageAvailable) return 'light';
        try {
            return localStorage.getItem(THEME_KEY) || 'light';
        } catch (e) {
            return 'light';
        }
    }
    
    /**
     * Set theme preference
     */
    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        if (!storageAvailable) return false;
        try {
            localStorage.setItem(THEME_KEY, theme);
            return true;
        } catch (e) {
            return false;
        }
    }
    
    /**
     * Export page to Markdown
     */
    function exportToMarkdown(pageId) {
        const page = getPage(pageId);
        if (!page) return null;
        
        let markdown = '';
        
        if (page.icon) {
            markdown += `${page.icon} `;
        }
        markdown += `# ${page.title || 'Untitled'}\n\n`;
        
        function blocksToMarkdown(blocks, depth = 0) {
            let md = '';
            let listCounter = {};
            
            for (const block of blocks) {
                const indent = '  '.repeat(depth);
                
                switch (block.type) {
                    case 'heading_1':
                        md += `${indent}# ${block.content}\n\n`;
                        break;
                    case 'heading_2':
                        md += `${indent}## ${block.content}\n\n`;
                        break;
                    case 'heading_3':
                        md += `${indent}### ${block.content}\n\n`;
                        break;
                    case 'text':
                        md += `${indent}${block.content}\n\n`;
                        break;
                    case 'bulleted_list':
                        md += `${indent}- ${block.content}\n`;
                        break;
                    case 'numbered_list':
                        md += `${indent}1. ${block.content}\n`;
                        break;
                    case 'todo':
                        const checkbox = block.content.checked ? '[x]' : '[ ]';
                        md += `${indent}- ${checkbox} ${block.content.text || block.content}\n`;
                        break;
                    case 'quote':
                        md += `${indent}> ${block.content}\n\n`;
                        break;
                    case 'code':
                        md += `${indent}\`\`\`${block.content.language || ''}\n${block.content.text || block.content}\n\`\`\`\n\n`;
                        break;
                    case 'math':
                        md += `${indent}$$\n${block.content.text || ''}\n$$\n\n`;
                        break;
                    case 'divider':
                        md += `${indent}---\n\n`;
                        break;
                    case 'callout':
                        md += `${indent}> Tip: ${block.content}\n\n`;
                        break;
                    case 'ai_image':
                        md += `${indent}![AI Image: ${block.content.prompt || ''}](${block.content.imageUrl || ''})\n\n`;
                        break;
                    case 'database':
                        md += `${indent}| ${block.content.columns.join(' | ')} |\n`;
                        md += `${indent}| ${block.content.columns.map(() => '---').join(' | ')} |\n`;
                        block.content.rows.forEach(row => {
                            md += `${indent}| ${row.join(' | ')} |\n`;
                        });
                        md += '\n';
                        break;
                    case 'chart':
                        md += `${indent}**${block.content.title || 'Chart'}**\n\n`;
                        (block.content.labels || []).forEach((label, index) => {
                            md += `${indent}- ${label}: ${(block.content.values || [])[index] ?? ''}${block.content.unit || ''}\n`;
                        });
                        md += '\n';
                        break;
                }
                
                // Handle nested children
                if (block.children && block.children.length > 0) {
                    md += blocksToMarkdown(block.children, depth + 1);
                }
            }
            
            return md;
        }
        
        markdown += blocksToMarkdown(page.blocks);
        return markdown;
    }
    
    /**
     * Clear all data (use with caution)
     */
    function clearAll() {
        memoryFallback = null;
        remoteDeletePending = true;
        if (remoteInitialized && remoteAvailable) {
            void fetch(getNotesEndpoint(), {
                method: 'DELETE',
                credentials: 'same-origin',
            }).then((response) => {
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                remoteDeletePending = false;
                remoteDirty = false;
            }).catch((error) => {
                console.warn('Failed to clear remote notes:', error.message);
            });
        }

        if (!storageAvailable) return;
        try {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(CURRENT_PAGE_KEY);
            localStorage.removeItem(GLOBAL_MODEL_KEY);
        } catch (e) {
            console.error('Error clearing storage:', e);
        }
    }
    
    // Initialize theme on load
    const savedTheme = getTheme();
    document.documentElement.setAttribute('data-theme', savedTheme);
    
    // Check storage availability on load
    checkStorageAvailability();
    
    return {
        generateId,
        generateBlockId,
        cloneBlocksWithFreshIds,
        initializeRemote,
        loadAll,
        saveAll,
        getStorageStatus,
        saveImageAsset,
        resolveImageAsset,
        exportToFile,
        importFromFile,
        getPages,
        getAllPages: getPages,
        getPage,
        createPage,
        updatePage,
        deletePage,
        permanentDeletePage,
        restorePage,
        getTrash,
        getCurrentPageId,
        setCurrentPageId,
        getTheme,
        setTheme,
        getGlobalDefaultModel,
        setGlobalDefaultModel,
        exportToMarkdown,
        clearAll
    };
})();


