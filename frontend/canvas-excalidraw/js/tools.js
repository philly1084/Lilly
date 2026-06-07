/**
 * Tools Module - Tool definitions and behaviors
 * Fixed: Proper resize handles, move logic, double-click text editing, multi-select, copy/paste
 * Enhanced: Small shape feedback, touch handling
 */

class ToolManager {
    constructor() {
        this.currentTool = 'selection';
        this.supportedTools = new Set([
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
        ]);
        this.isDrawing = false;
        this.isMoving = false;
        this.isResizing = false;
        this.resizeHandle = null;
        this.startPos = null;
        this.currentElement = null;
        this.lastElementId = 0;
        
        // Clipboard for copy/paste
        this.clipboard = [];
        this.clipboardOffset = 0;
        
        // Default properties
        this.defaultProperties = {
            strokeColor: '#000000',
            backgroundColor: 'transparent',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            edgeType: 'sharp',
            opacity: 1,
            fontSize: 20,
            fontFamily: 'Virgil, cursive',
            // Text styling defaults
            textAlign: 'center',
            bold: false,
            italic: false,
            underline: false,
            strikethrough: false,
            textTransform: 'none',
            letterSpacing: 0,
            lineHeight: 1.4,
            textShadow: false,
            textShadowColor: 'rgba(0,0,0,0.3)',
            textShadowBlur: 2
        };
        
        this.init();
    }
    
