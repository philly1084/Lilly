/**
 * Renderer Module - Rough.js rendering engine
 * Enhanced: Support for gradients, patterns, and improved fill styles
 */

class Renderer {
    constructor() {
        this.rough = window.rough;
        this.generators = new Map(); // Cache generators for different roughness values
        this.patternCanvases = new Map(); // Cache pattern canvases
    }
    
    getGenerator(roughness = 1) {
        if (!this.generators.has(roughness)) {
            this.generators.set(roughness, this.rough.generator());
        }
        return this.generators.get(roughness);
    }
    
    drawElement(ctx, element) {
        if (!element) return;
        
        const options = this.getRoughOptions(element);
        const rc = this.getGenerator(element.roughness ?? 1);
        
        ctx.save();
        
        // Apply opacity
        ctx.globalAlpha = element.opacity ?? 1;
        
        switch (element.type) {
            case 'rectangle':
                this.drawRectangle(ctx, rc, element, options);
                break;
            case 'diamond':
                this.drawDiamond(ctx, rc, element, options);
                break;
            case 'ellipse':
                this.drawEllipse(ctx, rc, element, options);
                break;
            case 'line':
                this.drawLine(ctx, rc, element, options);
                break;
            case 'arrow':
                this.drawArrow(ctx, rc, element, options);
                break;
            case 'freedraw':
                this.drawFreedraw(ctx, element);
                break;
            case 'text':
                this.drawText(ctx, element);
                break;
            case 'image':
                this.drawImage(ctx, element);
                break;
            case 'sticky':
                this.drawSticky(ctx, rc, element, options);
                break;
            case 'frame':
                this.drawFrame(ctx, rc, element, options);
                break;
            case 'storyboardFrame':
                this.drawStoryboardFrame(ctx, element);
                break;
            case 'animationBeat':
                this.drawAnimationBeat(ctx, element);
                break;
            case 'audioCue':
                this.drawAudioCue(ctx, element);
                break;
            case 'mermaidDiagram':
                this.drawMermaidDiagram(ctx, element);
                break;
            default:
                this.drawFallbackElement(ctx, element);
                break;
        }
        
        ctx.restore();
    }
    
    getRoughOptions(element) {
        const options = {
            stroke: element.strokeColor || '#000000',
            strokeWidth: element.strokeWidth || 2,
            roughness: element.roughness ?? 1,
            bowing: 1,
        };
        
        // Background fill
        if (element.backgroundColor && element.backgroundColor !== 'transparent') {
            options.fill = element.backgroundColor;
            options.fillStyle = 'hachure';
            options.fillWeight = 1;
            options.hachureGap = 4;
            options.hachureAngle = 60;
        }
        
        // Stroke style
        if (element.strokeStyle === 'dashed') {
            options.strokeLineDash = [8, 8];
        } else if (element.strokeStyle === 'dotted') {
            options.strokeLineDash = [2, 4];
        }
        
        return options;
    }
    
    // Create gradient fill
    createGradient(ctx, element, x, y, width, height) {
        if (!element.gradient) return null;
        
        const gradient = element.gradient;
        let canvasGradient;
        
        if (gradient.type === 'linear') {
            // Parse direction (e.g., "135deg")
            const angle = parseInt(gradient.direction) || 135;
            const rad = (angle - 90) * Math.PI / 180;
            
            // Calculate start and end points based on angle
            const cx = x + width / 2;
            const cy = y + height / 2;
            const dx = Math.cos(rad) * width / 2;
            const dy = Math.sin(rad) * height / 2;
            
            canvasGradient = ctx.createLinearGradient(
                cx - dx, cy - dy,
                cx + dx, cy + dy
            );
        } else if (gradient.type === 'radial') {
            const cx = x + width / 2;
            const cy = y + height / 2;
            const r = Math.max(width, height) / 2;
            
            canvasGradient = ctx.createRadialGradient(
                cx, cy, 0,
                cx, cy, r
            );
        }
        
        if (canvasGradient && gradient.stops) {
            gradient.stops.forEach((stop, index) => {
                const offset = index / (gradient.stops.length - 1);
                canvasGradient.addColorStop(offset, stop);
            });
        }
        
        return canvasGradient;
    }
    
