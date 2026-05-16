'use strict';

const ROLE_IDS = Object.freeze({
  ORCHESTRATOR: 'orchestrator',
  RESEARCH: 'research_agent',
  DESIGN: 'design_agent',
  BUILDER: 'builder_agent',
  QA: 'qa_agent',
  INTEGRATOR: 'integrator',
});

const IMPRESSIVE_FRONTEND_QUALITY_BAR = Object.freeze({
  name: 'impressive-frontend-websites',
  appliesTo: ['website', 'dashboard', 'app-workspace', 'landing-page', 'frontend-demo', 'html-prototype', 'ui-mockup', 'browser-game', 'interactive-sandbox', 'vite-preview'],
  promptTag: 'impressive_frontend_website_standard',
  requiredPractices: [
    'Start from a compact brief: site type, audience, primary goals, content/data, brand mood, assets, and target devices. If details are missing, infer a tasteful direction and ask only for true blockers.',
    'Build the actual usable first screen. The first viewport must communicate the product, place, workflow, offer, or audience immediately; do not ship a generic placeholder or a static screenshot-like mockup.',
    'Match the artifact family: operational tools should be calm, dense, and scannable; documentation should prioritize wayfinding; reports should emphasize evidence; brand/editorial pages may be more expressive.',
    'Include real controls, states, and interactions where expected: nav, filters, tabs, forms, empty/loading/error/disabled states, menus, dialogs, tooltips, drill-downs, toggles, search, or chart controls.',
    'Use visual assets that reveal the actual product, place, workflow, state, or audience when assets are available or can be generated. Avoid vague decorative gradients, blobs, blurred stock-like backgrounds, and purely atmospheric imagery.',
    'Design with restraint and specificity: stable responsive grids, readable typography, balanced color, explicit contrast, consistent borders/radii/spacing, no nested cards, no clipped labels, no horizontal overflow, and no one-note palettes.',
    'Treat opened UI surfaces as first-class: dropdown lists, select options, menus, popovers, dialogs, tooltips, hover, selected, focus, disabled, and empty states must have readable text/background contrast.',
    'Verify desktop and mobile screenshots, opened interactive states, broken images, console errors, contrast, overflow, clipped text, and nonblank canvas/WebGL/3D rendering when relevant.',
    'For non-trivial sites, expect an iteration pass after the first render; suggestions should name concrete next refinements rather than generic polish.',
  ],
});

const FRONTEND_FALLBACK_GATE = Object.freeze({
  promptTag: 'frontend_repair_redesign_gate',
  requiredPractices: [
    'After every preview or screenshot QA result, classify the next step as repair, redesign, ask, or ready. Repair when the concept is sound but implementation, assets, contrast, overflow, or interaction wiring failed. Redesign when the layout family, visual direction, or information architecture still feels generic, cheap, or mismatched.',
    'When a tool, asset, framework import, screenshot, or browser check fails, communicate the fallback being used and why. Do not hide a downgrade behind a success summary.',
    'A fallback may progress only if it preserves the user goal and adds concrete evidence: revised files, a new preview URL, screenshots, or a named blocker. If the fallback lowers quality materially, ask for direction or choose redesign before finalizing.',
    'For iterative design work, carry forward the previous design intent, QA evidence, and failure reason so the next pass changes the actual surface rather than regenerating the same scaffold.',
  ],
});

const GAME_PLACEHOLDER_ASSET_POLICY = Object.freeze({
  promptTag: 'game_placeholder_asset_policy',
  requiredPractices: [
    'If real game object files, sprites, models, or textures are unavailable, create in-place placeholder objects instead of blocking. Use varied silhouettes, colors, scale, motion, labels, materials, and interaction roles so players can distinguish heroes, hazards, pickups, scenery, goals, enemies, NPCs, vehicles, doors, and projectiles.',
    'Prefer implementation-native placeholders: CSS shapes, canvas sprites, SVG symbols, procedural Three.js meshes/materials, p5 drawings, or data-driven object factories. Avoid one repeated gray box or one generic icon standing in for every missing asset.',
    'Record the placeholder contract in AGENT_SANDBOX_BUILD.md or metadata.handoff with each placeholder object role, what real asset would replace it, and any collision/input/animation behavior that must survive asset replacement.',
  ],
});

