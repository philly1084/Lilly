/**
 * Properties Module - Right panel property controls
 * Enhanced: Extended color system with gradients, patterns, and color history
 */

class PropertiesManager {
    constructor() {
        this.selectedElement = null;
        this.init();
    }
    
    init() {
        // Legacy color pickers (for backwards compatibility)
        document.querySelectorAll('#strokeColorPicker .color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setStrokeColor(btn.dataset.color);
                this.updateColorUI(btn, '#strokeColorPicker');
            });
        });
        
        document.querySelectorAll('#backgroundColorPicker .color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setBackgroundColor(btn.dataset.color);
                this.updateColorUI(btn, '#backgroundColorPicker');
                // Clear gradient/pattern when setting solid color
                this.clearGradientAndPattern();
            });
        });
        
        // Extended color pickers - Stroke
        document.querySelectorAll('#strokeColorSection .color-picker-extended .color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const color = btn.dataset.color;
                this.setStrokeColor(color);
                this.updateExtendedColorUI(btn, '#strokeColorSection');
                if (window.ColorSystem) {
                    window.ColorSystem.addToHistory(color);
                }
            });
        });
        
        // Extended color pickers - Background
        document.querySelectorAll('#backgroundColorSection .color-picker-extended .color-btn, #backgroundColorSection .color-picker .color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const color = btn.dataset.color;
                this.setBackgroundColor(color);
                this.updateExtendedColorUI(btn, '#backgroundColorSection');
                this.clearGradientAndPattern();
                if (window.ColorSystem) {
                    window.ColorSystem.addToHistory(color);
                }
            });
        });
        
        // Custom color inputs
        const customStrokeColor = document.getElementById('customStrokeColor');
        if (customStrokeColor) {
            customStrokeColor.addEventListener('change', (e) => {
                this.setStrokeColor(e.target.value);
                if (window.ColorSystem) {
                    window.ColorSystem.addToHistory(e.target.value);
                }
            });
        }
        
        const customBackgroundColor = document.getElementById('customBackgroundColor');
        if (customBackgroundColor) {
            customBackgroundColor.addEventListener('change', (e) => {
                this.setBackgroundColor(e.target.value);
                this.clearGradientAndPattern();
                if (window.ColorSystem) {
                    window.ColorSystem.addToHistory(e.target.value);
                }
            });
        }
        
        // Color tabs (stroke)
        document.querySelectorAll('#strokeColorSection .color-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.tab;
                this.switchColorTab(tab, '#strokeColorSection');
            });
        });
        
        // Background fill type tabs
        document.querySelectorAll('#backgroundColorSection .color-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.bgTab;
                this.switchBackgroundTab(tab);
            });
        });
        
        // Gradient buttons
        document.querySelectorAll('.gradient-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const gradientKey = btn.dataset.gradient;
                const type = btn.dataset.gradientType || 'linear';
                this.applyGradient(gradientKey, type);
                this.updateGradientUI(btn);
            });
        });
        
        // Gradient type tabs
        document.querySelectorAll('.gradient-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const type = btn.dataset.gradientType;
                this.switchGradientType(type);
            });
        });
        
        // Pattern buttons
        document.querySelectorAll('.pattern-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const patternKey = btn.dataset.pattern;
                this.applyPattern(patternKey);
                this.updatePatternUI(btn);
            });
        });

        document.querySelectorAll('[data-stroke][data-fill].color-preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.applyColorPreset(btn.dataset.stroke, btn.dataset.fill);
            });
        });

        document.querySelectorAll('[data-color-section-toggle]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.toggleColorSection(btn.dataset.colorSectionToggle);
            });
        });

        document.getElementById('colorStudioStrokeInput')?.addEventListener('input', (e) => {
            const color = e.target.value || '#000000';
            this.setStrokeColor(color);
            if (window.ColorSystem) {
                window.ColorSystem.addToHistory(color);
                this.updateColorHistoryUI();
            }
        });

        document.getElementById('colorStudioFillInput')?.addEventListener('input', (e) => {
            const color = e.target.value || '#ffffff';
            this.setBackgroundColor(color);
            this.clearGradientAndPattern();
            if (window.ColorSystem) {
                window.ColorSystem.addToHistory(color);
                this.updateColorHistoryUI();
            }
        });

        document.getElementById('colorStudioClearFill')?.addEventListener('click', () => {
            this.setBackgroundColor('transparent');
            this.clearGradientAndPattern();
        });

        document.getElementById('colorStudioSwap')?.addEventListener('click', () => {
            this.swapStrokeAndFill();
        });

        this.updateColorPreview('stroke', window.toolManager?.defaultProperties?.strokeColor || '#000000');
        this.updateColorPreview('background', window.toolManager?.defaultProperties?.backgroundColor || 'transparent');
        this.updateColorStudioUI(
            window.toolManager?.defaultProperties?.strokeColor || '#000000',
            window.toolManager?.defaultProperties?.backgroundColor || 'transparent',
        );
        this.syncColorButtonAccessibility();
        
        // Stroke width picker
        document.querySelectorAll('#strokeWidthPicker .stroke-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setStrokeWidth(parseInt(btn.dataset.width));
                this.updateStrokeWidthUI(btn);
            });
        });
        
        // Stroke style picker
        document.querySelectorAll('#strokeStylePicker .stroke-style-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setStrokeStyle(btn.dataset.style);
                this.updateStrokeStyleUI(btn);
            });
        });
        
        // Roughness picker
        document.querySelectorAll('#roughnessPicker .roughness-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setRoughness(parseInt(btn.dataset.roughness));
                this.updateRoughnessUI(btn);
            });
        });
        
        // Edges picker
        document.querySelectorAll('#edgesPicker .edge-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setEdgeType(btn.dataset.edge);
                this.updateEdgesUI(btn);
            });
        });
        
        // Opacity slider
        const opacitySlider = document.getElementById('opacitySlider');
        if (opacitySlider) {
            opacitySlider.addEventListener('input', (e) => {
                this.setOpacity(parseInt(e.target.value) / 100);
                document.getElementById('opacityValue').textContent = e.target.value + '%';
            });
        }
        
        // Font size picker
        document.querySelectorAll('#fontSizePicker .font-size-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setFontSize(parseInt(btn.dataset.size));
                this.updateFontSizeUI(btn);
            });
        });
        
        // Font family select
        const fontSelect = document.getElementById('fontFamilySelect');
        if (fontSelect) {
            fontSelect.addEventListener('change', (e) => {
                this.setFontFamily(e.target.value);
            });
        }
        
        // Layer actions
        document.getElementById('deleteBtn')?.addEventListener('click', () => {
            this.deleteSelection();
        });
        
        document.getElementById('duplicateBtn')?.addEventListener('click', () => {
            window.selectionManager?.duplicateSelection();
        });
        
        document.getElementById('bringToFrontBtn')?.addEventListener('click', () => {
            window.selectionManager?.bringToFront();
        });
        
        document.getElementById('sendToBackBtn')?.addEventListener('click', () => {
            window.selectionManager?.sendToBack();
        });
        
        // Alignment buttons
        document.getElementById('alignLeftBtn')?.addEventListener('click', () => {
            window.selectionManager?.alignLeft();
        });
        
        document.getElementById('alignCenterBtn')?.addEventListener('click', () => {
            window.selectionManager?.alignCenter();
        });
        
        document.getElementById('alignRightBtn')?.addEventListener('click', () => {
            window.selectionManager?.alignRight();
        });
        
        document.getElementById('alignTopBtn')?.addEventListener('click', () => {
            window.selectionManager?.alignTop();
        });
        
        document.getElementById('alignMiddleBtn')?.addEventListener('click', () => {
            window.selectionManager?.alignMiddle();
        });
        
        document.getElementById('alignBottomBtn')?.addEventListener('click', () => {
            window.selectionManager?.alignBottom();
        });
        
        // Distribution buttons
        document.getElementById('distributeHBtn')?.addEventListener('click', () => {
            window.selectionManager?.distributeHorizontal();
        });
        
        document.getElementById('distributeVBtn')?.addEventListener('click', () => {
            window.selectionManager?.distributeVertical();
        });
        
        // Grid snap toggle
        document.getElementById('snapToGridBtn')?.addEventListener('click', () => {
            const canvas = window.infiniteCanvas;
            const enabled = canvas.toggleSnapToGrid();
            const btn = document.getElementById('snapToGridBtn');
            if (btn) {
                btn.classList.toggle('active', enabled);
            }
        });
        
        // Corner radius slider
        const cornerRadiusSlider = document.getElementById('cornerRadiusSlider');
        if (cornerRadiusSlider) {
            cornerRadiusSlider.addEventListener('input', (e) => {
                this.setCornerRadius(parseInt(e.target.value));
                document.getElementById('cornerRadiusValue').textContent = e.target.value + 'px';
            });
        }
        
        // Star points picker
        document.querySelectorAll('#starPointsPicker .star-points-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setStarPoints(parseInt(btn.dataset.points));
                this.updateStarPointsUI(btn);
            });
        });
        
        // Arrowhead picker
        document.querySelectorAll('#arrowheadPicker .arrowhead-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setArrowhead(btn.dataset.arrowhead);
                this.updateArrowheadUI(btn);
            });
        });
        
        // Connector style picker
        document.querySelectorAll('#connectorStylePicker .connector-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setConnectorStyle(btn.dataset.style);
                this.updateConnectorStyleUI(btn);
            });
        });
        
        // Initialize color history UI
        this.updateColorHistoryUI();
    }
    
    // Switch color tab
    switchColorTab(tab, container) {
        const section = document.querySelector(container);
        if (!section) return;
        
        // Update tab buttons
        section.querySelectorAll('.color-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
        
        // Update tab content
        section.querySelectorAll('.color-tab-content').forEach(content => {
            content.classList.toggle('active', content.dataset.tab === tab);
        });
    }
    
    // Switch background fill type tab
    switchBackgroundTab(tab) {
        const section = document.getElementById('backgroundColorSection');
        if (!section) return;
        
        // Update tab buttons
        section.querySelectorAll('.color-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.bgTab === tab);
        });
        
        // Update tab content
        section.querySelectorAll('.color-bg-tab-content').forEach(content => {
            content.classList.toggle('active', content.dataset.bgTab === tab);
        });
    }

    toggleColorSection(sectionId = '') {
        const section = document.getElementById(sectionId);
        if (!section) return;
        const isExpanded = section.classList.toggle('expanded');
        const button = document.querySelector(`[data-color-section-toggle="${sectionId}"]`);
        button?.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    }
    
    // Switch gradient type
    switchGradientType(type) {
        // Update tab buttons
        document.querySelectorAll('.gradient-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.gradientType === type);
        });
        
        // Show/hide gradient grids
        const linearGrid = document.getElementById('linearGradients');
        const radialGrid = document.getElementById('radialGradients');
        
        if (linearGrid) linearGrid.style.display = type === 'linear' ? 'grid' : 'none';
        if (radialGrid) radialGrid.style.display = type === 'radial' ? 'grid' : 'none';
    }
    
    // Apply gradient to selected elements
    applyGradient(gradientKey, type) {
        const canvas = window.infiniteCanvas;
        if (!canvas || !window.ColorSystem) return;
        
        const gradient = window.ColorSystem.gradients[type]?.[gradientKey];
        if (!gradient) return;
        
        let changed = false;
        for (const el of canvas.selectedElements) {
            el.fillType = 'gradient';
            el.gradient = { ...gradient };
            el.backgroundColor = 'transparent';
            el.pattern = null;
            changed = true;
        }
        
        if (changed) {
            canvas.render();
            window.historyManager?.pushState(canvas.elements);
        }
    }
    
    // Apply pattern to selected elements
    applyPattern(patternKey) {
        const canvas = window.infiniteCanvas;
        if (!canvas || !window.ColorSystem) return;
        
        const pattern = window.ColorSystem.patterns[patternKey];
        if (!pattern) return;
        
        let changed = false;
        for (const el of canvas.selectedElements) {
            el.fillType = 'pattern';
            el.pattern = { ...pattern, key: patternKey };
            el.backgroundColor = 'transparent';
            el.gradient = null;
            changed = true;
        }
        
        if (changed) {
            canvas.render();
            window.historyManager?.pushState(canvas.elements);
        }
    }
    
    // Clear gradient and pattern when setting solid color
    clearGradientAndPattern() {
        const canvas = window.infiniteCanvas;
        if (!canvas) return;
        
        for (const el of canvas.selectedElements) {
            el.fillType = 'solid';
            el.gradient = null;
            el.pattern = null;
        }
    }
    
    updateForSelection() {
        const canvas = window.infiniteCanvas;
        const elements = canvas.selectedElements;
        
        if (elements.length === 0) {
            this.selectedElement = null;
            this.disableControls(true);
            this.updateShapePropertyGroups(null);
            return;
        }
        
        if (elements.length === 1) {
            this.selectedElement = elements[0];
            this.disableControls(false);
            this.syncUItoElement(this.selectedElement);
            this.updateShapePropertyGroups(this.selectedElement);
        } else {
            // Multiple selection - disable specific controls
            this.selectedElement = null;
            this.disableControls(false);
            document.getElementById('fontSizeGroup')?.classList.add('disabled');
            document.getElementById('fontFamilyGroup')?.classList.add('disabled');
            this.updateShapePropertyGroups(null);
        }
        
        // Update alignment button visibility
        this.updateAlignmentVisibility(elements.length);
        
        // Update AI image properties visibility
        this.updateAIImageProperties(elements);
    }
    
    updateShapePropertyGroups(element) {
        // Hide all shape-specific groups by default
        const cornerRadiusGroup = document.getElementById('cornerRadiusGroup');
        const starPointsGroup = document.getElementById('starPointsGroup');
        const arrowheadGroup = document.getElementById('arrowheadGroup');
        const connectorStyleGroup = document.getElementById('connectorStyleGroup');
        
        if (cornerRadiusGroup) cornerRadiusGroup.style.display = 'none';
        if (starPointsGroup) starPointsGroup.style.display = 'none';
        if (arrowheadGroup) arrowheadGroup.style.display = 'none';
        if (connectorStyleGroup) connectorStyleGroup.style.display = 'none';
        
        if (!element) return;
        
        // Show relevant groups based on element type
        switch (element.type) {
            case 'rectangle':
                if (cornerRadiusGroup) cornerRadiusGroup.style.display = 'flex';
                break;
            case 'star':
                if (starPointsGroup) starPointsGroup.style.display = 'flex';
                break;
            case 'arrow':
            case 'curvedArrow':
            case 'elbowArrow':
                if (arrowheadGroup) arrowheadGroup.style.display = 'flex';
                break;
            case 'connector':
                if (connectorStyleGroup) connectorStyleGroup.style.display = 'flex';
                break;
        }
    }
    
    updateAlignmentVisibility(selectionCount) {
        const alignmentGroup = document.getElementById('alignmentGroup');
        if (alignmentGroup) {
            alignmentGroup.style.display = selectionCount >= 2 ? 'block' : 'none';
        }
    }
    
    disableControls(disabled) {
        const panel = document.getElementById('propertiesPanel');
        if (disabled) {
            panel?.classList.add('no-selection');
        } else {
            panel?.classList.remove('no-selection');
        }
    }
    
    syncUItoElement(element) {
        this.updateColorPreview('stroke', element.strokeColor || '#000000');
        this.updateColorPreview('background', element.backgroundColor || 'transparent');
        this.updateColorStudioUI(element.strokeColor || '#000000', element.backgroundColor || 'transparent');

        // Update stroke color
        const strokeBtn = document.querySelector(`#strokeColorPicker .color-btn[data-color="${element.strokeColor}"]`);
        if (strokeBtn) this.updateColorUI(strokeBtn, '#strokeColorPicker');
        
        // Also update extended color pickers
        const strokeExtendedBtn = document.querySelector(`#strokeColorSection .color-btn[data-color="${element.strokeColor}"]`);
        if (strokeExtendedBtn) this.updateExtendedColorUI(strokeExtendedBtn, '#strokeColorSection');
        
        // Update background color
        if (element.fillType === 'gradient' && element.gradient) {
            // Find and highlight the gradient button
            const gradientBtn = document.querySelector(`.gradient-btn[data-gradient="${this.getGradientKey(element.gradient)}"]`);
            if (gradientBtn) this.updateGradientUI(gradientBtn);
            this.switchBackgroundTab('gradient');
        } else if (element.fillType === 'pattern' && element.pattern) {
            // Find and highlight the pattern button
            const patternBtn = document.querySelector(`.pattern-btn[data-pattern="${element.pattern.key}"]`);
            if (patternBtn) this.updatePatternUI(patternBtn);
            this.switchBackgroundTab('pattern');
        } else {
            // Solid color
            const bgBtn = document.querySelector(`#backgroundColorPicker .color-btn[data-color="${element.backgroundColor}"]`);
            if (bgBtn) this.updateColorUI(bgBtn, '#backgroundColorPicker');
            
            const bgExtendedBtn = document.querySelector(`#backgroundColorSection .color-btn[data-color="${element.backgroundColor}"]`);
            if (bgExtendedBtn) this.updateExtendedColorUI(bgExtendedBtn, '#backgroundColorSection');
            this.switchBackgroundTab('solid');
        }
        
        // Update stroke width
        const widthBtn = document.querySelector(`#strokeWidthPicker .stroke-btn[data-width="${element.strokeWidth}"]`);
        if (widthBtn) this.updateStrokeWidthUI(widthBtn);
        
        // Update stroke style
        const styleBtn = document.querySelector(`#strokeStylePicker .stroke-style-btn[data-style="${element.strokeStyle}"]`);
        if (styleBtn) this.updateStrokeStyleUI(styleBtn);
        
        // Update roughness
        const roughnessBtn = document.querySelector(`#roughnessPicker .roughness-btn[data-roughness="${element.roughness}"]`);
        if (roughnessBtn) this.updateRoughnessUI(roughnessBtn);
        
        // Update edge type
        const edgeBtn = document.querySelector(`#edgesPicker .edge-btn[data-edge="${element.edgeType}"]`);
        if (edgeBtn) this.updateEdgesUI(edgeBtn);
        
        // Update opacity
        const opacitySlider = document.getElementById('opacitySlider');
        if (opacitySlider) {
            opacitySlider.value = (element.opacity ?? 1) * 100;
            document.getElementById('opacityValue').textContent = Math.round((element.opacity ?? 1) * 100) + '%';
        }
        
        // Update font size (for text)
        if (element.type === 'text' || element.type === 'sticky') {
            const fontSizeBtn = document.querySelector(`#fontSizePicker .font-size-btn[data-size="${element.fontSize}"]`);
            if (fontSizeBtn) this.updateFontSizeUI(fontSizeBtn);
            
            const fontSelect = document.getElementById('fontFamilySelect');
            if (fontSelect) fontSelect.value = element.fontFamily || 'Virgil, cursive';
        }
        
        // Update AI image properties
        if (element.type === 'image' && element.aiGenerated) {
            this.updateAIImageInfo(element);
        }
        
        // Update corner radius (for rectangles)
        if (element.type === 'rectangle') {
            const cornerRadiusSlider = document.getElementById('cornerRadiusSlider');
            const cornerRadiusValue = document.getElementById('cornerRadiusValue');
            if (cornerRadiusSlider) cornerRadiusSlider.value = element.cornerRadius || 0;
            if (cornerRadiusValue) cornerRadiusValue.textContent = (element.cornerRadius || 0) + 'px';
        }
        
        // Update star points (for stars)
        if (element.type === 'star') {
            const starPointsBtn = document.querySelector(`#starPointsPicker .star-points-btn[data-points="${element.starPoints || 5}"]`);
            if (starPointsBtn) this.updateStarPointsUI(starPointsBtn);
        }
        
        // Update arrowhead (for arrows)
        if (element.type === 'arrow' || element.type === 'curvedArrow' || element.type === 'elbowArrow') {
            const arrowheadBtn = document.querySelector(`#arrowheadPicker .arrowhead-btn[data-arrowhead="${element.arrowhead || 'end'}"]`);
            if (arrowheadBtn) this.updateArrowheadUI(arrowheadBtn);
        }
        
        // Update connector style (for connectors)
        if (element.type === 'connector') {
            const connectorBtn = document.querySelector(`#connectorStylePicker .connector-btn[data-style="${element.connectorStyle || 'straight'}"]`);
            if (connectorBtn) this.updateConnectorStyleUI(connectorBtn);
        }
    }
    
    // Helper to get gradient key from gradient object
    getGradientKey(gradient) {
        if (!window.ColorSystem) return null;
        
        for (const type of ['linear', 'radial']) {
            for (const [key, g] of Object.entries(window.ColorSystem.gradients[type] || {})) {
                if (g.name === gradient.name) return key;
            }
        }
        return null;
    }
    
    updateAIImageProperties(elements) {
        const imagePropertiesGroup = document.getElementById('imagePropertiesGroup');
        if (!imagePropertiesGroup) return;
        
        if (elements.length === 1 && elements[0].type === 'image' && elements[0].aiGenerated) {
            imagePropertiesGroup.style.display = 'block';
            this.updateAIImageInfo(elements[0]);
        } else {
            imagePropertiesGroup.style.display = 'none';
        }
    }
    
    updateAIImageInfo(element) {
        const promptEl = document.getElementById('aiImagePrompt');
        if (promptEl) {
            const prompt = element.originalPrompt || 'AI Generated Image';
            promptEl.textContent = prompt;
            promptEl.title = element.revisedPrompt || prompt;
        }
    }
    
    // Property setters
    setStrokeColor(color) {
        window.toolManager.updateDefaultProperties({ strokeColor: color });
        this.updateColorPreview('stroke', color);
        this.updateColorStudioUI(color, window.toolManager?.defaultProperties?.backgroundColor || 'transparent');
        this.updateSelectedElements('strokeColor', color);
    }
    
    setBackgroundColor(color) {
        window.toolManager.updateDefaultProperties({ backgroundColor: color });
        this.updateColorPreview('background', color);
        this.updateColorStudioUI(window.toolManager?.defaultProperties?.strokeColor || '#000000', color);
        this.updateSelectedElements('backgroundColor', color);
    }

    applyColorPreset(strokeColor = '#000000', fillColor = 'transparent') {
        const stroke = strokeColor || '#000000';
        const fill = fillColor || 'transparent';
        const canvas = window.infiniteCanvas;
        let changed = false;

        window.toolManager?.updateDefaultProperties?.({
            strokeColor: stroke,
            backgroundColor: fill,
        });
        this.clearGradientAndPattern();
        this.updateColorPreview('stroke', stroke);
        this.updateColorPreview('background', fill);
        this.updateColorStudioUI(stroke, fill);
        this.markColorPresetActive(stroke, fill);

        if (canvas?.selectedElements?.length) {
            canvas.selectedElements.forEach((element) => {
                if (element.strokeColor !== stroke) {
                    element.strokeColor = stroke;
                    changed = true;
                }
                if (element.backgroundColor !== fill) {
                    element.backgroundColor = fill;
                    changed = true;
                }
                if (element.fillType) {
                    element.fillType = 'solid';
                    changed = true;
                }
                if (element.gradient) {
                    delete element.gradient;
                    changed = true;
                }
                if (element.pattern) {
                    delete element.pattern;
                    changed = true;
                }
            });
        }

        if (window.ColorSystem) {
            window.ColorSystem.addToHistory(stroke);
            if (fill !== 'transparent') {
                window.ColorSystem.addToHistory(fill);
            }
            this.updateColorHistoryUI();
        }

        if (changed && canvas) {
            canvas.render();
            window.historyManager?.pushState(canvas.elements);
            window.app?.onCanvasElementsChanged?.();
        }
    }

    swapStrokeAndFill() {
        const defaults = window.toolManager?.defaultProperties || {};
        const canvas = window.infiniteCanvas;
        const selected = canvas?.selectedElements || [];
        const source = selected[0] || defaults;
        const nextStroke = source.backgroundColor || defaults.backgroundColor || 'transparent';
        const nextFill = source.strokeColor || defaults.strokeColor || '#000000';
        this.applyColorPreset(nextStroke === 'transparent' ? '#334155' : nextStroke, nextFill);
    }
    
    setStrokeWidth(width) {
        window.toolManager.updateDefaultProperties({ strokeWidth: width });
        this.updateSelectedElements('strokeWidth', width);
    }
    
    setStrokeStyle(style) {
        window.toolManager.updateDefaultProperties({ strokeStyle: style });
        this.updateSelectedElements('strokeStyle', style);
    }
    
    setRoughness(roughness) {
        window.toolManager.updateDefaultProperties({ roughness: roughness });
        this.updateSelectedElements('roughness', roughness);
    }
    
    setEdgeType(edge) {
        window.toolManager.updateDefaultProperties({ edgeType: edge });
        this.updateSelectedElements('edgeType', edge);
    }
    
    setOpacity(opacity) {
        window.toolManager.updateDefaultProperties({ opacity: opacity });
        this.updateSelectedElements('opacity', opacity);
    }
    
    setFontSize(size) {
        window.toolManager.updateDefaultProperties({ fontSize: size });
        this.updateSelectedElements('fontSize', size);
    }
    
    setFontFamily(family) {
        window.toolManager.updateDefaultProperties({ fontFamily: family });
        this.updateSelectedElements('fontFamily', family);
    }
    
    setCornerRadius(radius) {
        this.updateSelectedElements('cornerRadius', radius);
    }
    
    setStarPoints(points) {
        this.updateSelectedElements('starPoints', points);
    }
    
    setArrowhead(arrowhead) {
        this.updateSelectedElements('arrowhead', arrowhead);
    }
    
    setConnectorStyle(style) {
        this.updateSelectedElements('connectorStyle', style);
    }
    
    updateSelectedElements(property, value) {
        const canvas = window.infiniteCanvas;
        let changed = false;
        
        for (const el of canvas.selectedElements) {
            if (el[property] !== value) {
                el[property] = value;
                changed = true;
            }
        }
        
        if (changed) {
            canvas.render();
            window.historyManager?.pushState(canvas.elements);
        }
    }
    
    deleteSelection() {
        const canvas = window.infiniteCanvas;
        for (const el of canvas.selectedElements) {
            canvas.removeElement(el.id);
        }
        canvas.deselectAll();
        window.historyManager?.pushState(canvas.elements);
    }
    
    // UI update helpers
    updateColorUI(activeBtn, container) {
        document.querySelectorAll(`${container} .color-btn`).forEach(btn => btn.classList.remove('active'));
        activeBtn.classList.add('active');
        const section = activeBtn.closest('.color-section');
        if (section?.dataset.target) {
            this.updateColorPreview(section.dataset.target, activeBtn.dataset.color);
        }
        this.syncColorButtonAccessibility(document.querySelector(container));
    }
    
    updateExtendedColorUI(activeBtn, container) {
        if (!activeBtn) return;
        const section = document.querySelector(container);
        if (section) {
            section.querySelectorAll('.color-btn').forEach(btn => btn.classList.remove('active'));
            activeBtn.classList.add('active');
            if (section.dataset.target) {
                this.updateColorPreview(section.dataset.target, activeBtn.dataset.color);
            }
            this.syncColorButtonAccessibility(section);
        }
    }

    syncColorButtonAccessibility(root = document) {
        root.querySelectorAll('.color-btn').forEach((btn) => {
            const section = btn.closest('.color-section');
            const target = section?.dataset.target === 'background' ? 'fill' : 'stroke';
            const colorName = btn.getAttribute('title') || btn.dataset.color || 'custom color';
            btn.type = 'button';
            btn.setAttribute('aria-label', `Set ${target} color to ${colorName}`);
            btn.setAttribute('aria-pressed', btn.classList.contains('active') ? 'true' : 'false');
            btn.querySelectorAll('.color-checkmark').forEach((mark) => {
                mark.setAttribute('aria-hidden', 'true');
            });
        });
    }

    updateColorPreview(target, color) {
        const preview = document.getElementById(target === 'background' ? 'backgroundColorPreview' : 'strokeColorPreview');
        if (!preview) return;
        const nextColor = color || 'transparent';
        preview.classList.toggle('transparent', nextColor === 'transparent');
        preview.style.background = nextColor === 'transparent' ? '' : nextColor;
    }

    updateColorStudioUI(strokeColor = '#000000', fillColor = 'transparent') {
        const strokePreview = document.getElementById('colorStudioStrokePreview');
        const fillPreview = document.getElementById('colorStudioFillPreview');
        const strokeInput = document.getElementById('colorStudioStrokeInput');
        const fillInput = document.getElementById('colorStudioFillInput');
        const stroke = strokeColor || '#000000';
        const fill = fillColor || 'transparent';
        if (strokePreview) {
            strokePreview.classList.toggle('transparent', stroke === 'transparent');
            strokePreview.style.background = stroke === 'transparent' ? '' : stroke;
        }
        if (fillPreview) {
            fillPreview.classList.toggle('transparent', fill === 'transparent');
            fillPreview.style.background = fill === 'transparent' ? '' : fill;
        }
        if (strokeInput && /^#[0-9a-f]{6}$/i.test(stroke)) {
            strokeInput.value = stroke;
        }
        if (fillInput && /^#[0-9a-f]{6}$/i.test(fill)) {
            fillInput.value = fill;
        }
        this.markColorPresetActive(stroke, fill);
    }

    markColorPresetActive(strokeColor = '#000000', fillColor = 'transparent') {
        const stroke = String(strokeColor || '#000000').toLowerCase();
        const fill = String(fillColor || 'transparent').toLowerCase();
        document.querySelectorAll('.color-preset-btn').forEach((btn) => {
            btn.classList.toggle('active',
                String(btn.dataset.stroke || '').toLowerCase() === stroke
                && String(btn.dataset.fill || '').toLowerCase() === fill);
        });
    }
    
    updateGradientUI(activeBtn) {
        document.querySelectorAll('.gradient-btn').forEach(btn => btn.classList.remove('active'));
        if (activeBtn) activeBtn.classList.add('active');
    }
    
    updatePatternUI(activeBtn) {
        document.querySelectorAll('.pattern-btn').forEach(btn => btn.classList.remove('active'));
        if (activeBtn) activeBtn.classList.add('active');
    }
    
    updateStrokeWidthUI(activeBtn) {
        document.querySelectorAll('#strokeWidthPicker .stroke-btn').forEach(btn => btn.classList.remove('active'));
        activeBtn.classList.add('active');
    }
    
    updateStrokeStyleUI(activeBtn) {
        document.querySelectorAll('#strokeStylePicker .stroke-style-btn').forEach(btn => btn.classList.remove('active'));
        activeBtn.classList.add('active');
    }
    
    updateRoughnessUI(activeBtn) {
        document.querySelectorAll('#roughnessPicker .roughness-btn').forEach(btn => btn.classList.remove('active'));
        activeBtn.classList.add('active');
    }
    
    updateEdgesUI(activeBtn) {
        document.querySelectorAll('#edgesPicker .edge-btn').forEach(btn => btn.classList.remove('active'));
        activeBtn.classList.add('active');
    }
    
    updateFontSizeUI(activeBtn) {
        document.querySelectorAll('#fontSizePicker .font-size-btn').forEach(btn => btn.classList.remove('active'));
        activeBtn.classList.add('active');
    }
    
    updateStarPointsUI(activeBtn) {
        document.querySelectorAll('#starPointsPicker .star-points-btn').forEach(btn => btn.classList.remove('active'));
        activeBtn.classList.add('active');
    }
    
    updateArrowheadUI(activeBtn) {
        document.querySelectorAll('#arrowheadPicker .arrowhead-btn').forEach(btn => btn.classList.remove('active'));
        activeBtn.classList.add('active');
    }
    
    updateConnectorStyleUI(activeBtn) {
        document.querySelectorAll('#connectorStylePicker .connector-btn').forEach(btn => btn.classList.remove('active'));
        activeBtn.classList.add('active');
    }
    
    // Filter fonts based on search query
    filterFonts(query) {
        const fontList = document.getElementById('fontList');
        if (!fontList) return;
        
        const normalizedQuery = query.toLowerCase().trim();
        const fontItems = fontList.querySelectorAll('.font-item');
        
        fontItems.forEach(item => {
            const fontName = item.dataset.font?.toLowerCase() || '';
            const fontFamily = item.style.fontFamily?.toLowerCase() || '';
            
            if (normalizedQuery === '' || 
                fontName.includes(normalizedQuery) || 
                fontFamily.includes(normalizedQuery)) {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        });
        
        // Show "no results" message if all fonts are hidden
        const visibleItems = fontList.querySelectorAll('.font-item:not([style*="display: none"])');
        const noResultsMsg = fontList.querySelector('.no-results-message');
        
        if (visibleItems.length === 0) {
            if (!noResultsMsg) {
                const msg = document.createElement('div');
                msg.className = 'no-results-message';
                msg.textContent = 'No fonts found';
                msg.style.cssText = 'padding: 12px; text-align: center; color: var(--text-secondary); font-style: italic;';
                fontList.appendChild(msg);
            }
        } else if (noResultsMsg) {
            noResultsMsg.remove();
        }
    }
    
    // Update color history UI
    updateColorHistoryUI() {
        if (!window.ColorSystem) return;
        
        const updateHistory = (containerId, history) => {
            const container = document.getElementById(containerId);
            if (!container) return;
            
            if (history.length === 0) {
                container.innerHTML = '<span class="color-history-empty">No recent colors</span>';
                return;
            }
            
            container.innerHTML = history.map(color => `
                <button class="color-btn" data-color="${color}" style="background: ${color};" title="${color}"></button>
            `).join('');
            this.syncColorButtonAccessibility(container);
            
            // Attach listeners
            container.querySelectorAll('.color-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const section = container.closest('.color-section');
                    const target = section?.dataset.target || 'background';
                    if (target === 'stroke') {
                        this.setStrokeColor(btn.dataset.color);
                    } else {
                        this.setBackgroundColor(btn.dataset.color);
                        this.clearGradientAndPattern();
                    }
                });
            });
        };
        
        // Update both history containers
        updateHistory('strokeColorHistory', window.ColorSystem.history);
        updateHistory('backgroundColorHistory', window.ColorSystem.history);
    }
}

// Create global instance
window.propertiesManager = new PropertiesManager();