    // Create pattern fill
    createPattern(ctx, element) {
        if (!element.pattern) return null;
        
        const patternKey = `${element.pattern.key}_${element.strokeColor || '#000000'}`;
        
        // Check cache
        if (this.patternCanvases.has(patternKey)) {
            return this.patternCanvases.get(patternKey);
        }
        
        // Create pattern canvas
        const patternCanvas = document.createElement('canvas');
        const patternCtx = patternCanvas.getContext('2d');
        const size = parseInt(element.pattern.size) || 10;
        
        patternCanvas.width = size;
        patternCanvas.height = size;
        
        // Draw pattern
        const color = element.strokeColor || '#000000';
        patternCtx.strokeStyle = color;
        patternCtx.fillStyle = color;
        
        switch (element.pattern.key) {
            case 'dots':
                patternCtx.beginPath();
                patternCtx.arc(size/2, size/2, 1.5, 0, Math.PI * 2);
                patternCtx.fill();
                break;
            case 'dotsSmall':
                patternCtx.beginPath();
                patternCtx.arc(size/2, size/2, 1, 0, Math.PI * 2);
                patternCtx.fill();
                break;
            case 'lines':
                patternCtx.lineWidth = 1;
                patternCtx.beginPath();
                patternCtx.moveTo(size/2, 0);
                patternCtx.lineTo(size/2, size);
                patternCtx.stroke();
                break;
            case 'linesDiagonal':
                patternCtx.lineWidth = 1;
                patternCtx.beginPath();
                patternCtx.moveTo(0, size);
                patternCtx.lineTo(size, 0);
                patternCtx.stroke();
                break;
            case 'crosshatch':
                patternCtx.lineWidth = 1;
                patternCtx.beginPath();
                patternCtx.moveTo(0, 0);
                patternCtx.lineTo(size, size);
                patternCtx.moveTo(size, 0);
                patternCtx.lineTo(0, size);
                patternCtx.stroke();
                break;
            case 'waves':
                patternCtx.lineWidth = 1;
                patternCtx.beginPath();
                for (let i = 0; i < size; i += 2) {
                    patternCtx.lineTo(i, size/2 + Math.sin(i * 0.5) * 2);
                }
                patternCtx.stroke();
                break;
            case 'grid':
                patternCtx.lineWidth = 1;
                patternCtx.beginPath();
                patternCtx.moveTo(size/2, 0);
                patternCtx.lineTo(size/2, size);
                patternCtx.moveTo(0, size/2);
                patternCtx.lineTo(size, size/2);
                patternCtx.stroke();
                break;
            case 'checkerboard':
                patternCtx.fillRect(0, 0, size/2, size/2);
                patternCtx.fillRect(size/2, size/2, size/2, size/2);
                break;
        }
        
        const pattern = ctx.createPattern(patternCanvas, 'repeat');
        this.patternCanvases.set(patternKey, pattern);
        return pattern;
    }
    
    // Apply fill to context
    applyFill(ctx, element, x, y, width, height) {
        if (element.fillType === 'gradient' && element.gradient) {
            const gradient = this.createGradient(ctx, element, x, y, width, height);
            if (gradient) {
                ctx.fillStyle = gradient;
                return true;
            }
        } else if (element.fillType === 'pattern' && element.pattern) {
            const pattern = this.createPattern(ctx, element);
            if (pattern) {
                ctx.fillStyle = pattern;
                return true;
            }
        } else if (element.backgroundColor && element.backgroundColor !== 'transparent') {
            ctx.fillStyle = element.backgroundColor;
            return true;
        }
        return false;
    }
    
    drawRectangle(ctx, rc, element, options) {
        const x = element.x - element.width / 2;
        const y = element.y - element.height / 2;
        const w = element.width;
        const h = element.height;

        ctx.save();
        this.applyStrokeStyle(ctx, element);
        
        // Apply fill
        const hasFill = this.applyFill(ctx, element, x, y, w, h);
        
        this.beginRoundedRect(ctx, x, y, w, h, element.edgeType === 'round' ? Math.min(w, h) * 0.1 : 0);
        if (hasFill) {
            ctx.fill();
        }
        ctx.stroke();
        ctx.restore();
        
        // Draw text if present
        if (element.text) {
            this.drawElementText(ctx, element);
        }
    }
    
    createRoundedRectPath(x, y, w, h, r) {
        return `M ${x + r} ${y} ` +
               `L ${x + w - r} ${y} ` +
               `Q ${x + w} ${y} ${x + w} ${y + r} ` +
               `L ${x + w} ${y + h - r} ` +
               `Q ${x + w} ${y + h} ${x + w - r} ${y + h} ` +
               `L ${x + r} ${y + h} ` +
               `Q ${x} ${y + h} ${x} ${y + h - r} ` +
               `L ${x} ${y + r} ` +
               `Q ${x} ${y} ${x + r} ${y} Z`;
    }
    
