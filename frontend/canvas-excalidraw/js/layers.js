/**
 * Layers Module - Layer management system for the canvas
 * Features: Add, delete, duplicate, merge, reorder layers
 */

class Layer {
    constructor(id, name = 'Layer', visible = true, locked = false) {
        this.id = id || `layer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        this.name = name;
        this.visible = visible;
        this.locked = locked;
        this.elements = []; // Element IDs that belong to this layer
    }
}

class LayersManager {
    constructor() {
        this.layers = [];
        this.activeLayerId = null;
        this.layerCounter = 1;
        
        this.init();
    }
    
    init() {
        // Create default layer
        const defaultLayer = new Layer('layer-default', 'Layer 1', true, false);
        this.layers.push(defaultLayer);
        this.activeLayerId = defaultLayer.id;
        
        // Wait for DOM to be ready
        document.addEventListener('DOMContentLoaded', () => {
            this.setupEventListeners();
            this.renderLayersList();
        });
        
        // Hook into canvas element management
        this.hookCanvasMethods();
    }
    
    setupEventListeners() {
        // Add layer button
        document.getElementById('addLayerBtn')?.addEventListener('click', () => {
            this.addLayer();
        });
        
        // Duplicate layer button
        document.getElementById('duplicateLayerBtn')?.addEventListener('click', () => {
            this.duplicateActiveLayer();
        });
        
        // Delete layer button
        document.getElementById('deleteLayerBtn')?.addEventListener('click', () => {
            this.deleteActiveLayer();
        });
        
        // Merge layer button
        document.getElementById('mergeLayerBtn')?.addEventListener('click', () => {
            this.mergeActiveLayerDown();
        });
        
        // Update button states
        this.updateLayerControls();
    }
    
    hookCanvasMethods() {
        // Hook into addElement to assign new elements to active layer
        const canvas = window.infiniteCanvas;
        if (canvas) {
            const originalAddElement = canvas.addElement.bind(canvas);
            canvas.addElement = (element) => {
                // Assign element to active layer
                if (this.activeLayerId && this.getActiveLayer()?.visible) {
                    element.layerId = this.activeLayerId;
                    const layer = this.getLayer(this.activeLayerId);
                    if (layer) {
                        layer.elements.push(element.id);
                    }
                }
                return originalAddElement(element);
            };
            
            // Hook into removeElement to clean up layer references
            const originalRemoveElement = canvas.removeElement.bind(canvas);
            canvas.removeElement = (elementId) => {
                // Remove from layer
                this.layers.forEach(layer => {
                    layer.elements = layer.elements.filter(id => id !== elementId);
                });
                return originalRemoveElement(elementId);
            };
        }
    }
    
    addLayer(name) {
        const layerName = name || `Layer ${++this.layerCounter}`;
        const newLayer = new Layer(null, layerName, true, false);
        
        // Insert after active layer
        const activeIndex = this.layers.findIndex(l => l.id === this.activeLayerId);
        if (activeIndex >= 0) {
            this.layers.splice(activeIndex + 1, 0, newLayer);
        } else {
            this.layers.push(newLayer);
        }
        
        this.activeLayerId = newLayer.id;
        this.renderLayersList();
        this.updateLayerControls();
        
        return newLayer;
    }
    
    duplicateActiveLayer() {
        const activeLayer = this.getActiveLayer();
        if (!activeLayer) return;
        
        const canvas = window.infiniteCanvas;
        if (!canvas) return;
        
        // Create new layer with similar name
        const newLayer = this.addLayer(`${activeLayer.name} Copy`);
        
        // Duplicate elements from active layer
        const elementsToDuplicate = canvas.elements.filter(el => 
            el.layerId === activeLayer.id || (!el.layerId && activeLayer.id === 'layer-default')
        );
        
        const offset = 20;
        elementsToDuplicate.forEach(el => {
            const newEl = {
                ...el,
                id: window.toolManager.generateId(),
                x: el.x + offset,
                y: el.y + offset,
                layerId: newLayer.id
            };
            
            // Deep copy points if they exist
            if (el.points) {
                newEl.points = el.points.map(p => ({ x: p.x + offset, y: p.y + offset }));
            }
            
            canvas.elements.push(newEl);
            newLayer.elements.push(newEl.id);
        });
        
        canvas.render();
        window.historyManager?.pushState(canvas.elements);
        this.renderLayersList();
    }
    
    deleteActiveLayer() {
        if (this.layers.length <= 1) {
            // Don't delete the last layer
            window.app?.showToast?.('Cannot delete the last layer');
            return;
        }
        
        const activeLayer = this.getActiveLayer();
        if (!activeLayer) return;
        
        // Confirm deletion if layer has elements
        const canvas = window.infiniteCanvas;
        const elementCount = activeLayer.elements.length;
        
        if (elementCount > 0) {
            if (!confirm(`Delete "${activeLayer.name}" and its ${elementCount} elements?`)) {
                return;
            }
            
            // Remove elements belonging to this layer
            canvas.elements = canvas.elements.filter(el => 
                el.layerId !== activeLayer.id && el.layerId !== undefined
            );
            
            // Also handle elements without layerId (default layer)
            if (activeLayer.id === 'layer-default') {
                canvas.elements = canvas.elements.filter(el => el.layerId !== undefined);
            }
            
            canvas.render();
            window.historyManager?.pushState(canvas.elements);
        }
        
        // Remove layer
        const index = this.layers.findIndex(l => l.id === this.activeLayerId);
        this.layers.splice(index, 1);
        
        // Activate previous layer
        const newActiveIndex = Math.max(0, index - 1);
        this.activeLayerId = this.layers[newActiveIndex].id;
        
        this.renderLayersList();
        this.updateLayerControls();
    }
    
    mergeActiveLayerDown() {
        const activeIndex = this.layers.findIndex(l => l.id === this.activeLayerId);
        if (activeIndex <= 0) {
            window.app?.showToast?.('Cannot merge the bottom layer');
            return;
        }
        
        const activeLayer = this.layers[activeIndex];
        const targetLayer = this.layers[activeIndex - 1];
        const canvas = window.infiniteCanvas;
        
        if (!canvas) return;
        
        // Move all elements from active layer to target layer
        activeLayer.elements.forEach(elementId => {
            const element = canvas.elements.find(el => el.id === elementId);
            if (element) {
                element.layerId = targetLayer.id;
                targetLayer.elements.push(elementId);
            }
        });
        
        // Remove active layer
        this.layers.splice(activeIndex, 1);
        this.activeLayerId = targetLayer.id;
        
        canvas.render();
        window.historyManager?.pushState(canvas.elements);
        this.renderLayersList();
        this.updateLayerControls();
    }
    
    setActiveLayer(layerId) {
        if (this.layers.find(l => l.id === layerId)) {
            this.activeLayerId = layerId;
            this.renderLayersList();
            this.updateLayerControls();
        }
    }
    
    toggleLayerVisibility(layerId) {
        const layer = this.getLayer(layerId);
        if (layer) {
            layer.visible = !layer.visible;
            this.renderLayersList();
            window.infiniteCanvas?.render();
        }
    }
    
    toggleLayerLock(layerId) {
        const layer = this.getLayer(layerId);
        if (layer) {
            layer.locked = !layer.locked;
            this.renderLayersList();
        }
    }
    
    renameLayer(layerId, newName) {
        const layer = this.getLayer(layerId);
        if (layer && newName.trim()) {
            layer.name = newName.trim();
            this.renderLayersList();
        }
    }
    
    moveLayer(layerId, direction) {
        const index = this.layers.findIndex(l => l.id === layerId);
        if (index === -1) return;
        
        const newIndex = direction === 'up' ? index + 1 : index - 1;
        if (newIndex < 0 || newIndex >= this.layers.length) return;
        
        // Swap layers
        [this.layers[index], this.layers[newIndex]] = [this.layers[newIndex], this.layers[index]];
        
        // Reorder elements based on layer order
        this.reorderElementsByLayer();
        
        this.renderLayersList();
        window.infiniteCanvas?.render();
    }
    
    reorderElementsByLayer() {
        const canvas = window.infiniteCanvas;
        if (!canvas) return;
        
        // Create a map of element order based on layers
        const elementOrder = [];
        this.layers.forEach(layer => {
            layer.elements.forEach(elId => {
                const el = canvas.elements.find(e => e.id === elId);
                if (el) elementOrder.push(el);
            });
        });
        
        // Add elements without layer assignment
        canvas.elements.forEach(el => {
            if (!el.layerId && !elementOrder.includes(el)) {
                elementOrder.push(el);
            }
        });
        
        canvas.elements = elementOrder;
    }
    
    getLayer(layerId) {
        return this.layers.find(l => l.id === layerId);
    }
    
    getActiveLayer() {
        return this.getLayer(this.activeLayerId);
    }
    
    isElementVisible(element) {
        const layer = element.layerId ? this.getLayer(element.layerId) : this.layers[0];
        return layer ? layer.visible : true;
    }
    
    isElementLocked(element) {
        const layer = element.layerId ? this.getLayer(element.layerId) : this.layers[0];
        return layer ? layer.locked : false;
    }
    
    renderLayersList() {
        const container = document.getElementById('layersList');
        if (!container) return;
        
        container.innerHTML = '';
        
        // Render layers in reverse order (top to bottom in UI = last to first in array)
        [...this.layers].reverse().forEach(layer => {
            const layerEl = document.createElement('div');
            layerEl.className = `layer-item ${layer.id === this.activeLayerId ? 'active' : ''} ${!layer.visible ? 'hidden' : ''} ${layer.locked ? 'locked' : ''}`;
            layerEl.dataset.layerId = layer.id;
            layerEl.tabIndex = 0;
            layerEl.setAttribute('role', 'button');
            layerEl.setAttribute('aria-pressed', String(layer.id === this.activeLayerId));
            layerEl.setAttribute('aria-label', `${layer.name}, ${layer.id === this.activeLayerId ? 'active layer' : 'activate layer'}`);
            
            layerEl.innerHTML = `
                <button class="layer-visibility" type="button" title="${layer.visible ? 'Hide' : 'Show'} ${layer.name}" aria-label="${layer.visible ? 'Hide' : 'Show'} ${layer.name}">
                    ${layer.visible ? '👁️' : '👁️‍🗨️'}
                </button>
                <input type="text" class="layer-name" value="${layer.name}" title="Rename ${layer.name}" aria-label="Layer name: ${layer.name}">
                <button class="layer-lock" type="button" title="${layer.locked ? 'Unlock' : 'Lock'} ${layer.name}" aria-label="${layer.locked ? 'Unlock' : 'Lock'} ${layer.name}">
                    ${layer.locked ? '🔒' : '🔓'}
                </button>
            `;
            
            // Click to activate layer
            layerEl.addEventListener('click', (e) => {
                if (!e.target.classList.contains('layer-visibility') && 
                    !e.target.classList.contains('layer-lock') &&
                    !e.target.classList.contains('layer-name')) {
                    this.setActiveLayer(layer.id);
                }
            });
            layerEl.addEventListener('keydown', (e) => {
                if (e.target === layerEl && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    this.setActiveLayer(layer.id);
                }
            });
            
            // Visibility toggle
            const visibilityBtn = layerEl.querySelector('.layer-visibility');
            visibilityBtn.addEventListener('click', () => {
                this.toggleLayerVisibility(layer.id);
            });
            
            // Lock toggle
            const lockBtn = layerEl.querySelector('.layer-lock');
            lockBtn.addEventListener('click', () => {
                this.toggleLayerLock(layer.id);
            });
            
            // Rename
            const nameInput = layerEl.querySelector('.layer-name');
            nameInput.addEventListener('blur', () => {
                this.renameLayer(layer.id, nameInput.value);
            });
            nameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    nameInput.blur();
                }
            });
            
            container.appendChild(layerEl);
        });
    }
    
    updateLayerControls() {
        const deleteBtn = document.getElementById('deleteLayerBtn');
        const mergeBtn = document.getElementById('mergeLayerBtn');
        const duplicateBtn = document.getElementById('duplicateLayerBtn');
        
        const activeIndex = this.layers.findIndex(l => l.id === this.activeLayerId);
        
        if (deleteBtn) {
            deleteBtn.disabled = this.layers.length <= 1;
        }
        
        if (mergeBtn) {
            mergeBtn.disabled = activeIndex <= 0;
        }
        
        // Update counter for naming
        this.layerCounter = Math.max(this.layerCounter, this.layers.length);
    }
    
    // Serialization for save/load
    serialize() {
        return {
            layers: this.layers.map(l => ({
                id: l.id,
                name: l.name,
                visible: l.visible,
                locked: l.locked
            })),
            activeLayerId: this.activeLayerId,
            layerCounter: this.layerCounter
        };
    }
    
    deserialize(data) {
        if (!data || !data.layers) return;
        
        this.layers = data.layers.map(l => new Layer(l.id, l.name, l.visible, l.locked));
        this.activeLayerId = data.activeLayerId || (this.layers[0]?.id);
        this.layerCounter = data.layerCounter || this.layers.length;
        
        this.renderLayersList();
        this.updateLayerControls();
    }
}

// Create global instance
window.layersManager = new LayersManager();
