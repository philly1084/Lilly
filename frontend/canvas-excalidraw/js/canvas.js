/**
 * Canvas Module - Infinite Canvas with Pan/Zoom
 * Fixed: Proper space+drag panning, touch support, better zoom handling
 */

class InfiniteCanvas {
    constructor() {
        this.canvas = document.getElementById('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.container = document.getElementById('canvasContainer');
        
        // View state
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        this.pixelRatioX = 1;
        this.pixelRatioY = 1;
        this.viewportWidth = 0;
        this.viewportHeight = 0;
        
        // Pan state
        this.isPanning = false;
        this.lastPanX = 0;
        this.lastPanY = 0;
        this.spacePressed = false;
        this.middleMouseDown = false;
        
        // Elements storage
        this.elements = [];
        this.selectedElements = [];
        
        // Grid snapping
        this.snapToGrid = false;
        this.gridSize = 20;
        
        // Multi-select box
        this.isSelecting = false;
        this.selectionStart = null;
        this.selectionBox = { x: 0, y: 0, width: 0, height: 0 };
        
        // Touch handling
        this.touches = [];
        this.lastTouchDistance = 0;
        this.lastTouchCenter = null;
        
        // Initialize
        this.init();
    }
    
    init() {
        this.resize();
        this.setupResizeObservers();
        
        // Mouse events
        this.container.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        window.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        window.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        
        // Touch events
        this.container.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
        this.container.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
        this.container.addEventListener('touchend', (e) => this.handleTouchEnd(e));
        this.container.addEventListener('touchcancel', (e) => this.handleTouchEnd(e));
        
        // Zoom with wheel
        this.container.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });
        
        // Context menu is owned by the app shell so desktop and touch share actions.
        this.container.addEventListener('contextmenu', (e) => {
            if (!window.app?.handleCanvasContextMenu?.(e)) {
                e.preventDefault();
            }
        });
        
        // Mouse move for AI image tooltip
        this.container.addEventListener('mousemove', (e) => this.handleMouseMoveForTooltip(e));
        