const FRONTEND_TECH_STACK_GUIDANCE = Object.freeze({
  promptTag: 'sandbox_frontend_technology_ladder',
  localBuildLane: [
    'Use `code-sandbox` project mode for local builds; prefer `language:"vite"` for multi-file apps, games, simulations, dashboards, 3D scenes, and stateful workflows.',
    'Use plain static HTML only for simple read-only pages, document previews, or tiny snippets. If the user asks for an app, game, dashboard, interactive website, simulation, data explorer, or 3D experience, choose React/Vite modules or purpose-built browser libraries.',
    'For React previews, keep the entry browser-runnable without npm install by using ESM CDN or bundled browser imports in `index.html`, while still including `package.json`, `vite.config.js`, and `src/` files for repo handoff when useful.',
    'For 3D, WebGL, spatial data, generative visuals, or immersive scenes, use the local Three.js import map from `/api/sandbox-libraries/three/three.module.js` plus `/api/sandbox-libraries/three/addons/` when available.',
    'For motion, games, physics, sketches, and rich data, prefer the installed sandbox library routes for GSAP, Matter.js, p5.js, D3, Chart.js, ECharts, Plotly, Cytoscape, force-graph, or 3D Force Graph before external CDNs.',
    'Include real state and interaction plumbing: component state, event handlers, generated/mock data adapters, loading and empty states, keyboard/pointer/touch controls when relevant, and visible status feedback.',
  ],
  stageContract: [
    'Stage 1 local prototype: build a previewable sandbox bundle with source files, a clear entry point, and an `AGENT_SANDBOX_BUILD.md` or metadata.handoff note covering goal, assumptions, acceptance checks, and checks run.',
    'Stage 2 visual QA: open the preview URL, capture desktop and mobile screenshots, check console errors, contrast, overflow, broken assets, clipped text, opened controls, and nonblank canvas/WebGL pixels when relevant.',
    'Stage 3 remote build candidate: when the user wants it live, promote the local bundle into a managed app or repository lane rather than rebuilding from scratch; pass artifact IDs, source files, QA notes, and design intent to `managed-app iterate` or `remote-cli-agent`.',
    'Stage 4 live promotion: do not call it live until there is Git/source evidence, build or image evidence, rollout/deploy evidence, public URL, and browser/UI-check proof.',
  ],
});

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeLowerText(value = '') {
  return normalizeText(value).toLowerCase();
}

function hasResearchIntent(text = '') {
  const normalized = normalizeLowerText(text);
  return /\b(research|look up|search|browse|latest|current|compare|comparison|source|sources|evidence|pricing|news)\b/.test(normalized);
}

function hasDesignIntent(text = '') {
  const normalized = normalizeLowerText(text);
  return /\b(design|layout|visual|style|theme|brand|branding|ux|ui|information architecture|wireframe|prototype|polish|beautiful|modern)\b/.test(normalized);
}

function hasWebsiteBuildIntent(text = '') {
  const normalized = normalizeLowerText(text);
  if (!normalized) {
    return false;
  }

  const buildVerb = /\b(create|make|generate|build|draft|design|prototype|ship|assemble|produce|turn)\b/.test(normalized);
  const webTarget = /\b(website|web site|site|webpage|web page|landing page|microsite|product page|dashboard|frontend|front end|webapp|web app|html page|html document|browser game|web game|video game|sandboxed game|game prototype|playable game|interactive sandbox|vite preview|vite sandbox|multi step frontend|multi-step frontend)\b/.test(normalized)
    || (/\bgame\b/.test(normalized) && /\b(sandbox|sandboxed|browser|webapp|web app|phone|mobile|keyboard|mouse|touch)\b/.test(normalized));
  return (buildVerb && webTarget) || hasConceptPrototypeIntent(normalized);
}

