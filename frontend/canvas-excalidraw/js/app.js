/**
 * Main App Controller - Event coordination and app initialization
 * Enhanced: Uses OpenAI SDK for API communication
 * Fixed: Share functionality, mobile controls, export/import improvements
 */

class App {
    constructor() {
        this.currentTool = 'selection';
        this.aiTooltipTimeout = null;
        this.lastImport = null; // For undo import functionality
        this.init();
    }
    
    init() {
        // Wait for all modules to load
        document.addEventListener('DOMContentLoaded', () => {
            this.applyCoreWorkspaceMode();
            this.setupEventListeners();
            this.setupImageUpload();
            this.setupTheme();
            this.setupExport();
            this.setupKeyboardShortcuts();
            this.setupAutoSave();
            this.setupMobileControls();
            this.setupMiniMap();
            this.setupAITooltip();
            this.setupFontSearch();
            this.setupOpacitySlider();
            
            // Note: WebSocket not used with OpenAI SDK mode
            console.log('OpenAI SDK mode: WebSocket not used');
            
            // Load saved canvas or initial render
            this.loadCanvasFromStorage();
            window.infiniteCanvas?.render();
            
            // Push initial state for undo
            window.historyManager?.pushState(window.infiniteCanvas?.elements || []);
            
            // Setup model selector
            this.setupModelSelector();
            
            // Setup AI panel mode toggles
            this.setupAIModeToggles();
            window.aiAssistant?.setMode('chat');
            
            // Setup tooltips
            this.setupTooltips();
            
            // Setup touch/long-press for mobile
            this.setupTouchHandling();
            
            console.log('Lilly Canvas initialized with OpenAI SDK');
        });
    }