        // Keyboard shortcuts for zoom and space
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));
        document.addEventListener('keyup', (e) => this.handleKeyUp(e));
        
        // Center the view initially
        this.centerView();
    }
    
    resize() {
        const rect = this.container.getBoundingClientRect();
        const cssWidth = Math.max(1, rect.width);
        const cssHeight = Math.max(1, rect.height);
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const backingWidth = Math.max(1, Math.round(cssWidth * dpr));
        const backingHeight = Math.max(1, Math.round(cssHeight * dpr));

        this.viewportWidth = cssWidth;
        this.viewportHeight = cssHeight;
        this.pixelRatioX = backingWidth / cssWidth;
        this.pixelRatioY = backingHeight / cssHeight;

        this.canvas.style.width = `${cssWidth}px`;
        this.canvas.style.height = `${cssHeight}px`;

        if (this.canvas.width !== backingWidth || this.canvas.height !== backingHeight) {
            this.canvas.width = backingWidth;
            this.canvas.height = backingHeight;
        }

        this.ctx.setTransform(
            backingWidth / cssWidth,
            0,
            0,
            backingHeight / cssHeight,
            0,
            0
        );
        this.render();
    }

    setupResizeObservers() {
        let resizeFrame = null;
        const scheduleResize = () => {
            if (resizeFrame !== null) return;
            resizeFrame = requestAnimationFrame(() => {
                resizeFrame = null;
                this.resize();
            });
        };

        window.addEventListener('resize', scheduleResize);
        window.visualViewport?.addEventListener('resize', scheduleResize);
        window.visualViewport?.addEventListener('scroll', scheduleResize);

        if (window.ResizeObserver) {
            this.resizeObserver = new ResizeObserver(scheduleResize);
            this.resizeObserver.observe(this.container);
        }
    }

    getViewportSize() {
        return {
            width: this.viewportWidth || this.container.getBoundingClientRect().width,
            height: this.viewportHeight || this.container.getBoundingClientRect().height,
        };
    }

    getViewportCenter() {
        const size = this.getViewportSize();
        return {
            x: size.width / 2,
            y: size.height / 2,
        };
    }
    
    centerView() {
        const center = this.getViewportCenter();
        this.offsetX = center.x;
        this.offsetY = center.y;
        this.updateZoomDisplay();
        this.render();
    }
    
    handleMouseDown(e) {
        const rect = this.container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        // Middle mouse or Space+click to pan
        if (e.button === 1 || (e.button === 0 && this.spacePressed)) {
            this.isPanning = true;
            this.lastPanX = e.clientX;
            this.lastPanY = e.clientY;
            this.container.classList.add('panning');
            e.preventDefault();
            return;
        }
        
        // Right-click opens the app context menu.
        if (e.button === 2) {
            e.preventDefault();
            return;
        }
    }
    
    handleMouseMove(e) {
        // Panning
        if (this.isPanning) {
            const dx = e.clientX - this.lastPanX;
            const dy = e.clientY - this.lastPanY;
            this.offsetX += dx;
            this.offsetY += dy;
            this.lastPanX = e.clientX;
            this.lastPanY = e.clientY;
            this.render();
            return;
        }
    }
    
    handleMouseUp(e) {
        if (this.isPanning) {
            this.isPanning = false;
            this.middleMouseDown = false;
            this.container.classList.remove('panning');
        }
    }
    
    handleTouchStart(e) {
        this.touches = Array.from(e.touches);
        
        if (this.touches.length === 1) {
            // Single touch - could be drawing or panning
            const touch = this.touches[0];
            this.lastPanX = touch.clientX;
            this.lastPanY = touch.clientY;
        } else if (this.touches.length === 2) {
            // Two finger pinch/pan
            e.preventDefault();
            const touch1 = this.touches[0];
            const touch2 = this.touches[1];
            
            this.lastTouchDistance = Math.hypot(
                touch2.clientX - touch1.clientX,
                touch2.clientY - touch1.clientY
            );
            this.lastTouchCenter = {
                x: (touch1.clientX + touch2.clientX) / 2,
                y: (touch1.clientY + touch2.clientY) / 2
            };
        }
    }
    
    handleTouchMove(e) {
        this.touches = Array.from(e.touches);
        
        if (this.touches.length === 2) {
            e.preventDefault();
            const touch1 = this.touches[0];
            const touch2 = this.touches[1];
            
            // Calculate new distance and center
            const distance = Math.hypot(
                touch2.clientX - touch1.clientX,
                touch2.clientY - touch1.clientY
            );
            const center = {
                x: (touch1.clientX + touch2.clientX) / 2,
                y: (touch1.clientY + touch2.clientY) / 2
            };
            
            if (this.lastTouchDistance > 0) {
                // Zoom
                const scaleFactor = distance / this.lastTouchDistance;
                const rect = this.container.getBoundingClientRect();
                const zoomCenterX = center.x - rect.left;
                const zoomCenterY = center.y - rect.top;
                
                this.zoomAt(zoomCenterX, zoomCenterY, scaleFactor);
            }
            
            if (this.lastTouchCenter) {
                // Pan
                const dx = center.x - this.lastTouchCenter.x;
                const dy = center.y - this.lastTouchCenter.y;
                this.offsetX += dx;
                this.offsetY += dy;
                this.render();
            }
            
            this.lastTouchDistance = distance;
            this.lastTouchCenter = center;
        } else if (this.touches.length === 1 && window.toolManager?.currentTool === 'selection') {
            // Single touch pan in selection mode
            const touch = this.touches[0];
            const dx = touch.clientX - this.lastPanX;
            const dy = touch.clientY - this.lastPanY;
            this.offsetX += dx;
            this.offsetY += dy;
            this.lastPanX = touch.clientX;
            this.lastPanY = touch.clientY;
            this.render();
            e.preventDefault();
        }
    }
    
    handleTouchEnd(e) {
        this.touches = Array.from(e.touches);
        this.lastTouchDistance = 0;
        this.lastTouchCenter = null;
    }
    
    handleWheel(e) {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const rect = this.container.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
            this.zoomAt(mouseX, mouseY, zoomFactor);
        } else {
            // Normal scroll - pan vertically or horizontally
            e.preventDefault();
            const dx = e.deltaX * -1;
            const dy = e.deltaY * -1;
            this.offsetX += dx;
            this.offsetY += dy;
            this.render();
        }
    }
    
    handleKeyDown(e) {
        // Track space key for panning
        if (e.code === 'Space' && !e.repeat && !this.spacePressed) {
            this.spacePressed = true;
            if (!window.toolManager?.isDrawing) {
                this.container.classList.add('panning');
            }
        }
        
        // Zoom shortcuts (Ctrl/Cmd + 0/-/=)
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
            const key = e.key;
            if (key === '=' || key === '+' || key === 'NumpadAdd') {
                e.preventDefault();
                this.zoomIn();
            } else if (key === '-' || key === 'NumpadSubtract' || key === '_') {
                e.preventDefault();
                this.zoomOut();
            } else if (key === '0' || key === 'Numpad0') {
                e.preventDefault();
                this.resetZoom();
            }
        }
    }
    
    handleKeyUp(e) {
        if (e.code === 'Space') {
            this.spacePressed = false;
            this.container.classList.remove('panning');
        }
    }
    
    zoomAt(x, y, factor) {
        // Calculate world position before zoom
        const worldX = (x - this.offsetX) / this.scale;
        const worldY = (y - this.offsetY) / this.scale;
        
        // Apply zoom with limits
        const newScale = Math.max(0.1, Math.min(10, this.scale * factor));
        
        // Adjust offset to zoom towards mouse
        this.offsetX = x - worldX * newScale;
        this.offsetY = y - worldY * newScale;
        this.scale = newScale;
        
        this.updateZoomDisplay();
        this.render();
    }
    
    zoomIn() {
        const center = this.getViewportCenter();
        this.zoomAt(center.x, center.y, 1.2);
    }
    
    zoomOut() {
        const center = this.getViewportCenter();
        this.zoomAt(center.x, center.y, 0.833);
    }
    
    resetZoom() {
        this.scale = 1;
        this.centerView();
    }
    
    updateZoomDisplay() {
        const zoomLevel = document.getElementById('zoomLevel');
        if (zoomLevel) {
            zoomLevel.textContent = Math.round(this.scale * 100) + '%';
        }
    }
    
    // Coordinate transformations
    screenToWorld(x, y) {
        return {
            x: (x - this.offsetX) / this.scale,
            y: (y - this.offsetY) / this.scale
        };
    }
    
    worldToScreen(x, y) {
        return {
            x: x * this.scale + this.offsetX,
            y: y * this.scale + this.offsetY
        };
    }
    
    // Snap value to grid
    snapToGridValue(value) {
        if (!this.snapToGrid) return value;
        return Math.round(value / this.gridSize) * this.gridSize;
    }
    
    // Toggle grid snapping
    toggleSnapToGrid() {
        this.snapToGrid = !this.snapToGrid;
        return this.snapToGrid;
    }
    
    // Add element to canvas
    addElement(element) {
        // Snap to grid if enabled
        if (this.snapToGrid && element.type !== 'line' && element.type !== 'arrow' && element.type !== 'freedraw') {
            element.x = this.snapToGridValue(element.x);
            element.y = this.snapToGridValue(element.y);
            if (element.width) element.width = Math.max(this.gridSize, this.snapToGridValue(element.width));
            if (element.height) element.height = Math.max(this.gridSize, this.snapToGridValue(element.height));
        }
        
        this.elements.push(element);
        this.render();
    }
    
    // Remove element
    removeElement(elementId) {
        this.elements = this.elements.filter(el => el.id !== elementId);
        this.selectedElements = this.selectedElements.filter(el => el.id !== elementId);
        this.render();
    }
    
    // Get element at position
    getElementAt(x, y, padding = 0) {
        // Search in reverse order (top to bottom)
        for (let i = this.elements.length - 1; i >= 0; i--) {
            const el = this.elements[i];
            if (this.hitTest(el, x, y, padding)) {
                return el;
            }
        }
        return null;
    }
    
    // Hit test for an element
    hitTest(element, x, y, padding = 0) {
        if (!element) return false;
        
        const halfWidth = (element.width || 0) / 2 + padding;
        const halfHeight = (element.height || 0) / 2 + padding;
        
        switch (element.type) {
            case 'rectangle':
            case 'diamond':
            case 'ellipse':
            case 'text':
            case 'image':
            case 'sticky':
            case 'frame':
            case 'triangle':
            case 'star':
            case 'heart':
            case 'cloud':
            case 'cylinder':
            case 'cube':
            case 'speechBubble':
                return x >= element.x - halfWidth && 
                       x <= element.x + halfWidth &&
                       y >= element.y - halfHeight && 
                       y <= element.y + halfHeight;
            
            case 'line':
            case 'arrow':
            case 'connector':
                if (element.points && element.points.length >= 2) {
                    return this.pointToLineDistance(x, y, element.points[0], element.points[element.points.length - 1]) < 10 + padding;
                }
                return false;
            
            case 'curvedArrow':
            case 'elbowArrow':
                if (element.points && element.points.length >= 3) {
                    // Check distance to each line segment
                    for (let i = 0; i < element.points.length - 1; i++) {
                        if (this.pointToLineDistance(x, y, element.points[i], element.points[i + 1]) < 10 + padding) {
                            return true;
                        }
                    }
                }
                return false;
            
            case 'freedraw':
                if (element.points) {
                    for (const point of element.points) {
                        const dx = x - point.x;
                        const dy = y - point.y;
                        if (Math.sqrt(dx * dx + dy * dy) < 10 + padding) return true;
                    }
                }
                return false;
            
            default:
                return false;
        }
    }
    
    // Calculate distance from point to line segment
    pointToLineDistance(px, py, p1, p2) {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        
        if (len === 0) return Math.sqrt((px - p1.x) ** 2 + (py - p1.y) ** 2);
        
        const t = Math.max(0, Math.min(1, ((px - p1.x) * dx + (py - p1.y) * dy) / (len * len)));
        const projX = p1.x + t * dx;
        const projY = p1.y + t * dy;
        
        return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
    }
    
    // Get elements in rectangle (for multi-select)
    getElementsInRect(x1, y1, x2, y2) {
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        
        return this.elements.filter(el => {
            const halfWidth = (el.width || 0) / 2;
            const halfHeight = (el.height || 0) / 2;
            const elMinX = el.x - halfWidth;
            const elMaxX = el.x + halfWidth;
            const elMinY = el.y - halfHeight;
            const elMaxY = el.y + halfHeight;
            
            return elMaxX >= minX && elMinX <= maxX && elMaxY >= minY && elMinY <= maxY;
        });
    }
    
    // Select element(s)
    selectElement(element, addToSelection = false) {
        if (!addToSelection) {
            this.selectedElements = [];
        }
        if (element && !this.selectedElements.includes(element)) {
            this.selectedElements.push(element);
        }
        window.app?.onSelectionChange();
        this.render();
    }
    
    // Select multiple elements
    selectElements(elements) {
        this.selectedElements = [...elements];
        window.app?.onSelectionChange();
        this.render();
    }
    
    // Deselect all
    deselectAll() {
        this.selectedElements = [];
        this.isSelecting = false;
        this.selectionStart = null;
        window.app?.onSelectionChange();
        this.render();
    }
    
    // Start selection box
    startSelectionBox(x, y) {
        this.isSelecting = true;
        this.selectionStart = { x, y };
        this.selectionBox = { x, y, width: 0, height: 0 };
    }
    
    // Update selection box
    updateSelectionBox(x, y) {
        if (!this.isSelecting || !this.selectionStart) return;
        
        this.selectionBox.x = Math.min(this.selectionStart.x, x);
        this.selectionBox.y = Math.min(this.selectionStart.y, y);
        this.selectionBox.width = Math.abs(x - this.selectionStart.x);
        this.selectionBox.height = Math.abs(y - this.selectionStart.y);
        
        // Select elements in the box
        const selected = this.getElementsInRect(
            this.selectionBox.x,
            this.selectionBox.y,
            x,
            y
        );
        
        this.selectedElements = selected;
        window.app?.onSelectionChange();
        this.render();
    }
    
    // End selection box
    endSelectionBox() {
        this.isSelecting = false;
        this.selectionStart = null;
        this.selectionBox = { x: 0, y: 0, width: 0, height: 0 };
        this.render();
    }
    
    // Render the canvas
    render() {
        // Clear canvas
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.setTransform(this.pixelRatioX, 0, 0, this.pixelRatioY, 0, 0);
        
        // Save context state
        this.ctx.save();
        
        // Apply transform
        this.ctx.translate(this.offsetX, this.offsetY);
        this.ctx.scale(this.scale, this.scale);
        
        // Draw grid
        this.drawGrid();
        
        // Render all elements
        for (const element of this.elements) {
            window.renderer?.drawElement(this.ctx, element);
        }
        
        // Render selection highlights
        for (const element of this.selectedElements) {
            window.renderer?.drawSelection(this.ctx, element);
        }
        
        // Render selection box if active
        if (this.isSelecting) {
            this.drawSelectionBox();
        }
        
        // Restore context
        this.ctx.restore();
        
        // Update DOM selection box (must be done after restore since it uses screen coords)
        this.updateDomSelectionBox();
    }
    
    // Update the DOM-based selection box for HTML-based resize handles
    updateDomSelectionBox() {
        const selectionBox = document.getElementById('selectionBox');
        if (!selectionBox) return;
        
        // Only show for single selection with valid element
        if (this.selectedElements.length !== 1) {
            selectionBox.style.display = 'none';
            return;
        }
        
        const el = this.selectedElements[0];
        const padding = 4;
        
        let x, y, w, h;
        
        if (el.type === 'line' || el.type === 'arrow') {
            if (!el.points || el.points.length < 2) return;
            const p1 = el.points[0];
            const p2 = el.points[1];
            x = Math.min(p1.x, p2.x) - padding;
            y = Math.min(p1.y, p2.y) - padding;
            w = Math.abs(p2.x - p1.x) + padding * 2;
            h = Math.abs(p2.y - p1.y) + padding * 2;
        } else if (el.type === 'freedraw') {
            if (!el.points || el.points.length === 0) return;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of el.points) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            }
            x = minX - padding;
            y = minY - padding;
            w = maxX - minX + padding * 2;
            h = maxY - minY + padding * 2;
        } else {
            x = el.x - el.width / 2 - padding;
            y = el.y - el.height / 2 - padding;
            w = el.width + padding * 2;
            h = el.height + padding * 2;
        }
        
        // Convert to screen coordinates
        const screenPos = this.worldToScreen(x, y);
        
        selectionBox.style.display = 'block';
        selectionBox.style.left = screenPos.x + 'px';
        selectionBox.style.top = screenPos.y + 'px';
        selectionBox.style.width = (w * this.scale) + 'px';
        selectionBox.style.height = (h * this.scale) + 'px';
    }
    
    drawGrid() {
        const gridSize = this.gridSize;
        const majorGridSize = this.gridSize * 5;
        
        // Calculate visible area in world coordinates
        const topLeft = this.screenToWorld(0, 0);
        const size = this.getViewportSize();
        const bottomRight = this.screenToWorld(size.width, size.height);
        
        const startX = Math.floor(topLeft.x / gridSize) * gridSize;
        const endX = Math.ceil(bottomRight.x / gridSize) * gridSize;
        const startY = Math.floor(topLeft.y / gridSize) * gridSize;
        const endY = Math.ceil(bottomRight.y / gridSize) * gridSize;
        
        // Adjust opacity based on zoom
        const gridAlpha = Math.min(0.5, 0.3 + (1 - this.scale) * 0.2);
        
        this.ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--grid-color').trim();
        this.ctx.lineWidth = 1 / this.scale;
        
        // Draw minor grid lines
        this.ctx.beginPath();
        for (let x = startX; x <= endX; x += gridSize) {
            this.ctx.moveTo(x, startY);
            this.ctx.lineTo(x, endY);
        }
        for (let y = startY; y <= endY; y += gridSize) {
            this.ctx.moveTo(startX, y);
            this.ctx.lineTo(endX, y);
        }
        this.ctx.globalAlpha = gridAlpha * 0.6;
        this.ctx.stroke();
        this.ctx.globalAlpha = 1;
        
        // Draw major grid lines
        this.ctx.beginPath();
        this.ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();
        for (let x = Math.floor(startX / majorGridSize) * majorGridSize; x <= endX; x += majorGridSize) {
            this.ctx.moveTo(x, startY);
            this.ctx.lineTo(x, endY);
        }
        for (let y = Math.floor(startY / majorGridSize) * majorGridSize; y <= endY; y += majorGridSize) {
            this.ctx.moveTo(startX, y);
            this.ctx.lineTo(endX, y);
        }
        this.ctx.globalAlpha = gridAlpha * 0.3;
        this.ctx.stroke();
        this.ctx.globalAlpha = 1;
    }
    
    drawSelectionBox() {
        this.ctx.save();
        this.ctx.strokeStyle = '#a8a5ff';
        this.ctx.lineWidth = 1 / this.scale;
        this.ctx.setLineDash([5, 5]);
        this.ctx.fillStyle = 'rgba(168, 165, 255, 0.1)';
        this.ctx.fillRect(
            this.selectionBox.x,
            this.selectionBox.y,
            this.selectionBox.width,
            this.selectionBox.height
        );
        this.ctx.strokeRect(
            this.selectionBox.x,
            this.selectionBox.y,
            this.selectionBox.width,
            this.selectionBox.height
        );
        this.ctx.restore();
    }
    
    // Export canvas as data URL
    exportToDataURL(type = 'image/png', options = {}) {
        // Create a temporary canvas for export
        const exportCanvas = document.createElement('canvas');
        
        // Calculate bounds of all elements
        if (this.elements.length === 0) {
            return this.canvas.toDataURL(type);
        }
        
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        
        for (const el of this.elements) {
            const halfWidth = (el.width || 0) / 2;
            const halfHeight = (el.height || 0) / 2;
            minX = Math.min(minX, el.x - halfWidth);
            minY = Math.min(minY, el.y - halfHeight);
            maxX = Math.max(maxX, el.x + halfWidth);
            maxY = Math.max(maxY, el.y + halfHeight);
            
            // For freedraw, check all points
            if (el.points && el.type === 'freedraw') {
                for (const p of el.points) {
                    minX = Math.min(minX, p.x);
                    minY = Math.min(minY, p.y);
                    maxX = Math.max(maxX, p.x);
                    maxY = Math.max(maxY, p.y);
                }
            }
        }
        
        // Add padding
        const padding = options.padding !== undefined ? options.padding : 20;
        minX -= padding;
        minY -= padding;
        maxX += padding;
        maxY += padding;
        
        exportCanvas.width = maxX - minX;
        exportCanvas.height = maxY - minY;
        
        const ctx = exportCanvas.getContext('2d');
        
        // Fill background (unless transparent)
        if (!options.transparent) {
            const bgColor = options.backgroundColor || 
                (document.documentElement.getAttribute('data-theme') === 'dark' ? '#1e1e1e' : '#ffffff');
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
        }
        
        // Render elements
        ctx.translate(-minX, -minY);
        for (const element of this.elements) {
            window.renderer?.drawElement(ctx, element);
        }
        
        return exportCanvas.toDataURL(type);
    }
    
    // Get canvas bounds
    getBounds() {
        if (this.elements.length === 0) {
            const size = this.getViewportSize();
            return { x: 0, y: 0, width: size.width, height: size.height };
        }
        
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        
        for (const el of this.elements) {
            const halfWidth = (el.width || 0) / 2;
            const halfHeight = (el.height || 0) / 2;
            minX = Math.min(minX, el.x - halfWidth);
            minY = Math.min(minY, el.y - halfHeight);
            maxX = Math.max(maxX, el.x + halfWidth);
            maxY = Math.max(maxY, el.y + halfHeight);
            
            if (el.points && el.type === 'freedraw') {
                for (const p of el.points) {
                    minX = Math.min(minX, p.x);
                    minY = Math.min(minY, p.y);
                    maxX = Math.max(maxX, p.x);
                    maxY = Math.max(maxY, p.y);
                }
            }
        }
        
        return {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY
        };
    }
    
    // Handle mouse move for showing AI image revised prompt tooltip
    handleMouseMoveForTooltip(e) {
        const rect = this.container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const worldPos = this.screenToWorld(x, y);
        
        // Find AI-generated image under cursor
        const element = this.getElementAt(worldPos.x, worldPos.y);
        
        if (element && element.type === 'image' && element.aiGenerated && element.revisedPrompt) {
            this.showRevisedPromptTooltip(e.clientX, e.clientY, element.revisedPrompt);
        } else {
            this.hideRevisedPromptTooltip();
        }
    }
    
    showRevisedPromptTooltip(x, y, prompt) {
        let tooltip = document.getElementById('revisedPromptTooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'revisedPromptTooltip';
            tooltip.className = 'revised-prompt-tooltip';
            document.body.appendChild(tooltip);
        }
        
        tooltip.innerHTML = `<strong>Revised Prompt:</strong><br>${this.escapeHtml(prompt)}`;
        tooltip.style.left = (x + 10) + 'px';
        tooltip.style.top = (y + 10) + 'px';
        tooltip.style.display = 'block';
    }
    
    hideRevisedPromptTooltip() {
        const tooltip = document.getElementById('revisedPromptTooltip');
        if (tooltip) {
            tooltip.style.display = 'none';
        }
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Create global instance
window.infiniteCanvas = new InfiniteCanvas();
