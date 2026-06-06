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
                const element = {
                    dataset: {},
                    attributes: {},
                    classList: {
                        add: () => {},
                        toggle: () => {},
                    },
                    setAttribute(name, value) {
                        this.attributes[name] = String(value);
                    },
                    getAttribute(name) {
                        return this.attributes[name];
                    },
                };
                Object.defineProperty(element, 'textContent', {
                    set(value) {
                        this._text = String(value == null ? '' : value);
                    },
                });
                Object.defineProperty(element, 'innerHTML', {
                    get() {
                        return this._html || escapeHtml(this._text);
                    },
                    set(value) {
                        this._html = String(value == null ? '' : value);
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
            parse: (value) => `<p>${escapeHtml(value)}</p>`,
        },
        DOMPurify: { sanitize: (html) => html },
        console,
    };

    vm.createContext(context);
    vm.runInContext(source, context);
    return context.UIHelpers.prototype;
}

describe('web-chat markdown normalization', () => {
    test('finds speech highlight content indexes across comparable boundaries', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const node = {};
        const textMap = {
            text: ' first chunk ',
            positions: [
                null,
                { node, offset: 0 },
                { node, offset: 1 },
                { node, offset: 2 },
                { node, offset: 3 },
                { node, offset: 4 },
                null,
                { node, offset: 6 },
                { node, offset: 7 },
                { node, offset: 8 },
                { node, offset: 9 },
                { node, offset: 10 },
                null,
            ],
        };

        expect(helper.findComparableSpeechContentIndex(textMap, 0, 12, 1)).toBe(1);
        expect(helper.findComparableSpeechContentIndex(textMap, 12, 0, -1)).toBe(11);
    });

    test('does not backtrack into a previously spoken repeated sentence', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const node = {};
        const text = 'alpha beta alpha beta';
        helper.buildSpeechHighlightTextMap = () => ({
            text,
            positions: text.split('').map((char, index) => (
                char === ' ' ? null : { node, offset: index }
            )),
        });
        helper.createSpeechRangeFromComparableIndexes = (_textMap, startIndex, endIndex) => ({
            startIndex,
            endIndex,
        });

        const match = helper.findSpeechHighlightRange({}, 'Alpha beta.', {
            startIndex: 'alpha beta '.length,
            chunkIndex: 1,
        });

        expect(match.range).toEqual({
            startIndex: 'alpha beta '.length,
            endIndex: text.length - 1,
        });
    });

    test('renders assistant alignment feedback buttons with thumbs icons', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const html = helper.buildAlignmentFeedbackButtonsMarkup('assistant-1', {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Done.',
            metadata: {},
        });

        expect(html).toContain('data-alignment-rating="up"');
        expect(html).toContain('data-alignment-rating="down"');
        expect(html).toContain('data-lucide="thumbs-up"');
        expect(html).toContain('data-lucide="thumbs-down"');
    });

    test('does not render alignment feedback buttons for user messages', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const html = helper.buildAlignmentFeedbackButtonsMarkup('user-1', {
            id: 'user-1',
            role: 'user',
            content: 'Please build this.',
            metadata: {},
        });

        expect(html).toBe('');
    });

    test('renders verified research sources inside a closed dropdown', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        helper.generateMessageId = () => 'research-message';
        helper.formatTime = () => '12:00';
        const element = helper.renderResearchSourcesMessage({
            id: 'research-message',
            timestamp: '2026-05-16T12:00:00.000Z',
            query: 'AI deployment tools',
            results: [{
                title: 'Deployment guide',
                url: 'https://example.com/deploy',
                source: 'Example',
                excerpt: 'A short verified excerpt.',
                toolId: 'web-fetch',
            }],
        });

        expect(element.innerHTML).toContain('<details class="research-dropdown">');
        expect(element.innerHTML).not.toContain('<details class="research-dropdown" open');
        expect(element.innerHTML).toContain('Research for: AI deployment tools');
        expect(element.innerHTML).toContain('Click to expand verified source cards');
        expect(element.innerHTML).toContain('Click this header again to shrink it back');
        expect(element.innerHTML).toContain('Deployment guide');
    });

    test('renders candidate research pages inside a closed dropdown', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        helper.generateMessageId = () => 'search-message';
        helper.formatTime = () => '12:00';
        const element = helper.renderSearchResultsMessage({
            id: 'search-message',
            timestamp: '2026-05-16T12:00:00.000Z',
            query: 'AI model news',
            results: [{
                title: 'Model news',
                url: 'https://example.com/model-news',
                snippet: 'A useful candidate result.',
            }],
        });

        expect(element.innerHTML).toContain('<details class="research-dropdown">');
        expect(element.innerHTML).not.toContain('<details class="research-dropdown" open');
        expect(element.innerHTML).toContain('Research for: AI model news');
        expect(element.innerHTML).toContain('Click to expand candidate pages');
        expect(element.innerHTML).toContain('Model news');
    });

    test('renders plain text fences without the code preview chrome', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const html = helper.renderPlainTextFence('A plain assistant answer');

        expect(html).toContain('plain-text-fence');
        expect(html).toContain('A plain assistant answer');
        expect(html).not.toContain('code-header');
        expect(html).not.toContain('code-language');
        expect(html).not.toContain('text-code-block');
    });

    test('infers a build brief for previewable frontend requests', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const brief = helper.inferBuildRunBrief('Build a playable browser game with a sandbox preview.');

        expect(brief).toEqual(expect.objectContaining({
            lane: 'Sandbox/front-end build',
            output: 'Previewable sandbox',
        }));
        expect(brief.checks).toContain('Preview opens');
        expect(brief.checks).toContain('Artifact links persist');
    });

    test('renders user build briefs without changing the user message text', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const html = helper.renderUserMessage('Build a dashboard', {
            metadata: {
                buildRunBrief: {
                    summary: 'Build a dashboard',
                    lane: 'Sandbox/front-end build',
                    output: 'Previewable sandbox',
                    checks: ['Preview opens', 'No layout overflow'],
                },
            },
        });

        expect(html).toContain('Build a dashboard');
        expect(html).toContain('user-build-brief');
        expect(html).toContain('Sandbox/front-end build');
        expect(html).toContain('Preview opens');
    });

    test('renders selected tool chips beside clean user text', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const html = helper.renderUserMessage('Deploy the latest frontend fix', {
            metadata: {
                selectedToolChip: {
                    id: 'remote-cli-agent',
                    name: 'Remote CLI Agent',
                    icon: 'server',
                },
            },
        });

        expect(html).toContain('message-tool-chip--selected');
        expect(html).toContain('Remote CLI Agent');
        expect(html).toContain('Deploy the latest frontend fix');
        expect(html).not.toContain('/tool remote-cli-agent');
        expect(html).not.toContain('{&quot;task&quot;');
    });

    test('renders direct tool result chips without forcing raw JSON blocks', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const html = helper.buildAssistantRenderPlan({
            role: 'assistant',
            content: 'Remote job completed successfully.',
            metadata: {
                toolResultChip: {
                    id: 'remote-cli-agent',
                    name: 'Remote CLI Agent',
                    icon: 'server',
                    status: 'completed',
                },
            },
        }, false).html;

        expect(html).toContain('message-tool-chip--result');
        expect(html).toContain('Remote CLI Agent');
        expect(html).toContain('completed');
        expect(html).toContain('Remote job completed successfully.');
        expect(html).not.toContain('```json');
    });

    test('renders voted alignment feedback as disabled state', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const html = helper.buildAlignmentFeedbackButtonsMarkup('assistant-1', {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Done.',
            metadata: {
                alignmentFeedback: {
                    rating: 'down',
                    status: 'completed',
                },
            },
        });

        expect(html).toContain('is-negative');
        expect(html).toContain('disabled');
        expect(html).toContain('Alignment review saved');
    });

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

    test('keeps inferred survey ids stable when the submit path reparses the message', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const content = `Which direction should we take?

1. Dashboard UI
2. Cluster deployment`;
        const message = { id: 'choice-message-1' };
        const renderPlan = helper.buildSurveyRenderPlan(content, message);
        const reparsedSurvey = helper.extractSurveyDefinitionFromContent(content, message.id);

        expect(renderPlan.surveys[0].html).toContain('data-survey-id="choice-message-1"');
        expect(reparsedSurvey).toEqual(expect.objectContaining({
            id: 'choice-message-1',
            question: 'Which direction should we take?',
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

    test('does not infer a survey card from remote-cli status/proof rows', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const content = `Current remote-cli-agent state:

1. Namespace
web namespace exists.
2. Deployment
web/tetris-site is present and currently 1/1.
3. Ingress
awesome.demoserver2.buzz points to tetris-site on ports 80, 443.
4. Source file
/opt/agent-apps/tetris-game/site/index.html
5. Git status already has site/index.html modified from earlier work, plus multiple backup HTML files
Next recovery path is straightforward: patch site/index.html, refresh the ConfigMap, restart deployment/tetris-site, and verify the public page visually.`;

        expect(helper.extractSurveyDefinitionFromContent(content, 'remote-cli-status')).toBeNull();
        expect(helper.buildSurveyRenderPlan(content, { id: 'remote-cli-status' })).toEqual({
            markdown: content,
            surveys: [],
        });
    });

    test('does not infer a survey card from answer headings followed by bullets', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const content = `Which pieces changed:

- Backend display-content normalization now avoids wrapping answer payloads as surveys.
- Frontend plain-text survey inference only reacts to real choice prompts.
- Regression tests cover the cleanup path.

Options I ruled out:

- Rendering every short bullet list as a checkpoint.
- Asking the user to choose when the answer is only a status summary.`;

        expect(helper.extractSurveyDefinitionFromContent(content, 'answer-bullets')).toBeNull();
        expect(helper.buildSurveyRenderPlan(content, { id: 'answer-bullets' })).toEqual({
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

    test('keeps one-option checkpoints selectable when free-text Other is available', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        helper.expandedReasoningMessageIds = new Set();
        const survey = helper.normalizeSurveyDefinition({
            id: 'checkpoint-beach-direction',
            title: 'Choose a direction',
            steps: [{
                id: 'step-1',
                inputType: 'choice',
                question: 'Choose a direction',
                options: [
                    { id: 'pamphlet', label: 'Beach vacation pamphlet' },
                ],
                allowFreeText: true,
            }],
        }, 'message-1');
        const html = helper.renderSurveyBlock(survey, { id: 'message-1' });

        expect(survey.steps[0].inputType).toBe('choice');
        expect(html).toContain('data-option-id="pamphlet"');
        expect(html).toContain('data-option-id="custom-input"');
        expect(html).toContain('agent-survey-card__notes');
        expect(html).not.toContain('agent-survey-card__input--text');
    });

    test('renders multi-choice survey fields as checkbox options', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        helper.expandedReasoningMessageIds = new Set();
        const survey = helper.normalizeSurveyDefinition({
            id: 'checkpoint-deliverables',
            title: 'Pick useful outputs',
            fields: [{
                id: 'deliverables',
                label: 'Which outputs should the agent produce?',
                fieldType: 'multi-select',
                maxSelections: 3,
                options: [
                    { value: 'summary', label: 'Short summary' },
                    { value: 'patch', label: 'Code patch' },
                    { value: 'tests', label: 'Regression tests' },
                    { value: 'screenshots', label: 'Screenshots' },
                ],
            }],
        }, 'message-1');
        const html = helper.renderSurveyBlock(survey, { id: 'message-1' });

        expect(survey.steps[0]).toEqual(expect.objectContaining({
            inputType: 'multi-choice',
            allowMultiple: true,
            maxSelections: 3,
        }));
        expect(html).toContain('role="group"');
        expect(html).toContain('role="checkbox"');
        expect(html).toContain('data-step-allow-multiple="true"');
        expect(html).toContain('data-step-max-selections="3"');
        expect(html).toContain('Choose up to 3');
        expect(html).toContain('data-option-id="summary"');
        expect(html).toContain('data-option-id="screenshots"');
    });

    test('renders ordinary progress as one clean live status line', () => {
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

        expect(html).toContain('Live progress');
        expect(html).toContain('Running the task list.');
        expect(html).not.toContain('assistant-progress-card__steps');
        expect(html).not.toContain('assistant-progress-card__step--completed');
        expect(html).not.toContain('Inspect the stream payload');
        expect(html).not.toContain('[object Object]');
        expect(html).not.toContain('assistant-reasoning-ribbon');
        expect(html).not.toContain('Snapshot');
    });

    test('softens canonical planning operation labels in the live reasoning list', () => {
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
                phase: 'planning',
                detail: 'Building the requested feature.',
                source: 'tool-plan',
                estimated: false,
                completedSteps: 1,
                activeStepIndex: 1,
                steps: [
                    { title: 'Gather context and constraints', status: 'completed' },
                    { title: 'Propose the working plan', status: 'in_progress' },
                    { title: 'Confirm decisions and blockers', status: 'pending' },
                ],
            },
        }, true).html;

        expect(html).toContain('Getting oriented around your request');
        expect(html).toContain('Shaping the next plan');
        expect(html).toContain('Checking decisions and blockers');
        expect(html).not.toContain('Gather context and constraints');
        expect(html).not.toContain('Propose the working plan');
        expect(html).not.toContain('Confirm decisions and blockers');
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
                detail: 'Building the deployment update.',
                source: 'tool-plan',
                estimated: false,
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

    test('renders remote CLI progress heartbeat details from SSE progress metadata', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const message = {
            role: 'assistant',
            content: '',
            isStreaming: true,
            progressState: {
                phase: 'executing',
                reasoningSummary: 'Remote CLI agent is still working (390s elapsed).',
                toolEvents: [
                    {
                        toolId: 'remote-cli-agent',
                        stage: 'in_progress',
                        detail: 'Remote CLI agent is still working (390s elapsed).',
                    },
                ],
            },
        };

        const state = helper.getAssistantProgressState(message);
        const html = helper.buildAssistantRenderPlan(message, true).html;

        expect(state).toEqual(expect.objectContaining({
            detail: 'Remote CLI agent is still working (390s elapsed).',
            summary: 'Remote CLI agent is still working (390s elapsed).',
            line: 'Remote CLI agent is still working (390s elapsed).',
            showSteps: false,
        }));
        expect(html).toContain('Remote CLI agent is still working (390s elapsed).');
        expect(html).not.toContain('Connecting to the remote runner');
        expect(html).not.toContain('Bringing back verification');
        expect(html).not.toContain('assistant-progress-card__steps');
        expect(html).not.toContain('Working through the next step.');
    });

    test('cleans raw output labels from progress card status text', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const html = helper.buildAssistantRenderPlan({
            role: 'assistant',
            content: '',
            isStreaming: true,
            progressState: {
                phase: 'checking-tools',
                detail: 'output: The public page is live and served as a single `index.html`; checking the fullscreen CSS.',
                toolEvents: [{
                    toolId: 'remote-cli-agent',
                    stage: 'in_progress',
                    detail: 'output: The public page is live and served as a single `index.html`; checking the fullscreen CSS.',
                }],
            },
        }, true).html;

        expect(html).toContain('The public page is live and served as a single index.html; checking the fullscreen CSS.');
        expect(html).not.toContain('output:');
        expect(html).not.toContain('`index.html`');
        expect(html).not.toContain('assistant-progress-card__steps');
    });

    test('renders managed deployment progress as one card without raw remote SSE telemetry', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const message = {
            role: 'assistant',
            content: '',
            isStreaming: true,
            reasoningDisplaySource: 'stream',
            reasoningDisplayText: '{"toolCalls":1,"successfulToolCalls":1,"failedToolCalls":0,"uniqueStepSignatures":1}',
            reasoningDisplayFullText: '{"toolCalls":1,"successfulToolCalls":1,"failedToolCalls":0,"uniqueStepSignatures":1}',
            reasoningDisplayTitle: 'Reasoning',
            reasoningDisplayIcon: 'brain',
            managedAppProgressState: {
                phase: 'deploying',
                summary: 'Remote deployment is running.',
                detail: 'Build is queued and waiting on the deployment runner.',
                steps: [
                    { id: 'prepare', title: 'Prepare app record', status: 'completed' },
                    { id: 'build', title: 'Build and publish image', status: 'in_progress' },
                    { id: 'deploy', title: 'Roll out deployment', status: 'pending' },
                    { id: 'verify', title: 'Verify public endpoint', status: 'pending' },
                ],
            },
            progressState: {
                phase: 'checking-tools',
                detail: '{"toolCalls":1,"successfulToolCalls":1,"failedToolCalls":0,"uniqueStepSignatures":1}',
                toolEvents: [{
                    toolId: 'remote-cli-agent',
                    stage: 'in_progress',
                    detail: '{"toolCalls":1,"successfulToolCalls":1,"failedToolCalls":0,"uniqueStepSignatures":1}',
                }],
            },
        };

        const html = helper.buildAssistantRenderPlan(message, true).html;
        const cardCount = (html.match(/assistant-progress-card /g) || []).length;

        expect(cardCount).toBe(1);
        expect(html).toContain('assistant-progress-card--managed-app');
        expect(html).toContain('Remote deployment is running.');
        expect(html).toContain('Remote runner is checking tool results.');
        expect(html).not.toContain('assistant-progress-card--reasoning');
        expect(html).not.toContain('assistant-reasoning-ribbon');
        expect(html).not.toContain('successfulToolCalls');
        expect(html).not.toContain('uniqueStepSignatures');
    });

    test('hides oversized git deployment status dumps beside managed progress', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const statusDump = [
            'git status',
            'On branch main',
            'Changes not staged for commit:',
            '  modified: frontend/web-chat/js/app.js',
            'remote-cli-agent deployment status:',
            'namespace: app-demo',
            'deployment: app-demo',
            'ingress: app-demo.demoserver2.buzz',
            'verify_results=waiting for public url',
            'current state: build webhook queued',
        ].join('\n');
        const message = {
            role: 'assistant',
            content: statusDump,
            isStreaming: false,
            managedAppProgressState: {
                phase: 'updated',
                summary: 'Remote build is queued.',
                detail: 'Deployment will continue after the build webhook succeeds.',
                steps: [
                    { id: 'prepare', title: 'Prepare app record', status: 'completed' },
                    { id: 'build', title: 'Build and publish image', status: 'in_progress' },
                    { id: 'deploy', title: 'Roll out deployment', status: 'pending' },
                    { id: 'verify', title: 'Verify public endpoint', status: 'pending' },
                ],
            },
        };

        const html = helper.buildAssistantRenderPlan(message, false).html;

        expect(html).toContain('Remote build is queued.');
        expect(html).toContain('Deployment will continue after the build webhook succeeds.');
        expect(html).not.toContain('git status');
        expect(html).not.toContain('Changes not staged');
        expect(html).not.toContain('verify_results=');
    });

    test('renders progress rows for completed sections beyond the initially supplied step records', () => {
        const helper = Object.create(loadUIHelpersPrototype());
        const message = {
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
                detail: 'Building the next document sections.',
                source: 'workflow',
                estimated: false,
                totalSteps: 5,
                completedSteps: 4,
                steps: [
                    { title: 'Draft opening section', status: 'completed' },
                    { title: 'Draft evidence section', status: 'completed' },
                ],
            },
        };
        const state = helper.getAssistantProgressState(message);
        const html = helper.buildAssistantRenderPlan(message, true).html;

        const rowCount = (html.match(/assistant-progress-card__step /g) || []).length;
        const completedCount = (html.match(/assistant-progress-card__step--completed/g) || []).length;

        expect(state).toEqual(expect.objectContaining({
            completedSteps: 4,
            totalSteps: 5,
            summary: '4/5 steps complete',
        }));
        expect(rowCount).toBe(5);
        expect(completedCount).toBe(4);
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
        expect(html).toContain('Live progress');
        expect(html).toContain('Checking the next useful step.');
        expect(html).not.toContain('<details');
        expect(html).not.toContain('<summary');
        expect(html).not.toContain('assistant-reasoning-ribbon__body');
        expect(html).not.toContain('chevron-down');
    });
});
