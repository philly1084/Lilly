/**
 * Selection Module - Selection, move, resize, align, and distribute logic
 * Enhanced: Added alignment tools, better resize, multi-selection support
 */

class SelectionManager {
    constructor() {
        this.isSelecting = false;
        this.selectionBox = null;
        this.resizeHandle = null;
        this.isResizing = false;
        
        this.init();
    }
    
    init() {
        // Selection actions are handled here, but live resize interactions
        // are delegated to ToolManager to keep a single drag pipeline.
    }
    
    handleResizeStart(e, handle) {
        e.stopPropagation();
        const canvas = window.infiniteCanvas;
        
        if (canvas.selectedElements.length !== 1) return;
        
        this.isResizing = true;
        this.resizeHandle = handle.className.split(' ').find(c => 
            ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].includes(c)
        );
        this.resizeElement = canvas.selectedElements[0];
        this.resizeStartState = {
            x: this.resizeElement.x,
            y: this.resizeElement.y,
            width: this.resizeElement.width,
            height: this.resizeElement.height,
            points: this.resizeElement.points ? [...this.resizeElement.points.map(p => ({...p}))] : null
        };
        
        const rect = canvas.container.getBoundingClientRect();
        this.resizeStartX = e.clientX - rect.left;
        this.resizeStartY = e.clientY - rect.top;
    }
    
    handleResizeMove(e) {
        if (!this.isResizing || !this.resizeElement) return;
        
        const canvas = window.infiniteCanvas;
        const rect = canvas.container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        const deltaX = (x - this.resizeStartX) / canvas.scale;
        const deltaY = (y - this.resizeStartY) / canvas.scale;
        
        const el = this.resizeElement;
        const start = this.resizeStartState;
        
        let newX = start.x;
        let newY = start.y;
        let newWidth = start.width;
        let newHeight = start.height;
        
        // Handle different resize handles
        switch (this.resizeHandle) {
            case 'se':
                newWidth = Math.max(10, start.width + deltaX * 2);
                newHeight = Math.max(10, start.height + deltaY * 2);
                break;
            case 'nw':
                newWidth = Math.max(10, start.width - deltaX * 2);
                newHeight = Math.max(10, start.height - deltaY * 2);
                newX = start.x + (start.width - newWidth) / 2;
                newY = start.y + (start.height - newHeight) / 2;
                break;
            case 'ne':
                newWidth = Math.max(10, start.width + deltaX * 2);
                newHeight = Math.max(10, start.height - deltaY * 2);
                newY = start.y + (start.height - newHeight) / 2;
                break;
            case 'sw':
                newWidth = Math.max(10, start.width - deltaX * 2);
                newHeight = Math.max(10, start.height + deltaY * 2);
                newX = start.x + (start.width - newWidth) / 2;
                break;
            case 'n':
                newHeight = Math.max(10, start.height - deltaY * 2);
                newY = start.y + (start.height - newHeight) / 2;
                break;
            case 's':
                newHeight = Math.max(10, start.height + deltaY * 2);
                break;
            case 'w':
                newWidth = Math.max(10, start.width - deltaX * 2);
                newX = start.x + (start.width - newWidth) / 2;
                break;
            case 'e':
                newWidth = Math.max(10, start.width + deltaX * 2);
                break;
        }
        
        // Apply changes based on element type
        if (el.type === 'line' || el.type === 'arrow') {
            // Scale points for lines
            if (start.points && start.points.length >= 2) {
                const scaleX = newWidth / start.width;
                const scaleY = newHeight / start.height;
                
                el.points = start.points.map((p, i) => ({
                    x: (i === 0) ? p.x + (newX - start.x) : p.x + (newX - start.x) + (p.x - start.points[0].x) * (scaleX - 1),
                    y: (i === 0) ? p.y + (newY - start.y) : p.y + (newY - start.y) + (p.y - start.points[0].y) * (scaleY - 1)
                }));
            }
        } else {
            el.x = newX;
            el.y = newY;
            el.width = newWidth;
            el.height = newHeight;
        }
        
        // Constrain proportions with shift
        if (e.shiftKey && el.type !== 'line' && el.type !== 'arrow') {
            const size = Math.max(el.width, el.height);
            el.width = size;
            el.height = size;
        }
        
        canvas.render();
        window.renderer?.updateSelectionBox(el);
    }
    
    handleResizeEnd() {
        if (this.isResizing) {
            this.isResizing = false;
            this.resizeHandle = null;
            window.historyManager?.pushState(window.infiniteCanvas.elements);
        }
    }
    
    duplicateSelection() {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length === 0) return;
        
        const newElements = [];
        const offset = 20;
        
        for (const el of canvas.selectedElements) {
            const newEl = {
                ...el,
                id: window.toolManager.generateId(),
                x: el.x + offset,
                y: el.y + offset
            };
            
            // Deep copy points if they exist
            if (el.points) {
                newEl.points = el.points.map(p => ({ x: p.x + offset, y: p.y + offset }));
            }
            
            canvas.elements.push(newEl);
            newElements.push(newEl);
        }
        
        // Select new elements
        canvas.deselectAll();
        for (const el of newElements) {
            canvas.selectElement(el, true);
        }
        
        window.historyManager?.pushState(canvas.elements);
        canvas.render();
        window.app?.onCanvasElementsChanged?.();
    }
    
    bringToFront() {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length === 0) return;
        
        // Remove selected elements and add them at the end
        for (const el of canvas.selectedElements) {
            const index = canvas.elements.indexOf(el);
            if (index > -1) {
                canvas.elements.splice(index, 1);
                canvas.elements.push(el);
            }
        }
        
        window.historyManager?.pushState(canvas.elements);
        canvas.render();
        window.app?.onCanvasElementsChanged?.();
    }
    
    sendToBack() {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length === 0) return;
        
        // Remove selected elements and add them at the beginning
        for (const el of [...canvas.selectedElements].reverse()) {
            const index = canvas.elements.indexOf(el);
            if (index > -1) {
                canvas.elements.splice(index, 1);
                canvas.elements.unshift(el);
            }
        }
        
        window.historyManager?.pushState(canvas.elements);
        canvas.render();
    }
    
    // ========== ALIGNMENT TOOLS ==========
    
    alignLeft() {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length < 2) return;
        
        const minX = Math.min(...canvas.selectedElements.map(el => 
            el.x - (el.width || 0) / 2
        ));
        
        for (const el of canvas.selectedElements) {
            el.x = minX + (el.width || 0) / 2;
        }
        
        window.historyManager?.pushState(canvas.elements);
        canvas.render();
    }
    
    alignCenter() {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length < 2) return;
        
        const avgX = canvas.selectedElements.reduce((sum, el) => sum + el.x, 0) / 
                     canvas.selectedElements.length;
        
        for (const el of canvas.selectedElements) {
            el.x = avgX;
        }
        
        window.historyManager?.pushState(canvas.elements);
        canvas.render();
    }
    
    alignRight() {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length < 2) return;
        
        const maxX = Math.max(...canvas.selectedElements.map(el => 
            el.x + (el.width || 0) / 2
        ));
        
        for (const el of canvas.selectedElements) {
            el.x = maxX - (el.width || 0) / 2;
        }
        
        window.historyManager?.pushState(canvas.elements);
        canvas.render();
    }
    
    alignTop() {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length < 2) return;
        
        const minY = Math.min(...canvas.selectedElements.map(el => 
            el.y - (el.height || 0) / 2
        ));
        
        for (const el of canvas.selectedElements) {
            el.y = minY + (el.height || 0) / 2;
        }
        
        window.historyManager?.pushState(canvas.elements);
        canvas.render();
    }
    
    alignMiddle() {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length < 2) return;
        
        const avgY = canvas.selectedElements.reduce((sum, el) => sum + el.y, 0) / 
                     canvas.selectedElements.length;
        
        for (const el of canvas.selectedElements) {
            el.y = avgY;
        }
        
        window.historyManager?.pushState(canvas.elements);
        canvas.render();
    }
    
    alignBottom() {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length < 2) return;
        
        const maxY = Math.max(...canvas.selectedElements.map(el => 
            el.y + (el.height || 0) / 2
        ));
        
        for (const el of canvas.selectedElements) {
            el.y = maxY - (el.height || 0) / 2;
        }
        
        window.historyManager?.pushState(canvas.elements);
        canvas.render();
    }
    
    // ========== DISTRIBUTION TOOLS ==========
    
    distributeHorizontal() {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length < 3) return;
        
        const sorted = [...canvas.selectedElements].sort((a, b) => a.x - b.x);
        const minX = sorted[0].x;
        const maxX = sorted[sorted.length - 1].x;
        const step = (maxX - minX) / (sorted.length - 1);
        
        sorted.forEach((el, index) => {
            el.x = minX + step * index;
        });
        
        window.historyManager?.pushState(canvas.elements);
        canvas.render();
    }
    
    distributeVertical() {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length < 3) return;
        
        const sorted = [...canvas.selectedElements].sort((a, b) => a.y - b.y);
        const minY = sorted[0].y;
        const maxY = sorted[sorted.length - 1].y;
        const step = (maxY - minY) / (sorted.length - 1);
        
        sorted.forEach((el, index) => {
            el.y = minY + step * index;
        });
        
        window.historyManager?.pushState(canvas.elements);
        canvas.render();
    }
    
    // ========== GROUPING ==========
    
    groupSelection() {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length < 2) return;
        
        // Create a group element
        const groupId = window.toolManager.generateId();
        const groupElement = {
            id: groupId,
            type: 'group',
            elements: canvas.selectedElements.map(el => el.id),
            x: canvas.selectedElements.reduce((sum, el) => sum + el.x, 0) / canvas.selectedElements.length,
            y: canvas.selectedElements.reduce((sum, el) => sum + el.y, 0) / canvas.selectedElements.length
        };
        
        // Tag elements as grouped
        for (const el of canvas.selectedElements) {
            el.groupId = groupId;
        }
        
        canvas.addElement(groupElement);
        window.historyManager?.pushState(canvas.elements);
    }
    
    ungroupSelection() {
        const canvas = window.infiniteCanvas;
        
        for (const el of canvas.selectedElements) {
            if (el.groupId) {
                el.groupId = null;
            }
            if (el.type === 'group') {
                // Remove group element and ungroup its children
                const index = canvas.elements.indexOf(el);
                if (index > -1) {
                    canvas.elements.splice(index, 1);
                }
                for (const childEl of canvas.elements) {
                    if (el.elements.includes(childEl.id)) {
                        childEl.groupId = null;
                    }
                }
            }
        }
        
        window.historyManager?.pushState(canvas.elements);
        canvas.render();
    }
}

// Create global instance
window.selectionManager = new SelectionManager();
