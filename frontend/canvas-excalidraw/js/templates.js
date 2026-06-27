/**
 * Templates Module - Pre-made diagram templates
 * Templates: Flowchart, Wireframe, Mind Map, Org Chart, Kanban, SWOT, Timeline, Gantt
 */

class TemplatesManager {
    constructor() {
        this.templates = this.defineTemplates();
        this.previousFocus = null;
        this.init();
    }
    
    init() {
        document.addEventListener('DOMContentLoaded', () => {
            this.setupEventListeners();
        });
    }
    
    setupEventListeners() {
        // Template cards
        document.querySelectorAll('.template-card').forEach(card => {
            card.addEventListener('click', () => {
                const templateName = card.dataset.template;
                this.loadTemplate(templateName);
            });
        });
        
        // Close modal
        document.getElementById('closeTemplates')?.addEventListener('click', () => {
            this.hideTemplatesModal();
        });
        
        // Close on backdrop click
        document.getElementById('templatesModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                this.hideTemplatesModal();
            }
        });
        
        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.hideTemplatesModal();
            }
        });

        document.getElementById('templatesModal')?.addEventListener('keydown', (e) => {
            this.handleTemplatesModalKeydown(e);
        });
    }
    
    showTemplatesModal() {
        const modal = document.getElementById('templatesModal');
        if (modal) {
            this.previousFocus = document.activeElement?.focus ? document.activeElement : null;
            modal.style.display = 'flex';
            modal.classList.add('active');
            modal.setAttribute('aria-hidden', 'false');
            document.getElementById('closeTemplates')?.focus({ preventScroll: true });
        }
    }
    
    hideTemplatesModal() {
        const modal = document.getElementById('templatesModal');
        if (modal) {
            modal.style.display = 'none';
            modal.classList.remove('active');
            modal.setAttribute('aria-hidden', 'true');
            if (this.previousFocus && document.contains(this.previousFocus)) {
                this.previousFocus.focus({ preventScroll: true });
            }
            this.previousFocus = null;
        }
    }

    handleTemplatesModalKeydown(event) {
        if (event.key !== 'Tab') return;

        const modal = document.getElementById('templatesModal');
        if (!modal || !modal.classList.contains('active')) return;

        const focusable = Array.from(modal.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )).filter((element) => !element.disabled && element.getAttribute('aria-hidden') !== 'true');

        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus({ preventScroll: true });
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus({ preventScroll: true });
        }
    }
    
    loadTemplate(templateName) {
        const template = this.templates[templateName];
        if (!template) return;
        
        const canvas = window.infiniteCanvas;
        if (!canvas) return;
        
        // Clear existing selection
        canvas.deselectAll();
        
        // Generate elements from template
        const elements = template.generator();
        const newElements = [];
        
        elements.forEach(el => {
            const newEl = {
                ...el,
                id: window.toolManager.generateId()
            };
            canvas.elements.push(newEl);
            newElements.push(newEl);
        });
        
        // Select the new elements
        newElements.forEach(el => canvas.selectElement(el, true));
        
        // Hide modal
        this.hideTemplatesModal();
        
        // Render and save
        canvas.render();
        window.historyManager?.pushState(canvas.elements);
        
        // Show toast
        window.app?.showToast?.(`Loaded ${template.name} template`);
    }
    
    defineTemplates() {
        const defaultProps = () => ({
            strokeColor: '#000000',
            backgroundColor: 'transparent',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            edgeType: 'sharp',
            opacity: 1
        });
        
        return {
            flowchart: {
                name: 'Flowchart',
                generator: () => {
                    const elements = [];
                    const startY = 0;
                    const spacing = 120;
                    
                    // Start node (rounded rect)
                    elements.push({
                        type: 'rectangle',
                        x: 0, y: startY,
                        width: 120, height: 60,
                        text: 'Start',
                        edgeType: 'round',
                        backgroundColor: '#b2f2bb',
                        ...defaultProps()
                    });
                    
                    // Process
                    elements.push({
                        type: 'rectangle',
                        x: 0, y: startY + spacing,
                        width: 140, height: 70,
                        text: 'Process',
                        ...defaultProps()
                    });
                    
                    // Decision (diamond)
                    elements.push({
                        type: 'diamond',
                        x: 0, y: startY + spacing * 2,
                        width: 140, height: 100,
                        text: 'Decision?',
                        backgroundColor: '#ffec99',
                        ...defaultProps()
                    });
                    
                    // Yes/No branches
                    elements.push({
                        type: 'rectangle',
                        x: -150, y: startY + spacing * 3,
                        width: 100, height: 60,
                        text: 'Yes',
                        backgroundColor: '#a5d8ff',
                        ...defaultProps()
                    });
                    
                    elements.push({
                        type: 'rectangle',
                        x: 150, y: startY + spacing * 3,
                        width: 100, height: 60,
                        text: 'No',
                        backgroundColor: '#ffc9c9',
                        ...defaultProps()
                    });
                    
                    // End
                    elements.push({
                        type: 'rectangle',
                        x: 0, y: startY + spacing * 4,
                        width: 120, height: 60,
                        text: 'End',
                        edgeType: 'round',
                        backgroundColor: '#eebefa',
                        ...defaultProps()
                    });
                    
                    // Connect with arrows
                    const connections = [
                        [[0, startY + 30], [0, startY + spacing - 35]],
                        [[0, startY + spacing + 35], [0, startY + spacing * 2 - 50]],
                        [[-50, startY + spacing * 2], [-120, startY + spacing * 2], [-120, startY + spacing * 3 - 30]],
                        [[50, startY + spacing * 2], [120, startY + spacing * 2], [120, startY + spacing * 3 - 30]],
                        [[-150, startY + spacing * 3 + 30], [-150, startY + spacing * 3.5], [0, startY + spacing * 3.5], [0, startY + spacing * 4 - 30]],
                        [[150, startY + spacing * 3 + 30], [150, startY + spacing * 3.5], [0, startY + spacing * 3.5]]
                    ];
                    
                    connections.forEach(conn => {
                        if (conn.length === 2) {
                            elements.push({
                                type: 'arrow',
                                points: [
                                    { x: conn[0][0], y: conn[0][1] },
                                    { x: conn[1][0], y: conn[1][1] }
                                ],
                                x: (conn[0][0] + conn[1][0]) / 2,
                                y: (conn[0][1] + conn[1][1]) / 2,
                                width: Math.abs(conn[1][0] - conn[0][0]),
                                height: Math.abs(conn[1][1] - conn[0][1]),
                                ...defaultProps()
                            });
                        }
                    });
                    
                    return elements;
                }
            },
            
            wireframe: {
                name: 'Wireframe',
                generator: () => {
                    const elements = [];
                    
                    // Phone frame
                    elements.push({
                        type: 'rectangle',
                        x: 0, y: 0,
                        width: 300, height: 550,
                        edgeType: 'round',
                        strokeWidth: 3,
                        ...defaultProps()
                    });
                    
                    // Status bar
                    elements.push({
                        type: 'rectangle',
                        x: 0, y: -245,
                        width: 280, height: 30,
                        backgroundColor: '#e9e9e9',
                        roughness: 0,
                        ...defaultProps()
                    });
                    
                    // Header
                    elements.push({
                        type: 'rectangle',
                        x: 0, y: -200,
                        width: 260, height: 50,
                        backgroundColor: '#a8a5ff',
                        text: 'Header',
                        fontSize: 16,
                        roughness: 0,
                        ...defaultProps()
                    });
                    
                    // Content cards
                    for (let i = 0; i < 3; i++) {
                        elements.push({
                            type: 'rectangle',
                            x: 0, y: -100 + i * 110,
                            width: 260, height: 90,
                            backgroundColor: '#f5f5f5',
                            roughness: 0,
                            ...defaultProps()
                        });
                        
                        // Card image placeholder
                        elements.push({
                            type: 'rectangle',
                            x: -75, y: -100 + i * 110,
                            width: 80, height: 70,
                            backgroundColor: '#e0e0e0',
                            roughness: 0,
                            ...defaultProps()
                        });
                        
                        // Text lines
                        elements.push({
                            type: 'rectangle',
                            x: 50, y: -115 + i * 110,
                            width: 120, height: 10,
                            backgroundColor: '#cccccc',
                            roughness: 0,
                            ...defaultProps()
                        });
                        
                        elements.push({
                            type: 'rectangle',
                            x: 50, y: -95 + i * 110,
                            width: 80, height: 10,
                            backgroundColor: '#cccccc',
                            roughness: 0,
                            ...defaultProps()
                        });
                    }
                    
                    // Bottom nav
                    elements.push({
                        type: 'rectangle',
                        x: 0, y: 235,
                        width: 280, height: 50,
                        backgroundColor: '#f5f5f5',
                        roughness: 0,
                        ...defaultProps()
                    });
                    
                    // Nav items
                    [-80, 0, 80].forEach(x => {
                        elements.push({
                            type: 'ellipse',
                            x: x, y: 235,
                            width: 30, height: 30,
                            backgroundColor: '#cccccc',
                            roughness: 0,
                            ...defaultProps()
                        });
                    });
                    
                    return elements;
                }
            },
            
            mindmap: {
                name: 'Mind Map',
                generator: () => {
                    const elements = [];
                    const centerX = 0, centerY = 0;
                    
                    // Central node
                    elements.push({
                        type: 'ellipse',
                        x: centerX, y: centerY,
                        width: 160, height: 100,
                        text: 'Central\nTopic',
                        backgroundColor: '#ffec99',
                        strokeWidth: 3,
                        ...defaultProps()
                    });
                    
                    // Branch nodes
                    const branches = [
                        { x: 250, y: -150, text: 'Branch 1', color: '#ffc9c9' },
                        { x: 300, y: 0, text: 'Branch 2', color: '#b2f2bb' },
                        { x: 250, y: 150, text: 'Branch 3', color: '#a5d8ff' },
                        { x: -250, y: -150, text: 'Branch 4', color: '#eebefa' },
                        { x: -300, y: 0, text: 'Branch 5', color: '#ffd8a8' },
                        { x: -250, y: 150, text: 'Branch 6', color: '#96f2d7' }
                    ];
                    
                    branches.forEach(branch => {
                        // Branch node
                        elements.push({
                            type: 'rectangle',
                            x: branch.x, y: branch.y,
                            width: 120, height: 70,
                            text: branch.text,
                            backgroundColor: branch.color,
                            edgeType: 'round',
                            ...defaultProps()
                        });
                        
                        // Connection line
                        elements.push({
                            type: 'line',
                            points: [
                                { x: centerX + (branch.x > 0 ? 70 : -70), y: centerY + (branch.y * 0.3) },
                                { x: branch.x + (branch.x > 0 ? -55 : 55), y: branch.y }
                            ],
                            x: (centerX + branch.x) / 2,
                            y: (centerY + branch.y) / 2,
                            width: Math.abs(branch.x - centerX) - 125,
                            height: Math.abs(branch.y - centerY),
                            strokeWidth: 2,
                            ...defaultProps()
                        });
                        
                        // Sub-branches
                        const subOffset = branch.y > 0 ? 80 : -80;
                        elements.push({
                            type: 'rectangle',
                            x: branch.x + (branch.x > 0 ? 120 : -120), y: branch.y + subOffset,
                            width: 90, height: 50,
                            text: 'Sub-topic',
                            backgroundColor: '#f8f9fa',
                            roughness: 0,
                            ...defaultProps()
                        });
                        
                        elements.push({
                            type: 'line',
                            points: [
                                { x: branch.x + (branch.x > 0 ? 55 : -55), y: branch.y + (subOffset > 0 ? 25 : -25) },
                                { x: branch.x + (branch.x > 0 ? 120 : -120) - (branch.x > 0 ? 40 : -40), y: branch.y + subOffset }
                            ],
                            x: branch.x + (branch.x > 0 ? 87 : -87),
                            y: branch.y + subOffset / 2,
                            width: 65,
                            height: Math.abs(subOffset) - 25,
                            strokeWidth: 1,
                            ...defaultProps()
                        });
                    });
                    
                    return elements;
                }
            },
            
            orgchart: {
                name: 'Org Chart',
                generator: () => {
                    const elements = [];
                    
                    // CEO
                    elements.push({
                        type: 'rectangle',
                        x: 0, y: -200,
                        width: 140, height: 80,
                        text: 'CEO',
                        backgroundColor: '#eebefa',
                        edgeType: 'round',
                        strokeWidth: 3,
                        ...defaultProps()
                    });
                    
                    // Managers
                    const managers = ['CTO', 'CFO', 'COO'];
                    managers.forEach((title, i) => {
                        const x = (i - 1) * 200;
                        elements.push({
                            type: 'rectangle',
                            x: x, y: -50,
                            width: 130, height: 70,
                            text: title,
                            backgroundColor: '#a5d8ff',
                            edgeType: 'round',
                            ...defaultProps()
                        });
                        
                        // Connect to CEO
                        elements.push({
                            type: 'line',
                            points: [
                                { x: x, y: -85 },
                                { x: x, y: -160 }
                            ],
                            x: x, y: -122.5,
                            width: 0, height: 75,
                            strokeWidth: 2,
                            ...defaultProps()
                        });
                    });
                    
                    // Horizontal connector
                    elements.push({
                        type: 'line',
                        points: [
                            { x: -200, y: -160 },
                            { x: 200, y: -160 }
                        ],
                        x: 0, y: -160,
                        width: 400, height: 0,
                        strokeWidth: 2,
                        ...defaultProps()
                    });
                    
                    // CEO connector
                    elements.push({
                        type: 'line',
                        points: [
                            { x: 0, y: -160 },
                            { x: 0, y: -200 }
                        ],
                        x: 0, y: -180,
                        width: 0, height: 40,
                        strokeWidth: 2,
                        ...defaultProps()
                    });
                    
                    // Team members under each manager
                    managers.forEach((_, mi) => {
                        const mx = (mi - 1) * 200;
                        [-60, 60].forEach((offset, ti) => {
                            elements.push({
                                type: 'rectangle',
                                x: mx + offset, y: 80,
                                width: 100, height: 60,
                                text: `Team ${ti + 1}`,
                                backgroundColor: '#b2f2bb',
                                ...defaultProps()
                            });
                            
                            // Connect to manager
                            elements.push({
                                type: 'line',
                                points: [
                                    { x: mx + offset, y: 50 },
                                    { x: mx + offset, y: -15 }
                                ],
                                x: mx + offset, y: 17.5,
                                width: 0, height: 65,
                                strokeWidth: 1,
                                ...defaultProps()
                            });
                        });
                        
                        // Horizontal connector for team
                        elements.push({
                            type: 'line',
                            points: [
                                { x: mx - 60, y: 50 },
                                { x: mx + 60, y: 50 }
                            ],
                            x: mx, y: 50,
                            width: 120, height: 0,
                            strokeWidth: 1,
                            ...defaultProps()
                        });
                        
                        // Manager connector
                        elements.push({
                            type: 'line',
                            points: [
                                { x: mx, y: 50 },
                                { x: mx, y: -15 }
                            ],
                            x: mx, y: 17.5,
                            width: 0, height: 65,
                            strokeWidth: 1,
                            ...defaultProps()
                        });
                    });
                    
                    return elements;
                }
            },
            
            kanban: {
                name: 'Kanban Board',
                generator: () => {
                    const elements = [];
                    const columns = [
                        { name: 'To Do', color: '#ffc9c9' },
                        { name: 'In Progress', color: '#ffec99' },
                        { name: 'Review', color: '#a5d8ff' },
                        { name: 'Done', color: '#b2f2bb' }
                    ];
                    
                    columns.forEach((col, i) => {
                        const x = (i - 1.5) * 220;
                        
                        // Column header
                        elements.push({
                            type: 'rectangle',
                            x: x, y: -250,
                            width: 190, height: 50,
                            text: col.name,
                            backgroundColor: col.color,
                            roughness: 0,
                            ...defaultProps()
                        });
                        
                        // Column container
                        elements.push({
                            type: 'rectangle',
                            x: x, y: 0,
                            width: 190, height: 450,
                            backgroundColor: '#f8f9fa',
                            roughness: 0,
                            strokeWidth: 1,
                            ...defaultProps()
                        });
                        
                        // Cards
                        const cardCount = i === 0 ? 3 : i === 1 ? 2 : i === 2 ? 2 : 1;
                        for (let c = 0; c < cardCount; c++) {
                            elements.push({
                                type: 'sticky',
                                x: x, y: -140 + c * 110,
                                width: 160, height: 90,
                                text: `Task ${c + 1}`,
                                backgroundColor: '#ffffff',
                                strokeColor: '#e0e0e0',
                                roughness: 0,
                                strokeWidth: 1,
                                ...defaultProps()
                            });
                        }
                    });
                    
                    return elements;
                }
            },
            
            swot: {
                name: 'SWOT Analysis',
                generator: () => {
                    const elements = [];
                    
                    const quadrants = [
                        { x: -150, y: -120, title: 'Strengths', color: '#b2f2bb', icon: 'S' },
                        { x: 150, y: -120, title: 'Weaknesses', color: '#ffc9c9', icon: 'W' },
                        { x: -150, y: 120, title: 'Opportunities', color: '#a5d8ff', icon: 'O' },
                        { x: 150, y: 120, title: 'Threats', color: '#ffec99', icon: 'T' }
                    ];
                    
                    quadrants.forEach(q => {
                        // Quadrant background
                        elements.push({
                            type: 'rectangle',
                            x: q.x, y: q.y,
                            width: 250, height: 200,
                            backgroundColor: q.color,
                            roughness: 0,
                            opacity: 0.3,
                            ...defaultProps()
                        });
                        
                        // Border
                        elements.push({
                            type: 'rectangle',
                            x: q.x, y: q.y,
                            width: 250, height: 200,
                            roughness: 0,
                            strokeWidth: 2,
                            ...defaultProps()
                        });
                        
                        // Icon circle
                        elements.push({
                            type: 'ellipse',
                            x: q.x - 80, y: q.y - 60,
                            width: 40, height: 40,
                            backgroundColor: q.color,
                            text: q.icon,
                            fontSize: 16,
                            roughness: 0,
                            ...defaultProps()
                        });
                        
                        // Title
                        elements.push({
                            type: 'text',
                            x: q.x + 20, y: q.y - 60,
                            width: 150, height: 30,
                            text: q.title,
                            fontSize: 18,
                            fontWeight: 'bold',
                            ...defaultProps()
                        });
                        
                        // Bullet points
                        const bullets = ['• Point 1', '• Point 2', '• Point 3'];
                        bullets.forEach((bullet, i) => {
                            elements.push({
                                type: 'text',
                                x: q.x, y: q.y - 20 + i * 30,
                                width: 200, height: 25,
                                text: bullet,
                                fontSize: 14,
                                ...defaultProps()
                            });
                        });
                    });
                    
                    // Center cross lines
                    elements.push({
                        type: 'line',
                        points: [{ x: 0, y: -220 }, { x: 0, y: 220 }],
                        x: 0, y: 0,
                        width: 0, height: 440,
                        strokeWidth: 3,
                        ...defaultProps()
                    });
                    
                    elements.push({
                        type: 'line',
                        points: [{ x: -300, y: 0 }, { x: 300, y: 0 }],
                        x: 0, y: 0,
                        width: 600, height: 0,
                        strokeWidth: 3,
                        ...defaultProps()
                    });
                    
                    return elements;
                }
            },
            
            timeline: {
                name: 'Timeline',
                generator: () => {
                    const elements = [];
                    const events = [
                        { year: '2021', title: 'Started', desc: 'Project kickoff' },
                        { year: '2022', title: 'Growth', desc: 'Team expansion' },
                        { year: '2023', title: 'Launch', desc: 'Product release' },
                        { year: '2024', title: 'Scale', desc: 'Global expansion' },
                        { year: '2025', title: 'Future', desc: 'New horizons' }
                    ];
                    
                    // Main timeline line
                    elements.push({
                        type: 'line',
                        points: [{ x: -300, y: 0 }, { x: 300, y: 0 }],
                        x: 0, y: 0,
                        width: 600, height: 0,
                        strokeWidth: 4,
                        ...defaultProps()
                    });
                    
                    events.forEach((event, i) => {
                        const x = -240 + i * 120;
                        const isTop = i % 2 === 0;
                        const yOffset = isTop ? -80 : 80;
                        
                        // Event node
                        elements.push({
                            type: 'ellipse',
                            x: x, y: 0,
                            width: 30, height: 30,
                            backgroundColor: '#a8a5ff',
                            strokeWidth: 3,
                            ...defaultProps()
                        });
                        
                        // Connector line
                        elements.push({
                            type: 'line',
                            points: [
                                { x: x, y: isTop ? -15 : 15 },
                                { x: x, y: yOffset + (isTop ? 35 : -35) }
                            ],
                            x: x, y: yOffset / 2,
                            width: 0, height: Math.abs(yOffset) - 20,
                            strokeWidth: 2,
                            strokeStyle: 'dashed',
                            ...defaultProps()
                        });
                        
                        // Event card
                        elements.push({
                            type: 'rectangle',
                            x: x, y: yOffset,
                            width: 100, height: 70,
                            text: `${event.year}\n${event.title}`,
                            backgroundColor: isTop ? '#e7f5ff' : '#fff9db',
                            edgeType: 'round',
                            ...defaultProps()
                        });
                        
                        // Description
                        elements.push({
                            type: 'text',
                            x: x, y: yOffset + (isTop ? -55 : 55),
                            width: 100, height: 20,
                            text: event.desc,
                            fontSize: 12,
                            ...defaultProps()
                        });
                    });
                    
                    return elements;
                }
            },
            
            gantt: {
                name: 'Gantt Chart',
                generator: () => {
                    const elements = [];
                    const tasks = [
                        { name: 'Research', start: 0, duration: 2, color: '#a5d8ff' },
                        { name: 'Design', start: 1, duration: 3, color: '#eebefa' },
                        { name: 'Develop', start: 3, duration: 4, color: '#b2f2bb' },
                        { name: 'Test', start: 6, duration: 2, color: '#ffec99' },
                        { name: 'Deploy', start: 8, duration: 1, color: '#ffc9c9' }
                    ];
                    
                    // Header row
                    elements.push({
                        type: 'rectangle',
                        x: -150, y: -150,
                        width: 120, height: 40,
                        text: 'Task',
                        backgroundColor: '#e9e9e9',
                        roughness: 0,
                        ...defaultProps()
                    });
                    
                    // Week headers
                    for (let w = 0; w < 10; w++) {
                        elements.push({
                            type: 'rectangle',
                            x: -15 + w * 55, y: -150,
                            width: 50, height: 40,
                            text: `W${w + 1}`,
                            backgroundColor: '#f5f5f5',
                            roughness: 0,
                            ...defaultProps()
                        });
                    }
                    
                    // Task rows
                    tasks.forEach((task, i) => {
                        const y = -100 + i * 55;
                        
                        // Task name
                        elements.push({
                            type: 'rectangle',
                            x: -150, y: y,
                            width: 120, height: 45,
                            text: task.name,
                            backgroundColor: '#f8f9fa',
                            roughness: 0,
                            ...defaultProps()
                        });
                        
                        // Grid cells
                        for (let w = 0; w < 10; w++) {
                            elements.push({
                                type: 'rectangle',
                                x: -15 + w * 55, y: y,
                                width: 50, height: 45,
                                backgroundColor: w % 2 === 0 ? '#ffffff' : '#fafafa',
                                roughness: 0,
                                strokeWidth: 1,
                                ...defaultProps()
                            });
                        }
                        
                        // Task bar
                        const barX = -15 + task.start * 55 + (task.duration * 55) / 2 - 27.5;
                        elements.push({
                            type: 'rectangle',
                            x: barX, y: y,
                            width: task.duration * 55 - 10, height: 35,
                            text: task.name,
                            backgroundColor: task.color,
                            edgeType: 'round',
                            roughness: 0,
                            ...defaultProps()
                        });
                    });
                    
                    return elements;
                }
            }
        };
    }
}

// Create global instance
window.templatesManager = new TemplatesManager();
