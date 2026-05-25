const fs = require('fs');
const path = require('path');
const {
  PROJECT_ROOT,
  resolvePreferredWritableFile,
} = require('./runtime-state-paths');

const SELF_REFLECTION_UPDATE_TOOL_ID = 'self-reflection-update';
const SELF_REFLECTION_UPDATE_ACTION_LIMIT = 4;
const SELF_REFLECTION_MODEL_CARD_NOTE_LIMIT = 1200;
const SELF_REFLECTION_LOG_FILE = path.join(PROJECT_ROOT, 'data', 'self-reflection-updates', 'updates.jsonl');
const DURABLE_HISTORY_DIR = 'history';

const BLOCKED_DURABLE_CONTENT_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:sk|pk|rk|ghp|github_pat)_[A-Za-z0-9_\-]{16,}\b/i,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"']{12,}/i,
  /https?:\/\/[^/\s:@]+:[^/\s:@]+@/i,
  /\bignore\s+(previous|all|above|prior)\s+instructions\b/i,
  /\bdisregard\s+(your|all|any)\s+(instructions|rules|guidelines)\b/i,
  /\bsystem\s+prompt\s+override\b/i,
];

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeType(value = '') {
  return normalizeText(value).toLowerCase().replace(/[\s-]+/g, '_');
}

function getDefaultSkillStore() {
  return require('./skills/skill-store').skillStore;
}

function getDefaultAgentNotesHelpers() {
  return require('./agent-notes');
}

function getDefaultSoulHelpers() {
  return require('./agent-soul');
}

function getDefaultUserProfileHelpers() {
  return require('./agent-user-profile');
}

function getLogFilePath() {
  const configured = String(process.env.KIMIBUILT_SELF_REFLECTION_LOG_PATH || '').trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(PROJECT_ROOT, configured);
  }

  return resolvePreferredWritableFile(
    SELF_REFLECTION_LOG_FILE,
    ['self-reflection-updates', 'updates.jsonl'],
  );
}

function assertNoBlockedDurableContent(value = '', label = 'content') {
  const source = String(value || '');
  const matched = BLOCKED_DURABLE_CONTENT_PATTERNS.find((pattern) => pattern.test(source));
  if (matched) {
    const error = new Error(`${label} contains content that is not allowed in durable self-reflection updates.`);
    error.statusCode = 400;
    throw error;
  }
}

function assertReflectionEnvelope(input = {}) {
  const recursionDepth = Number(input.recursionDepth || 0);
  if (Number.isFinite(recursionDepth) && recursionDepth > 0) {
    const error = new Error('self-reflection-update does not support nested or recursive reflection calls.');
    error.statusCode = 400;
    throw error;
  }

  const source = normalizeType(input.source || '');
  if (source === 'self_reflection_update' || source === 'reflection_result') {
    const error = new Error('self-reflection-update cannot be called from its own result.');
    error.statusCode = 400;
    throw error;
  }
}

function normalizeActionList(input = {}) {
  const actions = Array.isArray(input.actions)
    ? input.actions
    : (input.action ? [input.action] : []);

  if (actions.length > SELF_REFLECTION_UPDATE_ACTION_LIMIT) {
    const error = new Error(`self-reflection-update accepts at most ${SELF_REFLECTION_UPDATE_ACTION_LIMIT} actions per call.`);
    error.statusCode = 400;
    throw error;
  }

  return actions
    .filter((action) => action && typeof action === 'object' && !Array.isArray(action))
    .map((action) => ({
      ...action,
      type: normalizeType(action.type || action.action || action.kind),
      reason: normalizeText(action.reason || action.rationale || input.reason || input.reflection),
    }));
}