function hasConceptPrototypeIntent(text = '') {
  const normalized = normalizeLowerText(text);
  if (!normalized) {
    return false;
  }

  const conceptCue = /\b(idea|concept|product idea|app idea|prototype|mockup|mvp|proof of concept|poc|sandbox it|sandboxed|local sandbox|try it locally)\b/.test(normalized);
  const softwareTarget = /\b(app|application|software|tool|product|feature|workflow|website|web site|site|webpage|web page|landing page|dashboard|frontend|front end|webapp|web app|html|browser game|game|service)\b/.test(normalized);
  const buildJourney = /\b(build|make|create|prototype|mock up|sandbox|try|test|ship|deploy|publish|remote cli|repo|repository|git|github|gitlab)\b/.test(normalized);

  return conceptCue && softwareTarget && buildJourney;
}

function hasGameOrSimulationIntent(text = '') {
  const normalized = normalizeLowerText(text);
  return /\b(browser game|web game|video game|playable game|sandboxed game|game prototype|game|simulation|physics toy|canvas game|webgl game)\b/.test(normalized);
}

function hasDocumentBuildIntent(text = '') {
  const normalized = normalizeLowerText(text);
  if (!normalized) {
    return false;
  }

  const buildVerb = /\b(create|make|generate|build|prepare|draft|write|assemble|compile|organize|turn|convert|export)\b/.test(normalized);
  const documentTarget = /\b(document|doc|report|brief|proposal|guide|summary|one-pager|whitepaper|slides|presentation|deck|pptx|docx|pdf)\b/.test(normalized);
  return buildVerb && documentTarget;
}

function buildRole({
  id,
  label,
  purpose,
  tools = [],
  outputContract = {},
  autonomy = 'bounded',
} = {}) {
  return {
    id,
    label,
    purpose,
    tools,
    outputContract,
    autonomy,
  };
}

function formatFrontendQualityBarForPrompt({
  includeWrapper = true,
  includeCanvasHandoff = false,
  includeGameAddendum = false,
  includeTechnologyLadder = true,
  includePromotionPath = true,
} = {}) {
  const tag = IMPRESSIVE_FRONTEND_QUALITY_BAR.promptTag;
  const lines = [];

  if (includeWrapper) {
    lines.push(`<${tag}>`);
  }

  lines.push(`Use this standard whenever the request is a ${IMPRESSIVE_FRONTEND_QUALITY_BAR.appliesTo.join(', ')}.`);
  IMPRESSIVE_FRONTEND_QUALITY_BAR.requiredPractices.forEach((practice) => {
    lines.push(`- ${practice}`);
  });

  if (includeTechnologyLadder) {
    lines.push(`<${FRONTEND_TECH_STACK_GUIDANCE.promptTag}>`);
    FRONTEND_TECH_STACK_GUIDANCE.localBuildLane.forEach((practice) => {
      lines.push(`- ${practice}`);
    });
    lines.push(`</${FRONTEND_TECH_STACK_GUIDANCE.promptTag}>`);
  }

  if (includePromotionPath) {
    lines.push('<local_to_live_build_stages>');
    FRONTEND_TECH_STACK_GUIDANCE.stageContract.forEach((practice) => {
      lines.push(`- ${practice}`);
    });
    lines.push('</local_to_live_build_stages>');
  }

  if (includeCanvasHandoff) {
    lines.push('- Include a verification and promotion plan in metadata.handoff: targetFramework, componentMap, local sandbox checks, desktop/mobile screenshot checks, opened interactive states to inspect, broken-image and console-error checks, contrast/overflow checks, clipped-text checks, live-promotion assumptions, and any remaining blockers.');
  }

  lines.push(`<${FRONTEND_FALLBACK_GATE.promptTag}>`);
  FRONTEND_FALLBACK_GATE.requiredPractices.forEach((practice) => {
    lines.push(`- ${practice}`);
  });
  lines.push(`</${FRONTEND_FALLBACK_GATE.promptTag}>`);

  if (includeGameAddendum) {
    lines.push('- For games, simulations, canvas, and WebGL work, include a real loop or workflow state machine when needed, pause/restart/reset controls, input affordances, fallback messaging for blank/module failures, and nonblank render verification.');
    lines.push(`<${GAME_PLACEHOLDER_ASSET_POLICY.promptTag}>`);
    GAME_PLACEHOLDER_ASSET_POLICY.requiredPractices.forEach((practice) => {
      lines.push(`- ${practice}`);
    });
    lines.push(`</${GAME_PLACEHOLDER_ASSET_POLICY.promptTag}>`);
  }

  if (includeWrapper) {
    lines.push(`</${tag}>`);
  }

  return lines.join('\n');
}