    init() {
        // Tool button clicks
        document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setTool(btn.dataset.tool);
            });
        });
        
        // Canvas interactions
        const canvas = document.getElementById('canvasContainer');
        canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        canvas.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
        
        window.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        window.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
        
        window.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        window.addEventListener('touchend', (e) => this.handleTouchEnd(e));
        
        // Double-click for text editing
        canvas.addEventListener('dblclick', (e) => this.handleDoubleClick(e));
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));
        document.addEventListener('keyup', (e) => this.handleKeyUp(e));
        
        // Space key for panning
        this.spacePressed = false;
        
        // Paste handler
        document.addEventListener('paste', (e) => this.handlePaste(e));
        
        // Initialize resize handles
        this.initResizeHandles();
    }

    getSupportedTools() {
        return Array.from(this.supportedTools);
    }

    isSupportedTool(toolName) {
        return this.supportedTools.has(toolName);
    }
    
    initResizeHandles() {
        const selectionBox = document.getElementById('selectionBox');
        if (selectionBox) {
            selectionBox.querySelectorAll('.resize-handle').forEach(handle => {
                handle.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                    this.startResize(e, handle);
                });
                
                // Touch support for resize handles
                handle.addEventListener('touchstart', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    this.startResize(e.touches[0], handle);
                }, { passive: false });
            });
        }
    }
    
    setTool(toolName) {
        if (!this.isSupportedTool(toolName)) {
            toolName = 'selection';
        }

        // Cancel any active operations
        if (this.isDrawing) {
            this.cancelDrawing();
        }
        
        this.currentTool = toolName;
        
        // Update UI
        document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            btn.classList.remove('active');
        });
        const btn = document.querySelector(`.tool-btn[data-tool="${toolName}"]`);
        if (btn) btn.classList.add('active');
        
        // Update cursor
        const container = document.getElementById('canvasContainer');
        container.className = 'canvas-container';
        container.style.cursor = ''; // Reset cursor
        
        switch (toolName) {
            case 'selection':
                container.style.cursor = 'default';
                break;
            case 'text':
                container.classList.add('texting');
                container.style.cursor = 'text';
                break;
            case 'freedraw':
                container.classList.add('drawing');
                container.style.cursor = 'crosshair';
                break;
            case 'eraser':
                container.classList.add('drawing');
                container.style.cursor = 'cell';
                break;
            case 'ai-image':
                container.style.cursor = 'crosshair';
                // Show tooltip
                const tooltip = document.getElementById('aiImageTooltip');
                if (tooltip) tooltip.style.display = 'block';
                break;
            case 'stickers':
                container.style.cursor = 'default';
                // Show stickers panel
                window.stickersManager?.showStickersPanel();
                break;
            default:
                container.classList.add('drawing');
                container.style.cursor = 'crosshair';
                break;
        }
        
        // Hide AI image tooltip when switching to other tools
        if (toolName !== 'ai-image') {
            const tooltip = document.getElementById('aiImageTooltip');
            if (tooltip) tooltip.style.display = 'none';
        }
        
        // Deselect if switching away from selection
        if (toolName !== 'selection') {
            window.infiniteCanvas.deselectAll();
        }
        
        // Close any open text editors
        const textEditor = document.getElementById('textEditor');
        if (textEditor && textEditor.style.display === 'block') {
            textEditor.blur();
        }
        
        // Close mobile toolbar after selection on mobile
        if (window.matchMedia('(max-width: 768px)').matches) {
            document.getElementById('toolbar')?.classList.remove('active');
        }
    }
    
    cancelDrawing() {
        const canvas = window.infiniteCanvas;
        if (this.currentElement) {
            // Remove incomplete element
            canvas.elements = canvas.elements.filter(
                el => el.id !== this.currentElement.id
            );
        }
        this.isDrawing = false;
        this.currentElement = null;
        canvas.render();
    }
    
    generateId() {
        return `el-${Date.now()}-${++this.lastElementId}`;
    }
    
    getElementProperties() {
        return { ...this.defaultProperties };
    }
    
    updateDefaultProperties(props) {
        this.defaultProperties = { ...this.defaultProperties, ...props };
    }
    
    handleMouseDown(e) {
        if (e.button !== 0) return;
        this.handleInputStart(e.clientX, e.clientY, e);
    }
    
    handleTouchStart(e) {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        const touch = e.touches[0];
        this.handleInputStart(touch.clientX, touch.clientY, e);
    }
    
    handleInputStart(clientX, clientY, originalEvent) {
        // Space+drag for panning - handled by canvas.js
        if (this.spacePressed) return;

        if (originalEvent?.cancelable) {
            originalEvent.preventDefault();
        }

        const canvas = window.infiniteCanvas;
        const rect = canvas.container.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const worldPos = canvas.screenToWorld(x, y);
        
        // Snap to grid if enabled
        if (canvas.snapToGrid) {
            worldPos.x = canvas.snapToGridValue(worldPos.x);
            worldPos.y = canvas.snapToGridValue(worldPos.y);
        }
        
        this.startPos = worldPos;

        if (!this.isSupportedTool(this.currentTool)) {
            this.setTool('selection');
        }
        
        switch (this.currentTool) {
            case 'selection':
                this.handleSelectionStart(originalEvent, worldPos);
                break;
            case 'rectangle':
                this.startShape('rectangle', worldPos);
                break;
            case 'diamond':
                this.startShape('diamond', worldPos);
                break;
            case 'ellipse':
                this.startShape('ellipse', worldPos);
                break;
            case 'triangle':
                this.startShape('triangle', worldPos);
                break;
            case 'star':
                this.startShape('star', worldPos, { points: 5 });
                break;
            case 'heart':
                this.startShape('heart', worldPos);
                break;
            case 'cloud':
                this.startShape('cloud', worldPos);
                break;
            case 'cylinder':
                this.startShape('cylinder', worldPos);
                break;
            case 'cube':
                this.startShape('cube', worldPos);
                break;
            case 'speechBubble':
                this.startShape('speechBubble', worldPos);
                break;
            case 'line':
                this.startLine('line', worldPos);
                break;
            case 'arrow':
                this.startLine('arrow', worldPos, { arrowhead: 'end' });
                break;
            case 'doubleArrow':
                this.startLine('arrow', worldPos, { arrowhead: 'both' });
                break;
            case 'curvedArrow':
                this.startCurvedArrow(worldPos);
                break;
            case 'elbowArrow':
                this.startElbowArrow(worldPos);
                break;
            case 'connector':
                this.startConnector(worldPos);
                break;
            case 'freedraw':
                this.startFreedraw(worldPos);
                break;
            case 'text':
                this.createText(worldPos);
                break;
            case 'eraser':
                this.eraseAt(worldPos);
                break;
            case 'image':
                this.handleImageTool(worldPos);
                break;
            case 'sticky':
                this.createSticky(worldPos);
                break;
            case 'frame':
                this.startFrame(worldPos);
                break;
            case 'ai-image':
                this.handleAIImageTool(worldPos);
                break;
        }
    }
    
    handleMouseMove(e) {
        this.handleInputMove(e.clientX, e.clientY, e);
    }
    
    handleTouchMove(e) {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        const touch = e.touches[0];
        this.handleInputMove(touch.clientX, touch.clientY, e);
    }
    
    handleInputMove(clientX, clientY, originalEvent) {
        const canvas = window.infiniteCanvas;
        const rect = canvas.container.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const worldPos = canvas.screenToWorld(x, y);
        
        // Snap to grid if enabled
        if (canvas.snapToGrid && (this.isDrawing || this.isResizing)) {
            worldPos.x = canvas.snapToGridValue(worldPos.x);
            worldPos.y = canvas.snapToGridValue(worldPos.y);
        }
        
        // Update cursor based on what we're hovering
        this.updateCursor(worldPos);
        
        if (this.isDrawing && this.currentElement) {
            this.updateElement(worldPos, originalEvent.shiftKey);
            canvas.render();
        } else if (this.isMoving && canvas.selectedElements.length > 0) {
            this.moveElements(worldPos);
        } else if (this.isResizing && canvas.selectedElements.length > 0) {
            this.resizeElement(worldPos, originalEvent.shiftKey);
        } else if (canvas.isSelecting) {
            canvas.updateSelectionBox(worldPos.x, worldPos.y);
        }
    }
    
    handleMouseUp(e) {
        this.handleInputEnd();
    }
    
    handleTouchEnd(e) {
        this.handleInputEnd();
    }
    
    handleInputEnd() {
        const canvas = window.infiniteCanvas;
        let shapeTooSmall = false;
        let completedElement = null;
        
        if (this.isDrawing && this.currentElement) {
            // Finalize element
            const el = this.currentElement;
            const minSize = 5;
            const minPoints = 3; // Minimum points for freedraw
            
            if (el.type === 'freedraw') {
                // For freedraw, check number of points
                shapeTooSmall = !el.points || el.points.length < minPoints;
            } else if (el.type === 'line' || el.type === 'arrow') {
                // For lines, check if there's actual length
                shapeTooSmall = !el.points || el.points.length < 2 || 
                          (Math.abs(el.points[1].x - el.points[0].x) < minSize && 
                           Math.abs(el.points[1].y - el.points[0].y) < minSize);
            } else {
                // For shapes, check dimensions
                shapeTooSmall = el.width < minSize && el.height < minSize;
            }
            
            if (shapeTooSmall) {
                // Too small, remove it and show toast
                canvas.elements = canvas.elements.filter(
                    existingEl => existingEl.id !== this.currentElement.id
                );
                
                // Show toast notification
                window.app?.showToast?.('Shape too small', 'error', 2000);
            } else {
                // Ensure freedraw has valid bounding box
                if (el.type === 'freedraw' && el.points && el.points.length > 0) {
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                    for (const p of el.points) {
                        minX = Math.min(minX, p.x);
                        minY = Math.min(minY, p.y);
                        maxX = Math.max(maxX, p.x);
                        maxY = Math.max(maxY, p.y);
                    }
                    el.x = (minX + maxX) / 2;
                    el.y = (minY + maxY) / 2;
                    el.width = Math.max(1, maxX - minX);
                    el.height = Math.max(1, maxY - minY);
                }
                
                // Save to history
                window.historyManager?.pushState(canvas.elements);
                completedElement = el;
            }
            
            this.isDrawing = false;
            this.currentElement = null;
            canvas.render();
        }
        
        if (this.isMoving) {
            if (this.hasMoved) {
                window.historyManager?.pushState(canvas.elements);
            }
            this.isMoving = false;
            this.moveStartPositions = null;
            this.hasMoved = false;
        }
        
        if (this.isResizing) {
            window.historyManager?.pushState(canvas.elements);
            this.isResizing = false;
            this.resizeHandle = null;
            this.resizeStartElement = null;
        }
        
        if (canvas.isSelecting) {
            canvas.endSelectionBox();
        }

        if (completedElement && this.shouldAutoReturnToSelection(completedElement.type)) {
            this.setTool('selection');
            canvas.selectElement(completedElement);
        }
    }

    shouldAutoReturnToSelection(elementType) {
        return !['freedraw'].includes(elementType);
    }
    
    updateCursor(worldPos) {
        const canvas = window.infiniteCanvas;
        const container = document.getElementById('canvasContainer');
        
        if (this.currentTool !== 'selection') return;
        
        // Check for resize handles first
        if (canvas.selectedElements.length === 1) {
            const handle = this.getResizeHandleAt(worldPos);
            if (handle) {
                container.style.cursor = handle.cursor;
                return;
            }
        }
        
        // Check for element hover
        const element = canvas.getElementAt(worldPos.x, worldPos.y);
        if (element) {
            container.style.cursor = 'move';
        } else {
            container.style.cursor = 'default';
        }
    }
    
    handleSelectionStart(e, worldPos) {
        const canvas = window.infiniteCanvas;
        const clickedElement = canvas.getElementAt(worldPos.x, worldPos.y);
        
        // Check resize handles first
        if (canvas.selectedElements.length === 1) {
            const handle = this.getResizeHandleAt(worldPos);
            if (handle) {
                this.isResizing = true;
                this.resizeHandle = handle.position;
                this.resizeStartElement = JSON.parse(JSON.stringify(canvas.selectedElements[0]));
                return;
            }
        }
        
        if (clickedElement) {
            if (e.shiftKey) {
                // Add to/remove from selection
                if (canvas.selectedElements.includes(clickedElement)) {
                    canvas.selectedElements = canvas.selectedElements.filter(el => el !== clickedElement);
                } else {
                    canvas.selectedElements.push(clickedElement);
                }
                canvas.selectElements(canvas.selectedElements);
            } else if (!canvas.selectedElements.includes(clickedElement)) {
                // Select single
                canvas.selectElement(clickedElement);
            }
            
            // Start moving
            this.isMoving = true;
            this.hasMoved = false;
            this.moveStartPos = worldPos;
            this.moveStartPositions = canvas.selectedElements.map(el => ({
                id: el.id,
                x: el.x,
                y: el.y,
                points: el.points ? JSON.parse(JSON.stringify(el.points)) : null
            }));
        } else {
            // Start selection box
            if (!e.shiftKey) {
                canvas.deselectAll();
            }
            canvas.startSelectionBox(worldPos.x, worldPos.y);
        }
    }
    
    getResizeHandleAt(pos) {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length !== 1) return null;
        
        const el = canvas.selectedElements[0];
        
        // Use larger handle size on touch devices
        const isTouch = window.matchMedia('(pointer: coarse)').matches;
        const handleSize = (isTouch ? 20 : 10) / canvas.scale;
        const padding = isTouch ? 8 : 4;
        
        // Get element bounds
        let bounds;
        if (el.type === 'line' || el.type === 'arrow' || el.type === 'connector') {
            if (!el.points || el.points.length < 2) return null;
            const p1 = el.points[0];
            const p2 = el.points[el.points.length - 1];
            bounds = {
                x: Math.min(p1.x, p2.x) - padding,
                y: Math.min(p1.y, p2.y) - padding,
                width: Math.abs(p2.x - p1.x) + padding * 2,
                height: Math.abs(p2.y - p1.y) + padding * 2
            };
        } else if (el.type === 'curvedArrow' || el.type === 'elbowArrow') {
            if (!el.points || el.points.length < 3) return null;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of el.points) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            }
            bounds = {
                x: minX - padding,
                y: minY - padding,
                width: maxX - minX + padding * 2,
                height: maxY - minY + padding * 2
            };
        } else if (el.type === 'freedraw') {
            if (!el.points || el.points.length === 0) return null;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of el.points) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            }
            bounds = {
                x: minX - padding,
                y: minY - padding,
                width: maxX - minX + padding * 2,
                height: maxY - minY + padding * 2
            };
        } else {
            bounds = {
                x: el.x - el.width / 2 - padding,
                y: el.y - el.height / 2 - padding,
                width: el.width + padding * 2,
                height: el.height + padding * 2
            };
        }
        
        // Define handle positions
        const handles = [
            { pos: 'nw', x: bounds.x, y: bounds.y, cursor: 'nw-resize' },
            { pos: 'n', x: bounds.x + bounds.width / 2, y: bounds.y, cursor: 'n-resize' },
            { pos: 'ne', x: bounds.x + bounds.width, y: bounds.y, cursor: 'ne-resize' },
            { pos: 'e', x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2, cursor: 'e-resize' },
            { pos: 'se', x: bounds.x + bounds.width, y: bounds.y + bounds.height, cursor: 'se-resize' },
            { pos: 's', x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height, cursor: 's-resize' },
            { pos: 'sw', x: bounds.x, y: bounds.y + bounds.height, cursor: 'sw-resize' },
            { pos: 'w', x: bounds.x, y: bounds.y + bounds.height / 2, cursor: 'w-resize' }
        ];
        
        for (const handle of handles) {
            const dx = pos.x - handle.x;
            const dy = pos.y - handle.y;
            if (Math.abs(dx) <= handleSize && Math.abs(dy) <= handleSize) {
                return handle;
            }
        }
        
        return null;
    }
    
    startResize(e, handle) {
        this.isResizing = true;
        this.resizeHandle = handle.classList.contains('nw') ? 'nw' :
                            handle.classList.contains('n') ? 'n' :
                            handle.classList.contains('ne') ? 'ne' :
                            handle.classList.contains('e') ? 'e' :
                            handle.classList.contains('se') ? 'se' :
                            handle.classList.contains('s') ? 's' :
                            handle.classList.contains('sw') ? 'sw' :
                            handle.classList.contains('w') ? 'w' : 'se';
        this.resizeStartElement = JSON.parse(JSON.stringify(window.infiniteCanvas.selectedElements[0]));
    }
    
    moveElements(worldPos) {
        const canvas = window.infiniteCanvas;
        const dx = worldPos.x - this.moveStartPos.x;
        const dy = worldPos.y - this.moveStartPos.y;
        
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            this.hasMoved = true;
        }
        
        for (const el of canvas.selectedElements) {
            const startPos = this.moveStartPositions.find(p => p.id === el.id);
            if (startPos) {
                el.x = startPos.x + dx;
                el.y = startPos.y + dy;
                
                // For lines/arrows/freedraw, update points directly from saved positions
                if (el.points && startPos.points) {
                    el.points = startPos.points.map(p => ({
                        x: p.x + dx,
                        y: p.y + dy
                    }));
                }
            }
        }
        
        canvas.render();
        window.renderer?.updateSelectionBox(canvas.selectedElements[0]);
    }
    
    resizeElement(worldPos, constrain) {
        const canvas = window.infiniteCanvas;
        const el = canvas.selectedElements[0];
        const start = this.resizeStartElement;
        
        if (!start) return;
        
        // Calculate deltas based on resize handle
        let dx = 0, dy = 0;
        
        switch (this.resizeHandle) {
            case 'se':
                dx = worldPos.x - (start.x + start.width / 2);
                dy = worldPos.y - (start.y + start.height / 2);
                break;
            case 'nw':
                dx = (start.x - start.width / 2) - worldPos.x;
                dy = (start.y - start.height / 2) - worldPos.y;
                break;
            case 'ne':
                dx = worldPos.x - (start.x + start.width / 2);
                dy = (start.y - start.height / 2) - worldPos.y;
                break;
            case 'sw':
                dx = (start.x - start.width / 2) - worldPos.x;
                dy = worldPos.y - (start.y + start.height / 2);
                break;
            case 'n':
                dy = (start.y - start.height / 2) - worldPos.y;
                break;
            case 's':
                dy = worldPos.y - (start.y + start.height / 2);
                break;
            case 'w':
                dx = (start.x - start.width / 2) - worldPos.x;
                break;
            case 'e':
                dx = worldPos.x - (start.x + start.width / 2);
                break;
        }
        
        let newWidth = Math.max(10, start.width + dx * (this.resizeHandle.includes('w') ? 2 : this.resizeHandle.includes('e') ? 2 : 0));
        let newHeight = Math.max(10, start.height + dy * (this.resizeHandle.includes('n') ? 2 : this.resizeHandle.includes('s') ? 2 : 0));
        
        // Constrain proportions with shift
        if (constrain && el.type !== 'line' && el.type !== 'arrow') {
            const aspectRatio = start.width / start.height;
            if (newWidth / newHeight > aspectRatio) {
                newWidth = newHeight * aspectRatio;
            } else {
                newHeight = newWidth / aspectRatio;
            }
        }
        
        // Apply changes based on element type
        if (el.type === 'line' || el.type === 'arrow') {
            if (start.points && start.points.length >= 2) {
                const scaleX = newWidth / start.width;
                const scaleY = newHeight / start.height;
                
                // Update based on which handle is being dragged
                if (this.resizeHandle === 'se' || this.resizeHandle === 'e' || this.resizeHandle === 's') {
                    el.points[1] = {
                        x: start.points[0].x + (start.points[1].x - start.points[0].x) * scaleX,
                        y: start.points[0].y + (start.points[1].y - start.points[0].y) * scaleY
                    };
                } else if (this.resizeHandle === 'nw' || this.resizeHandle === 'w' || this.resizeHandle === 'n') {
                    el.points[0] = {
                        x: start.points[1].x - (start.points[1].x - start.points[0].x) * scaleX,
                        y: start.points[1].y - (start.points[1].y - start.points[0].y) * scaleY
                    };
                }
                
                el.x = (el.points[0].x + el.points[1].x) / 2;
                el.y = (el.points[0].y + el.points[1].y) / 2;
                el.width = Math.abs(el.points[1].x - el.points[0].x);
                el.height = Math.abs(el.points[1].y - el.points[0].y);
            }
        } else {
            // Calculate new position based on handle
            if (this.resizeHandle === 'se') {
                // Bottom-right: center stays same
                el.width = newWidth;
                el.height = newHeight;
            } else if (this.resizeHandle === 'nw') {
                // Top-left: move center
                el.x = start.x - (newWidth - start.width) / 2;
                el.y = start.y - (newHeight - start.height) / 2;
                el.width = newWidth;
                el.height = newHeight;
            } else if (this.resizeHandle === 'ne') {
                el.x = start.x + (newWidth - start.width) / 2;
                el.y = start.y - (newHeight - start.height) / 2;
                el.width = newWidth;
                el.height = newHeight;
            } else if (this.resizeHandle === 'sw') {
                el.x = start.x - (newWidth - start.width) / 2;
                el.y = start.y + (newHeight - start.height) / 2;
                el.width = newWidth;
                el.height = newHeight;
            } else if (this.resizeHandle === 'n') {
                el.y = start.y - (newHeight - start.height) / 2;
                el.height = newHeight;
            } else if (this.resizeHandle === 's') {
                el.y = start.y + (newHeight - start.height) / 2;
                el.height = newHeight;
            } else if (this.resizeHandle === 'w') {
                el.x = start.x - (newWidth - start.width) / 2;
                el.width = newWidth;
            } else if (this.resizeHandle === 'e') {
                el.x = start.x + (newWidth - start.width) / 2;
                el.width = newWidth;
            }
        }
        
        canvas.render();
        window.renderer?.updateSelectionBox(el);
    }
    
    startShape(type, pos, options = {}) {
        this.isDrawing = true;
        this.currentElement = {
            id: this.generateId(),
            type: type,
            x: pos.x,
            y: pos.y,
            width: 0,
            height: 0,
            ...this.getElementProperties(),
            ...options
        };
        window.infiniteCanvas.elements.push(this.currentElement);
    }
    
    startCurvedArrow(pos) {
        this.isDrawing = true;
        this.currentElement = {
            id: this.generateId(),
            type: 'curvedArrow',
            x: pos.x,
            y: pos.y,
            points: [{ x: pos.x, y: pos.y }, { x: pos.x + 100, y: pos.y - 50 }, { x: pos.x + 200, y: pos.y }],
            width: 200,
            height: 100,
            ...this.getElementProperties(),
            arrowhead: 'end'
        };
        window.infiniteCanvas.elements.push(this.currentElement);
    }
    
    startElbowArrow(pos) {
        this.isDrawing = true;
        this.currentElement = {
            id: this.generateId(),
            type: 'elbowArrow',
            x: pos.x,
            y: pos.y,
            points: [{ x: pos.x, y: pos.y }, { x: pos.x, y: pos.y + 100 }, { x: pos.x + 150, y: pos.y + 100 }],
            width: 150,
            height: 100,
            ...this.getElementProperties(),
            arrowhead: 'end'
        };
        window.infiniteCanvas.elements.push(this.currentElement);
    }
    
    startConnector(pos) {
        this.isDrawing = true;
        this.currentElement = {
            id: this.generateId(),
            type: 'connector',
            x: pos.x,
            y: pos.y,
            points: [{ x: pos.x, y: pos.y }, { x: pos.x + 150, y: pos.y }],
            width: 150,
            height: 0,
            ...this.getElementProperties(),
            connectorStyle: 'straight'
        };
        window.infiniteCanvas.elements.push(this.currentElement);
    }
    
    startLine(type, pos, options = {}) {
        this.isDrawing = true;
        this.currentElement = {
            id: this.generateId(),
            type: type,
            x: pos.x,
            y: pos.y,
            points: [{ x: pos.x, y: pos.y }, { x: pos.x, y: pos.y }],
            width: 0,
            height: 0,
            ...this.getElementProperties(),
            ...options
        };
        window.infiniteCanvas.elements.push(this.currentElement);
    }
    
    startFreedraw(pos) {
        this.isDrawing = true;
        this.currentElement = {
            id: this.generateId(),
            type: 'freedraw',
            x: pos.x,
            y: pos.y,
            points: [{ x: pos.x, y: pos.y }],
            width: 0,
            height: 0,
            ...this.getElementProperties()
        };
        window.infiniteCanvas.elements.push(this.currentElement);
    }
    
    startFrame(pos) {
        this.isDrawing = true;
        this.currentElement = {
            id: this.generateId(),
            type: 'frame',
            x: pos.x,
            y: pos.y,
            width: 0,
            height: 0,
            name: 'Frame',
            ...this.getElementProperties()
        };
        window.infiniteCanvas.elements.push(this.currentElement);
    }
    
    updateElement(pos, constrain) {
        if (!this.currentElement) return;
        
        const el = this.currentElement;
        const canvas = window.infiniteCanvas;
        
        // Snap to grid if enabled
        let snappedPos = { ...pos };
        if (canvas.snapToGrid) {
            snappedPos.x = canvas.snapToGridValue(pos.x);
            snappedPos.y = canvas.snapToGridValue(pos.y);
        }
        
        switch (el.type) {
            case 'rectangle':
            case 'diamond':
            case 'ellipse':
            case 'frame':
            case 'sticky':
            case 'triangle':
            case 'star':
            case 'heart':
            case 'cloud':
            case 'cylinder':
            case 'cube':
            case 'speechBubble':
                let width = snappedPos.x - this.startPos.x;
                let height = snappedPos.y - this.startPos.y;
                
                if (constrain) {
                    const size = Math.max(Math.abs(width), Math.abs(height));
                    width = width < 0 ? -size : size;
                    height = height < 0 ? -size : size;
                }
                
                el.x = this.startPos.x + width / 2;
                el.y = this.startPos.y + height / 2;
                el.width = Math.abs(width);
                el.height = Math.abs(height);
                
                // Default size for sticky note
                if (el.type === 'sticky' && el.width < 100 && el.height < 100) {
                    el.width = Math.max(el.width, 200);
                    el.height = Math.max(el.height, 200);
                }
                break;
                
            case 'line':
            case 'arrow':
                el.points[1] = { x: snappedPos.x, y: snappedPos.y };
                el.x = (el.points[0].x + snappedPos.x) / 2;
                el.y = (el.points[0].y + snappedPos.y) / 2;
                el.width = Math.abs(el.points[1].x - el.points[0].x);
                el.height = Math.abs(el.points[1].y - el.points[0].y);
                
                // Constrain to 45-degree angles with shift
                if (constrain && el.points.length >= 2) {
                    const dx = el.points[1].x - el.points[0].x;
                    const dy = el.points[1].y - el.points[0].y;
                    const angle = Math.atan2(dy, dx);
                    const constrainedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    
                    el.points[1] = {
                        x: el.points[0].x + Math.cos(constrainedAngle) * distance,
                        y: el.points[0].y + Math.sin(constrainedAngle) * distance
                    };
                    el.x = (el.points[0].x + el.points[1].x) / 2;
                    el.y = (el.points[0].y + el.points[1].y) / 2;
                }
                break;
                
            case 'curvedArrow':
                // Update control point and end point
                el.points[2] = { x: snappedPos.x, y: snappedPos.y };
                el.points[1] = { 
                    x: (el.points[0].x + snappedPos.x) / 2, 
                    y: snappedPos.y 
                };
                el.x = (el.points[0].x + snappedPos.x) / 2;
                el.y = (el.points[0].y + snappedPos.y) / 2;
                el.width = Math.abs(snappedPos.x - el.points[0].x);
                el.height = Math.abs(snappedPos.y - el.points[0].y);
                break;
                
            case 'elbowArrow':
                // Update elbow point and end point
                el.points[1] = { x: el.points[0].x, y: snappedPos.y };
                el.points[2] = { x: snappedPos.x, y: snappedPos.y };
                el.x = (el.points[0].x + snappedPos.x) / 2;
                el.y = (el.points[0].y + snappedPos.y) / 2;
                el.width = Math.abs(snappedPos.x - el.points[0].x);
                el.height = Math.abs(snappedPos.y - el.points[0].y);
                break;
                
            case 'connector':
                el.points[1] = { x: snappedPos.x, y: snappedPos.y };
                el.x = (el.points[0].x + snappedPos.x) / 2;
                el.y = (el.points[0].y + snappedPos.y) / 2;
                el.width = Math.abs(el.points[1].x - el.points[0].x);
                el.height = Math.abs(el.points[1].y - el.points[0].y);
                break;
                
            case 'freedraw':
                // Don't snap freedraw points for smoother lines
                el.points.push({ x: pos.x, y: pos.y });
                // Update bounding box
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const p of el.points) {
                    minX = Math.min(minX, p.x);
                    minY = Math.min(minY, p.y);
                    maxX = Math.max(maxX, p.x);
                    maxY = Math.max(maxY, p.y);
                }
                el.x = (minX + maxX) / 2;
                el.y = (minY + maxY) / 2;
                el.width = maxX - minX;
                el.height = maxY - minY;
                break;
        }
    }
    
    createText(pos) {
        const textEditor = document.getElementById('textEditor');
        const canvas = window.infiniteCanvas;
        const screenPos = canvas.worldToScreen(pos.x, pos.y);
        
        // Clean up any existing handlers
        if (this._textEditorBlurHandler) {
            textEditor.removeEventListener('blur', this._textEditorBlurHandler);
            this._textEditorBlurHandler = null;
        }
        if (this._textEditorKeyHandler) {
            textEditor.removeEventListener('keydown', this._textEditorKeyHandler);
            this._textEditorKeyHandler = null;
        }
        
        // Position text editor
        textEditor.style.display = 'block';
        textEditor.style.left = screenPos.x + 'px';
        textEditor.style.top = (screenPos.y - 40) + 'px';
        textEditor.style.width = '200px';
        textEditor.style.height = '80px';
        textEditor.style.transform = 'translate(-50%, 0)';
        textEditor.value = '';
        textEditor.focus();
        
        // Store position for element creation
        textEditor.dataset.posX = pos.x;
        textEditor.dataset.posY = pos.y;
        
        // Handle text completion
        this._textEditorBlurHandler = () => {
            const text = textEditor.value.trim();
            if (text) {
                const element = {
                    id: this.generateId(),
                    type: 'text',
                    x: parseFloat(textEditor.dataset.posX),
                    y: parseFloat(textEditor.dataset.posY),
                    text: text,
                    width: 200,
                    height: 40,
                    ...this.getElementProperties()
                };
                canvas.addElement(element);
                window.historyManager?.pushState(canvas.elements);
                this.setTool('selection');
                canvas.selectElement(element);
            }
            textEditor.style.display = 'none';
            textEditor.style.background = '';
            textEditor.removeEventListener('blur', this._textEditorBlurHandler);
            this._textEditorBlurHandler = null;
        };
        
        // Handle Enter key to finish (Shift+Enter for new line)
        this._textEditorKeyHandler = (e) => {
            if (e.key === 'Escape') {
                textEditor.value = ''; // Cancel
                textEditor.blur();
            }
        };
        
        textEditor.addEventListener('blur', this._textEditorBlurHandler);
        textEditor.addEventListener('keydown', this._textEditorKeyHandler);
    }
    
    createSticky(pos) {
        const canvas = window.infiniteCanvas;
        const element = {
            id: this.generateId(),
            type: 'sticky',
            x: pos.x,
            y: pos.y,
            width: 200,
            height: 200,
            text: '',
            backgroundColor: '#ffec99',
            strokeColor: '#e6b800',
            roughness: 0,
            strokeWidth: 1
        };
        canvas.addElement(element);
        window.historyManager?.pushState(canvas.elements);
        this.setTool('selection');
        
        // Immediately start editing
        setTimeout(() => {
            canvas.selectElement(element);
            this.editStickyText(element);
        }, 50);
    }
    
    editStickyText(element) {
        const textEditor = document.getElementById('textEditor');
        const canvas = window.infiniteCanvas;
        const screenPos = canvas.worldToScreen(element.x, element.y);
        const screenSize = {
            width: element.width * canvas.scale,
            height: element.height * canvas.scale
        };
        
        // Clean up any existing handlers
        if (this._editStickyBlurHandler) {
            textEditor.removeEventListener('blur', this._editStickyBlurHandler);
            this._editStickyBlurHandler = null;
        }
        
        textEditor.style.display = 'block';
        textEditor.style.left = screenPos.x + 'px';
        textEditor.style.top = screenPos.y + 'px';
        textEditor.style.width = (screenSize.width - 24) + 'px';
        textEditor.style.height = (screenSize.height - 24) + 'px';
        textEditor.style.transform = 'translate(-50%, -50%)';
        textEditor.style.background = 'transparent';
        textEditor.style.border = 'none';
        textEditor.style.resize = 'none';
        textEditor.value = element.text || '';
        textEditor.focus();
        
        this._editStickyBlurHandler = () => {
            element.text = textEditor.value.trim();
            canvas.render();
            window.historyManager?.pushState(canvas.elements);
            textEditor.style.display = 'none';
            textEditor.style.background = '';
            textEditor.style.border = '';
            textEditor.style.resize = '';
            textEditor.removeEventListener('blur', this._editStickyBlurHandler);
            this._editStickyBlurHandler = null;
        };
        
        textEditor.addEventListener('blur', this._editStickyBlurHandler);
    }
    
    eraseAt(pos) {
        const canvas = window.infiniteCanvas;
        const element = canvas.getElementAt(pos.x, pos.y);
        if (element) {
            canvas.removeElement(element.id);
            window.historyManager?.pushState(canvas.elements);
        }
    }
    
    handleImageTool(pos) {
        const input = document.getElementById('imageInput');
        input.dataset.posX = pos.x;
        input.dataset.posY = pos.y;
        input.click();
    }
    
    handleAIImageTool(pos) {
        // Set the position for the image to be placed
        window.aiAssistant?.setImagePosition(pos);
        
        // Switch to image generation mode
        window.aiAssistant?.setMode('image');
        
        // Open AI panel
        window.aiAssistant?.showPanel();
        
        // Reset tool to selection
        this.setTool('selection');
    }
    
    handleDoubleClick(e) {
        if (this.currentTool !== 'selection') return;
        
        const canvas = window.infiniteCanvas;
        const rect = canvas.container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const worldPos = canvas.screenToWorld(x, y);
        
        const element = canvas.getElementAt(worldPos.x, worldPos.y);
        
        if (element && element.type === 'text') {
            this.editText(element);
        } else if (element && element.type === 'sticky') {
            this.editStickyText(element);
        }
    }
    
    editText(element) {
        const textEditor = document.getElementById('textEditor');
        const canvas = window.infiniteCanvas;
        const screenPos = canvas.worldToScreen(element.x, element.y);
        
        // Clean up any existing handlers
        if (this._editTextBlurHandler) {
            textEditor.removeEventListener('blur', this._editTextBlurHandler);
            this._editTextBlurHandler = null;
        }
        
        textEditor.style.display = 'block';
        textEditor.style.left = screenPos.x + 'px';
        textEditor.style.top = (screenPos.y - 40) + 'px';
        textEditor.style.width = '200px';
        textEditor.style.height = '80px';
        textEditor.style.transform = 'translate(-50%, 0)';
        textEditor.value = element.text || '';
        textEditor.focus();
        
        this._editTextBlurHandler = () => {
            const text = textEditor.value.trim();
            if (text) {
                element.text = text;
                canvas.render();
                window.historyManager?.pushState(canvas.elements);
            } else {
                // Delete empty text elements
                canvas.removeElement(element.id);
                canvas.deselectAll();
                canvas.render();
                window.historyManager?.pushState(canvas.elements);
            }
            textEditor.style.display = 'none';
            textEditor.style.background = '';
            textEditor.removeEventListener('blur', this._editTextBlurHandler);
            this._editTextBlurHandler = null;
        };
        
        textEditor.addEventListener('blur', this._editTextBlurHandler);
    }
    
    // Copy selected elements
    copySelection() {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length === 0) return;
        
        // Deep copy elements
        this.clipboard = canvas.selectedElements.map(el => ({
            ...el,
            points: el.points ? JSON.parse(JSON.stringify(el.points)) : undefined,
            imageElement: undefined // Can't copy image elements directly
        }));
        this.clipboardOffset = 0;
    }
    
    // Cut selected elements
    cutSelection() {
        this.copySelection();
        const canvas = window.infiniteCanvas;
        for (const el of canvas.selectedElements) {
            canvas.removeElement(el.id);
        }
        canvas.deselectAll();
        window.historyManager?.pushState(canvas.elements);
    }
    
    // Paste elements
    paste() {
        if (this.clipboard.length === 0) return;
        
        const canvas = window.infiniteCanvas;
        this.clipboardOffset += 20;
        
        const newElements = this.clipboard.map(el => {
            const newEl = {
                ...el,
                id: this.generateId(),
                x: el.x + this.clipboardOffset,
                y: el.y + this.clipboardOffset
            };
            
            // Offset points
            if (el.points) {
                newEl.points = el.points.map(p => ({
                    x: p.x + this.clipboardOffset,
                    y: p.y + this.clipboardOffset
                }));
            }
            
            return newEl;
        });
        
        // Add to canvas
        for (const el of newElements) {
            canvas.elements.push(el);
        }
        
        // Select new elements
        canvas.deselectAll();
        for (const el of newElements) {
            canvas.selectElement(el, true);
        }
        
        window.historyManager?.pushState(canvas.elements);
        canvas.render();
    }
    
    handlePaste(e) {
        // First try internal clipboard
        if (this.clipboard.length > 0 && !e.clipboardData?.items?.length) {
            e.preventDefault();
            this.paste();
            return;
        }
        
        // Handle external paste (images from clipboard)
        if (e.clipboardData && e.clipboardData.items) {
            const items = e.clipboardData.items;
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image') !== -1) {
                    const blob = items[i].getAsFile();
                    if (blob) {
                        this.loadImageFromFile(blob);
                    }
                    e.preventDefault();
                    return;
                }
            }
        }
    }
    
    loadImageFromFile(file, pos = null) {
        const canvas = window.infiniteCanvas;
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                // Get position - use provided pos or center of view
                let x, y;
                if (pos) {
                    x = pos.x;
                    y = pos.y;
                } else {
                    const viewportCenter = canvas.getViewportCenter?.() || {
                        x: (canvas.canvas.clientWidth || canvas.canvas.width) / 2,
                        y: (canvas.canvas.clientHeight || canvas.canvas.height) / 2,
                    };
                    const center = canvas.screenToWorld(viewportCenter.x, viewportCenter.y);
                    x = center.x;
                    y = center.y;
                }
                
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
                
                const element = {
                    id: this.generateId(),
                    type: 'image',
                    x: x,
                    y: y,
                    width: width,
                    height: height,
                    imageElement: img,
                    ...this.getElementProperties()
                };
                
                canvas.addElement(element);
                window.historyManager?.pushState(canvas.elements);
            };
            img.onerror = () => {
                console.error('Failed to load pasted image');
            };
            img.src = event.target.result;
        };
        reader.onerror = () => {
            console.error('Failed to read file');
        };
        reader.readAsDataURL(file);
    }
    
    handleKeyDown(e) {
        // Space key for panning
        if (e.code === 'Space' && !e.repeat && !this.spacePressed) {
            this.spacePressed = true;
            if (!this.isDrawing) {
                document.getElementById('canvasContainer').classList.add('panning');
            }
        }
        
        // Tool shortcuts (only when not in text input and not using modifiers)
        const isInputActive = document.activeElement.tagName === 'TEXTAREA' || 
                              document.activeElement.tagName === 'INPUT';
        
        if (!e.ctrlKey && !e.metaKey && !e.altKey && !isInputActive) {
            switch (e.key.toLowerCase()) {
                case 'v':
                case '1':
                    this.setTool('selection');
                    break;
                case 'r':
                case '2':
                    this.setTool('rectangle');
                    break;
                case 'o':
                case '4':
                    this.setTool('ellipse');
                    break;
                case 't':
                    this.setTool('triangle');
                    break;
                case 'd':
                case '3':
                    this.setTool('diamond');
                    break;
                case '*':
                    this.setTool('star');
                    break;
                case 'a':
                case '5':
                    this.setTool('arrow');
                    break;
                case 'l':
                case '6':
                    this.setTool('line');
                    break;
                case 'p':
                case '7':
                    this.setTool('freedraw');
                    break;
                case 'x':
                case '8':
                    this.setTool('text');
                    break;
                case 'e':
                case '9':
                    this.setTool('eraser');
                    break;
                case 'i':
                case '0':
                    this.setTool('image');
                    break;
                case 's':
                    this.setTool('sticky');
                    break;
                case 'f':
                    this.setTool('frame');
                    break;
                case 'g':
                    this.setTool('ai-image');
                    break;
                case 'k':
                    this.setTool('stickers');
                    break;
                case 'z':
                    this.setTool('ai-assistant');
                    if (window.aiAssistant) {
                        window.aiAssistant.showPanel();
                    }
                    break;
                case 'h':
                    this.setTool('heart');
                    break;
                case 'c':
                    this.setTool('cloud');
                    break;
                case 'y':
                    this.setTool('cylinder');
                    break;
                case 'b':
                    this.setTool('cube');
                    break;
                case 'u':
                    this.setTool('speechBubble');
                    break;
            }
        }
        
        // Delete key (only when not in input)
        if ((e.key === 'Delete' || e.key === 'Backspace') && !isInputActive) {
            const canvas = window.infiniteCanvas;
            if (canvas.selectedElements.length > 0) {
                for (const el of canvas.selectedElements) {
                    canvas.removeElement(el.id);
                }
                canvas.deselectAll();
                window.historyManager?.pushState(canvas.elements);
            }
        }
    }
    
    handleKeyUp(e) {
        if (e.code === 'Space') {
            this.spacePressed = false;
            document.getElementById('canvasContainer').classList.remove('panning');
        }
    }
}

// Create global instance
window.toolManager = new ToolManager();