function normalizeSkillPayload(action = {}, existing = null) {
  return {
    id: action.id || action.skillId || existing?.id,
    name: action.name || existing?.name,
    description: action.description !== undefined ? action.description : existing?.description,
    body: action.body !== undefined
      ? action.body
      : (action.instructions !== undefined ? action.instructions : existing?.body),
    tools: action.tools !== undefined ? action.tools : existing?.tools,
    triggerPatterns: action.triggerPatterns !== undefined
      ? action.triggerPatterns
      : (action.triggers !== undefined ? action.triggers : existing?.triggerPatterns),
    chain: action.chain !== undefined ? action.chain : (action.steps !== undefined ? action.steps : existing?.chain),
    contextPolicy: action.contextPolicy !== undefined ? action.contextPolicy : existing?.contextPolicy,
    enabled: action.enabled !== undefined ? action.enabled : existing?.enabled,
  };
}

function countOccurrences(source = '', needle = '') {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (index <= source.length) {
    const found = source.indexOf(needle, index);
    if (found === -1) {
      break;
    }
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function normalizeDurableMarkdown(value = '') {
  const normalized = String(value || '').replace(/\r\n/g, '\n').trimEnd();
  return normalized ? `${normalized}\n` : '';
}

function normalizeHistorySegment(value = '') {
  return normalizeText(value || 'durable-file')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'durable-file';
}

function getDurableHistoryPath(label = 'durable-file', context = {}) {
  const logPath = getLogFilePath();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const updateId = normalizeHistorySegment(context.updateId || 'update');
  const fileBase = normalizeHistorySegment(label);
  return path.join(path.dirname(logPath), DURABLE_HISTORY_DIR, fileBase, `${timestamp}-${updateId}.md`);
}

function saveDurableFileSnapshot(filePath = '', label = 'durable-file', context = {}) {
  const absoluteFilePath = String(filePath || '').trim();
  if (!absoluteFilePath || !fs.existsSync(absoluteFilePath)) {
    return '';
  }

  const snapshotKey = path.resolve(absoluteFilePath);
  if (context.snapshots?.has(snapshotKey)) {
    return context.snapshots.get(snapshotKey);
  }

  const currentContent = fs.readFileSync(absoluteFilePath, 'utf8');
  if (!currentContent) {
    return '';
  }

  const historyPath = getDurableHistoryPath(label, context);
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, currentContent, 'utf8');
  if (context.snapshots) {
    context.snapshots.set(snapshotKey, historyPath);
  }
  return historyPath;
}

function getDurableFileTarget(kind = '', context = {}) {
  if (kind === 'agent-notes') {
    const helpers = context.agentNotesHelpers || getDefaultAgentNotesHelpers();
    return {
      label: 'agent-notes.md',
      defaultHeading: '## Learned Carryover',
      characterLimit: helpers.AGENT_NOTES_CHAR_LIMIT,
      getFilePath: () => helpers.getAgentNotesFilePath?.() || helpers.getEffectiveAgentNotesConfig().absoluteFilePath,
      read: () => helpers.getEffectiveAgentNotesConfig().content,
      validate: (content) => helpers.validateAgentNotesContent(content),
      write: (content) => helpers.writeAgentNotesFile(content),
    };
  }

  if (kind === 'soul') {
    const helpers = context.soulHelpers || getDefaultSoulHelpers();
    return {
      label: 'soul.md',
      defaultHeading: '## Growth Notes',
      characterLimit: helpers.SOUL_CHAR_LIMIT,
      getFilePath: () => helpers.getSoulFilePath?.() || helpers.getEffectiveSoulConfig().absoluteFilePath,
      read: () => helpers.getEffectiveSoulConfig().content,
      validate: (content) => helpers.validateSoulContent(content),
      write: (content) => helpers.writeSoulFile(content),
    };
  }

  if (kind === 'user-profile') {
    const helpers = context.userProfileHelpers || getDefaultUserProfileHelpers();
    return {
      label: 'user.md',
      defaultHeading: '## Learned With Phil',
      characterLimit: helpers.USER_PROFILE_CHAR_LIMIT,
      getFilePath: () => helpers.getUserProfileFilePath?.() || helpers.getEffectiveUserProfileConfig().absoluteFilePath,
      read: () => helpers.getEffectiveUserProfileConfig().content,
      validate: (content) => helpers.validateUserProfileContent(content),
      write: (content) => helpers.writeUserProfileFile(content),
    };
  }

  const error = new Error(`Unsupported durable reflection target: ${kind || '(missing)'}`);
  error.statusCode = 400;
  throw error;
}

function hasMarkdownHeading(content = '', heading = '') {
  const expected = String(heading || '').trim();
  if (!expected) {
    return false;
  }
  return String(content || '').split(/\r?\n/).some((line) => line.trim() === expected);
}

function buildAppendContent(existingContent = '', addition = '', heading = '') {
  const existing = normalizeDurableMarkdown(existingContent);
  const block = normalizeDurableMarkdown(addition).trim();
  if (!block) {
    const error = new Error('durable append requires non-empty content.');
    error.statusCode = 400;
    throw error;
  }

  if (existing.includes(block)) {
    return {
      changed: false,
      content: existing,
    };
  }

  const shouldAddHeading = Boolean(heading)
    && !block.startsWith('#')
    && !hasMarkdownHeading(existing, heading);
  const nextParts = [existing.trimEnd()].filter(Boolean);
  if (shouldAddHeading) {
    nextParts.push(String(heading || '').trim());
  }
  nextParts.push(block);

  return {
    changed: true,
    content: normalizeDurableMarkdown(nextParts.join('\n\n')),
  };
}

function getCompactedAppendContent(action = {}) {
  return String(
    action.compactedContent
    || action.compacted_content
    || action.compacted
    || action.replacementContent
    || action.replacement_content
    || '',
  );
}

function isDurableLimitError(error = {}) {
  const code = String(error?.code || '');
  return code.endsWith('_LIMIT_EXCEEDED')
    || Number.isFinite(Number(error?.details?.limit));
}

function createCompactionRequiredError(target = {}, attemptedCharacters = 0) {
  const error = new Error(`${target.label} append would exceed ${target.characterLimit} characters; provide compactedContent with the full compacted file content including the new lesson.`);
  error.code = 'DURABLE_COMPACTION_REQUIRED';
  error.statusCode = 400;
  error.details = {
    target: target.label,
    limit: target.characterLimit,
    attemptedCharacters,
    compactedContentField: 'compactedContent',
  };
  return error;
}

function buildPatchedContent(existingContent = '', action = {}, label = 'durable file') {
  const oldText = String(action.oldText || action.old_string || action.find || '');
  const newText = String(action.newText || action.new_string || action.replace || '');
  if (!oldText) {
    const error = new Error(`${label} patch requires oldText.`);
    error.statusCode = 400;
    throw error;
  }

  const existing = normalizeDurableMarkdown(existingContent);
  const occurrences = countOccurrences(existing, oldText);
  if (occurrences !== 1) {
    const error = new Error(`${label} patch oldText must match exactly once; matched ${occurrences}.`);
    error.statusCode = 400;
    throw error;
  }

  return normalizeDurableMarkdown(existing.replace(oldText, newText));
}

function applyDurableAppend(action = {}, context = {}, kind = '') {
  const content = String(action.content || action.notes || action.body || '');
  if (!content.trim()) {
    const error = new Error('durable append requires non-empty content.');
    error.statusCode = 400;
    throw error;
  }

  const target = getDurableFileTarget(kind, context);
  assertNoBlockedDurableContent(content, target.label);
  const currentContent = target.read();
  const heading = String(action.heading || action.section || target.defaultHeading || '').trim();
  const next = buildAppendContent(currentContent, content, heading);
  let normalized;
  let operation = 'append';
  let attemptedCharacters = next.content.length;
  let compactedCharacters = 0;

  try {
    normalized = target.validate(next.content);
  } catch (error) {
    if (!isDurableLimitError(error)) {
      throw error;
    }

    const compactedContent = getCompactedAppendContent(action);
    if (!compactedContent.trim()) {
      throw createCompactionRequiredError(target, attemptedCharacters);
    }

    assertNoBlockedDurableContent(compactedContent, target.label);
    normalized = target.validate(compactedContent);
    operation = 'compact-append';
    compactedCharacters = normalized.length;
  }

  if (context.dryRun) {
    return {
      type: action.type,
      status: next.changed ? 'validated' : 'unchanged',
      operation,
      target: target.label,
      reason: action.reason,
      characters: normalized.length,
      characterLimit: target.characterLimit,
      attemptedCharacters,
      compactedCharacters,
    };
  }

  if (!next.changed) {
    return {
      type: action.type,
      status: 'unchanged',
      operation,
      target: target.label,
      reason: action.reason,
      characters: normalized.length,
      characterLimit: target.characterLimit,
      attemptedCharacters,
      compactedCharacters,
    };
  }

  const backupPath = saveDurableFileSnapshot(target.getFilePath(), target.label, context);
  const saved = target.write(normalized);
  return {
    type: action.type,
    status: 'applied',
    operation,
    target: saved.filePath,
    reason: action.reason,
    characters: saved.characterCount || normalized.length,
    characterLimit: saved.characterLimit || target.characterLimit,
    updatedAt: saved.updatedAt,
    backupPath,
    attemptedCharacters,
    compactedCharacters,
  };
}

function applyDurablePatch(action = {}, context = {}, kind = '') {
  const target = getDurableFileTarget(kind, context);
  const currentContent = target.read();
  const normalized = target.validate(buildPatchedContent(currentContent, action, target.label));
  assertNoBlockedDurableContent(normalized, target.label);

  if (context.dryRun) {
    return {
      type: action.type,
      status: 'validated',
      operation: 'patch',
      target: target.label,
      reason: action.reason,
      characters: normalized.length,
      characterLimit: target.characterLimit,
      replacements: 1,
    };
  }

  const backupPath = saveDurableFileSnapshot(target.getFilePath(), target.label, context);
  const saved = target.write(normalized);
  return {
    type: action.type,
    status: 'applied',
    operation: 'patch',
    target: saved.filePath,
    reason: action.reason,
    characters: saved.characterCount || normalized.length,
    characterLimit: saved.characterLimit || target.characterLimit,
    updatedAt: saved.updatedAt,
    replacements: 1,
    backupPath,
  };
}

function appendReflectionLog(entry = {}) {
  const logPath = getLogFilePath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  return logPath;
}

function parseUpdateLimit(value = 50) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 50;
  }
  return Math.max(1, Math.min(Math.floor(parsed), 200));
}