function inferAgentRolePipeline({
  objective = '',
  classification = null,
  executionProfile = 'default',
} = {}) {
  const text = normalizeText(objective);
  const normalized = normalizeLowerText(text);
  if (!normalized) {
    return null;
  }

  const conceptPrototype = hasConceptPrototypeIntent(normalized);
  const websiteBuild = hasWebsiteBuildIntent(normalized) || conceptPrototype;
  const gameBuild = hasGameOrSimulationIntent(normalized);
  const documentBuild = hasDocumentBuildIntent(normalized);
  const researchNeeded = hasResearchIntent(normalized)
    || classification?.groundingRequirement === 'required'
    || classification?.taskFamily === 'research'
    || classification?.taskFamily === 'research-deliverable';
  const designNeeded = websiteBuild
    || hasDesignIntent(normalized)
    || classification?.taskFamily === 'document';
  const buildNeeded = websiteBuild || documentBuild;

  if (!researchNeeded && !designNeeded && !buildNeeded) {
    return null;
  }

  const roles = [
    buildRole({
      id: ROLE_IDS.ORCHESTRATOR,
      label: 'Orchestrator',
      purpose: 'Own the task graph, budgets, sequencing, and handoff artifacts.',
      tools: ['user-checkpoint', 'agent-delegate', 'agent-workload'],
      outputContract: {
        format: 'json',
        required: ['rolePlan', 'handoffArtifacts', 'completionCriteria'],
      },
    }),
  ];

  if (researchNeeded) {
    roles.push(buildRole({
      id: ROLE_IDS.RESEARCH,
      label: 'Research Agent',
      purpose: 'Gather and verify sources before synthesis or artifact generation.',
      tools: ['web-search', 'web-fetch', 'web-scrape', 'research-bucket-write'],
      outputContract: {
        format: 'source-pack',
        required: ['claims', 'sources', 'sourceUrls'],
      },
    }));
  }

  if (designNeeded) {
    roles.push(buildRole({
      id: ROLE_IDS.DESIGN,
      label: 'Design Agent',
      purpose: 'Produce information architecture, visual direction, design tokens, and content structure before building.',
      tools: ['design-resource-search', 'image-search-unsplash', 'image-generate', 'graph-diagram'],
      outputContract: {
        format: 'design-brief',
        required: ['audience', 'layoutPlan', 'visualDirection', 'assetPlan', 'componentMap', 'fallbackGate', 'visualQaPlan'],
      },
    }));
  }

  if (buildNeeded) {
    roles.push(buildRole({
      id: ROLE_IDS.BUILDER,
      label: 'Builder Agent',
      purpose: 'Build the requested artifact from research and design specs in a previewable sandbox or artifact pipeline.',
      tools: websiteBuild
        ? ['document-workflow', 'code-sandbox', 'file-write']
        : ['document-workflow', 'graph-diagram'],
      outputContract: {
        format: websiteBuild ? 'sandbox-project' : 'document-artifact',
        required: websiteBuild
          ? ['workspacePath', 'previewUrl', 'files', 'technologyChoice', 'interactiveStates', 'responsivePlan', 'qaEvidence', 'promotionPlan']
          : ['artifactUrl', 'format'],
      },
    }));
  }

  if (websiteBuild) {
    roles.push(buildRole({
      id: ROLE_IDS.QA,
      label: 'QA Agent',
      purpose: 'Verify the generated website, dashboard, app, or game for renderability, responsive screenshots, opened states, and repair-vs-redesign decisions.',
      tools: ['code-sandbox', 'web-fetch', 'web-scrape'],
      outputContract: {
        format: 'qa-report',
        required: ['checks', 'screenshots', 'openedStates', 'issues', 'fallbackDecision', 'repairOrRedesign', 'refinements', 'ready'],
      },
    }));
  }

  roles.push(buildRole({
    id: ROLE_IDS.INTEGRATOR,
    label: 'Integrator',
    purpose: 'Assemble the final user-facing response, cite verified sources, and persist durable project context.',
    tools: ['document-workflow', 'agent-notes-write'],
    outputContract: {
      format: 'final-response',
      required: ['summary', 'artifacts', 'nextSteps'],
    },
  }));

  return {
    type: 'AgentRolePipeline',
    version: 1,
    strategy: websiteBuild
      ? (conceptPrototype ? 'concept-design-sandbox-build' : 'research-design-sandbox-build')
      : (documentBuild ? 'research-design-document-build' : 'research-design-synthesis'),
    executionProfile,
    requiresResearch: researchNeeded,
    requiresDesign: designNeeded,
    requiresBuild: buildNeeded,
    requiresSandbox: websiteBuild,
    maxRoundsHint: websiteBuild ? 4 : (researchNeeded && documentBuild ? 3 : 2),
    maxToolCallsHint: websiteBuild ? 10 : 7,
    qualityBar: websiteBuild ? IMPRESSIVE_FRONTEND_QUALITY_BAR : null,
    fallbackGate: websiteBuild ? FRONTEND_FALLBACK_GATE : null,
    placeholderAssetPolicy: gameBuild ? GAME_PLACEHOLDER_ASSET_POLICY : null,
    sandboxPolicy: websiteBuild
      ? {
        required: true,
        mode: 'project',
        reason: 'Website and dashboard artifacts should be built as previewable project workspaces, not only template text.',
        technologyLadder: FRONTEND_TECH_STACK_GUIDANCE.localBuildLane,
        promotionStages: FRONTEND_TECH_STACK_GUIDANCE.stageContract,
      }
      : {
        required: false,
      },
    roles,
  };
}

