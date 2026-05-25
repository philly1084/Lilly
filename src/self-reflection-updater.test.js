const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  applySelfReflectionUpdate,
  readSelfReflectionUpdates,
} = require('./self-reflection-updater');
const { SkillStore } = require('./skills/skill-store');

describe('self-reflection updater', () => {
  let tempDir;
  let notesPath;
  let soulPath;
  let userPath;
  let logPath;
  let originalNotesPath;
  let originalSoulPath;
  let originalUserPath;
  let originalLogPath;
  let skillStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimibuilt-self-reflection-'));
    notesPath = path.join(tempDir, 'agent-notes.md');
    soulPath = path.join(tempDir, 'soul.md');
    userPath = path.join(tempDir, 'user.md');
    logPath = path.join(tempDir, 'updates.jsonl');
    originalNotesPath = process.env.KIMIBUILT_AGENT_NOTES_PATH;
    originalSoulPath = process.env.KIMIBUILT_SOUL_PATH;
    originalUserPath = process.env.KIMIBUILT_USER_PROFILE_PATH;
    originalLogPath = process.env.KIMIBUILT_SELF_REFLECTION_LOG_PATH;
    process.env.KIMIBUILT_AGENT_NOTES_PATH = notesPath;
    process.env.KIMIBUILT_SOUL_PATH = soulPath;
    process.env.KIMIBUILT_USER_PROFILE_PATH = userPath;
    process.env.KIMIBUILT_SELF_REFLECTION_LOG_PATH = logPath;
    skillStore = new SkillStore({
      rootDir: path.join(tempDir, 'skills'),
    });
  });

  afterEach(() => {
    if (originalNotesPath === undefined) {
      delete process.env.KIMIBUILT_AGENT_NOTES_PATH;
    } else {
      process.env.KIMIBUILT_AGENT_NOTES_PATH = originalNotesPath;
    }
    if (originalLogPath === undefined) {
      delete process.env.KIMIBUILT_SELF_REFLECTION_LOG_PATH;
    } else {
      process.env.KIMIBUILT_SELF_REFLECTION_LOG_PATH = originalLogPath;
    }
    if (originalSoulPath === undefined) {
      delete process.env.KIMIBUILT_SOUL_PATH;
    } else {
      process.env.KIMIBUILT_SOUL_PATH = originalSoulPath;
    }
    if (originalUserPath === undefined) {
      delete process.env.KIMIBUILT_USER_PROFILE_PATH;
    } else {
      process.env.KIMIBUILT_USER_PROFILE_PATH = originalUserPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('applies carryover notes, exact skill patch, and model-card audit note', () => {
    skillStore.upsertSkill({
      id: 'recursive-learning',
      name: 'Recursive Learning',
      description: 'Keep recursive learning bounded.',
      body: 'Use old behavior.\nKeep updates small.\n',
      tools: ['agent-notes-write'],
      triggerPatterns: ['recursive learning'],
    }, { createOnly: true });

    const result = applySelfReflectionUpdate({
      source: 'user_turn',
      trigger: 'User asked for Hermes-style recursive updates.',
      reflection: 'This should become a bounded durable update path.',
      targetSkillId: 'recursive-learning',
      actions: [
        {
          type: 'agent_notes_replace',
          reason: 'Stable preference about recursive learning.',
          content: '# Carryover Notes\n\n## Phil\n- Wants bounded self-reflection updates to carry useful workflow lessons into future notes and skills.\n',
        },
        {
          type: 'skill_patch',
          reason: 'The skill needs the new bounded reflection behavior.',
          oldText: 'Use old behavior.',
          newText: 'Use bounded self-reflection updates only when durable notes or skill guidance should improve future work.',
        },
        {
          type: 'model_card_note',
          reason: 'Audit the improvement.',
          content: 'Added a bounded self-reflection path that updates carryover notes and registered skills together.',
        },
      ],
    }, {
      skillStore,
    });

    expect(result.applied).toBe(true);
    expect(result.modelCardNote).toContain('bounded self-reflection path');
    expect(fs.readFileSync(notesPath, 'utf8')).toContain('bounded self-reflection updates');
    expect(skillStore.readSkill('recursive-learning', { includeBody: true }).body).toContain('future work');
    expect(fs.readFileSync(logPath, 'utf8')).toContain('"modelCardNote"');
  });

  test('dry run validates without writing notes, skills, or audit logs', () => {
    skillStore.upsertSkill({
      id: 'reflection-dry-run',
      name: 'Reflection Dry Run',
      description: 'Validate before applying.',
      body: 'Original guidance.\n',
    }, { createOnly: true });

    const result = applySelfReflectionUpdate({
      source: 'model_card',
      dryRun: true,
      reflection: 'Check the proposed update.',
      targetSkillId: 'reflection-dry-run',
      actions: [
        {
          type: 'skill_patch',
          oldText: 'Original guidance.',
          newText: 'Updated guidance.',
        },
      ],
    }, {
      skillStore,
    });

    expect(result.applied).toBe(false);
    expect(result.actions[0].status).toBe('validated');
    expect(skillStore.readSkill('reflection-dry-run', { includeBody: true }).body).toContain('Original guidance');
    expect(fs.existsSync(logPath)).toBe(false);
  });

  test('validates every action before writing durable files', () => {
    expect(() => applySelfReflectionUpdate({
      source: 'user_turn',
      reflection: 'One valid action followed by an invalid skill patch must not partially apply.',
      actions: [
        {
          type: 'agent_notes_replace',
          reason: 'This would write if the batch were not validated first.',
          content: '# Carryover Notes\n\n## Phil\n- This should not be written when a later action fails.\n',
        },
        {
          type: 'skill_patch',
          skillId: 'missing-skill',
          oldText: 'Original guidance.',
          newText: 'Updated guidance.',
        },
      ],
    }, {
      skillStore,
    })).toThrow(/Skill not found/);

    expect(fs.existsSync(notesPath)).toBe(false);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  test('applies Hermes soul and user profile replacements', () => {
    const result = applySelfReflectionUpdate({
      source: 'user_requested',
      trigger: 'User asked to go full Hermes.',
      reflection: 'The durable profile should split agent identity from user profile memory.',
      actions: [
        {
          type: 'soul_replace',
          reason: 'Bound the assistant identity file.',
          content: '# Soul\n\n- Stay warm, grounded, and useful.\n',
        },
        {
          type: 'user_profile_replace',
          reason: 'Bound the user profile file.',
          content: '# User\n\n## Phil\n- Wants real verification before final answers.\n',
        },
      ],
    }, {
      skillStore,
    });

    expect(result.applied).toBe(true);
    expect(result.actions[0].target).toContain('soul.md');
    expect(result.actions[1].target).toContain('user.md');
    expect(fs.readFileSync(soulPath, 'utf8')).toContain('Stay warm');
    expect(fs.readFileSync(userPath, 'utf8')).toContain('real verification');
    expect(fs.readFileSync(logPath, 'utf8')).toContain('user_profile_replace');
  });

  test('appends and patches durable Hermes files without clobbering existing content', () => {
    fs.writeFileSync(soulPath, '# Soul\n\n## Behavior\n- Stay grounded.\n', 'utf8');
    fs.writeFileSync(userPath, '# User\n\n## Phil\n- Likes proof.\n', 'utf8');

    const result = applySelfReflectionUpdate({
      source: 'user_requested',
      trigger: 'User said the soul and user files are not growing.',
      reflection: 'Growth requests should preserve existing durable profile content while adding stable lessons.',
      actions: [
        {
          type: 'soul_append',
          reason: 'Add durable growth behavior without rewriting the whole soul file.',
          content: '- Treat explicit growth requests as permission to update bounded durable memory while preserving existing content.',
        },
        {
          type: 'user_profile_append',
          reason: 'Record the stable user preference for additive durable learning.',
          heading: '## Collaboration Defaults',
          content: '- Wants the agent to grow with the working relationship through safe additive updates.',
        },
        {
          type: 'user_profile_patch',
          reason: 'Make the existing proof preference more concrete.',
          oldText: '- Likes proof.',
          newText: '- Likes concrete proof before reassurance.',
        },
      ],
    }, {
      skillStore,
    });

    const updatedSoul = fs.readFileSync(soulPath, 'utf8');
    const updatedUser = fs.readFileSync(userPath, 'utf8');

    expect(result.applied).toBe(true);
    expect(updatedSoul).toContain('## Behavior');
    expect(updatedSoul).toContain('## Growth Notes');
    expect(updatedSoul).toContain('explicit growth requests');
    expect(updatedUser).toContain('## Phil');
    expect(updatedUser).toContain('concrete proof before reassurance');
    expect(updatedUser).toContain('safe additive updates');
    expect(result.actions[0].backupPath).toContain('history');
    expect(fs.readFileSync(result.actions[0].backupPath, 'utf8')).toContain('- Stay grounded.');
    expect(result.actions[1].backupPath).toBe(result.actions[2].backupPath);
    expect(fs.readFileSync(result.actions[1].backupPath, 'utf8')).toContain('- Likes proof.');
  });

  test('requires compacted content when a durable append exceeds the file limit', () => {
    const userProfile = require('./agent-user-profile');
    const prefix = '# User\n\n## Phil\n- ';
    const suffix = '\n';
    const fillerLength = userProfile.USER_PROFILE_CHAR_LIMIT - prefix.length - suffix.length - 4;
    fs.writeFileSync(userPath, `${prefix}${'x'.repeat(fillerLength)}${suffix}`, 'utf8');

    expect(() => applySelfReflectionUpdate({
      source: 'user_requested',
      trigger: 'User asked the agent to grow with them.',
      reflection: 'The user profile is near its limit, so appending requires compaction.',
      actions: [{
        type: 'user_profile_append',
        reason: 'Durable lesson needs to be preserved without overflow.',
        content: '- Durable lesson: compact old profile facts when adding stable new growth preferences.\n',
      }],
    }, {
      skillStore,
    })).toThrow(/provide compactedContent/);

    const result = applySelfReflectionUpdate({
      source: 'user_requested',
      trigger: 'User asked the agent to grow with them.',
      reflection: 'The user profile is near its limit, so append with compaction.',
      actions: [{
        type: 'user_profile_append',
        reason: 'Durable lesson needs to be preserved without overflow.',
        content: '- Durable lesson: compact old profile facts when adding stable new growth preferences.\n',
        compactedContent: '# User\n\n## Phil\n- Durable lesson: compact old profile facts when adding stable new growth preferences while preserving essentials.\n',
      }],
    }, {
      skillStore,
    });

    expect(result.actions[0]).toEqual(expect.objectContaining({
      status: 'applied',
      operation: 'compact-append',
      characterLimit: userProfile.USER_PROFILE_CHAR_LIMIT,
    }));
    expect(result.actions[0].attemptedCharacters).toBeGreaterThan(userProfile.USER_PROFILE_CHAR_LIMIT);
    expect(result.actions[0].compactedCharacters).toBeLessThan(userProfile.USER_PROFILE_CHAR_LIMIT);
    expect(fs.readFileSync(userPath, 'utf8')).toContain('compact old profile facts');
    expect(fs.readFileSync(result.actions[0].backupPath, 'utf8')).toContain('xxx');
  });

  test('reads audit updates newest first with bounded limits', () => {
    applySelfReflectionUpdate({
      source: 'model_card',
      trigger: 'first durable lesson',
      actions: [
        { type: 'model_card_note', content: 'First bounded self-reflection note.' },
      ],
    }, {
      skillStore,
    });
    fs.appendFileSync(logPath, '{bad-json\n', 'utf8');
    applySelfReflectionUpdate({
      source: 'model_card',
      trigger: 'second durable lesson',
      actions: [
        { type: 'model_card_note', content: 'Second bounded self-reflection note.' },
      ],
    }, {
      skillStore,
    });

    const result = readSelfReflectionUpdates({ limit: 1 });

    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].modelCardNote).toBe('Second bounded self-reflection note.');
    expect(result.meta.count).toBe(2);
    expect(result.meta.returned).toBe(1);
    expect(result.meta.parseErrors).toBe(1);
  });

  test('rejects nested recursive reflection calls', () => {
    expect(() => applySelfReflectionUpdate({
      source: 'self_reflection_update',
      recursionDepth: 1,
      actions: [
        { type: 'model_card_note', content: 'Should not apply.' },
      ],
    }, {
      skillStore,
    })).toThrow(/nested or recursive reflection calls/);
  });

  test('rejects blocked durable content in notes and skills', () => {
    expect(() => applySelfReflectionUpdate({
      source: 'user_turn',
      actions: [
        {
          type: 'agent_notes_replace',
          content: '# Carryover Notes\n\napi_key=abcdefghijklmnopqrstuvwxyz123456\n',
        },
      ],
    }, {
      skillStore,
    })).toThrow(/not allowed in durable self-reflection updates/);
  });
});