function readSelfReflectionUpdates(options = {}) {
  const limit = parseUpdateLimit(options.limit);
  const logPath = options.logPath
    ? (path.isAbsolute(options.logPath) ? options.logPath : path.resolve(PROJECT_ROOT, options.logPath))
    : getLogFilePath();

  const meta = {
    logPath,
    limit,
    count: 0,
    returned: 0,
    parseErrors: 0,
  };

  if (!fs.existsSync(logPath)) {
    return { updates: [], meta };
  }

  const updates = [];
  const lines = fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim());

  lines.forEach((line) => {
    try {
      updates.push(JSON.parse(line));
    } catch (_error) {
      meta.parseErrors += 1;
    }
  });

  const ordered = updates.reverse();
  const sliced = ordered.slice(0, limit);
  meta.count = updates.length;
  meta.returned = sliced.length;

  return {
    updates: sliced,
    meta,
  };
}

function buildLogEntry(input = {}, result = {}) {
  return {
    id: result.id,
    timestamp: result.updatedAt,
    dryRun: result.dryRun,
    source: normalizeText(input.source || 'runtime'),
    trigger: normalizeText(input.trigger || input.reason || ''),
    reflection: normalizeText(input.reflection || input.summary || ''),
    modelCardNote: result.modelCardNote || '',
    actions: result.actions.map((action) => ({
      type: action.type,
      status: action.status,
      target: action.target || '',
      reason: action.reason || '',
      message: action.message || '',
    })),
  };
}