function hasRole(pipeline = null, roleId = '') {
  return Array.isArray(pipeline?.roles)
    && pipeline.roles.some((role) => role?.id === roleId);
}

function formatAgentRolePipelineForPrompt(pipeline = null) {
  if (!pipeline || !Array.isArray(pipeline.roles) || pipeline.roles.length === 0) {
    return '(none)';
  }

  return JSON.stringify({
    strategy: pipeline.strategy,
    requiresResearch: pipeline.requiresResearch,
    requiresDesign: pipeline.requiresDesign,
    requiresBuild: pipeline.requiresBuild,
    sandboxPolicy: pipeline.sandboxPolicy,
    qualityBar: pipeline.qualityBar,
    fallbackGate: pipeline.fallbackGate,
    placeholderAssetPolicy: pipeline.placeholderAssetPolicy,
    roles: pipeline.roles.map((role) => ({
      id: role.id,
      label: role.label,
      purpose: role.purpose,
      tools: role.tools,
      outputContract: role.outputContract,
      autonomy: role.autonomy,
    })),
  }, null, 2);
}

module.exports = {
  ROLE_IDS,
  FRONTEND_TECH_STACK_GUIDANCE,
  FRONTEND_FALLBACK_GATE,
  GAME_PLACEHOLDER_ASSET_POLICY,
  IMPRESSIVE_FRONTEND_QUALITY_BAR,
  formatFrontendQualityBarForPrompt,
  formatAgentRolePipelineForPrompt,
  hasDocumentBuildIntent,
  hasConceptPrototypeIntent,
  hasResearchIntent,
  hasRole,
  hasWebsiteBuildIntent,
  inferAgentRolePipeline,
};