    applyCoreWorkspaceMode() {
        const stableTools = new Set(
            window.toolManager?.getSupportedTools?.() || [
                'selection',
                'rectangle',
                'ellipse',
                'diamond',
                'line',
                'arrow',
                'freedraw',
                'eraser',
                'text',
                'sticky',
                'frame',
                'image',
                'ai-image',
            ]
        );

        document.body.classList.add('canvas-core-mode');

        document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
            if (!stableTools.has(btn.dataset.tool)) {
                btn.classList.add('core-hidden');
                btn.setAttribute('aria-hidden', 'true');
                btn.tabIndex = -1;
            }
        });

        [
            'menuBtn',
            'themeDropdown',
            'shareBtn',
            'miniMapToggle',
            'miniMap',
            'layersPanel',
            'stickersPanel',
        ].forEach((id) => {
            const node = document.getElementById(id);
            if (node) {
                node.classList.add('core-hidden');
                node.setAttribute('aria-hidden', 'true');
            }
        });

        ['roughnessPicker', 'edgesPicker', 'alignmentGroup'].forEach((id) => {
            const node = document.getElementById(id);
            const group = node?.closest('.property-group') || node;
            if (group) {
                group.classList.add('core-hidden');
                group.setAttribute('aria-hidden', 'true');
            }
        });

        document.querySelectorAll('.tool-category').forEach((category) => {
            const visibleTools = Array.from(category.querySelectorAll('.tool-btn[data-tool]'))
                .filter((btn) => !btn.classList.contains('core-hidden'));

            if (visibleTools.length === 0 && !category.querySelector('#aiAssistantBtn')) {
                category.classList.add('core-hidden');
                return;
            }

            category.classList.add('expanded');
        });
    }
    
    setupAutoSave() {
        // Auto-save every 30 seconds
        this.autoSaveInterval = setInterval(() => {
            this.saveCanvasToStorage();
        }, 30000);
        
        // Save on page unload
        window.addEventListener('beforeunload', () => {
            this.saveCanvasToStorage();
        });
        
        // Save on visibility change (tab switch)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.saveCanvasToStorage();
            }
        });
    }
    
    saveCanvasToStorage() {
        try {
            const canvas = window.infiniteCanvas;
            if (!canvas || canvas.elements.length === 0) return;
            
            // Don't save image elements (can't serialize Image objects)
            const serializableElements = canvas.elements.map(el => {
                const copy = { ...el };
                delete copy.imageElement; // Remove non-serializable Image objects
                return copy;
            });
            
            const data = {
                elements: serializableElements,
                timestamp: Date.now(),
                version: '1.0'
            };
            
            localStorage.setItem('kimi-canvas-autosave', JSON.stringify(data));
        } catch (error) {
            console.warn('Failed to auto-save canvas:', error);
        }
    }
    
    loadCanvasFromStorage() {
        try {
            const saved = localStorage.getItem('kimi-canvas-autosave');
            if (!saved) return;
            
            const data = JSON.parse(saved);
            if (!data.elements || !Array.isArray(data.elements)) return;
            
            const canvas = window.infiniteCanvas;
            if (!canvas) return;
            
            const savedTime = new Date(data.timestamp).toLocaleString();
            
            // Load elements
            for (const el of data.elements) {
                // Restore default properties if missing
                if (!el.strokeColor) el.strokeColor = '#000000';
                if (!el.backgroundColor) el.backgroundColor = 'transparent';
                if (!el.strokeWidth) el.strokeWidth = 2;
                if (!el.strokeStyle) el.strokeStyle = 'solid';
                if (el.roughness === undefined) el.roughness = 1;
                if (el.opacity === undefined) el.opacity = 1;
                
                canvas.elements.push(el);
            }
            
            canvas.render();
            console.log(`Restored ${data.elements.length} elements from auto-save (${savedTime})`);
        } catch (error) {
            console.warn('Failed to load auto-saved canvas:', error);
        }
    }
    
    setupEventListeners() {
        // Zoom controls
        document.getElementById('zoomInBtn')?.addEventListener('click', () => {
            window.infiniteCanvas?.zoomIn();
        });
        
        document.getElementById('zoomOutBtn')?.addEventListener('click', () => {
            window.infiniteCanvas?.zoomOut();
        });
        
        document.getElementById('resetZoomBtn')?.addEventListener('click', () => {
            window.infiniteCanvas?.resetZoom();
        });
        
        // Theme picker dropdown
        const themePickerBtn = document.getElementById('themePickerBtn');
        const themeDropdown = document.getElementById('themeDropdown');
        
        themePickerBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            themeDropdown?.classList.toggle('active');
        });
        
        // Theme selection
        document.querySelectorAll('[data-theme]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const theme = btn.dataset.theme;
                this.setTheme(theme);
                themeDropdown?.classList.remove('active');
            });
        });
        
        // Close theme dropdown when clicking outside
        document.addEventListener('click', () => {
            themeDropdown?.classList.remove('active');
        });
        
        // Export button - show new export dialog
        const exportBtn = document.getElementById('exportBtn');
        const exportDropdown = document.getElementById('exportDropdown');
        
        exportBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (exportDropdown) {
                exportDropdown.classList.toggle('active');
            } else {
                window.importExportManager?.showExportDialog();
            }
        });
        
        // Export dropdown items - auto-close on selection
        document.querySelectorAll('[data-export]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const format = btn.dataset.export;
                
                // Show progress modal for PDF export
                if (format === 'pdf') {
                    this.showExportProgress();
                }
                
                await window.importExportManager?.export(format);
                
                // Hide progress modal
                if (format === 'pdf') {
                    this.hideExportProgress();
                }
                
                if (exportDropdown) {
                    exportDropdown.classList.remove('active');
                }
            });
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', () => {
            if (exportDropdown) {
                exportDropdown.classList.remove('active');
            }
        });
        
        // Import button - show import dialog
        document.getElementById('importBtn')?.addEventListener('click', () => {
            window.importExportManager?.showImportDialog();
        });
        
        // File import input
        const fileImportInput = document.getElementById('fileImportInput');
        fileImportInput?.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files);
            if (files.length > 0) {
                await window.importExportManager?.importFiles(files);
            }
            // Reset input
            e.target.value = '';
        });
        
        // Help button
        document.getElementById('helpBtn')?.addEventListener('click', () => {
            this.showHelpModal();
        });
        
        // Share button - implement share functionality
        document.getElementById('shareBtn')?.addEventListener('click', () => {
            this.shareCanvas();
        });
        
        // Clear canvas button
        document.getElementById('clearBtn')?.addEventListener('click', () => {
            this.clearCanvas();
        });
        
        // Templates button (if exists in menu/toolbar)
        document.getElementById('templatesBtn')?.addEventListener('click', () => {
            window.templatesManager?.showTemplatesModal();
        });
        
        // Menu button - open templates
        document.getElementById('menuBtn')?.addEventListener('click', () => {
            window.templatesManager?.showTemplatesModal();
        });
        
        // Stickers toggle button (if exists in toolbar)
        document.querySelector('.tool-btn[data-tool="stickers"]')?.addEventListener('click', () => {
            window.stickersManager?.toggleStickersPanel();
        });
        
        // Legacy Export modal (keep for backward compatibility)
        document.getElementById('closeExportModal')?.addEventListener('click', () => {
            this.hideExportModal();
        });
        
        document.querySelectorAll('.export-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.exportCanvas(btn.dataset.format);
            });
        });
        
        // Help modal
        document.getElementById('closeHelpModal')?.addEventListener('click', () => {
            this.hideHelpModal();
        });
        
        // Close modals on backdrop click
        document.getElementById('exportModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) this.hideExportModal();
        });
        
        document.getElementById('helpModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) this.hideHelpModal();
        });
        
        // Drag and drop for files with overlay
        const fileDropOverlay = document.getElementById('fileDropOverlay');
        let dragCounter = 0;
        
        document.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;
            if (fileDropOverlay) {
                fileDropOverlay.classList.add('active');
            }
            document.body.classList.add('drag-over');
        });
        
        document.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dragCounter--;
            if (dragCounter === 0) {
                if (fileDropOverlay) {
                    fileDropOverlay.classList.remove('active');
                }
                document.body.classList.remove('drag-over');
            }
        });
        
        document.addEventListener('dragover', (e) => {
            e.preventDefault();
        });
        
        document.addEventListener('drop', async (e) => {
            e.preventDefault();
            dragCounter = 0;
            if (fileDropOverlay) {
                fileDropOverlay.classList.remove('active');
            }
            document.body.classList.remove('drag-over');
            await this.handleFileDrop(e);
        });
        
        // Prevent leaving page with unsaved changes
        window.addEventListener('beforeunload', (e) => {
            const canvas = window.infiniteCanvas;
            if (canvas && canvas.elements.length > 0) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
    }
    
    setupMobileControls() {
        // Mobile toolbar toggle
        const mobileToolbarToggle = document.getElementById('mobileToolbarToggle');
        const toolbar = document.getElementById('toolbar');
        const mobileToolbarClose = document.getElementById('mobileToolbarClose');
        
        mobileToolbarToggle?.addEventListener('click', () => {
            document.getElementById('propertiesPanel')?.classList.remove('active');
            window.aiAssistant?.hidePanel();
            toolbar?.classList.add('active');
        });
        
        mobileToolbarClose?.addEventListener('click', () => {
            toolbar?.classList.remove('active');
        });
        
        // Mobile properties panel toggle
        const mobilePropertiesToggle = document.getElementById('mobilePropertiesToggle');
        const propertiesPanel = document.getElementById('propertiesPanel');
        const mobilePropertiesClose = document.getElementById('mobilePropertiesClose');
        
        mobilePropertiesToggle?.addEventListener('click', () => {
            document.getElementById('toolbar')?.classList.remove('active');
            window.aiAssistant?.hidePanel();
            propertiesPanel?.classList.add('active');
        });
        
        mobilePropertiesClose?.addEventListener('click', () => {
            propertiesPanel?.classList.remove('active');
        });
    }
    
    setupMiniMap() {
        const miniMapToggle = document.getElementById('miniMapToggle');
        const miniMap = document.getElementById('miniMap');
        
        miniMapToggle?.addEventListener('click', () => {
            const isVisible = miniMap?.style.display !== 'none';
            if (miniMap) {
                miniMap.style.display = isVisible ? 'none' : 'block';
            }
            miniMapToggle?.classList.toggle('active', !isVisible);
            
            if (!isVisible) {
                this.updateMiniMap();
            }
        });
        
        // Update mini map on canvas changes
        window.infiniteCanvas?.canvas?.addEventListener('change', () => {
            if (miniMap?.style.display !== 'none') {
                this.updateMiniMap();
            }
        });
    }
    
    updateMiniMap() {
        const miniMapCanvas = document.getElementById('miniMapCanvas');
        const miniMapViewport = document.getElementById('miniMapViewport');
        if (!miniMapCanvas || !window.infiniteCanvas) return;
        
        const canvas = window.infiniteCanvas;
        const ctx = miniMapCanvas.getContext('2d');
        
        // Get canvas bounds
        const bounds = canvas.getBounds();
        const padding = 50;
        
        // Set mini map dimensions
        const scale = Math.min(
            miniMapCanvas.width / (bounds.width + padding * 2),
            miniMapCanvas.height / (bounds.height + padding * 2)
        );
        
        // Clear mini map
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg');
        ctx.fillRect(0, 0, miniMapCanvas.width, miniMapCanvas.height);
        
        // Draw elements
        ctx.save();
        ctx.translate(
            miniMapCanvas.width / 2 - (bounds.x + bounds.width / 2) * scale,
            miniMapCanvas.height / 2 - (bounds.y + bounds.height / 2) * scale
        );
        ctx.scale(scale, scale);
        
        for (const element of canvas.elements) {
            window.renderer?.drawElement(ctx, element);
        }
        
        ctx.restore();
        
        // Update viewport indicator
        if (miniMapViewport) {
            const viewportWidth = canvas.canvas.width / canvas.scale * scale;
            const viewportHeight = canvas.canvas.height / canvas.scale * scale;
            miniMapViewport.style.width = `${viewportWidth}px`;
            miniMapViewport.style.height = `${viewportHeight}px`;
            miniMapViewport.style.left = `${miniMapCanvas.width / 2 - viewportWidth / 2}px`;
            miniMapViewport.style.top = `${miniMapCanvas.height / 2 - viewportHeight / 2}px`;
        }
    }
    
    setupAITooltip() {
        const aiTooltip = document.getElementById('aiImageTooltip');
        const aiTooltipClose = document.getElementById('aiTooltipClose');
        
        // Close button handler
        aiTooltipClose?.addEventListener('click', () => {
            if (aiTooltip) {
                aiTooltip.style.display = 'none';
            }
            if (this.aiTooltipTimeout) {
                clearTimeout(this.aiTooltipTimeout);
            }
        });
        
        // Auto-hide after 3 seconds when shown
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                    if (aiTooltip?.style.display === 'block') {
                        if (this.aiTooltipTimeout) {
                            clearTimeout(this.aiTooltipTimeout);
                        }
                        this.aiTooltipTimeout = setTimeout(() => {
                            if (aiTooltip) {
                                aiTooltip.style.display = 'none';
                            }
                        }, 3000);
                    }
                }
            });
        });
        
        if (aiTooltip) {
            observer.observe(aiTooltip, { attributes: true });
        }
        
        // Hide on click elsewhere
        document.addEventListener('click', (e) => {
            if (aiTooltip && !aiTooltip.contains(e.target) && 
                !e.target.closest('[data-tool="ai-image"]')) {
                aiTooltip.style.display = 'none';
            }
        });
    }
    
    setupFontSearch() {
        const fontSearchInput = document.getElementById('fontSearchInput');
        if (!fontSearchInput) return;
        
        let debounceTimer;
        
        fontSearchInput.addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                window.propertiesManager?.filterFonts(e.target.value);
            }, 300);
        });
    }
    
    setupOpacitySlider() {
        const opacitySlider = document.getElementById('opacitySlider');
        const opacityValue = document.getElementById('opacityValue');
        const opacityPreview = document.getElementById('opacityPreview');
        
        if (!opacitySlider) return;
        
        const updateOpacity = () => {
            const value = opacitySlider.value;
            if (opacityValue) {
                opacityValue.textContent = `${value}%`;
            }
            if (opacityPreview) {
                opacityPreview.style.width = `${value}%`;
            }
            
            // Update selected elements in real-time
            const canvas = window.infiniteCanvas;
            if (canvas?.selectedElements.length > 0) {
                for (const el of canvas.selectedElements) {
                    el.opacity = value / 100;
                }
                canvas.render();
            }
            
            // Update default properties
            window.toolManager?.updateDefaultProperties({ opacity: value / 100 });
        };
        
        opacitySlider.addEventListener('input', updateOpacity);
        
        // Initial update
        updateOpacity();
    }
    
    showExportProgress() {
        const modal = document.getElementById('exportProgressModal');
        if (modal) {
            modal.style.display = 'flex';
        }
    }
    
    hideExportProgress() {
        const modal = document.getElementById('exportProgressModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }
    
    updateExportProgress(progress, page = '') {
        const fill = document.getElementById('exportProgressFill');
        const text = document.getElementById('exportProgressText');
        const pageText = document.getElementById('exportProgressPage');
        
        if (fill) fill.style.width = `${progress}%`;
        if (text) text.textContent = progress < 100 ? 'Exporting...' : 'Complete!';
        if (pageText && page) pageText.textContent = page;
    }
    
    setupKeyboardShortcuts() {
        // Global keyboard shortcuts handled in individual modules
        // Additional app-level shortcuts:
        document.addEventListener('keydown', (e) => {
            // Don't process shortcuts when in input fields
            const isInputActive = document.activeElement.tagName === 'TEXTAREA' || 
                                  document.activeElement.tagName === 'INPUT';
            
            // Help shortcut
            if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isInputActive) {
                this.showHelpModal();
            }
            
            // Templates shortcut (Ctrl/Cmd + T)
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't' && !isInputActive) {
                e.preventDefault();
                window.templatesManager?.showTemplatesModal();
            }
            
            // Stickers shortcut (Ctrl/Cmd + Shift + S)
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's' && !isInputActive) {
                e.preventDefault();
                window.stickersManager?.toggleStickersPanel();
            }
            
            // Layers panel toggle (Ctrl/Cmd + L)
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l' && !isInputActive && !e.shiftKey) {
                e.preventDefault();
                document.getElementById('layersPanel')?.classList.toggle('active');
            }
            
            // Mini map toggle (M)
            if (e.key.toLowerCase() === 'm' && !isInputActive && !e.ctrlKey && !e.metaKey && !e.altKey) {
                document.getElementById('miniMapToggle')?.click();
            }
            
            // Escape to close modals and deselect
            if (e.key === 'Escape') {
                // First check if text editor is open
                const textEditor = document.getElementById('textEditor');
                if (textEditor && textEditor.style.display === 'block') {
                    textEditor.blur();
                    return;
                }
                
                // Close mobile panels
                document.getElementById('toolbar')?.classList.remove('active');
                document.getElementById('propertiesPanel')?.classList.remove('active');
                
                this.hideExportModal();
                this.hideHelpModal();
                window.aiAssistant?.hidePanel();
                window.infiniteCanvas?.deselectAll();
            }
            
            // Ctrl/Cmd shortcuts
            if ((e.ctrlKey || e.metaKey) && !isInputActive) {
                switch (e.key.toLowerCase()) {
                    case 'z':
                        e.preventDefault();
                        if (e.shiftKey) {
                            window.historyManager?.redo();
                        } else {
                            window.historyManager?.undo();
                        }
                        break;
                    case 'y':
                        e.preventDefault();
                        window.historyManager?.redo();
                        break;
                    case 'd':
                        e.preventDefault();
                        window.selectionManager?.duplicateSelection();
                        break;
                    case 'c':
                        e.preventDefault();
                        window.toolManager?.copySelection();
                        this.showToast('Copied to clipboard');
                        break;
                    case 'x':
                        e.preventDefault();
                        window.toolManager?.cutSelection();
                        this.showToast('Cut to clipboard');
                        break;
                    case 'v':
                        e.preventDefault();
                        window.toolManager?.paste();
                        break;
                    case 'g':
                        e.preventDefault();
                        if (e.shiftKey) {
                            window.selectionManager?.ungroupSelection();
                        } else {
                            window.selectionManager?.groupSelection();
                        }
                        break;
                    case 's':
                        e.preventDefault();
                        this.exportCanvas('json');
                        break;
                    case 'o':
                        e.preventDefault();
                        this.importJSON();
                        break;
                    case 'e':
                        e.preventDefault();
                        window.importExportManager?.showExportDialog();
                        break;
                    case 'a':
                        e.preventDefault();
                        // Select all
                        const canvas = window.infiniteCanvas;
                        canvas.selectElements(canvas.elements);
                        break;
                }
            }
        });
    }
    
    setupTouchHandling() {
        // Long-press tooltips for mobile
        if (window.matchMedia('(pointer: coarse)').matches) {
            document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
                let pressTimer;
                
                btn.addEventListener('touchstart', (e) => {
                    pressTimer = setTimeout(() => {
                        btn.classList.add('show-tooltip');
                        setTimeout(() => {
                            btn.classList.remove('show-tooltip');
                        }, 1500);
                    }, 500);
                });
                
                btn.addEventListener('touchend', () => {
                    clearTimeout(pressTimer);
                });
                
                btn.addEventListener('touchmove', () => {
                    clearTimeout(pressTimer);
                });
            });
        }
    }
    
    setupImageUpload() {
        const input = document.getElementById('imageInput');
        if (!input) return;
        
        input.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            this.loadImage(file, {
                x: parseFloat(input.dataset.posX) || 0,
                y: parseFloat(input.dataset.posY) || 0
            });
            
            // Reset input
            input.value = '';
        });
    }
    
    loadImage(file, pos) {
        const canvas = window.infiniteCanvas;
        const reader = new FileReader();
        
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                // Calculate size while maintaining aspect ratio
                const maxWidth = 400;
                const maxHeight = 300;
                let width = img.width;
                let height = img.height;
                
                if (width > maxWidth) {
                    height *= maxWidth / width;
                    width = maxWidth;
                }
                if (height > maxHeight) {
                    width *= maxHeight / height;
                    height = maxHeight;
                }
                
                // If no position specified, use center of view
                const x = pos?.x || canvas.screenToWorld(canvas.canvas.width / 2, canvas.canvas.height / 2).x;
                const y = pos?.y || canvas.screenToWorld(canvas.canvas.width / 2, canvas.canvas.height / 2).y;
                
                const element = {
                    id: window.toolManager.generateId(),
                    type: 'image',
                    x: x,
                    y: y,
                    width: width,
                    height: height,
                    imageElement: img,
                    ...window.toolManager.defaultProperties
                };
                
                canvas.addElement(element);
                window.historyManager?.pushState(canvas.elements);
                
                // Reset tool to selection
                window.toolManager.setTool('selection');
                canvas.selectElement(element);
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    }
    
    async handleFileDrop(e) {
        const files = e.dataTransfer.files;
        const canvas = window.infiniteCanvas;
        const rect = canvas.container.getBoundingClientRect();
        
        // Use new import system if available
        if (window.importExportManager) {
            // Get drop position for positioning imported elements
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const worldPos = canvas.screenToWorld(x, y);
            
            // Store current state for undo
            const previousElements = [...canvas.elements];
            const importSummary = {
                count: 0,
                files: [],
                errors: []
            };
            
            // Process each file
            for (const file of files) {
                try {
                    // Check if it's an image type
                    const isImage = file.type.startsWith('image/') || 
                        /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(file.name);
                    
                    if (isImage) {
                        await window.importExportManager.importImage(file, worldPos);
                        importSummary.count++;
                        importSummary.files.push(file.name);
                    } else {
                        await window.importExportManager.importFile(file);
                        importSummary.count++;
                        importSummary.files.push(file.name);
                    }
                } catch (error) {
                    // Map technical errors to user-friendly messages
                    const errorMessage = this.getUserFriendlyError(error, file.name);
                    importSummary.errors.push({ file: file.name, error: errorMessage });
                }
            }
            
            // Store import data for undo
            this.lastImport = {
                previousElements,
                newElements: canvas.elements.filter(el => !previousElements.includes(el)),
                summary: importSummary
            };
            
            // Show appropriate toast
            if (importSummary.count > 0) {
                this.showToast(`Imported ${importSummary.count} file(s)`);
                
                // Show undo option
                if (importSummary.count > 1) {
                    this.showUndoImportToast(importSummary);
                }
            }
            
            if (importSummary.errors.length > 0) {
                console.error('Import errors:', importSummary.errors);
                this.showToast(`${importSummary.errors.length} file(s) failed to import`, 'error');
            }
        } else {
            // Fallback to legacy import
            for (const file of files) {
                if (file.type.startsWith('image/')) {
                    const x = e.clientX - rect.left;
                    const y = e.clientY - rect.top;
                    const worldPos = canvas.screenToWorld(x, y);
                    this.loadImage(file, worldPos);
                } else if (file.name.endsWith('.json')) {
                    this.importJSONFile(file);
                }
            }
        }
    }
    
    getUserFriendlyError(error, filename) {
        const errorMap = {
            'Invalid JSON': `The file "${filename}" is not a valid JSON file.`,
            'Failed to read file': `Could not read "${filename}". The file may be corrupted.`,
            'Failed to load image': `Could not load "${filename}" as an image.`,
            'Unsupported file type': `"${filename}" has an unsupported file format.`
        };
        
        for (const [key, message] of Object.entries(errorMap)) {
            if (error.message?.includes(key)) {
                return message;
            }
        }
        
        return `Failed to import "${filename}": ${error.message || 'Unknown error'}`;
    }
    
    showUndoImportToast(summary) {
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerHTML = `
            <div>Imported ${summary.count} items</div>
            <button class="undo-btn" style="margin-left: 12px; padding: 4px 8px; background: var(--accent-color); color: white; border: none; border-radius: 4px; cursor: pointer;">Undo</button>
        `;
        
        toast.querySelector('.undo-btn')?.addEventListener('click', () => {
            this.undoLastImport();
            toast.remove();
        });
        
        document.getElementById('toastContainer')?.appendChild(toast);
        
        setTimeout(() => toast.remove(), 5000);
    }
    
    undoLastImport() {
        if (!this.lastImport) return;
        
        const canvas = window.infiniteCanvas;
        if (!canvas) return;
        
        // Restore previous elements
        canvas.elements = this.lastImport.previousElements;
        canvas.render();
        window.historyManager?.pushState(canvas.elements);
        
        this.showToast('Import undone');
        this.lastImport = null;
    }
    
    setupTheme() {
        if (document.body.classList.contains('canvas-core-mode')) {
            document.documentElement.removeAttribute('data-theme');
            return;
        }

        // Check for saved theme preference
        const savedTheme = localStorage.getItem('kimi-canvas-theme');
        if (savedTheme) {
            document.documentElement.setAttribute('data-theme', savedTheme);
        } else {
            // Check system preference
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                document.documentElement.setAttribute('data-theme', 'dark');
            }
        }
    }
    
    setTheme(theme) {
        if (document.body.classList.contains('canvas-core-mode')) {
            return;
        }

        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('kimi-canvas-theme', theme);
        window.infiniteCanvas?.render();
        this.showToast(`Theme changed to ${theme.charAt(0).toUpperCase() + theme.slice(1)}`);
    }
    
    toggleTheme() {
        // Legacy toggle - cycles through light/dark
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        this.setTheme(newTheme);
    }
    
    showLoading(message = 'Loading...') {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.querySelector('span').textContent = message;
            overlay.style.display = 'flex';
        }
    }
    
    hideLoading() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
    }
    
    setupExport() {
        // Already handled in setupEventListeners
    }
    
    onSelectionChange() {
        const canvas = window.infiniteCanvas;
        
        // Update properties panel
        window.propertiesManager?.updateForSelection();
        window.aiAssistant?.updateGroundingPanel();
        
        // Selection box update is now handled in canvas.render()
        // which is called after selection changes
    }
    
    showExportModal() {
        document.getElementById('exportModal')?.classList.add('active');
    }
    
    hideExportModal() {
        document.getElementById('exportModal')?.classList.remove('active');
    }
    
    showHelpModal() {
        document.getElementById('helpModal')?.classList.add('active');
    }
    
    hideHelpModal() {
        document.getElementById('helpModal')?.classList.remove('active');
    }
    
    setupModelSelector() {
        const topModelSelect = document.getElementById('topModelSelect');
        if (topModelSelect) {
            // Set initial value from localStorage via apiManager
            const selectedModel = window.apiManager.getSelectedModel();
            if ([...topModelSelect.options].some((option) => option.value === selectedModel)) {
                topModelSelect.value = selectedModel;
            }
            
            // Handle model change
            topModelSelect.addEventListener('change', (e) => {
                window.apiManager.setSelectedModel(e.target.value);
                
                // Also update AI panel model selector if it exists
                const diagramModelSelect = document.getElementById('diagramModelSelect');
                if (diagramModelSelect) {
                    diagramModelSelect.value = e.target.value;
                }
            });
        }
    }
    
    setupAIModeToggles() {
        // Mode toggle buttons
        const chatModeBtn = document.getElementById('chatModeBtn');
        const diagramModeBtn = document.getElementById('diagramModeBtn');
        const imageModeBtn = document.getElementById('imageModeBtn');
        
        if (chatModeBtn) {
            chatModeBtn.addEventListener('click', () => {
                window.aiAssistant?.setMode('chat');
            });
        }

        if (diagramModeBtn) {
            diagramModeBtn.addEventListener('click', () => {
                window.aiAssistant?.setMode('diagram');
            });
        }
        
        if (imageModeBtn) {
            imageModeBtn.addEventListener('click', () => {
                window.aiAssistant?.setMode('image');
            });
        }
        
        // Diagram model selector
        const diagramModelSelect = document.getElementById('diagramModelSelect');
        if (diagramModelSelect) {
            const selectedModel = window.apiManager.getSelectedModel();
            if ([...diagramModelSelect.options].some((option) => option.value === selectedModel)) {
                diagramModelSelect.value = selectedModel;
            }
            diagramModelSelect.addEventListener('change', (e) => {
                window.apiManager.setSelectedModel(e.target.value);
                
                // Also update top bar selector
                const topModelSelect = document.getElementById('topModelSelect');
                if (topModelSelect) {
                    topModelSelect.value = e.target.value;
                }
            });
        }
        
        // Image model selector
        const imageModelSelect = document.getElementById('imageModelSelect');
        if (imageModelSelect) {
            imageModelSelect.addEventListener('change', (e) => {
                window.aiAssistant?.updateImageSettings('model', e.target.value);
            });
        }
        
        // Image size selector
        const imageSizeSelect = document.getElementById('imageSizeSelect');
        if (imageSizeSelect) {
            imageSizeSelect.addEventListener('change', (e) => {
                window.aiAssistant?.updateImageSettings('size', e.target.value);
            });
        }
        
        // Image quality selector
        const imageQualitySelect = document.getElementById('imageQualitySelect');
        if (imageQualitySelect) {
            imageQualitySelect.addEventListener('change', (e) => {
                window.aiAssistant?.updateImageSettings('quality', e.target.value);
            });
        }
        
        // Image style selector
        const imageStyleSelect = document.getElementById('imageStyleSelect');
        if (imageStyleSelect) {
            imageStyleSelect.addEventListener('change', (e) => {
                window.aiAssistant?.updateImageSettings('style', e.target.value);
            });
        }
        
        // Download image button
        const downloadImageBtn = document.getElementById('downloadImageBtn');
        if (downloadImageBtn) {
            downloadImageBtn.addEventListener('click', () => {
                this.downloadSelectedImage();
            });
        }
    }
    
    downloadSelectedImage() {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length === 1) {
            const el = canvas.selectedElements[0];
            if (el.type === 'image' && el.imageUrl) {
                const a = document.createElement('a');
                a.href = el.imageUrl;
                a.download = `ai-image-${Date.now()}.png`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            }
        }
    }
    
    clearCanvas() {
        if (confirm('Are you sure you want to clear the canvas? This cannot be undone.')) {
            const canvas = window.infiniteCanvas;
            canvas.elements = [];
            canvas.selectedElements = [];
            window.historyManager?.clear();
            window.historyManager?.pushState([]);
            canvas.render();
            this.onSelectionChange();
            
            // Clear auto-save
            try {
                localStorage.removeItem('kimi-canvas-autosave');
            } catch (e) {
                console.warn('Failed to clear auto-save:', e);
            }
        }
    }
    
    async exportCanvas(format, options = {}) {
        this.hideExportModal();
        
        const canvas = window.infiniteCanvas;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        
        switch (format) {
            case 'png':
                const dataURL = canvas.exportToDataURL('image/png', options);
                this.downloadFile(dataURL, `canvas-${timestamp}.png`);
                this.showToast('Exported to PNG');
                break;
                
            case 'svg':
                const svgData = this.exportToSVG(options);
                this.downloadFile('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData), `canvas-${timestamp}.svg`);
                this.showToast('Exported to SVG');
                break;
                
            case 'json':
                const jsonData = JSON.stringify(canvas.elements, null, 2);
                const blob = new Blob([jsonData], { type: 'application/json' });
                this.downloadFile(URL.createObjectURL(blob), `canvas-${timestamp}.json`);
                this.showToast('Exported to JSON');
                break;
        }
    }
    
    exportToSVG(options = {}) {
        const canvas = window.infiniteCanvas;
        
        // Calculate bounds
        const bounds = canvas.getBounds();
        const padding = options.padding !== undefined ? options.padding : 20;
        
        const width = bounds.width + padding * 2;
        const height = bounds.height + padding * 2;
        const offsetX = -bounds.x + padding;
        const offsetY = -bounds.y + padding;
        
        let svg = `<?xml version="1.0" encoding="UTF-8"?>`;
        svg += `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
        
        // Add background (unless transparent)
        if (!options.transparent) {
            const bgColor = options.backgroundColor || 
                (document.documentElement.getAttribute('data-theme') === 'dark' ? '#1e1e1e' : '#ffffff');
            svg += `<rect width="100%" height="100%" fill="${bgColor}"/>`;
        }
        
        // Export each element
        for (const el of canvas.elements) {
            svg += this.elementToSVG(el, offsetX, offsetY);
        }
        
        svg += '</svg>';
        return svg;
    }
    
    elementToSVG(el, offsetX, offsetY) {
        const x = (el.x || 0) + offsetX;
        const y = (el.y || 0) + offsetY;
        const hw = (el.width || 0) / 2;
        const hh = (el.height || 0) / 2;
        const stroke = el.strokeColor || '#000000';
        const fill = el.backgroundColor || 'none';
        const strokeWidth = el.strokeWidth || 2;
        const opacity = el.opacity ?? 1;
        
        let svg = '';
        
        switch (el.type) {
            case 'rectangle':
                svg = `<rect x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}"`;
                svg += ` fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"`;
                if (el.edgeType === 'round') {
                    const r = Math.min(el.width, el.height) * 0.1;
                    svg += ` rx="${r}" ry="${r}"`;
                }
                svg += '/>';
                // Add text if present
                if (el.text) {
                    svg += this.shapeTextToSVG(el, x, y, hw, hh, opacity);
                }
                break;
                
            case 'diamond':
                const points = `${x},${y - hh} ${x + hw},${y} ${x},${y + hh} ${x - hw},${y}`;
                svg = `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
                // Add text if present
                if (el.text) {
                    svg += this.shapeTextToSVG(el, x, y, hw, hh, opacity);
                }
                break;
                
            case 'ellipse':
                svg = `<ellipse cx="${x}" cy="${y}" rx="${hw}" ry="${hh}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
                // Add text if present
                if (el.text) {
                    svg += this.shapeTextToSVG(el, x, y, hw, hh, opacity);
                }
                break;
                
            case 'text':
                if (el.text) {
                    const lines = el.text.split('\n');
                    const lineHeight = (el.fontSize || 20) * 1.4;
                    const startY = y - (lines.length - 1) * lineHeight / 2;
                    
                    svg += `<g opacity="${opacity}">`;
                    lines.forEach((line, i) => {
                        const lineY = startY + i * lineHeight;
                        svg += `<text x="${x}" y="${lineY}" text-anchor="middle" dominant-baseline="middle" fill="${stroke}" font-size="${el.fontSize || 20}" font-family="${this.escapeXml(el.fontFamily || 'sans-serif')}">${this.escapeXml(line)}</text>`;
                    });
                    svg += '</g>';
                }
                break;
                
            case 'sticky':
                svg = `<rect x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}"`;
                svg += ` fill="${el.backgroundColor || '#ffec99'}" stroke="${el.strokeColor || '#e6b800'}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
                
                if (el.text) {
                    svg += `<text x="${x - hw + 12}" y="${y - hh + 24}" fill="${el.strokeColor || '#5c4b00'}" font-size="16" font-family="${this.escapeXml(el.fontFamily || 'Virgil, cursive')}">${this.escapeXml(el.text)}</text>`;
                }
                break;
                
            case 'line':
            case 'arrow':
                if (el.points && el.points.length >= 2) {
                    const p1 = el.points[0];
                    const p2 = el.points[1];
                    svg = `<line x1="${p1.x + offsetX}" y1="${p1.y + offsetY}" x2="${p2.x + offsetX}" y2="${p2.y + offsetY}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
                    
                    if (el.type === 'arrow') {
                        // Simple arrowhead
                        const arrowSize = Math.max(10, strokeWidth * 4);
                        const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
                        const arrowAngle1 = angle + Math.PI * 0.85;
                        const arrowAngle2 = angle - Math.PI * 0.85;
                        
                        const ax1 = p2.x + Math.cos(arrowAngle1) * arrowSize;
                        const ay1 = p2.y + Math.sin(arrowAngle1) * arrowSize;
                        const ax2 = p2.x + Math.cos(arrowAngle2) * arrowSize;
                        const ay2 = p2.y + Math.sin(arrowAngle2) * arrowSize;
                        
                        svg += `<polygon points="${p2.x + offsetX},${p2.y + offsetY} ${ax1 + offsetX},${ay1 + offsetY} ${ax2 + offsetX},${ay2 + offsetY}" fill="${stroke}" opacity="${opacity}"/>`;
                    }
                }
                break;
                
            case 'freedraw':
                if (el.points && el.points.length >= 2) {
                    // Use quadratic curves for smoother lines
                    let path = `M ${el.points[0].x + offsetX} ${el.points[0].y + offsetY}`;
                    for (let i = 1; i < el.points.length - 1; i++) {
                        const xc = (el.points[i].x + el.points[i + 1].x) / 2;
                        const yc = (el.points[i].y + el.points[i + 1].y) / 2;
                        path += ` Q ${el.points[i].x + offsetX} ${el.points[i].y + offsetY}, ${xc + offsetX} ${yc + offsetY}`;
                    }
                    if (el.points.length > 1) {
                        const last = el.points[el.points.length - 1];
                        path += ` L ${last.x + offsetX} ${last.y + offsetY}`;
                    }
                    
                    let strokeDash = '';
                    if (el.strokeStyle === 'dashed') {
                        strokeDash = ' stroke-dasharray="8,8"';
                    } else if (el.strokeStyle === 'dotted') {
                        strokeDash = ' stroke-dasharray="2,4"';
                    }
                    
                    svg = `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"${strokeDash}/>`;
                }
                break;
                
            case 'frame':
                // Frame background
                if (el.backgroundColor && el.backgroundColor !== 'transparent') {
                    svg += `<rect x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}" fill="${el.backgroundColor}" opacity="${opacity * 0.3}"/>`;
                }
                // Frame border (dashed)
                svg += `<rect x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}" fill="none" stroke="${el.strokeColor || '#999999'}" stroke-width="${strokeWidth * 2}" stroke-dasharray="5,5" opacity="${opacity}"/>`;
                // Title bar
                const titleHeight = 30;
                svg += `<rect x="${x - hw}" y="${y - hh}" width="${el.width}" height="${titleHeight}" fill="${el.strokeColor || '#999999'}" opacity="${opacity}"/>`;
                if (el.name) {
                    svg += `<text x="${x - hw + 10}" y="${y - hh + titleHeight/2}" dominant-baseline="middle" fill="#ffffff" font-size="14" font-family="system-ui, sans-serif" font-weight="bold">${this.escapeXml(el.name)}</text>`;
                }
                break;
                
            case 'image':
                if (el.imageElement && el.imageElement.src) {
                    svg += `<image x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}" href="${el.imageElement.src}" opacity="${opacity}" preserveAspectRatio="xMidYMid meet"/>`;
                } else if (el.imageUrl) {
                    svg += `<image x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}" href="${el.imageUrl}" opacity="${opacity}" preserveAspectRatio="xMidYMid meet"/>`;
                }
                break;
        }
        
        return svg;
    }
    
    escapeXml(text) {
        if (!text) return '';
        return text.replace(/[<>&'"]/g, c => ({
            '<': '&lt;',
            '>': '&gt;',
            '&': '&amp;',
            "'": '&apos;',
            '"': '&quot;'
        })[c]);
    }
    
    shapeTextToSVG(el, x, y, hw, hh, opacity) {
        if (!el.text) return '';
        
        const lines = el.text.split('\n');
        const fontSize = el.fontSize || 20;
        const lineHeight = fontSize * 1.4;
        const maxWidth = (el.width || 200) - 20; // padding
        const fontFamily = this.escapeXml(el.fontFamily || 'sans-serif');
        const fill = el.strokeColor || '#000000';
        
        let svg = `<g opacity="${opacity}">`;
        
        // Simple word wrapping
        const wrappedLines = [];
        for (const line of lines) {
            const words = line.split(' ');
            let currentLine = words[0] || '';
            
            for (let i = 1; i < words.length; i++) {
                const testLine = currentLine + ' ' + words[i];
                // Estimate width (rough approximation)
                if (testLine.length * fontSize * 0.6 < maxWidth) {
                    currentLine = testLine;
                } else {
                    wrappedLines.push(currentLine);
                    currentLine = words[i];
                }
            }
            wrappedLines.push(currentLine);
        }
        
        const totalHeight = wrappedLines.length * lineHeight;
        const startY = y - totalHeight / 2 + lineHeight / 2;
        
        wrappedLines.forEach((line, i) => {
            if (i < 5) { // Limit to 5 lines
                const lineY = startY + i * lineHeight;
                svg += `<text x="${x}" y="${lineY}" text-anchor="middle" dominant-baseline="middle" fill="${fill}" font-size="${fontSize}" font-family="${fontFamily}">${this.escapeXml(line)}</text>`;
            }
        });
        
        svg += '</g>';
        return svg;
    }
    
    downloadFile(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    importJSON() {
        // Use new import system if available
        if (window.importExportManager) {
            window.importExportManager.showImportDialog();
            return;
        }
        
        // Legacy import
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            this.importJSONFile(file);
        };
        input.click();
    }
    
    importJSONFile(file) {
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const elements = JSON.parse(event.target.result);
                this.importElements(elements);
            } catch (error) {
                console.error('Import error:', error);
                alert('Invalid JSON file');
            }
        };
        reader.readAsText(file);
    }
    
    importElements(elements) {
        if (!Array.isArray(elements)) {
            // Try to handle Lilly sketch format
            if (elements.elements && Array.isArray(elements.elements)) {
                elements = elements.elements;
            } else {
                alert('Invalid format: expected array of elements');
                return;
            }
        }
        
        const canvas = window.infiniteCanvas;
        
        // Generate new IDs for imported elements
        const newElements = elements.map(el => ({
            ...el,
            id: window.toolManager.generateId(),
            imageElement: undefined // Can't serialize image elements
        }));
        
        // Add to canvas
        for (const el of newElements) {
            canvas.addElement(el);
        }
        
        // Select imported elements
        canvas.deselectAll();
        for (const el of newElements) {
            canvas.selectElement(el, true);
        }
        
        window.historyManager?.pushState(canvas.elements);
    }
    
    async shareCanvas() {
        const canvas = window.infiniteCanvas;
        
        try {
            // Try Web Share API first (for mobile)
            if (navigator.share && navigator.canShare) {
                // Export as PNG blob
                const dataURL = canvas.exportToDataURL('image/png');
                const response = await fetch(dataURL);
                const blob = await response.blob();
                const file = new File([blob], 'canvas.png', { type: 'image/png' });
                
                if (navigator.canShare({ files: [file] })) {
                    await navigator.share({
                        title: 'My Lilly Canvas',
                        text: 'Check out my canvas!',
                        files: [file]
                    });
                    this.showToast('Shared successfully!');
                    return;
                }
            }
            
            // Fallback to clipboard
            if (navigator.clipboard) {
                // Copy canvas data as JSON
                const json = JSON.stringify(canvas.elements, null, 2);
                await navigator.clipboard.writeText(json);
                this.showToast('Canvas data copied to clipboard!');
            } else {
                throw new Error('Clipboard API not available');
            }
        } catch (error) {
            console.error('Share error:', error);
            
            // Final fallback - download JSON
            if (error.name !== 'AbortError') {
                const json = JSON.stringify(canvas.elements, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                this.downloadFile(URL.createObjectURL(blob), 'canvas-share.json');
                this.showToast('Canvas exported as JSON file');
            }
        }
    }
    
    showToast(message, type = 'info', duration = 3000) {
        const container = document.getElementById('toastContainer');
        if (!container) return;
        
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        
        container.appendChild(toast);
        
        setTimeout(() => {
            toast.style.animation = 'fadeOut 0.2s ease';
            setTimeout(() => toast.remove(), 200);
        }, duration);
    }
    
    setupTooltips() {
        // Add hover tooltips for elements with title attribute
        const tooltip = document.getElementById('tooltip');
        if (!tooltip) return;
        
        document.querySelectorAll('[title]').forEach(el => {
            const title = el.getAttribute('title');
            el.removeAttribute('title');
            el.dataset.tooltip = title;
            
            el.addEventListener('mouseenter', (e) => {
                tooltip.textContent = title;
                tooltip.classList.add('visible');
                this.positionTooltip(e, tooltip);
            });
            
            el.addEventListener('mousemove', (e) => {
                this.positionTooltip(e, tooltip);
            });
            
            el.addEventListener('mouseleave', () => {
                tooltip.classList.remove('visible');
            });
        });
    }
    
    positionTooltip(e, tooltip) {
        const x = e.clientX;
        const y = e.clientY;
        const rect = tooltip.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // Position above by default
        let top = y - rect.height - 10;
        let left = x - rect.width / 2;
        
        // Adjust if off-screen
        if (left < 10) left = 10;
        if (left + rect.width > viewportWidth - 10) left = viewportWidth - rect.width - 10;
        if (top < 10) top = y + 20;
        
        tooltip.style.top = `${top}px`;
        tooltip.style.left = `${left}px`;
    }
    
    handleAIGeneratedDiagram(payload) {
        window.aiAssistant?.processGeneratedContent({ content: payload });
    }
}

// Create global app instance
window.app = new App();