function applyNotesReplace(action = {}, context = {}) {
  const content = String(action.content || action.notes || action.body || '');
  if (!content.trim()) {
    const error = new Error('agent notes replacement requires non-empty content.');
    error.statusCode = 400;
    throw error;
  }

  assertNoBlockedDurableContent(content, 'agent notes');
  const helpers = context.agentNotesHelpers || getDefaultAgentNotesHelpers();
  const normalized = helpers.validateAgentNotesContent(content);

  if (context.dryRun) {
    return {
      type: action.type,
      status: 'validated',
      target: 'agent-notes.md',
      reason: action.reason,
      characters: normalized.length,
      characterLimit: helpers.AGENT_NOTES_CHAR_LIMIT,
    };
  }

  const backupPath = saveDurableFileSnapshot(helpers.getAgentNotesFilePath?.(), 'agent-notes.md', context);
  const saved = helpers.writeAgentNotesFile(normalized);
  return {
    type: action.type,
    status: 'applied',
    target: saved.filePath,
    reason: action.reason,
    characters: saved.characterCount,
    characterLimit: saved.characterLimit,
    updatedAt: saved.updatedAt,
    backupPath,
  };
}

function applySoulReplace(action = {}, context = {}) {
  const content = String(action.content || action.notes || action.body || '');
  if (!content.trim()) {
    const error = new Error('soul replacement requires non-empty content.');
    error.statusCode = 400;
    throw error;
  }

  assertNoBlockedDurableContent(content, 'soul');
  const helpers = context.soulHelpers || getDefaultSoulHelpers();
  const normalized = helpers.validateSoulContent(content);

  if (context.dryRun) {
    return {
      type: action.type,
      status: 'validated',
      target: 'soul.md',
      reason: action.reason,
      characters: normalized.length,
      characterLimit: helpers.SOUL_CHAR_LIMIT,
    };
  }

  const backupPath = saveDurableFileSnapshot(helpers.getSoulFilePath?.(), 'soul.md', context);
  const saved = helpers.writeSoulFile(normalized);
  return {
    type: action.type,
    status: 'applied',
    target: saved.filePath,
    reason: action.reason,
    characters: saved.characterCount || normalized.length,
    characterLimit: saved.characterLimit || helpers.SOUL_CHAR_LIMIT,
    updatedAt: saved.updatedAt,
    backupPath,
  };
}