    drawDiamond(ctx, rc, element, options) {
        const cx = element.x;
        const cy = element.y;
        const hw = element.width / 2;
        const hh = element.height / 2;

        ctx.save();
        this.applyStrokeStyle(ctx, element);
        
        // Calculate bounding box for gradient/pattern
        const x = cx - hw;
        const y = cy - hh;
        const w = element.width;
        const h = element.height;
        
        // Apply fill
        const hasFill = this.applyFill(ctx, element, x, y, w, h);
        
        ctx.beginPath();
        ctx.moveTo(cx, cy - hh);
        ctx.lineTo(cx + hw, cy);
        ctx.lineTo(cx, cy + hh);
        ctx.lineTo(cx - hw, cy);
        ctx.closePath();
        
        if (hasFill) {
            ctx.fill();
        }
        ctx.stroke();
        ctx.restore();
        
        // Draw text if present
        if (element.text) {
            this.drawElementText(ctx, element);
        }
    }
    
    drawEllipse(ctx, rc, element, options) {
        const cx = element.x;
        const cy = element.y;
        const rx = element.width / 2;
        const ry = element.height / 2;

        ctx.save();
        this.applyStrokeStyle(ctx, element);
        
        // Calculate bounding box for gradient/pattern
        const x = cx - rx;
        const y = cy - ry;
        const w = element.width;
        const h = element.height;
        
        // Apply fill
        const hasFill = this.applyFill(ctx, element, x, y, w, h);
        
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        
        if (hasFill) {
            ctx.fill();
        }
        ctx.stroke();
        ctx.restore();
        
        // Draw text if present
        if (element.text) {
            this.drawElementText(ctx, element);
        }
    }
    
    drawLine(ctx, rc, element, options) {
        if (!element.points || element.points.length < 2) return;
        
        const p1 = element.points[0];
        const p2 = element.points[1];

        ctx.save();
        this.applyStrokeStyle(ctx, element);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.restore();
    }
    
    drawArrow(ctx, rc, element, options) {
        if (!element.points || element.points.length < 2) return;
        
        const p1 = element.points[0];
        const p2 = element.points[1];
        
        // Draw line
        ctx.save();
        this.applyStrokeStyle(ctx, element);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        
        // Draw arrowhead
        const arrowSize = Math.max(10, (element.strokeWidth || 2) * 4);
        const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        
        const arrowAngle1 = angle + Math.PI * 0.85;
        const arrowAngle2 = angle - Math.PI * 0.85;
        
        const ax1 = p2.x + Math.cos(arrowAngle1) * arrowSize;
        const ay1 = p2.y + Math.sin(arrowAngle1) * arrowSize;
        const ax2 = p2.x + Math.cos(arrowAngle2) * arrowSize;
        const ay2 = p2.y + Math.sin(arrowAngle2) * arrowSize;
        
        ctx.fillStyle = element.strokeColor || '#000000';
        ctx.beginPath();
        ctx.moveTo(ax1, ay1);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(ax2, ay2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }
    
    drawFreedraw(ctx, element) {
        if (!element.points || element.points.length < 2) return;
        
        ctx.save();
        ctx.strokeStyle = element.strokeColor || '#000000';
        ctx.lineWidth = element.strokeWidth || 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = element.opacity ?? 1;
        
        if (element.strokeStyle === 'dashed') {
            ctx.setLineDash([8, 8]);
        } else if (element.strokeStyle === 'dotted') {
            ctx.setLineDash([2, 4]);
        }
        
        ctx.beginPath();
        ctx.moveTo(element.points[0].x, element.points[0].y);
        
        // Use quadratic curves for smooth lines
        for (let i = 1; i < element.points.length - 1; i++) {
            const xc = (element.points[i].x + element.points[i + 1].x) / 2;
            const yc = (element.points[i].y + element.points[i + 1].y) / 2;
            ctx.quadraticCurveTo(element.points[i].x, element.points[i].y, xc, yc);
        }
        
        if (element.points.length > 1) {
            const last = element.points[element.points.length - 1];
            ctx.lineTo(last.x, last.y);
        }
        
        ctx.stroke();
        ctx.restore();
    }
    
    drawText(ctx, element) {
        if (!element.text) return;
        
        const fontSize = element.fontSize || 20;
        const fontFamily = element.fontFamily || 'Virgil, cursive';
        
        ctx.save();
        ctx.font = `${fontSize}px ${fontFamily}`;
        ctx.fillStyle = element.strokeColor || '#000000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.globalAlpha = element.opacity ?? 1;
        
        // Wrap text
        const lines = element.text.split('\n');
        const lineHeight = fontSize * 1.4;
        const totalHeight = lines.length * lineHeight;
        
        lines.forEach((line, index) => {
            const y = element.y - totalHeight / 2 + lineHeight / 2 + index * lineHeight;
            ctx.fillText(line, element.x, y);
        });
        
        ctx.restore();
    }
    
    drawElementText(ctx, element) {
        if (!element.text) return;
        
        const fontSize = element.fontSize || 20;
        const fontFamily = element.fontFamily || 'Virgil, cursive';
        
        ctx.save();
        ctx.font = `${fontSize}px ${fontFamily}`;
        ctx.fillStyle = element.strokeColor || '#000000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.globalAlpha = element.opacity ?? 1;
        
        // Calculate text area
        const padding = 10;
        const maxWidth = element.width - padding * 2;
        const lines = this.wrapText(ctx, element.text, maxWidth);
        const lineHeight = fontSize * 1.4;
        const totalHeight = lines.length * lineHeight;
        
        // Clip to element bounds
        const x = element.x - element.width / 2;
        const y = element.y - element.height / 2;
        ctx.beginPath();
        ctx.rect(x, y, element.width, element.height);
        ctx.clip();
        
        lines.forEach((line, index) => {
            const lineY = element.y - totalHeight / 2 + lineHeight / 2 + index * lineHeight;
            ctx.fillText(line, element.x, lineY);
        });
        
        ctx.restore();
    }
    
    wrapText(ctx, text, maxWidth) {
        const words = text.split(' ');
        const lines = [];
        let currentLine = words[0];
        
        for (let i = 1; i < words.length; i++) {
            const word = words[i];
            const width = ctx.measureText(currentLine + ' ' + word).width;
            if (width < maxWidth) {
                currentLine += ' ' + word;
            } else {
                lines.push(currentLine);
                currentLine = word;
            }
        }
        lines.push(currentLine);
        return lines;
    }
    
    drawImage(ctx, element) {
        if (!element.imageElement) return;
        
        const x = element.x - element.width / 2;
        const y = element.y - element.height / 2;
        
        ctx.save();
        ctx.globalAlpha = element.opacity ?? 1;
        
        // Check if image is fully loaded
        if (element.imageElement.complete && element.imageElement.naturalWidth !== 0) {
            ctx.drawImage(element.imageElement, x, y, element.width, element.height);
            
            // Draw AI-generated indicator
            if (element.aiGenerated) {
                this.drawAIGeneratedIndicator(ctx, element);
            }
        } else {
            // Draw placeholder while loading
            ctx.fillStyle = 'rgba(168, 165, 255, 0.2)';
            ctx.fillRect(x, y, element.width, element.height);
            ctx.strokeStyle = '#a8a5ff';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.strokeRect(x, y, element.width, element.height);
            ctx.setLineDash([]);
            
            // Draw loading text
            ctx.fillStyle = '#666';
            ctx.font = '14px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Loading...', element.x, element.y);
        }
        
        ctx.restore();
    }
    
