const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadUIHelpersPrototype() {
    const sourcePath = path.join(__dirname, 'ui.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/const uiHelpers = new UIHelpers\(\);[\s\S]*$/, 'globalThis.UIHelpers = UIHelpers;');
    const escapeHtml = (value) => String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const context = {
        window: { KimiBuiltGatewaySSE: {} },
        document: {
            getElementById: () => null,
            createElement: () => {
                const element = {};
                Object.defineProperty(element, 'textContent', {
                    set(value) {
                        this._text = String(value == null ? '' : value);
                    },
                });
                Object.defineProperty(element, 'innerHTML', {
                    get() {
                        return escapeHtml(this._text);
                    },
                });
                return element;
            },
        },
        localStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
        },
        marked: {
            setOptions: () => {},
            Renderer: function Renderer() {},
            use: () => {},
        },
        DOMPurify: { sanitize: (html) => html },
        console,
    };

    vm.createContext(context);
    vm.runInContext(source, context);
    return context.UIHelpers.prototype;
}

describe('web-chat markdown normalization', () => {
    test('restores flattened recipe headings and tables before rendering', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const normalized = helper.normalizeStructuredAssistantMarkdown(`Here is a potato recipe: Garlic-Herb Roasted Potatoes Why it works

Crispy outside.
Minimal prep. ---
Ingredients | Item | Quantity | |----------------|----------| | Baby potatoes | 2 lbs | | Olive oil | 3 Tbsp | > Tip: Dry potatoes first. ---
Preparation | Step | Action | |------|--------| | 1 | Pre-heat oven.
Grease the sheet. | | 2 | Roast until golden. | ---
Serving Suggestions
Meat & Pie: Fried chicken. ---
Variations | Variation | What changes | |-----------|--------------| | Spicy | Add cayenne. | --- Enjoy hot.`);

        expect(normalized).toContain('### Why it works');
        expect(normalized).toContain('### Ingredients');
        expect(normalized).toContain('| Item | Quantity |');
        expect(normalized).toContain('|----------------|----------|');
        expect(normalized).toContain('| Baby potatoes | 2 lbs |');
        expect(normalized).toContain('> Tip: Dry potatoes first.');
        expect(normalized).toContain('### Preparation');
        expect(normalized).toContain('| 1 | Pre-heat oven.<br>Grease the sheet. |');
        expect(normalized).toContain('### Serving Suggestions');
        expect(normalized).toContain('### Variations');
        expect(normalized).not.toMatch(/(^|\n)#{1,6}\s*(\n|$)/);
    });

    test('enhances presentation callout blockquotes', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const html = helper.enhancePresentationCallouts('<blockquote><p>[!WARNING] Check this<br>Review the deployment target.</p></blockquote>');

        expect(html).toContain('kb-callout kb-callout--warning');
        expect(html).toContain('kb-callout__title">Check this</div>');
        expect(html).toContain('Review the deployment target.');
    });

    test('does not infer a survey card from long news briefs with watchlists', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const content = `Here is the in-depth news brief for Sunday, May 3.

Big Story: Strait of Hormuz Is the Center of the Day

Why it matters: the Strait of Hormuz is a global oil and gas chokepoint. Any reopening, even partial, could ease pressure on energy markets. But if the operation is not coordinated with Iran, it could also become a military flashpoint.

Markets: Oil Falls, Stock Futures Rise

Markets reacted positively to the possibility that shipping through Hormuz could resume. The key question for the next 24-48 hours: does Iran tolerate, negotiate around, or challenge the U.S.-backed movement of ships?

The Readout

The strongest watchlist for tonight and Monday:

- Whether U.S.-guided ships actually move through Hormuz.
- Whether Iran publicly responds or interferes.
- Oil price movement after Asian and European markets open.
- Pentagon or White House clarification on whether this is a naval escort operation.
- Any sign neutral shipping companies accept or decline U.S. help.`;

        expect(helper.extractSurveyDefinitionFromContent(content, 'news-message')).toBeNull();
        expect(helper.buildSurveyRenderPlan(content, { id: 'news-message' })).toEqual({
            markdown: content,
            surveys: [],
        });
    });

    test('still infers a compact plain-text choice prompt', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const survey = helper.extractSurveyDefinitionFromContent(`Which direction should we take?

1. Dashboard UI
2. Cluster deployment`, 'choice-message');

        expect(survey).toEqual(expect.objectContaining({
            id: 'choice-message',
            question: 'Which direction should we take?',
            options: [
                expect.objectContaining({ label: 'Dashboard UI' }),
                expect.objectContaining({ label: 'Cluster deployment' }),
            ],
        }));
    });

    test('does not infer a survey card from final-answer completion summaries', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const content = `Yes. I pushed the Minecraft web game update onto the existing k3s deployment path and verified the public route is now serving successfully over HTTPS.

What I completed:

- Reused the existing web/minecraft-game ConfigMap-backed nginx deployment.
- Kept the current ingress and TLS path in place.
- Restarted the deployment and waited for rollout.
- Verified the live route with HTTPS and content smoke checks.

Live result:

- The public route is responding over HTTPS.
- The Minecraft page is serving the updated game.`;

        expect(helper.extractSurveyDefinitionFromContent(content, 'final-answer')).toBeNull();
        expect(helper.buildSurveyRenderPlan(content, { id: 'final-answer' })).toEqual({
            markdown: content,
            surveys: [],
        });
    });

    test('renders survey choices as keyboard-selectable list options without inline click handlers', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        helper.expandedReasoningMessageIds = new Set();
        const html = helper.renderSurveyBlock({
            id: 'checkpoint-1',
            title: 'Quick choice',
            steps: [{
                id: 'step-1',
                inputType: 'choice',
                question: 'Pick one',
                options: [
                    { id: 'a', label: 'A' },
                    { id: 'b', label: 'B' },
                ],
            }],
        }, { id: 'message-1' });

        expect(html).toContain('role="radiogroup"');
        expect(html).toContain('role="radio"');
        expect(html).toContain('tabindex="0"');
        expect(html).toContain('agent-survey-option__marker');
        expect(html).toContain('class="agent-survey-card__submit"');
        expect(html).not.toContain('toggleSurveyOption');
        expect(html).not.toContain('submitAgentSurvey');
    });

    test('renders progress as one live reasoning block with completed task styling', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const html = helper.buildAssistantRenderPlan({
            role: 'assistant',
            content: '',
            isStreaming: true,
            reasoningDisplaySource: 'generated',
            reasoningDisplayText: { text: 'Checking the next useful step.' },
            reasoningDisplayFullText: { text: 'Checking the next useful step.' },
            reasoningDisplayTitle: 'Live reasoning',
            reasoningDisplayIcon: 'sparkles',
            progressState: {
                phase: { label: 'executing' },
                detail: { message: 'Running the task list.' },
                completedSteps: 1,
                activeStepIndex: 1,
                steps: [
                    { title: { text: 'Inspect the stream payload' } },
                    { title: { text: 'Render the task list' } },
                    { title: { text: 'Verify the update path' } },
                ],
            },
        }, true).html;

        expect(html).toContain('Live reasoning (day dreaming answers)');
        expect(html).toContain('Checking the next useful step.');
        expect(html).toContain('assistant-progress-card__step--completed');
        expect(html).toContain('assistant-progress-card__step--in_progress');
        expect(html).toContain('Inspect the stream payload');
        expect(html).not.toContain('[object Object]');
        expect(html).not.toContain('assistant-reasoning-ribbon');
        expect(html).not.toContain('Snapshot');
    });

    test('renders progress step titles without visible truncation markers', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const html = helper.buildAssistantRenderPlan({
            role: 'assistant',
            content: '',
            isStreaming: true,
            reasoningDisplaySource: 'generated',
            reasoningDisplayText: { text: 'Checking the next useful step.' },
            reasoningDisplayFullText: { text: 'Checking the next useful step.' },
            reasoningDisplayTitle: 'Live reasoning',
            reasoningDisplayIcon: 'sparkles',
            progressState: {
                phase: 'executing',
                detail: 'Running the task list.',
                completedSteps: 0,
                activeStepIndex: 0,
                steps: [
                    {
                        title: 'Inspect the deployment state before editing. Then keep reading extra context that should not be shown when the compact step row needs to stay readable for the user because this generated planning note keeps going with implementation details, fallback checks, and final verification notes.',
                        status: 'in_progress',
                    },
                    {
                        title: 'Validate the output after the change [truncated 48 chars]',
                        status: 'pending',
                    },
                ],
            },
        }, true).html;

        expect(html).toContain('Inspect the deployment state before editing.');
        expect(html).toContain('Validate the output after the change');
        expect(html).not.toContain('Then keep reading extra context');
        expect(html).not.toContain('[truncated');
        expect(html).not.toContain('...');
    });

    test('renders live reasoning as a header without a duplicate dropdown body', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const html = helper.buildAssistantRenderPlan({
            role: 'assistant',
            content: '',
            isStreaming: true,
            reasoningDisplaySource: 'generated',
            reasoningDisplayText: { text: 'Checking the next useful step.' },
            reasoningDisplayFullText: { text: 'Checking the next useful step.' },
            reasoningDisplayTitle: 'Live reasoning',
            reasoningDisplayIcon: 'sparkles',
        }, true).html;

        expect(html).toContain('assistant-reasoning-ribbon__surface');
        expect(html).toContain('Live reasoning (day dreaming answers)');
        expect(html).toContain('Checking the next useful step.');
        expect(html).not.toContain('<details');
        expect(html).not.toContain('<summary');
        expect(html).not.toContain('assistant-reasoning-ribbon__body');
        expect(html).not.toContain('chevron-down');
    });
});