function applyUserProfileReplace(action = {}, context = {}) {
  const content = String(action.content || action.notes || action.body || '');
  if (!content.trim()) {
    const error = new Error('user profile replacement requires non-empty content.');
    error.statusCode = 400;
    throw error;
  }

  assertNoBlockedDurableContent(content, 'user profile');
  const helpers = context.userProfileHelpers || getDefaultUserProfileHelpers();
  const normalized = helpers.validateUserProfileContent(content);

  if (context.dryRun) {
    return {
      type: action.type,
      status: 'validated',
      target: 'user.md',
      reason: action.reason,
      characters: normalized.length,
      characterLimit: helpers.USER_PROFILE_CHAR_LIMIT,
    };
  }

  const backupPath = saveDurableFileSnapshot(helpers.getUserProfileFilePath?.(), 'user.md', context);
  const saved = helpers.writeUserProfileFile(normalized);
  return {
    type: action.type,
    status: 'applied',
    target: saved.filePath,
    reason: action.reason,
    characters: saved.characterCount,
    characterLimit: saved.characterLimit,
    updatedAt: saved.updatedAt,
    backupPath,
  };
}

function applySkillCreate(action = {}, context = {}) {
  const skillStore = context.skillStore || getDefaultSkillStore();
  const payload = normalizeSkillPayload(action);
  assertNoBlockedDurableContent(JSON.stringify(payload), 'skill');

  if (context.dryRun) {
    const manifest = skillStore.buildManifest(payload, null);
    const existing = skillStore.readSkill(manifest.id, { includeBody: true });
    if (existing) {
      const error = new Error(`Skill already exists: ${manifest.id}`);
      error.statusCode = 409;
      throw error;
    }
    return {
      type: action.type,
      status: 'validated',
      target: manifest.id,
      reason: action.reason,
    };
  }

  const skill = skillStore.upsertSkill(payload, { createOnly: true });
  return {
    type: action.type,
    status: 'applied',
    target: skill.id,
    reason: action.reason,
    skill: {
      id: skill.id,
      name: skill.name,
      bodyPath: skill.bodyPath,
    },
  };
}

