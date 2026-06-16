/**
 * AI Agent Module - Intelligent assistant for the notes-notion app
 * Provides contextual AI capabilities, chat interface, and page manipulation
 */

const Agent = (function() {
    const SHARED_MODEL_STORAGE_KEY = 'kimibuilt_default_model';
    const LEGACY_MODEL_STORAGE_KEY = 'notes_agent_model';
    const LEGACY_MESSAGES_STORAGE_KEY = 'notes_agent_messages';
    const PAGE_MESSAGES_STORAGE_PREFIX = 'notes_agent_messages:';
    const AGENT_PROFILE_STORAGE_KEY = 'notes_agent_profile';
    const NOTES_COLOR_OPTIONS = ['gray', 'brown', 'orange', 'yellow', 'amber', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink', 'rose', 'red'];
    const NOTES_FONT_FAMILY_OPTIONS = ['sans', 'serif', 'mono'];
    const NOTES_FONT_SIZE_OPTIONS = ['small', 'normal', 'large', 'xlarge'];
    const NOTES_FONT_WEIGHT_OPTIONS = ['regular', 'medium', 'semibold', 'bold'];
    const NOTES_TEXT_ALIGN_OPTIONS = ['left', 'center', 'right'];
    const NOTES_HIGHLIGHT_COLOR_OPTIONS = ['yellow', 'amber', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink', 'rose', 'red', 'orange', 'brown', 'gray'];
    const NOTES_TEMPLATE_METADATA_BLOCKLIST = new Set(['type', 'mode', 'audience']);
    const NOTES_AGENT_PROFILES = Object.freeze([
        Object.freeze({
            id: 'builder-buddy',
            name: 'Builder Buddy',
            shortName: 'Builder',
            initials: 'BB',
            tagline: 'Turns rough intent into working page blocks.',
            bestFor: 'New pages, rebuilds, structured drafts, specs, plans, and creative build-outs.',
            style: 'Friendly, decisive, practical, and a little lively. Think alongside the user, then build the page instead of over-explaining.',
            toolUse: 'Prefer notes-actions for page work. Use web-search, web-fetch, or web-scrape only when the page needs current or source-backed information. Use richer blocks such as database, mermaid, callout, code, ai_image, and toggle when they improve the result.',
            actionBias: 'Default to making the current notes page more useful. Choose a template, create a strong first screenful, and ship a complete block structure.',
        }),
        Object.freeze({
            id: 'research-buddy',
            name: 'Research Buddy',
            shortName: 'Research',
            initials: 'RB',
            tagline: 'Finds sources, then turns them into clean notes.',
            bestFor: 'Source-backed explainers, news/current topics, comparisons, learning pages, and evidence tables.',
            style: 'Curious, careful, grounded, and concise. Make uncertainty visible and avoid pretending unverified facts are current.',
            toolUse: 'Use web-search for discovery, web-fetch for selected pages, and web-scrape only for structured extraction or JS-rendered pages. Convert findings into bookmarks, databases, callouts, and source notes on the page.',
            actionBias: 'Gather enough evidence to be useful, then write the page with citations or source blocks. Keep synthesis separate from raw facts.',
        }),
        Object.freeze({
            id: 'polish-partner',
            name: 'Polish Partner',
            shortName: 'Polish',
            initials: 'PP',
            tagline: 'Tightens voice, structure, and readability.',
            bestFor: 'Editing existing pages, grammar, tone, concise rewrites, hierarchy, and layout cleanup.',
            style: 'Warm, editorial, respectful of the user voice, and precise. Improve the writing without sanding off personality.',
            toolUse: 'Use replace_text, highlight_text, update_block, change_block_type, and section-level operations before rebuilding. Avoid research unless the user asks for factual expansion.',
            actionBias: 'Preserve strong existing blocks. Make targeted edits first, then improve section rhythm, headings, callouts, and visual hierarchy.',
        }),
        Object.freeze({
            id: 'systems-builder',
            name: 'Systems Builder',
            shortName: 'Systems',
            initials: 'SB',
            tagline: 'Maps workflows, decisions, and technical plans.',
            bestFor: 'Technical notes, architecture, process maps, data models, SOPs, diagrams, and implementation plans.',
            style: 'Calm, structured, builder-minded, and specific. Prefer clear contracts and next actions over vague strategy.',
            toolUse: 'Use mermaid, code, database, chart, math, and todo blocks when they clarify systems work. Use web tools for current API or standards details before encoding them into the page.',
            actionBias: 'Turn ambiguity into a usable structure: components, flows, risks, decisions, owners, and verification steps.',
        }),
        Object.freeze({
            id: 'pitch-buddy',
            name: 'Pitch Buddy',
            shortName: 'Pitch',
            initials: 'PB',
            tagline: 'Shapes offers, stories, and persuasive briefs.',
            bestFor: 'Sales pages, proposals, value stories, client notes, product positioning, and executive summaries.',
            style: 'Confident, human, useful, and not hypey. Lead with outcomes, proof, and the next move.',
            toolUse: 'Use callouts for the offer, databases for proof or pricing comparisons, quotes for customer language, and todo blocks for next steps. Use web tools only when outside proof needs verification.',
            actionBias: 'Make the value easy to scan. Structure problem, offer, proof, fit, objections, and next steps.',
        }),
    ]);
    const NOTES_PAGE_TEMPLATES = Object.freeze([
        Object.freeze({
            id: 'brief',
            name: 'Executive Brief',
            useWhen: 'Short, high-signal pages that need a fast read with a clear takeaway.',
            matchers: [/\bbrief\b/, /\bsummary\b/, /\boverview\b/, /\bdecision\b/, /\bkey takeaways?\b/, /\bnext steps?\b/],
            structure: [
                'heading_1 for the topic or decision',
                'callout with the bottom line or headline takeaway',
                'heading_2 for context or background',
                'bulleted_list for the main points',
                'heading_2 for risks, watchouts, or tradeoffs',
                'todo or numbered_list for next steps',
            ],
            designRules: [
                'Lead with the answer, not with history.',
                'Use one callout and one list before adding dense prose.',
                'Keep sections compact and scannable.',
            ],
        }),
        Object.freeze({
            id: 'explainer',
            name: 'Editorial Explainer',
            useWhen: 'Educational topic pages, science notes, animal or place explainers, and polished knowledge pages that should feel visual and approachable.',
            matchers: [/\bexplainer\b/, /\bwhat is\b/, /\bhow does\b/, /\bwhy does\b/, /\bfacts?\b/, /\bscience\b/, /\bspecies\b/, /\banimal\b/, /\blearn\b/, /\babout\b/],
            structure: [
                'heading_1 for the topic or big question',
                'callout with the big idea or headline takeaway',
                'image or ai_image hero near the top',
                'database or list for quick facts or at-a-glance details',
                'heading_2 sections for how it works, why it matters, habitat/history/process, or notable traits',
                'toggle or callout for warnings, safety notes, or deeper detail',
                'heading_2 for sources, references, or next questions',
            ],
            designRules: [
                'Make the opening feel editorial, not like pasted homework notes.',
                'Use a hero visual and a strong big-idea callout in the first screenful.',
                'Break factual content into quick-scan clusters such as quick facts, warnings, sources, and themed sections.',
            ],
        }),
        Object.freeze({
            id: 'research',
            name: 'Research Page',
            useWhen: 'Topic pages, research notes, explainers, and source-backed investigations.',
            matchers: [/\bresearch\b/, /\bfindings?\b/, /\btopic\b/, /\bcompare\b/, /\bevidence\b/, /\bsources?\b/, /\blearn about\b/],
            structure: [
                'heading_1 for the topic',
                'callout describing what the page covers',
                'heading_2 for overview',
                'heading_2 for findings or themes',
                'bulleted_list or numbered_list for evidence, examples, or facts',
                'heading_2 for sources or open questions',
            ],
            designRules: [
                'Organize by themes, not by one uninterrupted essay.',
                'Use lists for findings and bookmarks for key links when relevant.',
                'Reserve prose blocks for synthesis between evidence sections.',
            ],
        }),
        Object.freeze({
            id: 'project',
            name: 'Project Plan',
            useWhen: 'Project pages, rollouts, roadmaps, launches, and execution planning.',
            matchers: [/\bproject\b/, /\bplan\b/, /\broadmap\b/, /\btimeline\b/, /\bmilestones?\b/, /\bowners?\b/, /\blaunch\b/],
            structure: [
                'heading_1 for the project name',
                'callout with project snapshot, goal, or status',
                'database or list for milestones, owners, or status tracking',
                'heading_2 for goals and scope',
                'heading_2 for timeline or phases',
                'heading_2 for risks and dependencies',
                'todo list for immediate actions',
            ],
            designRules: [
                'Make ownership and next actions visible.',
                'Use structured blocks instead of hiding status in paragraphs.',
                'Treat the page like a working surface, not a static memo.',
            ],
        }),
        Object.freeze({
            id: 'sales',
            name: 'Sales Pitch',
            useWhen: 'Sales narratives, proposals, product pitches, client decks, and value-story pages.',
            matchers: [/\bsales?\b/, /\bpitch\b/, /\bproposal\b/, /\bclient\b/, /\bcustomer\b/, /\broi\b/, /\bvalue prop\b/, /\bobjections?\b/, /\bdemo\b/],
            structure: [
                'heading_1 for the offer, product story, or pitch title',
                'callout with the value proposition or headline win',
                'heading_2 for the problem or opportunity',
                'heading_2 for the solution or offer',
                'quote, bookmark, database, or bulleted_list for proof, metrics, or testimonials',
                'heading_2 for objections, pricing, or fit notes',
                'todo or numbered_list for CTA, next steps, or the ask',
            ],
            designRules: [
                'Lead with the outcome, not with the company bio.',
                'Use proof blocks so claims feel grounded instead of generic.',
                'End with a concrete ask, next move, or offer structure.',
            ],
        }),
        Object.freeze({
            id: 'meeting',
            name: 'Meeting Notes',
            useWhen: 'Meetings, workshops, interviews, retros, and collaborative sessions.',
            matchers: [/\bmeeting\b/, /\bagenda\b/, /\battendees?\b/, /\bdecisions?\b/, /\bretro\b/, /\binterview\b/],
            structure: [
                'heading_1 for the meeting title',
                'text block for date, owner, or context',
                'heading_2 for attendees',
                'heading_2 for agenda',
                'heading_2 for notes or discussion',
                'heading_2 for decisions',
                'todo list for action items',
            ],
            designRules: [
                'Separate decisions from raw discussion notes.',
                'Keep action items explicit and checkable.',
                'Use dividers sparingly to separate pre-meeting and post-meeting sections.',
            ],
        }),
        Object.freeze({
            id: 'documentation',
            name: 'Documentation',
            useWhen: 'Guides, SOPs, onboarding docs, references, and product documentation.',
            matchers: [/\bdocumentation\b/, /\bdoc\b/, /\bguide\b/, /\bhow to\b/, /\bonboarding\b/, /\bsetup\b/, /\breference\b/],
            structure: [
                'heading_1 for the doc title',
                'callout with audience, scope, or prerequisite note',
                'heading_2 for overview',
                'heading_2 for getting started or setup',
                'numbered_list for steps or process',
                'code blocks, quotes, or callouts for examples and warnings',
                'heading_2 for troubleshooting or FAQ',
            ],
            designRules: [
                'Optimize for scanning and task completion.',
                'Use numbered steps for sequences and code blocks for examples.',
                'Pull warnings or constraints into callouts instead of burying them.',
            ],
        }),
        Object.freeze({
            id: 'dashboard',
            name: 'Status Dashboard',
            useWhen: 'Status overviews, operating dashboards, trackers, and live working summaries.',
            matchers: [/\bdashboard\b/, /\bstatus\b/, /\btracker\b/, /\bmetrics?\b/, /\bkpis?\b/, /\bscorecard\b/, /\bhealth\b/],
            structure: [
                'heading_1 for the dashboard title',
                'callout with overall status or summary',
                'database for metrics, owners, risks, or workstreams',
                'heading_2 for highlights',
                'heading_2 for blockers or risks',
                'heading_2 for next moves or decisions',
            ],
            designRules: [
                'Use structured blocks first and summary prose second.',
                'Give the page obvious status surfaces near the top.',
                'Keep sections compact so the page feels operational.',
            ],
        }),
        Object.freeze({
            id: 'journal',
            name: 'Journal / Reflection',
            useWhen: 'Daily notes, reflections, check-ins, and personal working pages.',
            matchers: [/\bjournal\b/, /\bdaily\b/, /\breflection\b/, /\bcheck-in\b/, /\blog\b/, /\bdiary\b/],
            structure: [
                'heading_1 for the date or entry title',
                'callout for the mood, theme, or daily focus',
                'heading_2 for highlights',
                'heading_2 for reflections',
                'heading_2 for priorities or goals',
                'todo list for follow-up actions',
            ],
            designRules: [
                'Make the page feel lightweight and easy to revisit.',
                'Use short paragraphs and headings for emotional or thematic separation.',
                'Keep the page personal but still structured.',
            ],
        }),
    ]);
    const NOTES_TEMPLATE_DESIGN_PRESETS = Object.freeze({
        brief: Object.freeze({
            pageIcon: '📌',
            calloutIcon: '⚡',
            calloutColor: 'yellow',
            sectionTextColor: 'blue',
            supportingTextColor: 'gray',
            sourceHeading: 'Supporting Notes',
            heroPromptSuffix: 'editorial desk scene',
            heroCaptionPrefix: 'Brief visual',
        }),
        explainer: Object.freeze({
            pageIcon: '💡',
            calloutIcon: '✨',
            calloutColor: 'orange',
            sectionTextColor: 'blue',
            supportingTextColor: 'gray',
            sourceHeading: 'Sources and Further Reading',
            heroPromptSuffix: 'editorial educational reference photo',
            heroCaptionPrefix: 'Lead visual',
        }),
        research: Object.freeze({
            pageIcon: '🔎',
            calloutIcon: '🧭',
            calloutColor: 'blue',
            sectionTextColor: 'blue',
            supportingTextColor: 'gray',
            sourceHeading: 'Verified Sources',
            heroPromptSuffix: 'editorial wildlife or reference photo',
            heroCaptionPrefix: 'Reference visual',
        }),
        project: Object.freeze({
            pageIcon: '🚀',
            calloutIcon: '📍',
            calloutColor: 'green',
            sectionTextColor: 'green',
            supportingTextColor: 'gray',
            sourceHeading: 'Working References',
            heroPromptSuffix: 'team workspace or planning board',
            heroCaptionPrefix: 'Project visual',
        }),
        sales: Object.freeze({
            pageIcon: 'ðŸŽ¯',
            calloutIcon: 'ðŸ’¼',
            calloutColor: 'orange',
            sectionTextColor: 'orange',
            supportingTextColor: 'gray',
            sourceHeading: 'Proof and References',
            heroPromptSuffix: 'confident product presentation or customer success scene',
            heroCaptionPrefix: 'Pitch visual',
        }),
        meeting: Object.freeze({
            pageIcon: '🗒️',
            calloutIcon: '👥',
            calloutColor: 'gray',
            sectionTextColor: 'brown',
            supportingTextColor: 'gray',
            sourceHeading: 'Follow-up Links',
            heroPromptSuffix: 'meeting desk or collaboration scene',
            heroCaptionPrefix: 'Meeting visual',
        }),
        documentation: Object.freeze({
            pageIcon: '🧩',
            calloutIcon: 'ℹ️',
            calloutColor: 'blue',
            sectionTextColor: 'blue',
            supportingTextColor: 'gray',
            sourceHeading: 'References',
            heroPromptSuffix: 'clean interface or system diagram reference',
            heroCaptionPrefix: 'Reference visual',
        }),
        dashboard: Object.freeze({
            pageIcon: '📊',
            calloutIcon: '📈',
            calloutColor: 'green',
            sectionTextColor: 'green',
            supportingTextColor: 'gray',
            sourceHeading: 'Reference Links',
            heroPromptSuffix: 'operations dashboard or team workspace',
            heroCaptionPrefix: 'Dashboard visual',
        }),
        journal: Object.freeze({
            pageIcon: '📔',
            calloutIcon: '🌤️',
            calloutColor: 'purple',
            sectionTextColor: 'purple',
            supportingTextColor: 'gray',
            sourceHeading: 'Context',
            heroPromptSuffix: 'calm editorial photo',
            heroCaptionPrefix: 'Mood visual',
        }),
    });
    const NOTES_VISUAL_PAGE_RECIPES = Object.freeze([
        Object.freeze({
            id: 'editorial-explainer',
            name: 'Editorial Explainer',
            appliesTo: ['explainer', 'research', 'brief'],
            useWhen: 'Topic pages, animal pages, science notes, place explainers, and polished educational content.',
            topCluster: 'Use the first screenful for page icon/title, compact properties, a big-idea callout, and a hero image or ai_image.',
            bodyRhythm: 'Alternate short text with quick facts, lists, quotes, warnings, or databases. Avoid more than two plain text blocks in a row.',
            supportCluster: 'Close with bookmark sources, a toggle appendix, or a compact research note cluster.',
            styling: 'Use colored section labels, muted gray support notes, and captions that feel editorial rather than mechanical.',
        }),
        Object.freeze({
            id: 'knowledge-hub',
            name: 'Knowledge Hub',
            appliesTo: ['research', 'documentation'],
            useWhen: 'Source-backed pages that should feel like a small research center rather than a report dump.',
            topCluster: 'Lead with a summary callout and either a hero reference image or a clear source cue near the top.',
            bodyRhythm: 'Group findings by theme and use bookmarks, toggles, diagrams, or databases for evidence and depth.',
            supportCluster: 'Keep a dedicated sources or references section that is visually distinct from the synthesis sections.',
            styling: 'Use blue or green section labels for themes, with gray text for appendix or verification notes.',
        }),
        Object.freeze({
            id: 'operating-board',
            name: 'Operating Board',
            appliesTo: ['project', 'dashboard'],
            useWhen: 'Plans, trackers, dashboards, launches, and execution pages.',
            topCluster: 'Make the page status-first with icon, properties, a snapshot callout, and a tracker or database near the top.',
            bodyRhythm: 'Use compact sections for goals, blockers, owners, and next moves instead of narrative prose.',
            supportCluster: 'Leave follow-up items visible as todo blocks and keep references tucked into a lighter support cluster.',
            styling: 'Use green accents for status, muted notes for context, and clear section separators so the page feels operational.',
        }),
        Object.freeze({
            id: 'confidence-deck',
            name: 'Confidence Deck',
            appliesTo: ['sales', 'brief'],
            useWhen: 'Sales pitches, offer pages, proposals, and value-story notes that need persuasion without feeling spammy.',
            topCluster: 'Use title, a headline value callout, and one proof cue or hero visual immediately near the top.',
            bodyRhythm: 'Move from problem to solution to proof, then end on fit, objections, or next-step clarity.',
            supportCluster: 'Keep testimonials, case links, objections, or pricing notes in a distinct support cluster.',
            styling: 'Use warm accent blocks, compact proof blocks, and clean CTA sections so the page feels confident and readable.',
        }),
        Object.freeze({
            id: 'guided-reference',
            name: 'Guided Reference',
            appliesTo: ['documentation'],
            useWhen: 'How-to pages, SOPs, guides, onboarding, and technical references.',
            topCluster: 'Start with scope, audience, and a warning or prerequisite callout before the main steps.',
            bodyRhythm: 'Mix numbered steps, code or diagram blocks, and short explanatory text so the page stays task-oriented.',
            supportCluster: 'Use toggles for FAQ depth and bookmarks for external references.',
            styling: 'Keep the page clean and procedural with blue labels, warning callouts, and restrained visual accents.',
        }),
        Object.freeze({
            id: 'session-record',
            name: 'Session Record',
            appliesTo: ['meeting', 'journal'],
            useWhen: 'Meetings, reflections, interviews, retros, and log-style pages.',
            topCluster: 'Use title, context metadata, and a summary callout before the detailed notes.',
            bodyRhythm: 'Break the middle into highlights, decisions, reflections, and follow-up sections rather than one chronological wall of notes.',
            supportCluster: 'Use toggles for raw detail and todo blocks for explicit next steps.',
            styling: 'Keep the tone light and readable with muted support copy and only a few accent blocks.',
        }),
    ]);
    const NOTES_DESIGN_SCHEMES = Object.freeze([
        Object.freeze({
            id: 'warm-editorial',
            name: 'Warm Editorial',
            appliesTo: ['brief', 'explainer'],
            keywords: ['story', 'history', 'travel', 'culture', 'city', 'guide', 'feature'],
            palette: 'Orange or yellow focal callout, blue section labels, gray supporting notes.',
            headerTreatment: 'Let the title and top callout feel punchy and magazine-like, then settle into clean section labels.',
            visualDirection: 'Use one strong hero image or ai_image with an editorial caption near the top.',
            editingRule: 'If the page already has a strong lead block, preserve it and tighten the rhythm around it instead of restyling everything.',
        }),
        Object.freeze({
            id: 'field-guide',
            name: 'Field Guide',
            appliesTo: ['explainer', 'research'],
            keywords: ['animal', 'wildlife', 'species', 'habitat', 'nature', 'science', 'planet', 'ocean', 'bird'],
            palette: 'Green or blue section labels, warm summary callout, gray support notes, and natural photography.',
            headerTreatment: 'Open with a big-idea heading, then use compact labels for traits, habitat, behavior, or quick facts.',
            visualDirection: 'Prefer Unsplash or reference-photo style hero imagery and quick-facts clusters.',
            editingRule: 'Turn repeated facts into lists or databases and keep supporting notes secondary to the main themes.',
        }),
        Object.freeze({
            id: 'cool-knowledge',
            name: 'Cool Knowledge',
            appliesTo: ['research', 'documentation'],
            keywords: ['research', 'analysis', 'compare', 'evidence', 'reference', 'sources', 'documentation'],
            palette: 'Blue accents, gray support copy, restrained callout color, and crisp source blocks.',
            headerTreatment: 'Keep headings neat and information-dense, with one clear summary block above the evidence sections.',
            visualDirection: 'Use bookmarks, diagrams, and reference visuals more than decorative imagery.',
            editingRule: 'Preserve the strongest evidence and source clusters, and avoid adding noisy color or extra ornament.',
        }),
        Object.freeze({
            id: 'signal-board',
            name: 'Signal Board',
            appliesTo: ['project', 'dashboard'],
            keywords: ['project', 'plan', 'status', 'tracker', 'dashboard', 'roadmap', 'launch'],
            palette: 'Green accents for status, gray support copy, and tight metadata near the title.',
            headerTreatment: 'Make the opening cluster status-first with icon, properties, and a callout or tracker immediately visible.',
            visualDirection: 'Structured data should do most of the work; use visuals sparingly and only when they clarify the state of work.',
            editingRule: 'Keep the page operational and avoid turning tracker content into long prose.',
        }),
        Object.freeze({
            id: 'deal-room',
            name: 'Deal Room',
            appliesTo: ['sales'],
            keywords: ['sales', 'pitch', 'proposal', 'roi', 'client', 'customer', 'offer', 'pricing'],
            palette: 'Orange focal accents, gray support notes, and a restrained green highlight for proof or wins.',
            headerTreatment: 'Open with a bold value proposition and keep proof close to the top before deeper objections or pricing detail.',
            visualDirection: 'Use one hero visual or proof block, then let quotes, metrics, and offer sections carry the page.',
            editingRule: 'Keep claims tied to proof and avoid drifting into generic brand copy.',
        }),
        Object.freeze({
            id: 'calm-session',
            name: 'Calm Session',
            appliesTo: ['meeting', 'journal'],
            keywords: ['meeting', 'reflection', 'journal', 'retro', 'check-in', 'notes'],
            palette: 'Brown or purple section labels, gray secondary notes, and one soft focal block.',
            headerTreatment: 'Use a quiet title area followed by a summary callout before the detailed notes.',
            visualDirection: 'Use minimal visuals; let the page feel calm, legible, and easy to revisit.',
            editingRule: 'Preserve chronology or session structure while separating highlights, decisions, and next moves.',
        }),
    ]);
    const NOTES_BLOCK_DESIGN_PATTERNS = Object.freeze([
        Object.freeze({
            id: 'executive-signal-brief',
            name: 'Executive Signal Brief',
            shortLabel: 'Executive signal',
            appliesTo: ['brief', 'research', 'sales', 'project'],
            keywords: ['executive', 'brief', 'decision', 'takeaways', 'summary', 'leadership'],
            useWhen: 'The page needs a fast-read structure with a clear lead, supporting signal, and next moves.',
            blockFlow: [
                'callout for the headline recommendation or bottom line',
                'bulleted_list for key signals, takeaways, or implications',
                'heading_2 plus short text for why it matters',
                'todo or numbered_list for next steps',
            ],
            designMoves: [
                'Keep the opening answer-first.',
                'Use one focal block and one scan list before heavier prose.',
                'Pull risks or tradeoffs into their own section instead of burying them.',
            ],
            frontendMoves: [
                'Use update_page for a crisp title and icon.',
                'Keep section labels compact and visible.',
            ],
        }),
        Object.freeze({
            id: 'research-evidence-ladder',
            name: 'Research Evidence Ladder',
            shortLabel: 'Evidence ladder',
            appliesTo: ['research', 'documentation'],
            keywords: ['research', 'evidence', 'findings', 'analysis', 'sources', 'compare', 'comparison'],
            useWhen: 'The page should move from summary to themed findings to visible proof and source handling.',
            blockFlow: [
                'callout for the research question or synthesis',
                'database or bulleted_list for key findings',
                'heading_2 sections for each evidence theme',
                'bookmark or toggle cluster for source notes and verification',
            ],
            designMoves: [
                'Group evidence by theme, not chronology.',
                'Keep synthesis separate from raw source detail.',
                'Use bookmarks or databases for proof instead of prose-only citations.',
            ],
            frontendMoves: [
                'Use a visible source cluster near the end of the page.',
                'Give findings their own colored section labels.',
            ],
        }),
        Object.freeze({
            id: 'explainer-hero-facts',
            name: 'Explainer Hero + Facts',
            shortLabel: 'Hero + facts',
            appliesTo: ['explainer', 'research'],
            keywords: ['explainer', 'facts', 'science', 'animal', 'topic', 'overview', 'learn'],
            useWhen: 'The page should feel visual and approachable while still giving fast factual orientation.',
            blockFlow: [
                'callout for the big idea',
                'image or ai_image hero near the top',
                'database or quick-facts list cluster',
                'heading-led sections for how it works, why it matters, or notable traits',
            ],
            designMoves: [
                'Make the first screenful editorial, not textbook-like.',
                'Use quick facts to break up long explanation sections.',
                'Reserve toggles for deeper detail or caveats.',
            ],
            frontendMoves: [
                'Use captions and colored section labels to keep the page lively.',
                'Avoid starting with a wall of text.',
            ],
        }),
        Object.freeze({
            id: 'sales-proof-stack',
            name: 'Sales Proof Stack',
            shortLabel: 'Sales proof',
            appliesTo: ['sales', 'brief'],
            keywords: ['sales', 'pitch', 'proposal', 'client', 'customer', 'roi', 'value', 'pricing', 'objection', 'demo'],
            useWhen: 'The page needs a persuasive flow from pain to solution to proof to next-step clarity.',
            blockFlow: [
                'callout for the value proposition or promised outcome',
                'heading_2 sections for problem, solution, and fit',
                'quote, bookmark, or database blocks for proof, metrics, or testimonials',
                'todo or numbered_list for CTA, next step, or offer structure',
            ],
            designMoves: [
                'Lead with the payoff, not the company introduction.',
                'Tie every claim to proof, testimonial, metric, or example.',
                'End with a clear ask or next move.',
            ],
            frontendMoves: [
                'Keep proof visible in its own block type, not hidden in paragraphs.',
                'Use warm accents for the pitch, then calmer support notes for objections or pricing.',
            ],
        }),
        Object.freeze({
            id: 'operator-status-board',
            name: 'Operator Status Board',
            shortLabel: 'Status board',
            appliesTo: ['project', 'dashboard'],
            keywords: ['status', 'tracker', 'owners', 'timeline', 'roadmap', 'launch', 'milestone'],
            useWhen: 'The page should read like a live operating surface instead of a static memo.',
            blockFlow: [
                'callout for current status and headline risk or win',
                'database for workstreams, owners, or metrics',
                'heading_2 sections for blockers, highlights, and next moves',
                'todo blocks for immediate actions',
            ],
            designMoves: [
                'Keep status surfaces near the top.',
                'Prefer structured data over repeated prose.',
                'Use short sections for blockers and decisions.',
            ],
            frontendMoves: [
                'Use metadata and green accents to reinforce status.',
                'Keep operational sections compact and scannable.',
            ],
        }),
        Object.freeze({
            id: 'meeting-decision-log',
            name: 'Meeting Decision Log',
            shortLabel: 'Decision log',
            appliesTo: ['meeting'],
            keywords: ['meeting', 'agenda', 'decisions', 'attendees', 'action items', 'workshop'],
            useWhen: 'Notes need a clear split between discussion, decisions, and follow-up work.',
            blockFlow: [
                'callout for the headline outcome or meeting summary',
                'heading_2 sections for agenda, discussion, and decisions',
                'bulleted_list for decisions or standout points',
                'todo blocks for follow-up actions',
            ],
            designMoves: [
                'Separate raw notes from resolved decisions.',
                'Do not bury action items inside discussion paragraphs.',
                'Use toggles for optional detail or appendices.',
            ],
            frontendMoves: [
                'Use properties for date or owner when helpful.',
                'Keep the notes calm and legible, not overly styled.',
            ],
        }),
        Object.freeze({
            id: 'guided-procedure-ladder',
            name: 'Guided Procedure Ladder',
            shortLabel: 'Procedure ladder',
            appliesTo: ['documentation'],
            keywords: ['guide', 'setup', 'steps', 'runbook', 'procedure', 'workflow'],
            useWhen: 'Readers need clear task flow, prerequisites, examples, and troubleshooting depth.',
            blockFlow: [
                'callout for scope, audience, or warning',
                'numbered_list for the main procedure',
                'code, mermaid, or quote blocks for examples and caveats',
                'toggle section for FAQ or troubleshooting',
            ],
            designMoves: [
                'Keep sequences procedural, not essay-like.',
                'Put warnings in callouts instead of inline sentences.',
                'Use toggles for optional depth so the main flow stays clear.',
            ],
            frontendMoves: [
                'Use blue labels and restrained accents.',
                'Keep the page task-oriented from the first screenful.',
            ],
        }),
        Object.freeze({
            id: 'reflection-review-loop',
            name: 'Reflection Review Loop',
            shortLabel: 'Reflection loop',
            appliesTo: ['journal', 'meeting'],
            keywords: ['reflection', 'retro', 'journal', 'check-in', 'review', 'highlights'],
            useWhen: 'The page should support reflection, highlights, lessons, and forward planning.',
            blockFlow: [
                'callout for mood, theme, or main reflection',
                'heading_2 sections for highlights and lessons',
                'text blocks for reflection',
                'todo blocks for priorities or next moves',
            ],
            designMoves: [
                'Keep the tone lightweight and revisitable.',
                'Separate highlights from interpretation.',
                'Close with next moves so the page feels useful, not purely archival.',
            ],
            frontendMoves: [
                'Use soft accents and muted support notes.',
                'Avoid overloading the page with heavy visuals.',
            ],
        }),
    ]);
    const NOTES_PAGE_DESIGN_MANUAL = Object.freeze([
        'Design quality is part of correctness in notes mode. If the result feels like raw Markdown pasted into a page, it is not finished.',
        'Think in page roles, not just paragraphs: title/icon, focal summary, themed sections, supporting evidence, interactive details, sources, and next steps.',
        'Aim for a true Notion feel: one obvious focal block near the top, clear section rhythm, muted supporting notes, and at least one visual or source cluster when the page is substantial.',
        'Treat style as part of the page system, not decoration after the fact: use page icon, colored section labels, muted secondary copy, and accent callouts to create hierarchy.',
        'Use `heading_3` for compact section labels or mini-subsections. If a phrase should sit on its own line as a label, give it its own heading block instead of leaving it inline inside a paragraph.',
        'Avoid a long ladder of heading followed by paragraph repeated all the way down the page. Break the rhythm with callouts, visuals, bookmarks, databases, toggles, quotes, and dividers where they add clarity.',
        'Treat the first screenful like a designed landing zone for the note: title, summary, and visual support should appear early instead of making the page start as a wall of text.',
        'Research pages should usually feel like a small knowledge hub: lead with a summary callout, group findings by theme, and surface real sources as bookmarks instead of hiding them in prose.',
        'When the topic is visual, real-world, product-like, place-based, or research-driven, include a hero image or ai_image near the top instead of leaving the page text-only.',
        'Operational pages should feel usable, not literary: use databases for repeated fields, todos for actions, and visible status or decision callouts near the top.',
        'Use toggles for optional depth, appendices, research notes, or background material so the main page stays scannable but still interactive.',
        'When a page is meant to look polished, upgrade page metadata too: title, icon, and section rhythm should feel intentional, not accidental.',
        'Use styling on purpose: accent callouts, muted gray support copy, section label colors where helpful, and image/bookmark blocks that make the page feel designed instead of dumped.',
        'On a substantial page, avoid more than two plain text blocks in a row without a visual, callout, quote, list, divider, bookmark, toggle, or database to reset the rhythm.',
    ]);
    let initPromise = null;

    // ============================================
    // API Client Integration
    // ============================================
    
    // Get or create API client
    function getAPIClient() {
        if (window.notesAPIClient) return window.notesAPIClient;
        
        // Create new client if not exists
        if (typeof NotesAPIClient !== 'undefined') {
            window.notesAPIClient = new NotesAPIClient();
            return window.notesAPIClient;
        }
        
        return null;
    }

    function getCurrentPageSessionId() {
        return window.Editor?.getCurrentPage?.()?.id || null;
    }

    function getConversationSessionId(pageContext = null) {
        return state.sharedSessionId || pageContext?.pageId || getCurrentPageSessionId();
    }

    function syncAPIClientSession(apiClient, pageContext = null) {
        if (!apiClient?.setSessionId) {
            return null;
        }

        const sessionId = getConversationSessionId(pageContext);
        if (sessionId) {
            apiClient.setSessionId(sessionId);
        }

        return sessionId;
    }

    async function hydrateSharedConversationSession(apiClient = null) {
        const client = apiClient || getAPIClient();
        if (!client?.getSessionState || !client?.getSessionMessages) {
            return null;
        }

        try {
            const sessionState = await client.getSessionState();
            const activeSessionId = String(sessionState.activeSessionId || '').trim()
                || String(sessionState.sessions?.[0]?.id || '').trim();

            if (!activeSessionId) {
                return null;
            }

            state.sharedSessionId = activeSessionId;
            client.setSessionId(activeSessionId);

            const backendMessages = await client.getSessionMessages(activeSessionId, 100);
            if (backendMessages.length > 0) {
                state.messages = backendMessages
                    .map((message) => ({
                        ...message,
                        content: String(message?.content || '').trim(),
                    }))
                    .filter((message) => message.role && message.content)
                    .slice(-100);
                saveMessagesForPage(activeSessionId, state.messages);
            }

            return activeSessionId;
        } catch (error) {
            console.warn('Failed to hydrate shared notes session:', error);
            return null;
        }
    }

    function getMessagesStorageKey(pageId) {
        return pageId ? `${PAGE_MESSAGES_STORAGE_PREFIX}${pageId}` : LEGACY_MESSAGES_STORAGE_KEY;
    }

    function readStoredMessages(pageId = null) {
        const key = getMessagesStorageKey(pageId);

        try {
            const savedMessages = localStorage.getItem(key);
            if (savedMessages) {
                const parsed = JSON.parse(savedMessages);
                return Array.isArray(parsed) ? parsed : [];
            }

            if (pageId) {
                const legacyMessages = localStorage.getItem(LEGACY_MESSAGES_STORAGE_KEY);
                if (legacyMessages) {
                    const parsedLegacy = JSON.parse(legacyMessages);
                    return Array.isArray(parsedLegacy) ? parsedLegacy : [];
                }
            }
        } catch (error) {
            console.warn('Failed to read saved messages:', error);
        }

        return [];
    }

    function saveMessagesForPage(pageId, messages) {
        try {
            localStorage.setItem(getMessagesStorageKey(pageId), JSON.stringify(messages));
            if (pageId) {
                localStorage.removeItem(LEGACY_MESSAGES_STORAGE_KEY);
            }
        } catch (error) {
            console.warn('Failed to save messages:', error);
        }
    }
    
    // Check if backend is available
    async function isBackendAvailable() {
        const apiClient = getAPIClient();
        if (!apiClient) return false;

        syncAPIClientSession(apiClient);
        
        try {
            if (typeof apiClient.checkHealth === 'function') {
                const health = await apiClient.checkHealth();
                return Boolean(health?.connected);
            }

            await apiClient.getModels(true);
            return true;
        } catch (error) {
            console.log('Backend not available:', error.message);
            return false;
        }
    }
    
    function truncateText(text, maxLength = 240) {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return '';
        if (normalized.length <= maxLength) return normalized;
        return `${normalized.slice(0, maxLength - 3)}...`;
    }

    function normalizeInlineText(value = '') {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function formatTimestamp(timestamp) {
        if (!timestamp) return 'unknown';
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return 'unknown';
        return date.toISOString();
    }

    function stripUnsafeNullCharacters(value = '') {
        return String(value || '').replace(/\u0000/g, '');
    }

    function hasInternalToolCallMarkup(text = '') {
        if (/<\s*dsml[_-]?(?:tool[_-]?calls|invoke|parameter)\b[^>]*>/i.test(String(text || ''))) {
            return true;
        }
        return /<\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?(?:tool_calls|invoke|parameter)(?:\s*[|｜])?\b[^>]*>/i.test(String(text || ''));
    }

    function stripInternalToolCallMarkup(text = '') {
        let value = stripUnsafeNullCharacters(text);
        if (!value) {
            return '';
        }

        value = value.replace(/<\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?tool_calls(?:\s*[|｜])?\s*>[\s\S]*?<\s*\/\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?tool_calls(?:\s*[|｜])?\s*>/gi, '');
        value = value.replace(/<\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?tool_calls(?:\s*[|｜])?\s*>[\s\S]*$/i, '');
        value = value.replace(/<\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?invoke\b[^>]*>[\s\S]*?<\s*\/\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?invoke(?:\s*[|｜])?\s*>/gi, '');
        value = value.replace(/<\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?parameter\b[^>]*>[\s\S]*?<\s*\/\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?parameter(?:\s*[|｜])?\s*>/gi, '');
        value = value.replace(/<\s*\/?\s*(?:[|｜]\s*)?(?:DSML\s*[|｜]\s*)?(?:tool_calls|invoke|parameter)(?:\b[^>]*)?>/gi, '');
        value = value.replace(/<\s*dsml[_-]?tool[_-]?calls\b[^>]*>[\s\S]*?<\s*\/\s*dsml[_-]?tool[_-]?calls\s*>/gi, '');
        value = value.replace(/<\s*dsml[_-]?tool[_-]?calls\b[^>]*>[\s\S]*$/i, '');
        value = value.replace(/<\s*dsml[_-]?invoke\b[^>]*>[\s\S]*?<\s*\/\s*dsml[_-]?invoke\s*>/gi, '');
        value = value.replace(/<\s*dsml[_-]?parameter\b[^>]*>[\s\S]*?<\s*\/\s*dsml[_-]?parameter\s*>/gi, '');
        value = value.replace(/<\s*\/?\s*dsml[_-]?(?:tool[_-]?calls|invoke|parameter)\b[^>]*>/gi, '');
        return value.trim();
    }

    function sanitizeStructuredValue(value) {
        if (typeof value === 'string') {
            return stripUnsafeNullCharacters(value);
        }

        if (Array.isArray(value)) {
            return value.map((entry) => sanitizeStructuredValue(entry));
        }

        if (!value || typeof value !== 'object') {
            return value;
        }

        const sanitized = {};
        Object.entries(value).forEach(([key, entryValue]) => {
            sanitized[key] = sanitizeStructuredValue(entryValue);
        });
        return sanitized;
    }

    function looksLikeInternalNotesScaffold(text = '') {
        const normalized = stripUnsafeNullCharacters(text).trim().toLowerCase();
        if (!normalized) {
            return false;
        }

        return (
            normalized.includes('original request:')
            && (
                normalized.includes('approved page plan:')
                || normalized.includes('previous failed reply:')
            )
        )
            || hasInternalToolCallMarkup(text)
            || normalized.includes('interpret "page" as the current notes page shown in this editor')
            || normalized.includes('return notes-actions that apply the content to the current notes page')
            || normalized.includes('use this approved page plan:')
            || normalized.includes('use these expanded section briefs:')
            || normalized.includes('use this section-by-section application brief:')
            || normalized.includes('hidden planning pass for a substantial notes-writing request')
            || normalized.includes('hidden section-expansion pass for a substantial notes-writing request');
    }

    function coerceTextValue(value) {
        if (typeof value === 'string') {
            return stripUnsafeNullCharacters(value);
        }

        if (value == null) {
            return '';
        }

        const extracted = window.Blocks?.extractResponseText?.(value);
        if (typeof extracted === 'string' && extracted) {
            return stripUnsafeNullCharacters(extracted);
        }

        if (typeof value === 'object') {
            if (typeof value.text === 'string') return stripUnsafeNullCharacters(value.text);
            if (typeof value.content === 'string') return stripUnsafeNullCharacters(value.content);
            if (typeof value.message === 'string') return stripUnsafeNullCharacters(value.message);
            if (typeof value.prompt === 'string') return stripUnsafeNullCharacters(value.prompt);
        }

        return stripUnsafeNullCharacters(String(value));
    }

    function extractBlockTextValue(block) {
        if (!block) return '';

        const content = block.content;
        if (typeof content === 'string') {
            return content;
        }

        if (!content || typeof content !== 'object') {
            return '';
        }

        switch (block.type) {
            case 'todo': {
                const checked = content.checked ? '[x]' : '[ ]';
                return `${checked} ${content.text || ''}`.trim();
            }
            case 'callout':
                return `${content.icon || block.icon || '!'} ${content.text || ''}`.trim();
            case 'code':
                return content.text || '';
            case 'mermaid':
                return content.text ? `Mermaid ${content.diagramType || 'diagram'}: ${content.text}` : '';
            case 'ai': {
                const parts = [];
                if (content.prompt) parts.push(`Prompt: ${content.prompt}`);
                if (content.result) parts.push(`Result: ${content.result}`);
                return parts.join('\n');
            }
            case 'image':
                return content.caption || content.alt || content.url || 'Image block';
            case 'ai_image': {
                if (content.source === 'artifact' && Array.isArray(content.artifactResults) && content.artifactResults.length > 0) {
                    const sourceHost = content.sourceHost || content.artifactResults[0]?.sourceHost || 'captured source';
                    return `Captured images from ${sourceHost}: ${content.artifactResults.length} options`;
                }

                const source = content.source === 'unsplash'
                    ? 'Unsplash'
                    : (content.source === 'artifact' ? 'Captured image' : 'AI image');
                const details = [
                    content.prompt || '',
                    content.unsplashPhotographer ? `photo by ${content.unsplashPhotographer}` : '',
                    content.sourceHost && content.source === 'artifact' ? `captured from ${content.sourceHost}` : '',
                    content.imageUrl || ''
                ].filter(Boolean);
                return details.length ? `${source}: ${details.join(' | ')}` : source;
            }
            case 'bookmark':
                return content.title || content.description || content.url || 'Bookmark block';
            case 'database': {
                const columns = Array.isArray(content.columns) ? content.columns.length : 0;
                const rows = Array.isArray(content.rows) ? content.rows.length : 0;
                const columnList = Array.isArray(content.columns) ? content.columns.join(', ') : '';
                return columnList
                    ? `Database with ${columns} columns (${columnList}) and ${rows} rows`
                    : `Database with ${columns} columns and ${rows} rows`;
            }
            case 'math':
                return content.text || content.latex || '';
            default:
                return content.text ||
                    content.prompt ||
                    content.result ||
                    content.url ||
                    content.caption ||
                    '';
        }
    }

    function buildPageContentSnapshot(pageContext) {
        if (!pageContext?.blocks?.length) {
            return '(page is empty)';
        }

        return pageContext.blocks.map((block) => {
            const indent = '  '.repeat(block.depth);
            const styleParts = [];
            if (block.color) styleParts.push(`bg:${block.color}`);
            if (block.textColor) styleParts.push(`text:${block.textColor}`);
            const styleSuffix = styleParts.length ? ` {${styleParts.join(', ')}}` : '';
            const prefix = `${indent}- [${block.id}] ${block.type}${styleSuffix}`;
            const preview = truncateText(block.content, 220);
            return preview ? `${prefix}: ${preview}` : prefix;
        }).join('\n');
    }

    function buildTopLevelLayoutSnapshot(pageContext) {
        if (!pageContext?.blocks?.length) {
            return '- Page is empty. Start with a clear top-level structure.';
        }

        const rootBlocks = pageContext.blocks.filter((block) => Number(block.depth || 0) === 0);
        if (!rootBlocks.length) {
            return '- No root-level blocks detected.';
        }

        const maxRootBlocks = 80;
        const visibleRootBlocks = rootBlocks.slice(0, maxRootBlocks);
        const flow = visibleRootBlocks
            .map((block, index) => `${index + 1}. [${block.id}] ${block.type}: ${truncateText(block.content, 120) || '(empty)'}`)
            .join('\n');
        const overflowNote = rootBlocks.length > maxRootBlocks
            ? `Showing first ${maxRootBlocks} root blocks; use BLOCKS IN THIS PAGE for nested/detail targets beyond this list.`
            : '';

        const typeCounts = rootBlocks.reduce((counts, block) => {
            const key = String(block.type || 'unknown');
            counts[key] = (counts[key] || 0) + 1;
            return counts;
        }, {});
        const mix = Object.entries(typeCounts)
            .map(([type, count]) => `${type} x${count}`)
            .join(', ');

        return [
            `Top-level flow (${rootBlocks.length} blocks):`,
            flow,
            overflowNote,
            mix ? `Top-level mix: ${mix}` : '',
        ].filter(Boolean).join('\n');
    }

    function buildSectionEditMap(pageContext = null) {
        const blocks = Array.isArray(pageContext?.blocks) ? pageContext.blocks : [];
        if (!blocks.length) {
            return '- No section anchors yet. Create a lead cluster first, then add clear section headings before deep expansion.';
        }

        const sections = [];
        let currentSection = null;

        const commitSection = () => {
            if (!currentSection) {
                return;
            }

            const anchorLabel = currentSection.anchorId
                ? `[${currentSection.anchorId}]`
                : '[lead-cluster]';
            const rangeLabel = currentSection.blockIds.length > 1
                ? `${currentSection.blockIds[0]} -> ${currentSection.blockIds[currentSection.blockIds.length - 1]}`
                : (currentSection.blockIds[0] || 'n/a');
            const supportTypes = Array.from(currentSection.supportTypes);
            const preview = currentSection.preview.length
                ? ` | preview: ${currentSection.preview.join(' | ')}`
                : '';

            sections.push(
                `${sections.length + 1}. ${currentSection.label} ${anchorLabel} | ${currentSection.level} | blocks: ${currentSection.blockIds.length} | ids: ${rangeLabel}${supportTypes.length ? ` | support: ${supportTypes.join(', ')}` : ''}${preview}`
            );
            currentSection = null;
        };

        const ensureLeadSection = (block) => {
            if (currentSection) {
                return currentSection;
            }

            currentSection = {
                label: 'Lead cluster before first heading',
                anchorId: block?.id || null,
                level: 'lead',
                blockIds: [],
                supportTypes: new Set(),
                preview: [],
            };
            return currentSection;
        };

        blocks.forEach((block) => {
            const type = canonicalizeBlockType(block?.type || 'text');
            const text = truncateStructuredSummary(extractBlockTextValue(block), 72) || '(empty)';
            const isHeading = ['heading_1', 'heading_2', 'heading_3'].includes(type);

            if (isHeading) {
                commitSection();
                currentSection = {
                    label: extractBlockTextValue(block) || 'Untitled section',
                    anchorId: block?.id || null,
                    level: type.replace('heading_', 'H'),
                    blockIds: [block?.id || ''],
                    supportTypes: new Set(),
                    preview: [],
                };
                return;
            }

            const section = currentSection || ensureLeadSection(block);
            section.blockIds.push(block?.id || '');

            if (!['text', 'heading_1', 'heading_2', 'heading_3'].includes(type)) {
                section.supportTypes.add(type);
            }

            if (section.preview.length < 2) {
                section.preview.push(`${type}: ${text}`);
            }
        });

        commitSection();

        return sections.length
            ? sections.join('\n')
            : '- The page has content but no reliable sections yet. Add headings before making heavy edits.';
    }

    function buildPageEditWorkflowGuidance(question = '', pageContext = null) {
        const normalized = String(question || '').trim().toLowerCase();
        const blockCount = Number(pageContext?.blockCount || 0);
        const outlineCount = Array.isArray(pageContext?.outline) ? pageContext.outline.length : 0;
        const wantsRebuild = /\b(rebuild|from scratch|start over|replace (?:the )?(?:whole |entire )?page|wipe (?:the )?page|reset (?:the )?page)\b/.test(normalized);
        const wantsIncrementalEdit = /\b(add|additional|more|continue|insert|include|also|between|after|before|here|next|follow-up|follow up)\b/.test(normalized);
        const hasUsableSections = outlineCount >= 2 || blockCount >= 6;

        const lines = [
            '- Work in order: lead cluster first, then main sections, then support/source cluster, then a final polish pass.',
            blockCount === 0
                ? '- The page is empty, so create the full section structure first before expanding the details.'
                : (wantsRebuild || (!hasUsableSections && !wantsIncrementalEdit))
                    ? '- The current page is weak or mismatched enough that a rebuild_page response is acceptable if it produces a cleaner structure.'
                    : '- Preserve existing page content by default; use section anchors, insert_between_sections, insert_after_section, insert_here, replace_section, or delete_here for multi-round edits.',
            '- Treat each section as a small editing job: decide its role, choose the right block mix, then write only that section.',
            '- Prefer section-level edits over append-only drift: replace weak blocks, insert support blocks beside them, and only append at the bottom for genuinely new trailing content.',
            '- Use rebuild_page only when the user clearly asks to replace/reset the whole page or the page is effectively empty.',
            '- Finish with a polish pass: remove repeated wording, tighten headings, audit block variety, and make sure the first screenful has a focal block.',
        ];

        return lines.join('\n');
    }

    function buildEditResponsePatterns(pageContext = null) {
        const firstHeadingId = Array.isArray(pageContext?.outline) ? pageContext.outline[0]?.id : null;
        const firstBodyBlockId = Array.isArray(pageContext?.blocks)
            ? pageContext.blocks.find((block) => !/^heading_/.test(canonicalizeBlockType(block?.type || '')))?.id || pageContext.blocks[0]?.id
            : null;

        return [
            '- Full-page reset: use update_page + rebuild_page only when the user explicitly wants a page reset or the page is empty.',
            firstBodyBlockId
                ? `- Section upgrade: target an existing weak block like [${firstBodyBlockId}] with replace_block or update_block, then insert_after a richer support block beside it.`
                : '- Section upgrade: replace a weak block and add one richer support block beside it instead of appending a duplicate section elsewhere.',
            firstHeadingId
                ? `- Layout cleanup: move_block around a section anchor like [${firstHeadingId}] to reorder sections, then delete_block any duplicate leftovers.`
                : '- Layout cleanup: use move_block and delete_block to remove duplicate sections once the new order is clear.',
            '- Multi-round addition: use insert_between_sections, insert_after_section, insert_before_section, or insert_here so new material lands beside the relevant section without replacing earlier content.',
            '- Final polish: after the structure is correct, update page metadata if needed and add one focal callout, visual, database, bookmark, toggle, or divider where it strengthens the page.',
        ].join('\n');
    }

    function buildPageDesignCriteria(pageContext) {
        const blocks = Array.isArray(pageContext?.blocks) ? pageContext.blocks : [];
        const headings = blocks.filter((block) => String(block?.type || '').startsWith('heading_'));
        const textBlocks = blocks.filter((block) => ['text', 'quote', 'callout'].includes(block?.type));
        const listBlocks = blocks.filter((block) => ['bulleted_list', 'numbered_list', 'todo'].includes(block?.type));
        const callouts = blocks.filter((block) => block?.type === 'callout');
        const dividers = blocks.filter((block) => block?.type === 'divider');
        const visualBlocks = blocks.filter((block) => ['image', 'ai_image', 'bookmark'].includes(block?.type));
        const styledBlocks = blocks.filter((block) => block?.color || block?.textColor);
        const longTextBlocks = textBlocks.filter((block) => String(block?.content || '').trim().length >= 280);

        const criteria = [
            '- Design the note as a sequence of purposeful blocks, not one long paragraph dump.',
            '- For full-page writing, build a scannable structure first, then fill in details.',
            '- Use headings to define sections before adding supporting text.',
            '- Keep paragraphs short. Split dense writing into multiple text blocks.',
            '- Use lists for grouped facts, steps, examples, or comparisons instead of burying them in prose.',
            '- Use callouts, quotes, dividers, visuals, and visual rhythm intentionally when they improve clarity.',
            '- For polished notes, use block styling intentionally: accent the focal callout, use colored section labels, and mute secondary/supporting copy.',
            '- Do not return a single giant text block for a substantial page unless the user explicitly asks for one paragraph.',
        ];

        if (!blocks.length) {
            criteria.push('- The page is empty, so create a complete top-level structure instead of appending a loose paragraph.');
        }

        if (blocks.length > 0 && headings.length === 0) {
            criteria.push('- The current page has no headings. Add section headings so the layout becomes navigable.');
        }

        if (longTextBlocks.length > 0) {
            criteria.push(`- The current page already has ${longTextBlocks.length} dense text block${longTextBlocks.length === 1 ? '' : 's'}. Break long content into smaller blocks.`);
        }

        if (textBlocks.length > 0 && listBlocks.length === 0) {
            criteria.push('- The page is text-heavy. Introduce list blocks where content can be chunked.');
        }

        if (headings.length > 0) {
            criteria.push(`- Preserve and strengthen the existing hierarchy across ${headings.length} heading block${headings.length === 1 ? '' : 's'} when it helps.`);
        }

        if (callouts.length === 0) {
            criteria.push('- Consider at least one callout for the key takeaway, status, warning, or decision when the content warrants it.');
        }

        if (visualBlocks.length === 0 && blocks.length >= 5) {
            criteria.push('- The page has no visual or source media blocks yet. Add an image, ai_image, or bookmark cluster if the topic supports it.');
        }

        if (styledBlocks.length === 0 && blocks.length >= 4) {
            criteria.push('- Nothing on the page is styled yet. Use textColor and background color intentionally so the hierarchy feels designed.');
        }
        if ((styledBlocks.length > 0 || visualBlocks.length > 0) && blocks.length > 0) {
            criteria.push('- The page already has visual anchors. Preserve and extend the strongest existing icon, image, bookmark, or color language unless the user asks for a redesign.');
        }

        if (dividers.length === 0 && blocks.length >= 6) {
            criteria.push('- Use dividers sparingly to separate major sections if the page starts to feel visually dense.');
        }

        return criteria.join('\n');
    }

    function buildTemplateSignalText(question = '', pageContext = null) {
        const parts = [
            String(question || ''),
            String(pageContext?.title || ''),
            ...(Array.isArray(pageContext?.outline)
                ? pageContext.outline.map((item) => item?.content || '')
                : []),
            ...(Array.isArray(pageContext?.blocks)
                ? pageContext.blocks.slice(0, 20).map((block) => `${block?.type || ''} ${block?.content || ''}`)
                : []),
        ];

        return parts.join('\n').toLowerCase();
    }

    function scoreNotesPageTemplate(template, question = '', pageContext = null) {
        const signalText = buildTemplateSignalText(question, pageContext);
        let score = 0;

        template.matchers.forEach((matcher, index) => {
            if (matcher.test(signalText)) {
                score += index === 0 ? 7 : 4;
            }
        });

        const blockCount = Number(pageContext?.blockCount || 0);
        const blockTypes = new Set((pageContext?.blocks || []).map((block) => String(block?.type || '').trim().toLowerCase()));
        const outlineText = Array.isArray(pageContext?.outline)
            ? pageContext.outline.map((heading) => String(heading?.content || '').toLowerCase()).join('\n')
            : '';

        if (!blockCount) {
            if (template.id === 'brief' || template.id === 'documentation' || template.id === 'explainer') {
                score += 1;
            }
        }

        if (template.id === 'explainer' && /\b(what is|how does|why does|facts?|science|species|animal|planet|sun|star|history|habitat|life cycle)\b/.test(signalText)) {
            score += 4;
        }

        if (template.id === 'project' && (blockTypes.has('todo') || /\b(goals?|timeline|milestones?|owners?|resources?)\b/.test(outlineText))) {
            score += 3;
        }

        if (template.id === 'sales' && (/\b(value|roi|offer|proof|pricing|testimonial|customer|client|objection|solution)\b/.test(signalText) || /\b(problem|solution|proof|offer|next steps?)\b/.test(outlineText))) {
            score += 4;
        }

        if (template.id === 'meeting' && /\b(attendees?|agenda|decisions?|action items?)\b/.test(outlineText)) {
            score += 4;
        }

        if (template.id === 'dashboard' && (blockTypes.has('database') || /\b(status|metrics?|kpis?|blockers?)\b/.test(outlineText))) {
            score += 4;
        }

        if (template.id === 'documentation' && blockTypes.has('code')) {
            score += 3;
        }

        if (template.id === 'research' && /\b(sources?|findings?|evidence|comparison)\b/.test(outlineText)) {
            score += 3;
        }

        return score;
    }

    function selectNotesPageTemplates(question = '', pageContext = null, options = {}) {
        const { limit = 3 } = options;
        const ranked = NOTES_PAGE_TEMPLATES
            .map((template) => ({
                ...template,
                score: scoreNotesPageTemplate(template, question, pageContext),
            }))
            .sort((left, right) => right.score - left.score);

        const matches = ranked.filter((template) => template.score > 0).slice(0, limit);
        if (matches.length > 0) {
            return matches;
        }

        return NOTES_PAGE_TEMPLATES
            .filter((template) => ['explainer', 'brief', 'sales', 'documentation'].includes(template.id))
            .slice(0, limit)
            .map((template, index) => ({
                ...template,
                score: limit - index,
            }));
    }

    function buildTemplateGuidance(question = '', pageContext = null, templateMatches = []) {
        const matches = Array.isArray(templateMatches) && templateMatches.length > 0
            ? templateMatches
            : selectNotesPageTemplates(question, pageContext, { limit: 2 });

        if (!matches.length) {
            return 'No specific template match. Fall back to a clean heading-first document layout.';
        }

        return matches.map((template, index) => [
            `${index + 1}. ${template.name} [${template.id}]`,
            `   Use when: ${template.useWhen}`,
            `   Recommended metadata: ${buildTemplateMetadataSummary(template.id)}`,
            `   Required palette: ${buildTemplateRequiredPalette(template.id).join(' + ')}`,
            '   Suggested block flow:',
            ...template.structure.map((step) => `   - ${step}`),
            `   Design moves: ${template.designRules.join(' ')}`,
            `   Frontend moves: ${buildTemplateFrontendMoves(template.id).join(' ')}`,
        ].join('\n')).join('\n\n');
    }

    function selectNotesVisualRecipes(question = '', pageContext = null, templateMatches = []) {
        const matches = Array.isArray(templateMatches) && templateMatches.length > 0
            ? templateMatches
            : selectNotesPageTemplates(question, pageContext, { limit: 2 });
        const templateIds = new Set(matches.map((template) => template.id));

        const recipes = NOTES_VISUAL_PAGE_RECIPES.filter((recipe) =>
            Array.isArray(recipe.appliesTo) && recipe.appliesTo.some((templateId) => templateIds.has(templateId))
        );

        if (recipes.length > 0) {
            return recipes.slice(0, 2);
        }

        return NOTES_VISUAL_PAGE_RECIPES.slice(0, 2);
    }

    function buildVisualRecipeGuidance(question = '', pageContext = null, templateMatches = []) {
        const recipes = selectNotesVisualRecipes(question, pageContext, templateMatches);
        return recipes.map((recipe, index) => [
            `${index + 1}. ${recipe.name} [${recipe.id}]`,
            `   Use when: ${recipe.useWhen}`,
            `   Top cluster: ${recipe.topCluster}`,
            `   Body rhythm: ${recipe.bodyRhythm}`,
            `   Support cluster: ${recipe.supportCluster}`,
            `   Styling: ${recipe.styling}`,
        ].join('\n')).join('\n\n');
    }

    function buildVisualRecipeChecklist(question = '', pageContext = null, templateMatches = []) {
        const leadRecipe = selectNotesVisualRecipes(question, pageContext, templateMatches)[0] || null;
        if (!leadRecipe) {
            return '- Make the first screenful feel designed and avoid long runs of plain text blocks.';
        }

        return [
            `- Visual recipe: ${leadRecipe.name}.`,
            `- Lead cluster target: ${leadRecipe.topCluster}`,
            `- Rhythm target: ${leadRecipe.bodyRhythm}`,
            `- Support cluster target: ${leadRecipe.supportCluster}`,
        ].join('\n');
    }

    function scoreNotesDesignScheme(scheme, question = '', pageContext = null, templateMatches = []) {
        const signalText = buildTemplateSignalText(question, pageContext);
        const templateIds = new Set((templateMatches || []).map((template) => template.id));
        let score = 0;

        if (Array.isArray(scheme.appliesTo)) {
            scheme.appliesTo.forEach((templateId) => {
                if (templateIds.has(templateId)) {
                    score += 4;
                }
            });
        }

        if (Array.isArray(scheme.keywords)) {
            scheme.keywords.forEach((keyword) => {
                const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (new RegExp(`\\b${escaped}\\b`, 'i').test(signalText)) {
                    score += 2;
                }
            });
        }

        return score;
    }

    function selectNotesDesignSchemes(question = '', pageContext = null, templateMatches = []) {
        const matches = Array.isArray(templateMatches) && templateMatches.length > 0
            ? templateMatches
            : selectNotesPageTemplates(question, pageContext, { limit: 2 });

        const ranked = NOTES_DESIGN_SCHEMES
            .map((scheme) => ({
                ...scheme,
                score: scoreNotesDesignScheme(scheme, question, pageContext, matches),
            }))
            .sort((left, right) => right.score - left.score);

        const selected = ranked.filter((scheme) => scheme.score > 0).slice(0, 2);
        if (selected.length > 0) {
            return selected;
        }

        return NOTES_DESIGN_SCHEMES.slice(0, 2);
    }

    function buildDesignSchemeGuidance(question = '', pageContext = null, templateMatches = []) {
        const schemes = selectNotesDesignSchemes(question, pageContext, templateMatches);
        return schemes.map((scheme, index) => [
            `${index + 1}. ${scheme.name} [${scheme.id}]`,
            `   Palette: ${scheme.palette}`,
            `   Header treatment: ${scheme.headerTreatment}`,
            `   Visual direction: ${scheme.visualDirection}`,
            `   Editing rule: ${scheme.editingRule}`,
        ].join('\n')).join('\n\n');
    }

    function buildDesignSchemeChecklist(question = '', pageContext = null, templateMatches = []) {
        const leadScheme = selectNotesDesignSchemes(question, pageContext, templateMatches)[0] || null;
        if (!leadScheme) {
            return '- Choose one dominant visual scheme and keep it consistent across headers, callouts, visuals, and support notes.';
        }

        return [
            `- Dominant scheme: ${leadScheme.name}.`,
            `- Palette target: ${leadScheme.palette}`,
            `- Header rule: ${leadScheme.headerTreatment}`,
            `- Editing rule: ${leadScheme.editingRule}`,
        ].join('\n');
    }

    function scoreNotesBlockDesignPattern(pattern, question = '', pageContext = null, templateMatches = []) {
        const signalText = buildTemplateSignalText(question, pageContext);
        const templateIds = new Set((templateMatches || []).map((template) => template.id));
        let score = 0;

        if (Array.isArray(pattern.appliesTo)) {
            pattern.appliesTo.forEach((templateId) => {
                if (templateIds.has(templateId)) {
                    score += 4;
                }
            });
        }

        if (Array.isArray(pattern.keywords)) {
            pattern.keywords.forEach((keyword) => {
                const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (new RegExp(escaped, 'i').test(signalText)) {
                    score += 2;
                }
            });
        }

        return score;
    }

    function selectNotesBlockDesignPatterns(question = '', pageContext = null, templateMatches = [], options = {}) {
        const { limit = 4 } = options;
        const matches = Array.isArray(templateMatches) && templateMatches.length > 0
            ? templateMatches
            : selectNotesPageTemplates(question, pageContext, { limit: 2 });

        const ranked = NOTES_BLOCK_DESIGN_PATTERNS
            .map((pattern) => ({
                ...pattern,
                score: scoreNotesBlockDesignPattern(pattern, question, pageContext, matches),
            }))
            .sort((left, right) => right.score - left.score);

        const selected = ranked.filter((pattern) => pattern.score > 0).slice(0, limit);
        if (selected.length > 0) {
            return selected;
        }

        return NOTES_BLOCK_DESIGN_PATTERNS.slice(0, limit);
    }

    function buildBlockDesignPatternGuidance(question = '', pageContext = null, templateMatches = []) {
        const patterns = selectNotesBlockDesignPatterns(question, pageContext, templateMatches, { limit: 3 });
        return patterns.map((pattern, index) => [
            `${index + 1}. ${pattern.name} [${pattern.id}]`,
            `   Use when: ${pattern.useWhen}`,
            `   Block flow: ${pattern.blockFlow.join(' -> ')}`,
            `   Design moves: ${pattern.designMoves.join(' ')}`,
            `   Frontend moves: ${pattern.frontendMoves.join(' ')}`,
        ].join('\n')).join('\n\n');
    }

    function buildIndexedLayoutCatalogGuidance() {
        if (!window.NotesLayoutCatalog?.buildIndexedGuide) {
            return 'No indexed layout catalog is loaded. Use the best-fit page templates and visual recipes above.';
        }

        const layoutGuide = window.NotesLayoutCatalog.buildIndexedGuide();
        const starterGuide = window.NotesLayoutCatalog.buildStarterGuide?.(10) || '';
        return [
            'Indexed page layouts agents can reference by number or ID:',
            layoutGuide,
            starterGuide ? `Blank block starters for wipe-and-swap edits:\n${starterGuide}` : '',
        ].filter(Boolean).join('\n\n');
    }

    function buildBlockDesignPatternChecklist(question = '', pageContext = null, templateMatches = []) {
        const leadPattern = selectNotesBlockDesignPatterns(question, pageContext, templateMatches, { limit: 1 })[0] || null;
        if (!leadPattern) {
            return '- Pick one reusable block pattern for the lead section and one for the supporting sections instead of freehanding every block.';
        }

        return [
            `- Lead pattern: ${leadPattern.name}.`,
            `- Block flow target: ${leadPattern.blockFlow.join(' -> ')}.`,
            `- Design moves: ${leadPattern.designMoves.join(' ')}`,
            `- Frontend moves: ${leadPattern.frontendMoves.join(' ')}`,
        ].join('\n');
    }

    function buildBlockDesignPatternPrompt(pattern, question = '') {
        const prefix = String(question || '').trim()
            ? `${String(question || '').trim()}\n\n`
            : '';

        return `${prefix}Use the ${pattern.name} block pattern on the current notes page. Build the page with this block flow: ${pattern.blockFlow.join(' -> ')}. ${pattern.designMoves[0]} ${pattern.frontendMoves[0]}`;
    }

    function getLiveBlockDesignOptions(question = '', pageContext = null, options = {}) {
        const context = pageContext || getPageContext();
        const templateMatches = selectNotesPageTemplates(question, context, { limit: 2 });
        const patterns = selectNotesBlockDesignPatterns(question, context, templateMatches, {
            limit: options.limit || 4,
        });

        return patterns.map((pattern) => ({
            id: pattern.id,
            label: pattern.shortLabel || pattern.name,
            title: pattern.name,
            description: pattern.useWhen,
            prompt: buildBlockDesignPatternPrompt(pattern, question),
        }));
    }

    function buildTemplateRequiredPalette(templateId = 'brief') {
        switch (templateId) {
            case 'explainer':
                return ['callout', 'hero image/ai_image', 'quick facts database or list cluster', 'bookmark or toggle support section'];
            case 'research':
                return ['callout', 'hero image/ai_image', 'bookmark source cluster', 'toggle for deep detail'];
            case 'project':
                return ['callout', 'database or tracker', 'todo next steps', 'styled section headings'];
            case 'sales':
                return ['callout', 'proof block or quote', 'bookmark/database for evidence', 'CTA next-step section'];
            case 'meeting':
                return ['callout or summary block', 'agenda/notes hierarchy', 'todo action items', 'supporting divider or toggle'];
            case 'documentation':
                return ['callout', 'numbered steps or code', 'toggle or FAQ section', 'bookmark references'];
            case 'dashboard':
                return ['callout', 'database', 'compact highlights section', 'todo or blocker section'];
            case 'journal':
                return ['callout', 'short reflection sections', 'todo or priorities', 'optional visual or quote'];
            default:
                return ['callout', 'list for scannability', 'clear next-step or closeout section'];
        }
    }

    function buildTemplateMetadataSuggestions(templateId = 'brief') {
        const suggestions = (() => {
            switch (templateId) {
                case 'explainer':
                    return [
                        { key: 'Type', value: 'Explainer' },
                        { key: 'Mode', value: 'Visual knowledge page' },
                        { key: 'Audience', value: 'General reader' },
                    ];
                case 'research':
                    return [
                        { key: 'Type', value: 'Research' },
                        { key: 'Mode', value: 'Knowledge hub' },
                        { key: 'Evidence', value: 'Source-linked' },
                    ];
                case 'project':
                    return [
                        { key: 'Type', value: 'Project' },
                        { key: 'Status', value: 'Active draft' },
                        { key: 'Mode', value: 'Working plan' },
                    ];
                case 'sales':
                    return [
                        { key: 'Type', value: 'Sales pitch' },
                        { key: 'Status', value: 'Draft' },
                        { key: 'Mode', value: 'Value story' },
                    ];
                case 'meeting':
                    return [
                        { key: 'Type', value: 'Meeting' },
                        { key: 'Mode', value: 'Action log' },
                        { key: 'Status', value: 'Open' },
                    ];
                case 'documentation':
                    return [
                        { key: 'Type', value: 'Documentation' },
                        { key: 'Audience', value: 'Reader guide' },
                        { key: 'Status', value: 'Draft' },
                    ];
                case 'dashboard':
                    return [
                        { key: 'Type', value: 'Dashboard' },
                        { key: 'Cadence', value: 'Snapshot' },
                        { key: 'Mode', value: 'Operational' },
                    ];
                case 'journal':
                    return [
                        { key: 'Type', value: 'Journal' },
                        { key: 'Mode', value: 'Reflection' },
                        { key: 'Status', value: 'Personal note' },
                    ];
                default:
                    return [
                        { key: 'Type', value: 'Brief' },
                        { key: 'Layout', value: 'Scan-first' },
                        { key: 'Status', value: 'Draft' },
                    ];
            }
        })();

        return suggestions.filter((entry) => {
            const key = String(entry?.key || '').trim().toLowerCase();
            return key && !NOTES_TEMPLATE_METADATA_BLOCKLIST.has(key);
        });
    }

    function buildTemplateMetadataSummary(templateId = 'brief') {
        return buildTemplateMetadataSuggestions(templateId)
            .map((entry) => `${entry.key}: ${entry.value}`)
            .join(', ');
    }

    function buildTemplateFrontendMoves(templateId = 'brief') {
        switch (templateId) {
            case 'explainer':
                return [
                    'Use page metadata so the page opens with icon, compact properties, and a clear page identity.',
                    'Give the first screenful a hero image or ai_image instead of opening with only text.',
                    'Use a quick-facts cluster, warning callout, or source bookmarks to keep the page interactive.',
                ];
            case 'research':
                return [
                    'Set a page icon and compact research properties.',
                    'Lead with a hero visual or reference image when the topic benefits from it.',
                    'Use bookmarks instead of prose-only citations.',
                ];
            case 'project':
                return [
                    'Use update_page metadata so the page reads like a live working surface.',
                    'Prefer a database over repeated bullet lists for workstreams or owners.',
                    'Keep next actions visible as todo blocks.',
                ];
            case 'sales':
                return [
                    'Use metadata to frame the page as a pitch, proposal, or value story.',
                    'Keep proof visible in quote, bookmark, or database blocks rather than hiding it in prose.',
                    'Make the CTA or next step unmistakable near the end of the page.',
                ];
            case 'meeting':
                return [
                    'Use properties for the meeting date, owner, or status when useful.',
                    'Separate discussion from decisions and follow-up blocks.',
                    'Use toggles for raw notes or appendix material.',
                ];
            case 'documentation':
                return [
                    'Use properties to clarify scope, status, or prerequisites.',
                    'Keep setup or process sections procedural, not essay-like.',
                    'Use bookmarks for linked references and toggles for FAQ depth.',
                ];
            case 'dashboard':
                return [
                    'Use page metadata and database blocks to make the page feel operational.',
                    'Keep the top of the page status-first.',
                    'Use compact supporting sections rather than long prose.',
                ];
            case 'journal':
                return [
                    'Use a personal icon and light metadata only if it improves the page.',
                    'Keep sections short and revisitable.',
                    'A quote or visual can help the page feel intentional without becoming busy.',
                ];
            default:
                return [
                    'Use page metadata when it helps the page feel complete.',
                    'Lead with one focal block and one scannable support block.',
                    'Keep the page compact and deliberate.',
                ];
        }
    }

    function buildTemplateExecutionChecklist(templateMatches = []) {
        const leadTemplate = Array.isArray(templateMatches) && templateMatches.length > 0 ? templateMatches[0] : null;
        if (!leadTemplate) {
            return '- Use the strongest matching page recipe and make the design visible in blocks and metadata.';
        }

        return [
            `- Lead recipe: ${leadTemplate.name}.`,
            `- Add or preserve metadata: ${buildTemplateMetadataSummary(leadTemplate.id)}.`,
            `- Minimum block mix: ${buildTemplateRequiredPalette(leadTemplate.id).join(', ')}.`,
            `- Frontend moves: ${buildTemplateFrontendMoves(leadTemplate.id).join(' ')}`,
        ].join('\n');
    }

    function buildBlockOpportunityGuidance(question = '', pageContext = null, templateMatches = []) {
        const signalText = buildTemplateSignalText(question, pageContext);
        const currentTypes = new Set((pageContext?.blocks || []).map((block) => String(block?.type || '').trim().toLowerCase()));
        const templateIds = new Set((templateMatches || []).map((template) => template.id));
        const opportunities = [];

        if ((/\b(takeaway|summary|overview|warning|important|decision|snapshot|why it matters)\b/.test(signalText) || templateIds.has('brief'))
            && !currentTypes.has('callout')) {
            opportunities.push('- Add a `callout` for the key takeaway or headline insight instead of leaving it buried in text.');
        }

        if ((/\b(compare|comparison|status|tracker|metrics?|kpis?|owners?|timeline|matrix|table|database|quick facts?|at a glance|key facts?)\b/.test(signalText) || templateIds.has('dashboard') || templateIds.has('project') || templateIds.has('explainer'))
            && !currentTypes.has('database')) {
            opportunities.push('- Consider a `database` block if the page has repeated structured data, status items, comparisons, or ownership.');
        }

        if ((/\b(source|sources|reference|references|links?|citations?|research|article|documentation)\b/.test(signalText) || templateIds.has('research'))
            && !currentTypes.has('bookmark')) {
            opportunities.push('- Use `bookmark` blocks for the most important links or sources instead of mentioning them only inline.');
        }

        if ((/\b(sales|pitch|proposal|roi|testimonial|pricing|proof|client|customer|offer)\b/.test(signalText) || templateIds.has('sales'))
            && !currentTypes.has('quote')
            && !currentTypes.has('bookmark')
            && !currentTypes.has('database')) {
            opportunities.push('- Add a proof block such as `quote`, `bookmark`, or `database` so the pitch has evidence instead of only claims.');
        }

        if ((/\b(process|workflow|flow|system|architecture|how it works|pipeline|steps?)\b/.test(signalText) || templateIds.has('documentation'))
            && !currentTypes.has('mermaid')) {
            opportunities.push('- A `mermaid` block may communicate process or structure better than another paragraph.');
        }

        if ((/\b(photo|visual|image|hero|animal|place|product|look|appearance|species|planet|science|habitat)\b/.test(signalText) || templateIds.has('research') || templateIds.has('explainer'))
            && !currentTypes.has('image')
            && !currentTypes.has('ai_image')) {
            opportunities.push('- Add an `image` or `ai_image` block when the topic benefits from a strong visual on the page.');
        }

        if ((/\b(faq|questions|appendix|details|background|deep dive|extra context|sources?|further reading)\b/.test(signalText) || templateIds.has('documentation') || templateIds.has('explainer'))
            && !currentTypes.has('toggle')) {
            opportunities.push('- Use `toggle` blocks to keep optional details interactive instead of crowding the main flow.');
        }

        if ((/\b(action items?|next steps?|follow up|todo|checklist)\b/.test(signalText) || templateIds.has('project') || templateIds.has('meeting'))
            && !currentTypes.has('todo')) {
            opportunities.push('- Convert operational follow-ups into `todo` blocks so the page stays actionable.');
        }

        if ((/\b(quote|said|statement|definition|notable line|verbatim)\b/.test(signalText))
            && !currentTypes.has('quote')) {
            opportunities.push('- Use a `quote` block if there is a line or definition that deserves emphasis.');
        }

        if ((pageContext?.blockCount || 0) >= 6 && !currentTypes.has('divider')) {
            opportunities.push('- Add a `divider` between major sections if the page feels visually dense.');
        }

        if (!opportunities.length) {
            opportunities.push('- Do a palette audit before finalizing: if headings + text + lists are all you used, check whether one richer block type would improve the page.');
        }

        return opportunities.join('\n');
    }

    function buildNotesPageDesignManual() {
        return NOTES_PAGE_DESIGN_MANUAL.map((line) => `- ${line}`).join('\n');
    }

    function getTemplateDesignPreset(templateId = 'brief') {
        return NOTES_TEMPLATE_DESIGN_PRESETS[templateId] || NOTES_TEMPLATE_DESIGN_PRESETS.brief;
    }

    function buildVisualAnchorSnapshot(pageContext = null) {
        if (!pageContext) {
            return '- No page loaded yet, so choose a scheme and establish the visual anchors from scratch.';
        }

        const blocks = Array.isArray(pageContext.blocks) ? pageContext.blocks : [];
        const stats = analyzeStructuredBlocks(blocks);
        const colorCounts = {};
        blocks.forEach((block) => {
            ['color', 'textColor'].forEach((key) => {
                const value = String(block?.[key] || '').trim().toLowerCase();
                if (!value || value === 'default') {
                    return;
                }
                colorCounts[value] = (colorCounts[value] || 0) + 1;
            });
        });

        const colorSummary = Object.entries(colorCounts)
            .sort((left, right) => right[1] - left[1])
            .slice(0, 4)
            .map(([color, count]) => `${color} x${count}`)
            .join(', ');

        const focalTypes = ['callout', 'image', 'ai_image', 'bookmark', 'database', 'quote'];
        const leadFocalBlocks = blocks
            .filter((block) => focalTypes.includes(canonicalizeBlockType(block?.type || '')))
            .slice(0, 4)
            .map((block) => `${canonicalizeBlockType(block?.type || '')}: ${truncateStructuredSummary(extractBlockDefinitionText(block), 90) || '(empty)'}`);

        return [
            `- Existing icon: ${pageContext.icon || '(none)'}`,
            `- Existing cover: ${pageContext.hasCover ? 'present' : 'none'}`,
            `- Visual/source blocks already on page: ${stats.visualSupportCount}`,
            `- Styled blocks already on page: ${stats.styledBlockCount}`,
            `- Existing accent colors: ${colorSummary || 'none yet'}`,
            `- Lead focal blocks: ${leadFocalBlocks.length ? leadFocalBlocks.join(' | ') : 'none yet'}`,
            '- Editing rule: preserve and extend the strongest current visual anchors unless the user explicitly asks for a different look.',
        ].join('\n');
    }

    function resolveTemplateDesignPreset(templateId = 'brief', context = null) {
        const basePreset = getTemplateDesignPreset(templateId);
        const blocks = Array.isArray(context?.blocks) ? context.blocks : [];
        if (!blocks.length) {
            return basePreset;
        }

        const colorCounts = {};
        blocks.forEach((block) => {
            ['color', 'textColor'].forEach((key) => {
                const value = String(block?.[key] || '').trim().toLowerCase();
                if (!value || value === 'default' || value === 'gray') {
                    return;
                }
                colorCounts[value] = (colorCounts[value] || 0) + 1;
            });
        });

        const dominantAccent = Object.entries(colorCounts)
            .sort((left, right) => right[1] - left[1])[0]?.[0] || '';

        if (!dominantAccent) {
            return basePreset;
        }

        return {
            ...basePreset,
            sectionTextColor: dominantAccent,
            calloutColor: dominantAccent,
        };
    }

    function extractBlockDefinitionText(block) {
        if (!block || typeof block !== 'object') {
            return '';
        }

        const type = canonicalizeBlockType(block.type || 'text');
        const content = Object.prototype.hasOwnProperty.call(block, 'content')
            ? block.content
            : (Object.prototype.hasOwnProperty.call(block, 'text')
                ? block.text
                : (block.prompt || block.caption || block.url || block.imageUrl || block.title || block.description || ''));

        if (typeof content === 'string') {
            return stripUnsafeNullCharacters(content);
        }

        if (!content || typeof content !== 'object') {
            return '';
        }

        switch (type) {
            case 'todo':
                return stripUnsafeNullCharacters(String(content.text || ''));
            case 'callout':
                return coerceTextValue(content.text || content.content || content.message || '');
            case 'code':
                return stripUnsafeNullCharacters(String(content.text || ''));
            case 'math':
                return stripUnsafeNullCharacters(String(content.text || content.latex || ''));
            case 'mermaid':
                return stripUnsafeNullCharacters(String(content.text || ''));
            case 'ai':
                return coerceTextValue(content.result || content.prompt || '');
            case 'image':
                return coerceTextValue(content.caption || content.alt || content.url || '');
            case 'ai_image':
                return coerceTextValue(content.caption || content.prompt || content.imageUrl || '');
            case 'bookmark':
                return coerceTextValue(content.title || content.description || content.url || '');
            default:
                return coerceTextValue(
                    content.text
                    || content.prompt
                    || content.result
                    || content.caption
                    || content.url
                    || ''
                );
        }
    }

    function cloneStructuredValue(value) {
        if (value == null) {
            return value;
        }

        try {
            return JSON.parse(JSON.stringify(value));
        } catch (_error) {
            return value;
        }
    }

    function truncateStructuredSummary(text = '', maxChars = 180) {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!normalized || normalized.length <= maxChars) {
            return normalized;
        }

        const clipped = normalized.slice(0, maxChars + 1);
        const boundary = clipped.lastIndexOf(' ');
        return `${(boundary >= 90 ? clipped.slice(0, boundary) : clipped.slice(0, maxChars)).trim()}...`;
    }

    function stripHtmlToPlainText(value = '') {
        return String(value || '')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function analyzeStructuredBlocks(blocks = []) {
        const typeCounts = {};
        let textChars = 0;
        let longTextCount = 0;
        let visualSupportCount = 0;
        let styledBlockCount = 0;

        blocks.forEach((block) => {
            const type = canonicalizeBlockType(block?.type || 'text');
            typeCounts[type] = (typeCounts[type] || 0) + 1;

            const text = extractBlockDefinitionText(block).trim();
            textChars += text.length;
            if (['text', 'quote', 'callout', 'toggle'].includes(type) && text.length >= 220) {
                longTextCount += 1;
            }

            if (['image', 'ai_image', 'bookmark'].includes(type)) {
                visualSupportCount += 1;
            }

            if (block?.color || block?.textColor) {
                styledBlockCount += 1;
            }
        });

        const layoutSupportTypes = ['callout', 'bookmark', 'database', 'image', 'ai_image', 'mermaid', 'toggle', 'divider', 'todo'];
        const layoutSupportCount = layoutSupportTypes.reduce((total, type) => total + (typeCounts[type] || 0), 0);

        return {
            blockCount: blocks.length,
            textChars,
            longTextCount,
            visualSupportCount,
            styledBlockCount,
            typeCounts,
            layoutSupportCount,
        };
    }

    function countMaxPlainBlockRun(blocks = []) {
        if (!Array.isArray(blocks) || blocks.length === 0) {
            return 0;
        }

        const plainTypes = new Set(['text', 'bulleted_list', 'numbered_list']);
        let currentRun = 0;
        let maxRun = 0;

        blocks.forEach((block) => {
            const type = canonicalizeBlockType(block?.type || 'text');
            if (plainTypes.has(type)) {
                currentRun += 1;
                maxRun = Math.max(maxRun, currentRun);
                return;
            }

            currentRun = 0;
        });

        return maxRun;
    }

    function hasMeaningfulPageIcon(pageContext = null) {
        const icon = String(pageContext?.icon || '').trim();
        return Boolean(icon && !/^note$/i.test(icon));
    }

    function inferCoverUrlFromBlocks(blocks = []) {
        if (!Array.isArray(blocks)) {
            return '';
        }

        for (const block of blocks) {
            const type = canonicalizeBlockType(block?.type || '');
            if (type === 'image') {
                const url = String(block?.content?.url || '').trim();
                if (/^https?:\/\//i.test(url)) {
                    return url;
                }
            }

            if (type === 'ai_image') {
                const url = String(block?.content?.imageUrl || block?.content?.downloadUrl || '').trim();
                if (/^https?:\/\//i.test(url)) {
                    return url;
                }
            }
        }

        return '';
    }

    function buildPageContextFromGeneratedBlocks(blocks = [], context = null) {
        const outline = blocks
            .filter((block) => /^heading_/.test(canonicalizeBlockType(block?.type || '')))
            .map((block, index) => ({
                id: block?.id || `generated_heading_${index}`,
                content: extractBlockDefinitionText(block),
            }));

        return {
            ...(context || {}),
            blocks,
            blockCount: blocks.length,
            outline,
        };
    }

    function inferStructuredPageTitle({ blocks = [], action = null, context = null, question = '' } = {}) {
        const heading = blocks.find((block) => canonicalizeBlockType(block?.type || '') === 'heading_1');
        const headingText = extractBlockDefinitionText(heading).trim();
        if (headingText) {
            return headingText;
        }

        const actionTitle = String(action?.title || '').trim();
        if (actionTitle) {
            return actionTitle;
        }

        const contextTitle = String(context?.title || '').trim();
        if (contextTitle && !/^untitled$/i.test(contextTitle)) {
            return contextTitle;
        }

        const aboutMatch = String(question || '').match(/\b(?:about|on|regarding|for)\s+(.+?)(?:[?.!,]|$)/i);
        return aboutMatch ? aboutMatch[1].trim() : '';
    }

    function inferStructuredPageSubject(options = {}) {
        const title = inferStructuredPageTitle(options);
        if (!title) {
            return '';
        }

        const subject = title.split(/[:\-–—|]/)[0].trim();
        return subject || title;
    }

    function buildFallbackCalloutText(templateId = 'brief', subject = '') {
        const safeSubject = subject || 'This page';
        switch (templateId) {
            case 'explainer':
                return `${safeSubject}: open with the big idea, then make the page easy to scan with quick facts, clear sections, and visual support.`;
            case 'research':
                return `${safeSubject} at a glance: the page should surface the strongest themes, the clearest evidence, and why the topic matters.`;
            case 'project':
                return `${safeSubject}: lead with the goal, current status, and the next actions that move the work forward.`;
            case 'dashboard':
                return `${safeSubject}: keep the operating picture visible with a clear status read, key highlights, and immediate watchouts.`;
            case 'documentation':
                return `${safeSubject}: clarify scope, the core workflow, and the warnings or prerequisites a reader should notice first.`;
            case 'meeting':
                return `${safeSubject}: separate context, decisions, and follow-up actions so the page works after the meeting is over.`;
            case 'journal':
                return `${safeSubject}: keep the main theme visible, then support it with highlights, reflections, and next moves.`;
            default:
                return `${safeSubject}: lead with the bottom line and keep the page scannable before adding deeper detail.`;
        }
    }

    function buildCalloutBlock(text = '', preset = {}) {
        return {
            type: 'callout',
            content: {
                text: truncateStructuredSummary(text, 220),
                icon: preset.calloutIcon || '💡',
            },
            color: preset.calloutColor || null,
        };
    }

    function ensureTemplateCalloutBlock(blocks = [], { template = null, preset = null, action = null, context = null, question = '' } = {}) {
        if (!Array.isArray(blocks) || blocks.length === 0) {
            return blocks;
        }

        const typeCounts = analyzeStructuredBlocks(blocks).typeCounts;
        if (typeCounts.callout > 0) {
            return blocks;
        }

        const nextBlocks = blocks.map((block) => cloneStructuredValue(block));
        const introIndex = nextBlocks.findIndex((block, index) => {
            if (index === 0) {
                return false;
            }

            const type = canonicalizeBlockType(block?.type || '');
            if (!['quote', 'text'].includes(type)) {
                return false;
            }

            const text = extractBlockDefinitionText(block).trim();
            return text.length >= 24 && text.length <= 260;
        });

        const designPreset = preset || getTemplateDesignPreset(template?.id);
        if (introIndex >= 0) {
            nextBlocks[introIndex] = buildCalloutBlock(extractBlockDefinitionText(nextBlocks[introIndex]), designPreset);
            return nextBlocks;
        }

        const subject = inferStructuredPageSubject({ blocks: nextBlocks, action, context, question });
        const fallbackText = buildFallbackCalloutText(template?.id || 'brief', subject);
        const calloutBlock = buildCalloutBlock(fallbackText, designPreset);
        const firstHeadingIndex = nextBlocks.findIndex((block) => canonicalizeBlockType(block?.type || '') === 'heading_1');

        if (firstHeadingIndex >= 0) {
            nextBlocks.splice(firstHeadingIndex + 1, 0, calloutBlock);
            return nextBlocks;
        }

        return [calloutBlock, ...nextBlocks];
    }

    function looksLikeSourceHeadingText(text = '') {
        return /\b(sources?|references?|citations?|links?|verified sources?|source note|research note)\b/i.test(String(text || ''));
    }

    function maybeConvertSupportNoteToToggle(blocks = [], { template = null } = {}) {
        if (!Array.isArray(blocks) || blocks.length < 2) {
            return blocks;
        }

        const stats = analyzeStructuredBlocks(blocks);
        if (stats.typeCounts.toggle > 0 || !['explainer', 'research', 'documentation'].includes(template?.id)) {
            return blocks;
        }

        const nextBlocks = blocks.map((block) => cloneStructuredValue(block));
        for (let index = 0; index < nextBlocks.length - 1; index++) {
            const current = nextBlocks[index];
            const next = nextBlocks[index + 1];
            const currentType = canonicalizeBlockType(current?.type || '');
            const nextType = canonicalizeBlockType(next?.type || '');
            const headingText = extractBlockDefinitionText(current).trim();
            const nextText = extractBlockDefinitionText(next).trim();

            if (!/^heading_/.test(currentType) || nextType !== 'text') {
                continue;
            }

            if (!/\b(source note|research note|background|appendix|deep dive|extra context|verification note)\b/i.test(headingText)) {
                continue;
            }

            if (nextText.length < 120) {
                continue;
            }

            let headingIndex = index;
            if (headingIndex > 0 && canonicalizeBlockType(nextBlocks[headingIndex - 1]?.type || '') !== 'divider' && nextBlocks.length >= 7) {
                nextBlocks.splice(headingIndex, 0, { type: 'divider', content: '' });
                headingIndex += 1;
            }

            nextBlocks[headingIndex + 1] = {
                type: 'toggle',
                content: nextText,
                color: 'gray',
            };
            return nextBlocks;
        }

        return blocks;
    }

    function maybeConvertQuickFactsToDatabase(blocks = [], { template = null } = {}) {
        if (!Array.isArray(blocks) || blocks.length < 4) {
            return blocks;
        }

        const stats = analyzeStructuredBlocks(blocks);
        if (stats.typeCounts.database > 0 || !['explainer', 'research'].includes(template?.id)) {
            return blocks;
        }

        const nextBlocks = blocks.map((block) => cloneStructuredValue(block));
        for (let index = 0; index < nextBlocks.length - 2; index++) {
            const heading = nextBlocks[index];
            const headingType = canonicalizeBlockType(heading?.type || '');
            const headingText = extractBlockDefinitionText(heading).trim();
            if (!/^heading_/.test(headingType) || !/\b(quick facts?|fun facts?|at a glance|key facts?)\b/i.test(headingText)) {
                continue;
            }

            const listItems = [];
            let scanIndex = index + 1;
            while (scanIndex < nextBlocks.length) {
                const candidate = nextBlocks[scanIndex];
                const candidateType = canonicalizeBlockType(candidate?.type || '');
                if (!['bulleted_list', 'numbered_list'].includes(candidateType)) {
                    break;
                }
                const text = extractBlockDefinitionText(candidate).trim();
                if (text) {
                    listItems.push(text);
                }
                scanIndex += 1;
            }

            if (listItems.length < 3) {
                continue;
            }

            const colonHeavy = listItems.filter((item) => /:/.test(item)).length >= Math.ceil(listItems.length / 2);
            const databaseContent = colonHeavy
                ? {
                    columns: ['Fact', 'Detail'],
                    rows: listItems.map((item) => {
                        const parts = item.split(/:\s*/, 2);
                        return [parts[0] || 'Fact', parts[1] || ''];
                    }),
                    sortColumn: null,
                    sortDirection: 'asc',
                }
                : {
                    columns: ['Quick fact'],
                    rows: listItems.map((item) => [item]),
                    sortColumn: null,
                    sortDirection: 'asc',
                };

            nextBlocks.splice(index + 1, listItems.length, {
                type: 'database',
                content: databaseContent,
            });
            return nextBlocks;
        }

        return blocks;
    }

    function maybeConvertWarningTextToCallout(blocks = [], { template = null } = {}) {
        if (!Array.isArray(blocks) || blocks.length < 3) {
            return blocks;
        }

        const stats = analyzeStructuredBlocks(blocks);
        if (stats.typeCounts.callout > 1 || !['explainer', 'research', 'documentation'].includes(template?.id)) {
            return blocks;
        }

        const nextBlocks = blocks.map((block) => cloneStructuredValue(block));
        for (let index = 0; index < nextBlocks.length - 1; index++) {
            const heading = nextBlocks[index];
            const body = nextBlocks[index + 1];
            const headingType = canonicalizeBlockType(heading?.type || '');
            const bodyType = canonicalizeBlockType(body?.type || '');
            const headingText = extractBlockDefinitionText(heading).trim();

            if (!/^heading_/.test(headingType) || !/\b(stay safe|safety|warning|watch out|important|caution)\b/i.test(headingText)) {
                continue;
            }

            if (!['text', 'quote'].includes(bodyType)) {
                continue;
            }

            const bodyText = extractBlockDefinitionText(body).trim();
            if (bodyText.length < 40 || bodyText.length > 240) {
                continue;
            }

            nextBlocks[index + 1] = {
                type: 'callout',
                content: {
                    text: truncateStructuredSummary(bodyText, 220),
                    icon: '⚠️',
                },
                color: 'orange',
            };
            return nextBlocks;
        }

        return blocks;
    }

    function ensureSupportSectionDivider(blocks = [], { template = null } = {}) {
        if (!Array.isArray(blocks) || blocks.length < 6) {
            return blocks;
        }

        if (!['explainer', 'research', 'documentation', 'meeting'].includes(template?.id)) {
            return blocks;
        }

        const nextBlocks = blocks.map((block) => cloneStructuredValue(block));
        const dividerIndex = nextBlocks.findIndex((block, index) => {
            if (index < 2) {
                return false;
            }

            const type = canonicalizeBlockType(block?.type || '');
            if (!/^heading_/.test(type)) {
                return false;
            }

            return /\b(source note|research note|sources?|references?|appendix|deep dive|follow[- ]?up|faq|next upgrade)\b/i.test(extractBlockDefinitionText(block));
        });

        if (dividerIndex >= 2) {
            nextBlocks.splice(dividerIndex, 0, { type: 'divider', content: '' });
            return nextBlocks;
        }

        return blocks;
    }

    function ensureLeadClusterDivider(blocks = [], { template = null } = {}) {
        if (!Array.isArray(blocks) || blocks.length < 6) {
            return blocks;
        }

        if (!['explainer', 'research', 'brief', 'documentation'].includes(template?.id)) {
            return blocks;
        }

        const nextBlocks = blocks.map((block) => cloneStructuredValue(block));
        const firstSectionIndex = nextBlocks.findIndex((block, index) =>
            index >= 2 && ['heading_2', 'heading_3'].includes(canonicalizeBlockType(block?.type || ''))
        );

        if (firstSectionIndex < 3) {
            return blocks;
        }

        const leadCluster = nextBlocks.slice(0, firstSectionIndex);
        const hasDesignedLead = leadCluster.some((block) => ['callout', 'image', 'ai_image', 'bookmark', 'database', 'quote'].includes(canonicalizeBlockType(block?.type || '')));
        if (!hasDesignedLead) {
            return blocks;
        }

        if (canonicalizeBlockType(nextBlocks[firstSectionIndex - 1]?.type || '') === 'divider') {
            return blocks;
        }

        nextBlocks.splice(firstSectionIndex, 0, { type: 'divider', content: '' });
        return nextBlocks;
    }

    function shouldPreferHeroVisual({ template = null, question = '', blocks = [] } = {}) {
        const signalText = [
            String(question || ''),
            ...blocks.slice(0, 12).map((block) => extractBlockDefinitionText(block)),
        ].join('\n').toLowerCase();

        if (['explainer', 'research', 'brief', 'journal'].includes(template?.id)) {
            return true;
        }

        return /\b(animal|wildlife|bird|species|nature|ocean|sea|mountain|city|travel|product|brand|design|visual|photo|look|appearance|gallery|place|landscape|science|habitat|planet|star)\b/.test(signalText);
    }

    function buildTemplateHeroImageBlock({ template = null, preset = null, action = null, context = null, question = '' } = {}) {
        const subject = inferStructuredPageSubject({ blocks: action?.blocks || [], action, context, question }) || 'page topic';
        const promptBase = `${subject}, ${preset?.heroPromptSuffix || 'editorial reference photo'}`;
        const captionPrefix = preset?.heroCaptionPrefix || 'Reference visual';

        return {
            type: 'ai_image',
            content: {
                prompt: promptBase,
                caption: `${captionPrefix}: ${subject}`,
                imageUrl: null,
                model: null,
                size: '1536x1024',
                quality: null,
                style: null,
                source: 'unsplash',
                status: 'pending',
                unsplashResults: null,
                selectedUnsplashId: null,
                unsplashPhotographer: null,
                unsplashPhotographerUrl: null,
                imageAssetId: null,
                downloadUrl: null,
            },
        };
    }

    function ensureHeroVisualBlock(blocks = [], { template = null, preset = null, action = null, context = null, question = '' } = {}) {
        if (!Array.isArray(blocks) || blocks.length === 0) {
            return blocks;
        }

        const stats = analyzeStructuredBlocks(blocks);
        if (stats.visualSupportCount > 0 || !shouldPreferHeroVisual({ template, question, blocks })) {
            return blocks;
        }

        const nextBlocks = blocks.map((block) => cloneStructuredValue(block));
        const heroBlock = buildTemplateHeroImageBlock({ template, preset, action, context, question });
        const calloutIndex = nextBlocks.findIndex((block) => canonicalizeBlockType(block?.type || '') === 'callout');
        if (calloutIndex >= 0) {
            nextBlocks.splice(calloutIndex + 1, 0, heroBlock);
            return nextBlocks;
        }

        const headingIndex = nextBlocks.findIndex((block) => canonicalizeBlockType(block?.type || '') === 'heading_1');
        if (headingIndex >= 0) {
            nextBlocks.splice(headingIndex + 1, 0, heroBlock);
            return nextBlocks;
        }

        return [heroBlock, ...nextBlocks];
    }

    function looksLikeSupportingSection(text = '') {
        return /\b(source note|research note|background|appendix|deep dive|extra context|verification note|references?|sources?|follow[- ]?up|next steps?|faq)\b/i.test(String(text || ''));
    }

    function looksLikeCompactSectionLabel(text = '') {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!normalized || normalized.length > 72) {
            return false;
        }

        if (/^[-*•\d]/.test(normalized) || /^https?:\/\//i.test(normalized)) {
            return false;
        }

        const withoutColon = normalized.replace(/:\s*$/, '').trim();
        const words = withoutColon.split(/\s+/).filter(Boolean);
        if (words.length === 0 || words.length > 7) {
            return false;
        }

        if (/[.!?]$/.test(withoutColon)) {
            return false;
        }

        if (words.length === 1) {
            return /^[A-Z0-9][A-Za-z0-9'’/&-]+$/.test(words[0]);
        }

        return /^[A-Z0-9][A-Za-z0-9'’/&-]*(?:\s+(?:[A-Z0-9][A-Za-z0-9'’/&-]*|and|or|of|the|for|to|in|on|with|vs\.?)){1,6}$/.test(withoutColon);
    }

    function shouldSplitInlineSectionLabel(label = '', body = '') {
        const normalizedLabel = String(label || '').trim();
        const normalizedBody = String(body || '').trim();
        if (!looksLikeCompactSectionLabel(normalizedLabel) || normalizedBody.length < 24) {
            return false;
        }

        if (/\b(big idea|key takeaway|takeaway|summary|important|warning|note|why it matters|bottom line)\b/i.test(normalizedLabel)) {
            return false;
        }

        return true;
    }

    function maybePromoteCompactSectionLabels(blocks = [], { preset = null } = {}) {
        if (!Array.isArray(blocks) || blocks.length < 3) {
            return blocks;
        }

        const nextBlocks = blocks.map((block) => cloneStructuredValue(block));
        let changed = false;

        for (let index = 0; index < nextBlocks.length; index++) {
            const block = nextBlocks[index];
            const type = canonicalizeBlockType(block?.type || '');
            if (type !== 'text') {
                continue;
            }

            const text = extractBlockDefinitionText(block).replace(/\s+/g, ' ').trim();
            if (!text) {
                continue;
            }

            const labelBodyMatch = text.match(/^([^:]{2,48}):\s+(.+)$/);
            if (labelBodyMatch && shouldSplitInlineSectionLabel(labelBodyMatch[1], labelBodyMatch[2])) {
                nextBlocks.splice(index, 1,
                    {
                        type: 'heading_3',
                        content: labelBodyMatch[1].trim(),
                        textColor: preset?.sectionTextColor || null,
                    },
                    {
                        type: 'text',
                        content: labelBodyMatch[2].trim(),
                    });
                changed = true;
                index += 1;
                continue;
            }

            const nextType = canonicalizeBlockType(nextBlocks[index + 1]?.type || '');
            if (looksLikeCompactSectionLabel(text)
                && ['text', 'quote', 'bulleted_list', 'numbered_list', 'todo', 'toggle', 'database', 'bookmark'].includes(nextType)
                && !/^heading_/.test(canonicalizeBlockType(nextBlocks[index - 1]?.type || ''))) {
                nextBlocks[index] = {
                    ...nextBlocks[index],
                    type: 'heading_3',
                    content: text.replace(/:\s*$/, ''),
                    textColor: nextBlocks[index].textColor || preset?.sectionTextColor || null,
                };
                changed = true;
            }
        }

        return changed ? nextBlocks : blocks;
    }

    function applyTemplateDesignDecorations(blocks = [], { preset = null } = {}) {
        if (!Array.isArray(blocks) || blocks.length === 0) {
            return blocks;
        }

        return blocks.map((block) => {
            if (!block || typeof block !== 'object') {
                return block;
            }

            const nextBlock = cloneStructuredValue(block);
            const type = canonicalizeBlockType(nextBlock.type || 'text');
            const text = extractBlockDefinitionText(nextBlock).trim();

            if (type === 'callout' && !nextBlock.color && preset?.calloutColor) {
                nextBlock.color = preset.calloutColor;
            }

            if ((type === 'heading_2' || type === 'heading_3') && !nextBlock.textColor) {
                nextBlock.textColor = looksLikeSupportingSection(text)
                    ? (preset?.supportingTextColor || 'gray')
                    : (preset?.sectionTextColor || null);
            }

            if ((type === 'text' || type === 'quote' || type === 'toggle') && !nextBlock.textColor && looksLikeSupportingSection(text)) {
                nextBlock.textColor = preset?.supportingTextColor || 'gray';
            }

            if (type === 'toggle' && !nextBlock.color && looksLikeSupportingSection(text)) {
                nextBlock.color = 'gray';
            }

            return nextBlock;
        });
    }

    function applyTemplatePageMetadata(action = null, { template = null, preset = null, context = null, question = '' } = {}) {
        if (!action || typeof action !== 'object') {
            return action;
        }

        const nextAction = {
            ...action,
        };
        const wantsDesignedPage = /\b(design|designed|polished|beautiful|styled|visual|notion|notion-like|dashboard|brief|report)\b/i.test(String(question || ''));
        const existingProperties = Array.isArray(context?.properties) ? context.properties : [];
        const suggestedProperties = buildTemplateMetadataSuggestions(template?.id || 'brief');

        if (!nextAction.icon && (!hasMeaningfulPageIcon(context) || wantsDesignedPage) && preset?.pageIcon) {
            nextAction.icon = preset.pageIcon;
        }

        if ((!Array.isArray(nextAction.properties) || nextAction.properties.length === 0)
            && suggestedProperties.length > 0
            && (existingProperties.length === 0 || wantsDesignedPage)) {
            nextAction.properties = suggestedProperties;
        }

        if (!nextAction.cover && !context?.hasCover) {
            const coverUrl = inferCoverUrlFromBlocks(nextAction.blocks);
            if (coverUrl) {
                nextAction.cover = coverUrl;
            }
        }

        return nextAction;
    }

    function extractSourceBookmarksFromToolEvents(toolEvents = []) {
        if (!Array.isArray(toolEvents) || toolEvents.length === 0) {
            return [];
        }

        const searchMetaByUrl = new Map();
        toolEvents.forEach((event) => {
            const toolId = event?.result?.toolId || event?.toolCall?.function?.name || '';
            if (toolId !== 'web-search' || event?.result?.success === false) {
                return;
            }

            const results = Array.isArray(event?.result?.data?.results) ? event.result.data.results : [];
            results.forEach((entry) => {
                const url = String(entry?.url || '').trim();
                if (!/^https?:\/\//i.test(url) || searchMetaByUrl.has(url)) {
                    return;
                }

                searchMetaByUrl.set(url, {
                    title: String(entry?.title || '').trim(),
                    description: truncateStructuredSummary(String(entry?.snippet || '').replace(/\s+/g, ' ').trim(), 180),
                });
            });
        });

        const seen = new Set();
        const bookmarks = [];

        toolEvents.forEach((event) => {
            const toolId = event?.result?.toolId || event?.toolCall?.function?.name || '';
            if (!['web-fetch', 'web-scrape'].includes(toolId) || event?.result?.success === false) {
                return;
            }

            const args = parseToolArguments(event?.toolCall?.function?.arguments);
            const data = event?.result?.data || {};
            const url = String(data.url || args.url || '').trim();
            if (!/^https?:\/\//i.test(url) || seen.has(url)) {
                return;
            }

            const searchMeta = searchMetaByUrl.get(url) || {};
            const rawExcerpt = toolId === 'web-fetch'
                ? stripHtmlToPlainText(data.body || '')
                : stripHtmlToPlainText(data.content || data.text || JSON.stringify(data.data || ''));

            bookmarks.push({
                url,
                title: String(data.title || searchMeta.title || '').trim(),
                description: truncateStructuredSummary(searchMeta.description || rawExcerpt, 180),
            });
            seen.add(url);
        });

        if (bookmarks.length < 3) {
            for (const [url, meta] of searchMetaByUrl.entries()) {
                if (seen.has(url)) {
                    continue;
                }

                bookmarks.push({
                    url,
                    title: meta.title || '',
                    description: meta.description || '',
                });
                seen.add(url);

                if (bookmarks.length >= 3) {
                    break;
                }
            }
        }

        return bookmarks
            .filter((bookmark) => bookmark.url)
            .slice(0, 3);
    }

    function ensureSourceBookmarkBlocks(blocks = [], { preset = null, toolEvents = [] } = {}) {
        if (!Array.isArray(blocks) || blocks.length === 0) {
            return blocks;
        }

        const stats = analyzeStructuredBlocks(blocks);
        if (stats.typeCounts.bookmark > 0) {
            return blocks;
        }

        const bookmarks = extractSourceBookmarksFromToolEvents(toolEvents);
        if (!bookmarks.length) {
            return blocks;
        }

        const nextBlocks = blocks.map((block) => cloneStructuredValue(block));
        const bookmarkBlocks = bookmarks.map((bookmark) => ({
            type: 'bookmark',
            content: {
                url: bookmark.url,
                title: bookmark.title || bookmark.url,
                description: bookmark.description || '',
                favicon: '',
                image: '',
            },
        }));

        const sourceHeadingIndex = nextBlocks.findIndex((block) => {
            const type = canonicalizeBlockType(block?.type || '');
            return /^heading_/.test(type) && looksLikeSourceHeadingText(extractBlockDefinitionText(block));
        });

        if (sourceHeadingIndex >= 0) {
            let insertionHeadingIndex = sourceHeadingIndex;
            if (sourceHeadingIndex > 0 && canonicalizeBlockType(nextBlocks[sourceHeadingIndex - 1]?.type || '') !== 'divider' && nextBlocks.length >= 7) {
                nextBlocks.splice(sourceHeadingIndex, 0, { type: 'divider', content: '' });
                insertionHeadingIndex += 1;
            }
            nextBlocks.splice(insertionHeadingIndex + 1, 0, ...bookmarkBlocks);
            return nextBlocks;
        }

        if (nextBlocks.length >= 7 && canonicalizeBlockType(nextBlocks[nextBlocks.length - 1]?.type || '') !== 'divider') {
            nextBlocks.push({ type: 'divider', content: '' });
        }

        nextBlocks.push({
            type: 'heading_2',
            content: preset?.sourceHeading || 'Sources',
        });
        nextBlocks.push(...bookmarkBlocks);
        return nextBlocks;
    }

    function shouldApplyStructuredDesignUpgrade(blocks = [], { question = '', template = null } = {}) {
        if (!Array.isArray(blocks) || blocks.length === 0) {
            return false;
        }

        const stats = analyzeStructuredBlocks(blocks);
        const maxPlainRun = countMaxPlainBlockRun(blocks);
        const structuralRequest = /\b(create|make|build|draft|write|turn|convert|organize|restructure|brief|report|guide|proposal|page|notes?)\b/i.test(String(question || ''));
        const substantial = stats.blockCount >= 6
            || stats.textChars >= 420
            || (stats.typeCounts.heading_2 || 0) >= 2
            || structuralRequest;

        if (!substantial) {
            return false;
        }

        switch (template?.id) {
            case 'explainer':
                return stats.typeCounts.callout === 0
                    || stats.visualSupportCount === 0
                    || stats.styledBlockCount === 0
                    || stats.typeCounts.database === 0
                    || stats.typeCounts.toggle === 0
                    || maxPlainRun >= 3
                    || stats.longTextCount > 1;
            case 'research':
                return stats.typeCounts.callout === 0
                    || stats.typeCounts.bookmark === 0
                    || stats.visualSupportCount === 0
                    || stats.styledBlockCount === 0
                    || stats.layoutSupportCount < 3
                    || maxPlainRun >= 3
                    || stats.longTextCount > 1;
            case 'project':
            case 'dashboard':
                return stats.typeCounts.callout === 0
                    || stats.styledBlockCount === 0
                    || stats.typeCounts.database === 0
                    || stats.typeCounts.todo === 0;
            case 'documentation':
                return stats.typeCounts.callout === 0
                    || stats.visualSupportCount === 0
                    || stats.styledBlockCount === 0
                    || ((stats.typeCounts.numbered_list || 0) === 0 && (stats.typeCounts.code || 0) === 0 && (stats.typeCounts.toggle || 0) === 0);
            case 'meeting':
                return stats.typeCounts.todo === 0 || stats.typeCounts.callout === 0 || stats.styledBlockCount === 0;
            default:
                return stats.typeCounts.callout === 0
                    || stats.visualSupportCount === 0
                    || stats.styledBlockCount === 0
                    || stats.layoutSupportCount < 2
                    || maxPlainRun >= 3
                    || stats.longTextCount > 1;
        }
    }

    function enhanceStructuredPageActions(actions = [], question = '', context = null, toolEvents = []) {
        if (!Array.isArray(actions) || actions.length === 0) {
            return [];
        }

        return actions.map((action) => {
            if (!action || typeof action !== 'object') {
                return action;
            }

            const op = String(action.op || '').trim().toLowerCase();
            if (!['rebuild_page', 'replace_page'].includes(op) || !Array.isArray(action.blocks) || action.blocks.length === 0) {
                return action;
            }

            if (isRawHtmlSourceOnlyBlocks(action.blocks)) {
                return action;
            }

            const generatedContext = buildPageContextFromGeneratedBlocks(action.blocks, context);
            const template = selectNotesPageTemplates(question, generatedContext, { limit: 1 })[0] || null;
            if (!shouldApplyStructuredDesignUpgrade(action.blocks, { question, template })) {
                return action;
            }

            const preset = resolveTemplateDesignPreset(template?.id, context);
            let nextBlocks = action.blocks.map((block) => cloneStructuredValue(block));
            nextBlocks = ensureTemplateCalloutBlock(nextBlocks, { template, preset, action, context, question });
            nextBlocks = ensureHeroVisualBlock(nextBlocks, { template, preset, action, context, question });
            nextBlocks = maybePromoteCompactSectionLabels(nextBlocks, { preset });
            nextBlocks = maybeConvertQuickFactsToDatabase(nextBlocks, { template });
            nextBlocks = maybeConvertWarningTextToCallout(nextBlocks, { template });
            nextBlocks = maybeConvertSupportNoteToToggle(nextBlocks, { template });
            nextBlocks = ensureLeadClusterDivider(nextBlocks, { template });
            nextBlocks = ensureSupportSectionDivider(nextBlocks, { template });
            nextBlocks = ensureSourceBookmarkBlocks(nextBlocks, { preset, toolEvents });
            nextBlocks = applyTemplateDesignDecorations(nextBlocks, { preset });

            const enhancedAction = {
                ...action,
                blocks: nextBlocks,
            };

            if (!enhancedAction.icon && preset?.pageIcon) {
                enhancedAction.icon = preset.pageIcon;
            }

            if (!enhancedAction.title) {
                const currentTitle = String(context?.title || '').trim();
                if (!currentTitle || /^untitled$/i.test(currentTitle)) {
                    const nextTitle = inferStructuredPageTitle({
                        blocks: nextBlocks,
                        action: enhancedAction,
                        context,
                        question,
                    });
                    if (nextTitle) {
                        enhancedAction.title = nextTitle;
                    }
                }
            }

            return applyTemplatePageMetadata(enhancedAction, {
                template,
                preset,
                context,
                question,
            });
        });
    }

    function getSelectionSnapshot(pageContext) {
        const selectedBlockId = window.Selection?.getSelectedBlockId?.() || null;
        const selectedText = truncateText(window.Selection?.getSelectedText?.() || '', 300);

        if (!selectedBlockId && !selectedText) {
            return {
                selectedBlockSummary: 'No block is selected.',
                selectedText: ''
            };
        }

        const selectedBlock = pageContext?.blocks?.find((block) => block.id === selectedBlockId) || null;
        const selectedBlockStyle = selectedBlock
            ? [
                selectedBlock.color ? `bg:${selectedBlock.color}` : '',
                selectedBlock.textColor ? `text:${selectedBlock.textColor}` : ''
            ].filter(Boolean).join(', ')
            : '';
        const selectedBlockSummary = selectedBlock
            ? `[${selectedBlock.id}] ${selectedBlock.type}${selectedBlockStyle ? ` {${selectedBlockStyle}}` : ''}: ${truncateText(selectedBlock.content, 220)}`
            : (selectedBlockId ? `Selected block id: ${selectedBlockId}` : 'No block is selected.');

        return {
            selectedBlockSummary,
            selectedText
        };
    }

    function buildPageSetupSummary(pageContext) {
        if (!pageContext) {
            return 'No page is currently loaded.';
        }

        const selection = getSelectionSnapshot(pageContext);
        const properties = Array.isArray(pageContext.properties) ? pageContext.properties.length : 0;
        const propertyList = Array.isArray(pageContext.properties) && pageContext.properties.length > 0
            ? pageContext.properties.map((prop) => `${prop.key}: ${prop.value}`).join(', ')
            : 'None';
        const outlineItems = pageContext.outline?.length || 0;
        const setupLines = [
            `Page title: ${pageContext.title || 'Untitled'}`,
            `Page id: ${pageContext.pageId || 'unknown'}`,
            `Page icon: ${pageContext.icon || '(none)'}`,
            `Has cover: ${pageContext.hasCover ? 'yes' : 'no'}`,
            `Block count: ${pageContext.blockCount}`,
            `Word count: ${pageContext.wordCount}`,
            `Reading time: ${pageContext.readingTime} min`,
            `Default model: ${pageContext.defaultModel || state.selectedModel}`,
            `Outline headings: ${outlineItems}`,
            `Properties: ${properties}`,
            `Property values: ${propertyList}`,
            `Last updated: ${formatTimestamp(pageContext.lastUpdated)}`,
            `Selection: ${selection.selectedBlockSummary}`,
            `Supported text colors: default, ${NOTES_COLOR_OPTIONS.join(', ')}`,
            `Supported block background colors: default, ${NOTES_COLOR_OPTIONS.join(', ')}`,
        ];

        if (selection.selectedText) {
            setupLines.push(`Selected text: ${selection.selectedText}`);
        }

        return setupLines.join('\n');
    }

    function inferPageReasoningModes(question = '', pageContext = null) {
        const normalized = String(question || '').trim().toLowerCase();
        const modes = [];

        if (/\b(color|colour|color-code|colour-code|palette|visual tag|highlight|stage color|status color)\b/.test(normalized)) {
            modes.push('color_coding');
        }

        if (/\b(mermaid|diagram|flowchart|sequence chart|sequence diagram|chart sequence|node|edge|participant)\b/.test(normalized)) {
            modes.push('mermaid_alignment');
        }

        if (/\b(cross[- ]?reference|xref|related|relationship|connect|linked|elsewhere|same concept|references?)\b/.test(normalized)) {
            modes.push('cross_reference');
        }

        if (/\b(layout|page setup|structure|organize|sequence|order|stages?|steps?|flow|where blocks|where sections)\b/.test(normalized)) {
            modes.push('layout_reasoning');
        }

        if ((pageContext?.projections?.pageMap?.summary?.crossReferenceCount || 0) > 0 && modes.length === 0) {
            modes.push('page_map_available');
        }

        return Array.from(new Set(modes));
    }

    function buildPageReasoningGuidance(question = '', pageContext = null) {
        const pageMap = pageContext?.projections?.pageMap || pageContext?.reasoningMap || null;
        const modes = inferPageReasoningModes(question, pageContext);
        const summary = pageMap?.summary || {};
        const lines = [
            `Reasoning modes for this request: ${modes.length ? modes.join(', ') : 'general_page_context'}`,
            `Derived map: ${summary.sectionCount || 0} layout regions, ${summary.mermaidCount || 0} Mermaid block(s), ${summary.mermaidStepCount || 0} Mermaid step(s), ${summary.crossReferenceCount || 0} cross-reference candidates.`,
            '- Before editing layout, identify the relevant heading section, its block range, and any related blocks elsewhere in the page.',
            '- When the user asks where information belongs, compare layout regions, related clusters, Mermaid matches, and current block styles before deciding the target block IDs.',
            '- When adding new information, place it beside the most related section or block rather than appending it to the end by default.',
        ];

        if (modes.includes('mermaid_alignment')) {
            lines.push('- For Mermaid work, inspect the Mermaid steps and their relatedBlockIds. Keep the Mermaid block and the matching page blocks synchronized when the user asks for diagram/page consistency.');
        }

        if (modes.includes('color_coding')) {
            lines.push('- For color-coding by sequence, use colorCodingHints as the starting palette. Apply the same color meaning to the Mermaid step, its matched heading/callout/todo/list blocks, and any repeated concept highlights.');
            lines.push('- Use update_block color/textColor for whole-block sequence tags and highlight_text only for exact terms inside a text-like block.');
        }

        if (modes.includes('cross_reference')) {
            lines.push('- For cross-references, use relatedClusters and crossReferences to find existing blocks that talk about the same concept before creating duplicate explanations.');
            lines.push('- If a new block summarizes related material, name the source block IDs in your hidden planning and place the summary near the strongest anchor section.');
        }

        if (modes.includes('layout_reasoning')) {
            lines.push('- For layout reasoning, treat the page as a designed sequence: lead cluster, major sections, support/detail clusters, then closeout. Reorder or restyle section anchors instead of rebuilding unrelated sections.');
        }

        return lines.join('\n');
    }

    function normalizePageReferences(references = []) {
        if (!Array.isArray(references)) return [];
        const seen = new Set();

        return references
            .map((reference) => {
                if (!reference || typeof reference !== 'object') return null;
                const pageId = String(reference.pageId || reference.id || '').trim();
                if (!pageId || seen.has(pageId)) return null;
                seen.add(pageId);
                const type = reference.type === 'chat' ? 'chat' : 'page';

                return {
                    pageId,
                    sourcePageId: normalizeInlineText(reference.sourcePageId || ''),
                    type,
                    hasChat: Boolean(reference.hasChat || reference.chatPreview || reference.chatPageId || reference.chatSourcePageId),
                    chatPageId: normalizeInlineText(reference.chatPageId || ''),
                    chatSourcePageId: normalizeInlineText(reference.chatSourcePageId || ''),
                    chatPreview: truncateText(reference.chatPreview || '', 420),
                    chatMessageCount: Number(reference.chatMessageCount || 0) || 0,
                    title: normalizeInlineText(reference.title || 'Untitled') || 'Untitled',
                    icon: normalizeInlineText(reference.icon || (type === 'chat' ? 'Chat' : 'Page')) || (type === 'chat' ? 'Chat' : 'Page'),
                    spaceId: normalizeInlineText(reference.spaceId || ''),
                    spaceName: normalizeInlineText(reference.spaceName || 'Private') || 'Private',
                    preview: truncateText(reference.preview || '', 320),
                    outline: Array.isArray(reference.outline)
                        ? reference.outline.map((item) => normalizeInlineText(item)).filter(Boolean).slice(0, 8)
                        : [],
                    blockCount: Number(reference.blockCount || 0) || 0,
                    updatedAt: normalizeInlineText(reference.updatedAt || ''),
                };
            })
            .filter(Boolean)
            .slice(0, 6);
    }

    function normalizeReferenceSearchPayload(payload = null) {
        if (!payload || typeof payload !== 'object') {
            return { query: '', policy: 'snippet_search_only', hits: [] };
        }

        const hits = Array.isArray(payload.hits)
            ? payload.hits
                .map((hit) => {
                    if (!hit || typeof hit !== 'object') return null;
                    const pageId = String(hit.pageId || hit.id || '').trim();
                    if (!pageId) return null;
                    const type = hit.type === 'chat' ? 'chat' : 'page';

                    return {
                        pageId,
                        sourcePageId: normalizeInlineText(hit.sourcePageId || ''),
                        type,
                        hasChat: Boolean(hit.hasChat || hit.chatSnippet || hit.chatPageId || hit.chatSourcePageId),
                        chatPageId: normalizeInlineText(hit.chatPageId || ''),
                        chatSourcePageId: normalizeInlineText(hit.chatSourcePageId || ''),
                        chatSnippet: truncateText(hit.chatSnippet || '', 420),
                        chatMessageCount: Number(hit.chatMessageCount || 0) || 0,
                        title: normalizeInlineText(hit.title || 'Untitled') || 'Untitled',
                        icon: normalizeInlineText(hit.icon || (type === 'chat' ? 'Chat' : 'Page')) || (type === 'chat' ? 'Chat' : 'Page'),
                        spaceName: normalizeInlineText(hit.spaceName || 'Private') || 'Private',
                        outline: Array.isArray(hit.outline)
                            ? hit.outline.map((item) => normalizeInlineText(item)).filter(Boolean).slice(0, 6)
                            : [],
                        snippet: truncateText(hit.snippet || '', 360),
                        score: Number(hit.score || 0) || 0,
                        selected: Boolean(hit.selected),
                    };
                })
                .filter(Boolean)
                .slice(0, 10)
            : [];

        return {
            query: normalizeInlineText(payload.query || ''),
            policy: normalizeInlineText(payload.policy || 'snippet_search_only') || 'snippet_search_only',
            hits,
        };
    }

    function getNotesStorageModule() {
        if (window.NotesStorage?.loadAll) {
            return window.NotesStorage;
        }

        try {
            if (typeof Storage !== 'undefined' && Storage?.loadAll) {
                return Storage;
            }
        } catch (_error) {
            // The browser-native window.Storage object is not the notes database.
        }

        return window.Storage?.loadAll ? window.Storage : null;
    }

    function getReferencedPageById(pageId = '') {
        const normalizedPageId = String(pageId || '').trim();
        if (!normalizedPageId) return null;

        const currentPage = window.Editor?.getCurrentPage?.();
        if (currentPage?.id === normalizedPageId) {
            return currentPage;
        }

        return getNotesStorageModule()?.getPage?.(normalizedPageId) || null;
    }

    function getReferencedChatSourcePageId(reference = {}) {
        const sourcePageId = String(reference.chatSourcePageId || reference.sourcePageId || '').trim();
        if (sourcePageId) return sourcePageId;

        const chatPageId = String(reference.chatPageId || '').trim();
        if (chatPageId.startsWith('chat:')) {
            const stripped = chatPageId.slice(5).trim();
            return stripped === 'legacy' ? '' : stripped;
        }

        const pageId = String(reference.pageId || '').trim();
        if (pageId.startsWith('chat:')) {
            const stripped = pageId.slice(5).trim();
            return stripped === 'legacy' ? '' : stripped;
        }

        if (reference.hasChat && pageId) return pageId;

        return '';
    }

    function buildExpandedChatContext(reference = {}) {
        const sourcePageId = getReferencedChatSourcePageId(reference);
        const messages = readStoredMessages(sourcePageId || null)
            .map((message) => {
                if (!message || typeof message !== 'object') return null;
                const role = normalizeInlineText(message.role || 'message') || 'message';
                const content = truncateText(
                    message.content || message.text || message.message || message.reasoningSummary || '',
                    900,
                );
                if (!content) return null;
                return { role, content };
            })
            .filter(Boolean)
            .slice(-40);

        if (!messages.length) return null;

        const lines = [
            `Chat: ${reference.title || 'Referenced chat'} [pageId=${reference.pageId || 'chat:legacy'}]`,
            `Source pageId: ${sourcePageId || 'legacy chat'}`,
            `Messages included: ${messages.length}`,
            'Conversation excerpt:',
            ...messages.map((message, index) => `${index + 1}. ${message.role}: ${message.content}`),
        ];

        return lines.join('\n').slice(0, 6000);
    }

    function shouldExpandReferenceContext(question = '', references = [], referenceSearch = null) {
        if (!references.length) return false;
        const normalized = normalizeInlineText(question).toLowerCase();
        if (!normalized) return false;

        const deepUseIntent = /\b(compare|contrast|summari[sz]e|synthesi[sz]e|extract|audit|review|rewrite|revise|merge|combine|connect|cross[-\s]?reference|pull|full context|whole page|entire page|all context|details from)\b/.test(normalized)
            || /\b(?:use|based on|from)\s+(?:the\s+)?(?:attached|referenced|reference|linked)\b/.test(normalized);
        if (deepUseIntent) return true;

        const selectedHits = (referenceSearch?.hits || []).filter((hit) => hit.selected && hit.score >= 8);
        return selectedHits.length > 0
            && /\b(reference|referenced|attached|linked|that page|those pages|this page|the page|that note|those notes|the plan)\b/.test(normalized);
    }

    function buildReferencedPagePromptSection(question = '', references = [], referenceSearch = null) {
        const normalizedReferences = normalizePageReferences(references);
        const normalizedSearch = normalizeReferenceSearchPayload(referenceSearch);
        if (!normalizedReferences.length && !normalizedSearch.hits.length) {
            return 'No additional referenced notes pages were attached. Use only the current page context.';
        }

        const lines = [
            'Reference policy:',
            '- Cross-page and chat context starts as snippets and outlines only, so unrelated private page content or full chat histories are not exposed by default.',
            '- If EXPANDED REFERENCED PAGE CONTEXT appears below, it was included because the current request needs deeper context from an attached/relevant page.',
            '- Do not claim you reviewed a full referenced page or full chat history unless that full context explicitly appears below.',
            '- When useful, cite referenced pages or chats by title and pageId, and keep current-page edits scoped to the active page unless the user asks to navigate or rewrite another page.',
        ];

        if (normalizedReferences.length) {
            lines.push('', 'Attached note/chat references:');
            normalizedReferences.forEach((reference, index) => {
                const kind = reference.type === 'chat' ? 'chat snippet' : 'page';
                const countLabel = reference.type === 'chat' ? 'messages' : 'blocks';
                lines.push(`${index + 1}. ${reference.icon} ${reference.title} [pageId=${reference.pageId}] [type=${kind}]`);
                lines.push(`   Space: ${reference.spaceName}; ${countLabel}: ${reference.blockCount}; updated: ${reference.updatedAt || 'unknown'}`);
                if (reference.sourcePageId) {
                    lines.push(`   Source pageId: ${reference.sourcePageId}`);
                }
                if (reference.outline.length) {
                    lines.push(`   Outline: ${reference.outline.join(' > ')}`);
                }
                if (reference.preview) {
                    lines.push(`   Preview: ${reference.preview}`);
                }
                if (reference.hasChat && reference.chatPreview) {
                    lines.push(`   Attached chat preview (${reference.chatMessageCount || 'unknown'} messages): ${reference.chatPreview}`);
                }
            });
        }

        if (normalizedSearch.hits.length) {
            lines.push('', `Workspace note/chat search hits (${normalizedSearch.policy}; query="${normalizedSearch.query || 'prompt terms'}"):`);
            normalizedSearch.hits.forEach((hit, index) => {
                const kind = hit.type === 'chat' ? 'chat snippet' : 'page';
                lines.push(`${index + 1}. ${hit.icon} ${hit.title} [pageId=${hit.pageId}] [type=${kind}]${hit.selected ? ' [attached]' : ''}`);
                lines.push(`   Space: ${hit.spaceName}; score: ${hit.score}`);
                if (hit.sourcePageId) {
                    lines.push(`   Source pageId: ${hit.sourcePageId}`);
                }
                if (hit.outline.length) {
                    lines.push(`   Outline: ${hit.outline.join(' > ')}`);
                }
                if (hit.snippet) {
                    lines.push(`   Snippet: ${hit.snippet}`);
                }
                if (hit.hasChat && hit.chatSnippet) {
                    lines.push(`   Attached chat snippet (${hit.chatMessageCount || 'unknown'} messages): ${hit.chatSnippet}`);
                }
            });
        }

        if (shouldExpandReferenceContext(question, normalizedReferences, normalizedSearch)) {
            const selectedIds = new Set(normalizedReferences
                .filter((reference) => reference.type !== 'chat')
                .map((reference) => reference.pageId));
            const hitIds = normalizedSearch.hits
                .filter((hit) => hit.type !== 'chat' && (hit.selected || hit.score >= 10))
                .map((hit) => hit.pageId);
            const expandIds = Array.from(new Set([...selectedIds, ...hitIds])).slice(0, 2);

            const expanded = expandIds
                .map((pageId) => {
                    const page = getReferencedPageById(pageId);
                    if (!page) return null;
                    const context = window.NotesQuery?.buildPageContext
                        ? window.NotesQuery.buildPageContext(page, {
                            maxReferences: 28,
                            maxClusters: 8,
                            maxSentences: 36,
                        })
                        : null;
                    const content = context
                        ? buildFullPageContentFromContext(context)
                        : getNotesStorageModule()?.exportToMarkdown?.(pageId);
                    const outline = context?.outline?.length
                        ? context.outline.map((entry) => `- [${entry.id}] ${entry.content}`).join('\n')
                        : '- No headings found';

                    return [
                        `Page: ${page.title || 'Untitled'} [pageId=${page.id}]`,
                        `Stats: ${context?.blockCount || page.blocks?.length || 0} blocks, ${context?.wordCount || 0} words`,
                        'Outline:',
                        outline,
                        'Content excerpt:',
                        String(content || '').slice(0, 5000),
                    ].join('\n');
                })
                .filter(Boolean);

            if (expanded.length) {
                lines.push('', 'EXPANDED REFERENCED PAGE CONTEXT:');
                lines.push(expanded.join('\n\n---\n\n'));
            }

            const expandedChats = normalizedReferences
                .filter((reference) => reference.type === 'chat' || reference.hasChat)
                .slice(0, 2)
                .map(buildExpandedChatContext)
                .filter(Boolean);

            if (expandedChats.length) {
                lines.push('', 'EXPANDED REFERENCED CHAT CONTEXT:');
                lines.push(expandedChats.join('\n\n---\n\n'));
            }
        }

        return lines.join('\n');
    }

    // Build system prompt with page context
    function buildSystemPrompt(pageContext, requestContext = {}) {
        const question = String(requestContext?.question || '').trim();
        const agentProfile = requestContext?.agentProfile || getSelectedAgentProfile();
        const agentProfileGuidance = buildAgentProfilePromptGuidance(agentProfile);
        const referencedPages = buildReferencedPagePromptSection(
            question,
            requestContext?.pageReferences || [],
            requestContext?.referenceSearch || null,
        );
        const templateMatches = selectNotesPageTemplates(question, pageContext, { limit: 2 });
        const pageSetup = buildPageSetupSummary(pageContext);
        const blockMap = buildPageContentSnapshot(pageContext);
        const agentLayerSnapshot = pageContext?.projections?.agentContext
            ? JSON.stringify(pageContext.projections.agentContext, null, 2).slice(0, 8000)
            : '';
        const styleLayerSnapshot = pageContext?.projections?.styles
            ? JSON.stringify(pageContext.projections.styles, null, 2).slice(0, 5000)
            : '';
        const sentenceLayerSnapshot = pageContext?.projections?.sentences
            ? JSON.stringify(pageContext.projections.sentences, null, 2).slice(0, 5000)
            : '';
        const pageReasoningMapSnapshot = pageContext?.projections?.pageMap
            ? JSON.stringify(pageContext.projections.pageMap, null, 2).slice(0, 9000)
            : '';
        const pageContent = buildFullPageContentFromContext(pageContext).slice(0, 6000);
        const topLevelLayout = buildTopLevelLayoutSnapshot(pageContext);
        const sectionEditMap = buildSectionEditMap(pageContext);
        const visualAnchors = buildVisualAnchorSnapshot(pageContext);
        const pageReasoningGuidance = buildPageReasoningGuidance(question, pageContext);
        const pageEditWorkflow = buildPageEditWorkflowGuidance(question, pageContext);
        const editResponsePatterns = buildEditResponsePatterns(pageContext);
        const blockOpportunities = buildBlockOpportunityGuidance(question, pageContext, templateMatches);
        const designManual = buildNotesPageDesignManual();
        const templateChecklist = buildTemplateExecutionChecklist(templateMatches);
        const visualRecipeGuidance = buildVisualRecipeGuidance(question, pageContext, templateMatches);
        const visualRecipeChecklist = buildVisualRecipeChecklist(question, pageContext, templateMatches);
        const designSchemeGuidance = buildDesignSchemeGuidance(question, pageContext, templateMatches);
        const designSchemeChecklist = buildDesignSchemeChecklist(question, pageContext, templateMatches);
        const blockPatternGuidance = buildBlockDesignPatternGuidance(question, pageContext, templateMatches);
        const blockPatternChecklist = buildBlockDesignPatternChecklist(question, pageContext, templateMatches);
        const symphonyUnderstanding = buildSymphonyUnderstandingGuidance(question, pageContext, templateMatches);
        const designCriteria = [
            buildPageDesignCriteria(pageContext),
            ...templateMatches.flatMap((template) => template.designRules.map((rule) => `- Template cue (${template.name}): ${rule}`)),
        ].filter(Boolean).join('\n');
        const templateGuidance = buildTemplateGuidance(question, pageContext, templateMatches);
        const outline = pageContext?.outline?.length
            ? pageContext.outline.map((heading) => `- [${heading.id}] ${heading.content}`).join('\n')
            : '- No headings yet';

        return `You are an AI assistant editing a Lilly-style block-based document.

CURRENT PAGE: "${pageContext?.title || 'Untitled'}"

ACTIVE BUDDY PROFILE:
${agentProfileGuidance}

PAGE STRUCTURE:
The document is organized into blocks. Each block has a unique ID shown in brackets like [block_abc123].
Reference blocks by their ID when editing or inserting content.

BLOCKS IN THIS PAGE:
${blockMap || '(page is empty)'}

AGENT QUERY LAYERS:
Use the smallest useful layer. Prefer block IDs from the outline, sections, style table, or a grep result instead of rewriting the full page.
- flat_text: read only text content in document order
- outline: read heading blocks and section anchors
- sections: read section heading IDs and their block ranges
- styles: read block color, text color, font family, and font size
- grep: limit visible blocks by word, block type, section, color, textColor, or block ID
- sentence_index: search sentence-sized spans with block IDs and exact sentence text for precise highlighting or replacement
- page_map: read layout regions, Mermaid steps, repeated concepts, cross-references, and color-coding hints
- mermaid_sequences: read Mermaid blocks as ordered steps with related page block candidates

COMPACT AGENT SNAPSHOT:
${agentLayerSnapshot || '(no query projection available)'}

STYLE LAYER SNAPSHOT:
${styleLayerSnapshot || '(no style projection available)'}

SENTENCE SEARCH SNAPSHOT:
${sentenceLayerSnapshot || '(no sentence projection available)'}

PAGE REASONING MAP:
${pageReasoningMapSnapshot || '(no page reasoning map available)'}

PAGE REASONING RULES:
${pageReasoningGuidance}

TOP-LEVEL LAYOUT:
${topLevelLayout}

SECTION EDIT MAP:
A section target starts at a heading block ID and includes that heading plus every following block until the next same-or-higher heading.
${sectionEditMap}

OUTLINE (Headings):
${outline}

CURRENT PAGE CONTENT (excerpt):
${pageContent || '(page is empty)'}

REFERENCED NOTES PAGES:
${referencedPages}

PAGE STATS:
${pageSetup}

ROUTING PRIORITY:
- If the user is asking to build, fill, rewrite, reorganize, or polish the current notes page, prefer notes-actions that update the page blocks instead of artifact, file, or export output.
- Only switch to artifact, download, export, link, or standalone-file behavior when the user explicitly asks for that delivery mode.
- Supporting research is allowed only to improve the page; it should not replace page edits.

SYMPHONY REQUEST UNDERSTANDING:
${symphonyUnderstanding}

CURRENT VISUAL ANCHORS:
${visualAnchors}

BEST-FIT PAGE TEMPLATES:
${templateGuidance}

VISUAL PAGE RECIPES:
${visualRecipeGuidance}

DESIGN SCHEMES:
${designSchemeGuidance}

LIVE BLOCK DESIGN PATTERNS:
${blockPatternGuidance}

PAGE DESIGN MANUAL:
${designManual}

INDEXED DESIGN LAYOUT CATALOG:
${buildIndexedLayoutCatalogGuidance()}

BLOCK OPPORTUNITIES FOR THIS REQUEST:
${blockOpportunities}

TEMPLATE EXECUTION CHECKLIST:
${templateChecklist}

VISUAL DESIGN CHECKLIST:
${visualRecipeChecklist}

DESIGN SCHEME CHECKLIST:
${designSchemeChecklist}

BLOCK PATTERN CHECKLIST:
${blockPatternChecklist}

PAGE DESIGN CRITERIA:
${designCriteria}

PAGE EDIT WORKFLOW:
${pageEditWorkflow}

EDIT RESPONSE PATTERNS:
${editResponsePatterns}

AVAILABLE ACTIONS - Respond with JSON:
When the user asks you to edit, create, delete, or reorganize content, respond with a JSON action block like this:

\`\`\`notes-actions
{
  "assistant_reply": "Brief, friendly explanation of what I did",
  "actions": [
    { "op": "update_page", "title": "Research Brief", "icon": "🔎" },
    { "op": "update_block", "blockId": "block_abc123", "type": "text", "content": "New content here" },
    { "op": "replace_text", "blockId": "block_abc123", "findText": "old phrase", "replaceWith": "new phrase", "replaceAll": false },
    { "op": "highlight_text", "blockId": "block_abc123", "text": "important phrase", "color": "yellow" },
    { "op": "highlight_text", "blockId": "block_abc123", "sentenceQuery": "phrase in the sentence", "scope": "sentence", "color": "blue" },
    { "op": "update_block", "blockId": "block_heading123", "type": "heading_3", "content": "Existing heading text" },
    { "op": "update_block", "blockId": "block_heading456", "type": "heading_2", "content": "Existing heading text", "textColor": "blue", "color": "gray" },
    { "op": "replace_block", "blockId": "block_abc123", "blocks": [{ "type": "heading_2", "content": "New Section" }, { "type": "text", "content": "Fresh opening" }] },
    { "op": "replace_section", "headingBlockId": "block_heading123", "blocks": [{ "type": "heading_2", "content": "Rebuilt Section" }, { "type": "text", "content": "Only this section changed." }] },
    { "op": "move_block", "blockId": "block_abc123", "targetBlockId": "block_xyz789", "position": "before" },
    { "op": "move_section", "headingBlockId": "block_heading123", "targetHeadingBlockId": "block_heading999", "position": "after" },
    { "op": "insert_after", "blockId": "block_abc123", "blocks": [{ "type": "callout", "content": { "text": "Key takeaway", "icon": "⚡" }, "color": "yellow" }] },
    { "op": "insert_here", "blockId": "block_abc123", "position": "after", "blocks": [{ "type": "text", "content": "Inserted exactly here." }] },
    { "op": "insert_after_section", "headingBlockId": "block_heading123", "blocks": [{ "type": "heading_2", "content": "New Section" }] },
    { "op": "insert_between_sections", "afterHeadingBlockId": "block_heading123", "beforeHeadingBlockId": "block_heading456", "blocks": [{ "type": "heading_2", "content": "Inserted Section" }] },
    { "op": "rebuild_page", "blocks": [{ "type": "heading_1", "content": "New Structure" }, { "type": "text", "content": "Fresh opening" }] },
    { "op": "delete_block", "blockId": "block_def456" },
    { "op": "delete_here", "headingBlockId": "block_heading123", "scope": "section" },
    { "op": "delete_section", "headingBlockId": "block_heading123" },
    { "op": "append_to_page", "blocks": [{ "type": "text", "content": "Added at end" }] }
  ]
}
\`\`\`

VALID OPERATIONS:
- update_page: Update page-level metadata like title, icon, cover, properties, or page default model
- update_block: Change content of an existing block and optionally change its type in place (requires blockId; may include type and content)
- change_block_type: Convert an existing block to another type while preserving the best available text (requires blockId and type; optional content)
- set_block_type: Alias for change_block_type
- replace_text: Replace a specific phrase inside an existing block without rewriting the whole block (requires blockId, findText or oldText, replaceWith or newText; optional replaceAll and caseSensitive)
- highlight_text: Highlight a specific phrase or sentence inside an existing text-like block (requires blockId and text, or sentenceQuery with scope "sentence"; optional color)
- replace_block: Replace block with new block(s) (requires blockId, blocks array)
- move_block: Reorder an existing block relative to another block (requires blockId, targetBlockId, optional position "before"|"after")
- replace_section: Replace a heading and all following blocks until the next same-or-higher heading (requires headingBlockId or blockId, blocks array)
- move_section: Move a whole heading section relative to another heading section (requires headingBlockId, targetHeadingBlockId, optional position "before"|"after")
- insert_here: Insert block(s) immediately before or after a named block or section anchor (requires blockId or headingBlockId, blocks array, optional position "before"|"after", optional scope "block"|"section")
- insert_after_section: Add block(s) after the complete section that starts at a heading (requires headingBlockId, blocks array)
- insert_before_section: Add block(s) before the complete section that starts at a heading (requires headingBlockId, blocks array)
- insert_between_sections: Add block(s) between two heading sections (requires afterHeadingBlockId or beforeHeadingBlockId, blocks array)
- delete_here: Delete the named block or section anchor (requires blockId or headingBlockId, optional scope "block"|"section")
- delete_section: Remove a heading and all following blocks until the next same-or-higher heading (requires headingBlockId or blockId)
- insert_after: Add new block(s) after specified block (requires blockId, blocks array)
- insert_before: Add new block(s) before specified block (requires blockId, blocks array)
- append_to_page: Add block(s) at end of page (requires blocks array)
- prepend_to_page: Add block(s) at start of page (requires blocks array)
- rebuild_page: Replace the full page body with a new block structure when a clean rebuild is better than incremental edits (requires blocks array)
- delete_block: Remove a block (requires blockId)

STRUCTURAL EDITING RULES:
- You can use every visible block in BLOCKS IN THIS PAGE and TOP-LEVEL LAYOUT, not only the final block or final row.
- On second and later page-edit requests, preserve existing content unless the user explicitly asks to replace/reset the whole page.
- For "insert here", "insert between sections", "add this after/before that", or "delete here" requests, use insert_here, insert_between_sections, insert_after_section, insert_before_section, delete_here, or delete_section instead of rebuild_page.
- When moving existing material, use move_block or move_section with the destination anchor ID; do not recreate the material at the end.
- When a block is the right content but the wrong kind, use update_block with type or change_block_type/set_block_type. Do not leave JSON or markdown markers inside a code/text block to imply the new type.
- Use change_block_type/set_block_type/update_block with type to convert a block in place. Keep the existing block ID whenever possible; do not delete and recreate the block just to change its type.
- For full-page builds, return one notes-actions payload only. Do not put the JSON payload in the visible assistant_reply, and do not add a code block containing the request at the bottom of the page.
- Keep block type names exact: text, heading_1, heading_2, heading_3, bulleted_list, numbered_list, todo, callout, quote, divider, image, ai_image, bookmark, database, chart, toggle, mermaid, code, math.

BLOCK TYPES:
- text: Plain text paragraph
- heading_1, heading_2, heading_3: Section headings
- bulleted_list and numbered_list: grouped items
- todo: checkbox item using {text, checked}
- callout: highlighted note using {text, icon}
- quote: emphasized excerpt or standout line
- divider: section separator
- image and ai_image: visual support blocks
- bookmark: linked source/reference block
- database: comparison, tracker, or quick-facts table
- chart: simple bar, line, or pie visualization for metrics
- toggle: collapsible detail section
- mermaid: diagram block
- code and math: technical support blocks

BLOCK DESIGN HEURISTICS:
- Use heading blocks to create hierarchy before adding details.
- Use callout blocks for takeaways, warnings, decisions, or highlighted facts.
- Use list, todo, database, bookmark, image, toggle, quote, divider, or mermaid blocks when they communicate the section better than another paragraph.
- Do not leave markdown markers like \`##\`, \`-\`, or \`[ ]\` inside block content when a native block type exists.
- For polished Notion-like pages, treat visual hierarchy as required work, not optional polish.

GUIDELINES:
- Always reference blocks by their exact ID in [brackets]
- assistant_reply should be brief and user-friendly
- The editor will automatically apply your actions and show the assistant_reply to the user
- Your default job in this interface is to edit the current notes page itself through block updates.
- When notes mode is active, the only supporting tools you may rely on are web-search, web-fetch, and web-scrape.
- Never print internal tool-call markup such as <|tool_calls|>, <｜DSML｜tool_calls>, invoke tags, or parameter tags in the assistant reply. If a tool is unavailable, say what is missing in plain language.
- Do not rely on document creation, artifact generation, filesystem writes, image tools, Git, deployment tools, or remote/server commands from this surface.
- Use any gathered web information only to improve the current page blocks or to answer the user in chat while planning.
- When the user asks for page changes, put the final content into page blocks instead of replying with standalone HTML, artifact info, download links, or chat-only prose.
- Only stay in planning/chat mode when the user is explicitly brainstorming, outlining, asking for options, or says not to edit the page yet.
- When the user is brainstorming or asking for layout help, offer 2-3 template directions by name, explain the block structure briefly, and then adapt the chosen direction on the page.
- In this notes interface, "page" means the current notes document unless the user explicitly says web page, site page, route, component, repo file, or server page.
- If the user says "put this on the page", "add this to the page", "insert this into the page", or similar, treat that as a request to edit the current notes page using notes-actions.
- Never satisfy a notes-page edit by writing a local repo/runtime file or by mentioning /app or filesystem write failures.
- For substantial page-writing requests such as briefs, reports, specs, plans, guides, proposals, or polished notes pages, think in three silent passes: architecture, section briefs, then final articulation into notes-actions.
- Work section by section. Decide the role of each section before writing it, and treat the lead cluster as its own designed editing job.
- For large pages, make an explicit design pass first, then break the page into heading-based chunks that could be handed to independent section agents. Use section-level operations to apply each chunk from its heading down instead of repeatedly rewriting the whole page.
- When editing an existing section, target the heading ID with replace_section, insert_after_section, move_section, or delete_section so the edit covers the heading and every block beneath it up to the next same-or-higher heading.
- When the user asks to change a specific word, sentence, phrase, number, name, or small part of a block, prefer replace_text over rewriting the entire block.
- When the user asks to highlight, mark, call out, emphasize, or visually tag specific text, use highlight_text on the smallest exact phrase inside the relevant block.
- When the user asks to find or highlight a sentence, use sentence_index to pick the correct blockId and exactText. For full-sentence emphasis, use highlight_text with the full sentence text and "scope": "sentence"; if you only know a phrase, use "sentenceQuery" with "scope": "sentence".
- Choose a best-fit page template from the template guidance above and adapt it to the user's request instead of inventing the page layout from scratch every time.
- Also choose a matching visual recipe from the recipe guidance above so the page has a clear opening cluster, body rhythm, and support cluster.
- Also choose a dominant design scheme from the scheme guidance above so the page has a coherent palette and header treatment.
- Also choose 1-2 live block design patterns from the pattern guidance above so the lead, proof, notes, and closeout sections each have a reusable structure.
- When building a full page, prefer a clear structure with headings first and then supporting blocks under each heading instead of one long undifferentiated dump.
- For non-trivial page builds, returns should usually involve multiple blocks with hierarchy, not a single oversized text block.
- If a generated text block would carry multiple sections, multiple ideas, or more than a short paragraph, split it into separate blocks before returning notes-actions.
- Prefer structural edits over append-only edits when the page needs organization: use update_block to convert block types, replace_block to rebuild a section, move_block to reorder sections, and rebuild_page when the current layout should be replaced wholesale.
- It is acceptable to replace a single block with multiple blocks, or to rebuild the full page, if that is the clearest way to satisfy the request.
- Do not ship a substantial page as only heading + text + list blocks unless the user explicitly asked for a minimal/plain layout.
- Research pages should usually use at least one richer support block such as callout, bookmark, image, ai_image, toggle, or database when the content supports it.
- In notes, Mermaid usually belongs as a mermaid block inside the page. Do not switch to a downloadable Mermaid artifact unless the user explicitly asks for a file, export, download, or shareable artifact.
- Use plain strings for text-like blocks and structured objects for todo, callout, code, math, mermaid, image, ai_image, bookmark, database, chart, and ai blocks.
- For existing database blocks, use update_database with {blockId, columns, rows} to replace the whole table in one logical write, or {blockId, appendRows} to add many rows at once.
- Use fill_database_column with {blockId, column or columnIndex, start, end} for rating/score fills such as 1-5, or {values:[...]} for custom mass fills.
- Database columns must be useful labels, not placeholders; keep row cell counts aligned with columns.
- You may include formatting on text-like blocks using {bold, italic, underline, strikethrough, code}.
- You may include children on blocks when nested content improves the page, especially under toggles.
- You may include fontFamily on blocks using: ${NOTES_FONT_FAMILY_OPTIONS.join(', ')}.
- You may include fontSize on blocks using: ${NOTES_FONT_SIZE_OPTIONS.join(', ')}.
- You may include fontWeight on blocks using: ${NOTES_FONT_WEIGHT_OPTIONS.join(', ')}.
- You may include textAlign on text-like blocks using: ${NOTES_TEXT_ALIGN_OPTIONS.join(', ')}.
- highlight_text supports these highlight colors: ${NOTES_HIGHLIGHT_COLOR_OPTIONS.join(', ')}.
- Do not invent block IDs - only use IDs that exist in the page
- Keep assistant_reply concise unless the user asks for detailed explanation
- When the user asks for a redesign, dashboard, brief, report, or polished layout, consider updating the page title, icon, or cover with update_page in addition to the blocks.
- If the user asks for color or visual design, explicitly consider block background colors ("color"), text colors ("textColor"), highlight colors, and per-block typography where they improve readability.
- When improving layout or variety, prefer mixing headings, callouts, quotes, lists, databases, images, dividers, and tasteful color/textColor choices instead of only plain paragraphs`;

        return `You are an AI assistant editing a Lilly-style block-based document.

CURRENT PAGE: "${pageContext?.title || 'Untitled'}"

PAGE STRUCTURE:
The document is organized into blocks. Each block has a unique ID shown in brackets like [block_abc123].
Reference blocks by their ID when editing or inserting content.

BLOCKS IN THIS PAGE:
${blockMap || '(page is empty)'}

TOP-LEVEL LAYOUT:
${topLevelLayout}

OUTLINE (Headings):
${outline}

CURRENT PAGE CONTENT (excerpt):
${pageContent || '(page is empty)'}

PAGE STATS:
${pageSetup}

ROUTING PRIORITY:
- If the user is asking to build, fill, rewrite, reorganize, or polish the current notes page, prefer notes-actions that update the page blocks instead of artifact, file, or export output.
- Only switch to artifact, download, export, link, or standalone-file behavior when the user explicitly asks for that delivery mode.
- Supporting research is allowed only to improve the page; it should not replace page edits.

SYMPHONY REQUEST UNDERSTANDING:
${symphonyUnderstanding}

CURRENT VISUAL ANCHORS:
${visualAnchors}

BEST-FIT PAGE TEMPLATES:
${templateGuidance}

VISUAL PAGE RECIPES:
${visualRecipeGuidance}

DESIGN SCHEMES:
${designSchemeGuidance}

PAGE DESIGN MANUAL:
${designManual}

INDEXED DESIGN LAYOUT CATALOG:
${buildIndexedLayoutCatalogGuidance()}

BLOCK OPPORTUNITIES FOR THIS REQUEST:
${blockOpportunities}

TEMPLATE EXECUTION CHECKLIST:
${templateChecklist}

VISUAL DESIGN CHECKLIST:
${visualRecipeChecklist}

DESIGN SCHEME CHECKLIST:
${designSchemeChecklist}

PAGE DESIGN CRITERIA:
${designCriteria}

AVAILABLE ACTIONS - Respond with JSON:
When the user asks you to edit, create, delete, or reorganize content, respond with a JSON action block like this:

\`\`\`notes-actions
{
  "assistant_reply": "Brief, friendly explanation of what I did",
  "actions": [
    { "op": "update_page", "title": "Middle East Overnight Brief", "icon": "🌍" },
    { "op": "update_block", "blockId": "block_abc123", "type": "text", "content": "New content here" },
    { "op": "move_block", "blockId": "block_abc123", "targetBlockId": "block_xyz789", "position": "before" },
    { "op": "insert_after", "blockId": "block_abc123", "blocks": [{ "type": "heading_2", "content": "New Section" }] },
    { "op": "insert_here", "headingBlockId": "block_heading123", "scope": "section", "position": "after", "blocks": [{ "type": "heading_2", "content": "New Section" }] },
    { "op": "insert_between_sections", "afterHeadingBlockId": "block_heading123", "beforeHeadingBlockId": "block_heading456", "blocks": [{ "type": "heading_2", "content": "Inserted Section" }] },
    { "op": "rebuild_page", "blocks": [{ "type": "heading_1", "content": "New Structure" }, { "type": "text", "content": "Fresh opening" }] },
    { "op": "delete_block", "blockId": "block_def456" },
    { "op": "delete_here", "headingBlockId": "block_heading123", "scope": "section" },
    { "op": "append_to_page", "blocks": [{ "type": "text", "content": "Added at end" }] }
  ]
}
\`\`\`

VALID OPERATIONS:
- update_page: Update page-level metadata like title, icon, cover, properties, or page default model
- update_block: Change content of an existing block and optionally change its type in place (requires blockId; may include type and content)
- change_block_type: Convert an existing block to another type while preserving the best available text (requires blockId and type; optional content)
- set_block_type: Alias for change_block_type
- replace_text: Replace a specific phrase inside an existing block without rewriting the whole block (requires blockId, findText or oldText, replaceWith or newText; optional replaceAll and caseSensitive)
- highlight_text: Highlight a specific phrase inside an existing text-like block (requires blockId and text; optional color)
- replace_block: Replace block with new block(s) (requires blockId, blocks array)
- move_block: Reorder an existing block relative to another block (requires blockId, targetBlockId, optional position "before"|"after")
- insert_here: Insert block(s) immediately before or after a named block or section anchor (requires blockId or headingBlockId, blocks array, optional position "before"|"after", optional scope "block"|"section")
- insert_after_section: Add block(s) after the complete section that starts at a heading (requires headingBlockId, blocks array)
- insert_before_section: Add block(s) before the complete section that starts at a heading (requires headingBlockId, blocks array)
- insert_between_sections: Add block(s) between two heading sections (requires afterHeadingBlockId or beforeHeadingBlockId, blocks array)
- delete_here: Delete the named block or section anchor (requires blockId or headingBlockId, optional scope "block"|"section")
- delete_section: Remove a heading and all following blocks until the next same-or-higher heading (requires headingBlockId or blockId)
- insert_after: Add new block(s) after specified block (requires blockId, blocks array)
- insert_before: Add new block(s) before specified block (requires blockId, blocks array)
- append_to_page: Add block(s) at end of page (requires blocks array)
- prepend_to_page: Add block(s) at start of page (requires blocks array)
- rebuild_page: Replace the full page body with a new block structure when a clean rebuild is better than incremental edits (requires blocks array)
- delete_block: Remove a block (requires blockId)

STRUCTURAL EDITING RULES:
- You can use every visible block in BLOCKS IN THIS PAGE and TOP-LEVEL LAYOUT, not only the final block or final row.
- On second and later page-edit requests, preserve existing content unless the user explicitly asks to replace/reset the whole page.
- For "insert here", "insert between sections", "add this after/before that", or "delete here" requests, use insert_here, insert_between_sections, insert_after_section, insert_before_section, delete_here, or delete_section instead of rebuild_page.
- When moving existing material, use move_block or move_section with the destination anchor ID; do not recreate the material at the end.
- When a block is the right content but the wrong kind, use update_block with type or change_block_type/set_block_type. Do not leave JSON or markdown markers inside a code/text block to imply the new type.
- Use change_block_type/set_block_type/update_block with type to convert a block in place. Keep the existing block ID whenever possible; do not delete and recreate the block just to change its type.
- For full-page builds, return one notes-actions payload only. Do not put the JSON payload in the visible assistant_reply, and do not add a code block containing the request at the bottom of the page.
- Keep block type names exact: text, heading_1, heading_2, heading_3, bulleted_list, numbered_list, todo, callout, quote, divider, image, ai_image, bookmark, database, chart, toggle, mermaid, code, math.

BLOCK TYPES:
- text: Plain text paragraph
- heading_1, heading_2, heading_3: Section headings
- bulleted_list: Bullet points
- numbered_list: Numbered items
- todo: Checkbox item (content: {text: "...", checked: false})
- code: Code block (content: {language: "javascript", text: "..."})
- quote: Blockquote
- callout: Highlighted info box (content: {text: "...", icon: "💡"})
- divider: Horizontal line
- mermaid: Mermaid diagram (content: {text: "...", diagramType: "flowchart"})
- image: Image (content: {url: "...", caption: "..."})
- bookmark: Link bookmark (content: {url: "...", title: "..."})

BLOCK DESIGN HEURISTICS:
- Use heading blocks to create hierarchy before adding details.
- Use callout blocks for takeaways, warnings, decisions, or highlighted facts.
- Use bulleted or numbered lists for grouped items instead of long paragraphs.
- Use todo blocks for action items or checklists.
- Use quote blocks for direct excerpts or testimonial-style content.
- Use divider blocks to break up dense sections.
- Use image or ai_image blocks when visuals should live on the page, not in chat.
- Use mermaid blocks for flows, processes, systems, org charts, and diagrams.
- Use database blocks for comparison tables, trackers, or structured matrices.
- Use todo blocks for real checkboxes instead of leaving markdown task syntax like \`[ ]\` or \`[x]\` inside plain text.
- Do not leave markdown markers like \`##\`, \`-\`, \`--\`, \`[ ]\`, or \`**bold**\` inside block content when a native heading, list, todo, callout, or formatting choice exists.
- Use \`heading_3\` for compact section labels, mini-subheads, and small Notion-style separators when a phrase deserves its own line but should not become a major section heading.
- If headings, text, and bullets are the only blocks in a substantial page draft, you almost certainly have not used the full page palette yet.
- Before finalizing notes-actions, do a palette audit and check whether callout, database, bookmark, image/ai_image, mermaid, toggle, quote, todo, divider, code, or math would improve the page.
- For a polished Notion-like page, treat visual hierarchy as required work, not optional polish: use a focal block near the top, style section labels with textColor where helpful, and give secondary notes a quieter tone.
- Use the frontend metadata surface when it improves the result: page icon, cover URL, compact properties, and page default model are all available in notes mode.
- Prefer a designed first screenful: title/icon, a focal callout, and a hero visual or source cue should usually appear before the deeper body sections.
- On substantial pages, avoid more than two plain text blocks in a row without breaking the cadence with a richer block.
- If the page has a "Quick Facts", "At a Glance", or "Key Facts" section, consider a database block instead of leaving it as a plain bullet pile.
- Choose one dominant design scheme and keep it consistent across headers, callouts, visuals, and support notes instead of mixing unrelated accents.
- When editing an existing page, preserve the strongest current icon, cover, focal block, and accent colors unless the user explicitly asks for a new look.

GUIDELINES:
- Always reference blocks by their exact ID in [brackets]
- assistant_reply should be brief and user-friendly (not mention the JSON actions)
- The editor will automatically apply your actions and show the assistant_reply to the user
- Your default job in this interface is to edit the current notes page itself through block updates.
- When notes mode is active, the only supporting tools you may rely on are web-search, web-fetch, and web-scrape.
- Never print internal tool-call markup such as <|tool_calls|>, <｜DSML｜tool_calls>, invoke tags, or parameter tags in the assistant reply. If a tool is unavailable, say what is missing in plain language.
- Do not rely on document creation, artifact generation, filesystem writes, image tools, Git, deployment tools, or remote/server commands from this surface.
- Use any gathered web information only to update the current page blocks or to answer the user in chat while planning.
- When the user asks for page changes, put the final content into page blocks instead of replying with standalone HTML, artifact info, download links, or chat-only prose.
- Only stay in planning/chat mode when the user is explicitly brainstorming, outlining, asking for options, or says not to edit the page yet.
- When the user is brainstorming or asking for layout help, offer 2-3 template directions by name, explain the block structure briefly, and then adapt the chosen direction on the page.
- Only switch to standalone HTML/file/artifact output when the user explicitly asks for an export, download, link, attachment, or standalone file.
- You are free to change block types, replace weak sections, move blocks, delete redundant content, and rebuild the page structure when that produces a better result.
- When the user asks to change a specific word, sentence, phrase, number, name, or small part of a block, prefer replace_text over rewriting the entire block.
- When the user asks to highlight, mark, call out, emphasize, or visually tag specific text, use highlight_text on the smallest exact phrase inside the relevant block.
- In this notes interface, "page" means the current notes document unless the user explicitly says web page, site page, route, component, repo file, or server page.
- If the user says "put this on the page", "add this to the page", "insert this into the page", or similar, treat that as a request to edit the current notes page using notes-actions, not a request to inspect a remote server or codebase.
- Never satisfy a notes-page edit by writing a local repo/runtime file or by mentioning /app or filesystem write failures. Use notes-actions unless the user explicitly asks for an export, download, or file.
- Use \`\`\`notes-actions only when the user is actually asking to edit, create, delete, reorganize, or restyle page content.
- If the user is asking for remote execution, SSH work, cluster setup, deployment, debugging, research, or other non-page tasks, answer normally and use the available backend tools instead of forcing a notes-actions JSON response.
- For multi-step non-page work, keep ownership of the original ask and continue through the next concrete diagnostic, repair, and verification steps instead of turning each intermediate issue into a new user task.
- Treat intermediate SSH/server failures as part of the same troubleshooting chain. Do not stop to ask what to do next when the next reasonable remote action is implied by verified results.
- If SSH access or a prior SSH target is already established in the session, do not ask for host/user details again unless a tool failure shows the target is missing or incorrect.
- Ask the user only when blocked by missing secrets or credentials, a genuinely ambiguous product decision, or a destructive action that needs approval.
- For substantial page-writing requests such as briefs, reports, specs, plans, guides, proposals, or polished notes pages, work in passes: decide the sections first, then expand each section, then polish the full page before returning the final answer or notes-actions block.
- Choose a best-fit page template from the template guidance above and adapt it to the user's request instead of inventing the page layout from scratch every time.
- Also choose a matching visual recipe from the recipe guidance above so the page has a clear opening cluster, body rhythm, and support cluster.
- Also choose a dominant design scheme from the scheme guidance above so the page has a coherent palette and header treatment.
- When building a full page, prefer a clear structure with headings first and then supporting blocks under each heading instead of one long undifferentiated dump.
- For non-trivial page builds, returns should usually involve multiple blocks with hierarchy, not a single oversized text block.
- If a generated text block would carry multiple sections, multiple ideas, or more than a short paragraph, split it into separate blocks before returning notes-actions.
- Do not ship a substantial page as only \`heading_*\` + \`text\` + list blocks unless the user explicitly asked for a minimal/plain layout.
- Research pages should usually use at least one richer support block such as \`callout\`, \`bookmark\`, \`image\`, \`ai_image\`, \`toggle\`, or \`database\` when the content supports it.
- When the user wants the page to feel polished, designed, or Notion-like, make the design visible in the returned blocks: page icon, a focal callout, a hero image/ai_image when the topic supports it, colored section labels, muted supporting notes, and a clear source or appendix cluster.
- Prefer structural edits over append-only edits when the page needs organization: use update_block to convert block types, replace_block to rebuild a section, move_block to reorder sections, and rebuild_page when the current layout should be replaced wholesale.
- It is acceptable to replace a single block with multiple blocks, or to rebuild the full page, if that is the clearest way to satisfy the request.
- In notes, Mermaid usually belongs as a mermaid block inside the page. Do not switch to a downloadable Mermaid artifact unless the user explicitly asks for a file, export, download, or shareable artifact.
- For text-like blocks, use plain strings for content
- For special blocks (todo, code, mermaid, image, bookmark, database, chart), use structured objects
- Do not write markdown syntax into a block when the block type already expresses the structure. Use heading blocks for headings, list blocks for bullets, todo blocks for checkboxes, callout blocks for highlighted notes, and \`formatting\` instead of raw \`**bold**\` markers.
- Use \`heading_3\` when a short label or mini-section should sit on its own line. Do not bury those labels inline at the start of paragraph text.
- You may include \`formatting\` on text-like blocks using \`{bold, italic, underline, strikethrough, code}\`.
- You may include \`fontFamily\` (\`${NOTES_FONT_FAMILY_OPTIONS.join('`, `')}\`), \`fontSize\` (\`${NOTES_FONT_SIZE_OPTIONS.join('`, `')}\`), \`fontWeight\` (\`${NOTES_FONT_WEIGHT_OPTIONS.join('`, `')}\`), and \`textAlign\` (\`${NOTES_TEXT_ALIGN_OPTIONS.join('`, `')}\`) for deliberate per-block typography.
- You may include \`children\` on blocks when nested content improves the page, especially under toggles.
- Do not invent block IDs - only use IDs that exist in the page
- Keep assistant_reply concise unless user asks for detailed explanation
- If generating Mermaid diagrams, include clean diagram code in a \`\`\`mermaid block
- Additional supported blocks and capabilities:
  - toggle: expand/collapse section with plain string content
  - math: equation block using {text, displayMode}
  - ai_image: use {prompt, source: "ai"|"unsplash", imageUrl, model, size, quality, style}
  - database: use {columns, rows, sortColumn, sortDirection}
  - existing database updates: use update_database with {blockId, columns, rows} or {blockId, appendRows} for larger writes
  - database score/rating fills: use fill_database_column with {blockId, column or columnIndex, start, end, step} or explicit values
  - chart: use {title, chartType, labels, values, unit}; chartType can be bar, line, or pie
  - ai: inline AI block using {prompt, result, model}
- For callout blocks, use structured content like {text: "...", icon: "💡"}.
- Use image for known image URLs or uploaded/static images.
- Use ai_image with source: "ai" for generated illustrations, posters, covers, concept art, mockups, and diagrams.
- Use ai_image with source: "unsplash" for real photography, mood boards, people, offices, products, and reference imagery.
- You may optionally add "color" and "textColor" to any inserted/replaced block using: ${NOTES_COLOR_OPTIONS.join(', ')}.
- You may optionally add "fontFamily", "fontSize", "fontWeight", and "textAlign" to any inserted/replaced text-like block using supported typography options.
- Use highlight_text for phrase-level emphasis with highlight colors: ${NOTES_HIGHLIGHT_COLOR_OPTIONS.join(', ')}.
- Use styling intentionally for hierarchy and variety, for example yellow or blue callouts, gray supporting notes, red warnings, and green status summaries.
- For structured blocks (todo, callout, code, math, mermaid, image, ai_image, bookmark, database, chart, ai), use structured objects rather than plain strings.
- When the user asks for a redesign, dashboard, brief, report, or polished layout, consider updating the page title/icon/cover with update_page in addition to the blocks.
- If the user asks for color or visual design, explicitly consider block background colors ("color"), text colors ("textColor"), highlight colors, and per-block typography where they improve readability.
- When improving layout or variety, prefer mixing headings, callouts, quotes, lists, databases, images, dividers, and tasteful color/textColor choices instead of only plain paragraphs`;
    }

    function normalizeLooseStructuredToken(value = '', options = {}) {
        const {
            lowercase = true,
            spacesToUnderscore = true,
        } = options;
        let normalized = stripUnsafeNullCharacters(value).trim();
        if (!normalized) {
            return '';
        }

        normalized = normalized
            .replace(/\s*([_-])\s*/g, '$1')
            .replace(/\s{2,}/g, ' ');

        if (spacesToUnderscore) {
            normalized = normalized.replace(/\s+/g, '_');
        }

        normalized = normalized.replace(/-/g, '_').replace(/_+/g, '_');
        return lowercase ? normalized.toLowerCase() : normalized;
    }

    function normalizeLooseStructuredKeyName(key = '') {
        const trimmed = stripUnsafeNullCharacters(key).trim();
        if (!trimmed) {
            return '';
        }

        const normalized = normalizeLooseStructuredToken(trimmed, {
            lowercase: true,
            spacesToUnderscore: true,
        });
        const compact = normalized.replace(/_/g, '');
        const aliases = {
            assistantreply: 'assistant_reply',
            assistant_reply: 'assistant_reply',
            assistantmessage: 'assistantMessage',
            assistant_message: 'assistantMessage',
            notesactions: 'notes-actions',
            notes_actions: 'notes-actions',
            blockid: 'blockId',
            block_id: 'blockId',
            headingblockid: 'headingBlockId',
            heading_block_id: 'headingBlockId',
            sectionblockid: 'sectionBlockId',
            section_block_id: 'sectionBlockId',
            targetblockid: 'targetBlockId',
            target_block_id: 'targetBlockId',
            targetheadingblockid: 'targetHeadingBlockId',
            target_heading_block_id: 'targetHeadingBlockId',
            targetsectionblockid: 'targetSectionBlockId',
            target_section_block_id: 'targetSectionBlockId',
            afterheadingblockid: 'afterHeadingBlockId',
            after_heading_block_id: 'afterHeadingBlockId',
            beforeheadingblockid: 'beforeHeadingBlockId',
            before_heading_block_id: 'beforeHeadingBlockId',
            previousheadingblockid: 'previousHeadingBlockId',
            previous_heading_block_id: 'previousHeadingBlockId',
            nextheadingblockid: 'nextHeadingBlockId',
            next_heading_block_id: 'nextHeadingBlockId',
            imageurl: 'imageUrl',
            image_url: 'imageUrl',
            imageassetid: 'imageAssetId',
            image_asset_id: 'imageAssetId',
            downloadurl: 'downloadUrl',
            download_url: 'downloadUrl',
            sortcolumn: 'sortColumn',
            sort_column: 'sortColumn',
            sortdirection: 'sortDirection',
            sort_direction: 'sortDirection',
            defaultmodel: 'defaultModel',
            default_model: 'defaultModel',
            displaymode: 'displayMode',
            display_mode: 'displayMode',
            textcolor: 'textColor',
            text_color: 'textColor',
            backgroundcolor: 'backgroundColor',
            background_color: 'backgroundColor',
            bgcolor: 'bgColor',
            bg_color: 'bgColor',
            fontfamily: 'fontFamily',
            font_family: 'fontFamily',
            fontsize: 'fontSize',
            font_size: 'fontSize',
            fontweight: 'fontWeight',
            font_weight: 'fontWeight',
            textalign: 'textAlign',
            text_align: 'textAlign',
            unsplashresults: 'unsplashResults',
            unsplash_results: 'unsplashResults',
            selectedunsplashid: 'selectedUnsplashId',
            selected_unsplash_id: 'selectedUnsplashId',
            unsplashphotographer: 'unsplashPhotographer',
            unsplash_photographer: 'unsplashPhotographer',
            unsplashphotographerurl: 'unsplashPhotographerUrl',
            unsplash_photographer_url: 'unsplashPhotographerUrl',
            diagramtype: 'diagramType',
            diagram_type: 'diagramType',
            outputtext: 'output_text',
            output_text: 'output_text',
        };

        if (aliases[normalized]) {
            return aliases[normalized];
        }
        if (aliases[compact]) {
            return aliases[compact];
        }
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed)) {
            return trimmed;
        }
        return normalized;
    }

    function normalizeLooseStructuredObject(value) {
        if (Array.isArray(value)) {
            return value.map((entry) => normalizeLooseStructuredObject(entry));
        }

        if (!value || typeof value !== 'object') {
            return value;
        }

        const normalized = {};
        Object.entries(value).forEach(([key, entryValue]) => {
            const normalizedKey = normalizeLooseStructuredKeyName(key);
            const nextValue = normalizeLooseStructuredObject(entryValue);
            const existingValue = normalized[normalizedKey];
            if (Object.prototype.hasOwnProperty.call(normalized, normalizedKey)) {
                const existingEmpty = existingValue == null
                    || existingValue === ''
                    || (Array.isArray(existingValue) && existingValue.length === 0);
                if (existingEmpty && nextValue != null && nextValue !== '') {
                    normalized[normalizedKey] = nextValue;
                }
                return;
            }
            normalized[normalizedKey] = nextValue;
        });

        return normalized;
    }

    function normalizeLooseStructuredJsonText(text = '') {
        const cleaned = stripDiffStylePrefixes(stripUnsafeNullCharacters(text)).trim();
        if (!cleaned) {
            return '';
        }

        return cleaned
            .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$\s-]{0,48})"\s*:/g, (_match, prefix, key) => {
                const normalizedKey = normalizeLooseStructuredKeyName(key);
                return `${prefix}"${normalizedKey}":`;
            })
            .replace(/([{,]\s*)"([^"\r\n]+?)"\s*:/g, (_match, prefix, key) => {
            const normalizedKey = normalizeLooseStructuredKeyName(key);
            return `${prefix}"${normalizedKey}":`;
        });
    }

    function escapeRawNewlinesInJsonStrings(text = '') {
        const source = String(text || '');
        let output = '';
        let inString = false;
        let isEscaped = false;

        for (let index = 0; index < source.length; index += 1) {
            const char = source[index];

            if (inString) {
                if (isEscaped) {
                    output += char;
                    isEscaped = false;
                    continue;
                }
                if (char === '\\') {
                    output += char;
                    isEscaped = true;
                    continue;
                }
                if (char === '"') {
                    output += char;
                    inString = false;
                    continue;
                }
                if (char === '\n' || char === '\r') {
                    output += ' ';
                    if (char === '\r' && source[index + 1] === '\n') {
                        index += 1;
                    }
                    continue;
                }
                output += char;
                continue;
            }

            output += char;
            if (char === '"') {
                inString = true;
            }
        }

        return output;
    }

    function parseStructuredJsonPayload(text = '') {
        const cleaned = normalizeStructuredPayloadText(text);
        if (!cleaned) {
            return null;
        }

        const candidates = [cleaned];
        const newlineEscaped = escapeRawNewlinesInJsonStrings(cleaned);
        if (newlineEscaped && newlineEscaped !== cleaned) {
            candidates.push(newlineEscaped);
        }
        const looseCandidate = normalizeLooseStructuredJsonText(cleaned);
        if (looseCandidate && looseCandidate !== cleaned) {
            candidates.push(looseCandidate);
        }
        const looseNewlineEscaped = escapeRawNewlinesInJsonStrings(looseCandidate);
        if (looseNewlineEscaped && !candidates.includes(looseNewlineEscaped)) {
            candidates.push(looseNewlineEscaped);
        }
        [...candidates].forEach((candidate) => {
            buildLooseTopLevelJsonCandidates(candidate).forEach((nextCandidate) => {
                if (nextCandidate && !candidates.includes(nextCandidate)) {
                    candidates.push(nextCandidate);
                }
            });
        });

        for (const candidate of candidates) {
            try {
                return normalizeLooseStructuredObject(JSON.parse(candidate));
            } catch (_error) {
                // Try the next normalized candidate.
            }
        }

        return null;
    }

    function findJsonStringEnd(text = '', start = 0) {
        const source = String(text || '');
        if (source[start] !== '"') {
            return -1;
        }

        let isEscaped = false;
        for (let index = start + 1; index < source.length; index++) {
            const char = source[index];
            if (isEscaped) {
                isEscaped = false;
                continue;
            }
            if (char === '\\') {
                isEscaped = true;
                continue;
            }
            if (char === '"') {
                return index + 1;
            }
        }

        return -1;
    }

    function buildLooseTopLevelJsonCandidates(text = '') {
        const source = String(text || '').trim();
        if (!source) {
            return [];
        }

        const candidates = [];
        if (/^"(?:assistant_reply|assistantReply|assistantMessage|reply|message|actions|operations|edits|notes-actions)"\s*:/i.test(source)) {
            candidates.push(`{${source}}`);
        }

        const stringEnd = findJsonStringEnd(source, 0);
        if (stringEnd > 0 && /^\s*,\s*"(?:actions|operations|edits|notes-actions)"\s*:/i.test(source.slice(stringEnd))) {
            candidates.push(`{"assistant_reply":${source}}`);
        }

        return candidates;
    }

    function unwrapCodeFence(text = '') {
        const trimmed = stripUnsafeNullCharacters(text)
            .trim()
            .replace(/^```+\s*notes\s*(?:[_-]|\s)\s*actions\b/i, '```notes-actions')
            .replace(/^```+\s*json\b/i, '```json');
        const match = trimmed.match(/^```(?:json|notes-actions)?\s*([\s\S]*?)\s*```$/i);
        return match ? match[1].trim() : trimmed;
    }

    function safeJsonParse(text = '') {
        return parseStructuredJsonPayload(text);
    }

    function normalizeStructuredPayloadText(text = '') {
        return stripDiffStylePrefixes(unwrapCodeFence(text)).trim();
    }

    function isValidHiddenDraftPayload(payload = null) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return false;
        }

        const sections = Array.isArray(payload.sections) ? payload.sections : [];
        if (sections.length === 0) {
            return false;
        }

        return sections.some((section) => {
            if (!section || typeof section !== 'object' || Array.isArray(section)) {
                return false;
            }

            return typeof section.heading === 'string'
                || typeof section.goal === 'string'
                || typeof section.summary === 'string'
                || Array.isArray(section.keyPoints)
                || Array.isArray(section.blockTypes)
                || Array.isArray(section.suggestedBlocks);
        });
    }

    function shouldUseMultiPassNotesDraft(question = '', context = null, requestOptions = {}) {
        if (requestOptions?.outputFormat || isPlanningConversationIntent(question, context)) {
            return false;
        }

        const normalized = String(question || '').trim().toLowerCase();
        if (!normalized) {
            return false;
        }

        const pageHasEnoughSurface = (context?.blockCount || 0) > 3 || (context?.outline?.length || 0) > 1;
        if (normalized.length < 28 && !pageHasEnoughSurface) {
            return false;
        }

        if (/\b(ssh|remote|server|cluster|k8s|kubernetes|kubectl|deploy|deployment|docker|traefik|let'?s encrypt|acme|cert-manager|search the web|browse|scrape|tool)\b/.test(normalized)) {
            return false;
        }

        if (/\b(research|look up|find|gather)\b[\s\S]{0,30}\b(web|online|site|website)\b/.test(normalized)) {
            return false;
        }

        const writingVerb = /\b(create|make|build|draft|write|expand|organize|polish|rewrite|turn|convert|structure|format)\b/.test(normalized);
        const improvementVerb = /\b(restructure|rework|refresh|improve|clean up|tighten|finish|continue|fill out|work on)\b/.test(normalized);
        const substantialTarget = /\b(page|document|report|brief|spec|proposal|plan|guide|memo|summary|notes|runbook|dashboard|playbook)\b/.test(normalized);
        const sectionTarget = /\b(section|sections|block|blocks|layout|structure|flow)\b/.test(normalized);

        return (writingVerb || improvementVerb) && (substantialTarget || pageHasEnoughSurface || sectionTarget);
    }

    function supportsStructuredNotesDrafting(modelId = '') {
        const normalized = String(modelId || '').trim().toLowerCase();
        if (!normalized) {
            return false;
        }

        return !(
            /\bgpt-oss\b/.test(normalized)
            || /\boss\b/.test(normalized)
            || /\bgemini\b/.test(normalized)
            || /\bkimi\b/.test(normalized)
        );
    }

    function isExplicitPageEditIntent(question = '') {
        const normalized = String(question || '').trim().toLowerCase();
        if (!normalized) {
            return false;
        }

        return [
            /\b(put|add|insert|place|append|prepend|move|drop|apply|write|turn|convert|use|set)\b[\s\S]{0,40}\b(on|into|to|in)\b[\s\S]{0,20}\b(page|note|document|doc)\b/,
            /\b(edit|update|rewrite|reformat|reorganize|restyle|clean up|fix)\b[\s\S]{0,40}\b(page|note|document|doc)\b/,
            /\b(current page|this page|the page|this note|the note)\b/,
        ].some((pattern) => pattern.test(normalized));
    }

    function hasExplicitExternalPageIntent(question = '') {
        const normalized = String(question || '').trim().toLowerCase();
        if (!normalized) {
            return false;
        }

        if (/https?:\/\//.test(normalized)) {
            return true;
        }

        const externalTarget = /\b(site|website|web\s*page|homepage|landing\s*page|url)\b/.test(normalized);
        const externalVerb = /\b(look over|review|inspect|analyze|audit|browse|scrape|check|visit)\b/.test(normalized);
        return externalTarget && externalVerb;
    }

    function isPlanningConversationIntent(question = '', context = null) {
        const normalized = String(question || '').trim().toLowerCase();
        if (!normalized) {
            return false;
        }

        const planningPatterns = [
            /\b(help me|let'?s|lets|can we|could we|i want to|we should)\s+(plan|outline|brainstorm|think through|talk through|discuss|ideate|sketch out|map out)\b/,
            /\b(just|only)\s+(plan|outline|brainstorm|discuss)\b/,
            /\b(plan|outline|brainstorm|think through|talk through|discuss|ideate|sketch out|map out)\b[\s\S]{0,40}\b(before|first)\b/,
            /\b(before|first)\b[\s\S]{0,30}\b(edit|update|rewrite|apply|write|change|rebuild)\b/,
            /\b(do not|don't|dont|not)\b[\s\S]{0,20}\b(edit|update|rewrite|apply|write|change|rebuild)\b[\s\S]{0,20}\b(yet|first)\b/,
        ];
        const planningTarget = /\b(page|notes?|document|doc|brief|report|spec|guide|proposal|outline|section|content|html page|web page|landing page|website)\b/.test(normalized)
            || (context?.blockCount || 0) > 0
            || (context?.outline?.length || 0) > 0;

        return planningTarget && planningPatterns.some((pattern) => pattern.test(normalized));
    }

    function hasNonPageRuntimeIntent(question = '', requestOptions = {}) {
        if (requestOptions?.outputFormat) {
            return true;
        }

        const normalized = String(question || '').trim().toLowerCase();
        if (!normalized) {
            return false;
        }

        return hasExplicitExternalPageIntent(normalized)
            || /\b(ssh|remote|server|cluster|k8s|kubernetes|kubectl|deploy|deployment|docker|container|ingress|traefik|dns|tls|acme|cert|debug|troubleshoot|logs|tool call|tool use)\b/.test(normalized);
    }

    function isImplicitPageBuildIntent(question = '', context = null, requestOptions = {}) {
        if (hasNonPageRuntimeIntent(question, requestOptions)) {
            return false;
        }

        const normalized = String(question || '').trim().toLowerCase();
        if (!normalized) {
            return false;
        }

        const pageWritingVerb = /\b(create|make|build|draft|write|expand|fill out|flesh out|continue|finish|polish|rewrite|turn|convert|organize|restructure|rework|improve|work on)\b/.test(normalized);
        const pageTarget = /\b(page|notes|note|document|doc|brief|report|spec|plan|guide|proposal|outline|section|content)\b/.test(normalized);
        const contextSurface = (context?.blockCount || 0) > 0 || (context?.outline?.length || 0) > 0;
        const asksForFullerContent = /\b(more detail|more details|fill it out|flesh it out|expand it|make it better|make it fuller|build it out|finish the page|work on the page)\b/.test(normalized);

        return (pageWritingVerb && (pageTarget || contextSurface)) || asksForFullerContent;
    }

    function shouldForcePageEditActions(question = '', context = null, requestOptions = {}) {
        if (isPlanningConversationIntent(question, context) || hasNonPageRuntimeIntent(question, requestOptions)) {
            return false;
        }

        return isExplicitPageEditIntent(question)
            || isImplicitPageBuildIntent(question, context, requestOptions)
            || shouldUseMultiPassNotesDraft(question, context, requestOptions);
    }

    function getFallbackLayoutForTemplate(templateId = '') {
        const fallbackLayouts = {
            brief: { index: 1, name: 'Executive Brief', id: 'executive-brief' },
            explainer: { index: 2, name: 'Editorial Explainer', id: 'editorial-explainer' },
            research: { index: 3, name: 'Research Hub', id: 'research-hub' },
            project: { index: 4, name: 'Operator Board', id: 'operator-board' },
            dashboard: { index: 4, name: 'Operator Board', id: 'operator-board' },
            sales: { index: 5, name: 'Sales Proof Stack', id: 'sales-proof-stack' },
            documentation: { index: 6, name: 'Guided Procedure', id: 'guided-procedure' },
            meeting: { index: 7, name: 'Session Record', id: 'session-record' },
            journal: { index: 7, name: 'Session Record', id: 'session-record' },
        };

        return fallbackLayouts[templateId] || fallbackLayouts.explainer;
    }

    function getBestFitIndexedLayout(templateMatches = []) {
        const leadTemplate = Array.isArray(templateMatches) && templateMatches.length > 0 ? templateMatches[0] : null;
        const fallback = getFallbackLayoutForTemplate(leadTemplate?.id);
        const catalog = window.NotesLayoutCatalog?.getPageLayouts?.() || [];
        if (!catalog.length) {
            return fallback;
        }

        const matchById = catalog.find((layout) => layout.id === fallback.id);
        if (matchById) {
            return {
                index: matchById.index,
                id: matchById.id,
                name: matchById.name,
            };
        }

        return {
            index: catalog[0].index,
            id: catalog[0].id,
            name: catalog[0].name,
        };
    }

    function buildRequestUnderstanding(question = '', context = null, requestOptions = {}) {
        const normalized = String(question || '').trim();
        const templateMatches = selectNotesPageTemplates(normalized, context, { limit: 2 });
        const designSchemes = selectNotesDesignSchemes(normalized, context, templateMatches);
        const leadTemplate = templateMatches[0] || null;
        const leadScheme = designSchemes[0] || null;
        const layout = getBestFitIndexedLayout(templateMatches);
        const outputFormat = requestOptions?.outputFormat || inferRequestedArtifactFormat(normalized);
        const suppressedOutput = shouldSuppressRequestedArtifactFormat(normalized, context, outputFormat);
        const pageReasoningModes = inferPageReasoningModes(normalized, context);

        let route = 'chat';
        let label = 'Answer in chat';
        let strategy = 'Respond directly unless the user asks for page changes.';
        let confidence = 0.54;

        if (hasNonPageRuntimeIntent(normalized, requestOptions)) {
            route = 'external_runtime';
            label = 'External work';
            strategy = 'Do not force notes-actions; handle the runtime, website, deployment, or diagnostic request directly.';
            confidence = 0.9;
        } else if (outputFormat && !suppressedOutput) {
            route = 'artifact';
            label = `${String(outputFormat).toUpperCase()} artifact`;
            strategy = 'Create the requested explicit export or artifact and only mirror useful context into notes.';
            confidence = 0.86;
        } else if (isPlanningConversationIntent(normalized, context)) {
            route = 'planning';
            label = 'Plan before editing';
            strategy = 'Discuss 2-3 directions, then wait for or invite a concrete page edit.';
            confidence = 0.82;
        } else if (shouldUseMultiPassNotesDraft(normalized, context, requestOptions)) {
            route = 'symphony_page_draft';
            label = 'Symphony page draft';
            strategy = 'Run architecture, section-agent expansion, and final polish before applying page blocks.';
            confidence = 0.88;
        } else if (shouldForcePageEditActions(normalized, context, requestOptions)) {
            route = 'page_edit';
            label = 'Edit current page';
            strategy = 'Return notes-actions that update the current page instead of chat-only prose.';
            confidence = isExplicitPageEditIntent(normalized) ? 0.9 : 0.76;
        } else if (normalized.length > 0 && ((context?.blockCount || 0) > 0 || (context?.outline?.length || 0) > 0)) {
            route = 'page_aware_chat';
            label = 'Page-aware answer';
            strategy = 'Use the page as context while keeping the answer conversational.';
            confidence = 0.62;
        }

        const signals = [
            shouldUseMultiPassNotesDraft(normalized, context, requestOptions) ? 'multi-pass page build' : '',
            shouldForcePageEditActions(normalized, context, requestOptions) ? 'notes-actions likely' : '',
            suppressedOutput ? 'artifact wording suppressed for notes page' : '',
            leadTemplate?.name ? `template: ${leadTemplate.name}` : '',
            layout?.name ? `layout: ${layout.name}` : '',
            leadScheme?.name ? `scheme: ${leadScheme.name}` : '',
            pageReasoningModes.length ? `page reasoning: ${pageReasoningModes.join(', ')}` : '',
        ].filter(Boolean);

        return {
            route,
            label,
            confidence,
            strategy,
            template: leadTemplate ? {
                id: leadTemplate.id,
                name: leadTemplate.name,
                score: leadTemplate.score || 0,
            } : null,
            layout,
            designScheme: leadScheme ? {
                id: leadScheme.id,
                name: leadScheme.name,
            } : null,
            pageReasoningModes,
            signals,
        };
    }

    function buildSymphonyUnderstandingGuidance(question = '', pageContext = null, templateMatches = []) {
        const understanding = buildRequestUnderstanding(question, pageContext, {});
        const leadTemplate = understanding.template || templateMatches[0] || null;
        return [
            `Route: ${understanding.label} [${understanding.route}]`,
            `Confidence: ${Math.round((understanding.confidence || 0) * 100)}%`,
            leadTemplate?.name ? `Template: ${leadTemplate.name}` : '',
            understanding.layout?.name ? `Indexed layout: #${understanding.layout.index} ${understanding.layout.name}` : '',
            understanding.designScheme?.name ? `Design scheme: ${understanding.designScheme.name}` : '',
            understanding.pageReasoningModes?.length ? `Page reasoning: ${understanding.pageReasoningModes.join(', ')}` : '',
            `Strategy: ${understanding.strategy}`,
            understanding.signals?.length ? `Signals: ${understanding.signals.join(' | ')}` : '',
            'Before answering, reconcile the route, template, layout, and page context. If they conflict, preserve the user request first, then the current page, then visual polish.',
        ].filter(Boolean).join('\n');
    }

    function looksLikeShortAcknowledgement(text = '') {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!normalized) {
            return true;
        }

        if (normalized.length > 180) {
            return false;
        }

        const acknowledgementStart = /^(sure|yes|okay|ok|done|absolutely|certainly|yep|yeah|i('|’)ll|i can|i have|i did)\b/i.test(normalized);
        const placementIntent = /\b(place|put|add|insert|apply|placed|added|inserted|applied)\b[\s\S]{0,30}\b(page|note|document)\b/i.test(normalized);
        const pageReference = /\b(on|into|to|in)\s+(the\s+)?(page|note|document)\b/i.test(normalized);

        return (acknowledgementStart && pageReference) || placementIntent;
    }

    function getLastSubstantialAssistantMessage(excludeText = '') {
        syncConversationWithCurrentPage({ emitEvent: false });
        const excluded = stripUnsafeNullCharacters(excludeText).trim();

        for (let index = state.messages.length - 1; index >= 0; index -= 1) {
            const message = state.messages[index];
            if (!message || message.role !== 'assistant' || message.hidden || message.transient) {
                continue;
            }

            const content = unwrapGenericResponseContent(message.content || '');
            if (!content || content === excluded || looksLikeInternalNotesScaffold(content)) {
                continue;
            }

            if (message.appliedCount > 0 || /^Applied \d+ page change/i.test(content)) {
                continue;
            }

            if (content.length < 160 && looksLikeShortAcknowledgement(content)) {
                continue;
            }

            return content;
        }

        return '';
    }

    function getPageRootBlocks() {
        const page = window.Editor?.getCurrentPage?.();
        return Array.isArray(page?.blocks) ? page.blocks : [];
    }

    function pageHasOnlyPlaceholderContent() {
        const blocks = getPageRootBlocks();
        if (blocks.length === 0) {
            return true;
        }

        if (blocks.length !== 1) {
            return false;
        }

        const [block] = blocks;
        const text = extractBlockTextValue(block).trim();
        return ['text', 'heading_1', 'heading_2', 'heading_3'].includes(block?.type) && !text;
    }

    function isStructuralTextBoundary(line = '') {
        const normalized = String(line || '').trim();
        if (!normalized) return true;

        return /^#{1,3}\s+/.test(normalized) ||
            /^>\s+/.test(normalized) ||
            /^(?:[-*]|--+)\s+/.test(normalized) ||
            /^(?:[-*]\s+)?\[(?: |x|X)\]\s+/.test(normalized) ||
            /^\d+\.\s+/.test(normalized) ||
            /^\[![a-z_ -]+\]$/i.test(normalized) ||
            /^!\s*\S+/.test(normalized) ||
            /^```/.test(normalized) ||
            /^---+$/.test(normalized);
    }

    function inferHeadingLevel(line = '', isFirstHeading = false) {
        const normalized = String(line || '').trim();
        if (!normalized) {
            return null;
        }

        if (/^#{1,3}\s+/.test(normalized)) {
            const level = normalized.match(/^#+/)[0].length;
            return `heading_${Math.min(level, 3)}`;
        }

        if (normalized.length > 90) {
            return null;
        }

        if (/[.:;!?]$/.test(normalized)) {
            return null;
        }

        if (normalized.split(/\s+/).length > 8) {
            return null;
        }

        if (isFirstHeading) {
            return 'heading_1';
        }

        return /^(summary|overview|background|market position|what the company does|core solution areas|business strengths|strategic direction|bottom line|sources)$/i.test(normalized)
            ? 'heading_2'
            : null;
    }

    function getCalloutIconForMarker(marker = '') {
        const normalized = String(marker || '').trim().toLowerCase();
        return {
            summary: '!',
            info: 'i',
            important: '!!',
            tip: '+',
            warning: '!',
            note: '*',
            callout: '!'
        }[normalized] || '!';
    }

    function escapeMarkdownAltText(value = '') {
        return String(value || '')
            .replace(/\\/g, '\\\\')
            .replace(/\]/g, '\\]');
    }

    function buildMarkdownImageLine(url = '', altText = 'Image') {
        const normalizedUrl = String(url || '').trim();
        if (!/^https?:\/\//i.test(normalizedUrl)) {
            return null;
        }

        const normalizedAlt = String(altText || '').replace(/\s+/g, ' ').trim() || 'Image';
        return `![${escapeMarkdownAltText(normalizedAlt)}](${normalizedUrl})`;
    }

    function looksLikeEmbeddableImageUrl(url = '') {
        const normalizedUrl = String(url || '').trim();
        if (!/^https?:\/\//i.test(normalizedUrl)) {
            return false;
        }

        if (/\.(?:png|jpe?g|gif|webp|svg|bmp|avif)(?:[?#].*)?$/i.test(normalizedUrl)) {
            return true;
        }

        try {
            const parsed = new URL(normalizedUrl);
            const hostname = parsed.hostname.toLowerCase();
            if (/\/api\/artifacts\/[^/]+\/download\b/i.test(parsed.pathname)) {
                return true;
            }
            return /(?:^|\.)unsplash\.com$/.test(hostname) ||
                /(?:^|\.)oaiusercontent\.com$/.test(hostname) ||
                /(?:^|\.)openai\.com$/.test(hostname) ||
                /blob\.core\.windows\.net$/.test(hostname);
        } catch (_error) {
            return false;
        }
    }

    function buildArtifactDisplayUrl(path = '', options = {}) {
        const normalizedPath = String(path || '').trim();
        if (!normalizedPath) {
            return '';
        }

        try {
            const url = new URL(normalizedPath, window.location.origin);
            if (options.inline) {
                url.searchParams.set('inline', '1');
            }
            return url.toString();
        } catch (_error) {
            return '';
        }
    }

    function extractHostLabel(value = '') {
        try {
            return new URL(String(value || '').trim()).hostname.replace(/^www\./i, '');
        } catch (_error) {
            return '';
        }
    }

    function normalizeBlindArtifactItem(item, fallbackPrompt = '', fallbackHost = '') {
        if (!item || typeof item !== 'object') {
            return null;
        }

        const downloadUrl = buildArtifactDisplayUrl(item.downloadPath || item.downloadUrl || '');
        const inlineUrl = buildArtifactDisplayUrl(
            item.inlinePath || item.downloadPath || item.downloadUrl || '',
            { inline: true },
        );
        if (!downloadUrl || !inlineUrl) {
            return null;
        }

        const sourceHost = item.sourceHost || fallbackHost || '';
        const filename = item.filename || `captured-image-${item.index || 1}`;
        const alt = filename
            .replace(/\.[a-z0-9]{2,5}$/i, '')
            .replace(/[-_]+/g, ' ')
            .trim() || fallbackPrompt || 'Captured image';

        return {
            artifactId: item.artifactId || null,
            filename,
            mimeType: item.mimeType || '',
            sizeBytes: item.sizeBytes || 0,
            sourceHost,
            downloadUrl,
            inlineUrl,
            imageUrl: inlineUrl,
            alt,
        };
    }

    function parseToolArguments(rawArgs) {
        if (!rawArgs) {
            return {};
        }

        if (typeof rawArgs === 'object') {
            return rawArgs;
        }

        if (typeof rawArgs !== 'string') {
            return {};
        }

        try {
            return JSON.parse(rawArgs);
        } catch (_error) {
            return {};
        }
    }

    function extractBlindArtifactSelectionsFromToolEvents(toolEvents = []) {
        if (!Array.isArray(toolEvents) || toolEvents.length === 0) {
            return [];
        }

        const selections = [];

        toolEvents.forEach((event) => {
            const toolId = event?.toolCall?.function?.name || event?.result?.toolId || '';
            if (toolId !== 'web-scrape') {
                return;
            }

            const args = parseToolArguments(event?.toolCall?.function?.arguments);
            const data = event?.result?.data || {};
            const imageCapture = data.imageCapture && typeof data.imageCapture === 'object'
                ? data.imageCapture
                : (event?.result?.imageCapture && typeof event.result.imageCapture === 'object'
                    ? event.result.imageCapture
                    : null);
            if (imageCapture?.mode !== 'blind-artifacts') {
                return;
            }

            const fallbackHost = extractHostLabel(data.url || args.url || '') || imageCapture.items?.[0]?.sourceHost || '';
            const items = (Array.isArray(imageCapture.items) ? imageCapture.items : [])
                .map((item) => normalizeBlindArtifactItem(item, data.title || data.url || args.url || '', fallbackHost))
                .filter(Boolean);
            if (items.length === 0) {
                return;
            }

            selections.push({
                prompt: data.title || data.url || args.url || `Captured images from ${fallbackHost || 'scraped page'}`,
                sourceHost: fallbackHost,
                items,
            });
        });

        return selections;
    }

    function isEmptyStarterBlock(block) {
        if (!block || block.type !== 'text' || (Array.isArray(block.children) && block.children.length > 0)) {
            return false;
        }

        return !extractBlockTextValue(block).trim();
    }

    function appendBlindArtifactSelectionBlocks(toolEvents = []) {
        const selections = extractBlindArtifactSelectionsFromToolEvents(toolEvents);
        if (!selections.length || !window.Blocks?.createBlock || !window.Editor?.getCurrentPage) {
            return { appliedCount: 0, selectionCount: 0, imageCount: 0 };
        }

        const page = window.Editor.getCurrentPage();
        if (!page) {
            return { appliedCount: 0, selectionCount: 0, imageCount: 0 };
        }

        const blocks = selections.map((selection) => window.Blocks.createBlock('ai_image', {
            prompt: selection.prompt,
            caption: '',
            imageUrl: null,
            model: null,
            size: '1536x1024',
            quality: null,
            style: null,
            source: 'artifact',
            status: 'search_results',
            unsplashResults: null,
            artifactResults: selection.items,
            selectedUnsplashId: null,
            selectedArtifactId: null,
            imageAssetId: null,
            artifactId: null,
            downloadUrl: null,
            sourceHost: selection.sourceHost || null,
        }));

        if (blocks.length === 0) {
            return { appliedCount: 0, selectionCount: 0, imageCount: 0 };
        }

        const existingBlocks = Array.isArray(page.blocks) ? page.blocks : [];
        const inserted = existingBlocks.length === 1 && isEmptyStarterBlock(existingBlocks[0])
            ? (window.Editor.replaceBlockWithBlocks?.(existingBlocks[0].id, blocks) || [])
            : (window.Editor.insertBlocksAfter?.(existingBlocks.length ? existingBlocks[existingBlocks.length - 1].id : null, blocks) || []);

        if (inserted.length > 0) {
            window.Editor.savePage?.();
        }

        return {
            appliedCount: inserted.length,
            selectionCount: inserted.length,
            imageCount: selections.reduce((total, selection) => total + selection.items.length, 0),
        };
    }

    function isImageLikePayload(value) {
        if (!value || typeof value !== 'object') {
            return false;
        }

        return Object.prototype.hasOwnProperty.call(value, 'imageUrl') ||
            Object.prototype.hasOwnProperty.call(value, 'thumbUrl') ||
            Object.prototype.hasOwnProperty.call(value, 'b64_json') ||
            Object.prototype.hasOwnProperty.call(value, 'markdownImage') ||
            Object.prototype.hasOwnProperty.call(value, 'markdownImages') ||
            Object.prototype.hasOwnProperty.call(value, 'images') ||
            Object.prototype.hasOwnProperty.call(value, 'image') ||
            Object.prototype.hasOwnProperty.call(value, 'alt') ||
            Object.prototype.hasOwnProperty.call(value, 'prompt') ||
            Object.prototype.hasOwnProperty.call(value, 'revisedPrompt') ||
            /^(generated|unsplash|artifact|url)$/i.test(String(value.source || '').trim()) ||
            looksLikeEmbeddableImageUrl(value.url || value.normalizedUrl || '');
    }

    function parseMarkdownImageDestination(destination = '') {
        let value = String(destination || '').trim();
        if (!value) {
            return { url: '', title: '' };
        }

        if (/^<[^>]+>$/.test(value)) {
            value = value.slice(1, -1).trim();
        }

        let title = '';
        const titleMatch = value.match(/\s+(["'])(.*?)\1\s*$/);
        if (titleMatch) {
            title = titleMatch[2].trim();
            value = value.slice(0, titleMatch.index).trim();
        }

        return {
            url: value,
            title
        };
    }

    function buildBlockFromMarkdownImage(altText = '', destination = '') {
        const { url, title } = parseMarkdownImageDestination(destination);
        if (!/^https?:\/\//i.test(url)) {
            return null;
        }

        const normalizedAlt = String(altText || '').trim();
        const normalizedTitle = String(title || '').trim();
        const isExplicitAIImage = /^ai(?:\s+image)?:\s*/i.test(normalizedAlt);
        const promptText = normalizedAlt.replace(/^ai(?:\s+image)?:\s*/i, '').trim();
        const caption = promptText || normalizedAlt || normalizedTitle;
        let hostname = '';
        try {
            hostname = new URL(url).hostname;
        } catch (_error) {
            hostname = '';
        }

        if (isExplicitAIImage || /(?:^|\.)unsplash\.com$/i.test(hostname)) {
            const isUnsplashPhotoPage = /(?:^|\.)unsplash\.com$/i.test(hostname) && /\/photos\/[^/?#]+/i.test(url);
            return {
                type: 'ai_image',
                content: {
                    prompt: caption || (isExplicitAIImage ? 'AI image' : 'Unsplash image'),
                    caption: normalizedTitle || caption || '',
                    imageUrl: isUnsplashPhotoPage ? null : url,
                    model: null,
                    size: isExplicitAIImage ? 'auto' : '1536x1024',
                    quality: isExplicitAIImage ? 'auto' : null,
                    style: null,
                    source: isExplicitAIImage ? 'ai' : 'unsplash',
                    status: isUnsplashPhotoPage ? 'pending' : 'done',
                    unsplashResults: null,
                    selectedUnsplashId: null,
                    unsplashPhotographer: null,
                    unsplashPhotographerUrl: null,
                    imageAssetId: null,
                    downloadUrl: isUnsplashPhotoPage ? url : null,
                }
            };
        }

        return {
            type: 'image',
            content: {
                url,
                caption: normalizedAlt || normalizedTitle || ''
            }
        };
    }

    function extractMarkdownImageBlocksFromLine(line = '') {
        const source = String(line || '').trim();
        if (!source.startsWith('![')) {
            return [];
        }

        const matches = [...source.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];
        if (matches.length === 0) {
            return [];
        }

        let cursor = 0;
        const blocks = [];

        for (const match of matches) {
            if (source.slice(cursor, match.index).trim()) {
                return [];
            }

            const block = buildBlockFromMarkdownImage(match[1], match[2]);
            if (!block) {
                return [];
            }

            blocks.push(block);
            cursor = match.index + match[0].length;
        }

        if (source.slice(cursor).trim()) {
            return [];
        }

        return blocks;
    }

    function extractMarkdownImageContent(value, seen = new WeakSet()) {
        if (value == null) {
            return null;
        }

        if (typeof value === 'string') {
            const normalized = value.trim();
            return normalized.startsWith('![') ? normalized : null;
        }

        if (typeof value !== 'object') {
            return null;
        }

        if (seen.has(value)) {
            return null;
        }
        seen.add(value);

        if (Array.isArray(value)) {
            const arrayImages = value
                .map((entry) => extractMarkdownImageContent(entry, seen))
                .filter(Boolean);
            return arrayImages.length ? arrayImages.join('\n\n') : null;
        }

        if (typeof value.markdownImage === 'string' && value.markdownImage.trim()) {
            return value.markdownImage.trim();
        }

        if (Array.isArray(value.markdownImages)) {
            const markdownImages = value.markdownImages
                .map((entry) => typeof entry === 'string' ? entry.trim() : '')
                .filter(Boolean);
            if (markdownImages.length) {
                return markdownImages.join('\n\n');
            }
        }

        const collectedImages = [];

        if (value.image && typeof value.image === 'object') {
            const singleImage = buildMarkdownImageLine(
                value.image.url || value.image.imageUrl || value.image.normalizedUrl || '',
                value.image.alt || value.image.prompt || value.image.caption || value.image.title || 'Image'
            );
            if (singleImage) {
                collectedImages.push(singleImage);
            }
        }

        if (Array.isArray(value.images)) {
            value.images.forEach((image) => {
                if (!image || typeof image !== 'object') return;
                const markdownImage = buildMarkdownImageLine(
                    image.url || image.imageUrl || image.normalizedUrl || image.thumbUrl || '',
                    image.alt || image.prompt || image.caption || image.title || value.query || 'Image'
                );
                if (markdownImage) {
                    collectedImages.push(markdownImage);
                }
            });
        }

        if (!collectedImages.length) {
            const directImageUrl = value.url || value.imageUrl || value.normalizedUrl || '';
            const directImage = buildMarkdownImageLine(
                isImageLikePayload(value) && looksLikeEmbeddableImageUrl(directImageUrl) ? directImageUrl : '',
                value.alt || value.prompt || value.caption || value.title || value.query || value.description || value.text || 'Image'
            );
            if (directImage) {
                collectedImages.push(directImage);
            }
        }

        return collectedImages.length ? collectedImages.join('\n\n') : null;
    }

    function scoreFallbackBlocks(blocks = []) {
        return blocks.reduce((score, block) => {
            const type = block?.type;
            if (!type) {
                return score;
            }

            let nextScore = score + 1;
            if (['image', 'ai_image', 'bookmark', 'database', 'chart'].includes(type)) nextScore += 8;
            if (['heading_1', 'heading_2', 'heading_3', 'callout', 'quote'].includes(type)) nextScore += 2;
            if (type === 'divider') nextScore += 0.5;
            if (type === 'code') nextScore -= 0.5;
            return nextScore;
        }, 0);
    }

    function selectPreferredFallbackBlocks(importedBlocks = [], richTextBlocks = []) {
        if (!importedBlocks.length) return richTextBlocks;
        if (!richTextBlocks.length) return importedBlocks;

        const importedHasMedia = importedBlocks.some((block) => ['image', 'ai_image', 'bookmark', 'database', 'chart'].includes(block?.type));
        const richTextHasMedia = richTextBlocks.some((block) => ['image', 'ai_image', 'bookmark', 'database', 'chart'].includes(block?.type));

        if (importedHasMedia !== richTextHasMedia) {
            return importedHasMedia ? importedBlocks : richTextBlocks;
        }

        const importedScore = scoreFallbackBlocks(importedBlocks);
        const richTextScore = scoreFallbackBlocks(richTextBlocks);

        if (importedScore === richTextScore) {
            return richTextBlocks.length >= importedBlocks.length ? richTextBlocks : importedBlocks;
        }

        return richTextScore > importedScore ? richTextBlocks : importedBlocks;
    }

    function countInlineStructuralMarkers(text = '') {
        const matches = String(text || '').match(/\s(?=(?:> |#{1,3}\s+|(?:[-*]|--+)\s+|(?:[-*]\s+)?\[(?: |x|X)\]\s+|\d+\.\s+|\[![a-z_ -]+\]|!\[[^\]]*\]\([^)]+\)|---+))/g);
        return matches ? matches.length : 0;
    }

    function stripMarkdownInlineFormatting(text = '') {
        return String(text || '')
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/__(.+?)__/g, '$1')
            .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
            .replace(/(?<!_)_([^_]+)_(?!_)/g, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function findRawHtmlDocumentStartIndex(source = '') {
        const value = String(source || '');
        const starts = [
            /<!doctype\s+html\b/i,
            /<html\b/i,
            /<head\b/i,
            /<body\b/i,
        ]
            .map((pattern) => {
                const match = pattern.exec(value);
                return Number.isInteger(match?.index) ? match.index : -1;
            })
            .filter((index) => index >= 0);

        return starts.length > 0 ? Math.min(...starts) : -1;
    }

    function looksLikeRawHtmlDocumentSource(source = '') {
        const value = String(source || '').trim();
        if (!value || value.length < 80 || /^```/i.test(value)) {
            return false;
        }

        if (!/^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(value)) {
            return false;
        }

        return /<!doctype\s+html\b/i.test(value)
            || /<html\b/i.test(value)
            || (/<head\b/i.test(value) && /<body\b/i.test(value))
            || /<\/(?:html|body)>/i.test(value);
    }

    function splitRawHtmlDocumentSource(source = '') {
        const value = stripUnsafeNullCharacters(source).replace(/\r\n?/g, '\n').trim();
        if (!value || /^```/i.test(value)) {
            return null;
        }

        const startIndex = findRawHtmlDocumentStartIndex(value);
        if (startIndex < 0) {
            return null;
        }

        const prefix = value.slice(0, startIndex).trim();
        const htmlTail = value.slice(startIndex).trim();
        if (!looksLikeRawHtmlDocumentSource(htmlTail)) {
            return null;
        }

        const closeMatch = htmlTail.match(/<\/html\s*>/i);
        const htmlEndIndex = closeMatch && Number.isInteger(closeMatch.index)
            ? closeMatch.index + closeMatch[0].length
            : htmlTail.length;

        return {
            prefix,
            html: htmlTail.slice(0, htmlEndIndex).trim(),
            suffix: htmlTail.slice(htmlEndIndex).trim(),
        };
    }

    function stripHtmlDocumentLeadIn(prefix = '') {
        const safePrefix = stripInternalHtmlDocumentPreface(prefix);
        return String(safePrefix || '')
            .replace(/```html\s*$/i, '')
            .replace(/\b(?:here(?:'s| is)?|below is|this is)\s+the\s+(?:full\s+)?html\s+(?:source|code|document)\s*(?:for|of)?\s*$/i, '')
            .replace(/\b(?:full\s+)?html\s+(?:source|code|document|preview)\s*:?\s*$/i, '')
            .replace(/\bhtml\s+document\s*$/i, '')
            .replace(/\b[a-z0-9._-]+\.html\s*$/i, '')
            .replace(/[:\-]+$/g, '')
            .trim();
    }

    function stripInternalHtmlDocumentPreface(prefix = '') {
        const text = stripUnsafeNullCharacters(prefix).trim();
        if (!text) {
            return '';
        }

        if (/(?:^|\n)\s*(?:analysis|reasoning|thinking|chain of thought|internal planning|diagnostics?|raw details|trace id|diagnostic code|provider_or_backend_error|model request failed|image request received|\+\d+ms)\b/i.test(text)
            || /\bPAGE REASONING (?:MAP|RULES)\b/i.test(text)
            || /\bworking in background\b/i.test(text)
            || (/^(?:i(?:'|’|â€™)?ll|i will|let me)\b/i.test(text)
                && /\b(?:rebuild|build|return|deliver|compose|create|html|page|artifact|viewer|clean)\b/i.test(text))) {
            return '';
        }

        return text;
    }

    function stripHtmlDocumentSuffix(suffix = '') {
        const text = stripUnsafeNullCharacters(suffix).trim();
        if (!text) {
            return '';
        }

        if (/^```+\s*$/i.test(text)
            || /^```+\s*(?:done|here you go|ready|finished)[.!]?\s*$/i.test(text)
            || /^(?:done|here you go|ready|finished)[.!]?\s*$/i.test(text)
            || stripInternalHtmlDocumentPreface(text) === '') {
            return '';
        }

        return text;
    }

    function extractTitleFromRawHtmlDocument(html = '') {
        const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        return String(match?.[1] || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function buildBlocksFromRawHtmlDocument(sourceText = '') {
        const split = splitRawHtmlDocumentSource(sourceText);
        if (!split?.html) {
            return [];
        }

        const prefixTitle = stripHtmlDocumentLeadIn(split.prefix);
        const htmlTitle = extractTitleFromRawHtmlDocument(split.html);
        const blocks = [];
        const title = prefixTitle || htmlTitle;
        if (title) {
            blocks.push({
                type: 'heading_1',
                content: title,
            });
        }

        blocks.push({
            type: 'code',
            content: {
                language: 'html',
                text: split.html,
            },
        });

        const suffixText = stripHtmlDocumentSuffix(split.suffix);
        if (suffixText) {
            blocks.push({
                type: 'text',
                content: stripMarkdownInlineFormatting(suffixText),
            });
        }

        return blocks;
    }

    function isRawHtmlSourceCodeBlock(block = null) {
        if (!block || canonicalizeBlockType(block.type || '') !== 'code') {
            return false;
        }

        const content = block.content && typeof block.content === 'object'
            ? block.content
            : { text: block.content, language: '' };
        return String(content.language || '').trim().toLowerCase() === 'html'
            && looksLikeRawHtmlDocumentSource(content.text || '');
    }

    function isRawHtmlSourceOnlyBlocks(blocks = []) {
        const list = Array.isArray(blocks) ? blocks : [];
        if (!list.some((block) => isRawHtmlSourceCodeBlock(block))) {
            return false;
        }

        return list.every((block) => {
            const type = canonicalizeBlockType(block?.type || '');
            return type === 'code' || type === 'heading_1' || type === 'text';
        });
    }

    function normalizeMarkdownTextForBlockType(type = 'text', value = '') {
        const normalizedType = canonicalizeBlockType(type);
        const source = String(value || '').trim();
        if (!source) {
            return '';
        }

        let cleaned = source;
        switch (normalizedType) {
            case 'heading_1':
            case 'heading_2':
            case 'heading_3':
                cleaned = cleaned.replace(/^#{1,3}\s+/, '');
                break;
            case 'bulleted_list':
                cleaned = cleaned.replace(/^(?:[-*]|--+)\s+/, '');
                break;
            case 'numbered_list':
                cleaned = cleaned.replace(/^\d+\.\s+/, '');
                break;
            case 'todo':
                cleaned = cleaned.replace(/^(?:[-*]\s+)?\[(?: |x|X)\]\s+/, '');
                break;
            case 'quote':
                cleaned = cleaned.replace(/^>\s+/, '');
                break;
            case 'callout':
                cleaned = cleaned
                    .replace(/^\[![a-z_ -]+\]\s*/i, '')
                    .replace(/^>\s+/, '');
                break;
            default:
                break;
        }

        return stripMarkdownInlineFormatting(cleaned);
    }

    function inferMarkdownLikeSingleLineBlock(value = '', fallbackType = 'text') {
        const normalized = String(value || '').trim();
        if (!normalized || /\n/.test(normalized)) {
            return null;
        }

        const todoMatch = normalized.match(/^(?:[-*]\s+)?\[( |x|X)\]\s+(.+)$/);
        if (todoMatch) {
            return {
                type: 'todo',
                content: {
                    text: normalizeMarkdownTextForBlockType('todo', todoMatch[2]),
                    checked: /x/i.test(todoMatch[1]),
                },
            };
        }

        const headingMatch = normalized.match(/^(#{1,3})\s+(.+)$/);
        if (headingMatch) {
            return {
                type: `heading_${Math.min(headingMatch[1].length, 3)}`,
                content: normalizeMarkdownTextForBlockType('text', headingMatch[2]),
            };
        }

        const strongHeadingMatch = normalized.match(/^\*\*(.+?)\*\*$/);
        if (canonicalizeBlockType(fallbackType) === 'text' && strongHeadingMatch) {
            const headingText = stripMarkdownInlineFormatting(strongHeadingMatch[1]);
            if (headingText && headingText.split(/\s+/).length <= 8 && !/[.!?]$/.test(headingText)) {
                return {
                    type: 'heading_2',
                    content: headingText,
                };
            }
        }

        const calloutLabelMatch = normalized.match(/^\*\*(.+?)\*\*:?\s+(.+)$/);
        const calloutLabel = stripMarkdownInlineFormatting(calloutLabelMatch?.[1] || '').replace(/:\s*$/, '');
        if (canonicalizeBlockType(fallbackType) === 'text' && calloutLabelMatch
            && /\b(big idea|key takeaway|takeaway|summary|important|warning|note|why it matters|bottom line)\b/i.test(calloutLabel)) {
            return {
                type: 'callout',
                content: {
                    text: stripMarkdownInlineFormatting(`${calloutLabel}: ${calloutLabelMatch[2]}`),
                    icon: '!',
                },
            };
        }

        const bulletMatch = normalized.match(/^(?:[-*]|--+)\s+(.+)$/);
        if (bulletMatch) {
            return {
                type: 'bulleted_list',
                content: normalizeMarkdownTextForBlockType('bulleted_list', bulletMatch[1]),
            };
        }

        const numberedMatch = normalized.match(/^\d+\.\s+(.+)$/);
        if (numberedMatch) {
            return {
                type: 'numbered_list',
                content: normalizeMarkdownTextForBlockType('numbered_list', numberedMatch[1]),
            };
        }

        const quoteMatch = normalized.match(/^>\s+(.+)$/);
        if (quoteMatch) {
            return {
                type: 'quote',
                content: normalizeMarkdownTextForBlockType('quote', quoteMatch[1]),
            };
        }

        if (/^---+$/.test(normalized)) {
            return {
                type: 'divider',
                content: '',
            };
        }

        return null;
    }

    function normalizeMarkdownLikeBlockDefinition(blockDefinition, options = {}) {
        if (!blockDefinition || typeof blockDefinition !== 'object') {
            return blockDefinition;
        }

        const defaultType = options.defaultType || 'text';
        const normalized = {
            ...blockDefinition,
        };
        let type = canonicalizeBlockType(normalized.type || defaultType);

        const hasExplicitContent = Object.prototype.hasOwnProperty.call(normalized, 'content');
        const hasExplicitText = Object.prototype.hasOwnProperty.call(normalized, 'text');
        const contentValue = hasExplicitContent
            ? normalized.content
            : (hasExplicitText ? normalized.text : '');

        if (typeof contentValue === 'string') {
            const rawHtmlSplit = splitRawHtmlDocumentSource(contentValue);
            if ((type === 'text' || type === 'code') && rawHtmlSplit?.html) {
                type = 'code';
                normalized.content = {
                    language: 'html',
                    text: rawHtmlSplit.html,
                };
                delete normalized.text;
            } else if ((type === 'text' || type === 'code' || type === 'mermaid') && looksLikeMermaidSource(contentValue)) {
                const mermaidSource = normalizeMermaidSourceText(contentValue);
                type = 'mermaid';
                normalized.content = {
                    text: mermaidSource,
                    diagramType: detectMermaidDiagramType(mermaidSource),
                };
                delete normalized.text;
            } else {
                const inferred = inferMarkdownLikeSingleLineBlock(contentValue, type);
                if (inferred && (type === 'text' || inferred.type === type || ['heading_1', 'heading_2', 'heading_3', 'bulleted_list', 'numbered_list', 'todo', 'quote', 'callout', 'divider'].includes(inferred.type))) {
                    type = inferred.type;
                    normalized.content = inferred.content;
                    delete normalized.text;
                } else {
                    normalized.content = normalizeMarkdownTextForBlockType(type, contentValue);
                    delete normalized.text;
                }
            }
        } else if (type === 'todo' && contentValue && typeof contentValue === 'object') {
            normalized.content = {
                ...contentValue,
                text: normalizeMarkdownTextForBlockType('todo', contentValue.text || ''),
            };
        } else if (type === 'callout' && contentValue && typeof contentValue === 'object') {
            normalized.content = {
                ...contentValue,
                text: normalizeMarkdownTextForBlockType('callout', contentValue.text || contentValue.content || contentValue.message || ''),
            };
        } else if (type === 'image' && contentValue && typeof contentValue === 'object') {
            normalized.content = {
                url: String(contentValue.url || contentValue.imageUrl || contentValue.image_url || contentValue.normalizedUrl || contentValue.downloadUrl || ''),
                caption: coerceTextValue(contentValue.caption || contentValue.alt || contentValue.text || ''),
            };
        } else if (['heading_1', 'heading_2', 'heading_3', 'bulleted_list', 'numbered_list', 'quote', 'text'].includes(type) && typeof contentValue === 'string') {
            normalized.content = normalizeMarkdownTextForBlockType(type, contentValue);
        }

        normalized.type = type;
        const normalizedColor = normalizeNotesColor(
            Object.prototype.hasOwnProperty.call(normalized, 'color')
                ? normalized.color
                : (normalized.backgroundColor ?? normalized.bgColor)
        );
        if (normalizedColor) {
            normalized.color = normalizedColor;
        } else {
            delete normalized.color;
        }

        const normalizedTextColor = normalizeNotesColor(normalized.textColor);
        if (normalizedTextColor) {
            normalized.textColor = normalizedTextColor;
        } else {
            delete normalized.textColor;
        }

        const normalizedFontFamily = normalizeNotesFontFamily(normalized.fontFamily);
        if (normalizedFontFamily) {
            normalized.fontFamily = normalizedFontFamily;
        } else {
            delete normalized.fontFamily;
        }

        const normalizedFontSize = normalizeNotesFontSize(normalized.fontSize);
        if (normalizedFontSize) {
            normalized.fontSize = normalizedFontSize;
        } else {
            delete normalized.fontSize;
        }

        const normalizedFontWeight = normalizeNotesFontWeight(normalized.fontWeight);
        if (normalizedFontWeight) {
            normalized.fontWeight = normalizedFontWeight;
        } else {
            delete normalized.fontWeight;
        }

        const normalizedTextAlign = normalizeNotesTextAlign(normalized.textAlign);
        if (normalizedTextAlign) {
            normalized.textAlign = normalizedTextAlign;
        } else {
            delete normalized.textAlign;
        }
        if (Array.isArray(normalized.children) && normalized.children.length > 0) {
            normalized.children = normalized.children.map((child) => normalizeMarkdownLikeBlockDefinition(child));
        }
        return normalized;
    }

    function normalizeNotesColor(value) {
        const token = normalizeLooseStructuredToken(value || '', {
            lowercase: true,
            spacesToUnderscore: true,
        });
        if (!token || token === 'default' || token === 'none' || token === 'null') {
            return null;
        }

        if (NOTES_COLOR_OPTIONS.includes(token)) {
            return token;
        }

        const compact = token.replace(/_/g, '');
        const matchedColor = NOTES_COLOR_OPTIONS.find((color) => (
            compact === `${color}background`
            || compact === `${color}bg`
            || compact === `${color}text`
            || compact === `${color}color`
            || compact.includes(color)
        ));
        return matchedColor || null;
    }

    function normalizeNotesFontFamily(value) {
        const token = normalizeLooseStructuredToken(value || '', {
            lowercase: true,
            spacesToUnderscore: true,
        });
        if (!token || token === 'default' || token === 'none' || token === 'null') {
            return null;
        }

        const compact = token.replace(/_/g, '');
        const aliases = {
            sans: 'sans',
            sansserif: 'sans',
            system: 'sans',
            default: null,
            serif: 'serif',
            georgia: 'serif',
            editorial: 'serif',
            mono: 'mono',
            monospace: 'mono',
            code: 'mono',
        };
        return NOTES_FONT_FAMILY_OPTIONS.includes(token)
            ? token
            : (aliases[compact] || null);
    }

    function normalizeNotesFontSize(value) {
        const token = normalizeLooseStructuredToken(value || '', {
            lowercase: true,
            spacesToUnderscore: true,
        });
        if (!token || token === 'default' || token === 'none' || token === 'null') {
            return null;
        }

        const compact = token.replace(/_/g, '');
        const aliases = {
            small: 'small',
            sm: 'small',
            normal: 'normal',
            regular: 'normal',
            medium: 'normal',
            large: 'large',
            lg: 'large',
            xlarge: 'xlarge',
            xl: 'xlarge',
            extralarge: 'xlarge',
            display: 'xlarge',
        };
        return NOTES_FONT_SIZE_OPTIONS.includes(token)
            ? token
            : (aliases[compact] || null);
    }

    function normalizeNotesFontWeight(value) {
        const token = normalizeLooseStructuredToken(value || '', {
            lowercase: true,
            spacesToUnderscore: true,
        });
        if (!token || token === 'default' || token === 'none' || token === 'null') {
            return null;
        }

        const compact = token.replace(/_/g, '');
        const aliases = {
            regular: 'regular',
            normal: 'regular',
            medium: 'medium',
            semibold: 'semibold',
            semi: 'semibold',
            strong: 'semibold',
            bold: 'bold',
            heavy: 'bold',
        };
        return NOTES_FONT_WEIGHT_OPTIONS.includes(token)
            ? token
            : (aliases[compact] || null);
    }

    function normalizeNotesTextAlign(value) {
        const token = normalizeLooseStructuredToken(value || '', {
            lowercase: true,
            spacesToUnderscore: true,
        });
        if (!token || token === 'default' || token === 'none' || token === 'null') {
            return null;
        }

        const compact = token.replace(/_/g, '');
        const aliases = {
            left: 'left',
            start: 'left',
            center: 'center',
            centered: 'center',
            middle: 'center',
            right: 'right',
            end: 'right',
        };
        return NOTES_TEXT_ALIGN_OPTIONS.includes(token)
            ? token
            : (aliases[compact] || null);
    }

    function normalizeNotesHighlightColor(value) {
        return normalizeNotesColor(value) || (
            NOTES_HIGHLIGHT_COLOR_OPTIONS.includes(String(value || '').toLowerCase())
                ? String(value || '').toLowerCase()
                : null
        );
    }

    function normalizeMarkdownLikeBlockDefinitions(blockDefinitions = []) {
        if (!Array.isArray(blockDefinitions) || blockDefinitions.length === 0) {
            return [];
        }

        return blockDefinitions.map((blockDefinition) => normalizeMarkdownLikeBlockDefinition(blockDefinition));
    }

    function looksLikeCollapsedStructuredMarkdown(sourceText = '') {
        const normalized = String(sourceText || '').replace(/\r\n/g, '\n').trim();
        if (!normalized) {
            return false;
        }

        const lineCount = normalized.split('\n').filter(Boolean).length;
        const inlineMarkerCount = countInlineStructuralMarkers(normalized);

        if (inlineMarkerCount < 2) {
            return false;
        }

        return lineCount <= 3;
    }

    function normalizeCollapsedStructuredMarkdown(sourceText = '') {
        let value = stripUnsafeNullCharacters(sourceText).replace(/\r\n/g, '\n').trim();
        if (!looksLikeCollapsedStructuredMarkdown(value)) {
            return value;
        }

        const inlineMarkerPattern = /\s(?=(?:> |#{1,3}\s+|[-*]\s+|\d+\.\s+|\[![a-z_ -]+\]|!\[[^\]]*\]\([^)]+\)|---+))/g;
        const firstMarkerIndex = value.search(inlineMarkerPattern);
        const leadingChunk = firstMarkerIndex > 0 ? value.slice(0, firstMarkerIndex).trim() : '';
        const markerAfterLeadingChunk = firstMarkerIndex > 0 ? value.slice(firstMarkerIndex + 1).trimStart() : '';

        value = value.replace(inlineMarkerPattern, '\n');

        if (leadingChunk
            && leadingChunk.length <= 120
            && !/^#{1,3}\s+/.test(leadingChunk)
            && !isStructuralTextBoundary(leadingChunk)
            && !/[.:;]$/.test(leadingChunk)
            && /^(?:> |#{1,3}\s+|[-*]\s+|\d+\.\s+)/.test(markerAfterLeadingChunk)) {
            value = `# ${leadingChunk}\n${value.slice(leadingChunk.length).trim()}`;
        }

        return value
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n[ \t]+/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function buildBlocksFromRichText(sourceText = '') {
        const text = normalizeCollapsedStructuredMarkdown(sourceText);
        if (!text) {
            return [];
        }

        const blocks = [];
        const lines = text.split('\n');
        let index = 0;
        let usedTitle = false;

        const splitInlineHeadingLine = (line = '') => {
            const normalized = String(line || '').trim();
            const markerMatch = normalized.match(/^(#{1,3})\s+(.+)$/);
            if (!markerMatch) {
                return null;
            }

            const body = markerMatch[2].trim();
            const punctuationSplit = body.match(/^(.+?[?!])\s+(.+)$/);
            if (punctuationSplit && punctuationSplit[1].split(/\s+/).length <= 10) {
                return {
                    heading: punctuationSplit[1].trim(),
                    remainder: punctuationSplit[2].trim(),
                };
            }

            const titleCaseSplit = body.match(/^((?:[A-Z][a-z'’\-]*\s+){1,5}[A-Z][a-z'’\-]*)\s+([A-Z][\s\S]+)$/);
            if (titleCaseSplit) {
                const headingWords = titleCaseSplit[1].trim().split(/\s+/).length;
                const remainderWords = titleCaseSplit[2].trim().split(/\s+/).length;
                if (headingWords <= 5 && remainderWords >= 3) {
                    return {
                        heading: titleCaseSplit[1].trim(),
                        remainder: titleCaseSplit[2].trim(),
                    };
                }
            }

            return null;
        };

        while (index < lines.length) {
            const rawLine = lines[index];
            const line = rawLine.trim();

            if (!line) {
                index += 1;
                continue;
            }

            if (/^```/.test(line)) {
                const language = line.slice(3).trim() || 'plain';
                const codeLines = [];
                index += 1;
                while (index < lines.length && !/^```/.test(lines[index].trim())) {
                    codeLines.push(lines[index]);
                    index += 1;
                }
                if (index < lines.length) {
                    index += 1;
                }
                if (/^mermaid$/i.test(language)) {
                    const mermaidSource = normalizeMermaidSourceText(codeLines.join('\n'));
                    blocks.push({
                        type: 'mermaid',
                        content: {
                            text: mermaidSource,
                            diagramType: detectMermaidDiagramType(mermaidSource),
                        },
                    });
                    continue;
                }
                blocks.push({
                    type: 'code',
                    content: {
                        language,
                        text: codeLines.join('\n')
                    }
                });
                continue;
            }

            const markdownImageBlocks = extractMarkdownImageBlocksFromLine(line);
            if (markdownImageBlocks.length > 0) {
                blocks.push(...markdownImageBlocks);
                index += 1;
                continue;
            }

            const calloutMatch = line.match(/^\[!([a-z_ -]+)\]$/i);
            if (calloutMatch) {
                const calloutLines = [];
                index += 1;
                while (index < lines.length) {
                    const nextLine = lines[index].trim();
                    if (!nextLine) {
                        if (calloutLines.length > 0) break;
                        index += 1;
                        continue;
                    }
                    if (isStructuralTextBoundary(nextLine)) {
                        break;
                    }
                    calloutLines.push(nextLine);
                    index += 1;
                }
                blocks.push({
                    type: 'callout',
                    content: {
                        text: calloutLines.join(' ').trim() || calloutMatch[1],
                        icon: getCalloutIconForMarker(calloutMatch[1])
                    }
                });
                continue;
            }

            const imagePromptMatch = line.match(/^!\s*(.+)$/);
            if (imagePromptMatch && !/^!\[/.test(line)) {
                blocks.push({
                    type: 'ai_image',
                    content: {
                        prompt: imagePromptMatch[1].trim(),
                        caption: '',
                        imageUrl: null,
                        model: null,
                        size: '1536x1024',
                        quality: null,
                        style: null,
                        source: 'unsplash',
                        status: 'pending',
                        unsplashResults: null,
                        selectedUnsplashId: null,
                        unsplashPhotographer: null,
                        unsplashPhotographerUrl: null,
                        imageAssetId: null
                    }
                });
                index += 1;
                continue;
            }

            if (/^---+$/.test(line)) {
                blocks.push({ type: 'divider', content: '' });
                index += 1;
                continue;
            }

            const headingLevel = inferHeadingLevel(line, !usedTitle);
            const explicitHeadingMatch = line.match(/^#{1,3}\s+/);
            const inlineHeadingSplit = explicitHeadingMatch ? splitInlineHeadingLine(line) : null;
            const nextLine = lines[index + 1]?.trim() || '';
            if (headingLevel && (explicitHeadingMatch || !nextLine || !/^[a-z]/.test(nextLine))) {
                blocks.push({
                    type: headingLevel,
                    content: inlineHeadingSplit
                        ? normalizeMarkdownTextForBlockType('text', inlineHeadingSplit.heading)
                        : normalizeMarkdownTextForBlockType(headingLevel, line)
                });
                usedTitle = true;
                if (inlineHeadingSplit?.remainder) {
                    blocks.push({
                        type: 'text',
                        content: normalizeMarkdownTextForBlockType('text', inlineHeadingSplit.remainder),
                    });
                }
                index += 1;
                continue;
            }

            if (/^>\s+/.test(line)) {
                blocks.push({
                    type: 'quote',
                    content: normalizeMarkdownTextForBlockType('quote', line)
                });
                index += 1;
                continue;
            }

            if (/^(?:[-*]\s+)?\[(?: |x|X)\]\s+/.test(line)) {
                while (index < lines.length && /^(?:[-*]\s+)?\[(?: |x|X)\]\s+/.test(lines[index].trim())) {
                    const currentLine = lines[index].trim();
                    const todoMatch = currentLine.match(/^(?:[-*]\s+)?\[( |x|X)\]\s+(.+)$/);
                    blocks.push({
                        type: 'todo',
                        content: {
                            text: normalizeMarkdownTextForBlockType('todo', todoMatch?.[2] || ''),
                            checked: /x/i.test(todoMatch?.[1] || ''),
                        }
                    });
                    index += 1;
                }
                continue;
            }

            if (/^(?:[-*]|--+)\s+/.test(line)) {
                while (index < lines.length && /^(?:[-*]|--+)\s+/.test(lines[index].trim())) {
                    blocks.push({
                        type: 'bulleted_list',
                        content: normalizeMarkdownTextForBlockType('bulleted_list', lines[index].trim())
                    });
                    index += 1;
                }
                continue;
            }

            if (/^\d+\.\s+/.test(line)) {
                while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
                    blocks.push({
                        type: 'numbered_list',
                        content: normalizeMarkdownTextForBlockType('numbered_list', lines[index].trim())
                    });
                    index += 1;
                }
                continue;
            }

            const paragraphLines = [line];
            index += 1;
            while (index < lines.length) {
                const next = lines[index].trim();
                if (!next || isStructuralTextBoundary(next) || inferHeadingLevel(next, false)) {
                    break;
                }
                paragraphLines.push(next);
                index += 1;
            }

            blocks.push({
                type: 'text',
                content: normalizeMarkdownTextForBlockType('text', paragraphLines.join(' ').trim())
            });
        }

        return blocks.filter((block) => {
            if (!block || !block.type) return false;
            if (typeof block.content === 'string') return block.content.trim().length > 0 || block.type === 'divider';
            if (block.type === 'callout') return Boolean(block.content?.text);
            if (block.type === 'code') return Boolean(block.content?.text);
            if (block.type === 'ai_image') return Boolean(block.content?.prompt);
            return true;
        });
    }

    function shouldPreferRebuildFallback(question = '', context = null, blocks = [], sourceText = '') {
        const normalized = String(question || '').trim().toLowerCase();
        const existingBlockCount = Number(context?.blockCount || 0);
        const generatedBlockCount = Array.isArray(blocks) ? blocks.length : 0;
        const substantialText = String(sourceText || '').trim().length > 500;
        const structuralRequest = /\b(create|make|build|draft|write|expand|fill out|flesh out|turn|convert|organize|restructure|report|brief|spec|plan|guide|proposal|page)\b/.test(normalized);
        const explicitPageReset = /\b(rebuild|from scratch|start over|replace (?:the )?(?:whole |entire )?page|wipe (?:the )?page|reset (?:the )?page|clear (?:the )?page)\b/.test(normalized);
        const incrementalEdit = /\b(add|additional|more|continue|insert|include|also|between|after|before|here|next|follow-up|follow up|extend)\b/.test(normalized);

        return pageHasOnlyPlaceholderContent()
            || (explicitPageReset && generatedBlockCount >= 2)
            || (!incrementalEdit && generatedBlockCount >= 4 && existingBlockCount <= 3 && structuralRequest)
            || (substantialText && existingBlockCount <= 2);
    }

    function buildFallbackNotesActionsFromText(question = '', sourceText = '', context = null) {
        if (looksLikeInternalNotesScaffold(sourceText)) {
            return null;
        }

        const { importedPage, blocks } = extractPreferredBlocksFromSourceText(sourceText);

        if (!blocks.length) {
            return null;
        }

        const actions = [];
        const importedTitle = String(importedPage?.title || '').trim();
        const currentPage = window.Editor?.getCurrentPage?.();
        const currentTitle = String(currentPage?.title || '').trim();

        if (importedTitle && (!currentTitle || /^untitled$/i.test(currentTitle))) {
            actions.push({
                op: 'update_page',
                title: importedTitle
            });
        }

        if (shouldPreferRebuildFallback(question, context, blocks, sourceText)) {
            const rebuildAction = {
                op: 'rebuild_page',
                blocks
            };

            if (importedTitle) {
                rebuildAction.title = importedTitle;
            }

            actions.push(rebuildAction);
        } else if (pageHasOnlyPlaceholderContent()) {
            const firstBlockId = getPageRootBlocks()[0]?.id || null;
            if (firstBlockId) {
                actions.push({
                    op: 'replace_block',
                    blockId: firstBlockId,
                    blocks
                });
            } else {
                actions.push({
                    op: 'append_to_page',
                    blocks
                });
            }
        } else {
            actions.push({
                op: 'append_to_page',
                blocks
            });
        }

        return actions;
    }

    function extractPreferredBlocksFromSourceText(sourceText = '') {
        const directRawHtmlBlocks = buildBlocksFromRawHtmlDocument(sourceText);
        if (directRawHtmlBlocks.length > 0) {
            const titleBlock = directRawHtmlBlocks.find((block) => block?.type === 'heading_1');
            return {
                importedPage: {
                    title: titleBlock?.content || extractTitleFromRawHtmlDocument(directRawHtmlBlocks.find((block) => block?.type === 'code')?.content?.text || ''),
                    blocks: directRawHtmlBlocks,
                },
                blocks: directRawHtmlBlocks,
            };
        }

        const normalizedSourceText = normalizeCollapsedStructuredMarkdown(sourceText);
        const rawHtmlBlocks = buildBlocksFromRawHtmlDocument(normalizedSourceText);
        if (rawHtmlBlocks.length > 0) {
            const titleBlock = rawHtmlBlocks.find((block) => block?.type === 'heading_1');
            return {
                importedPage: {
                    title: titleBlock?.content || extractTitleFromRawHtmlDocument(rawHtmlBlocks.find((block) => block?.type === 'code')?.content?.text || ''),
                    blocks: rawHtmlBlocks,
                },
                blocks: rawHtmlBlocks,
            };
        }

        const importedPage = window.ImportExport?.importFromMarkdown?.(normalizedSourceText);
        const importedBlocks = Array.isArray(importedPage?.blocks)
            ? importedPage.blocks.filter((block) => extractBlockTextValue(block).trim() || ['divider', 'image', 'ai_image'].includes(block.type))
            : [];
        const richTextBlocks = buildBlocksFromRichText(normalizedSourceText);

        return {
            importedPage,
            blocks: selectPreferredFallbackBlocks(importedBlocks, richTextBlocks)
        };
    }

    function buildFallbackPageEditResponse(question = '', responseText = '', context = null) {
        const directResponse = unwrapGenericResponseContent(responseText);
        const preferredSource = directResponse && !looksLikeShortAcknowledgement(directResponse)
            ? directResponse
            : getLastSubstantialAssistantMessage(directResponse);
        const actions = buildFallbackNotesActionsFromText(question, preferredSource, context);

        if (!actions || actions.length === 0) {
            return null;
        }

        return {
            displayText: /blank page|place it on|put it on|add it to|insert it into/i.test(String(question || '').toLowerCase())
                ? 'Placed that on the page.'
                : 'Added that to the page.',
            appliedCount: applyNotesActions(actions).appliedCount
        };
    }

    function splitPlainTextIntoParagraphBlocks(sourceText = '') {
        const normalized = stripUnsafeNullCharacters(sourceText).replace(/\s+/g, ' ').trim();
        if (!normalized || normalized.length < 320) {
            return [];
        }

        const sentences = normalized.match(/[^.!?]+(?:[.!?]+|$)/g)
            ?.map((sentence) => sentence.trim())
            .filter(Boolean) || [];
        if (sentences.length < 2) {
            return [];
        }

        const blocks = [];
        let currentChunk = '';

        sentences.forEach((sentence) => {
            const nextChunk = currentChunk ? `${currentChunk} ${sentence}` : sentence;
            const sentenceCount = currentChunk ? currentChunk.match(/[^.!?]+(?:[.!?]+|$)/g)?.length || 0 : 0;
            if (currentChunk && (nextChunk.length > 260 || sentenceCount >= 2)) {
                blocks.push({
                    type: 'text',
                    content: currentChunk.trim()
                });
                currentChunk = sentence;
                return;
            }

            currentChunk = nextChunk;
        });

        if (currentChunk.trim()) {
            blocks.push({
                type: 'text',
                content: currentChunk.trim()
            });
        }

        return blocks.length > 1 ? blocks : [];
    }

    function shouldExpandSingleBlockText(sourceText = '', question = '', context = null) {
        const normalized = stripUnsafeNullCharacters(sourceText).trim();
        if (!normalized) {
            return false;
        }

        if (/\n\s*\n/.test(normalized) || /^#{1,3}\s+/m.test(normalized) || /^[-*]\s+/m.test(normalized) || /^\d+\.\s+/m.test(normalized)) {
            return true;
        }

        return shouldForcePageEditActions(question, context, {}) && normalized.length >= 320;
    }

    function expandStructuredPageTextIntoBlocks(sourceText = '', question = '', context = null) {
        const normalized = stripUnsafeNullCharacters(sourceText).trim();
        if (!normalized) {
            return [];
        }

        const preferredBlocks = extractPreferredBlocksFromSourceText(normalized).blocks;
        if (preferredBlocks.length > 1 || preferredBlocks.some((block) => block?.type !== 'text')) {
            return preferredBlocks;
        }

        if (!shouldExpandSingleBlockText(normalized, question, context)) {
            return preferredBlocks;
        }

        const paragraphBlocks = splitPlainTextIntoParagraphBlocks(normalized);
        return paragraphBlocks.length > 1 ? paragraphBlocks : preferredBlocks;
    }

    function normalizeStructuredPageActions(actions = [], question = '', context = null, toolEvents = []) {
        if (!Array.isArray(actions) || actions.length === 0) {
            return [];
        }

        const expandedActions = actions.map((action) => {
            if (!action || typeof action !== 'object') {
                return action;
            }

            const op = String(action.op || '').trim().toLowerCase();
            const blockDefinitions = Array.isArray(action.blocks)
                ? action.blocks
                : (action.block && typeof action.block === 'object' ? [action.block] : []);

            const getSingleTextSource = (block) => {
                if (!block || typeof block !== 'object') {
                    return '';
                }

                const type = canonicalizeBlockType(block.type || action.type || 'text');
                if (type !== 'text') {
                    return '';
                }

                if (typeof block.content === 'string') {
                    return block.content;
                }

                if (typeof block.text === 'string') {
                    return block.text;
                }

                return '';
            };

            if (op === 'update_block') {
                const sourceText = typeof action.content === 'string'
                    ? action.content
                    : (typeof action.text === 'string' ? action.text : '');
                const expandedBlocks = expandStructuredPageTextIntoBlocks(sourceText, question, context);
                if (expandedBlocks.length > 1) {
                    return {
                        ...action,
                        op: 'replace_block',
                        blocks: expandedBlocks,
                    };
                }
                if (sourceText) {
                    const normalizedBlock = normalizeMarkdownLikeBlockDefinition({
                        type: action.type || 'text',
                        content: sourceText,
                        formatting: action.formatting,
                        color: action.color,
                        textColor: action.textColor,
                    }, {
                        defaultType: action.type || 'text',
                    });

                    return {
                        ...action,
                        type: normalizedBlock.type,
                        content: normalizedBlock.content,
                    };
                }
                return action;
            }

            if (![
                'replace_block',
                'replace_section',
                'rebuild_page',
                'append_to_page',
                'prepend_to_page',
                'insert_after',
                'insert_before',
                'insert_here',
                'insert_between_sections',
                'insert_after_section',
                'insert_before_section',
            ].includes(op)) {
                return action;
            }

            if (blockDefinitions.length !== 1) {
                if (blockDefinitions.length === 0) {
                    return action;
                }

                return {
                    ...action,
                    blocks: normalizeMarkdownLikeBlockDefinitions(blockDefinitions),
                };
            }

            const sourceText = getSingleTextSource(blockDefinitions[0]);
            const expandedBlocks = expandStructuredPageTextIntoBlocks(sourceText, question, context);
            if (expandedBlocks.length <= 1) {
                return {
                    ...action,
                    blocks: normalizeMarkdownLikeBlockDefinitions(blockDefinitions),
                };
            }

            return {
                ...action,
                blocks: normalizeMarkdownLikeBlockDefinitions(expandedBlocks),
            };
        });

        return enhanceStructuredPageActions(expandedActions, question, context, toolEvents);
    }

    async function repairNotesPageEditResponse({
        apiClient,
        model,
        systemPrompt,
        question,
        previousResponse,
        requestOptions = {},
    }) {
        const repairPrompt = `${systemPrompt}

Repair pass: the previous assistant reply did not apply changes to the current notes page.
Return only a valid JSON notes-actions payload.
Do not return plain chat prose outside the JSON payload.
If the previous reply drifted into HTML, artifact creation, download links, or standalone file language, ignore that and convert the answer into direct page edits.
If the request adds to an existing page, prefer insert_here, insert_between_sections, insert_after_section, replace_section, or replace_block over rebuild_page.
Use rebuild_page only when the user explicitly asked to reset or replace the whole page.`;

        const repairResponse = await apiClient.chat([
            { role: 'system', content: repairPrompt },
            {
                role: 'user',
                content: `Original request:\n${question}\n\nPrevious failed reply:\n${previousResponse || '(empty)'}\n\nReturn notes-actions that directly update the current notes page.`
            }
        ], model, requestOptions);

        if (repairResponse?.error) {
            throw new Error(repairResponse.content || 'Notes repair pass failed');
        }

        return repairResponse?.content || '';
    }

    function summarizeAppliedNotesActions(actions = [], appliedCount = 0) {
        const normalizedActions = Array.isArray(actions) ? actions : [];
        if (normalizedActions.length === 0 || appliedCount <= 0) {
            return '';
        }

        const insertedBlockCount = normalizedActions.reduce((total, action) => {
            if (Array.isArray(action?.blocks)) {
                return total + action.blocks.length;
            }
            return total + (action?.content ? 1 : 0);
        }, 0);

        if (normalizedActions.some((action) => action?.op === 'rebuild_page' || action?.op === 'replace_page')) {
            return insertedBlockCount > 0
                ? `Rebuilt the page with ${insertedBlockCount} block${insertedBlockCount === 1 ? '' : 's'}.`
                : 'Rebuilt the page structure.';
        }

        if (normalizedActions.some((action) => action?.op === 'replace_block')) {
            return insertedBlockCount > 0
                ? `Reworked the page with ${insertedBlockCount} updated block${insertedBlockCount === 1 ? '' : 's'}.`
                : `Updated ${appliedCount} page change${appliedCount === 1 ? '' : 's'}.`;
        }

        if (normalizedActions.some((action) => ['replace_section', 'delete_section', 'delete_here', 'move_section', 'insert_after_section', 'insert_before_section', 'insert_between_sections', 'insert_here'].includes(action?.op))) {
            return `Updated ${appliedCount} section-level page change${appliedCount === 1 ? '' : 's'}.`;
        }

        if (normalizedActions.some((action) => ['append_to_page', 'prepend_to_page', 'insert_after', 'insert_before'].includes(action?.op))) {
            return insertedBlockCount > 0
                ? `Added ${insertedBlockCount} new block${insertedBlockCount === 1 ? '' : 's'} to the page.`
                : `Added content to the page in ${appliedCount} step${appliedCount === 1 ? '' : 's'}.`;
        }

        if (normalizedActions.some((action) => action?.op === 'update_block')) {
            return `Updated ${appliedCount} block${appliedCount === 1 ? '' : 's'} on the page.`;
        }

        return `Applied ${appliedCount} page change${appliedCount === 1 ? '' : 's'}.`;
    }

    function normalizeHiddenDraftResult(text = '', fallback = null) {
        const parsed = safeJsonParse(text);
        if (isValidHiddenDraftPayload(parsed)) {
            return JSON.stringify(parsed, null, 2);
        }

        return fallback;
    }

    function parseHiddenDraftPayload(text = '', fallback = null) {
        const parsed = safeJsonParse(text);
        if (isValidHiddenDraftPayload(parsed)) {
            return parsed;
        }

        return isValidHiddenDraftPayload(fallback) ? fallback : null;
    }

    function normalizeSectionAgentExpansionPayload(payload = null, fallbackSection = {}, index = 0) {
        const section = payload && typeof payload === 'object' && !Array.isArray(payload)
            ? payload
            : {};
        const heading = String(section.heading || fallbackSection.heading || `Section ${index + 1}`).trim();
        const anchorHint = String(section.anchorHint || fallbackSection.anchorHint || '').trim();
        const suggestedBlocks = Array.isArray(section.suggestedBlocks) && section.suggestedBlocks.length > 0
            ? section.suggestedBlocks
            : (Array.isArray(fallbackSection.suggestedBlocks) && fallbackSection.suggestedBlocks.length > 0
                ? fallbackSection.suggestedBlocks
                : []);
        const keyPoints = Array.isArray(section.keyPoints) && section.keyPoints.length > 0
            ? section.keyPoints
            : (Array.isArray(fallbackSection.keyPoints) ? fallbackSection.keyPoints : []);
        const summary = String(section.summary || section.goal || fallbackSection.summary || fallbackSection.goal || '').trim();
        const agentRole = String(
            section.agentRole
            || fallbackSection.agentRole
            || (index === 0 ? 'lead-section-agent' : `section-agent-${index + 1}`)
        ).trim();

        return {
            ...fallbackSection,
            ...section,
            heading,
            anchorHint,
            agentRole,
            summary,
            keyPoints,
            suggestedBlocks,
        };
    }

    async function buildParallelSectionExpansionPayload({
        planningClient,
        model,
        systemPrompt,
        question,
        requestOptions = {},
        plan = null,
    }) {
        const sections = Array.isArray(plan?.sections) ? plan.sections : [];
        if (!planningClient?.chat || sections.length < 2) {
            return null;
        }

        const maxParallelSectionAgents = 6;
        const sectionAgents = sections.slice(0, maxParallelSectionAgents);
        const remainingSections = sections.slice(maxParallelSectionAgents).map((section, index) => normalizeSectionAgentExpansionPayload(
            section,
            section,
            index + maxParallelSectionAgents
        ));

        const sectionAgentPrompt = `${systemPrompt}

Hidden section-agent expansion pass for a substantial notes-writing request.
Do not return notes-actions in this pass.
You are one independent section agent working from the shared design pass.
Work only on the assigned section, keep its heading anchor stable, and produce blocks that can be merged with other section agents.
Return JSON only in this shape:
{
  "heading": "Section heading",
  "anchorHint": "Reuse [block_id] or create a new section",
  "agentRole": "lead-section-agent | evidence-section-agent | closeout-section-agent",
  "summary": "Detailed summary of what this section should say",
  "keyPoints": ["Point 1", "Point 2"],
  "suggestedBlocks": [
    { "type": "heading_2", "content": "Section heading" },
    { "type": "text", "content": "Opening paragraph guidance" }
  ],
  "handoffNotes": ["Any consistency notes for the final page assembler"]
}`;

        const expansionTasks = sectionAgents.map(async (section, index) => {
            try {
                const response = await planningClient.chat([
                    { role: 'system', content: sectionAgentPrompt },
                    {
                        role: 'user',
                        content: `Original request:
${question}

Shared design and architecture pass:
${JSON.stringify(plan, null, 2)}

Assigned section ${index + 1} of ${sections.length}:
${JSON.stringify(section, null, 2)}`
                    }
                ], model, requestOptions);

                if (response?.error) {
                    throw new Error(response.content || 'Section expansion failed');
                }

                return normalizeSectionAgentExpansionPayload(
                    safeJsonParse(response?.content || ''),
                    section,
                    index
                );
            } catch (error) {
                console.warn('Section-agent expansion failed:', error);
                return normalizeSectionAgentExpansionPayload({
                    ...section,
                    agentRole: section.agentRole || `section-agent-${index + 1}`,
                    handoffNotes: [
                        ...(Array.isArray(section.handoffNotes) ? section.handoffNotes : []),
                        'Section expansion fell back to the architecture pass.',
                    ],
                }, section, index);
            }
        });

        const expandedSections = await Promise.all(expansionTasks);
        return {
            ...plan,
            editMode: plan.editMode || 'hybrid_refresh',
            sections: [
                ...expandedSections,
                ...remainingSections,
            ],
            sectionAgentMode: 'parallel',
            sectionAgentLimit: maxParallelSectionAgents,
        };
    }

    function buildHiddenDraftApplicationBrief(planText = '', expansionText = '') {
        const plan = safeJsonParse(planText);
        const expansion = safeJsonParse(expansionText);
        const sections = Array.isArray(expansion?.sections) && expansion.sections.length > 0
            ? expansion.sections
            : (Array.isArray(plan?.sections) ? plan.sections : []);

        if (!sections.length) {
            return '';
        }

        const editMode = String(expansion?.editMode || plan?.editMode || '').trim() || 'hybrid_refresh';
        const leadGoal = String(expansion?.leadGoal || plan?.leadGoal || '').trim();
        const designPass = expansion?.designPass || plan?.designPass || null;
        const polishChecks = Array.isArray(expansion?.polishChecks) && expansion.polishChecks.length > 0
            ? expansion.polishChecks
            : (Array.isArray(plan?.polishChecks) ? plan.polishChecks : []);

        return [
            `Edit mode: ${editMode}`,
            plan?.templateId ? `Template: ${plan.templateId}` : '',
            plan?.title ? `Target title: ${plan.title}` : '',
            designPass?.visualDirection ? `Design pass: ${designPass.visualDirection}` : '',
            designPass?.sectionAgentStrategy ? `Section-agent strategy: ${designPass.sectionAgentStrategy}` : '',
            leadGoal ? `Lead cluster goal: ${leadGoal}` : '',
            'Section sequence:',
            ...sections.map((section, index) => {
                const heading = String(section?.heading || `Section ${index + 1}`).trim();
                const anchorHint = String(section?.anchorHint || '').trim();
                const purpose = String(section?.summary || section?.goal || '').trim();
                const agentRole = String(section?.agentRole || '').trim();
                const blockMix = Array.isArray(section?.suggestedBlocks) && section.suggestedBlocks.length > 0
                    ? section.suggestedBlocks
                        .map((block) => canonicalizeBlockType(block?.type || 'text'))
                        .filter(Boolean)
                        .join(', ')
                    : (Array.isArray(section?.blockTypes) ? section.blockTypes.join(', ') : '');

                return `${index + 1}. ${heading}${anchorHint ? ` (${anchorHint})` : ''}${agentRole ? ` [${agentRole}]` : ''}${purpose ? ` -> ${purpose}` : ''}${blockMix ? ` | block mix: ${blockMix}` : ''}`;
            }),
            polishChecks.length
                ? `Final polish: ${polishChecks.join(' | ')}`
                : 'Final polish: tighten repetition, keep the lead cluster designed, and check block variety before returning notes-actions.',
        ].filter(Boolean).join('\n');
    }

    async function buildMultiPassNotesMessages({
        apiClient,
        model,
        systemPrompt,
        question,
        requestOptions = {},
    }) {
        const planningClient = typeof NotesAPIClient !== 'undefined'
            ? new NotesAPIClient()
            : apiClient;

        const planningPrompt = `${systemPrompt}

Hidden planning pass for a substantial notes-writing request.
Do not return notes-actions in this pass.
Do not plan filesystem writes, repo paths, or local file creation.
First make a design pass, then break the page into sections that can be assigned to independent section agents.
Return JSON only in this shape:
{
  "templateId": "brief",
  "editMode": "rebuild_page | targeted_section_edits | hybrid_refresh",
  "title": "Page title",
  "leadGoal": "What the first screenful should achieve",
  "designPass": {
    "visualDirection": "Overall page composition and design scheme",
    "sectionAgentStrategy": "How independent section agents should split the work",
    "sharedConstraints": ["Keep terminology consistent", "Use the selected block palette"]
  },
  "polishChecks": ["Keep the lead cluster designed", "Avoid long runs of plain text"],
  "sections": [
    {
      "heading": "Section heading",
      "goal": "Why this section exists",
      "anchorHint": "Reuse [block_id] or create a new section",
      "agentRole": "lead-section-agent | evidence-section-agent | closeout-section-agent",
      "blockTypes": ["heading_2", "text", "bulleted_list"],
      "keyPoints": ["Point 1", "Point 2"]
    }
  ]
}`;

        const planningResponse = await planningClient.chat([
            { role: 'system', content: planningPrompt },
            { role: 'user', content: question }
        ], model, requestOptions);

        if (planningResponse?.error) {
            throw new Error(planningResponse.content || 'Planning pass failed');
        }

        const planPayload = parseHiddenDraftPayload(planningResponse.content, null);
        const normalizedPlan = normalizeHiddenDraftResult(planningResponse.content, null);
        if (!normalizedPlan) {
            return null;
        }

        const parallelExpansionPayload = await buildParallelSectionExpansionPayload({
            planningClient,
            model,
            systemPrompt,
            question,
            requestOptions,
            plan: planPayload,
        });

        let normalizedExpansion = parallelExpansionPayload
            ? JSON.stringify(parallelExpansionPayload, null, 2)
            : null;

        const expansionPrompt = `${systemPrompt}

Hidden section-expansion pass for a substantial notes-writing request.
Do not return notes-actions in this pass.
Do not plan filesystem writes, repo paths, or local file creation.
You will receive the original request plus the approved page plan.
Keep the chosen template consistent while expanding sections.
Treat sections as independently assigned chunks, then return the merged section briefs.
Return JSON only in this shape:
{
  "templateId": "brief",
  "editMode": "hybrid_refresh",
  "title": "Page title",
  "leadGoal": "What the first screenful should achieve",
  "designPass": {
    "visualDirection": "Overall page composition and design scheme",
    "sectionAgentStrategy": "How independent section agents split the work",
    "sharedConstraints": ["Keep terminology consistent", "Use the selected block palette"]
  },
  "polishChecks": ["Keep the lead cluster designed", "Avoid long runs of plain text"],
  "sections": [
    {
      "heading": "Section heading",
      "anchorHint": "Reuse [block_id] or create a new section",
      "agentRole": "lead-section-agent | evidence-section-agent | closeout-section-agent",
      "summary": "Detailed summary of what this section should say",
      "suggestedBlocks": [
        { "type": "heading_2", "content": "Section heading" },
        { "type": "text", "content": "Opening paragraph guidance" }
      ]
    }
  ]
}`;

        if (!normalizedExpansion) {
            const expansionResponse = await planningClient.chat([
                { role: 'system', content: expansionPrompt },
                {
                    role: 'user',
                    content: `Original request:\n${question}\n\nApproved page plan:\n${normalizedPlan}`
                }
            ], model, requestOptions);

            if (expansionResponse?.error) {
                throw new Error(expansionResponse.content || 'Expansion pass failed');
            }

            normalizedExpansion = normalizeHiddenDraftResult(expansionResponse.content, normalizedPlan);
        }
        if (!normalizedExpansion) {
            return null;
        }

        const applicationBrief = buildHiddenDraftApplicationBrief(normalizedPlan, normalizedExpansion);

        return [
            {
                role: 'system',
                content: `${systemPrompt}

Use the hidden planning work below as internal guidance.
This request already completed the silent architecture and section-brief passes.
For this final pass, do the articulation pass and return the finished answer only.
Do not mention local file writes, /app paths, or filesystem errors.
If the user is editing the page, return notes-actions as needed.
Do not switch this final pass into standalone HTML, artifact output, or download-link language unless the user explicitly asked for that.`
            },
            {
                role: 'user',
                content: `${question}

Use this approved page plan:
${normalizedPlan}

Use these expanded section briefs:
${normalizedExpansion}

${applicationBrief ? `Use this section-by-section application brief:\n${applicationBrief}\n\n` : ''}Preserve the chosen template's layout rhythm and block variety.
Apply the page section by section instead of one-shotting the whole document.
When a section has an existing heading anchor, prefer replace_section, insert_after_section, move_section, or delete_section over a full-page rebuild.
For second-round additions, preserve earlier content and use insert_here or insert_between_sections when the user gives a local placement cue.
Silently verify the lead cluster, section order, and final polish before returning the page edits.`
            }
        ];
    }

    function normalizeActionContent(type, content) {
        const value = sanitizeStructuredValue(content == null ? '' : content);

        switch (type) {
            case 'todo':
                if (value && typeof value === 'object') {
                    return {
                        text: String(value.text || ''),
                        checked: Boolean(value.checked)
                    };
                }
                return { text: String(value || ''), checked: false };
            case 'callout':
                if (value && typeof value === 'object') {
                    return {
                        text: coerceTextValue(
                            Object.prototype.hasOwnProperty.call(value, 'text')
                                ? value.text
                                : value.content ?? value.message ?? value
                        ),
                        icon: String(value.icon || '!')
                    };
                }
                return { text: coerceTextValue(value), icon: '!' };
            case 'code':
                if (value && typeof value === 'object') {
                    return {
                        language: value.language || 'plain',
                        text: String(value.text || '')
                    };
                }
                return { language: 'plain', text: String(value || '') };
            case 'math':
                if (value && typeof value === 'object') {
                    return {
                        text: String(value.text || value.latex || ''),
                        displayMode: value.displayMode !== false
                    };
                }
                return { text: String(value || ''), displayMode: true };
            case 'mermaid':
                if (value && typeof value === 'object') {
                    const mermaidSource = normalizeMermaidSourceText(value.text || value.content || value.code || value.source || '');
                    return {
                        text: mermaidSource,
                        diagramType: value.diagramType || detectMermaidDiagramType(mermaidSource),
                        _showEditor: false
                    };
                }
                {
                    const mermaidSource = normalizeMermaidSourceText(value);
                    return {
                        text: mermaidSource,
                        diagramType: detectMermaidDiagramType(mermaidSource),
                        _showEditor: false
                    };
                }
            case 'ai':
                if (value && typeof value === 'object') {
                    return {
                        prompt: String(value.prompt || ''),
                        result: value.result || null,
                        model: value.model || null
                    };
                }
                return { prompt: String(value || ''), result: null, model: null };
            case 'image':
                if (value && typeof value === 'object') {
                    return {
                        url: String(value.url || value.imageUrl || value.image_url || value.normalizedUrl || value.downloadUrl || ''),
                        caption: coerceTextValue(value.caption || value.alt || value.text || '')
                    };
                }
                return /^https?:\/\//i.test(String(value).trim())
                    ? { url: String(value).trim(), caption: '' }
                    : { url: '', caption: coerceTextValue(value) };
            case 'ai_image':
                if (value && typeof value === 'object') {
                    const hasSearchResults =
                        (Array.isArray(value.unsplashResults) && value.unsplashResults.length > 0) ||
                        (Array.isArray(value.artifactResults) && value.artifactResults.length > 0);
                    const hasImage = Boolean(value.imageUrl || value.url || value.imageAssetId);
                    return {
                        prompt: coerceTextValue(value.prompt || value.text || value.description || ''),
                        caption: coerceTextValue(value.caption || ''),
                        imageUrl: value.imageUrl || value.url || null,
                        model: value.model || null,
                        size: value.size || 'auto',
                        quality: value.quality || 'auto',
                        style: value.style || null,
                        source: value.source === 'unsplash' ? 'unsplash' : (value.source === 'artifact' ? 'artifact' : 'ai'),
                        status: value.status || (hasSearchResults ? 'search_results' : (hasImage ? 'done' : 'pending')),
                        unsplashResults: Array.isArray(value.unsplashResults) && value.unsplashResults.length > 0 ? value.unsplashResults : null,
                        artifactResults: Array.isArray(value.artifactResults) && value.artifactResults.length > 0 ? value.artifactResults : null,
                        selectedUnsplashId: value.selectedUnsplashId || null,
                        selectedArtifactId: value.selectedArtifactId || null,
                        unsplashPhotographer: value.unsplashPhotographer || null,
                        unsplashPhotographerUrl: value.unsplashPhotographerUrl || null,
                        imageAssetId: value.imageAssetId || null,
                        artifactId: value.artifactId || null,
                        downloadUrl: value.downloadUrl || null,
                        sourceHost: value.sourceHost || null,
                    };
                }
                return {
                    prompt: coerceTextValue(value),
                    caption: '',
                    imageUrl: null,
                    model: null,
                    size: 'auto',
                    quality: 'auto',
                    style: null,
                    source: 'ai',
                    status: 'pending',
                    unsplashResults: null,
                    artifactResults: null,
                    selectedUnsplashId: null,
                    selectedArtifactId: null,
                    unsplashPhotographer: null,
                    unsplashPhotographerUrl: null,
                    imageAssetId: null,
                    artifactId: null,
                    downloadUrl: null,
                    sourceHost: null,
                };
            case 'bookmark':
                if (value && typeof value === 'object') {
                    return {
                        url: String(value.url || ''),
                        title: String(value.title || ''),
                        description: String(value.description || ''),
                        favicon: String(value.favicon || ''),
                        image: String(value.image || '')
                    };
                }
                return {
                    url: String(value || ''),
                    title: '',
                    description: '',
                    favicon: '',
                    image: ''
                };
            case 'database':
                if (value && typeof value === 'object' && (Array.isArray(value.columns) || Array.isArray(value.headers) || Array.isArray(value.rows))) {
                    return {
                        columns: Array.isArray(value.columns)
                            ? value.columns
                            : (Array.isArray(value.headers) ? undefined : ['Name', 'Status', 'Notes']),
                        headers: Array.isArray(value.headers) ? value.headers : undefined,
                        rows: Array.isArray(value.rows) ? value.rows : [],
                        sortColumn: value.sortColumn || null,
                        sortDirection: value.sortDirection || 'asc'
                    };
                }
                return {
                    columns: ['Name', 'Status', 'Notes'],
                    rows: String(value || '').trim() ? [[String(value).trim(), '', '']] : [['', '', '']],
                    sortColumn: null,
                    sortDirection: 'asc'
                };
            case 'chart':
                if (value && typeof value === 'object') {
                    return {
                        title: String(value.title || value.name || 'Chart'),
                        chartType: ['bar', 'line', 'pie'].includes(String(value.chartType || value.type || '').toLowerCase())
                            ? String(value.chartType || value.type).toLowerCase()
                            : 'bar',
                        labels: Array.isArray(value.labels) ? value.labels : [],
                        values: Array.isArray(value.values) ? value.values : [],
                        data: Array.isArray(value.data) ? value.data : null,
                        columns: Array.isArray(value.columns) ? value.columns : null,
                        rows: Array.isArray(value.rows) ? value.rows : null,
                        unit: String(value.unit || '')
                    };
                }
                return {
                    title: String(value || 'Chart'),
                    chartType: 'bar',
                    labels: [],
                    values: [],
                    data: null,
                    columns: null,
                    rows: null,
                    unit: ''
                };
            case 'divider':
                return '';
            default:
                return typeof value === 'string' ? value : stripUnsafeNullCharacters(String(value || ''));
        }
    }

    function canonicalizeBlockType(type) {
        const normalized = normalizeLooseStructuredToken(type || 'text', {
            lowercase: true,
            spacesToUnderscore: true,
        });
        const aliases = {
            paragraph: 'text',
            p: 'text',
            h1: 'heading_1',
            heading1: 'heading_1',
            heading_1: 'heading_1',
            h2: 'heading_2',
            heading2: 'heading_2',
            heading_2: 'heading_2',
            h3: 'heading_3',
            heading3: 'heading_3',
            heading_3: 'heading_3',
            bullet: 'bulleted_list',
            bullets: 'bulleted_list',
            bullet_list: 'bulleted_list',
            bulletedlist: 'bulleted_list',
            bulleted_list: 'bulleted_list',
            bul_leted_list: 'bulleted_list',
            bulleted: 'bulleted_list',
            togglelist: 'toggle',
            collapsible: 'toggle',
            numberedlist: 'numbered_list',
            number_list: 'numbered_list',
            numberlist: 'numbered_list',
            numbered_list: 'numbered_list',
            checklist: 'todo',
            to_do: 'todo',
            todo: 'todo',
            calloutbox: 'callout',
            call_out: 'callout',
            equation: 'math',
            formula: 'math',
            diagram: 'mermaid',
            drawing: 'ai_image',
            drawings: 'ai_image',
            draw: 'ai_image',
            sketch: 'ai_image',
            illustration: 'ai_image',
            aiimage: 'ai_image',
            image_generation: 'ai_image',
            imagegeneration: 'ai_image',
            table: 'database',
            chart: 'chart',
            charts: 'chart',
            graph: 'chart',
            graph_block: 'chart',
            barchart: 'chart',
            bar_chart: 'chart',
            linechart: 'chart',
            line_chart: 'chart',
            piechart: 'chart',
            pie_chart: 'chart'
        };

        const compact = normalized.replace(/_/g, '');
        return aliases[normalized] || aliases[compact] || normalized || 'text';
    }

    function normalizeActionBlock(blockDefinition, options = {}) {
        const defaultType = options.defaultType || 'text';
        const rawDefinition = typeof blockDefinition === 'string'
            ? { type: defaultType, content: blockDefinition }
            : (blockDefinition || {});
        const definition = normalizeMarkdownLikeBlockDefinition(rawDefinition, { defaultType });
        const type = canonicalizeBlockType(definition.type || defaultType);
        let contentInput = Object.prototype.hasOwnProperty.call(definition, 'content')
            ? definition.content
            : (Object.prototype.hasOwnProperty.call(definition, 'text') ? definition.text : '');

        if (type === 'database' && definition && typeof definition === 'object'
            && (Array.isArray(definition.columns) || Array.isArray(definition.headers) || Array.isArray(definition.rows))) {
            contentInput = {
                ...(contentInput && typeof contentInput === 'object' && !Array.isArray(contentInput)
                    ? contentInput
                    : {}),
                columns: definition.columns,
                headers: definition.headers,
                rows: definition.rows,
                sortColumn: definition.sortColumn,
                sortDirection: definition.sortDirection
            };
        }

        if (type === 'chart' && definition && typeof definition === 'object'
            && (Array.isArray(definition.labels) || Array.isArray(definition.values) || Array.isArray(definition.data) || Array.isArray(definition.rows))) {
            contentInput = {
                ...(contentInput && typeof contentInput === 'object' && !Array.isArray(contentInput)
                    ? contentInput
                    : { title: Object.prototype.hasOwnProperty.call(definition, 'content') ? definition.content : definition.text }),
                title: definition.title || definition.name || (typeof contentInput === 'string' ? contentInput : undefined),
                chartType: definition.chartType || definition.chart || definition.kind,
                labels: definition.labels,
                values: definition.values,
                data: definition.data,
                columns: definition.columns,
                rows: definition.rows,
                unit: definition.unit
            };
        }

        if (!Object.prototype.hasOwnProperty.call(definition, 'content') && definition && typeof definition === 'object') {
            switch (type) {
                case 'callout':
                    contentInput = {
                        text: Object.prototype.hasOwnProperty.call(definition, 'text') ? definition.text : '',
                        icon: definition.icon
                    };
                    break;
                case 'image':
                    contentInput = {
                        url: definition.url || '',
                        caption: definition.caption || definition.text || ''
                    };
                    break;
                case 'ai_image':
                    contentInput = {
                        prompt: definition.prompt || definition.text || '',
                        caption: definition.caption || '',
                        imageUrl: definition.imageUrl || definition.url || null,
                        model: definition.model || null,
                        size: definition.size || 'auto',
                        quality: definition.quality || 'auto',
                        style: definition.style || null,
                        source: definition.source || 'ai',
                        status: definition.status,
                        unsplashResults: definition.unsplashResults || null,
                        artifactResults: definition.artifactResults || null,
                        selectedUnsplashId: definition.selectedUnsplashId || null,
                        selectedArtifactId: definition.selectedArtifactId || null,
                        unsplashPhotographer: definition.unsplashPhotographer || null,
                        unsplashPhotographerUrl: definition.unsplashPhotographerUrl || null,
                        imageAssetId: definition.imageAssetId || null,
                        artifactId: definition.artifactId || null,
                        downloadUrl: definition.downloadUrl || null,
                        sourceHost: definition.sourceHost || null,
                    };
                    break;
                case 'bookmark':
                    contentInput = {
                        url: definition.url || '',
                        title: definition.title || '',
                        description: definition.description || definition.text || '',
                        favicon: definition.favicon || '',
                        image: definition.image || ''
                    };
                    break;
                case 'database':
                    contentInput = {
                        columns: definition.columns,
                        headers: definition.headers,
                        rows: definition.rows,
                        sortColumn: definition.sortColumn,
                        sortDirection: definition.sortDirection
                    };
                    break;
                case 'chart':
                    contentInput = {
                        title: definition.title || definition.name || definition.text || 'Chart',
                        chartType: definition.chartType || definition.chart || definition.kind,
                        labels: definition.labels,
                        values: definition.values,
                        data: definition.data,
                        columns: definition.columns,
                        rows: definition.rows,
                        unit: definition.unit
                    };
                    break;
                default:
                    break;
            }
        }

        const block = Blocks.createBlock(type, normalizeActionContent(type, contentInput), {
            children: [],
            formatting: definition.formatting || {},
            color: normalizeNotesColor(definition.color ?? definition.backgroundColor ?? definition.bgColor),
            textColor: normalizeNotesColor(definition.textColor),
            fontFamily: normalizeNotesFontFamily(definition.fontFamily),
            fontSize: normalizeNotesFontSize(definition.fontSize),
            fontWeight: normalizeNotesFontWeight(definition.fontWeight),
            textAlign: normalizeNotesTextAlign(definition.textAlign),
            expanded: definition.expanded,
            icon: definition.icon
        });

        if (definition.id) {
            block.id = definition.id;
        }

        if (Array.isArray(definition.children) && definition.children.length > 0) {
            block.children = definition.children.map((child) => normalizeActionBlock(child));
        }

        return block;
    }

    function buildBlocksFromLegacyActionContent(rawAction = {}) {
        if (Array.isArray(rawAction.blocks) && rawAction.blocks.length > 0) {
            return rawAction.blocks;
        }

        if (rawAction.block && typeof rawAction.block === 'object') {
            return [rawAction.block];
        }

        const textSource = [
            rawAction.content,
            rawAction.markdown,
            rawAction.text,
            rawAction.body,
            rawAction.result
        ].find((value) => typeof value === 'string' && value.trim());

        if (!textSource) {
            return [];
        }

        return extractPreferredBlocksFromSourceText(textSource).blocks;
    }

    function normalizeLegacyNotesAction(rawAction) {
        if (!rawAction || typeof rawAction !== 'object') {
            return null;
        }

        const op = normalizeLooseStructuredToken(rawAction.op || rawAction.action || rawAction.operation || '', {
            lowercase: true,
            spacesToUnderscore: true,
        });
        const opAliases = {
            rebuildpage: 'rebuild_page',
            re_build_page: 'rebuild_page',
            replacepage: 'replace_page',
            replace_page: 'replace_page',
            updateblock: 'update_block',
            update_block: 'update_block',
            changeblocktype: 'change_block_type',
            change_block_type: 'change_block_type',
            setblocktype: 'set_block_type',
            set_block_type: 'set_block_type',
            convertblocktype: 'convert_block_type',
            convert_block_type: 'convert_block_type',
            moveblock: 'move_block',
            move_block: 'move_block',
            movesection: 'move_section',
            move_section: 'move_section',
            inserthere: 'insert_here',
            insert_here: 'insert_here',
            inserthereafter: 'insert_here',
            insertherebefore: 'insert_here',
            insertbetween: 'insert_between_sections',
            insert_between: 'insert_between_sections',
            insertbetweensections: 'insert_between_sections',
            insert_between_sections: 'insert_between_sections',
            insertsectionbetween: 'insert_between_sections',
            insert_section_between: 'insert_between_sections',
            insertaftersection: 'insert_after_section',
            insert_after_section: 'insert_after_section',
            insertbeforesection: 'insert_before_section',
            insert_before_section: 'insert_before_section',
            deletehere: 'delete_here',
            delete_here: 'delete_here',
            removehere: 'delete_here',
            remove_here: 'delete_here',
            deletesection: 'delete_section',
            delete_section: 'delete_section',
            appendtopage: 'append_to_page',
            append_to_page: 'append_to_page',
            prependtopage: 'prepend_to_page',
            prepend_to_page: 'prepend_to_page',
        };
        const canonicalOp = opAliases[op] || opAliases[op.replace(/_/g, '')] || op;
        const normalizedAction = {
            ...rawAction,
            op: canonicalOp
        };

        switch (canonicalOp) {
            case 'replace_content': {
                const blocks = buildBlocksFromLegacyActionContent(rawAction);
                if (!blocks.length) {
                    return null;
                }

                return {
                    ...normalizedAction,
                    op: 'rebuild_page',
                    blocks
                };
            }
            case 'append_content': {
                const blocks = buildBlocksFromLegacyActionContent(rawAction);
                if (!blocks.length) {
                    return null;
                }

                return {
                    ...normalizedAction,
                    op: 'append_to_page',
                    blocks
                };
            }
            case 'prepend_content': {
                const blocks = buildBlocksFromLegacyActionContent(rawAction);
                if (!blocks.length) {
                    return null;
                }

                return {
                    ...normalizedAction,
                    op: 'prepend_to_page',
                    blocks
                };
            }
            default:
                return normalizedAction.op ? normalizedAction : null;
        }
    }

    function buildImplicitNotesActionsFromPayload(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return null;
        }

        const directAction = normalizeLegacyNotesAction(payload);
        if (directAction) {
            return [directAction];
        }
        if (isNotesBlockDefinition(payload)) {
            return null;
        }

        const pageLikeBlocks = Array.isArray(payload.blocks)
            ? payload.blocks
            : (Array.isArray(payload.page?.blocks)
                ? payload.page.blocks
                : (Array.isArray(payload.document?.blocks)
                    ? payload.document.blocks
                    : null));
        if (Array.isArray(pageLikeBlocks) && pageLikeBlocks.length > 0) {
            return [{
                op: 'rebuild_page',
                blocks: pageLikeBlocks
            }];
        }

        const textSource = [
            payload.content,
            payload.markdown,
            payload.text,
            payload.body,
            payload.result,
            payload.output,
            payload.page?.content,
            payload.document?.content
        ].find((value) => typeof value === 'string' && value.trim());
        if (!textSource) {
            return null;
        }

        const blocks = extractPreferredBlocksFromSourceText(textSource).blocks;
        if (!blocks.length) {
            return null;
        }

        return [{
            op: 'rebuild_page',
            blocks
        }];
    }

    function getNotesPayloadActions(payload) {
        if (!payload || typeof payload !== 'object') {
            return null;
        }

        const actions = Array.isArray(payload.actions)
            ? payload.actions
            : (Array.isArray(payload.operations)
                ? payload.operations
                : (Array.isArray(payload.edits)
                    ? payload.edits
                    : (Array.isArray(payload['notes-actions'])
                        ? payload['notes-actions']
                        : null)));

        if (!Array.isArray(actions)) {
            return buildImplicitNotesActionsFromPayload(payload);
        }

        return actions
            .map((action) => normalizeLegacyNotesAction(action))
            .filter(Boolean);
    }

    function getNotesPayloadReply(payload) {
        if (!payload || typeof payload !== 'object') {
            return '';
        }

        const reply = String(
            payload.assistant_reply
            || payload.assistantReply
            || payload.assistantMessage
            || payload.reply
            || payload.message
            || ''
        ).trim();

        return isAssistantReplyPlaceholderText(reply) || looksLikeInternalNotesScaffold(reply)
            ? ''
            : reply;
    }

    function tryParseNotesActionPayload(payloadText) {
        if (!payloadText) return null;

        const payload = parseStructuredJsonPayload(payloadText);
        if (!payload) {
            return null;
        }

        if (Array.isArray(payload)) {
            const normalizedActions = payload
                .map((action) => normalizeLegacyNotesAction(action))
                .filter(Boolean);
            if (normalizedActions.length > 0) {
                return {
                    displayText: '',
                    actions: normalizedActions
                };
            }
            return null;
        }

        const actions = getNotesPayloadActions(payload);
        if (payload && typeof payload === 'object' && Array.isArray(actions)) {
            return {
                displayText: getNotesPayloadReply(payload),
                actions
            };
        }

        return null;
    }

    function stripDiffStylePrefixes(text = '') {
        const source = stripUnsafeNullCharacters(text);
        const lines = source.split(/\r?\n/);
        const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
        if (nonEmptyLines.length === 0) {
            return source.trim();
        }

        const prefixedLines = nonEmptyLines.filter((line) => /^\s*\+\s?/.test(line));
        if (prefixedLines.length < 3 || prefixedLines.length < Math.ceil(nonEmptyLines.length * 0.4)) {
            return source.trim();
        }

        return lines
            .map((line) => line.replace(/^\s*\+\s?/, ''))
            .join('\n')
            .trim();
    }

    function isAssistantReplyPlaceholderText(text = '') {
        const normalized = String(text || '').trim().toLowerCase();
        if (!normalized) {
            return false;
        }

        return /^<\s*assistant(?:\s+reply)?\s*\/?>$/i.test(normalized)
            || normalized === 'assistant reply'
            || normalized === 'assistant_reply';
    }

    function parseLooseJsonValue(value) {
        if (!value || typeof value !== 'string') {
            return null;
        }

        return parseStructuredJsonPayload(value);
    }

    function looksLikeBlockTypeToken(value = '') {
        const normalized = String(value || '').trim();
        if (!normalized || /\s/.test(normalized)) {
            return false;
        }

        const canonical = canonicalizeBlockType(normalized);
        return [
            'text',
            'heading_1',
            'heading_2',
            'heading_3',
            'bulleted_list',
            'numbered_list',
            'todo',
            'code',
            'quote',
            'callout',
            'divider',
            'mermaid',
            'diagram',
            'drawing',
            'drawings',
            'draw',
            'sketch',
            'illustration',
            'image',
            'ai_image',
            'bookmark',
            'database',
            'chart',
            'ai',
            'toggle',
            'math',
        ].includes(canonical);
    }

    function extractFunctionPayloadText(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return null;
        }

        const type = String(value.type || '').trim().toLowerCase();
        const functionName = String(value.name || value.function?.name || '').trim();
        if (type !== 'function' && !functionName) {
            return null;
        }

        const candidateSources = [
            value.parameters,
            value.arguments,
            value.function?.arguments,
            value.function?.parameters,
        ];

        for (const source of candidateSources) {
            const parsed = typeof source === 'string'
                ? parseLooseJsonValue(source)
                : source;
            if (!parsed || typeof parsed !== 'object') {
                continue;
            }

            const functionText = [
                parsed.notes_page_update,
                parsed.assistant_reply,
                parsed.assistantReply,
                parsed.message,
                parsed.content,
                parsed.text,
                parsed.result,
                parsed.response,
                parsed.output_text,
                parsed.outputText,
            ].find((entry) => typeof entry === 'string' && entry.trim() && !isAssistantReplyPlaceholderText(entry));

            if (functionText) {
                const normalizedFunctionText = stripUnsafeNullCharacters(functionText).trim();
                return looksLikeInternalNotesScaffold(normalizedFunctionText) ? null : normalizedFunctionText;
            }
        }

        return null;
    }

    function extractGenericWrapperContent(value) {
        if (typeof value === 'string') {
            const trimmed = stripUnsafeNullCharacters(value).trim();
            if (!trimmed) {
                return null;
            }

            const parsedPayload = tryParseGenericContentPayload(trimmed);
            if (parsedPayload?.displayText && !looksLikeInternalNotesScaffold(parsedPayload.displayText)) {
                return parsedPayload.displayText;
            }

            if (looksLikeBlockTypeToken(trimmed)) {
                return null;
            }

            return (isAssistantReplyPlaceholderText(trimmed) || looksLikeInternalNotesScaffold(trimmed)) ? null : trimmed;
        }

        if (value == null) {
            return null;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                const extracted = extractGenericWrapperContent(item);
                if (extracted) {
                    return extracted;
                }
            }
            return null;
        }

        if (typeof value !== 'object') {
            return null;
        }

        const functionPayloadText = extractFunctionPayloadText(value);
        if (functionPayloadText) {
            return functionPayloadText;
        }

        const imageMarkdown = extractMarkdownImageContent(value);

        const directKeys = ['content', 'text', 'message', 'result', 'response', 'output', 'output_text', 'outputText', 'markdown'];
        let primaryText = null;
        for (const key of directKeys) {
            if (typeof value[key] === 'string' && value[key].trim() && !isAssistantReplyPlaceholderText(value[key])) {
                const candidateText = extractGenericWrapperContent(value[key])
                    || stripUnsafeNullCharacters(value[key]).trim();
                if (!looksLikeInternalNotesScaffold(candidateText)) {
                    primaryText = candidateText;
                    break;
                }
            }
        }

        if (primaryText && imageMarkdown && !primaryText.includes('![')) {
            return `${primaryText}\n\n${imageMarkdown}`.trim();
        }

        if (primaryText) {
            return primaryText;
        }

        if (imageMarkdown) {
            return imageMarkdown;
        }

        const nestedKeys = [
            'content',
            'output',
            'payload',
            'data',
            'item',
            'items',
            'value',
            'result',
            'details',
            'toolResult',
        ];
        for (const key of nestedKeys) {
            const extracted = extractGenericWrapperContent(value[key]);
            if (extracted) {
                return extracted;
            }
        }

        return null;
    }

    function tryParseGenericContentPayload(payloadText) {
        if (!payloadText) {
            return null;
        }

        const payload = parseStructuredJsonPayload(payloadText);
        if (!payload) {
            return null;
        }

        if (payload && typeof payload === 'object' && Array.isArray(payload.actions)) {
            return null;
        }
        if (Array.isArray(payload) && payload.every((item) => typeof item === 'string' && looksLikeBlockTypeToken(item))) {
            return null;
        }
        if (Array.isArray(payload) && payload.some((item) => isNotesBlockDefinition(item))) {
            return null;
        }
        if (isNotesBlockDefinition(payload)) {
            return null;
        }

        const content = extractGenericWrapperContent(payload);
        if (!content || looksLikeInternalNotesScaffold(content)) {
            return null;
        }

        return {
            displayText: content,
            actions: []
        };
    }

    function findBalancedGenericContentPayload(text) {
        const source = stripDiffStylePrefixes(text);
        if (!source.includes('{') && !source.includes('[')) {
            return null;
        }

        for (let start = 0; start < source.length; start++) {
            if (!['{', '['].includes(source[start])) continue;

            let depth = 0;
            let inString = false;
            let isEscaped = false;

            for (let index = start; index < source.length; index++) {
                const char = source[index];

                if (inString) {
                    if (isEscaped) {
                        isEscaped = false;
                    } else if (char === '\\') {
                        isEscaped = true;
                    } else if (char === '"') {
                        inString = false;
                    }
                    continue;
                }

                if (char === '"') {
                    inString = true;
                    continue;
                }

                if (char === '{' || char === '[') {
                    depth += 1;
                    continue;
                }

                if (char === '}' || char === ']') {
                    depth -= 1;
                    if (depth === 0) {
                        const candidate = source.slice(start, index + 1);
                        const parsed = tryParseGenericContentPayload(candidate);
                        if (parsed) {
                            return {
                                parsed,
                                candidate
                            };
                        }
                        break;
                    }
                }
            }
        }

        return null;
    }

    function unwrapGenericResponseContent(text = '') {
        const directPayload = tryParseGenericContentPayload(text);
        if (directPayload?.displayText && !looksLikeInternalNotesScaffold(directPayload.displayText)) {
            return directPayload.displayText;
        }

        const balancedPayload = findBalancedGenericContentPayload(text);
        if (balancedPayload?.parsed?.displayText && !looksLikeInternalNotesScaffold(balancedPayload.parsed.displayText)) {
            return balancedPayload.parsed.displayText;
        }

        const normalized = stripDiffStylePrefixes(text).trim();
        return looksLikeInternalNotesScaffold(normalized) ? '' : normalized;
    }

    function isNotesBlockDefinition(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }

        if (typeof value.type !== 'string' || !value.type.trim()) {
            return false;
        }
        const type = canonicalizeBlockType(value.type);

        if (Object.prototype.hasOwnProperty.call(value, 'content')) {
            return true;
        }

        switch (type) {
            case 'divider':
                return true;
            case 'image':
                return Boolean(value.url || value.imageUrl || value.image_url || value.normalizedUrl || value.downloadUrl || value.caption || value.alt || value.text);
            case 'ai_image':
                return Boolean(
                    value.prompt ||
                    value.text ||
                    value.imageUrl ||
                    value.url ||
                    value.imageAssetId ||
                    (Array.isArray(value.unsplashResults) && value.unsplashResults.length > 0) ||
                    (Array.isArray(value.artifactResults) && value.artifactResults.length > 0)
                );
            case 'bookmark':
                return Boolean(value.url || value.title || value.description || value.text);
            case 'database':
                return Array.isArray(value.columns) || Array.isArray(value.rows);
            case 'chart':
                return Boolean(
                    value.title ||
                    value.name ||
                    value.text ||
                    Array.isArray(value.labels) ||
                    Array.isArray(value.values) ||
                    Array.isArray(value.data) ||
                    Array.isArray(value.rows)
                );
            case 'callout':
                return Boolean(value.text || value.icon);
            case 'code':
                return Boolean(value.text || value.language);
            case 'math':
                return Boolean(value.text || value.latex);
            case 'mermaid':
                return Boolean(value.text || value.diagramType);
            case 'ai':
                return Boolean(value.prompt || value.result || value.text);
            default:
                return Boolean(value.text);
        }
    }

    function detectMermaidDiagramType(text) {
        const normalized = String(text || '').trim().toLowerCase();
        if (!normalized) return 'flowchart';
        if (normalized.startsWith('sequencediagram')) return 'sequence';
        if (normalized.startsWith('classdiagram')) return 'class';
        if (normalized.startsWith('statediagram')) return 'state';
        if (normalized.startsWith('erdiagram')) return 'er';
        if (normalized.startsWith('gantt')) return 'gantt';
        if (normalized.startsWith('pie')) return 'pie';
        if (normalized.startsWith('mindmap')) return 'mindmap';
        if (normalized.startsWith('gitgraph')) return 'gitgraph';
        return 'flowchart';
    }

    const MERMAID_DIAGRAM_START_PATTERN = /^(flowchart|graph|sequencediagram|classdiagram|statediagram(?:-v2)?|erdiagram|gantt|pie|mindmap|gitgraph)\b/i;

    function normalizeMermaidSourceText(text) {
        let value = String(text || '').trim();
        if (!value) return '';

        const fencedMatch = value.match(/```mermaid\s*([\s\S]*?)```/i);
        if (fencedMatch?.[1]) {
            value = fencedMatch[1].trim();
        } else {
            value = value
                .replace(/^```mermaid\s*/i, '')
                .replace(/```$/, '')
                .trim();
        }

        return value
            .replace(/^[\s"'`]+/, '')
            .replace(/[\s"',}]+$/, '')
            .replace(/^mermaid(?:\\r\\n|\\n|\r?\n)+/i, '')
            .replace(/\\r\\n/g, '\n')
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .trim();
    }

    function looksLikeMermaidSource(text) {
        return MERMAID_DIAGRAM_START_PATTERN.test(normalizeMermaidSourceText(text));
    }

    function startsWithMermaidResponse(text) {
        const value = String(text || '').trim();
        if (!value) return false;

        return /^```mermaid\b/i.test(value) ||
            /^["'`]*mermaid(?:\\r\\n|\\n|\r?\n)+/i.test(value) ||
            looksLikeMermaidSource(value);
    }

    function extractLeadingMermaidBlock(text, stopIndex = null) {
        const source = String(text || '');
        const slice = source.slice(0, stopIndex == null ? source.length : stopIndex).trim();
        if (!slice) return null;

        const decoded = normalizeMermaidSourceText(slice);

        if (!decoded) return null;
        if (!MERMAID_DIAGRAM_START_PATTERN.test(decoded)) {
            return null;
        }

        return {
            type: 'mermaid',
            content: {
                text: decoded,
                diagramType: detectMermaidDiagramType(decoded),
            },
        };
    }

    function hasLooseNotesActionFence(text = '') {
        return /```+\s*notes\s*(?:[_-]|\s)\s*actions\b/i.test(String(text || ''));
    }

    function hasLooseAssistantReplyKey(text = '') {
        return /"\s*assistant\s*(?:[_-]|\s)?\s*reply\s*"\s*:/i.test(String(text || ''));
    }

    function hasLooseNotesActionsKey(text = '') {
        return /"\s*notes\s*(?:[_-]|\s)?\s*actions\s*"\s*:/i.test(String(text || ''));
    }

    function hasLooseNotesActionCollectionKey(text = '') {
        return /"\s*(?:actions|operations|edits)\s*"\s*:/i.test(String(text || ''));
    }

    function hasLooseLegacyContentAction(text = '') {
        return /"\s*action\s*"\s*:\s*"\s*(?:replace|append|prepend)\s*(?:[_-]|\s)?\s*content\s*"/i.test(String(text || ''));
    }

    function hasLooseNotesBlockTypeMarker(text = '') {
        return /"\s*type\s*"\s*:\s*"\s*(?:text|heading\s*(?:[_-]|\s)?\s*[123]|bulleted\s*(?:[_-]|\s)?\s*list|numbered\s*(?:[_-]|\s)?\s*list|todo|code|quote|callout|divider|mermaid|diagram|drawing|drawings|draw|sketch|illustration|image|ai\s*(?:[_-]|\s)?\s*image|bookmark|database|chart|ai|toggle|math)\s*"/i.test(String(text || ''));
    }

    function findStructuredMarkerIndex(text = '') {
        const value = String(text || '');
        return value.search(/```+\s*notes\s*(?:[_-]|\s)\s*actions|```+\s*json|"\s*assistant\s*(?:[_-]|\s)?\s*reply\s*"\s*:|"\s*notes\s*(?:[_-]|\s)?\s*actions\s*"\s*:|"\s*(?:actions|operations|edits)\s*"\s*:|"\s*action\s*"\s*:\s*"\s*(?:replace|append|prepend)\s*(?:[_-]|\s)?\s*content\s*"|"\s*type\s*"\s*:\s*"\s*function\s*"|"\s*name\s*"\s*:\s*"\s*update_notes_page\s*"|"\s*type\s*"\s*:\s*"\s*(?:text|heading\s*(?:[_-]|\s)?\s*[123]|bulleted\s*(?:[_-]|\s)?\s*list|numbered\s*(?:[_-]|\s)?\s*list|todo|code|quote|callout|divider|mermaid|diagram|drawing|drawings|draw|sketch|illustration|image|ai\s*(?:[_-]|\s)?\s*image|bookmark|database|chart|ai|toggle|math)\s*"/i);
    }

    function hasHighConfidenceRecoveredBlocks(blocks = []) {
        if (!Array.isArray(blocks) || blocks.length === 0) {
            return false;
        }

        if (blocks.length >= 2) {
            return true;
        }

        const [block] = blocks;
        const type = canonicalizeBlockType(block?.type || 'text');
        const text = extractBlockDefinitionText(block).replace(/\s+/g, ' ').trim();

        if (['mermaid', 'database', 'chart', 'image', 'ai_image', 'bookmark', 'code', 'math'].includes(type)) {
            return Boolean(text);
        }
        if (['callout', 'quote', 'todo'].includes(type)) {
            return text.length >= 24;
        }
        if (/^heading_/.test(type)) {
            return text.length >= 18 && text.split(/\s+/).length >= 3;
        }
        return text.length >= 60 && text.split(/\s+/).length >= 6;
    }

    function extractBlockFragmentActions(text) {
        const source = String(text || '');
        const blockMatches = [];

        for (let start = 0; start < source.length; start++) {
            if (source[start] !== '{') continue;

            let depth = 0;
            let inString = false;
            let isEscaped = false;

            for (let index = start; index < source.length; index++) {
                const char = source[index];

                if (inString) {
                    if (isEscaped) {
                        isEscaped = false;
                    } else if (char === '\\') {
                        isEscaped = true;
                    } else if (char === '"') {
                        inString = false;
                    }
                    continue;
                }

                if (char === '"') {
                    inString = true;
                    continue;
                }

                if (char === '{') {
                    depth += 1;
                    continue;
                }

                if (char === '}') {
                    depth -= 1;
                    if (depth === 0) {
                        const candidate = source.slice(start, index + 1);
                        const parsed = parseStructuredJsonPayload(candidate);
                        if (parsed && isNotesBlockDefinition(parsed)) {
                            blockMatches.push({ parsed, start, end: index + 1 });
                        }
                        break;
                    }
                }
            }
        }

        const recoveredBlocks = [];
        if (blockMatches.length > 0) {
            const leadingMermaid = extractLeadingMermaidBlock(source, blockMatches[0].start);
            if (leadingMermaid) {
                recoveredBlocks.push(leadingMermaid);
            }

            let previousEnd = blockMatches[0].start;
            blockMatches.forEach((match, index) => {
                const separator = source.slice(index === 0 ? blockMatches[0].start : previousEnd, match.start);
                if (index > 0 && /[^\s,\]\[]/.test(separator)) {
                    return;
                }

                recoveredBlocks.push(match.parsed);
                previousEnd = match.end;
            });
        } else {
            const mermaidOnly = extractLeadingMermaidBlock(source);
            if (mermaidOnly) {
                recoveredBlocks.push(mermaidOnly);
            }
        }

        if (!recoveredBlocks.length) {
            return null;
        }
        if (!hasHighConfidenceRecoveredBlocks(recoveredBlocks)) {
            return null;
        }

        return [{
            op: 'append_to_page',
            blocks: recoveredBlocks,
        }];
    }

    function findBalancedNotesActionPayload(text) {
        const source = String(text || '');
        if (!(hasLooseNotesActionCollectionKey(source) || hasLooseNotesActionsKey(source))) {
            return null;
        }

        for (let start = 0; start < source.length; start++) {
            if (source[start] !== '{') continue;

            let depth = 0;
            let inString = false;
            let isEscaped = false;

            for (let index = start; index < source.length; index++) {
                const char = source[index];

                if (inString) {
                    if (isEscaped) {
                        isEscaped = false;
                    } else if (char === '\\') {
                        isEscaped = true;
                    } else if (char === '"') {
                        inString = false;
                    }
                    continue;
                }

                if (char === '"') {
                    inString = true;
                    continue;
                }

                if (char === '{') {
                    depth += 1;
                    continue;
                }

                if (char === '}') {
                    depth -= 1;
                    if (depth === 0) {
                        const candidate = source.slice(start, index + 1);
                        const parsed = tryParseNotesActionPayload(candidate);
                        if (parsed) {
                            return {
                                parsed,
                                candidate
                            };
                        }
                        break;
                    }
                }
            }
        }

        return null;
    }

    function looksLikeNotesActionResponse(text) {
        const value = stripUnsafeNullCharacters(text);
        return hasLooseNotesActionFence(value) ||
            /```json/i.test(value) ||
            hasLooseAssistantReplyKey(value) ||
            hasLooseNotesActionsKey(value) ||
            hasLooseNotesActionCollectionKey(value) ||
            hasLooseLegacyContentAction(value) ||
            hasLooseNotesBlockTypeMarker(value) ||
            startsWithMermaidResponse(value);
    }

    function stripStructuredResponseText(text) {
        const value = stripInternalToolCallMarkup(text);
        if (startsWithMermaidResponse(value) || looksLikeInternalNotesScaffold(value)) {
            return '';
        }

        const genericContent = tryParseGenericContentPayload(value) || findBalancedGenericContentPayload(value)?.parsed;
        if (genericContent?.displayText && !looksLikeInternalNotesScaffold(genericContent.displayText)) {
            return genericContent.displayText;
        }

        const markerIndex = findStructuredMarkerIndex(value);
        if (markerIndex >= 0) {
            return value.slice(0, markerIndex).trim();
        }
        return value.trim();
    }

    function extractNotesActionPlan(responseText) {
        const text = stripInternalToolCallMarkup(responseText);
        const match = text.match(/```+\s*notes\s*(?:[_-]|\s)\s*actions\b\s*([\s\S]*?)```/i);
        if (!match) {
            const jsonFenceMatch = text.match(/```+\s*json\b\s*([\s\S]*?)```/i);
            const directPayload = tryParseNotesActionPayload(text.trim());
            const fencedPayload = jsonFenceMatch ? tryParseNotesActionPayload(jsonFenceMatch[1].trim()) : null;
            const balancedPayload = findBalancedNotesActionPayload(text);
            const genericPayload = tryParseGenericContentPayload(text.trim())
                || (jsonFenceMatch ? tryParseGenericContentPayload(jsonFenceMatch[1].trim()) : null)
                || findBalancedGenericContentPayload(text)?.parsed;
            const fragmentActions = extractBlockFragmentActions(text);
            const parsed = directPayload || fencedPayload || balancedPayload?.parsed || genericPayload || (fragmentActions
                ? { displayText: '', actions: fragmentActions }
                : null);

            if (parsed) {
                const visibleText = typeof parsed.displayText === 'string'
                    ? parsed.displayText
                    : text
                        .replace(jsonFenceMatch?.[0] || '', '')
                        .replace(balancedPayload?.candidate || '', '')
                        .trim();
                return {
                    displayText: visibleText,
                    actions: parsed.actions
                };
            }

            return {
                displayText: looksLikeNotesActionResponse(text)
                    || isAssistantReplyPlaceholderText(text)
                    || looksLikeInternalNotesScaffold(text)
                    ? ''
                    : text.trim(),
                actions: [],
                parseFailed: looksLikeNotesActionResponse(text)
            };
        }

        const payloadText = match[1].trim();
        const visibleText = text.replace(match[0], '').trim();

        const directPayload = tryParseNotesActionPayload(payloadText);
        const balancedPayload = findBalancedNotesActionPayload(payloadText);
        const genericPayload = tryParseGenericContentPayload(payloadText)
            || findBalancedGenericContentPayload(payloadText)?.parsed;
        const fragmentActions = extractBlockFragmentActions(payloadText);
        const parsed = directPayload || balancedPayload?.parsed || genericPayload || (fragmentActions
            ? { displayText: '', actions: fragmentActions }
            : null);
        if (!parsed) {
            console.warn('Failed to parse notes action plan payload');
            return {
                displayText: looksLikeInternalNotesScaffold(visibleText) ? '' : (visibleText || ''),
                actions: [],
                parseFailed: true
            };
        }

        return {
            displayText: looksLikeInternalNotesScaffold(parsed.displayText || visibleText || '')
                ? ''
                : String(parsed.displayText || visibleText || '').trim(),
            actions: parsed.actions
        };
    }

    function getFirstBlockId() {
        return getPageContext()?.blocks?.[0]?.id || null;
    }

    function getLastBlockId() {
        const blocks = getPageContext()?.blocks || [];
        return blocks.length ? blocks[blocks.length - 1].id : null;
    }

    function getBlockTextContent(block = null) {
        if (!block) return '';
        if (typeof block.content === 'string') return block.content;
        if (block.content && typeof block.content === 'object') {
            if (typeof block.content.text === 'string') return block.content.text;
            if (typeof block.content.caption === 'string') return block.content.caption;
            if (typeof block.content.title === 'string') return block.content.title;
            if (typeof block.content.description === 'string') return block.content.description;
            if (typeof block.content.prompt === 'string') return block.content.prompt;
        }
        return '';
    }

    function setBlockTextContent(block = null, nextText = '') {
        if (!block) return block;
        const value = String(nextText == null ? '' : nextText);
        const nextBlock = JSON.parse(JSON.stringify(block));

        if (typeof nextBlock.content === 'string' || nextBlock.content == null) {
            nextBlock.content = value;
            return nextBlock;
        }

        if (nextBlock.content && typeof nextBlock.content === 'object') {
            if (Object.prototype.hasOwnProperty.call(nextBlock.content, 'text')) {
                nextBlock.content.text = value;
            } else if (Object.prototype.hasOwnProperty.call(nextBlock.content, 'caption')) {
                nextBlock.content.caption = value;
            } else if (Object.prototype.hasOwnProperty.call(nextBlock.content, 'title')) {
                nextBlock.content.title = value;
            } else if (Object.prototype.hasOwnProperty.call(nextBlock.content, 'description')) {
                nextBlock.content.description = value;
            } else if (Object.prototype.hasOwnProperty.call(nextBlock.content, 'prompt')) {
                nextBlock.content.prompt = value;
            } else {
                nextBlock.content.text = value;
            }
        }

        return nextBlock;
    }

    function replaceSpecificBlockText(block = null, action = {}) {
        const originalText = getBlockTextContent(block);
        const findText = String(action.findText || action.oldText || action.targetText || action.text || '').trim();
        const replacementText = String(action.replaceWith ?? action.newText ?? action.content ?? '');

        if (!block || !findText || !originalText) {
            return null;
        }

        const flags = action.caseSensitive ? 'g' : 'gi';
        const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(escaped, action.replaceAll === false ? (action.caseSensitive ? '' : 'i') : flags);
        const nextText = originalText.replace(pattern, replacementText);

        if (nextText === originalText) {
            return null;
        }

        return setBlockTextContent(block, nextText);
    }

    function splitTextIntoSentences(value = '') {
        if (window.NotesQuery?.splitSentences) {
            return window.NotesQuery.splitSentences(value);
        }

        const source = String(value || '');
        const sentences = [];
        const pattern = /[^.!?\n]+(?:[.!?]+["')\]]*|(?=\n|$))/g;
        let match;

        while ((match = pattern.exec(source))) {
            const exactText = match[0].trim();
            if (!exactText) continue;
            sentences.push({
                sentenceIndex: sentences.length,
                text: exactText.replace(/\s+/g, ' ').trim(),
                exactText,
            });
        }

        return sentences.length ? sentences : (source.trim()
            ? [{ sentenceIndex: 0, text: source.trim().replace(/\s+/g, ' '), exactText: source.trim() }]
            : []);
    }

    function resolveSentenceHighlightText(blockText = '', action = {}) {
        const rawText = String(action.text || action.targetText || action.findText || action.sentenceText || '').trim();
        const sentenceQuery = String(action.sentenceQuery || action.query || action.textIncludes || '').trim();
        const wantsSentence = action.scope === 'sentence'
            || action.match === 'sentence'
            || action.fullSentence === true
            || Boolean(sentenceQuery);
        const queryText = sentenceQuery || rawText;

        if (!wantsSentence || !queryText) {
            return rawText;
        }

        const normalizedQuery = queryText.replace(/\s+/g, ' ').trim().toLowerCase();
        const queryWords = normalizedQuery.split(/\s+/).filter(Boolean);
        const sentence = splitTextIntoSentences(blockText).find((candidate) => {
            const normalizedSentence = String(candidate.text || candidate.exactText || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
            if (!normalizedSentence) return false;
            return normalizedSentence.includes(normalizedQuery)
                || queryWords.every((word) => normalizedSentence.includes(word));
        });

        return sentence?.exactText || rawText;
    }

    function addBlockTextHighlight(block = null, action = {}) {
        const blockText = getBlockTextContent(block);
        const highlightText = resolveSentenceHighlightText(blockText, action);
        if (!block || !highlightText) {
            return null;
        }

        const haystack = action.caseSensitive ? blockText : blockText.toLowerCase();
        const needle = action.caseSensitive ? highlightText : highlightText.toLowerCase();
        if (!haystack.includes(needle)) {
            return null;
        }

        const nextBlock = JSON.parse(JSON.stringify(block));
        nextBlock.formatting = {
            ...(nextBlock.formatting || {}),
            highlights: [
                ...((Array.isArray(nextBlock.formatting?.highlights) ? nextBlock.formatting.highlights : [])),
                {
                    text: highlightText,
                    color: normalizeNotesHighlightColor(action.color || action.highlightColor || 'yellow') || 'yellow'
                }
            ]
        };
        return nextBlock;
    }

    function normalizeDatabaseContentForAction(content = {}) {
        const source = content && typeof content === 'object' ? content : {};
        if (window.Blocks?.normalizeDatabaseContent) {
            return window.Blocks.normalizeDatabaseContent(source);
        }

        const sourceRows = Array.isArray(source.rows) ? source.rows : [];
        const maxRowWidth = sourceRows.reduce((maxWidth, row) => {
            if (Array.isArray(row)) return Math.max(maxWidth, row.length);
            if (Array.isArray(row?.cells)) return Math.max(maxWidth, row.cells.length);
            if (Array.isArray(row?.values)) return Math.max(maxWidth, row.values.length);
            return Math.max(maxWidth, 1);
        }, 0);
        const declaredColumns = Array.isArray(source.columns) && source.columns.length > 0
            ? source.columns
            : (Array.isArray(source.headers) ? source.headers : []);
        const pickColumnLabel = (column, index) => {
            if (column && typeof column === 'object' && !Array.isArray(column)) {
                const keys = ['header', 'label', 'name', 'title', 'columnName', 'fieldName', 'field', 'key', 'text', 'value', 'output_text', 'output', 'id'];
                for (const key of keys) {
                    const value = String(column[key] || '').trim();
                    if (value) return value;
                }
            }
            return String(column || '').trim() || `Column ${index + 1}`;
        };
        const isGenericColumnLabel = (label = '') => /^(?:output|output_text|output text|content|value|data|text)$/i.test(String(label || '').trim());
        const columns = declaredColumns.length > 0
            ? declaredColumns.map(pickColumnLabel)
            : ['Name', 'Status', 'Notes'];
        const labelCounts = columns.reduce((counts, label) => {
            const key = String(label || '').trim().toLowerCase();
            if (key) counts[key] = (counts[key] || 0) + 1;
            return counts;
        }, {});
        columns.forEach((label, index) => {
            const key = String(label || '').trim().toLowerCase();
            if (!label || (labelCounts[key] > 1 && isGenericColumnLabel(label))) {
                columns[index] = `Column ${index + 1}`;
            }
        });
        while (columns.length < maxRowWidth) {
            columns.push(`Column ${columns.length + 1}`);
        }
        const cellValue = (cell) => {
            if (cell == null) return '';
            if (typeof cell === 'object' && !Array.isArray(cell)) {
                for (const key of ['value', 'text', 'content', 'output_text', 'output', 'result', 'response']) {
                    const value = cell[key];
                    if (value != null && String(value).trim()) return String(value);
                }
                return '';
            }
            return String(cell);
        };
        const rows = sourceRows.map((row) => {
            let cells;
            if (Array.isArray(row)) {
                cells = row.slice();
            } else if (Array.isArray(row?.cells)) {
                cells = row.cells.slice();
            } else if (Array.isArray(row?.values)) {
                cells = row.values.slice();
            } else {
                cells = [row];
            }
            while (cells.length < columns.length) cells.push('');
            if (cells.length > columns.length) cells.length = columns.length;
            return cells.map(cellValue);
        });
        return {
            columns,
            rows,
            sortColumn: Number.isInteger(source.sortColumn) ? source.sortColumn : null,
            sortDirection: source.sortDirection === 'desc' ? 'desc' : 'asc',
        };
    }

    function resolveDatabaseColumnIndex(database = {}, columnRef = null) {
        const columns = Array.isArray(database.columns) ? database.columns : [];
        if (Number.isInteger(columnRef)) {
            return columnRef >= 0 && columnRef < columns.length ? columnRef : -1;
        }
        const numeric = Number(columnRef);
        if (Number.isInteger(numeric) && String(columnRef).trim() !== '') {
            const zeroBased = numeric - 1;
            return zeroBased >= 0 && zeroBased < columns.length ? zeroBased : -1;
        }
        const needle = String(columnRef || '').trim().toLowerCase();
        if (!needle) return -1;
        return columns.findIndex((column) => String(column || '').trim().toLowerCase() === needle);
    }

    function buildDatabaseUpdate(existingBlock = null, action = {}) {
        const existing = normalizeDatabaseContentForAction(existingBlock?.content || {});
        const rows = Array.isArray(action.rows)
            ? action.rows
            : existing.rows;
        const appendRows = Array.isArray(action.appendRows) ? action.appendRows : null;
        return normalizeDatabaseContentForAction({
            ...existing,
            columns: Array.isArray(action.columns) ? action.columns : existing.columns,
            rows: appendRows ? [...existing.rows, ...appendRows] : rows,
            sortColumn: Object.prototype.hasOwnProperty.call(action, 'sortColumn') ? action.sortColumn : existing.sortColumn,
            sortDirection: action.sortDirection || existing.sortDirection,
        });
    }

    function buildDatabaseFill(existingBlock = null, action = {}) {
        const database = normalizeDatabaseContentForAction(existingBlock?.content || {});
        const columnIndex = resolveDatabaseColumnIndex(database, action.columnIndex ?? action.column ?? action.columnName);
        if (columnIndex < 0) return null;

        const startRow = Math.max(0, Number.isInteger(action.rowStart) ? action.rowStart : Number(action.rowStart || 0));
        const requestedCount = Number(action.count || action.rowCount || 0);
        const values = Array.isArray(action.values)
            ? action.values
            : (() => {
                const start = Number(action.start ?? action.from ?? 1);
                const end = Number(action.end ?? action.to ?? 5);
                if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
                const step = Number(action.step || (end >= start ? 1 : -1));
                const generated = [];
                if (!step) return generated;
                for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
                    generated.push(value);
                    if (generated.length > 500) break;
                }
                return generated;
            })();
        if (!values.length && requestedCount <= 0) return null;

        const fillValues = values.length ? values : Array.from({ length: requestedCount }, (_entry, index) => index + 1);
        const rowsNeeded = startRow + fillValues.length;
        while (database.rows.length < rowsNeeded) {
            database.rows.push(Array(database.columns.length).fill(''));
        }
        database.rows = database.rows.map((row) => {
            const cells = Array.isArray(row) ? row.slice() : [row];
            while (cells.length < database.columns.length) cells.push('');
            return cells;
        });
        fillValues.forEach((value, offset) => {
            database.rows[startRow + offset][columnIndex] = value == null ? '' : String(value);
        });
        return normalizeDatabaseContentForAction(database);
    }

    function shouldStageNotesActions(actions = []) {
        if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') {
            return false;
        }
        if (typeof window.requestAnimationFrame !== 'function' || typeof document === 'undefined' || !document.body) {
            return false;
        }
        return actions.some((action) => /^(replace_section|move_section|insert_after_section|insert_before_section|insert_between_sections|insert_here|delete_section|delete_here|replace_block|move_block|reorder_block|move|replace_text|highlight_text|update_database|fill_database_column|change_block_type|set_block_type|convert_block_type)$/.test(String(action?.op || '').toLowerCase()));
    }

    function getActionStageDelay(action = {}, index = 0) {
        const op = String(action?.op || '').toLowerCase();
        const base = /section|rebuild|replace_page/.test(op) ? 850 : 520;
        return 260 + (index * base);
    }

    function applyNotesActions(actions = []) {
        const editor = window.Editor;
        if (!editor || !Array.isArray(actions) || actions.length === 0) {
            return { appliedCount: 0, focusBlockId: null };
        }

        const targetPageId = editor.getCurrentPage?.()?.id || null;
        let appliedCount = 0;
        let focusBlockId = null;
        
        // Get affected blocks for visual feedback
        const affectedBlockIds = getAffectedBlockIds(actions);
        
        // Highlight blocks before applying actions
        affectedBlockIds.forEach(blockId => {
            const action = actions.find(a => 
                a.blockId === blockId || a.targetBlockId === blockId
            );
            const actionType = action?.op?.includes('delete') ? 'deleting' : 
                              action?.op?.includes('insert') ? 'inserting' : 'editing';
            highlightBlock(blockId, actionType);
        });

        const applySingleAction = (rawAction) => {
            if (!rawAction || typeof rawAction !== 'object') return;
            if (targetPageId && editor.getCurrentPage?.()?.id !== targetPageId) return;

            const op = String(rawAction.op || '').toLowerCase();
            const targetBlockId = rawAction.blockId || rawAction.targetBlockId || null;
            const blockDefinitions = Array.isArray(rawAction.blocks)
                ? rawAction.blocks
                : (rawAction.block ? [rawAction.block] : []);

            try {
                switch (op) {
                    case 'update_page': {
                        const pageUpdates = {};
                        ['title', 'icon', 'cover', 'properties', 'defaultModel'].forEach((key) => {
                            if (Object.prototype.hasOwnProperty.call(rawAction, key)) {
                                pageUpdates[key] = rawAction[key];
                            }
                        });
                        editor.updatePageMetadata?.(pageUpdates);
                        appliedCount++;
                        break;
                    }
                    case 'update_block':
                    case 'change_block_type':
                    case 'set_block_type':
                    case 'convert_block_type': {
                        if (!targetBlockId) return;
                        const existing = editor.getBlock?.(targetBlockId);
                        if (!existing) return;

                        const nextType = rawAction.type || existing.type;
                        const nextContent = Object.prototype.hasOwnProperty.call(rawAction, 'content')
                            ? rawAction.content
                            : (Object.prototype.hasOwnProperty.call(rawAction, 'text')
                                ? rawAction.text
                                : existing.content);
                        const replacement = normalizeActionBlock({
                            ...JSON.parse(JSON.stringify(existing)),
                            id: targetBlockId,
                            type: nextType,
                            content: nextContent,
                            children: rawAction.keepChildren === false ? [] : (existing.children || []),
                            color: Object.prototype.hasOwnProperty.call(rawAction, 'color')
                                ? rawAction.color
                                : existing.color,
                            textColor: Object.prototype.hasOwnProperty.call(rawAction, 'textColor')
                                ? rawAction.textColor
                                : existing.textColor,
                            fontFamily: Object.prototype.hasOwnProperty.call(rawAction, 'fontFamily')
                                ? rawAction.fontFamily
                                : existing.fontFamily,
                            fontSize: Object.prototype.hasOwnProperty.call(rawAction, 'fontSize')
                                ? rawAction.fontSize
                                : existing.fontSize,
                            fontWeight: Object.prototype.hasOwnProperty.call(rawAction, 'fontWeight')
                                ? rawAction.fontWeight
                                : existing.fontWeight,
                            textAlign: Object.prototype.hasOwnProperty.call(rawAction, 'textAlign')
                                ? rawAction.textAlign
                                : existing.textAlign,
                            icon: Object.prototype.hasOwnProperty.call(rawAction, 'icon')
                                ? rawAction.icon
                                : existing.icon
                        }, { defaultType: nextType });
                        const updated = editor.updateBlockFields
                            ? editor.updateBlockFields(targetBlockId, replacement)
                            : null;
                        if (updated) {
                            focusBlockId = targetBlockId;
                            appliedCount++;
                            break;
                        }
                        const inserted = editor.replaceBlockWithBlocks?.(targetBlockId, [replacement]) || [];
                        if (!inserted.length) return;
                        focusBlockId = inserted[0]?.id || replacement.id || targetBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'update_database': {
                        if (!targetBlockId) return;
                        const existing = editor.getBlock?.(targetBlockId);
                        if (!existing || existing.type !== 'database') return;
                        const nextContent = buildDatabaseUpdate(existing, rawAction);
                        const updated = editor.updateDatabaseContent
                            ? editor.updateDatabaseContent(targetBlockId, nextContent)
                            : editor.updateBlockFields?.(targetBlockId, { content: nextContent });
                        if (!updated) return;
                        focusBlockId = targetBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'fill_database_column': {
                        if (!targetBlockId) return;
                        const existing = editor.getBlock?.(targetBlockId);
                        if (!existing || existing.type !== 'database') return;
                        const nextContent = buildDatabaseFill(existing, rawAction);
                        if (!nextContent) return;
                        const updated = editor.updateDatabaseContent
                            ? editor.updateDatabaseContent(targetBlockId, nextContent)
                            : editor.updateBlockFields?.(targetBlockId, { content: nextContent });
                        if (!updated) return;
                        focusBlockId = targetBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'replace_text': {
                        if (!targetBlockId) return;
                        const existing = editor.getBlock?.(targetBlockId);
                        if (!existing) return;
                        const replacement = replaceSpecificBlockText(existing, rawAction);
                        if (!replacement) return;
                        const updated = editor.updateBlockFields
                            ? editor.updateBlockFields(targetBlockId, replacement)
                            : null;
                        if (!updated) {
                            const inserted = editor.replaceBlockWithBlocks?.(targetBlockId, [replacement]) || [];
                            if (!inserted.length) return;
                        }
                        focusBlockId = targetBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'highlight_text': {
                        if (!targetBlockId) return;
                        const existing = editor.getBlock?.(targetBlockId);
                        if (!existing) return;
                        const replacement = addBlockTextHighlight(existing, rawAction);
                        if (!replacement) return;
                        const updated = editor.updateBlockFields
                            ? editor.updateBlockFields(targetBlockId, replacement)
                            : null;
                        if (!updated) {
                            const inserted = editor.replaceBlockWithBlocks?.(targetBlockId, [replacement]) || [];
                            if (!inserted.length) return;
                        }
                        focusBlockId = targetBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'replace_block': {
                        if (!targetBlockId) return;
                        const replacements = (blockDefinitions.length ? blockDefinitions : [rawAction]).map((blockDef, index) => {
                            const normalized = normalizeActionBlock(blockDef, {
                                defaultType: rawAction.type || blockDef.type || 'text'
                            });
                            if (index === 0 && !normalized.id) {
                                normalized.id = targetBlockId;
                            }
                            return normalized;
                        });
                        const inserted = editor.replaceBlockWithBlocks?.(targetBlockId, replacements) || [];
                        focusBlockId = inserted[inserted.length - 1]?.id || focusBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'replace_section': {
                        const headingBlockId = rawAction.headingBlockId
                            || rawAction.sectionBlockId
                            || rawAction.blockId
                            || targetBlockId;
                        if (!headingBlockId) return;
                        const replacements = (blockDefinitions.length ? blockDefinitions : [rawAction]).map((blockDef) => normalizeActionBlock(blockDef, {
                            defaultType: rawAction.type || blockDef.type || 'text'
                        }));
                        const inserted = editor.replaceSectionFromHeading
                            ? (editor.replaceSectionFromHeading(headingBlockId, replacements) || [])
                            : (editor.replaceBlockWithBlocks?.(headingBlockId, replacements) || []);
                        focusBlockId = inserted[0]?.id || inserted[inserted.length - 1]?.id || focusBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'move_block':
                    case 'reorder_block':
                    case 'move': {
                        const moveBlockId = targetBlockId || rawAction.draggedBlockId || rawAction.sourceBlockId || null;
                        const destinationBlockId = rawAction.targetBlockId || rawAction.destinationBlockId || rawAction.referenceBlockId || rawAction.anchorBlockId || null;
                        const position = String(rawAction.position || 'after').toLowerCase() === 'before' ? 'before' : 'after';
                        if (!moveBlockId || !destinationBlockId || moveBlockId === destinationBlockId) return;
                        editor.reorderBlocks?.(moveBlockId, destinationBlockId, position);
                        focusBlockId = moveBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'move_section':
                    case 'reorder_section': {
                        const headingBlockId = rawAction.headingBlockId
                            || rawAction.sectionBlockId
                            || rawAction.blockId
                            || rawAction.sourceBlockId
                            || rawAction.draggedBlockId
                            || null;
                        const destinationHeadingId = rawAction.targetHeadingBlockId
                            || rawAction.targetSectionBlockId
                            || rawAction.targetBlockId
                            || rawAction.destinationBlockId
                            || rawAction.referenceBlockId
                            || rawAction.anchorBlockId
                            || null;
                        const position = String(rawAction.position || 'after').toLowerCase() === 'before' ? 'before' : 'after';
                        if (!headingBlockId || !destinationHeadingId || headingBlockId === destinationHeadingId) return;
                        const moved = editor.moveSection
                            ? editor.moveSection(headingBlockId, destinationHeadingId, position)
                            : editor.reorderBlocks?.(headingBlockId, destinationHeadingId, position);
                        if (!moved) return;
                        focusBlockId = headingBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'insert_here': {
                        const anchorBlockId = rawAction.headingBlockId
                            || rawAction.sectionBlockId
                            || rawAction.blockId
                            || rawAction.targetBlockId
                            || targetBlockId
                            || null;
                        if (!anchorBlockId) return;
                        const position = String(rawAction.position || 'after').toLowerCase() === 'before' ? 'before' : 'after';
                        const scope = String(rawAction.scope || rawAction.targetScope || '').toLowerCase();
                        const blocksToInsert = blockDefinitions.length ? blockDefinitions : [{
                            type: rawAction.type || 'text',
                            content: rawAction.content || ''
                        }];
                        const normalizedBlocks = blocksToInsert.map((blockDef) => normalizeActionBlock(blockDef, {
                            defaultType: rawAction.type || blockDef.type || 'text'
                        }));
                        const useSectionAnchor = scope === 'section'
                            || rawAction.headingBlockId
                            || rawAction.sectionBlockId;
                        const inserted = useSectionAnchor
                            ? (position === 'before'
                                ? (editor.insertBlocksBeforeSection?.(anchorBlockId, normalizedBlocks) || editor.insertBlocksBefore?.(anchorBlockId, normalizedBlocks) || [])
                                : (editor.insertBlocksAfterSection?.(anchorBlockId, normalizedBlocks) || editor.insertBlocksAfter?.(anchorBlockId, normalizedBlocks) || []))
                            : (position === 'before'
                                ? (editor.insertBlocksBefore?.(anchorBlockId, normalizedBlocks) || [])
                                : (editor.insertBlocksAfter?.(anchorBlockId, normalizedBlocks) || []));
                        if (!inserted.length) return;
                        focusBlockId = inserted[inserted.length - 1]?.id || focusBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'insert_between_sections': {
                        const afterHeadingBlockId = rawAction.afterHeadingBlockId
                            || rawAction.previousHeadingBlockId
                            || rawAction.headingBlockId
                            || rawAction.sectionBlockId
                            || null;
                        const beforeHeadingBlockId = rawAction.beforeHeadingBlockId
                            || rawAction.nextHeadingBlockId
                            || rawAction.targetHeadingBlockId
                            || rawAction.targetSectionBlockId
                            || null;
                        const blocksToInsert = blockDefinitions.length ? blockDefinitions : [{
                            type: rawAction.type || 'text',
                            content: rawAction.content || ''
                        }];
                        const normalizedBlocks = blocksToInsert.map((blockDef) => normalizeActionBlock(blockDef, {
                            defaultType: rawAction.type || blockDef.type || 'text'
                        }));
                        const inserted = afterHeadingBlockId
                            ? (editor.insertBlocksAfterSection?.(afterHeadingBlockId, normalizedBlocks) || editor.insertBlocksAfter?.(afterHeadingBlockId, normalizedBlocks) || [])
                            : (beforeHeadingBlockId
                                ? (editor.insertBlocksBeforeSection?.(beforeHeadingBlockId, normalizedBlocks) || editor.insertBlocksBefore?.(beforeHeadingBlockId, normalizedBlocks) || [])
                                : []);
                        if (!inserted.length) return;
                        focusBlockId = inserted[inserted.length - 1]?.id || focusBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'insert_after': {
                        const insertAfterId = targetBlockId || getLastBlockId();
                        const blocksToInsert = blockDefinitions.length ? blockDefinitions : [{
                            type: rawAction.type || 'text',
                            content: rawAction.content || ''
                        }];
                        const inserted = editor.insertBlocksAfter?.(
                            insertAfterId,
                            blocksToInsert.map((blockDef) => normalizeActionBlock(blockDef, {
                                defaultType: rawAction.type || blockDef.type || 'text'
                            }))
                        ) || [];
                        focusBlockId = inserted[inserted.length - 1]?.id || focusBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'insert_after_section': {
                        const headingBlockId = rawAction.headingBlockId
                            || rawAction.sectionBlockId
                            || rawAction.blockId
                            || targetBlockId
                            || getLastBlockId();
                        if (!headingBlockId) return;
                        const blocksToInsert = blockDefinitions.length ? blockDefinitions : [{
                            type: rawAction.type || 'text',
                            content: rawAction.content || ''
                        }];
                        const normalizedBlocks = blocksToInsert.map((blockDef) => normalizeActionBlock(blockDef, {
                            defaultType: rawAction.type || blockDef.type || 'text'
                        }));
                        const inserted = editor.insertBlocksAfterSection
                            ? (editor.insertBlocksAfterSection(headingBlockId, normalizedBlocks) || [])
                            : (editor.insertBlocksAfter?.(headingBlockId, normalizedBlocks) || []);
                        focusBlockId = inserted[inserted.length - 1]?.id || focusBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'insert_before': {
                        const insertBeforeId = targetBlockId || getFirstBlockId();
                        if (!insertBeforeId) return;
                        const blocksToInsert = blockDefinitions.length ? blockDefinitions : [{
                            type: rawAction.type || 'text',
                            content: rawAction.content || ''
                        }];
                        const inserted = editor.insertBlocksBefore?.(
                            insertBeforeId,
                            blocksToInsert.map((blockDef) => normalizeActionBlock(blockDef, {
                                defaultType: rawAction.type || blockDef.type || 'text'
                            }))
                        ) || [];
                        focusBlockId = inserted[inserted.length - 1]?.id || focusBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'insert_before_section': {
                        const headingBlockId = rawAction.headingBlockId
                            || rawAction.sectionBlockId
                            || rawAction.blockId
                            || targetBlockId
                            || getFirstBlockId();
                        if (!headingBlockId) return;
                        const blocksToInsert = blockDefinitions.length ? blockDefinitions : [{
                            type: rawAction.type || 'text',
                            content: rawAction.content || ''
                        }];
                        const normalizedBlocks = blocksToInsert.map((blockDef) => normalizeActionBlock(blockDef, {
                            defaultType: rawAction.type || blockDef.type || 'text'
                        }));
                        const inserted = editor.insertBlocksBeforeSection
                            ? (editor.insertBlocksBeforeSection(headingBlockId, normalizedBlocks) || [])
                            : (editor.insertBlocksBefore?.(headingBlockId, normalizedBlocks) || []);
                        focusBlockId = inserted[inserted.length - 1]?.id || focusBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'append_to_page':
                    case 'append': {
                        const blocksToInsert = blockDefinitions.length ? blockDefinitions : [{
                            type: rawAction.type || 'text',
                            content: rawAction.content || ''
                        }];
                        const lastBlockId = getLastBlockId();
                        const normalizedBlocks = blocksToInsert.map((blockDef) => normalizeActionBlock(blockDef, {
                            defaultType: rawAction.type || blockDef.type || 'text'
                        }));
                        const inserted = lastBlockId
                            ? (editor.insertBlocksAfter?.(lastBlockId, normalizedBlocks) || [])
                            : (editor.insertBlocksAfter?.(null, normalizedBlocks) || []);
                        focusBlockId = inserted[inserted.length - 1]?.id || focusBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'prepend_to_page':
                    case 'prepend': {
                        const firstBlockId = getFirstBlockId();
                        const blocksToInsert = blockDefinitions.length ? blockDefinitions : [{
                            type: rawAction.type || 'text',
                            content: rawAction.content || ''
                        }];
                        const normalizedBlocks = blocksToInsert.map((blockDef) => normalizeActionBlock(blockDef, {
                            defaultType: rawAction.type || blockDef.type || 'text'
                        }));
                        const inserted = firstBlockId
                            ? (editor.insertBlocksBefore?.(firstBlockId, normalizedBlocks) || [])
                            : (editor.insertBlocksAfter?.(null, normalizedBlocks) || []);
                        focusBlockId = inserted[inserted.length - 1]?.id || focusBlockId;
                        appliedCount++;
                        break;
                    }
                    case 'rebuild_page':
                    case 'replace_page': {
                        const rebuiltBlocks = (blockDefinitions.length ? blockDefinitions : []).map((blockDef) => normalizeActionBlock(blockDef, {
                            defaultType: blockDef.type || 'text'
                        }));
                        if (!editor.importBlocks || rebuiltBlocks.length === 0) return;

                        const pageUpdates = {};
                        ['title', 'icon', 'cover', 'properties', 'defaultModel'].forEach((key) => {
                            if (Object.prototype.hasOwnProperty.call(rawAction, key)) {
                                pageUpdates[key] = rawAction[key];
                            }
                        });
                        if (Object.keys(pageUpdates).length > 0) {
                            editor.updatePageMetadata?.(pageUpdates);
                        }

                        const imported = editor.importBlocks(rebuiltBlocks, { replace: true });
                        focusBlockId = window.Editor?.getCurrentPage?.()?.blocks?.[0]?.id || focusBlockId;
                        if (Array.isArray(imported) ? imported.length > 0 : (!editor.getCurrentPage || window.Editor?.getCurrentPage?.()?.id === targetPageId)) {
                            appliedCount++;
                        }
                        break;
                    }
                    case 'delete_here': {
                        const headingBlockId = rawAction.headingBlockId
                            || rawAction.sectionBlockId
                            || null;
                        const deleteBlockId = rawAction.blockId || rawAction.targetBlockId || targetBlockId;
                        const scope = String(rawAction.scope || rawAction.targetScope || '').toLowerCase();
                        if ((scope === 'section' || headingBlockId) && (headingBlockId || deleteBlockId)) {
                            const deleted = editor.deleteSectionFromHeading
                                ? editor.deleteSectionFromHeading(headingBlockId || deleteBlockId)
                                : editor.deleteBlock?.(headingBlockId || deleteBlockId);
                            if (!deleted && editor.deleteSectionFromHeading) return;
                            appliedCount++;
                            break;
                        }
                        if (!deleteBlockId) return;
                        editor.deleteBlock?.(deleteBlockId);
                        appliedCount++;
                        break;
                    }
                    case 'delete_block':
                    case 'delete': {
                        if (!targetBlockId) return;
                        editor.deleteBlock?.(targetBlockId);
                        appliedCount++;
                        break;
                    }
                    case 'delete_section': {
                        const headingBlockId = rawAction.headingBlockId
                            || rawAction.sectionBlockId
                            || rawAction.blockId
                            || targetBlockId;
                        if (!headingBlockId) return;
                        const deleted = editor.deleteSectionFromHeading
                            ? editor.deleteSectionFromHeading(headingBlockId)
                            : editor.deleteBlock?.(headingBlockId);
                        if (!deleted && editor.deleteSectionFromHeading) return;
                        appliedCount++;
                        break;
                    }
                    default:
                        break;
                }
            } catch (error) {
                console.error(`Failed to apply notes action "${op}":`, error);
            }
        };

        const finalizeAppliedActions = () => {
            if (appliedCount <= 0) {
                unhighlightAllBlocks();
                return;
            }
            editor.savePage?.();
            if (focusBlockId) {
                editor.focusBlock?.(focusBlockId);
            }

            // Remove highlights after a delay
            setTimeout(() => {
                unhighlightAllBlocks();
            }, 2000);
        };

        if (shouldStageNotesActions(actions)) {
            actions.forEach((rawAction, index) => {
                window.setTimeout(() => {
                    if (targetPageId && editor.getCurrentPage?.()?.id !== targetPageId) {
                        if (index === actions.length - 1) {
                            finalizeAppliedActions();
                        }
                        return;
                    }
                    applySingleAction(rawAction);
                    if (index === actions.length - 1) {
                        finalizeAppliedActions();
                    }
                }, getActionStageDelay(rawAction, index));
            });

            return { appliedCount: actions.length, focusBlockId, staged: true };
        }

        actions.forEach(applySingleAction);
        finalizeAppliedActions();

        return { appliedCount, focusBlockId };
    }

    function prepareAssistantResponse(responseText, options = {}) {
        const {
            question = '',
            context = null,
            toolEvents = [],
        } = options;
        const parsed = extractNotesActionPlan(responseText);
        const normalizedActions = normalizeStructuredPageActions(parsed.actions, question, context, toolEvents);
        const applied = applyNotesActions(normalizedActions);
        const actionCount = Array.isArray(normalizedActions) ? normalizedActions.length : 0;

        if (actionCount > 0 || parsed.parseFailed) {
            const detail = {
                actionCount,
                appliedCount: applied.appliedCount,
                parseFailed: Boolean(parsed.parseFailed),
                structuredResponse: looksLikeNotesActionResponse(responseText),
                responseLength: String(responseText || '').length
            };

            try {
                window.dispatchEvent(new CustomEvent('notes-agent-parse', {
                    detail: {
                        model: state.selectedModel,
                        ...detail
                    }
                }));
            } catch (error) {
                console.warn('Failed to dispatch notes parse event:', error);
            }

            if (parsed.parseFailed || (actionCount > 0 && applied.appliedCount === 0)) {
                console.warn('Notes structured response was not fully applied:', detail);
            } else if (actionCount > 0) {
                console.info('Notes structured response parsed and applied:', detail);
            }
        }

        const fallbackReply = summarizeAppliedNotesActions(normalizedActions, applied.appliedCount);
        const shouldUseFallbackReply = !parsed.displayText || looksLikeShortAcknowledgement(parsed.displayText);

        return {
            displayText: (shouldUseFallbackReply ? fallbackReply : parsed.displayText) || (parsed.parseFailed
                ? 'I prepared page updates, but the response could not be applied automatically. Please try again.'
                : ''),
            appliedCount: applied.appliedCount
        };
    }

    function resolveVisibleAssistantText(preparedDisplayText = '', responseText = '') {
        const normalizedPrepared = stripInternalToolCallMarkup(preparedDisplayText).trim();
        if (normalizedPrepared
            && !isAssistantReplyPlaceholderText(normalizedPrepared)
            && !looksLikeInternalNotesScaffold(normalizedPrepared)) {
            return normalizedPrepared;
        }

        const normalizedGeneric = unwrapGenericResponseContent(responseText);
        if (normalizedGeneric
            && !looksLikeNotesActionResponse(responseText)
            && !isAssistantReplyPlaceholderText(normalizedGeneric)) {
            return normalizedGeneric;
        }

        const strippedStructured = stripStructuredResponseText(responseText);
        if (strippedStructured && !isAssistantReplyPlaceholderText(strippedStructured)) {
            return strippedStructured;
        }

        return '';
    }

    function getStreamingVisibleText(text) {
        const value = stripInternalToolCallMarkup(text);
        const trimmed = value.trim();

        if (/^\{[\s\S]*"\s*(?:actions|operations|edits)\s*"\s*:/i.test(trimmed)
            && hasLooseAssistantReplyKey(trimmed)) {
            return '';
        }

        if (looksLikeInternalNotesScaffold(trimmed)) {
            return '';
        }

        return stripStructuredResponseText(
            value
                .replace(/```+\s*notes\s*(?:[_-]|\s)\s*actions[\s\S]*$/i, '')
                .replace(/```+\s*json[\s\S]*?(?:"\s*assistant\s*(?:[_-]|\s)?\s*reply\s*"|"\s*actions\s*")[\s\S]*$/i, '')
        ).trimEnd();
    }

    function isInvalidGatewayResponseText(text) {
        const normalized = String(text || '').trim().toLowerCase().replace(/[’]/g, '\'');
        if (!normalized) return false;

        return normalized.includes('support@backend.io') ||
            normalized.includes('docs.backend.io/cli') ||
            (normalized.includes('need help?') && normalized.includes('backend.io')) ||
            normalized.includes('cli_help sub-agent') ||
            normalized.includes('generalist agent') ||
            normalized.includes('grep_search') ||
            normalized.includes('provided file-system tools') ||
            normalized.includes('current environment\'s available toolset') ||
            normalized.includes('current workspace in /app') ||
            normalized.includes('i do not have access to an ssh-execute tool') ||
            normalized.includes('i do not have a usable remote-build or ssh execution tool') ||
            normalized.includes('i can\'t access the remote server from this environment') ||
            normalized.includes('i cannot access the remote server from this environment') ||
            normalized.includes('this session is restricted from network/ssh access') ||
            normalized.includes('this session is restricted from network access') ||
            normalized.includes('no ssh/network path to the remote server') ||
            normalized.includes('no ssh path to the remote server') ||
            normalized.includes('i can\'t run remote-build') ||
            normalized.includes('i cannot run remote-build') ||
            normalized.includes('i can\'t connect via ssh') ||
            normalized.includes('i cannot connect via ssh') ||
            normalized.includes('i can\'t execute ssh from this session') ||
            normalized.includes('i cannot execute ssh from this session') ||
            normalized.includes('bwrap: no permissions to create a new namespace') ||
            normalized.includes('bwrap: no permissions to create a new na') ||
            normalized.includes('bwrap: no permissions') ||
            normalized.includes('basic local commands fail before any ssh attempt') ||
            normalized.includes('testing command execution first') ||
            normalized.includes('earlier retries were failing before any remote connection could start') ||
            normalized.includes('local shell startup still breaks') ||
            normalized.includes('fails before any remote connection starts') ||
            normalized.includes('fails before any network connection starts') ||
            normalized.includes('workspace can execute anything locally') ||
            normalized.includes('launch a remote check from /app') ||
            normalized.includes('can\'t inspect config or launch a remote check from /app') ||
            normalized.includes('what i can do from this session') ||
            normalized.includes('what i cannot do in this session') ||
            normalized.includes('runtime exposes a writable file tool') ||
            normalized.includes('github/canva connector tools') ||
            normalized.includes('create a new local git repo in /app') ||
            normalized.includes('i cannot create a new repo from this exact turn') ||
            normalized.includes('run git init, builds, or normal shell commands') ||
            normalized.includes('modify the local filesystem') ||
            normalized.includes('the exact blocker is the runtime sandbox') ||
            normalized.includes('kernel does not allow non-privileged user namespaces') ||
            normalized.startsWith('<!doctype html') ||
            normalized.startsWith('<html');
    }

    function isToolRuntimeSensitiveIntent(question = '', requestOptions = {}) {
        if (requestOptions?.outputFormat) {
            return false;
        }

        const normalized = String(question || '').trim().toLowerCase();
        if (!normalized) {
            return false;
        }

        return [
            /\bssh\b/,
            /\bssh-execute\b/,
            /\bremote-build\b/,
            /\bremote command\b/,
            /\bremote server\b/,
            /\bremote host\b/,
            /\bserver\b[\s\S]{0,40}\b(check|inspect|debug|deploy|build|install|setup|health)\b/,
            /\b(cluster|k3s|kubernetes|k8s|kubectl|docker|traefik|cert-manager|let'?s encrypt|acme)\b/,
            /\bweb research\b/,
            /\bsearch the web\b/,
            /\bbrowse online\b/,
            /\bscrape\b/,
            /\btool\b[\s\S]{0,20}\b(work|call|run|use|available)\b/,
        ].some((pattern) => pattern.test(normalized));
    }

    function isToolCompatibleNotesModelId(modelId = '') {
        const id = String(modelId || '').trim().toLowerCase();
        if (!id) {
            return false;
        }

        return isSupportedNotesModelId(id);
    }

    function getAvailableNotesModelIds(options = {}) {
        const {
            toolCompatibleOnly = false
        } = options;

        return (getModels() || [])
            .map((model) => model?.id || model)
            .map((modelId) => String(modelId || '').trim())
            .filter(Boolean)
            .filter((modelId) => (toolCompatibleOnly ? isToolCompatibleNotesModelId(modelId) : isSupportedNotesModelId(modelId)));
    }

    function isToolExecutionFailure(error = null) {
        const normalized = String(error?.message || '').trim().toLowerCase();
        if (!normalized) {
            return false;
        }

        return [
            /\bssh\b/,
            /\bssh-execute\b/,
            /\bremote-build\b/,
            /\bremote command\b/,
            /\btool invocation failed\b/,
            /\btool execution failed\b/,
            /\bfailed to load tools\b/,
            /\bmissing-target\b/,
            /\bcredential\b/,
            /\bhost\b/,
            /\bconnection refused\b/,
            /\btimed out\b/,
            /\bpermission denied\b/,
            /\bkubectl\b/,
            /\bk3s\b/,
            /\bcluster\b/,
        ].some((pattern) => pattern.test(normalized));
    }

    function shouldRetryWithAlternateModel(error = null) {
        const status = Number(error?.status || 0);
        const normalized = String(error?.message || '').trim().toLowerCase();

        if (!normalized && !status) {
            return false;
        }

        if (isToolExecutionFailure(error)) {
            return false;
        }

        if (status === 404 && /\b(model|resource was not found|not found)\b/.test(normalized)) {
            return true;
        }

        if (status === 502 && /invalid response returned by the ai gateway/.test(normalized)) {
            return true;
        }

        return /server error|api request failed|streaming error|invalid response returned by the ai gateway|model .* failed|unsupported model/.test(normalized);
    }

    function buildCandidateModelsForRequest(question = '', preferredModel = 'gpt-4o', requestOptions = {}) {
        const toolSensitiveRequest = isToolRuntimeSensitiveIntent(question, requestOptions);
        const ordered = [];
        const pushUnique = (modelId) => {
            const normalized = String(modelId || '').trim();
            if (!normalized || ordered.includes(normalized) || !isSupportedNotesModelId(normalized)) {
                return;
            }
            ordered.push(normalized);
        };

        if (toolSensitiveRequest) {
            const availableModelIds = getAvailableNotesModelIds({ toolCompatibleOnly: true });

            if (isToolCompatibleNotesModelId(preferredModel)) {
                pushUnique(preferredModel);
            }
            if (ordered.length === 0) {
                availableModelIds.forEach(pushUnique);
            }
            return ordered;
        }

        pushUnique(preferredModel);
        getAvailableNotesModelIds().forEach(pushUnique);
        return ordered;
    }

    // ============================================
    // Visual Feedback for AI Actions
    // ============================================
    
    /**
     * Highlight a block to show AI is working on it
     * @param {string} blockId - The block ID to highlight
     * @param {string} action - The action being performed ('editing', 'inserting', 'deleting')
     */
    function highlightBlock(blockId, action = 'editing') {
        if (!blockId) return;
        
        const blockElement = document.querySelector(`[data-block-id="${blockId}"]`);
        if (!blockElement) return;
        
        // Remove any existing AI state classes
        blockElement.classList.remove('ai-editing', 'ai-inserting', 'ai-deleting');
        
        // Add appropriate class based on action
        blockElement.classList.add(`ai-${action}`);
        
        // Scroll block into view if needed
        blockElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        return blockElement;
    }
    
    /**
     * Remove AI highlight from a block
     * @param {string} blockId - The block ID to unhighlight
     */
    function unhighlightBlock(blockId) {
        if (!blockId) return;
        
        const blockElement = document.querySelector(`[data-block-id="${blockId}"]`);
        if (!blockElement) return;
        
        blockElement.classList.remove('ai-editing', 'ai-inserting', 'ai-deleting');
        return blockElement;
    }
    
    /**
     * Unhighlight all AI-affected blocks
     */
    function unhighlightAllBlocks() {
        document.querySelectorAll('.ai-editing, .ai-inserting, .ai-deleting').forEach(el => {
            el.classList.remove('ai-editing', 'ai-inserting', 'ai-deleting');
        });
    }
    
    /**
     * Show toast notification for completed AI actions
     * @param {number} actionCount - Number of actions applied
     * @param {string} description - Description of what was done
     */
    function showActionToast(actionCount, description = '') {
        // Page-write completion is already visible through staged highlights and
        // chat context. Keep this hook quiet so Notes edits do not create a
        // modal-feeling success/failure popup after every agent write.
        void actionCount;
        void description;
    }
    
    /**
     * Extract block IDs from actions for highlighting
     * @param {Array} actions - Array of action objects
     * @returns {Array} Array of block IDs affected
     */
    function getAffectedBlockIds(actions = []) {
        const blockIds = new Set();
        
        actions.forEach(action => {
            if (action.blockId) blockIds.add(action.blockId);
            if (action.headingBlockId) blockIds.add(action.headingBlockId);
            if (action.sectionBlockId) blockIds.add(action.sectionBlockId);
            if (action.targetBlockId) blockIds.add(action.targetBlockId);
            if (action.targetHeadingBlockId) blockIds.add(action.targetHeadingBlockId);
            if (action.targetSectionBlockId) blockIds.add(action.targetSectionBlockId);
            if (action.afterHeadingBlockId) blockIds.add(action.afterHeadingBlockId);
            if (action.beforeHeadingBlockId) blockIds.add(action.beforeHeadingBlockId);
            if (action.previousHeadingBlockId) blockIds.add(action.previousHeadingBlockId);
            if (action.nextHeadingBlockId) blockIds.add(action.nextHeadingBlockId);
            if (action.draggedBlockId) blockIds.add(action.draggedBlockId);
            if (action.sourceBlockId) blockIds.add(action.sourceBlockId);
            if (action.destinationBlockId) blockIds.add(action.destinationBlockId);
            if (action.referenceBlockId) blockIds.add(action.referenceBlockId);
            if (action.anchorBlockId) blockIds.add(action.anchorBlockId);
            
            // Also check for blocks being inserted (they won't have IDs yet, but their neighbors will)
            if (action.blocks && Array.isArray(action.blocks)) {
                // For insert operations, highlight the reference block
                if (action.blockId) blockIds.add(action.blockId);
            }
        });
        
        return Array.from(blockIds);
    }

    function getStoredModelId() {
        try {
            return localStorage.getItem(SHARED_MODEL_STORAGE_KEY) ||
                localStorage.getItem(LEGACY_MODEL_STORAGE_KEY) ||
                'gpt-4o';
        } catch (error) {
            return 'gpt-4o';
        }
    }

    function persistSelectedModel(modelId) {
        try {
            localStorage.setItem(SHARED_MODEL_STORAGE_KEY, modelId);
            localStorage.setItem(LEGACY_MODEL_STORAGE_KEY, modelId);
        } catch (error) {
            console.warn('Failed to persist selected model:', error);
        }
    }

    function getStoredAgentProfileId() {
        try {
            const stored = localStorage.getItem(AGENT_PROFILE_STORAGE_KEY);
            return NOTES_AGENT_PROFILES.some((profile) => profile.id === stored)
                ? stored
                : NOTES_AGENT_PROFILES[0].id;
        } catch (error) {
            return NOTES_AGENT_PROFILES[0].id;
        }
    }

    function persistSelectedAgentProfile(profileId) {
        try {
            localStorage.setItem(AGENT_PROFILE_STORAGE_KEY, profileId);
        } catch (error) {
            console.warn('Failed to persist selected agent profile:', error);
        }
    }

    function getAgentProfiles() {
        return NOTES_AGENT_PROFILES.map((profile) => ({ ...profile }));
    }

    function getAgentProfile(profileId = state.selectedAgentProfileId) {
        return NOTES_AGENT_PROFILES.find((profile) => profile.id === profileId) || NOTES_AGENT_PROFILES[0];
    }

    function getSelectedAgentProfile() {
        return getAgentProfile(state.selectedAgentProfileId);
    }

    function setSelectedAgentProfile(profileId) {
        const nextProfile = getAgentProfile(profileId);
        if (!nextProfile || nextProfile.id !== profileId) {
            return false;
        }

        state.selectedAgentProfileId = nextProfile.id;
        persistSelectedAgentProfile(nextProfile.id);

        try {
            window.dispatchEvent(new CustomEvent('notes-agent-profile-changed', {
                detail: { profile: { ...nextProfile } }
            }));
        } catch (error) {
            console.warn('Failed to dispatch agent profile change event:', error);
        }

        return true;
    }

    function buildAgentProfileMetadata(profile = getSelectedAgentProfile()) {
        return {
            id: profile.id,
            name: profile.name,
            shortName: profile.shortName,
            bestFor: profile.bestFor,
        };
    }

    function buildAgentProfilePromptGuidance(profile = getSelectedAgentProfile()) {
        if (!profile) {
            return '';
        }

        return [
            `Selected buddy: ${profile.name}`,
            `Best for: ${profile.bestFor}`,
            `Personality and style: ${profile.style}`,
            `Tool and block use: ${profile.toolUse}`,
            `Work bias: ${profile.actionBias}`,
            'Keep this as a working personality layer, not a costume. The profile should shape judgment, wording, tool choice, and page structure while still obeying the notes-actions contract above all else.',
        ].join('\n');
    }

    function isSupportedNotesModelId(modelId) {
        const id = String(modelId || '').trim().toLowerCase();
        if (!id) return false;

        const looksLikeChatModel = [
            'gpt',
            'claude',
            'gemini',
            'kimi',
            'llama',
            'mistral',
            'qwen',
            'phi',
            'ollama',
            'antigravity',
            'deepseek',
            'deepseak',
        ].some((token) => id.includes(token));

        const looksUnsupported = [
            'image',
            'embedding',
            'tts',
            'transcribe',
            'audio',
            'realtime',
            'vision-preview',
            'preview-tools',
            '-tools',
            'codex',
            'computer-use',
            'computer_use',
        ].some((token) => id.includes(token));

        return looksLikeChatModel && !looksUnsupported;
    }
    
    // ============================================
    // State Management
    // ============================================
    const state = {
        selectedModel: getStoredModelId(),
        selectedAgentProfileId: getStoredAgentProfileId(),
        isActive: false,
        messages: [],
        activePageId: null,
        sharedSessionId: null,
        isProcessing: false,
        streamingEnabled: true,
        cachedModels: null,
        modelsCacheTime: null
    };

    function emitConversationChange(detail = {}) {
        try {
            window.dispatchEvent(new CustomEvent('notes-agent-context-changed', {
                detail: {
                    pageId: state.activePageId,
                    messageCount: state.messages.length,
                    ...detail
                }
            }));
        } catch (error) {
            console.warn('Failed to dispatch conversation change event:', error);
        }
    }

    function syncConversationWithCurrentPage(options = {}) {
        const {
            pageId = getCurrentPageSessionId(),
            emitEvent = true
        } = options;
        const conversationId = getConversationSessionId({ pageId });

        if (!conversationId) {
            return state.messages;
        }

        if (state.activePageId === conversationId) {
            syncAPIClientSession(getAPIClient(), { pageId: conversationId });
            if (emitEvent) {
                emitConversationChange({ reason: 'page-sync' });
            }
            return state.messages;
        }

        state.activePageId = conversationId;
        state.messages = readStoredMessages(conversationId).slice(-100);
        syncAPIClientSession(getAPIClient(), { pageId: conversationId });

        if (emitEvent) {
            emitConversationChange({ reason: 'page-switch' });
        }

        return state.messages;
    }

    function setProcessingState(isProcessing, detail = {}) {
        state.isProcessing = Boolean(isProcessing);

        try {
            window.dispatchEvent(new CustomEvent('notes-agent-processing', {
                detail: {
                    isProcessing: state.isProcessing,
                    model: state.selectedModel,
                    ...detail
                }
            }));
        } catch (error) {
            console.warn('Failed to dispatch agent processing event:', error);
        }
    }

    function yieldToBrowser() {
        return new Promise((resolve) => {
            if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(() => resolve());
                return;
            }

            setTimeout(resolve, 0);
        });
    }

    const MODEL_DISPLAY_NAMES = {
        'gpt-4o': 'GPT-4o',
        'gpt-4o-mini': 'GPT-4o Mini',
        'gpt-4-turbo': 'GPT-4 Turbo',
        'gpt-4': 'GPT-4',
        'gpt-3.5-turbo': 'GPT-3.5 Turbo',
        'o1-preview': 'o1 Preview',
        'o1-mini': 'o1 Mini',
        'o3-mini': 'o3 Mini',
        'o4-mini': 'o4 Mini',
        'kimi-k2': 'Lilly K2',
        'kimi-k2-mini': 'Lilly K2 Mini',
        'claude-sonnet-4': 'Claude Sonnet 4',
        'claude-haiku-4': 'Claude Haiku 4',
        'claude-3-opus': 'Claude 3 Opus',
        'claude-3-sonnet': 'Claude 3 Sonnet',
        'claude-3-haiku': 'Claude 3 Haiku',
        'claude-3-5-sonnet': 'Claude 3.5 Sonnet',
        'claude-3.5-sonnet-latest': 'Claude 3.5 Sonnet Latest',
    };

    const MODEL_DESCRIPTIONS = {
        'gpt-4o': 'Most capable multimodal model',
        'gpt-4o-mini': 'Fast and affordable',
        'gpt-4-turbo': 'Advanced reasoning',
        'o1-preview': 'Reasoning-focused model',
        'o1-mini': 'Fast reasoning model',
        'o3-mini': 'Compact reasoning model',
        'o4-mini': 'Fast multimodal reasoning',
        'kimi-k2': 'Advanced reasoning and coding',
        'kimi-k2-mini': 'Quick responses, everyday tasks',
        'claude-sonnet-4': 'Balanced intelligence and speed',
        'claude-haiku-4': 'Fast and lightweight',
        'claude-3-opus': 'Powerful reasoning',
        'claude-3-sonnet': 'Balanced performance',
        'claude-3-haiku': 'Fast and efficient',
        'claude-3-5-sonnet': 'Latest and most capable',
        'claude-3.5-sonnet-latest': 'Latest and most capable',
    };
    
    // ============================================
    // Model Definitions (Fallback when API unavailable)
    // ============================================
    const FALLBACK_MODELS = [
        { 
            id: 'gpt-4o', 
            name: 'GPT-4o', 
            provider: 'openai',
            description: 'Most capable multimodal model'
        },
        { 
            id: 'gpt-4o-mini', 
            name: 'GPT-4o Mini', 
            provider: 'openai',
            description: 'Fast and cost-effective'
        },
        { 
            id: 'kimi-k2', 
            name: 'Lilly K2', 
            provider: 'kimi',
            description: 'Advanced reasoning and coding'
        },
        { 
            id: 'kimi-k2-mini', 
            name: 'Lilly K2 Mini', 
            provider: 'kimi',
            description: 'Quick responses, everyday tasks'
        },
        { 
            id: 'claude-sonnet-4', 
            name: 'Claude Sonnet 4', 
            provider: 'anthropic',
            description: 'Balanced intelligence and speed'
        },
        { 
            id: 'claude-haiku-4', 
            name: 'Claude Haiku 4', 
            provider: 'anthropic',
            description: 'Fast and lightweight'
        }
    ];

    function inferProvider(modelOrId) {
        const provider = String(modelOrId?.provider || modelOrId?.owned_by || '').toLowerCase();
        if (provider === 'openai' || provider === 'anthropic' || provider === 'google' ||
            provider === 'meta' || provider === 'kimi' || provider === 'mistral') {
            return provider;
        }

        const id = String(modelOrId?.id || modelOrId || '').toLowerCase();
        if (id.includes('claude')) return 'anthropic';
        if (id.includes('gpt') || id.includes('o1') || id.includes('o3') || id.includes('o4')) return 'openai';
        if (id.includes('kimi')) return 'kimi';
        if (id.includes('gemini') || id.includes('palm')) return 'google';
        if (id.includes('llama') || id.includes('meta')) return 'meta';
        if (id.includes('mistral')) return 'mistral';
        return 'other';
    }

    function formatModelName(modelId) {
        if (MODEL_DISPLAY_NAMES[modelId]) {
            return MODEL_DISPLAY_NAMES[modelId];
        }

        return modelId
            .split('-')
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    }

    function normalizeModel(model) {
        const id = String(model?.id || '').trim();
        if (!id) return null;

        const provider = inferProvider(model);

        return {
            ...model,
            id,
            provider,
            name: model.name || formatModelName(id),
            description: model.description || MODEL_DESCRIPTIONS[id] || model.owned_by || 'AI model'
        };
    }

    function normalizeModelsResponse(response) {
        const apiClient = getAPIClient();
        const rawModels = Array.isArray(response)
            ? response
            : Array.isArray(response?.data)
                ? response.data
                : [];

        const filteredModels = apiClient?.filterChatModels
            ? apiClient.filterChatModels(rawModels)
            : rawModels;

        const modelsToUse = filteredModels.length > 0 ? filteredModels : rawModels;
        const uniqueModels = new Map();

        modelsToUse.forEach((model) => {
            const normalized = normalizeModel(model);
            if (normalized && !uniqueModels.has(normalized.id)) {
                uniqueModels.set(normalized.id, normalized);
            }
        });

        return Array.from(uniqueModels.values());
    }
    
    // ============================================
    // Response Templates for Stub Mode
    // ============================================
    const RESPONSE_TEMPLATES = {
        greeting: [
            "Hello! I'm ready to help you with your notes. What would you like to do?",
            "Hi there! I can help you write, edit, or analyze your page. What do you need?",
            "Hey! I'm your AI assistant. Ask me anything about your page or how I can help!"
        ],
        question: [
            "Based on your page about **{topic}**, I can see you have {blockCount} blocks of content. {observation}",
            "Looking at your notes on **{topic}**, here's what I found: {observation}",
            "From what I can see in your **{topic}** page: {observation}"
        ],
        edit: [
            "✅ I've updated that block for you. The content has been improved while keeping your original meaning.",
            "✅ Done! I've made the requested changes to your content.",
            "✅ Block updated successfully. Let me know if you'd like any other edits!"
        ],
        insert: [
            "✅ I've added a new **{type}** block after the specified block.",
            "✅ New content added! You can find it in your page.",
            "✅ Inserted successfully. The page has been updated."
        ],
        delete: [
            "✅ Block removed from your page.",
            "✅ I've deleted that block for you.",
            "✅ Done! The block has been removed."
        ],
        summarize: [
            "Here's a summary of your page **{title}**:\n\n{summary}",
            "Summary of **{title}**:\n\n{summary}\n\nKey points have been condensed while keeping the essential information.",
            "📋 Page Summary:\n\n{summary}"
        ],
        improve: [
            "✅ I've improved the writing in that block. The text is now more polished and professional.",
            "✅ Writing enhanced! I've clarified the language and improved the flow.",
            "✅ Improvements made: better grammar, clearer structure, and more engaging language."
        ],
        continue: [
            "I've continued writing based on your content. Here's what I added:\n\n{content}",
            "Building on your existing content, I've added:\n\n{content}",
            "Following your writing style, I continued with:\n\n{content}"
        ],
        outline: [
            "Here's an outline for **{topic}**:\n\n{outline}",
            "📋 Suggested structure for {topic}:\n\n{outline}\n\nWould you like me to expand on any of these sections?",
            "I've created an outline for you:\n\n{outline}"
        ],
        unknown: [
            "I'm not sure I understood that. Could you rephrase or ask something specific about your page?",
            "I can help with writing, editing, summarizing, and more. What would you like to do?",
            "Try asking me to summarize your page, improve a block, or generate an outline!"
        ]
    };
    
    // ============================================
    // Initialization
    // ============================================
    async function init() {
        if (initPromise) {
            return initPromise;
        }

        initPromise = (async () => {
            state.messages = readStoredMessages();
            const apiClient = getAPIClient();
            await hydrateSharedConversationSession(apiClient);
            syncConversationWithCurrentPage({ emitEvent: false });

            // Try to fetch models from API first
            try {
                await refreshModelsFromAPI();
            } catch (error) {
                console.log('Using fallback models');
            }

            // Validate selected model
            const availableModels = state.cachedModels || FALLBACK_MODELS;
            if (!isSupportedNotesModelId(state.selectedModel) || !availableModels.find(m => m.id === state.selectedModel)) {
                state.selectedModel = availableModels[0]?.id || 'gpt-4o';
                persistSelectedModel(state.selectedModel);
            }

            console.log('Agent module initialized with model:', state.selectedModel);
        })();

        return initPromise;
    }
    
    // Fetch models from API with caching
    async function refreshModelsFromAPI() {
        const apiClient = getAPIClient();
        if (!apiClient) return false;

        syncAPIClientSession(apiClient);
        
        // Check cache (cache for 5 minutes)
        const cacheExpiry = 5 * 60 * 1000;
        if (state.cachedModels && state.modelsCacheTime && 
            (Date.now() - state.modelsCacheTime < cacheExpiry)) {
            return true;
        }
        
        try {
            const modelsResponse = await apiClient.getModels();
            const models = normalizeModelsResponse(modelsResponse);
            if (models.length > 0) {
                state.cachedModels = models;
                state.modelsCacheTime = Date.now();
                return true;
            }
        } catch (error) {
            console.warn('Failed to fetch models from API:', error);
        }
        
        return false;
    }
    
    // ============================================
    // Model Management
    // ============================================
    function getModels() {
        // Return cached models from API if available, otherwise fallback
        return state.cachedModels || FALLBACK_MODELS;
    }
    
    async function getModelsAsync() {
        // Try to refresh from API
        await refreshModelsFromAPI();
        return getModels();
    }
    
    function getSelectedModel() {
        return state.selectedModel;
    }
    
    function setSelectedModel(modelId) {
        const availableModels = getModels();
        const model = availableModels.find(m => m.id === modelId);
        if (model && isSupportedNotesModelId(modelId)) {
            state.selectedModel = modelId;
            persistSelectedModel(modelId);
            return true;
        }
        return false;
    }
    
    function getModelInfo(modelId) {
        const availableModels = getModels();
        return availableModels.find(m => m.id === modelId) || availableModels[0];
    }

    function getModel(modelId) {
        const availableModels = getModels();
        return availableModels.find(m => m.id === modelId) || availableModels[0];
    }

    function getModelsByProvider() {
        const availableModels = getModels();
        const grouped = {};
        availableModels.forEach(model => {
            const provider = model.provider || 'Other';
            if (!grouped[provider]) {
                grouped[provider] = [];
            }
            grouped[provider].push(model);
        });
        return grouped;
    }
    
    // ============================================
    // Page Context Extraction
    // ============================================
    function getPageContext() {
        const page = window.Editor?.getCurrentPage?.();
        if (!page) {
            return null;
        }

        if (window.NotesQuery?.buildPageContext) {
            try {
                return window.NotesQuery.buildPageContext(page);
            } catch (error) {
                console.warn('[Notes Agent] Failed to build query-backed page context:', error);
            }
        }
        
        // Flatten all blocks recursively
        function flattenBlocks(blocks, depth = 0) {
            const result = [];
            blocks.forEach(block => {
                result.push({
                    id: block.id,
                    type: block.type,
                    content: extractBlockTextValue(block),
                    depth: depth,
                    hasChildren: block.children && block.children.length > 0,
                    color: block.color || null,
                    textColor: block.textColor || null
                });
                if (block.children && block.children.length > 0) {
                    result.push(...flattenBlocks(block.children, depth + 1));
                }
            });
            return result;
        }
        
        const allBlocks = flattenBlocks(page.blocks || []);
        const outline = allBlocks.filter(b => b.type.startsWith('heading_'));
        const textBlocks = allBlocks.filter(b => {
            const textTypes = ['text', 'heading_1', 'heading_2', 'heading_3', 'quote', 'callout'];
            return textTypes.includes(b.type) && b.content;
        });
        
        // Calculate word count
        const fullText = textBlocks.map(b => b.content).join(' ');
        const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length;
        
        // Estimate reading time (average 200 words per minute)
        const readingTime = Math.max(1, Math.ceil(wordCount / 200));
        
        return {
            title: page.title || 'Untitled',
            icon: page.icon || '',
            pageId: page.id,
            blocks: allBlocks,
            outline: outline,
            blockCount: allBlocks.length,
            wordCount: wordCount,
            readingTime: readingTime,
            lastUpdated: page.updatedAt,
            defaultModel: page.defaultModel,
            hasCover: !!page.cover,
            properties: page.properties || []
        };
    }
    
    function getFullPageContentLegacy() {
        const context = getPageContext();
        if (!context) return '';
        
        let content = '';
        if (context.icon) content += `${context.icon} `;
        content += `# ${context.title}\n\n`;
        
        context.blocks.forEach(block => {
            const indent = '  '.repeat(block.depth);
            switch (block.type) {
                case 'heading_1':
                    content += `${indent}# ${block.content}\n\n`;
                    break;
                case 'heading_2':
                    content += `${indent}## ${block.content}\n\n`;
                    break;
                case 'heading_3':
                    content += `${indent}### ${block.content}\n\n`;
                    break;
                case 'text':
                    content += `${indent}${block.content}\n\n`;
                    break;
                case 'bulleted_list':
                    content += `${indent}- ${block.content}\n`;
                    break;
                case 'numbered_list':
                    content += `${indent}1. ${block.content}\n`;
                    break;
                case 'todo':
                    content += `${indent}- [ ] ${block.content}\n`;
                    break;
                case 'quote':
                    content += `${indent}> ${block.content}\n\n`;
                    break;
                case 'code':
                    content += `${indent}\`\`\`${block.content?.language && block.content.language !== 'plain' ? block.content.language : ''}\n${block.content?.text || block.content || ''}\n\`\`\`\n\n`;
                    break;
                case 'divider':
                    content += `${indent}---\n\n`;
                    break;
                case 'callout':
                    content += `${indent}💡 ${block.content}\n\n`;
                    break;
                default:
                    content += `${indent}${block.content}\n\n`;
            }
        });
        
        return content;
    }
    
    function buildFullPageContentFromContext(context = null) {
        if (!context) return '';

        let content = '';
        if (context.icon) content += `${context.icon} `;
        content += `# ${context.title}\n\n`;

        context.blocks.forEach((block) => {
            const indent = '  '.repeat(block.depth);
            switch (block.type) {
                case 'heading_1':
                    content += `${indent}# ${block.content}\n\n`;
                    break;
                case 'heading_2':
                    content += `${indent}## ${block.content}\n\n`;
                    break;
                case 'heading_3':
                    content += `${indent}### ${block.content}\n\n`;
                    break;
                case 'text':
                    content += `${indent}${block.content}\n\n`;
                    break;
                case 'bulleted_list':
                    content += `${indent}- ${block.content}\n`;
                    break;
                case 'numbered_list':
                    content += `${indent}1. ${block.content}\n`;
                    break;
                case 'todo':
                    content += `${indent}- [ ] ${block.content}\n`;
                    break;
                case 'quote':
                    content += `${indent}> ${block.content}\n\n`;
                    break;
                case 'code':
                    content += `${indent}\`\`\`\n${block.content}\n\`\`\`\n\n`;
                    break;
                case 'divider':
                    content += `${indent}---\n\n`;
                    break;
                case 'callout':
                    content += `${indent}! ${block.content?.text || block.content}\n\n`;
                    break;
                case 'mermaid':
                    content += `${indent}\`\`\`mermaid\n${block.content?.text || block.content || ''}\n\`\`\`\n\n`;
                    break;
                case 'ai':
                    content += `${indent}> AI block: ${block.content?.prompt || block.content?.result || block.content || ''}\n\n`;
                    break;
                default:
                    content += `${indent}${block.content}\n\n`;
            }
        });

        return content;
    }

    function getFullPageContent() {
        const context = getPageContext();
        return buildFullPageContentFromContext(context);
    }

    function getOutline() {
        const context = getPageContext();
        if (!context) return [];
        return context.outline;
    }

    function getPageProjection(options = {}) {
        const page = window.Editor?.getCurrentPage?.();
        if (!page || !window.NotesQuery?.createProjection) {
            return null;
        }

        try {
            return window.NotesQuery.createProjection(page, options);
        } catch (error) {
            console.warn('[Notes Agent] Failed to build page projection:', error);
            return null;
        }
    }
    
    // ============================================
    // Page Context Helper
    // ============================================
    
    /**
     * Format page structure for AI context
     * Returns a structured summary of all blocks with IDs, types, and content previews
     * @param {Object} options - Formatting options
     * @param {number} options.maxContentLength - Max length for content preview (default: 100)
     * @param {boolean} options.includeStats - Include page statistics (default: true)
     * @returns {string} Formatted page structure
     */
    function formatPageContextForAI(options = {}) {
        const { maxContentLength = 100, includeStats = true, mode = null } = options;

        if (mode && window.NotesQuery?.createProjection) {
            const projection = getPageProjection(options);
            if (typeof projection === 'string') return projection;
            if (projection) return JSON.stringify(projection, null, 2);
        }

        const context = getPageContext();
        
        if (!context) {
            return 'No page is currently loaded.';
        }
        
        const lines = [];
        
        // Page header
        lines.push(`PAGE: "${context.title || 'Untitled'}"`);
        lines.push('');
        
        // Statistics
        if (includeStats) {
            lines.push('STATISTICS:');
            lines.push(`  - Total blocks: ${context.blockCount}`);
            lines.push(`  - Word count: ${context.wordCount}`);
            lines.push(`  - Reading time: ~${context.readingTime} min`);
            lines.push(`  - Headings: ${context.outline?.length || 0}`);
            lines.push('');
        }
        
        // Block structure
        lines.push('BLOCK STRUCTURE:');
        context.blocks?.forEach(block => {
            const indent = '  '.repeat(block.depth || 0);
            const contentPreview = block.content 
                ? truncateText(block.content, maxContentLength)
                : '(empty)';
            lines.push(`${indent}[${block.id}] ${block.type}: "${contentPreview}"`);
        });
        
        return lines.join('\n');
    }
    
    /**
     * Get detailed info about a specific block
     * @param {string} blockId - The block ID
     * @returns {Object|null} Block details or null if not found
     */
    function getBlockInfo(blockId) {
        const context = getPageContext();
        if (!context?.blocks) return null;
        
        const block = context.blocks.find(b => b.id === blockId);
        if (!block) return null;
        
        return {
            id: block.id,
            type: block.type,
            content: block.content,
            depth: block.depth,
            hasChildren: block.hasChildren,
            preview: truncateText(block.content, 200)
        };
    }
    
    function getPageMetadata() {
        const context = getPageContext();
        if (!context) return null;
        
        return {
            title: context.title,
            icon: context.icon,
            blockCount: context.blockCount,
            wordCount: context.wordCount,
            readingTime: context.readingTime,
            lastUpdated: context.lastUpdated
        };
    }
    
    // ============================================
    // Chat Interface
    // ============================================
    function addMessage(role, content, metadata = {}) {
        syncConversationWithCurrentPage({ emitEvent: false });

        const message = {
            id: 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            role: role, // 'user' or 'assistant'
            content: content,
            timestamp: Date.now(),
            model: role === 'assistant' ? state.selectedModel : null,
            ...metadata
        };
        
        state.messages.push(message);
        
        // Keep only last 100 messages
        if (state.messages.length > 100) {
            state.messages = state.messages.slice(-100);
        }
        
        // Save to localStorage
        saveMessages();
        
        return message;
    }
    
    function saveMessages() {
        saveMessagesForPage(state.activePageId, state.messages);
    }
    
    function getMessages() {
        syncConversationWithCurrentPage({ emitEvent: false });
        return [...state.messages];
    }
    
    function clearConversation() {
        syncConversationWithCurrentPage({ emitEvent: false });
        state.messages = [];
        try {
            localStorage.removeItem(getMessagesStorageKey(state.activePageId));
            if (!state.activePageId) {
                localStorage.removeItem(LEGACY_MESSAGES_STORAGE_KEY);
            }
        } catch (error) {
            console.warn('Failed to clear messages:', error);
        }
        emitConversationChange({ reason: 'clear' });
        showToast('Conversation cleared', 'info');
    }
    
    function formatMessageForDisplay(message) {
        // Convert markdown-like syntax to HTML
        let html = escapeHtml(message.content);
        
        // Bold: **text**
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        
        // Italic: *text* or _text_
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
        html = html.replace(/_(.*?)_/g, '<em>$1</em>');
        
        // Code: `text`
        html = html.replace(/`(.*?)`/g, '<code>$1</code>');
        
        // Line breaks
        html = html.replace(/\n/g, '<br>');
        
        return html;
    }
    
    // ============================================
    // AI Response Generation (Stub Mode)
    // ============================================
    function generateStubResponse(userMessage, context) {
        const messageLower = userMessage.toLowerCase();
        const topic = context?.title || 'your notes';
        
        // Detect intent
        if (messageLower.match(/^(hi|hello|hey|greetings)/)) {
            return pickRandom(RESPONSE_TEMPLATES.greeting);
        }
        
        if (messageLower.includes('summarize') || messageLower.includes('summary')) {
            const summary = buildSummaryText(context);
            return formatTemplate(pickRandom(RESPONSE_TEMPLATES.summarize), {
                title: topic,
                summary: summary
            });
        }
        
        if (messageLower.includes('outline') || messageLower.includes('structure')) {
            const match = userMessage.match(/(?:for|about|on)\s+(.+?)(?:\?|$)/i);
            const outlineTopic = match ? match[1] : topic;
            const outline = buildOutlineText(outlineTopic);
            return formatTemplate(pickRandom(RESPONSE_TEMPLATES.outline), {
                topic: outlineTopic,
                outline: outline
            });
        }
        
        if (messageLower.includes('improve') || messageLower.includes('rewrite') || messageLower.includes('enhance')) {
            return pickRandom(RESPONSE_TEMPLATES.improve);
        }
        
        if (messageLower.includes('continue') || messageLower.includes('expand') || messageLower.includes('more')) {
            const continued = buildContinuedText(context);
            return formatTemplate(pickRandom(RESPONSE_TEMPLATES.continue), {
                content: continued
            });
        }
        
        // Default question/observation response
        const observation = generateObservation(context);
        return formatTemplate(pickRandom(RESPONSE_TEMPLATES.question), {
            topic: topic,
            blockCount: context?.blockCount || 0,
            observation: observation
        });
    }
    
    function generateObservation(context) {
        if (!context || !context.blocks || context.blocks.length === 0) {
            return "Your page is currently empty. Would you like me to help you get started?";
        }
        
        const headings = context.blocks.filter(b => b.type.startsWith('heading_'));
        const lists = context.blocks.filter(b => b.type.includes('list') || b.type === 'todo');
        
        let obs = "";
        if (headings.length > 0) {
            obs += `I can see ${headings.length} section${headings.length > 1 ? 's' : ''}`;
            if (context.wordCount > 0) {
                obs += ` with approximately ${context.wordCount} words`;
            }
            obs += ". ";
        }
        
        if (lists.length > 0) {
            obs += `You have ${lists.length} list${lists.length > 1 ? 's' : ''} for organizing items. `;
        }
        
        obs += `This would take about ${context.readingTime} minute${context.readingTime > 1 ? 's' : ''} to read.`;
        
        return obs;
    }
    
    function buildSummaryText(context) {
        if (!context || !context.blocks || context.blocks.length === 0) {
            return "The page is currently empty.";
        }
        
        const headings = context.blocks.filter(b => b.type.startsWith('heading_'));
        const mainPoints = context.blocks
            .filter(b => ['text', 'callout', 'quote'].includes(b.type) && b.content)
            .slice(0, 3)
            .map(b => b.content.substring(0, 100) + (b.content.length > 100 ? '...' : ''));
        
        let summary = "";
        if (headings.length > 0) {
            summary += "**Key Sections:**\n";
            headings.slice(0, 5).forEach(h => {
                summary += `- ${h.content}\n`;
            });
            summary += "\n";
        }
        
        if (mainPoints.length > 0) {
            summary += "**Main Points:**\n";
            mainPoints.forEach((point, i) => {
                summary += `${i + 1}. ${point}\n`;
            });
        }
        
        return summary || "The page contains content ready for review.";
    }
    
    function buildOutlineText(topic) {
        return [
            "1. **Introduction**",
            "   - Overview of " + topic,
            "   - Purpose and goals",
            "",
            "2. **Main Concepts**",
            "   - Key principles",
            "   - Important definitions",
            "   - Core ideas",
            "",
            "3. **Implementation**",
            "   - Step-by-step guide",
            "   - Best practices",
            "   - Common pitfalls",
            "",
            "4. **Examples**",
            "   - Real-world applications",
            "   - Case studies",
            "   - Code samples (if applicable)",
            "",
            "5. **Conclusion**",
            "   - Summary of key points",
            "   - Next steps",
            "   - Additional resources"
        ].join('\n');
    }
    
    function buildContinuedText(context) {
        const lastTextBlock = context?.blocks?.slice().reverse().find(b => 
            b.type === 'text' && b.content
        );
        
        if (!lastTextBlock) {
            return "I can continue writing once you have some text content on the page. Start with a paragraph and I'll help expand on it!";
        }
        
        const topics = [
            "Building on this foundation, it's important to consider the broader implications and how they apply to real-world scenarios.",
            "This leads us to consider additional factors that may influence the outcome. By examining these elements more closely, we can gain deeper insights.",
            "Furthermore, exploring alternative approaches can provide valuable perspectives and enhance our understanding of the subject matter.",
            "The next step involves putting these concepts into practice and observing the results through careful experimentation and analysis."
        ];
        
        return pickRandom(topics) + "\n\nWould you like me to add this to your page?";
    }
    
    // ============================================
    // Core AI Actions
    // ============================================
    function isToolCommand(question) {
        const trimmed = String(question || '').trim();
        return trimmed === '/tools' || trimmed.startsWith('/tools ') || trimmed.startsWith('/tool ') || trimmed.startsWith('/tool-help ');
    }

    function inferRequestedArtifactFormat(question) {
        const normalized = String(question || '').toLowerCase();
        if (!normalized) return null;

        const explicitDeliveryIntent = hasExplicitArtifactDeliveryIntent(normalized);
        const explicitArtifactVerb = /\b(export|generate|create|make|save|download|convert|render|produce|link|share|attach)\b/.test(normalized);
        const explicitStandaloneHtmlIntent = /\b(standalone html|html file|downloadable html|shareable html|html artifact|html export)\b/.test(normalized);

        if (explicitStandaloneHtmlIntent || (/\bhtml\b/.test(normalized) && explicitDeliveryIntent)) return 'html';
        if (/\bpdf\b/.test(normalized) && explicitArtifactVerb) return 'pdf';
        if (/\bdocx\b|\bword document\b/.test(normalized) && explicitArtifactVerb) return 'docx';
        if (/\bxml\b/.test(normalized) && explicitArtifactVerb) return 'xml';
        if (/\bxlsx\b|\bexcel\b|\bspreadsheet\b/.test(normalized) && explicitArtifactVerb) return 'xlsx';
        if (/\b(mermaid|\.mmd\b)\b/.test(normalized)
            && /\b(export|download|save|artifact|file|mmd|link|share)\b/.test(normalized)) return 'mermaid';
        return null;
    }

    function hasExplicitArtifactDeliveryIntent(question = '') {
        const normalized = String(question || '').toLowerCase();
        if (!normalized) return false;

        return /\b(export|download|save|artifact|file|link|share|attachment)\b/.test(normalized);
    }

    function isArtifactGenerationIntent(question) {
        const normalized = String(question || '').toLowerCase();
        if (!normalized) return false;

        const format = inferRequestedArtifactFormat(normalized);
        if (!format) return false;

        return /\b(export|generate|create|make|save|download|convert|render|produce|link)\b/.test(normalized);
    }

    function shouldSuppressRequestedArtifactFormat(question = '', context = null, requestedArtifactFormat = null) {
        if (!requestedArtifactFormat) {
            return false;
        }

        if (isPlanningConversationIntent(question, context)) {
            return true;
        }

        if (shouldPreferInlineMermaidBlock(question, context, requestedArtifactFormat)) {
            return true;
        }

        if (hasExplicitArtifactDeliveryIntent(question)) {
            return false;
        }

        return shouldForcePageEditActions(question, context, {});
    }

    function isExplicitMermaidDownloadIntent(question = '') {
        const normalized = String(question || '').toLowerCase();
        if (!normalized) return false;

        return /\b(download|export|save|share|link|artifact|mmd)\b/.test(normalized);
    }

    function pageHasMermaidBlocks(context = null) {
        return Array.isArray(context?.blocks) && context.blocks.some((block) => block?.type === 'mermaid');
    }

    function shouldPreferInlineMermaidBlock(question = '', context = null, requestedArtifactFormat = null) {
        if (requestedArtifactFormat !== 'mermaid') {
            return false;
        }

        const normalized = String(question || '').trim().toLowerCase();
        if (!normalized) {
            return false;
        }

        const diagramEditIntent = [
            /\b(fill out|complete|finish|update|edit|fix|improve|expand|revise|polish|populate)\b[\s\S]{0,40}\b(mermaid|diagram)\b/,
            /\b(mermaid|diagram)\b[\s\S]{0,40}\b(fill out|complete|finish|update|edit|fix|improve|expand|revise|polish|populate)\b/,
        ].some((pattern) => pattern.test(normalized));

        return !isExplicitMermaidDownloadIntent(question)
            && (
                pageHasMermaidBlocks(context)
                || isExplicitPageEditIntent(question)
                || diagramEditIntent
            );
    }

    function flattenPageBlocks(blocks = [], result = []) {
        (Array.isArray(blocks) ? blocks : []).forEach((block) => {
            if (!block || typeof block !== 'object') {
                return;
            }

            result.push(block);
            if (Array.isArray(block.children) && block.children.length > 0) {
                flattenPageBlocks(block.children, result);
            }
        });

        return result;
    }

    function findPreferredMermaidTargetBlock(page = null) {
        const allBlocks = flattenPageBlocks(page?.blocks || []);
        const mermaidBlocks = allBlocks.filter((block) => block?.type === 'mermaid');
        if (mermaidBlocks.length === 0) {
            return null;
        }

        const emptyMermaidBlock = mermaidBlocks.find((block) => {
            const source = typeof block?.content === 'object'
                ? block.content.text
                : block?.content;
            return !normalizeMermaidSourceText(source).trim();
        });
        if (emptyMermaidBlock) {
            return emptyMermaidBlock;
        }

        return mermaidBlocks.length === 1 ? mermaidBlocks[0] : null;
    }

    async function loadMermaidSourceFromArtifact(artifact = {}) {
        const previewSource = normalizeMermaidSourceText(artifact?.preview?.content || '');
        if (looksLikeMermaidSource(previewSource)) {
            return previewSource;
        }

        const rawDownloadUrl = artifact?.downloadUrl
            ? new URL(artifact.downloadUrl, window.location.origin)
            : null;
        if (!rawDownloadUrl) {
            return '';
        }

        rawDownloadUrl.searchParams.set('inline', '1');

        try {
            const response = await fetch(rawDownloadUrl.toString(), {
                headers: {
                    Accept: 'text/plain, text/vnd.mermaid, */*'
                },
                credentials: 'same-origin'
            });

            if (!response.ok) {
                return '';
            }

            const source = normalizeMermaidSourceText(await response.text());
            return looksLikeMermaidSource(source) ? source : '';
        } catch (error) {
            console.warn('Failed to load Mermaid artifact source:', error);
            return '';
        }
    }

    async function applyGeneratedMermaidArtifactToPage(artifacts = [], options = {}) {
        const {
            question = '',
            explicitPageEditIntent = false
        } = options;

        if (!window.Blocks?.createBlock || !window.Editor?.getCurrentPage) {
            return { appliedCount: 0, blockCount: 0, reusedExisting: false };
        }

        const page = window.Editor.getCurrentPage();
        if (!page) {
            return { appliedCount: 0, blockCount: 0, reusedExisting: false };
        }

        const existingTopLevelBlocks = Array.isArray(page.blocks) ? page.blocks : [];
        const shouldApplyToPage = explicitPageEditIntent
            || pageHasMermaidBlocks({ blocks: flattenPageBlocks(existingTopLevelBlocks, []) })
            || (existingTopLevelBlocks.length === 1 && isEmptyStarterBlock(existingTopLevelBlocks[0]));

        if (!shouldApplyToPage) {
            return { appliedCount: 0, blockCount: 0, reusedExisting: false };
        }

        const mermaidSources = [];
        for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
            const format = String(artifact?.format || '').trim().toLowerCase();
            if (format && !['mermaid', 'mmd'].includes(format)) {
                continue;
            }

            const source = await loadMermaidSourceFromArtifact(artifact);
            if (source) {
                mermaidSources.push(source);
            }
        }

        if (mermaidSources.length === 0) {
            return { appliedCount: 0, blockCount: 0, reusedExisting: false };
        }

        const mermaidBlocks = mermaidSources.map((source) => window.Blocks.createBlock('mermaid', {
            text: source,
            diagramType: detectMermaidDiagramType(source),
            _showEditor: false
        }));

        const preferredTarget = mermaidBlocks.length === 1
            ? findPreferredMermaidTargetBlock(page)
            : null;

        let inserted = [];
        if (preferredTarget) {
            inserted = window.Editor.replaceBlockWithBlocks?.(preferredTarget.id, mermaidBlocks) || [];
        } else if (existingTopLevelBlocks.length === 1 && isEmptyStarterBlock(existingTopLevelBlocks[0])) {
            inserted = window.Editor.replaceBlockWithBlocks?.(existingTopLevelBlocks[0].id, mermaidBlocks) || [];
        } else {
            const lastBlockId = flattenPageBlocks(existingTopLevelBlocks, []).slice(-1)[0]?.id || null;
            inserted = window.Editor.insertBlocksAfter?.(lastBlockId, mermaidBlocks) || [];
        }

        if (inserted.length > 0) {
            window.Editor.savePage?.();
        }

        return {
            appliedCount: inserted.length,
            blockCount: inserted.length,
            reusedExisting: Boolean(preferredTarget && inserted.length > 0)
        };
    }

    function appendArtifactBookmark(artifact, format) {
        const downloadUrl = artifact?.downloadUrl
            ? new URL(artifact.downloadUrl, window.location.origin).toString()
            : null;
        if (!downloadUrl || !window.Blocks?.createBlock) {
            return false;
        }

        const page = window.Editor?.getCurrentPage?.();
        if (!page) {
            return false;
        }

        const exportMarker = `notes-agent-artifact-${format || artifact.format || 'file'}`;
        const existingBlock = (page.blocks || []).find((block) => block?.exportMarker === exportMarker);
        const title = artifact.filename
            ? `Download ${artifact.filename}`
            : `Download ${String(format || artifact.format || 'file').toUpperCase()} export`;
        const description = `Generated ${new Date().toLocaleString()}`;

        const bookmarkBlock = window.Blocks.createBlock('bookmark', {
            url: downloadUrl,
            title,
            description,
            favicon: '',
            image: ''
        }, {
            exportMarker
        });

        if (existingBlock) {
            bookmarkBlock.id = existingBlock.id;
            window.Editor.replaceBlockWithBlocks?.(existingBlock.id, [bookmarkBlock]);
            return true;
        }

        const blocks = page.blocks || [];
        const lastBlockId = blocks.length ? blocks[blocks.length - 1].id : null;
        window.Editor.insertBlocksAfter?.(lastBlockId, [bookmarkBlock]);
        return true;
    }

    function formatAvailableToolsResponse(toolResponse, category = null) {
        const tools = Array.isArray(toolResponse) ? toolResponse : (toolResponse?.tools || []);
        const runtime = toolResponse?.meta?.runtime || null;

        if (!Array.isArray(tools) || tools.length === 0) {
            return category
                ? `No frontend tools are available in category \`${category}\`.`
                : 'No frontend tools are currently available.';
        }

        const lines = ['## Available Tools', ''];
        if (runtime) {
            const gatewayScope = runtime.modelGateway?.internalCluster ? 'internal cluster' : 'external endpoint';
            lines.push(`Runtime source: \`${runtime.source || 'backend'}\``);
            lines.push(`Model gateway: \`${runtime.modelGateway?.baseURL || 'unknown'}\` (${gatewayScope})`);
            if (runtime.sshDefaults?.enabled) {
                const target = runtime.sshDefaults.host
                    ? `${runtime.sshDefaults.username || 'unknown'}@${runtime.sshDefaults.host}:${runtime.sshDefaults.port || 22}`
                    : 'not set';
                lines.push(`SSH defaults: source=${runtime.sshDefaults.source || 'unknown'}, target=${target}, configured=${runtime.sshDefaults.configured ? 'yes' : 'no'}`);
            } else {
                lines.push('SSH defaults: disabled');
            }
            lines.push('');
        }

        tools.forEach((tool) => {
            const params = Array.isArray(tool.parameters)
                ? tool.parameters.map((param) => typeof param === 'string' ? param : param.name).filter(Boolean)
                : Object.keys(tool.inputSchema?.properties || {});
            lines.push(`- \`${tool.id}\` (${tool.category})`);
            lines.push(`  ${tool.description || 'No description provided.'}`);
            if (tool.support?.status) {
                lines.push(`  Support: ${tool.support.status}`);
            }
            if (tool.runtime?.defaultTarget) {
                lines.push(`  Runtime: ${tool.runtime.defaultTarget} via ${tool.runtime.source || 'unknown'}`);
            } else if (tool.runtime && Object.prototype.hasOwnProperty.call(tool.runtime, 'configured')) {
                lines.push(`  Runtime: configured=${tool.runtime.configured ? 'yes' : 'no'}`);
            }
            if (params.length) {
                lines.push(`  Params: ${params.join(', ')}`);
            }
        });
        lines.push('');
        lines.push('Usage: `/tool <id> {"key":"value"}`');
        lines.push('Help: `/tool-help <id>`');
        return lines.join('\n');
    }

    async function handleToolCommand(question, options = {}) {
        const {
            onComplete,
            hiddenAssistantMessage = false
        } = options;
        const apiClient = getAPIClient();

        if (!apiClient) {
            throw new Error('Tool commands require the backend API client.');
        }

        const trimmed = String(question || '').trim();
        let responseText = '';

        if (trimmed === '/tools' || trimmed.startsWith('/tools ')) {
            const category = trimmed.startsWith('/tools ') ? trimmed.slice('/tools '.length).trim() : null;
            const toolResponse = await apiClient.getAvailableTools(category || null);
            responseText = formatAvailableToolsResponse(toolResponse, category);
        } else if (trimmed.startsWith('/tool-help ')) {
            const toolId = trimmed.slice('/tool-help '.length).trim();
            if (!toolId) {
                throw new Error('Usage: /tool-help <id>');
            }

            const doc = await apiClient.getToolDoc(toolId);
            responseText = `## Tool Help: \`${toolId}\`\n\nSupport: \`${doc?.support?.status || 'unknown'}\`\n\n${doc?.content || 'No documentation found.'}`;
        } else {
            const match = trimmed.match(/^\/tool\s+([^\s]+)(?:\s+([\s\S]+))?$/i);
            if (!match) {
                throw new Error('Usage: /tool <id> {"key":"value"}');
            }

            const toolId = match[1];
            const rawParams = (match[2] || '').trim();
            let params = {};

            if (rawParams) {
                params = JSON.parse(rawParams);
            }

            const invocation = await apiClient.invokeTool(toolId, params);
            responseText = `## Tool Result: \`${toolId}\`\n\n\`\`\`json\n${JSON.stringify(invocation?.result, null, 2)}\n\`\`\``;
        }

        const assistantMessage = hiddenAssistantMessage
            ? null
            : addMessage('assistant', responseText, {
                model: state.selectedModel,
                source: 'tool-command'
            });

        setProcessingState(false);

        if (onComplete) {
            onComplete(responseText, assistantMessage);
        }

        return responseText;
    }

    async function ask(question, options = {}) {
        const {
            onChunk,
            onReasoning,
            onStreamComplete,
            onComplete,
            onError,
            hiddenUserMessage = false,
            hiddenAssistantMessage = false,
            pageReferences = [],
            referenceSearch = null
        } = options;
        
        // Validate
        if (!question || typeof question !== 'string') {
            const error = new Error('Question must be a non-empty string');
            if (onError) onError(error);
            throw error;
        }

        syncConversationWithCurrentPage({ emitEvent: false });
        const normalizedPageReferences = normalizePageReferences(pageReferences);
        const normalizedReferenceSearch = normalizeReferenceSearchPayload(referenceSearch);
        
        if (!hiddenUserMessage) {
            addMessage('user', question, {
                ...(normalizedPageReferences.length ? { pageReferences: normalizedPageReferences } : {}),
            });
        }

        // Set processing state
        setProcessingState(true, {
            requestType: hiddenUserMessage || hiddenAssistantMessage ? 'internal' : 'chat'
        });

        try {
            if (isToolCommand(question)) {
                return await handleToolCommand(question, {
                    onComplete,
                    hiddenAssistantMessage
                });
            }

            const context = getPageContext();
            const apiClient = getAPIClient();
            const toolSensitiveRequest = isToolRuntimeSensitiveIntent(question);
            
            // Check if we can use the real API
            if (apiClient) {
                try {
                    const responseText = await askWithAPI(question, context, {
                        onChunk,
                        onReasoning,
                        onStreamComplete,
                        onComplete,
                        onError,
                        hiddenAssistantMessage,
                        pageReferences: normalizedPageReferences,
                        referenceSearch: normalizedReferenceSearch
                    });
                    return responseText;
                } catch (apiError) {
                    const backendAvailable = await isBackendAvailable();
                    const shouldUseStubFallback = !toolSensitiveRequest && !backendAvailable;

                    if (!shouldUseStubFallback) {
                        throw apiError;
                    }

                    console.warn('API call failed, backend is unavailable, falling back to stub mode:', apiError.message);
                }
            }

            // Fallback to stub mode (offline/no API client)
            return await askWithStub(question, context, {
                onChunk,
                onStreamComplete,
                onComplete,
                onError,
                hiddenAssistantMessage,
                pageReferences: normalizedPageReferences,
                referenceSearch: normalizedReferenceSearch
            });

        } catch (error) {
            setProcessingState(false, { error: error.message });
            console.error('Agent ask error:', error);
            
            if (onError) {
                onError(error);
            } else {
                showToast('Error: ' + error.message, 'error');
            }
            
            throw error;
        }
    }
    
    // Call the real API with streaming support
    async function askWithAPI(question, context, options) {
        const {
            onChunk,
            onReasoning,
            onStreamComplete,
            onComplete,
            onError,
            hiddenAssistantMessage = false,
            pageReferences = [],
            referenceSearch = null
        } = options;
        const apiClient = getAPIClient();
        syncAPIClientSession(apiClient, context);
        const explicitPageEditIntent = isExplicitPageEditIntent(question);
        let requestedArtifactFormat = inferRequestedArtifactFormat(question);
        if (shouldSuppressRequestedArtifactFormat(question, context, requestedArtifactFormat)) {
            requestedArtifactFormat = null;
        }
        const agentProfile = getSelectedAgentProfile();
        const normalizedPageReferences = normalizePageReferences(pageReferences);
        const normalizedReferenceSearch = normalizeReferenceSearchPayload(referenceSearch);
        const requestOptions = {
            ...(requestedArtifactFormat ? { outputFormat: requestedArtifactFormat } : {}),
            reasoningEffort: 'medium',
            metadata: {
                notesAgentProfile: buildAgentProfileMetadata(agentProfile),
                notesAgentProfileId: agentProfile.id,
                ...(normalizedPageReferences.length ? { notesPageReferences: normalizedPageReferences } : {}),
                ...(normalizedReferenceSearch.hits.length ? { notesReferenceSearch: normalizedReferenceSearch } : {}),
            },
        };
        const requestUnderstanding = buildRequestUnderstanding(question, context, requestOptions);
        
        // Build messages array with enhanced system prompt
        const systemPrompt = buildSystemPrompt(context || {
            title: 'Untitled',
            blockCount: 0,
            wordCount: 0,
            outline: []
        }, {
            question,
            agentProfile,
            pageReferences: normalizedPageReferences,
            referenceSearch: normalizedReferenceSearch
        });

        const attemptedModels = [];
        const candidateModels = buildCandidateModelsForRequest(question, state.selectedModel, requestOptions);
        const toolSensitiveRequest = isToolRuntimeSensitiveIntent(question, requestOptions);

        try {
            for (let modelIndex = 0; modelIndex < candidateModels.length; modelIndex += 1) {
                const model = candidateModels[modelIndex];
                if (!isSupportedNotesModelId(model) || attemptedModels.includes(model)) {
                    continue;
                }

                attemptedModels.push(model);
                const useMultiPassDraft = supportsStructuredNotesDrafting(model)
                    && shouldUseMultiPassNotesDraft(question, context, requestOptions);
                const forcePageEditActions = shouldForcePageEditActions(question, context, requestOptions);
                const effectiveQuestion = forcePageEditActions
                    ? `${question}\n\nInterpret "page" as the current notes page shown in this editor. This is a direct page edit request, so return notes-actions that apply the content to the current notes page unless the user explicitly says web page, site page, repo file, or server component. Put the result into page blocks. Do not reply with chat prose alone. Do not create standalone HTML, file, export, artifact, or download-link output unless the user explicitly asked for that.`
                    : question;
                let messages = [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: effectiveQuestion }
                ];
                let responseText = '';
                let lastVisibleText = '';
                let jsonBuffer = '';
                let inJsonBlock = false;
                let generatedArtifacts = [];
                let generatedToolEvents = [];
                let assistantMetadata = null;
                let processingReleased = false;

                const releaseProcessing = async (detail = {}) => {
                    if (processingReleased) {
                        return;
                    }

                    processingReleased = true;
                    setProcessingState(false, {
                        phase: 'response-received',
                        ...detail
                    });

                    if (onStreamComplete) {
                        try {
                            onStreamComplete({
                                model,
                                ...detail
                            });
                        } catch (callbackError) {
                            console.warn('notes onStreamComplete callback failed:', callbackError);
                        }
                    }

                    await yieldToBrowser();
                };

                try {
                    if (useMultiPassDraft) {
                        const multiPassMessages = await buildMultiPassNotesMessages({
                            apiClient,
                            model,
                            systemPrompt,
                            question: effectiveQuestion,
                            requestOptions,
                        });
                        if (Array.isArray(multiPassMessages) && multiPassMessages.length > 0) {
                            messages = multiPassMessages;
                        }
                    }

                    if (state.streamingEnabled && apiClient.streamChat) {
                        for await (const chunk of apiClient.streamChat(messages, model, null, requestOptions)) {
                            if (chunk.type === 'delta' && chunk.content) {
                                const chunkText = chunk.content;
                                responseText += chunkText;

                                if (isInvalidGatewayResponseText(responseText)) {
                                    const invalidGatewayError = new Error('Invalid response returned by the AI gateway.');
                                    invalidGatewayError.status = 502;
                                    throw invalidGatewayError;
                                }

                                if (hasLooseNotesActionFence(chunkText)) {
                                    inJsonBlock = true;
                                    jsonBuffer = chunkText;
                                } else if (inJsonBlock) {
                                    jsonBuffer += chunkText;
                                    if (chunkText.includes('```')) {
                                        inJsonBlock = false;
                                    }
                                    continue;
                                }

                                if (onChunk && !inJsonBlock) {
                                    const visibleText = getStreamingVisibleText(responseText);
                                    const visibleDelta = visibleText.slice(lastVisibleText.length);
                                    lastVisibleText = visibleText;
                                    if (visibleDelta) {
                                        onChunk(visibleDelta, visibleText);
                                    }
                                }
                                continue;
                            }

                            if (chunk.type === 'done') {
                                generatedArtifacts = Array.isArray(chunk.artifacts) ? chunk.artifacts : [];
                                generatedToolEvents = Array.isArray(chunk.toolEvents) ? chunk.toolEvents : [];
                                if (chunk.assistantMetadata && typeof chunk.assistantMetadata === 'object') {
                                    assistantMetadata = {
                                        ...(assistantMetadata || {}),
                                        ...chunk.assistantMetadata,
                                    };
                                }
                                continue;
                            }

                            if (chunk.type === 'reasoning') {
                                const summary = String(chunk.summary || chunk.content || '').trim();
                                if (summary) {
                                    assistantMetadata = {
                                        ...(assistantMetadata || {}),
                                        reasoningSummary: summary,
                                        reasoningAvailable: true,
                                    };
                                    if (onReasoning) {
                                        onReasoning(chunk.content || summary, summary);
                                    }
                                }
                                continue;
                            }

                            if (chunk.type === 'error') {
                                const streamError = new Error(chunk.error || 'Streaming error');
                                streamError.status = chunk.status;
                                throw streamError;
                            }
                        }
                    } else {
                        const response = await apiClient.chat(messages, model, requestOptions);
                        if (response?.error) {
                            const apiError = new Error(response.content || 'API request failed');
                            apiError.status = response.status;
                            throw apiError;
                        }

                        responseText = response.content || response.message || String(response);
                        generatedArtifacts = Array.isArray(response.artifacts) ? response.artifacts : [];
                        generatedToolEvents = Array.isArray(response.toolEvents) ? response.toolEvents : [];
                        assistantMetadata = response.assistantMetadata || null;
                    }

                    await releaseProcessing({
                        requestType: hiddenAssistantMessage ? 'internal' : 'chat'
                    });

                    if (isInvalidGatewayResponseText(responseText)) {
                        const invalidGatewayError = new Error('Invalid response returned by the AI gateway.');
                        invalidGatewayError.status = 502;
                        throw invalidGatewayError;
                    }

                    let preparedResponse;
                    try {
                        preparedResponse = prepareAssistantResponse(responseText, {
                            question,
                            context,
                            toolEvents: generatedToolEvents,
                        });
                    } catch (parseError) {
                        console.warn('Failed to parse structured response, using raw text:', parseError);
                        const cleanedText = stripStructuredResponseText(responseText);
                        preparedResponse = {
                            displayText: cleanedText || (looksLikeNotesActionResponse(responseText)
                                ? 'I prepared page updates, but the response could not be applied automatically. Please try again.'
                                : ''),
                            appliedCount: 0
                        };
                    }

                    if (forcePageEditActions && preparedResponse.appliedCount === 0) {
                        const fallbackPageEdit = buildFallbackPageEditResponse(question, responseText, context);
                        if (fallbackPageEdit?.appliedCount > 0) {
                            preparedResponse = fallbackPageEdit;
                        } else {
                            try {
                                const repairedResponseText = await repairNotesPageEditResponse({
                                    apiClient,
                                    model,
                                    systemPrompt,
                                    question: effectiveQuestion,
                                    previousResponse: responseText,
                                    requestOptions,
                                });

                                if (repairedResponseText && repairedResponseText !== responseText) {
                                    responseText = repairedResponseText;
                                    preparedResponse = prepareAssistantResponse(repairedResponseText, {
                                        question,
                                        context,
                                        toolEvents: generatedToolEvents,
                                    });
                                }

                                if (preparedResponse.appliedCount === 0) {
                                    const repairedFallbackPageEdit = buildFallbackPageEditResponse(question, responseText, context);
                                    if (repairedFallbackPageEdit?.appliedCount > 0) {
                                        preparedResponse = repairedFallbackPageEdit;
                                    }
                                }
                            } catch (repairError) {
                                console.warn('Notes page-edit repair pass failed:', repairError);
                            }
                        }
                    }

                    const blindArtifactSelectionResult = appendBlindArtifactSelectionBlocks(generatedToolEvents);
                    const mermaidArtifactApplyResult = requestedArtifactFormat === 'mermaid'
                        ? await applyGeneratedMermaidArtifactToPage(generatedArtifacts, {
                            question,
                            explicitPageEditIntent
                        })
                        : { appliedCount: 0, blockCount: 0, reusedExisting: false };

                    const shouldAppendArtifactLinks = generatedArtifacts.length > 0
                        && requestedArtifactFormat
                        && !(
                            requestedArtifactFormat === 'mermaid'
                            && mermaidArtifactApplyResult.appliedCount > 0
                            && !isExplicitMermaidDownloadIntent(question)
                        );

                    if (shouldAppendArtifactLinks) {
                        generatedArtifacts.forEach((artifact) => appendArtifactBookmark(artifact, requestedArtifactFormat));
                    }

                    const artifactLinkNotice = shouldAppendArtifactLinks
                        ? `\n\nDownload link added at the bottom of the page for the generated ${requestedArtifactFormat.toUpperCase()} export.`
                        : '';
                    const mermaidArtifactNotice = mermaidArtifactApplyResult.appliedCount > 0
                        ? `\n\nUpdated ${mermaidArtifactApplyResult.blockCount} Mermaid block${mermaidArtifactApplyResult.blockCount === 1 ? '' : 's'} on the page from the generated diagram.`
                        : '';
                    const blindArtifactNotice = blindArtifactSelectionResult.selectionCount > 0
                        ? `\n\nAdded ${blindArtifactSelectionResult.imageCount} captured image option${blindArtifactSelectionResult.imageCount === 1 ? '' : 's'} to the page as selectable image blocks.`
                        : '';
                    const baseVisibleResponse = resolveVisibleAssistantText(preparedResponse.displayText, responseText);
                    const fallbackVisibleResponse = blindArtifactSelectionResult.selectionCount > 0
                        ? `Added ${blindArtifactSelectionResult.imageCount} captured image option${blindArtifactSelectionResult.imageCount === 1 ? '' : 's'} to the page as selectable image blocks.`
                        : (mermaidArtifactApplyResult.appliedCount > 0
                            ? `Updated ${mermaidArtifactApplyResult.blockCount} Mermaid block${mermaidArtifactApplyResult.blockCount === 1 ? '' : 's'} on the page.`
                            : '');
                    const visibleResponse = `${baseVisibleResponse}${artifactLinkNotice}${mermaidArtifactNotice}${blindArtifactNotice}`.trim()
                        || fallbackVisibleResponse;
                    const assistantMessage = hiddenAssistantMessage
                        ? null
                        : addMessage('assistant', visibleResponse, {
                            model,
                            tokensUsed: estimateTokens(question + visibleResponse),
                            source: 'api',
                            ...(normalizedPageReferences.length ? { pageReferences: normalizedPageReferences } : {}),
                            requestUnderstanding,
                            appliedCount: (preparedResponse.appliedCount || 0)
                                + (mermaidArtifactApplyResult.appliedCount || 0)
                                + (blindArtifactSelectionResult.appliedCount || 0),
                            ...(assistantMetadata || {})
                        });

                    if (model !== state.selectedModel && !toolSensitiveRequest) {
                        state.selectedModel = model;
                        persistSelectedModel(model);
                        window.dispatchEvent(new CustomEvent('modelChanged', { detail: { modelId: model } }));
                        showToast(`Switched AI model to ${model} after the previous model failed.`, 'info');
                    }

                    if (onComplete) {
                        onComplete(visibleResponse, assistantMessage);
                    }

                    return visibleResponse;
                } catch (error) {
                    const hasMoreCandidates = candidateModels
                        .slice(modelIndex + 1)
                        .some((candidate) => isSupportedNotesModelId(candidate) && !attemptedModels.includes(candidate));
                    const shouldRetryWithFallback = hasMoreCandidates && shouldRetryWithAlternateModel(error);

                    if (!shouldRetryWithFallback) {
                        throw error;
                    }

                    console.warn(`Model ${model} failed for Notes agent, retrying with the next candidate:`, error.message);
                }
            }

            throw new Error('AI request failed for all available fallback models');
        } catch (error) {
            setProcessingState(false, { error: error.message });
            unhighlightAllBlocks();

            if (onError) {
                onError(error);
            } else {
                showToast('AI request failed: ' + error.message, 'error');
            }
            throw error;
        }
    }
    
    // Stub mode for offline/no API
    async function askWithStub(question, context, options) {
        const {
            onChunk,
            onStreamComplete,
            onComplete,
            onError,
            hiddenAssistantMessage = false,
            pageReferences = []
        } = options;
        const normalizedPageReferences = normalizePageReferences(pageReferences);
        const requestUnderstanding = buildRequestUnderstanding(question, context, {});
        const generatedToolEvents = [];
        
        try {
            // Simulate processing delay
            await delay(500 + Math.random() * 1000);
            
            // Generate response (stub mode)
            const responseText = generateStubResponse(question, context);
            
            // Simulate streaming if enabled
            if (state.streamingEnabled && onChunk) {
                const chunks = simulateStreaming(responseText);
                let fullResponse = '';
                let visibleResponse = '';
                
                for (const chunk of chunks) {
                    await delay(30 + Math.random() * 50);
                    fullResponse += chunk;
                    const nextVisible = getStreamingVisibleText(fullResponse);
                    const visibleDelta = nextVisible.slice(visibleResponse.length);
                    visibleResponse = nextVisible;
                    if (visibleDelta) {
                        onChunk(visibleDelta, nextVisible);
                    }
                }
            }

            setProcessingState(false, {
                phase: 'response-received',
                requestType: hiddenAssistantMessage ? 'internal' : 'chat'
            });
            if (onStreamComplete) {
                try {
                    onStreamComplete({
                        requestType: hiddenAssistantMessage ? 'internal' : 'chat'
                    });
                } catch (callbackError) {
                    console.warn('notes onStreamComplete callback failed:', callbackError);
                }
            }
            await yieldToBrowser();
            
            // Add assistant message
            const preparedResponse = prepareAssistantResponse(responseText, {
                question,
                context,
                toolEvents: generatedToolEvents,
            });
            const visibleResponse = resolveVisibleAssistantText(preparedResponse.displayText, responseText);

            const assistantMessage = hiddenAssistantMessage
                ? null
                : addMessage('assistant', visibleResponse, {
                    model: state.selectedModel,
                    tokensUsed: estimateTokens(question + visibleResponse),
                    source: 'stub',
                    ...(normalizedPageReferences.length ? { pageReferences: normalizedPageReferences } : {}),
                    requestUnderstanding,
                    appliedCount: preparedResponse.appliedCount || 0
                });

            if (onComplete) {
                onComplete(visibleResponse, assistantMessage);
            }
            
            return visibleResponse;
            
        } catch (error) {
            setProcessingState(false, { error: error.message });
            unhighlightAllBlocks();
            
            if (onError) {
                onError(error);
            } else {
                showToast('Request failed: ' + error.message, 'error');
            }
            throw error;
        }
    }
    
    function simulateStreaming(text) {
        // Split text into chunks (words or small phrases)
        const chunks = [];
        const words = text.split(/(\s+)/);
        
        for (let i = 0; i < words.length; i++) {
            // Group 1-3 words per chunk for natural feeling
            const chunkSize = Math.floor(Math.random() * 3) + 1;
            const chunk = words.slice(i, i + chunkSize).join('');
            if (chunk) chunks.push(chunk);
            i += chunkSize - 1;
        }
        
        return chunks;
    }
    
    // ============================================
    // Block Editing Actions
    // ============================================
    function editBlock(blockId, newContent, options = {}) {
        try {
            const page = window.Editor?.getCurrentPage?.();
            if (!page) {
                throw new Error('No page is currently loaded');
            }
            
            const block = window.Editor?.getBlock?.(blockId);
            if (!block) {
                throw new Error('Block not found: ' + blockId);
            }
            
            // Update the block content
            window.Editor?.updateBlockContent?.(blockId, newContent);
            
            // Save the page
            window.Editor?.savePage?.();
            
            // Refresh the editor UI
            window.Editor?.refreshEditor?.();
            
            showToast('Block updated', 'success');
            
            // Add system message about the edit
            addMessage('assistant', pickRandom(RESPONSE_TEMPLATES.edit), {
                action: 'edit',
                blockId: blockId
            });
            
            return true;
            
        } catch (error) {
            console.error('Edit block error:', error);
            showToast('Failed to edit block: ' + error.message, 'error');
            throw error;
        }
    }
    
    function insertBlockAfter(blockId, type, content, options = {}) {
        try {
            const newBlock = window.Editor?.insertBlockAfter?.(blockId, type, content);
            
            if (!newBlock) {
                throw new Error('Failed to insert block');
            }
            
            window.Editor?.savePage?.();
            
            // Refresh the editor UI
            window.Editor?.refreshEditor?.();
            
            const typeName = type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            showToast(`${typeName} block added`, 'success');
            
            // Add system message
            addMessage('assistant', formatTemplate(pickRandom(RESPONSE_TEMPLATES.insert), {
                type: typeName
            }), {
                action: 'insert',
                blockId: newBlock.id,
                blockType: type
            });
            
            return newBlock;
            
        } catch (error) {
            console.error('Insert block error:', error);
            showToast('Failed to insert block: ' + error.message, 'error');
            throw error;
        }
    }
    
    function insertBlockBefore(blockId, type, content, options = {}) {
        try {
            const newBlock = window.Editor?.insertBlockBefore?.(blockId, type, content);
            
            if (!newBlock) {
                throw new Error('Failed to insert block');
            }
            
            window.Editor?.savePage?.();
            
            // Refresh the editor UI
            window.Editor?.refreshEditor?.();
            
            const typeName = type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            showToast(`${typeName} block added`, 'success');
            
            return newBlock;
            
        } catch (error) {
            console.error('Insert block error:', error);
            showToast('Failed to insert block: ' + error.message, 'error');
            throw error;
        }
    }
    
    function deleteBlock(blockId) {
        try {
            const block = window.Editor?.getBlock?.(blockId);
            if (!block) {
                throw new Error('Block not found: ' + blockId);
            }
            
            window.Editor?.deleteBlock?.(blockId);
            window.Editor?.savePage?.();
            
            // Refresh the editor UI
            window.Editor?.refreshEditor?.();
            
            showToast('Block deleted', 'success');
            
            // Add system message
            addMessage('assistant', pickRandom(RESPONSE_TEMPLATES.delete), {
                action: 'delete',
                blockId: blockId
            });
            
            return true;
            
        } catch (error) {
            console.error('Delete block error:', error);
            showToast('Failed to delete block: ' + error.message, 'error');
            throw error;
        }
    }
    
    function duplicateBlock(blockId) {
        try {
            window.Editor?.duplicateBlock?.(blockId);
            window.Editor?.savePage?.();
            
            showToast('Block duplicated', 'success');
            
            return true;
            
        } catch (error) {
            console.error('Duplicate block error:', error);
            showToast('Failed to duplicate block: ' + error.message, 'error');
            throw error;
        }
    }
    
    // ============================================
    // AI-Powered Content Actions
    // ============================================
    async function summarize(target = 'page') {
        try {
            const context = getPageContext();
            if (!context) {
                throw new Error('No page is currently loaded');
            }
            
            setProcessingState(true, { requestType: 'summarize' });
            
            await delay(1000);
            
            const summary = buildSummaryText(context);
            const response = formatTemplate(pickRandom(RESPONSE_TEMPLATES.summarize), {
                title: context.title,
                summary: summary
            });
            
            addMessage('assistant', response, {
                action: 'summarize',
                target: target
            });
            
            setProcessingState(false);
            
            return summary;
            
        } catch (error) {
            setProcessingState(false, { error: error.message });
            console.error('Summarize error:', error);
            throw error;
        }
    }
    
    async function improveWriting(blockId) {
        try {
            const block = window.Editor?.getBlock?.(blockId);
            if (!block) {
                throw new Error('Block not found');
            }
            
            setProcessingState(true, { requestType: 'improve' });
            
            await delay(1500);
            
            // Simulate improved content (in real implementation, would call AI API)
            const originalContent = typeof block.content === 'string' ? block.content : block.content?.text || '';
            const improvedContent = simulateImprovement(originalContent);
            
            // Update the block
            window.Editor?.updateBlockContent?.(blockId, improvedContent);
            window.Editor?.savePage?.();
            
            // Refresh the editor UI
            window.Editor?.refreshEditor?.();
            
            const response = pickRandom(RESPONSE_TEMPLATES.improve);
            addMessage('assistant', response, {
                action: 'improve',
                blockId: blockId
            });
            
            setProcessingState(false);
            
            showToast('Writing improved', 'success');
            
            return improvedContent;
            
        } catch (error) {
            setProcessingState(false, { error: error.message });
            console.error('Improve writing error:', error);
            throw error;
        }
    }
    
    function simulateImprovement(text) {
        // Simple simulation of text improvement
        // In a real implementation, this would call an AI API
        const improvements = [
            text.replace(/\bgood\b/gi, 'excellent'),
            text.replace(/\bbad\b/gi, 'challenging'),
            text.replace(/\bvery\b/gi, 'remarkably'),
            text.replace(/\bthing\b/gi, 'aspect'),
        ];
        
        // Add some professional polish
        let improved = improvements[Math.floor(Math.random() * improvements.length)] || text;
        
        // Capitalize first letter of sentences better
        improved = improved.replace(/\.\s+([a-z])/g, (match, letter) => `. ${letter.toUpperCase()}`);
        
        return improved;
    }
    
    async function continueWriting(insertAfterBlockId = null) {
        try {
            const context = getPageContext();
            if (!context) {
                throw new Error('No page is currently loaded');
            }
            
            setProcessingState(true, { requestType: 'continue' });
            
            await delay(2000);
            
            const continuedContent = buildContinuedText(context);
            
            // If no specific block ID, add at end
            const targetBlockId = insertAfterBlockId || context.blocks[context.blocks.length - 1]?.id;
            
            if (targetBlockId) {
                const newBlock = window.Editor?.insertBlockAfter?.(targetBlockId, 'text', continuedContent);
                window.Editor?.savePage?.();
                
                // Refresh the editor UI
                window.Editor?.refreshEditor?.();
                
                if (newBlock) {
                    window.Editor?.focusBlock?.(newBlock.id);
                }
            }
            
            const response = formatTemplate(pickRandom(RESPONSE_TEMPLATES.continue), {
                content: continuedContent.substring(0, 100) + '...'
            });
            
            addMessage('assistant', response, {
                action: 'continue'
            });
            
            setProcessingState(false);
            
            showToast('Content added', 'success');
            
            return continuedContent;
            
        } catch (error) {
            setProcessingState(false, { error: error.message });
            console.error('Continue writing error:', error);
            throw error;
        }
    }
    
    async function generateOutline(topic) {
        try {
            setProcessingState(true, { requestType: 'outline' });
            
            await delay(1500);
            
            const outlineTopic = topic || getPageContext()?.title || 'this topic';
            const outline = buildOutlineText(outlineTopic);
            
            const response = formatTemplate(pickRandom(RESPONSE_TEMPLATES.outline), {
                topic: outlineTopic,
                outline: outline
            });
            
            addMessage('assistant', response, {
                action: 'generateOutline',
                topic: outlineTopic
            });
            
            setProcessingState(false);
            
            return outline;
            
        } catch (error) {
            setProcessingState(false, { error: error.message });
            console.error('Generate outline error:', error);
            throw error;
        }
    }
    
    // ============================================
    // Utility Functions
    // ============================================
    function pickRandom(array) {
        return array[Math.floor(Math.random() * array.length)];
    }
    
    function formatTemplate(template, values) {
        return template.replace(/\{(\w+)\}/g, (match, key) => {
            return values[key] !== undefined ? values[key] : match;
        });
    }
    
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    function estimateTokens(text) {
        // Rough estimation: ~4 characters per token
        return Math.ceil(text.length / 4);
    }
    
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    function showToast(message, type = 'info') {
        if (window.Sidebar?.showToast) {
            window.Sidebar.showToast(message, type);
        } else {
            console.log(`[${type.toUpperCase()}] ${message}`);
        }
    }
    
    // ============================================
    // Advanced Features
    // ============================================
    function getConversationHistory(limit = 10) {
        syncConversationWithCurrentPage({ emitEvent: false });
        return state.messages.slice(-limit);
    }
    
    function exportConversation() {
        syncConversationWithCurrentPage({ emitEvent: false });
        const data = {
            exportedAt: new Date().toISOString(),
            pageId: state.activePageId,
            model: state.selectedModel,
            messages: state.messages
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `conversation-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showToast('Conversation exported', 'success');
    }
    
    function setStreamingEnabled(enabled) {
        state.streamingEnabled = enabled;
    }
    
    function isStreamingEnabled() {
        return state.streamingEnabled;
    }
    
    function getStats() {
        return {
            totalMessages: state.messages.length,
            userMessages: state.messages.filter(m => m.role === 'user').length,
            assistantMessages: state.messages.filter(m => m.role === 'assistant').length,
            estimatedTokens: state.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0),
            currentModel: state.selectedModel,
            isProcessing: state.isProcessing
        };
    }
    
    // ============================================
    // Initialize on load
    // ============================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    
    // ============================================
    // Public API
    // ============================================
    return {
        // Initialization
        init,
        
        // State
        state,
        getStats,
        
        // API Client
        getAPIClient,
        isBackendAvailable,
        
        // Models
        getModels,
        getModelsAsync,
        getSelectedModel,
        setSelectedModel,
        getModelInfo,
        getModel,
        getModelsByProvider,
        getAgentProfiles,
        getSelectedAgentProfile,
        setSelectedAgentProfile,

        // Page Context
        getPageContext,
        getFullPageContent,
        getBlockDesignOptions: getLiveBlockDesignOptions,
        getRequestUnderstanding: buildRequestUnderstanding,
        getDesignLayoutCatalog: () => window.NotesLayoutCatalog?.getPageLayouts?.() || [],
        getOutline,
        getPageProjection,
        getPageMetadata,
        
        // Page Context Helper (new)
        formatPageContextForAI,
        getBlockInfo,
        
        // Chat Interface
        ask,
        getMessages,
        clearConversation,
        syncConversationWithCurrentPage,
        formatMessageForDisplay,
        getConversationHistory,
        exportConversation,
        
        // Streaming
        setStreamingEnabled,
        isStreamingEnabled,
        
        // Block Actions
        editBlock,
        insertBlockAfter,
        insertBlockBefore,
        deleteBlock,
        duplicateBlock,
        
        // AI Actions
        summarize,
        improveWriting,
        continueWriting,
        generateOutline,
        
        // Visual Feedback (new)
        highlightBlock,
        unhighlightBlock,
        unhighlightAllBlocks,
        
        // Internal utilities (exposed for testing/advanced use)
        _generateStubResponse: generateStubResponse,
        _simulateStreaming: simulateStreaming,
        _buildSystemPrompt: buildSystemPrompt,
        _selectNotesPageTemplates: selectNotesPageTemplates,
        _selectNotesDesignSchemes: selectNotesDesignSchemes,
        _buildRequestUnderstanding: buildRequestUnderstanding,
        _selectNotesBlockDesignPatterns: selectNotesBlockDesignPatterns,
        _applyNotesActions: applyNotesActions,
        _extractNotesActionPlan: extractNotesActionPlan,
        _normalizeStructuredPageActions: normalizeStructuredPageActions,
        _buildFallbackNotesActionsFromText: buildFallbackNotesActionsFromText,
        _hasNonPageRuntimeIntent: hasNonPageRuntimeIntent,
        _shouldForcePageEditActions: shouldForcePageEditActions,
        _shouldUseMultiPassNotesDraft: shouldUseMultiPassNotesDraft,
        _shouldSuppressRequestedArtifactFormat: shouldSuppressRequestedArtifactFormat,
        _buildAgentProfilePromptGuidance: buildAgentProfilePromptGuidance
    };
})();

// Expose to window for global access
window.Agent = Agent;
