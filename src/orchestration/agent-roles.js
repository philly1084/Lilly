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
  requiredPractices: [
    'infer a compact brief when the user gives sparse context',
    'make the first viewport specific to the product, place, workflow, offer, or audience',
    'build the usable experience with real controls, states, data regions, and purposeful interactions',
    'use relevant visual assets that reveal the product, workflow, audience, place, or state',
    'avoid generic placeholders, one-note palettes, decorative blobs, nested cards, clipped labels, and horizontal overflow',
    'verify desktop, mobile, opened interactive surfaces, contrast, console errors, broken images, and nonblank canvas or 3D rendering',
    'iterate after the first working render for non-trivial frontend builds',
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
  const webTarget = /\b(website|web site|site|webpage|web page|landing page|microsite|product page|dashboard|frontend|front end|webapp|web app|html page|html document|browser game|web game|sandboxed game|game prototype|playable game|interactive sandbox|vite preview|vite sandbox|multi step frontend|multi-step frontend)\b/.test(normalized)
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
        required: ['audience', 'layoutPlan', 'visualDirection', 'assetPlan', 'componentMap', 'visualQaPlan'],
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
          ? ['workspacePath', 'previewUrl', 'files', 'interactiveStates', 'responsivePlan']
          : ['artifactUrl', 'format'],
      },
    }));
  }

  if (websiteBuild) {
    roles.push(buildRole({
      id: ROLE_IDS.QA,
      label: 'QA Agent',
      purpose: 'Verify the generated website or dashboard for renderability, responsive screenshots, and obvious content/design regressions.',
      tools: ['code-sandbox', 'web-fetch', 'web-scrape'],
      outputContract: {
        format: 'qa-report',
        required: ['checks', 'screenshots', 'openedStates', 'issues', 'refinements', 'ready'],
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
    sandboxPolicy: websiteBuild
      ? {
        required: true,
        mode: 'project',
        reason: 'Website and dashboard artifacts should be built as previewable project workspaces, not only template text.',
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
  IMPRESSIVE_FRONTEND_QUALITY_BAR,
  formatAgentRolePipelineForPrompt,
  hasDocumentBuildIntent,
  hasConceptPrototypeIntent,
  hasResearchIntent,
  hasRole,
  hasWebsiteBuildIntent,
  inferAgentRolePipeline,
};