function applySkillUpdate(action = {}, context = {}) {
  const skillStore = context.skillStore || getDefaultSkillStore();
  const skillId = action.id || action.skillId || context.targetSkillId;
  const existing = skillStore.readSkill(skillId || '', { includeBody: true });
  if (!existing) {
    const error = new Error(`Skill not found: ${skillId || '(missing id)'}`);
    error.statusCode = 404;
    throw error;
  }

  const payload = normalizeSkillPayload({
    ...action,
    id: existing.id,
  }, existing);
  assertNoBlockedDurableContent(JSON.stringify(payload), 'skill');

  if (context.dryRun) {
    skillStore.buildManifest(payload, existing);
    return {
      type: action.type,
      status: 'validated',
      target: existing.id,
      reason: action.reason,
    };
  }

  const skill = skillStore.upsertSkill(payload, { updateOnly: true });
  return {
    type: action.type,
    status: 'applied',
    target: skill.id,
    reason: action.reason,
    skill: {
      id: skill.id,
      name: skill.name,
      bodyPath: skill.bodyPath,
    },
  };
}

function applySkillPatch(action = {}, context = {}) {
  const skillStore = context.skillStore || getDefaultSkillStore();
  const skillId = action.id || action.skillId || context.targetSkillId;
  const existing = skillStore.readSkill(skillId || '', { includeBody: true });
  if (!existing) {
    const error = new Error(`Skill not found: ${skillId || '(missing id)'}`);
    error.statusCode = 404;
    throw error;
  }

  const oldText = String(action.oldText || action.old_string || action.find || '');
  const newText = String(action.newText || action.new_string || action.replace || '');
  if (!oldText) {
    const error = new Error('skill_patch requires oldText.');
    error.statusCode = 400;
    throw error;
  }
  const occurrences = countOccurrences(existing.body || '', oldText);
  if (occurrences !== 1) {
    const error = new Error(`skill_patch oldText must match exactly once in ${existing.id}; matched ${occurrences}.`);
    error.statusCode = 400;
    throw error;
  }

  assertNoBlockedDurableContent(newText, 'skill patch');
  const body = String(existing.body || '').replace(oldText, newText);
  const payload = normalizeSkillPayload({ ...existing, body }, existing);

  if (context.dryRun) {
    return {
      type: action.type,
      status: 'validated',
      target: existing.id,
      reason: action.reason,
      replacements: 1,
    };
  }

  const skill = skillStore.upsertSkill(payload, { updateOnly: true });
  return {
    type: action.type,
    status: 'applied',
    target: skill.id,
    reason: action.reason,
    replacements: 1,
    skill: {
      id: skill.id,
      name: skill.name,
      bodyPath: skill.bodyPath,
    },
  };
}

function applyModelCardNote(action = {}, context = {}) {
  const note = normalizeText(action.content || action.note || action.body || '');
  if (!note) {
    const error = new Error('model_card_note requires content.');
    error.statusCode = 400;
    throw error;
  }
  if (note.length > SELF_REFLECTION_MODEL_CARD_NOTE_LIMIT) {
    const error = new Error(`model_card_note cannot exceed ${SELF_REFLECTION_MODEL_CARD_NOTE_LIMIT} characters.`);
    error.statusCode = 400;
    throw error;
  }
  assertNoBlockedDurableContent(note, 'model card note');

  context.modelCardNotes.push(note);
  return {
    type: action.type,
    status: context.dryRun ? 'validated' : 'recorded',
    target: 'model-card',
    reason: action.reason,
    characters: note.length,
  };
}

