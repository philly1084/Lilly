'use strict';

const QUALITY_CONTRACT_VERSION = 'agent-quality-contract/v1';

function normalizeText(value = '') {
  return String(value || '').trim();
}

function hasTextMatch(values = [], pattern) {
  return values.some((value) => pattern.test(normalizeText(value)));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildEvidence(metadata = {}) {
  const verifyCommands = asArray(metadata.verifyCommands).map(normalizeText).filter(Boolean);
  const verifyResults = asArray(metadata.verifyResults).map(normalizeText).filter(Boolean);
  const uiScreenshots = asArray(metadata.uiScreenshots).map(normalizeText).filter(Boolean);
  const changedFiles = asArray(metadata.changedFiles).map(normalizeText).filter(Boolean);
  const textPool = [
    metadata.whatChanged,
    metadata.blocker,
    metadata.publicUrl,
    metadata.publicHost,
    metadata.deployment,
    metadata.gitCommit,
    metadata.gitRepo,
    metadata.workspace,
    metadata.cwd,
    metadata.uiCheckReport,
    ...verifyCommands,
    ...verifyResults,
    ...uiScreenshots,
    ...changedFiles,
  ].map(normalizeText).filter(Boolean);
  const proofTextPool = [
    metadata.whatChanged,
    metadata.publicUrl,
    metadata.publicHost,
    metadata.deployment,
    metadata.gitCommit,
    metadata.gitRepo,
    metadata.workspace,
    metadata.cwd,
    metadata.uiCheckReport,
    ...verifyCommands,
    ...verifyResults,
    ...uiScreenshots,
    ...changedFiles,
  ].map(normalizeText).filter(Boolean);

  return {
    ...metadata,
    verifyCommands,
    verifyResults,
    uiScreenshots,
    changedFiles,
    textPool,
    proofTextPool,
  };
}

const QUALITY_PROFILES = {
  'document-artifact': {
    id: 'document-artifact',
    label: 'Document artifact quality',
    goal: 'Produce a finished, format-correct document with explicit assumptions, source files, and target-medium verification.',
    checks: [
      {
        id: 'format_locked',
        label: 'Format is explicit and real',
        required: true,
        pass: (evidence) => hasTextMatch(evidence.textPool, /\b(?:html|pdf|pptx|xlsx|md|markdown|document|artifact|source file|download|preview)\b/i),
      },
      {
        id: 'not_placeholder',
        label: 'Deliverable is not a placeholder or plan-only artifact',
        required: true,
        pass: (evidence) => !hasTextMatch(evidence.textPool, /\b(?:todo|tbd|placeholder|plan-only|outline only|not generated)\b/i),
      },
      {
        id: 'target_medium_checked',
        label: 'Target medium was rendered, previewed, or inspected',
        required: true,
        pass: (evidence) => hasTextMatch(evidence.textPool, /\b(?:rendered|preview|opened|inspected|ui-check|visual|page break|contrast|table split|captions?)\b/i),
      },
      {
        id: 'handoff_complete',
        label: 'Handoff includes source/output/checks/assumptions',
        pass: (evidence) => hasTextMatch(evidence.textPool, /\b(?:source|artifact|checks? run|assumptions?|open questions?|acceptance)\b/i),
      },
    ],
  },
  'website-experience': {
    id: 'website-experience',
    label: 'Website and frontend experience quality',
    goal: 'Ship a usable, specific, responsive UI with real controls, relevant assets, and browser evidence.',
    checks: [
      {
        id: 'public_or_preview_url',
        label: 'Public or preview URL is available',
        required: true,
        pass: (evidence) => Boolean(normalizeText(evidence.publicUrl || evidence.publicHost)),
      },
      {
        id: 'browser_proof',
        label: 'Browser, Playwright, screenshot, or kimibuilt-ui-check evidence exists',
        required: true,
        pass: (evidence) => {
          if (/missing .*?(?:browser|playwright|kimibuilt-ui-check|ui proof|ui-affecting)/i.test(normalizeText(evidence.blocker))) {
            return false;
          }
          return Boolean(normalizeText(evidence.uiCheckReport))
            || evidence.uiScreenshots.length > 0
            || hasTextMatch(evidence.proofTextPool, /\b(?:kimibuilt-ui-check|playwright|chromium|browser|screenshot|visual qa|desktop|mobile)\b/i);
        },
      },
      {
        id: 'responsive_states',
        label: 'Desktop/mobile or opened-state verification is represented',
        pass: (evidence) => evidence.uiScreenshots.length >= 2
          || hasTextMatch(evidence.textPool, /\b(?:desktop|mobile|responsive|opened state|dialog|menu|popover|modal)\b/i),
      },
      {
        id: 'frontend_specificity',
        label: 'Change summary names a concrete UI/workflow instead of generic polish',
        pass: (evidence) => hasTextMatch([evidence.whatChanged], /\b(?:dashboard|site|website|page|route|frontend|ui|workflow|screen|component|copy|layout|interaction)\b/i),
      },
    ],
  },
  'remote-deployment': {
    id: 'remote-deployment',
    label: 'Remote CLI deployment quality',
    goal: 'Make remote software changes with baseline evidence, git/source continuity, deploy proof, and clear blockers.',
    checks: [
      {
        id: 'baseline_or_runtime_identity',
        label: 'Baseline or runtime identity evidence was captured',
        pass: (evidence) => hasTextMatch(evidence.textPool, /\b(?:baseline|hostname|whoami|uname|os-release|uptime|kubectl|get pods|git status)\b/i),
      },
      {
        id: 'change_continuity',
        label: 'Changed files, git commit, or concrete change summary is captured',
        required: true,
        pass: (evidence) => evidence.changedFiles.length > 0
          || Boolean(normalizeText(evidence.gitCommit))
          || Boolean(normalizeText(evidence.whatChanged)),
      },
      {
        id: 'verification_commands',
        label: 'Verification commands and results are captured',
        required: true,
        pass: (evidence) => evidence.verifyCommands.length > 0 && evidence.verifyResults.length > 0,
      },
      {
        id: 'deployment_or_url_proof',
        label: 'Deployment, host, or public URL proof is captured when relevant',
        pass: (evidence) => Boolean(normalizeText(evidence.deployment || evidence.publicHost || evidence.publicUrl)),
      },
      {
        id: 'blocker_explicit',
        label: 'Blocked work has an explicit blocker, complete work has none',
        required: true,
        pass: (evidence) => normalizeText(evidence.completionStatus) === 'blocked'
          ? Boolean(normalizeText(evidence.blocker))
          : !Boolean(normalizeText(evidence.blocker)),
      },
    ],
  },
};

function inferQualitySurfaces(task = '', metadata = {}) {
  const text = [
    task,
    metadata.whatChanged,
    metadata.publicUrl,
    metadata.publicHost,
    metadata.deployment,
    ...(Array.isArray(metadata.verifyCommands) ? metadata.verifyCommands : []),
    ...(Array.isArray(metadata.verifyResults) ? metadata.verifyResults : []),
  ].map(normalizeText).join('\n').toLowerCase();
  const surfaces = new Set();

  if (/\b(?:remote|server|deploy|deployment|k3s|kubectl|ingress|tls|gitlab|runner|public host|public url)\b/.test(text)
    || metadata.deployment
    || metadata.gitCommit) {
    surfaces.add('remote-deployment');
  }
  if (/\b(?:website|site|dashboard|frontend|front-end|ui|user interface|html artifact|web-chat|managed-app preview|landing page)\b/.test(text)
    || metadata.uiCheckReport
    || (Array.isArray(metadata.uiScreenshots) && metadata.uiScreenshots.length > 0)) {
    surfaces.add('website-experience');
  }
  if (/\b(?:document|pdf|pptx|xlsx|markdown|md\b|brief|report|runbook|manual|deck|worksheet|artifact)\b/.test(text)) {
    surfaces.add('document-artifact');
  }

  if (surfaces.size === 0) {
    surfaces.add('remote-deployment');
  }
  return Array.from(surfaces);
}

function scoreProfile(profile, evidence) {
  const checks = profile.checks.map((check) => {
    const passed = Boolean(check.pass(evidence));
    return {
      id: check.id,
      label: check.label,
      required: check.required === true,
      passed,
    };
  });
  const passed = checks.filter((check) => check.passed).length;
  const requiredMissing = checks
    .filter((check) => check.required && !check.passed)
    .map((check) => check.id);
  return {
    id: profile.id,
    label: profile.label,
    score: checks.length > 0 ? Number((passed / checks.length).toFixed(2)) : 1,
    requiredMissing,
    checks,
  };
}

function summarizeStatus(surfaceScores = [], completionStatus = '') {
  if (normalizeText(completionStatus) === 'blocked') {
    return 'blocked';
  }
  const requiredMissing = surfaceScores.flatMap((surface) => surface.requiredMissing || []);
  const average = surfaceScores.length > 0
    ? surfaceScores.reduce((sum, surface) => sum + surface.score, 0) / surfaceScores.length
    : 1;
  if (requiredMissing.length === 0 && average >= 0.85) {
    return 'passed';
  }
  if (average >= 0.5) {
    return 'partial';
  }
  return 'needs_work';
}

function assessAgentQuality({ task = '', metadata = {}, surfaces = null } = {}) {
  const selectedSurfaces = (Array.isArray(surfaces) && surfaces.length > 0 ? surfaces : inferQualitySurfaces(task, metadata))
    .filter((surface) => QUALITY_PROFILES[surface]);
  const evidence = buildEvidence(metadata);
  const surfaceScores = selectedSurfaces.map((surface) => scoreProfile(QUALITY_PROFILES[surface], evidence));
  const score = surfaceScores.length > 0
    ? Number((surfaceScores.reduce((sum, surface) => sum + surface.score, 0) / surfaceScores.length).toFixed(2))
    : 1;
  const requiredMissing = Array.from(new Set(surfaceScores.flatMap((surface) => surface.requiredMissing || [])));
  return {
    version: QUALITY_CONTRACT_VERSION,
    surfaces: surfaceScores,
    score,
    status: summarizeStatus(surfaceScores, metadata.completionStatus),
    requiredMissing,
  };
}

function normalizeQualityAssessment(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const score = Number(value.score);
  const status = normalizeText(value.status || 'unknown').toLowerCase() || 'unknown';
  const requiredMissing = Array.isArray(value.requiredMissing)
    ? value.requiredMissing.map(normalizeText).filter(Boolean)
    : [];
  const surfaces = Array.isArray(value.surfaces)
    ? value.surfaces
        .filter((surface) => surface && typeof surface === 'object' && !Array.isArray(surface))
        .map((surface) => ({
          id: normalizeText(surface.id),
          label: normalizeText(surface.label || surface.id),
          score: Number.isFinite(Number(surface.score)) ? Number(surface.score) : null,
          requiredMissing: Array.isArray(surface.requiredMissing)
            ? surface.requiredMissing.map(normalizeText).filter(Boolean)
            : [],
        }))
    : [];

  return {
    status,
    score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null,
    requiredMissing,
    surfaces,
  };
}

function countBy(values = []) {
  return values.reduce((counts, value) => {
    const key = normalizeText(value || 'unknown') || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function summarizeCountMap(counts = {}, limit = 6) {
  return Object.entries(counts)
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function summarizeAgentQualityAssessments(assessments = []) {
  const normalized = (Array.isArray(assessments) ? assessments : [])
    .map(normalizeQualityAssessment)
    .filter(Boolean);
  const scored = normalized.filter((assessment) => assessment.score != null);
  const statusCounts = countBy(normalized.map((assessment) => assessment.status));
  const missingGateCounts = countBy(normalized.flatMap((assessment) => assessment.requiredMissing));
  const surfaceStats = new Map();

  normalized.forEach((assessment) => {
    assessment.surfaces.forEach((surface) => {
      const id = surface.id || surface.label;
      if (!id) {
        return;
      }
      const current = surfaceStats.get(id) || {
        id,
        label: surface.label || id,
        count: 0,
        scored: 0,
        scoreTotal: 0,
        requiredMissing: {},
      };
      current.count += 1;
      if (surface.score != null) {
        current.scored += 1;
        current.scoreTotal += surface.score;
      }
      surface.requiredMissing.forEach((gate) => {
        current.requiredMissing[gate] = (current.requiredMissing[gate] || 0) + 1;
      });
      surfaceStats.set(id, current);
    });
  });

  const averageScore = scored.length > 0
    ? Number((scored.reduce((sum, assessment) => sum + assessment.score, 0) / scored.length).toFixed(2))
    : null;

  return {
    version: `${QUALITY_CONTRACT_VERSION}/summary`,
    total: normalized.length,
    scored: scored.length,
    averageScore,
    statusCounts,
    topMissingGates: summarizeCountMap(missingGateCounts),
    surfaces: Array.from(surfaceStats.values())
      .map((surface) => ({
        id: surface.id,
        label: surface.label,
        count: surface.count,
        scored: surface.scored,
        averageScore: surface.scored > 0
          ? Number((surface.scoreTotal / surface.scored).toFixed(2))
          : null,
        topMissingGates: summarizeCountMap(surface.requiredMissing, 4),
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  };
}

function buildQualityProfileMetadata(surfaces = Object.keys(QUALITY_PROFILES)) {
  return surfaces
    .filter((surface) => QUALITY_PROFILES[surface])
    .map((surface) => {
      const profile = QUALITY_PROFILES[surface];
      return {
        id: profile.id,
        label: profile.label,
        goal: profile.goal,
        requiredChecks: profile.checks.filter((check) => check.required).map((check) => check.id),
        checks: profile.checks.map((check) => check.id),
      };
    });
}

function buildAgentQualityContractText(surfaces = Object.keys(QUALITY_PROFILES)) {
  const profiles = buildQualityProfileMetadata(surfaces);
  return [
    'Agent quality metrics:',
    '- Use a manager-and-specialist pattern: keep final user responsibility with the orchestrator, and delegate bounded document, website, or remote deployment work only when that specialist has the right tools and verification path.',
    '- Treat guardrails as release gates: a run is not complete until required evidence is present or a blocker names the missing tool, approval, credential, or proof path.',
    '- Emit structured proof so traces/evals/admin review can score the work: changed files/artifacts, verification commands/results, public URLs, browser or render proof, assumptions, and blockers.',
    ...profiles.map((profile) => `- ${profile.label}: ${profile.goal} Required checks: ${profile.requiredChecks.join(', ') || 'none'}.`),
  ].join('\n');
}

module.exports = {
  QUALITY_CONTRACT_VERSION,
  QUALITY_PROFILES,
  assessAgentQuality,
  buildAgentQualityContractText,
  buildQualityProfileMetadata,
  inferQualitySurfaces,
  summarizeAgentQualityAssessments,
};