    drawAIGeneratedIndicator(ctx, element) {
        const x = element.x - element.width / 2;
        const y = element.y - element.height / 2;
        
        // Draw small AI badge in corner
        const badgeSize = 20;
        const badgeX = x + element.width - badgeSize - 4;
        const badgeY = y + 4;
        
        ctx.fillStyle = 'rgba(168, 165, 255, 0.9)';
        ctx.beginPath();
        ctx.arc(badgeX + badgeSize/2, badgeY + badgeSize/2, badgeSize/2, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.fillStyle = 'white';
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('AI', badgeX + badgeSize/2, badgeY + badgeSize/2);
    }
    
    drawSticky(ctx, rc, element, options) {
        const x = element.x - element.width / 2;
        const y = element.y - element.height / 2;
        const w = element.width;
        const h = element.height;
        
        // Draw sticky note with slight rotation for hand-drawn look
        ctx.save();
        ctx.globalAlpha = element.opacity ?? 1;
        
        // Apply fill for sticky note
        if (element.fillType === 'gradient' && element.gradient) {
            const gradient = this.createGradient(ctx, element, x, y, w, h);
            if (gradient) ctx.fillStyle = gradient;
            else ctx.fillStyle = element.backgroundColor || '#ffec99';
        } else if (element.fillType === 'pattern' && element.pattern) {
            const pattern = this.createPattern(ctx, element);
            if (pattern) ctx.fillStyle = pattern;
            else ctx.fillStyle = element.backgroundColor || '#ffec99';
        } else {
            ctx.fillStyle = element.backgroundColor || '#ffec99';
        }
        
        ctx.fillRect(x, y, w, h);
        
        // Draw border
        ctx.strokeStyle = element.strokeColor || '#e6b800';
        ctx.lineWidth = element.strokeWidth || 1;
        ctx.strokeRect(x, y, w, h);
        
        // Draw shadow
        ctx.fillStyle = 'rgba(0,0,0,0.1)';
        ctx.fillRect(x + 4, y + h, w, 4);
        ctx.fillRect(x + w, y + 4, 4, h);
        
        ctx.restore();
        
        // Draw text
        if (element.text) {
            this.drawStickyText(ctx, element);
        }
    }
    
    drawStickyText(ctx, element) {
        if (!element.text) return;
        
        const fontSize = 16;
        const fontFamily = element.fontFamily || 'Virgil, cursive';
        
        ctx.save();
        ctx.font = `${fontSize}px ${fontFamily}`;
        ctx.fillStyle = element.strokeColor || '#5c4b00';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.globalAlpha = element.opacity ?? 1;
        
        const padding = 12;
        const maxWidth = element.width - padding * 2;
        const lines = this.wrapText(ctx, element.text, maxWidth);
        const lineHeight = fontSize * 1.5;
        
        const startX = element.x - element.width / 2 + padding;
        const startY = element.y - element.height / 2 + padding;
        
        lines.forEach((line, index) => {
            const lineY = startY + index * lineHeight;
            if (lineY + fontSize < startY + element.height - padding) {
                ctx.fillText(line, startX, lineY);
            }
        });
        
        ctx.restore();
    }
    
    drawFrame(ctx, rc, element, options) {
        const x = element.x - element.width / 2;
        const y = element.y - element.height / 2;
        const w = element.width;
        const h = element.height;
        
        ctx.save();
        ctx.globalAlpha = element.opacity ?? 1;
        
        // Apply fill for frame background
        if (element.fillType === 'gradient' && element.gradient) {
            const gradient = this.createGradient(ctx, element, x, y, w, h);
            if (gradient) ctx.fillStyle = gradient;
            else if (element.backgroundColor && element.backgroundColor !== 'transparent') {
                ctx.fillStyle = element.backgroundColor;
            }
        } else if (element.fillType === 'pattern' && element.pattern) {
            const pattern = this.createPattern(ctx, element);
            if (pattern) ctx.fillStyle = pattern;
            else if (element.backgroundColor && element.backgroundColor !== 'transparent') {
                ctx.fillStyle = element.backgroundColor;
            }
        } else if (element.backgroundColor && element.backgroundColor !== 'transparent') {
            ctx.fillStyle = element.backgroundColor;
        }
        
        if (element.backgroundColor && element.backgroundColor !== 'transparent') {
            ctx.fillRect(x, y, w, h);
        }
        
        // Draw frame border (thicker)
        ctx.strokeStyle = element.strokeColor || '#999999';
        ctx.lineWidth = (element.strokeWidth || 2) * 2;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
        
        // Draw title bar
        const titleHeight = 30;
        ctx.fillStyle = element.strokeColor || '#999999';
        ctx.fillRect(x, y, w, titleHeight);
        
        // Draw frame name
        if (element.name) {
            ctx.fillStyle = '#ffffff';
            ctx.font = `bold 14px system-ui, sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(element.name, x + 10, y + titleHeight / 2);
        }
        
        ctx.restore();
    }

    drawStoryboardFrame(ctx, element) {
        const x = element.x - element.width / 2;
        const y = element.y - element.height / 2;
        const w = element.width;
        const h = element.height;

        ctx.save();
        ctx.globalAlpha = element.opacity ?? 1;
        this.drawPanelShell(ctx, element, x, y, w, h, '#f8fafc', '#334155');

        ctx.fillStyle = 'rgba(51, 65, 85, 0.08)';
        ctx.fillRect(x + 12, y + 34, w - 24, Math.max(34, h - 76));
        ctx.strokeStyle = 'rgba(51, 65, 85, 0.28)';
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(x + 12, y + 34, w - 24, Math.max(34, h - 76));
        ctx.setLineDash([]);

        this.drawPanelTitle(ctx, element.title || 'Storyboard frame', x, y, w, '#0f172a');
        this.drawPanelTimecode(ctx, element, x + w - 82, y + 12, '#334155', '#e2e8f0');
        this.drawWrappedPanelText(ctx, element.text || '', x + 14, y + h - 34, w - 28, 13, '#475569', 2);
        this.drawProductionPlaybackState(ctx, element, x, y, w, h, '#334155');
        ctx.restore();
    }

    drawAnimationBeat(ctx, element) {
        const x = element.x - element.width / 2;
        const y = element.y - element.height / 2;
        const w = element.width;
        const h = element.height;

        ctx.save();
        ctx.globalAlpha = element.opacity ?? 1;
        this.drawPanelShell(ctx, element, x, y, w, h, '#ecfeff', '#0e7490');
        this.drawPanelTitle(ctx, element.title || 'Animation beat', x, y, w, '#164e63');
        this.drawPanelTimecode(ctx, element, x + w - 82, y + 12, '#0e7490', '#cffafe');

        const railY = y + h - 26;
        ctx.strokeStyle = '#0e7490';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + 18, railY);
        ctx.lineTo(x + w - 18, railY);
        ctx.stroke();
        [0.18, 0.5, 0.82].forEach((tick) => {
            const tx = x + w * tick;
            ctx.fillStyle = '#0e7490';
            ctx.beginPath();
            ctx.arc(tx, railY, 4, 0, Math.PI * 2);
            ctx.fill();
        });

        const preset = String(element.motionPreset || 'ease').toUpperCase();
        ctx.fillStyle = '#cffafe';
        ctx.strokeStyle = '#0e7490';
        ctx.lineWidth = 1;
        this.roundRectPath(ctx, x + 15, y + h - 52, 58, 18, 9);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#155e75';
        ctx.font = '800 9px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(preset.slice(0, 7), x + 44, y + h - 43, 48);

        this.drawWrappedPanelText(ctx, element.text || '', x + 16, y + 36, w - 32, 13, '#155e75', 3);
        this.drawProductionPlaybackState(ctx, element, x, y, w, h, '#0e7490');
        ctx.restore();
    }

    drawAudioCue(ctx, element) {
        const x = element.x - element.width / 2;
        const y = element.y - element.height / 2;
        const w = element.width;
        const h = element.height;

        ctx.save();
        ctx.globalAlpha = element.opacity ?? 1;
        this.drawPanelShell(ctx, element, x, y, w, h, '#fff7ed', '#9a3412');
        this.drawPanelTitle(ctx, element.title || 'Audio cue', x, y, w, '#7c2d12');
        this.drawPanelTimecode(ctx, element, x + w - 82, y + 12, '#9a3412', '#fed7aa');

        const detail = [
            element.audioName || '',
            Number.isFinite(element.duration) ? this.formatPanelDuration(element.duration) : '',
            element.audioPersistent === false ? 'session linked' : '',
        ].filter(Boolean).join(' - ');
        this.drawWrappedPanelText(ctx, detail || element.text || '', x + 16, y + 35, w - 32, 12, '#9a3412', 2);

        const waveY = y + h - 31;
        const peaks = Array.isArray(element.waveformPeaks) && element.waveformPeaks.length > 0
            ? element.waveformPeaks
            : Array.from({ length: 36 }, (_, index) => 0.35 + Math.abs(Math.sin(index * 0.85)) * 0.65);
        const barWidth = Math.max(2, (w - 34) / peaks.length - 2);
        ctx.fillStyle = '#ea580c';
        peaks.forEach((peak, index) => {
            const normalizedPeak = Math.max(0.12, Math.min(1, Number(peak) || 0.3));
            const barHeight = 7 + normalizedPeak * 22;
            const px = x + 17 + index * ((w - 34) / peaks.length);
            ctx.fillRect(px, waveY - barHeight / 2, barWidth, barHeight);
        });

        ctx.strokeStyle = '#ea580c';
        ctx.globalAlpha *= 0.22;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 16, waveY);
        ctx.lineTo(x + w - 16, waveY);
        ctx.stroke();

        this.drawProductionPlaybackState(ctx, element, x, y, w, h, '#ea580c');
        ctx.restore();
    }

    drawMermaidDiagram(ctx, element) {
        const x = element.x - element.width / 2;
        const y = element.y - element.height / 2;
        const w = element.width;
        const h = element.height;

        ctx.save();
        ctx.globalAlpha = element.opacity ?? 1;
        this.drawPanelShell(ctx, element, x, y, w, h, '#eef2ff', '#3730a3');
        this.drawPanelTitle(ctx, element.title || 'Mermaid diagram', x, y, w, '#312e81');

        ctx.fillStyle = '#111827';
        ctx.fillRect(x + 14, y + 40, w - 28, h - 54);
        this.drawWrappedPanelText(ctx, element.text || '', x + 24, y + 52, w - 48, 12, '#bfdbfe', 5, '12px "Roboto Mono", Consolas, monospace');
        const nodeCount = Array.isArray(element.mermaidNodes) ? element.mermaidNodes.length : 0;
        if (nodeCount > 0) {
            ctx.fillStyle = '#c7d2fe';
            ctx.font = '700 11px Inter, system-ui, sans-serif';
            ctx.fillText(`${nodeCount} parsed node${nodeCount === 1 ? '' : 's'}`, x + 18, y + h - 22, w - 36);
        }
        ctx.restore();
    }

    drawPanelShell(ctx, element, x, y, w, h, fallbackFill, fallbackStroke) {
        ctx.fillStyle = element.backgroundColor || fallbackFill;
        ctx.strokeStyle = element.strokeColor || fallbackStroke;
        ctx.lineWidth = element.strokeWidth || 2;
        this.roundRectPath(ctx, x, y, w, h, 10);
        ctx.fill();
        ctx.stroke();
    }

    drawPanelTitle(ctx, title, x, y, w, color) {
        ctx.fillStyle = color;
        ctx.font = '700 14px Inter, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(String(title || '').slice(0, 42), x + 14, y + 12, w - 28);
    }

    drawPanelTimecode(ctx, element, x, y, stroke, fill) {
        if (!Number.isFinite(element.startTime)) return;
        const duration = Number.isFinite(element.durationSeconds) ? element.durationSeconds : 4;
        const text = `${this.formatPanelDuration(element.startTime)}-${this.formatPanelDuration(element.startTime + duration)}`;
        ctx.save();
        ctx.fillStyle = fill;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        this.roundRectPath(ctx, x, y, 68, 20, 10);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = stroke;
        ctx.font = '700 10px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x + 34, y + 10, 58);
        ctx.restore();
    }

    drawProductionPlaybackState(ctx, element, x, y, w, h, color) {
        const previewState = window.app?.getTimelineCuePreviewState?.(element);
        if (!previewState?.active) {
            return;
        }
        const progress = Math.max(0, Math.min(1, Number(previewState.progress) || 0));

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.globalAlpha = 0.86;
        this.roundRectPath(ctx, x - 5, y - 5, w + 10, h + 10, 14);
        ctx.stroke();

        ctx.fillStyle = color;
        this.roundRectPath(ctx, x + 12, y - 14, 74, 22, 11);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = '900 10px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(previewState.isPlaying ? 'PLAYING' : 'CUE', x + 49, y - 3, 60);

        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
        this.roundRectPath(ctx, x + 12, y + h + 8, w - 24, 8, 4);
        ctx.fill();
        ctx.fillStyle = color;
        this.roundRectPath(ctx, x + 12, y + h + 8, Math.max(8, (w - 24) * progress), 8, 4);
        ctx.fill();

        if (element.type === 'animationBeat') {
            const railY = y + h + 26;
            const startX = x + 18;
            const endX = x + w - 18;
            const markerX = startX + (endX - startX) * progress;
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 5]);
            ctx.beginPath();
            ctx.moveTo(startX, railY);
            ctx.lineTo(endX, railY);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(markerX, railY, 6, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    drawWrappedPanelText(ctx, text, x, y, maxWidth, fontSize, color, maxLines = 3, font = '') {
        ctx.fillStyle = color;
        ctx.font = font || `${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const lines = String(text || '')
            .split(/\r?\n/)
            .flatMap((line) => this.wrapText(ctx, line, maxWidth))
            .slice(0, maxLines);
        lines.forEach((line, index) => {
            ctx.fillText(line, x, y + index * fontSize * 1.35);
        });
    }

    formatPanelDuration(seconds) {
        const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
        const minutes = Math.floor(safeSeconds / 60);
        const rest = String(safeSeconds % 60).padStart(2, '0');
        return `${minutes}:${rest}`;
    }

    roundRectPath(ctx, x, y, w, h, radius = 8) {
        const r = Math.min(radius, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }
    
    drawFallbackElement(ctx, element) {
        if (element.points && element.points.length >= 2) {
            ctx.save();
            this.applyStrokeStyle(ctx, element);
            ctx.beginPath();
            ctx.moveTo(element.points[0].x, element.points[0].y);
            for (let i = 1; i < element.points.length; i++) {
                ctx.lineTo(element.points[i].x, element.points[i].y);
            }
            ctx.stroke();
            ctx.restore();
            return;
        }

        if (!element.width || !element.height) {
            return;
        }

        const x = element.x - element.width / 2;
        const y = element.y - element.height / 2;
        const label = element.text || element.name || element.type;

        ctx.save();
        this.applyStrokeStyle(ctx, element);
        ctx.setLineDash([8, 6]);
        this.beginRoundedRect(ctx, x, y, element.width, element.height, 14);
        if (this.applyFill(ctx, element, x, y, element.width, element.height)) {
            ctx.fill();
        }
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.fillStyle = element.strokeColor || '#000000';
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, element.x, element.y);
        ctx.restore();
    }
    
    drawSelection(ctx, element) {
        if (!element) return;
        
        const canvas = window.infiniteCanvas;
        const padding = 4;
        let x, y, w, h;
        
        if (element.type === 'line' || element.type === 'arrow') {
            if (!element.points || element.points.length < 2) return;
            const p1 = element.points[0];
            const p2 = element.points[1];
            x = Math.min(p1.x, p2.x) - padding;
            y = Math.min(p1.y, p2.y) - padding;
            w = Math.abs(p2.x - p1.x) + padding * 2;
            h = Math.abs(p2.y - p1.y) + padding * 2;
        } else if (element.type === 'freedraw') {
            if (!element.points || element.points.length === 0) return;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of element.points) {
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
            x = element.x - element.width / 2 - padding;
            y = element.y - element.height / 2 - padding;
            w = element.width + padding * 2;
            h = element.height + padding * 2;
        }
        
        ctx.save();
        ctx.strokeStyle = '#a8a5ff';
        ctx.lineWidth = 1 / canvas.scale;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
        
        // Draw resize handles for single selection
        if (canvas.selectedElements.length === 1) {
            this.drawResizeHandles(ctx, x, y, w, h, canvas.scale);
        }
    }
    
    drawResizeHandles(ctx, x, y, w, h, scale) {
        const handleSize = 10 / scale;
        const handleOffset = handleSize / 2;
        
        const handles = [
            { x: x, y: y }, // nw
            { x: x + w / 2, y: y }, // n
            { x: x + w, y: y }, // ne
            { x: x + w, y: y + h / 2 }, // e
            { x: x + w, y: y + h }, // se
            { x: x + w / 2, y: y + h }, // s
            { x: x, y: y + h }, // sw
            { x: x, y: y + h / 2 } // w
        ];
        
        ctx.save();
        
        // Draw shadow/glow for visibility on light backgrounds
        ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
        ctx.shadowBlur = 4 / scale;
        ctx.shadowOffsetX = 1 / scale;
        ctx.shadowOffsetY = 1 / scale;
        
        // Draw handles with shadow
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#a8a5ff';
        ctx.lineWidth = 2 / scale;
        
        for (const handle of handles) {
            ctx.beginPath();
            ctx.rect(handle.x - handleOffset, handle.y - handleOffset, handleSize, handleSize);
            ctx.fill();
            ctx.stroke();
        }
        
        // Reset shadow and draw outline for additional visibility
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        
        // Draw dark outline
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.lineWidth = 0.5 / scale;
        
        for (const handle of handles) {
            ctx.beginPath();
            ctx.rect(handle.x - handleOffset, handle.y - handleOffset, handleSize, handleSize);
            ctx.stroke();
        }
        
        ctx.restore();
    }
    
    beginRoundedRect(ctx, x, y, width, height, radius) {
        if (!radius) {
            ctx.beginPath();
            ctx.rect(x, y, width, height);
            return;
        }

        const safeRadius = Math.min(radius, width / 2, height / 2);
        ctx.beginPath();
        ctx.moveTo(x + safeRadius, y);
        ctx.lineTo(x + width - safeRadius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
        ctx.lineTo(x + width, y + height - safeRadius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
        ctx.lineTo(x + safeRadius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
        ctx.lineTo(x, y + safeRadius);
        ctx.quadraticCurveTo(x, y, x + safeRadius, y);
        ctx.closePath();
    }

    applyStrokeStyle(ctx, element) {
        ctx.strokeStyle = element.strokeColor || '#000000';
        ctx.lineWidth = element.strokeWidth || 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([]);

        if (element.strokeStyle === 'dashed') {
            ctx.setLineDash([8, 8]);
        } else if (element.strokeStyle === 'dotted') {
            ctx.setLineDash([2, 6]);
        }
    }

    applyFillStyle(ctx, element) {
        ctx.fillStyle = element.backgroundColor && element.backgroundColor !== 'transparent'
            ? element.backgroundColor
            : 'transparent';
    }
    
    // Update selection box UI
    updateSelectionBox(element) {
        const selectionBox = document.getElementById('selectionBox');
        if (!element || !selectionBox) {
            if (selectionBox) selectionBox.style.display = 'none';
            return;
        }
        
        const canvas = window.infiniteCanvas;
        const padding = 4;
        
        let x, y, w, h;
        
        if (element.type === 'line' || element.type === 'arrow') {
            if (!element.points || element.points.length < 2) return;
            const p1 = element.points[0];
            const p2 = element.points[1];
            x = Math.min(p1.x, p2.x) - padding;
            y = Math.min(p1.y, p2.y) - padding;
            w = Math.abs(p2.x - p1.x) + padding * 2;
            h = Math.abs(p2.y - p1.y) + padding * 2;
        } else if (element.type === 'freedraw') {
            if (!element.points || element.points.length === 0) return;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of element.points) {
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
            x = element.x - element.width / 2 - padding;
            y = element.y - element.height / 2 - padding;
            w = element.width + padding * 2;
            h = element.height + padding * 2;
        }
        
        // Convert to screen coordinates
        const screenPos = canvas.worldToScreen(x, y);
        
        selectionBox.style.display = 'block';
        selectionBox.style.left = screenPos.x + 'px';
        selectionBox.style.top = screenPos.y + 'px';
        selectionBox.style.width = (w * canvas.scale) + 'px';
        selectionBox.style.height = (h * canvas.scale) + 'px';
    }
    
    hideSelectionBox() {
        const selectionBox = document.getElementById('selectionBox');
        if (selectionBox) {
            selectionBox.style.display = 'none';
        }
    }
}

// Create global instance
window.renderer = new Renderer();