function applySelfReflectionAction(action = {}, context = {}) {
  switch (action.type) {
  case 'agent_notes_replace':
  case 'carryover_notes_replace':
    return applyNotesReplace(action, context);
  case 'agent_notes_append':
  case 'carryover_notes_append':
    return applyDurableAppend(action, context, 'agent-notes');
  case 'agent_notes_patch':
  case 'carryover_notes_patch':
    return applyDurablePatch(action, context, 'agent-notes');
  case 'soul_replace':
  case 'agent_soul_replace':
  case 'personality_replace':
    return applySoulReplace(action, context);
  case 'soul_append':
  case 'agent_soul_append':
  case 'personality_append':
    return applyDurableAppend(action, context, 'soul');
  case 'soul_patch':
  case 'agent_soul_patch':
  case 'personality_patch':
    return applyDurablePatch(action, context, 'soul');
  case 'user_notes_replace':
  case 'user_profile_replace':
  case 'user_md_replace':
    return applyUserProfileReplace(action, context);
  case 'user_notes_append':
  case 'user_profile_append':
  case 'user_md_append':
    return applyDurableAppend(action, context, 'user-profile');
  case 'user_notes_patch':
  case 'user_profile_patch':
  case 'user_md_patch':
    return applyDurablePatch(action, context, 'user-profile');
  case 'skill_create':
    return applySkillCreate(action, context);
  case 'skill_update':
  case 'skill_edit':
    return applySkillUpdate(action, context);
  case 'skill_patch':
    return applySkillPatch(action, context);
  case 'model_card_note':
    return applyModelCardNote(action, context);
  default: {
    const error = new Error(`Unsupported self-reflection action type: ${action.type || '(missing)'}`);
    error.statusCode = 400;
    throw error;
  }
  }
}

function applySelfReflectionUpdate(input = {}, options = {}) {
  assertReflectionEnvelope(input);
  const dryRun = input.dryRun === true || input.apply === false;
  const actions = normalizeActionList(input);
  const result = {
    id: `self-reflection-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    updatedAt: new Date().toISOString(),
    dryRun,
    applied: false,
    actions: [],
    modelCardNote: '',
    logPath: null,
  };

  if (actions.length === 0) {
    result.message = 'No self-reflection actions were requested.';
    return result;
  }

  const baseContext = {
    updateId: result.id,
    targetSkillId: normalizeText(input.targetSkillId || input.skillId),
    skillStore: options.skillStore,
    agentNotesHelpers: options.agentNotesHelpers,
    soulHelpers: options.soulHelpers,
    userProfileHelpers: options.userProfileHelpers,
  };
  const validationContext = {
    ...baseContext,
    dryRun: true,
    modelCardNotes: [],
  };

  const validatedActions = actions.map((action) => applySelfReflectionAction(action, validationContext));

  if (dryRun) {
    result.actions = validatedActions;
    result.modelCardNote = validationContext.modelCardNotes.join('\n');
    return result;
  }

  const context = {
    ...baseContext,
    dryRun: false,
    modelCardNotes: [],
    snapshots: new Map(),
  };

  result.actions = actions.map((action) => applySelfReflectionAction(action, context));
  result.applied = !dryRun && result.actions.some((action) => ['applied', 'recorded'].includes(action.status));
  result.modelCardNote = context.modelCardNotes.join('\n');

  if (!dryRun && options.writeLog !== false) {
    result.logPath = appendReflectionLog(buildLogEntry(input, result));
  }

  return result;
}

module.exports = {
  SELF_REFLECTION_MODEL_CARD_NOTE_LIMIT,
  SELF_REFLECTION_UPDATE_ACTION_LIMIT,
  SELF_REFLECTION_UPDATE_TOOL_ID,
  applySelfReflectionUpdate,
  assertNoBlockedDurableContent,
  getLogFilePath,
  readSelfReflectionUpdates,
};
