jest.mock('../../artifacts/artifact-service', () => ({
  artifactService: {
    createStoredArtifact: jest.fn(),
    deleteArtifact: jest.fn(),
    generateArtifact: jest.fn(),
    serializeArtifact: jest.fn(),
  },
}));

jest.mock('../../asset-manager', () => ({
  assetManager: {
    searchAssets: jest.fn(),
    upsertWorkspacePath: jest.fn(async () => null),
  },
}));

jest.mock('../../research-buckets', () => ({
  researchBucketService: {
    list: jest.fn(),
    search: jest.fn(),
    read: jest.fn(),
    write: jest.fn(),
    mkdir: jest.fn(),
  },
}));

jest.mock('../../public-source-index', () => ({
  SOURCE_KINDS: [
    'public_api',
    'dashboard',
    'news_feed',
    'rss_feed',
    'data_portal',
    'open_data',
    'download',
    'web_page',
  ],
  STATUSES: [
    'candidate',
    'verified',
    'stale',
    'broken',
    'blocked',
    'retired',
  ],
  publicSourceIndexService: {
    list: jest.fn(),
    search: jest.fn(),
    get: jest.fn(),
    upsert: jest.fn(),
    refresh: jest.fn(),
  },
}));

jest.mock('../../tts/tts-service', () => ({
  ttsService: {
    synthesize: jest.fn(),
    getPublicConfig: jest.fn(() => ({
      configured: true,
      provider: 'kokoro',
      maxTextChars: 2400,
      defaultVoiceId: 'af_heart',
      voices: [{
        id: 'af_heart',
        label: 'Heart Studio',
        provider: 'kokoro',
      }],
    })),
  },
}));

jest.mock('../../generated-audio-artifacts', () => ({
  persistGeneratedAudio: jest.fn(),
}));

const { ToolManager } = require('./index');
const { artifactService } = require('../../artifacts/artifact-service');
const { assetManager } = require('../../asset-manager');
const { researchBucketService } = require('../../research-buckets');
const { publicSourceIndexService } = require('../../public-source-index');
const config = require('../../config');
const { ttsService } = require('../../tts/tts-service');
const { persistGeneratedAudio } = require('../../generated-audio-artifacts');
const { AgentRunService } = require('../../agent-runs');
const { AsyncLabStore } = require('../../async-lab/store');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

describe('ToolManager image tools', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    artifactService.createStoredArtifact.mockReset();
    artifactService.deleteArtifact.mockReset();
    artifactService.generateArtifact.mockReset();
    artifactService.serializeArtifact.mockReset();
    assetManager.searchAssets.mockReset();
    assetManager.upsertWorkspacePath.mockClear();
    researchBucketService.list.mockReset();
    researchBucketService.search.mockReset();
    researchBucketService.read.mockReset();
    researchBucketService.write.mockReset();
    researchBucketService.mkdir.mockReset();
    publicSourceIndexService.list.mockReset();
    publicSourceIndexService.search.mockReset();
    publicSourceIndexService.get.mockReset();
    publicSourceIndexService.upsert.mockReset();
    publicSourceIndexService.refresh.mockReset();
    ttsService.synthesize.mockReset();
    persistGeneratedAudio.mockReset();
    artifactService.createStoredArtifact.mockResolvedValue({
      id: 'artifact-file-write-1',
      sessionId: 'session-1',
      filename: 'sample.html',
      extension: 'html',
      mimeType: 'text/html',
      sizeBytes: 57,
      previewHtml: '<!DOCTYPE html><html><body><h1>Hello</h1></body></html>',
      metadata: {},
    });
    artifactService.deleteArtifact.mockResolvedValue(true);
    artifactService.serializeArtifact.mockReturnValue({
      id: 'artifact-file-write-1',
      filename: 'sample.html',
      format: 'html',
      mimeType: 'text/html',
      sizeBytes: 57,
      downloadUrl: '/api/artifacts/artifact-file-write-1/download',
      previewUrl: '/api/artifacts/artifact-file-write-1/preview',
      preview: {
        type: 'html',
        content: '<!DOCTYPE html><html><body><h1>Hello</h1></body></html>',
      },
      metadata: {},
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('registers restricted git and k3s deploy tools', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    expect(toolManager.getTool('git-safe')).toBeTruthy();
    expect(toolManager.getTool('k3s-deploy')).toBeTruthy();
    expect(toolManager.getTool('managed-app')).toBeTruthy();
    expect(toolManager.getTool('opencode-run')).toBeFalsy();
    expect(toolManager.getTool('agent-delegate')).toBeTruthy();
    expect(toolManager.getTool('self-reflection-update')).toBeTruthy();
    expect(toolManager.getTool('podcast')).toBeTruthy();
  });

  test.each(['false', '0', 'no', 'off', 0])(
    'keeps serialized tool failure %p failed across execution handoffs',
    async (success) => {
      const toolId = `serialized-failure-${String(success)}`;
      const toolManager = new ToolManager();
      toolManager.registry.register({
        id: toolId,
        name: 'Serialized failure probe',
        description: 'Returns a compatible serialized failure result',
        category: 'web',
        backend: {
          handler: async () => ({}),
        },
      });
      toolManager.loadedTools.set(toolId, {
        id: toolId,
        category: 'web',
        execute: jest.fn().mockResolvedValue({
          success,
          error: 'Source request was denied',
          duration: 12,
          timestamp: '2026-07-16T12:00:00.000Z',
        }),
      });

      try {
        const result = await toolManager.executeTool(toolId, {}, {});
        const readiness = toolManager.registry.getToolReadiness(toolId);

        expect(result).toEqual(expect.objectContaining({
          success: false,
          failureKind: 'tool_failure',
          verification: {
            status: 'failed',
            evidence: 'Tool returned an error result.',
          },
        }));
        expect(readiness).toEqual(expect.objectContaining({
          reason: 'Last execution failed: Source request was denied',
          lastProbe: expect.objectContaining({
            success: false,
            failureKind: 'tool_failure',
          }),
        }));
      } finally {
        toolManager.loadedTools.delete(toolId);
        toolManager.registry.unregister(toolId);
      }
    },
  );

  test('registers modern agent capability map and gap-covering skills', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    expect(toolManager.getTool('modern-agent-capability-map')).toBeTruthy();

    const result = await toolManager.executeTool('modern-agent-capability-map', {}, {});
    expect(result.success).toBe(true);

    const capabilityIds = result.data.capabilities.map((capability) => capability.id);
    expect(capabilityIds).toEqual(expect.arrayContaining([
      'mcp-connector-bridge',
      'a2a-agent-interoperability',
      'computer-browser-use',
      'agent-trace-eval-replay',
      'daily-work-connectors',
      'native-office-roundtrip',
      'agent-tool-security-governance',
      'skill-authoring-workshop',
    ]));
    expect(result.data.capabilities).toHaveLength(8);
    expect(result.data.capabilities.every((capability) => capability.registered)).toBe(true);
    expect(result.data.capabilities.find((capability) => capability.id === 'native-office-roundtrip').runtimeBoundary)
      .toContain('native DOCX');
  });

  test('skill-context returns structured selected skills for modern agent lanes', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const result = await toolManager.executeTool('skill-context', {
      text: 'connect Lilly to a Model Context Protocol server and then replay the agent trace',
      limit: 4,
    }, {});

    expect(result.success).toBe(true);
    expect(result.data.context).toContain('<registered_skills>');
    expect(result.data.selectedSkills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'mcp-connector-bridge' }),
      expect.objectContaining({ id: 'agent-trace-eval-replay' }),
    ]));
  });

  test('skill-context selects the long-form burst builder workflow', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const result = await toolManager.executeTool('skill-context', {
      text: 'make a researched HTML and PDF book with images using fresh context builders, section agent bursts, a designed index, and master review rebuild passes',
      limit: 3,
    }, {});

    expect(result.success).toBe(true);
    expect(result.data.selectedSkills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'long-form-content-burst-builder' }),
    ]));
    expect(result.data.context).toContain('Use immediate bounded `agent-delegate` bursts');
  });

  test('skill-context selects the skill creator agent workflow', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const prompts = [
      'use a skill creator agent that can chain tools into skills without polluting the requesting chat',
      'build a recursive skill builder that combines tools into reusable long form skills',
    ];

    for (const text of prompts) {
      const result = await toolManager.executeTool('skill-context', {
        text,
        limit: 3,
      }, {});

      expect(result.success).toBe(true);
      expect(result.data.selectedSkills).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'skill-creator-agent' }),
      ]));
      expect(result.data.context).toContain('Use `agent-delegate` with one bounded creator task');
    }
  });

  test('registers remote operation skills with kubectl and k3s trigger coverage', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const remoteSkill = toolManager.registry.getSkill('remote-command');
    const deploySkill = toolManager.registry.getSkill('k3s-deploy');

    expect(remoteSkill.triggerPatterns).toEqual(expect.arrayContaining([
      'remote cli',
      'remote cli runner',
      'direct cli',
      'kubectl',
      'k3s',
      'rancher',
      'journalctl',
      'systemctl',
    ]));
    expect(deploySkill.triggerPatterns).toEqual(expect.arrayContaining([
      'apply manifests',
      'cluster rollout',
    ]));
  });

  test('returns image diagnostics when image generation fetch fails before provider response', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();
    const imageTool = toolManager.getTool('image-generate');
    const fetchError = new Error('fetch failed');
    fetchError.cause = Object.assign(new Error('getaddrinfo ENOTFOUND image-router.local'), {
      code: 'ENOTFOUND',
      hostname: 'image-router.local',
      syscall: 'getaddrinfo',
    });
    imageTool.backend.handler = jest.fn(async () => {
      throw fetchError;
    });

    const result = await toolManager.executeTool('image-generate', {
      prompt: 'A dog playing fetch',
      model: 'gpt-image-2',
      size: '1024x1024',
    }, {
      sessionId: 'session-image-fetch-failed',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('fetch failed');
    expect(result.diagnostics.imageGeneration).toEqual(expect.objectContaining({
      code: 'provider_fetch_failed',
      stage: 'tool_error',
      flags: expect.objectContaining({
        providerResponseReceived: false,
      }),
      error: expect.objectContaining({
        message: 'fetch failed',
        cause: expect.objectContaining({
          code: 'ENOTFOUND',
          hostname: 'image-router.local',
        }),
      }),
    }));
  });

  test('returns image diagnostics when provider reports no parseable image data', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();
    const imageTool = toolManager.getTool('image-generate');
    imageTool.backend.handler = jest.fn(async () => {
      throw new Error('Provider returned no parseable image data');
    });

    const result = await toolManager.executeTool('image-generate', {
      prompt: 'A dog versus a cat',
      model: 'gpt-image-2',
    }, {
      sessionId: 'session-image-not-parseable',
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics.imageGeneration).toEqual(expect.objectContaining({
      code: 'provider_response_not_parsable',
      stage: 'tool_error',
      flags: expect.objectContaining({
        providerResponseReceived: true,
        likelyBackendParserIssue: true,
      }),
      error: expect.objectContaining({
        message: 'Provider returned no parseable image data',
      }),
    }));
  });

  test('registers and executes the curated design resource search tool', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const tool = toolManager.getTool('design-resource-search');
    const skill = toolManager.registry.getSkill('design-resource-search');

    expect(tool).toBeTruthy();
    expect(skill.triggerPatterns).toEqual(expect.arrayContaining([
      'safe design libraries',
      'find backgrounds',
      'find fonts',
    ]));

    const searchResult = await toolManager.executeTool('design-resource-search', {
      query: 'website icons',
      category: 'icons',
    });

    expect(searchResult.success).toBe(true);
    expect(searchResult.data.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'lucide',
        fetchPlan: expect.objectContaining({
          tool: 'web-fetch',
        }),
      }),
    ]));

    const fetchPlan = await toolManager.executeTool('design-resource-search', {
      action: 'fetch_plan',
      resourceId: 'google-fonts',
    });

    expect(fetchPlan.success).toBe(true);
    expect(fetchPlan.data.fetchPlan.params.url).toContain('fonts.googleapis.com');
  });

  test('routes podcast through the injected podcast service', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const service = {
      createPodcast: jest.fn(async () => ({
        title: 'Test podcast',
        audio: { artifactId: 'artifact-podcast-1' },
        script: { turns: [] },
      })),
    };

    const result = await toolManager.executeTool('podcast', {
      topic: 'How batteries work',
      durationMinutes: 10,
    }, {
      sessionId: 'session-1',
      podcastService: service,
      clientSurface: 'chat',
    });

    expect(result.success).toBe(true);
    expect(service.createPodcast).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'How batteries work',
      durationMinutes: 10,
    }), expect.objectContaining({
      sessionId: 'session-1',
      podcastService: service,
    }));
    expect(result.data.audio).toEqual({ artifactId: 'artifact-podcast-1' });
  });

  test('renders podcast video through the injected video service when requested', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const podcastWorkflowService = {
      createPodcast: jest.fn(async () => ({
        title: 'Test podcast',
        audio: { artifactId: 'artifact-podcast-1' },
        artifacts: [{ id: 'artifact-podcast-1', filename: 'test.wav' }],
        script: {
          transcript: 'Maya: Batteries store energy.',
          turns: [{ speaker: 'Maya', text: 'Batteries store energy.' }],
        },
      })),
    };
    const videoWorkflowService = {
      createVideoFromPodcast: jest.fn(async () => ({
        video: { artifactId: 'artifact-video-1' },
        artifact: { id: 'artifact-video-1', filename: 'test.mp4' },
        storyboard: { scenes: [{ id: 'scene-01' }] },
      })),
    };

    const result = await toolManager.executeTool('podcast', {
      topic: 'How batteries work',
      includeVideo: true,
      videoAspectRatio: '9:16',
      videoImageMode: 'generated',
      videoGenerateImages: true,
      videoGeneratedImageRatio: 4,
      model: 'gpt-4o-mini',
    }, {
      sessionId: 'session-1',
      podcastService: podcastWorkflowService,
      podcastVideoService: videoWorkflowService,
      clientSurface: 'chat',
      model: 'gpt-4o',
    });

    expect(result.success).toBe(true);
    expect(videoWorkflowService.createVideoFromPodcast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Test podcast',
      }),
      expect.objectContaining({
        sessionId: 'session-1',
        options: expect.objectContaining({
          aspectRatio: '9:16',
          imageMode: 'generated',
          generateImages: true,
          generatedImageRatio: 4,
          model: 'gpt-4o',
        }),
      }),
    );
    expect(result.data.video).toEqual({ artifactId: 'artifact-video-1' });
    expect(result.data.artifactIds).toEqual(['artifact-podcast-1', 'artifact-video-1']);
  });

  test('generates batch graph diagrams with native data, SVG, Mermaid, and persisted image artifacts', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();
    artifactService.createStoredArtifact.mockImplementation(async (artifact) => ({
      id: `artifact-${artifact.metadata.graphId}`,
      sessionId: artifact.sessionId,
      filename: artifact.filename,
      extension: artifact.extension,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.buffer.length,
      previewHtml: artifact.previewHtml,
      metadata: artifact.metadata,
    }));
    artifactService.serializeArtifact.mockImplementation((artifact) => ({
      id: artifact.id,
      filename: artifact.filename,
      format: artifact.extension,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      downloadUrl: `/api/artifacts/${artifact.id}/download`,
      previewUrl: `/api/artifacts/${artifact.id}/preview`,
      preview: { type: 'html', content: artifact.previewHtml },
      metadata: artifact.metadata,
    }));

    const result = await toolManager.executeTool('graph-diagram', {
      graphs: [
        {
          title: 'Agent Tool Flow',
          type: 'flowchart',
          nodes: [
            { id: 'agent', label: 'Agent' },
            { id: 'graph', label: 'Graph Tool' },
            { id: 'doc', label: 'Document' },
          ],
          edges: [
            { from: 'agent', to: 'graph', label: 'renders' },
            { from: 'graph', to: 'doc', label: 'embeds SVG' },
          ],
        },
        {
          title: 'Evidence Mix',
          insightTitle: 'Sources outnumber images two to one',
          summary: 'The evidence package contains six sources and three images.',
          altText: 'Bar chart showing six sources and three images.',
          sourceLabel: 'Prepared evidence inventory',
          sourceUrl: 'https://example.test/evidence',
          caveat: 'Counts exclude drafts.',
          type: 'bar',
          data: [
            { label: 'Sources', value: 6 },
            { label: 'Images', value: 3 },
          ],
        },
      ],
      outputFormats: ['native', 'mermaid', 'svg', 'html'],
      renderMode: 'artifact',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
      model: 'gpt-5.5',
    });

    expect(result.success).toBe(true);
    expect(result.data.graphCount).toBe(2);
    expect(result.data.svgPreferred).toBe(true);
    expect(result.data.graphs[0].formats.mermaid).toContain('flowchart');
    expect(result.data.graphs[0].formats.svg).toContain('<svg');
    expect(result.data.graphs[1].formats.svg).toContain('Evidence Mix');
    expect(result.data.graphs[1].native).toEqual(expect.objectContaining({
      insightTitle: 'Sources outnumber images two to one',
      summary: 'The evidence package contains six sources and three images.',
      altText: 'Bar chart showing six sources and three images.',
      sourceLabel: 'Prepared evidence inventory',
      sourceUrl: 'https://example.test/evidence',
      caveat: 'Counts exclude drafts.',
    }));
    expect(result.data.artifacts[1].metadata.visualization).toEqual(expect.objectContaining({
      kind: 'data-visualization',
      chartType: 'bar',
      insightTitle: 'Sources outnumber images two to one',
      sourceLabel: 'Prepared evidence inventory',
      caveat: 'Counts exclude drafts.',
    }));
    expect(result.data.images).toHaveLength(2);
    expect(result.data.markdownImages[0]).toContain('/api/artifacts/artifact-Agent_Tool_Flow/download');
    expect(artifactService.createStoredArtifact).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      extension: 'svg',
      mimeType: 'image/svg+xml',
      metadata: expect.objectContaining({
        toolId: 'graph-diagram',
        graphType: 'flowchart',
      }),
    }));
  });

  test('normalizes markdown-wrapped image URLs before validation', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();
    global.fetch = jest.fn(async (url, options = {}) => ({
      ok: true,
      url,
      headers: {
        get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/jpeg' : null),
      },
      body: options.method === 'HEAD'
        ? null
        : {
          cancel: jest.fn(async () => {}),
        },
    }));

    const result = await toolManager.executeTool('image-from-url', {
      url: '![Hero image](https://images.unsplash.com/photo-12345?fit=crop&w=1200).',
    });

    expect(result.success).toBe(true);
    expect(result.data.image.url).toBe('https://images.unsplash.com/photo-12345?fit=crop&w=1200');
    expect(result.data.image.verified).toBe(true);
    expect(result.data.markdownImage).toContain('https://images.unsplash.com/photo-12345?fit=crop&w=1200');
  });

  test('verifies and normalizes batches of direct image urls', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();
    global.fetch = jest.fn(async (url, options = {}) => ({
      ok: true,
      url,
      headers: {
        get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/png' : null),
      },
      body: options.method === 'HEAD'
        ? null
        : {
          cancel: jest.fn(async () => {}),
        },
    }));

    const result = await toolManager.executeTool('image-from-url', {
      urls: [
        'https://cdn.example.com/photo-one',
        'https://cdn.example.com/photo-two',
      ],
    });

    expect(result.success).toBe(true);
    expect(result.data.verifiedCount).toBe(2);
    expect(result.data.images).toHaveLength(2);
    expect(result.data.markdownImages).toHaveLength(2);
    expect(result.data.rejected).toEqual([]);
  });

  test('accepts file-write content aliases and writes the file body', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-file-write-'));
    try {
      const targetPath = path.join(tempDir, 'sample.html');

      const result = await toolManager.executeTool('file-write', {
        path: targetPath,
        html: '<!DOCTYPE html><html><body><h1>Hello</h1></body></html>',
      });

      const written = await fs.readFile(targetPath, 'utf8');

      expect(result.success).toBe(true);
      expect(result.data.path).toBe(targetPath);
      expect(written).toContain('<h1>Hello</h1>');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('governs plain registry write handlers in Mission Mode', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-file-write-policy-'));
    const target = path.join(tempDir, 'blocked.txt');

    const result = await toolManager.executeTool('file-write', {
      path: target,
      content: 'must not be written',
    }, {
      runId: 'agent-run-policy',
      metadata: { missionMode: true },
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'TOOL_APPROVAL_REQUIRED',
      invocation: expect.objectContaining({ status: 'blocked', risk: 'write' }),
    }));
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('refuses paused and cancelled Mission Mode runs before the tool handler', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();
    const tool = toolManager.getTool('file-write');
    const handler = jest.fn(async () => ({ written: true }));
    tool.backend.handler = handler;
    const agentRunService = new AgentRunService({
      store: new AsyncLabStore({ persistToPostgres: false }),
    });
    const createExecutingRun = async (suffix) => {
      const created = await agentRunService.createRun({
        objective: `Control ${suffix}`,
        idempotencyKey: `tool-control-${suffix}`,
      }, 'mission-owner');
      await agentRunService.transitionRun(created.run.id, 'planning', { ownerId: 'mission-owner' });
      return (await agentRunService.transitionRun(created.run.id, 'executing', {
        ownerId: 'mission-owner',
      })).run;
    };
    const pausedRun = await createExecutingRun('paused');
    await agentRunService.performAction(pausedRun.id, {
      action: 'pause',
      idempotencyKey: 'pause-tool-control',
      reason: 'Wait for the operator',
    }, 'mission-owner');
    const cancelledRun = await createExecutingRun('cancelled');
    await agentRunService.performAction(cancelledRun.id, {
      action: 'cancel',
      idempotencyKey: 'cancel-tool-control',
      reason: 'Stop the mission',
    }, 'mission-owner');

    const execute = (runId, metadata = { missionMode: true }) => toolManager.executeTool('file-write', {
      path: 'should-not-be-written.txt',
      content: 'blocked',
    }, {
      runId,
      ownerId: 'mission-owner',
      agentRunService,
      metadata,
      sandboxMode: true,
      workspaceBounded: true,
    });
    const paused = await execute(pausedRun.id);
    const cancelled = await execute(cancelledRun.id);

    expect(paused).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'AGENT_RUN_PAUSED',
      control: expect.objectContaining({ paused: true, canAdvance: false }),
    }));
    expect(cancelled).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'AGENT_RUN_CANCELLED',
      control: expect.objectContaining({ cancelRequested: true, canAdvance: false }),
    }));
    expect(handler).not.toHaveBeenCalled();

    const legacy = await execute(pausedRun.id, {});
    expect(legacy.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    await agentRunService.performAction(pausedRun.id, {
      action: 'resume',
      idempotencyKey: 'resume-tool-control',
    }, 'mission-owner');
    const resumed = await execute(pausedRun.id);
    expect(resumed.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test('returns a helpful error when file-write is called without content', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const result = await toolManager.executeTool('file-write', {
      path: 'missing-content.txt',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('file-write requires a `content` string');
  });

  test('mirrors file-write outputs into artifacts when a session is active', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-file-write-artifact-'));
    try {
      const targetPath = path.join(tempDir, 'sample.html');

      const result = await toolManager.executeTool('file-write', {
        path: targetPath,
        content: '<!DOCTYPE html><html><body><h1>Hello</h1></body></html>',
      }, {
        route: '/api/chat',
        sessionId: 'session-1',
      });

      expect(result.success).toBe(true);
      expect(artifactService.createStoredArtifact).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-1',
        sourceMode: 'chat',
        filename: 'sample.html',
        extension: 'html',
        mimeType: 'text/html',
        metadata: expect.objectContaining({
          createdByAgentTool: true,
          toolId: 'file-write',
        }),
      }));
      expect(result.data.artifactPersisted).toBe(true);
      expect(result.data.artifact).toEqual(expect.objectContaining({
        id: 'artifact-file-write-1',
        downloadUrl: '/api/artifacts/artifact-file-write-1/download',
        previewUrl: '/api/artifacts/artifact-file-write-1/preview',
      }));
      expect(result.data.artifacts).toEqual([expect.objectContaining({
        id: 'artifact-file-write-1',
      })]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('searches indexed assets through asset-search', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    assetManager.searchAssets.mockResolvedValue({
      query: 'pricing pdf',
      count: 1,
      results: [
        {
          id: 'artifact:report-1',
          sourceType: 'artifact',
          kind: 'document',
          filename: 'pricing-report.pdf',
          artifactId: 'report-1',
          downloadUrl: '/api/artifacts/report-1/download',
        },
      ],
    });

    const result = await toolManager.executeTool('asset-search', {
      query: 'pricing pdf',
      kind: 'document',
      includeContent: true,
    }, {
      ownerId: 'phill',
      sessionId: 'session-1',
    });

    expect(result.success).toBe(true);
    expect(assetManager.searchAssets).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'pricing pdf',
        kind: 'document',
        includeContent: true,
      }),
      expect.objectContaining({
        ownerId: 'phill',
        sessionId: 'session-1',
      }),
    );
    expect(result.data.results[0].filename).toBe('pricing-report.pdf');
  });

  test('registers and executes research bucket tools', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    researchBucketService.list.mockResolvedValue({
      rootPath: '/tmp/research-buckets/shared',
      count: 1,
      results: [{ path: 'docs/brief.md', category: 'docs' }],
    });
    researchBucketService.search.mockResolvedValue({
      query: 'pricing',
      count: 1,
      results: [{ path: 'docs/brief.md', snippet: 'pricing table' }],
    });
    researchBucketService.read.mockResolvedValue({
      path: 'docs/brief.md',
      category: 'docs',
      content: '# Brief',
    });
    researchBucketService.mkdir.mockResolvedValue({
      path: 'docs/vendor',
      created: true,
    });
    researchBucketService.write.mockResolvedValue({
      path: 'docs/brief.md',
      absolutePath: '/tmp/research-buckets/shared/docs/brief.md',
      bytesWritten: 7,
      entry: { path: 'docs/brief.md', category: 'docs' },
    });
    assetManager.upsertWorkspacePath.mockResolvedValue({
      id: 'research-bucket:/tmp/research-buckets/shared/docs/brief.md',
      sourceType: 'research-bucket',
    });

    expect(toolManager.getTool('research-bucket-list')).toBeTruthy();
    expect(toolManager.getTool('research-bucket-search')).toBeTruthy();
    expect(toolManager.getTool('research-bucket-read')).toBeTruthy();
    expect(toolManager.getTool('research-bucket-write')).toBeTruthy();
    expect(toolManager.getTool('research-bucket-mkdir')).toBeTruthy();

    await expect(toolManager.executeTool('research-bucket-list', { category: 'docs' })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ count: 1 }),
    }));
    await expect(toolManager.executeTool('research-bucket-search', { query: 'pricing' })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ query: 'pricing' }),
    }));
    await expect(toolManager.executeTool('research-bucket-read', { path: 'docs/brief.md' })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ content: '# Brief' }),
    }));
    await expect(toolManager.executeTool('research-bucket-mkdir', { path: 'docs/vendor' })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ created: true }),
    }));

    const writeResult = await toolManager.executeTool('research-bucket-write', {
      path: 'brief.md',
      category: 'docs',
      content: '# Brief',
      tags: ['pricing'],
    }, {
      ownerId: 'phill',
      sessionId: 'session-1',
    });

    expect(writeResult.success).toBe(true);
    expect(writeResult.data.assetIndexed).toBe(true);
    expect(assetManager.upsertWorkspacePath).toHaveBeenCalledWith(
      '/tmp/research-buckets/shared/docs/brief.md',
      expect.objectContaining({
        sourceType: 'research-bucket',
        ownerId: 'phill',
        sessionId: 'session-1',
      }),
    );
  });

  test('returns research bucket validation errors through tool execution', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    researchBucketService.read.mockRejectedValue(new Error('research-bucket-read mode must be "preview", "content", or "base64".'));

    const result = await toolManager.executeTool('research-bucket-read', {
      path: 'docs/brief.md',
      mode: 'raw',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('mode must be');
  });

  test('registers and executes public source index tools', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    publicSourceIndexService.list.mockResolvedValue({
      count: 1,
      results: [{ id: 'sec-edgar-submissions-api', kind: 'public_api' }],
    });
    publicSourceIndexService.search.mockResolvedValue({
      query: 'filings',
      count: 1,
      results: [{ id: 'sec-edgar-submissions-api', score: 3 }],
    });
    publicSourceIndexService.get.mockResolvedValue({
      id: 'sec-edgar-submissions-api',
      name: 'SEC EDGAR Submissions API',
    });
    publicSourceIndexService.upsert.mockResolvedValue({
      action: 'created',
      entry: { id: 'sec-edgar-submissions-api', status: 'candidate' },
    });
    publicSourceIndexService.refresh.mockResolvedValue({
      entry: { id: 'sec-edgar-submissions-api', status: 'verified' },
      verification: { ok: true, httpStatus: 200 },
    });

    expect(toolManager.getTool('public-source-list')).toBeTruthy();
    expect(toolManager.getTool('public-source-search')).toBeTruthy();
    expect(toolManager.getTool('public-source-get')).toBeTruthy();
    expect(toolManager.getTool('public-source-add')).toBeTruthy();
    expect(toolManager.getTool('public-source-refresh')).toBeTruthy();

    await expect(toolManager.executeTool('public-source-list', { kind: 'public_api' })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ count: 1 }),
    }));
    await expect(toolManager.executeTool('public-source-search', { query: 'filings' })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ query: 'filings' }),
    }));
    await expect(toolManager.executeTool('public-source-get', { id: 'sec-edgar-submissions-api' })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ name: 'SEC EDGAR Submissions API' }),
    }));
    await expect(toolManager.executeTool('public-source-add', {
      name: 'SEC EDGAR Submissions API',
      kind: 'public_api',
      url: 'https://data.sec.gov/submissions/',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ action: 'created' }),
    }));
    await expect(toolManager.executeTool('public-source-refresh', {
      id: 'sec-edgar-submissions-api',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        verification: expect.objectContaining({ ok: true }),
      }),
    }));
  });

  test('synthesizes speech with local TTS and persists the audio into the active session', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    ttsService.synthesize.mockResolvedValue({
      audioBuffer: Buffer.from('RIFF-test-audio'),
      contentType: 'audio/wav',
      text: 'Read this status update aloud.',
      voice: {
        id: 'af_heart',
        label: 'Heart Studio',
        provider: 'kokoro',
      },
      provider: 'kokoro',
    });
    persistGeneratedAudio.mockResolvedValue({
      artifact: {
        id: 'artifact-audio-1',
        filename: 'status-update.wav',
        mimeType: 'audio/wav',
        downloadUrl: '/api/artifacts/artifact-audio-1/download',
      },
      audio: {
        artifactId: 'artifact-audio-1',
        downloadUrl: '/api/artifacts/artifact-audio-1/download',
        inlinePath: '/api/artifacts/artifact-audio-1/download?inline=1',
      },
      artifactIds: ['artifact-audio-1'],
    });

    const result = await toolManager.executeTool('speech-generate', {
      text: 'Read this status update aloud.',
      title: 'Status update',
    }, {
      sessionId: 'session-1',
      clientSurface: 'chat',
    });

    expect(result.success).toBe(true);
    expect(ttsService.synthesize).toHaveBeenCalledWith({
      text: 'Read this status update aloud.',
      voiceId: '',
    });
    expect(persistGeneratedAudio).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      sourceMode: 'chat',
      text: 'Read this status update aloud.',
      title: 'Status update',
      provider: 'kokoro',
      mimeType: 'audio/wav',
      metadata: expect.objectContaining({
        requestedText: 'Read this status update aloud.',
        createdByAgentTool: true,
      }),
    }));
    expect(result.data).toEqual(expect.objectContaining({
      provider: 'kokoro',
      contentType: 'audio/wav',
      artifactIds: ['artifact-audio-1'],
      audio: expect.objectContaining({
        inlinePath: '/api/artifacts/artifact-audio-1/download?inline=1',
      }),
    }));
  });

  test('writes durable carryover notes through agent-notes-write and enforces the character limit', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-agent-notes-tool-'));
    const originalPath = process.env.KIMIBUILT_AGENT_NOTES_PATH;
    process.env.KIMIBUILT_AGENT_NOTES_PATH = path.join(tempDir, 'agent-notes.md');

    try {
      const success = await toolManager.executeTool('agent-notes-write', {
        content: '# Carryover Notes\n- Phil prefers concise diffs.\n',
        reason: 'Useful collaboration detail for future sessions.',
      });

      expect(success.success).toBe(true);
      expect(success.data.filePath).toContain('agent-notes.md');
      expect(await fs.readFile(process.env.KIMIBUILT_AGENT_NOTES_PATH, 'utf8')).toBe('# Carryover Notes\n- Phil prefers concise diffs.\n');

      const failure = await toolManager.executeTool('agent-notes-write', {
        content: 'x'.repeat(5000),
      });

      expect(failure.success).toBe(false);
      expect(failure.error).toContain('agent-notes.md cannot exceed');
    } finally {
      if (originalPath === undefined) {
        delete process.env.KIMIBUILT_AGENT_NOTES_PATH;
      } else {
        process.env.KIMIBUILT_AGENT_NOTES_PATH = originalPath;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('recommends a document workflow through the document-workflow tool', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const documentService = {
      recommendDocumentWorkflow: jest.fn(() => ({
        inferredType: 'website-slides',
        recommendedFormat: 'html',
        blueprint: { label: 'Website Slides' },
      })),
      buildDocumentPlan: jest.fn(),
      aiGenerate: jest.fn(),
      assemble: jest.fn(),
      generatePresentation: jest.fn(),
    };

    const result = await toolManager.executeTool('document-workflow', {
      action: 'recommend',
      prompt: 'Research vacation pricing and build website slides I can review.',
    }, {
      documentService,
    });

    expect(result.success).toBe(true);
    expect(documentService.recommendDocumentWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Research vacation pricing and build website slides I can review.',
    }));
    expect(result.data.recommendation).toEqual(expect.objectContaining({
      inferredType: 'website-slides',
      recommendedFormat: 'html',
    }));
  });

  test('generates grounded html content from source material through document-workflow', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const documentService = {
      recommendDocumentWorkflow: jest.fn(() => ({
        inferredType: 'document',
        recommendedFormat: 'html',
        blueprint: { label: 'Executive Brief' },
      })),
      buildDocumentPlan: jest.fn(),
      aiGenerate: jest.fn(async (prompt) => ({
        id: 'doc-1',
        filename: 'vacation-pricing.html',
        mimeType: 'text/html',
        content: '<!DOCTYPE html><html><body><h1>Vacation Pricing</h1></body></html>',
        contentBuffer: Buffer.from('<!DOCTYPE html><html><body><h1>Vacation Pricing</h1></body></html>'),
        metadata: { format: 'html' },
        downloadUrl: '/api/documents/doc-1/download',
      })),
      assemble: jest.fn(),
      generatePresentation: jest.fn(),
    };

    const result = await toolManager.executeTool('document-workflow', {
      action: 'generate',
      prompt: 'Create a vacation pricing summary page.',
      format: 'html',
      includeContent: true,
      sources: [
        {
          title: 'Sample pricing',
          sourceUrl: 'https://travel.example.com/packages',
          content: 'Weekend package: $799. Flights from Halifax start at $214.',
        },
      ],
    }, {
      documentService,
      model: 'gpt-5.4-mini',
    });

    expect(result.success).toBe(true);
    expect(documentService.aiGenerate).toHaveBeenCalledWith(
      expect.stringContaining('Do not ask the user to supply website lists or source URLs'),
      expect.objectContaining({
        format: 'html',
        model: 'gpt-5.4-mini',
      }),
    );
    expect(documentService.aiGenerate).toHaveBeenCalledWith(
      expect.stringContaining('Weekend package: $799. Flights from Halifax start at $214.'),
      expect.any(Object),
    );
    expect(result.data.document).toEqual(expect.objectContaining({
      filename: 'vacation-pricing.html',
      downloadUrl: '/api/documents/doc-1/download',
      content: expect.stringContaining('<h1>Vacation Pricing</h1>'),
    }));
  });

  test('infers pdf output for document-workflow prompts when format is omitted', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const documentService = {
      recommendDocumentWorkflow: jest.fn(() => ({
        inferredType: 'document',
        recommendedFormat: 'html',
        blueprint: { label: 'Document' },
      })),
      buildDocumentPlan: jest.fn(),
      aiGenerate: jest.fn(async () => ({
        id: 'doc-pdf-1',
        filename: 'fighting-climate-change.pdf',
        mimeType: 'application/pdf',
        contentBuffer: Buffer.from('%PDF-1.4\n'),
        size: 9,
        metadata: { format: 'pdf' },
        downloadUrl: '/api/documents/doc-pdf-1/download',
      })),
      assemble: jest.fn(),
      generatePresentation: jest.fn(),
    };

    const result = await toolManager.executeTool('document-workflow', {
      action: 'generate',
      prompt: 'Can you make me a pdf on fighting climate change?',
    }, {
      documentService,
    });

    expect(result.success).toBe(true);
    expect(documentService.recommendDocumentWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      format: 'pdf',
    }));
    expect(documentService.aiGenerate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ format: 'pdf' }),
    );
    expect(result.data.document).toEqual(expect.objectContaining({
      filename: 'fighting-climate-change.pdf',
      mimeType: 'application/pdf',
      downloadUrl: '/api/documents/doc-pdf-1/download',
    }));
  });

  test('persists document-workflow documents as session artifacts when session context is available', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const documentService = {
      recommendDocumentWorkflow: jest.fn(() => ({
        inferredType: 'document',
        recommendedFormat: 'html',
        blueprint: { label: 'Executive Brief' },
      })),
      buildDocumentPlan: jest.fn(),
      aiGenerate: jest.fn(async () => ({
        id: 'doc-1',
        filename: 'safety-brief.html',
        mimeType: 'text/html',
        content: '<!DOCTYPE html><html><body><h1>Safety Brief</h1></body></html>',
        contentBuffer: Buffer.from('<!DOCTYPE html><html><body><h1>Safety Brief</h1></body></html>'),
        metadata: { format: 'html' },
        downloadUrl: '/api/documents/doc-1/download',
      })),
      assemble: jest.fn(),
      generatePresentation: jest.fn(),
    };

    artifactService.createStoredArtifact.mockResolvedValue({
      id: 'artifact-doc-1',
      sessionId: 'session-1',
      filename: 'safety-brief.html',
      extension: 'html',
      mimeType: 'text/html',
      sizeBytes: 64,
      previewHtml: '<!DOCTYPE html><html><body><h1>Safety Brief</h1></body></html>',
      metadata: { format: 'html' },
    });
    artifactService.serializeArtifact.mockReturnValue({
      id: 'artifact-doc-1',
      sessionId: 'session-1',
      filename: 'safety-brief.html',
      format: 'html',
      mimeType: 'text/html',
      sizeBytes: 64,
      downloadUrl: '/api/artifacts/artifact-doc-1/download',
      previewUrl: '/api/artifacts/artifact-doc-1/preview',
      preview: {
        type: 'html',
        content: '<!DOCTYPE html><html><body><h1>Safety Brief</h1></body></html>',
      },
      metadata: { format: 'html' },
    });

    const result = await toolManager.executeTool('document-workflow', {
      action: 'generate',
      prompt: 'Create a safety brief.',
      format: 'html',
      includeContent: true,
    }, {
      documentService,
      sessionId: 'session-1',
      session: { id: 'session-1', metadata: {} },
      clientSurface: 'web-chat',
    });

    expect(result.success).toBe(true);
    expect(artifactService.createStoredArtifact).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      filename: 'safety-brief.html',
      extension: 'html',
      metadata: expect.objectContaining({
        persistedFrom: 'document-workflow',
        originalDocumentId: 'doc-1',
      }),
    }));
    expect(result.data.document).toEqual(expect.objectContaining({
      id: 'artifact-doc-1',
      downloadUrl: '/api/artifacts/artifact-doc-1/download',
      artifact: expect.objectContaining({
        id: 'artifact-doc-1',
      }),
      artifacts: expect.arrayContaining([
        expect.objectContaining({ id: 'artifact-doc-1' }),
      ]),
    }));
  });

  test('generates presentations from structured slide payloads through document-workflow', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const documentService = {
      recommendDocumentWorkflow: jest.fn(() => ({
        inferredType: 'presentation',
        recommendedFormat: 'pptx',
        blueprint: { label: 'Presentation' },
      })),
      buildDocumentPlan: jest.fn(),
      aiGenerate: jest.fn(),
      assemble: jest.fn(),
      generatePresentation: jest.fn(async () => ({
        id: 'deck-structured-1',
        filename: 'structured-deck.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        metadata: { slideCount: 2 },
        downloadUrl: '/api/documents/deck-structured-1/download',
      })),
    };

    const result = await toolManager.executeTool('document-workflow', {
      action: 'generate',
      documentType: 'presentation',
      format: 'pptx',
      generateImages: false,
      presentation: {
        title: 'Structured Deck',
        theme: 'executive',
        slides: [
          { layout: 'title', title: 'Structured Deck' },
          { layout: 'image', title: 'Hero', imageUrl: 'https://images.example.com/hero.jpg' },
        ],
      },
    }, {
      documentService,
      model: 'gpt-5.4-mini',
    });

    expect(result.success).toBe(true);
    expect(documentService.generatePresentation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Structured Deck',
        slides: expect.arrayContaining([
          expect.objectContaining({
            imageUrl: 'https://images.example.com/hero.jpg',
          }),
        ]),
      }),
      expect.objectContaining({
        format: 'pptx',
        model: 'gpt-5.4-mini',
        generateImages: false,
      }),
    );
    expect(result.data.document).toEqual(expect.objectContaining({
      filename: 'structured-deck.pptx',
      downloadUrl: '/api/documents/deck-structured-1/download',
    }));
  });

  test('routes dashboard html generation through the artifact pipeline inside document-workflow', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const documentService = {
      recommendDocumentWorkflow: jest.fn(() => ({
        inferredType: 'document',
        recommendedFormat: 'html',
        blueprint: { label: 'Executive Brief' },
      })),
      buildDocumentPlan: jest.fn(),
      aiGenerate: jest.fn(),
      assemble: jest.fn(),
      generatePresentation: jest.fn(),
    };

    artifactService.generateArtifact.mockResolvedValue({
      artifact: {
        id: 'artifact-1',
        filename: 'support-ops-dashboard.html',
        mimeType: 'text/html',
        sizeBytes: 2048,
        downloadUrl: '/api/artifacts/artifact-1/download',
        preview: {
          type: 'html',
          content: '<!DOCTYPE html><html><body data-dashboard-template="admin-control-room"></body></html>',
        },
        metadata: {
          dashboardTemplateSuggestedPrimaryId: 'admin-control-room',
        },
      },
      outputText: '<!DOCTYPE html><html><body data-dashboard-template="admin-control-room"></body></html>',
    });

    const result = await toolManager.executeTool('document-workflow', {
      action: 'generate',
      prompt: 'Create a dashboard-style HTML for support operations.',
      format: 'html',
      includeContent: true,
      sources: [
        {
          title: 'Weekly technology brief',
          content: 'Ticket volume is up 18%. SLA misses concentrated in the overnight queue.',
        },
      ],
    }, {
      sessionId: 'session-1',
      documentService,
      model: 'gpt-5.4-mini',
    });

    expect(result.success).toBe(true);
    expect(artifactService.generateArtifact).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      format: 'html',
      prompt: expect.stringContaining('Ticket volume is up 18%'),
    }));
    expect(documentService.aiGenerate).not.toHaveBeenCalled();
    expect(result.data.document).toEqual(expect.objectContaining({
      filename: 'support-ops-dashboard.html',
      downloadUrl: '/api/artifacts/artifact-1/download',
      content: expect.stringContaining('data-dashboard-template'),
    }));
  });

  test('routes website sandbox generation through frontend artifacts without a suite wrapper', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const documentService = {
      recommendDocumentWorkflow: jest.fn(() => ({
        inferredType: 'document',
        recommendedFormat: 'html',
        blueprint: { label: 'Website Mockup' },
      })),
      buildDocumentPlan: jest.fn(),
      aiGenerate: jest.fn(),
      assemble: jest.fn(),
      generatePresentation: jest.fn(),
    };
    const siteIndex = '<!DOCTYPE html><html><body><main data-component="soundtrack-system">Soundtrack System</main></body></html>';
    artifactService.generateArtifact.mockResolvedValue({
      artifact: {
        id: 'artifact-site-1',
        filename: 'soundtrack-system.html',
        mimeType: 'text/html',
        sizeBytes: 4096,
        downloadUrl: '/api/artifacts/artifact-site-1/download',
        previewUrl: '/api/artifacts/artifact-site-1/preview',
        sandboxUrl: '/api/artifacts/artifact-site-1/sandbox',
        preview: {
          type: 'html',
          content: siteIndex,
        },
        metadata: {
          type: 'frontend',
          frameworkTarget: 'static',
          bundle: {
            entry: 'index.html',
            files: [
              { path: 'index.html', language: 'html', purpose: 'Home page', content: siteIndex },
              { path: 'styles.css', language: 'css', purpose: 'Shared styles', content: 'body{color:#111;background:#fff;}' },
              { path: 'app.js', language: 'javascript', purpose: 'Interactions', content: 'document.body.dataset.ready = "true";' },
            ],
          },
        },
      },
      outputText: siteIndex,
    });
    const nestedToolManager = {
      executeTool: jest.fn(async (id, params) => ({
        success: true,
        data: {
          mode: 'project',
          entry: params.entry,
          files: params.files.map((file) => ({ path: file.path, content: file.content })),
        },
      })),
    };

    const result = await toolManager.executeTool('document-workflow', {
      action: 'generate-suite',
      request: 'Mock me up a website with a soundtrack system. It needs to be cool and fully flushed out.',
      formats: ['html'],
      buildMode: 'sandbox',
      useSandbox: true,
    }, {
      sessionId: 'session-1',
      documentService,
      toolManager: nestedToolManager,
      model: 'gpt-5.4-mini',
    });

    expect(result.success).toBe(true);
    expect(artifactService.generateArtifact).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      format: 'html',
      prompt: expect.stringContaining('soundtrack system'),
    }));
    expect(documentService.aiGenerate).not.toHaveBeenCalled();
    expect(nestedToolManager.executeTool).toHaveBeenCalledWith(
      'code-sandbox',
      expect.objectContaining({
        mode: 'project',
        entry: 'index.html',
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'index.html', content: expect.stringContaining('data-component="soundtrack-system"') }),
          expect.objectContaining({ path: 'styles.css' }),
          expect.objectContaining({ path: 'app.js' }),
          expect.objectContaining({ path: 'AGENT_SANDBOX_BUILD.md' }),
        ]),
      }),
      expect.any(Object),
    );
    const sandboxParams = nestedToolManager.executeTool.mock.calls[0][1];
    expect(sandboxParams.files.find((file) => file.path === 'index.html').content).toContain('data-component="soundtrack-system"');
    expect(sandboxParams.files.find((file) => file.path === 'index.html').content).not.toContain('Sandbox build bundle assembled');
    expect(result.data.sandboxBuild).toEqual(expect.objectContaining({ mode: 'project' }));
  });

  test('builds website sandbox from serialized static bundle metadata', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const documentService = {
      recommendDocumentWorkflow: jest.fn(() => ({
        inferredType: 'document',
        recommendedFormat: 'html',
        blueprint: { label: 'Website Mockup' },
      })),
      buildDocumentPlan: jest.fn(),
      aiGenerate: jest.fn(),
      assemble: jest.fn(),
      generatePresentation: jest.fn(),
    };
    const siteIndex = '<!DOCTYPE html><html><body><main data-component="soundtrack-system">Soundtrack System</main></body></html>';
    artifactService.generateArtifact.mockResolvedValue({
      artifact: {
        id: 'artifact-site-summary-1',
        filename: 'soundtrack-system.zip',
        mimeType: 'application/zip',
        sizeBytes: 4096,
        downloadUrl: '/api/artifacts/artifact-site-summary-1/download',
        bundleDownloadUrl: '/api/artifacts/artifact-site-summary-1/bundle',
        preview: {
          type: 'site',
          entry: 'index.html',
          fileCount: 3,
        },
        metadata: {
          type: 'frontend',
          frameworkTarget: 'static',
          bundle: {
            entry: 'index.html',
            frameworkTarget: 'static',
            fileCount: 3,
            htmlPageCount: 1,
            files: [
              { path: 'index.html', language: 'html', purpose: 'Home page' },
              { path: 'styles.css', language: 'css', purpose: 'Shared styles' },
              { path: 'app.js', language: 'javascript', purpose: 'Interactions' },
            ],
          },
        },
      },
      outputText: siteIndex,
    });
    const nestedToolManager = {
      executeTool: jest.fn(async (id, params) => ({
        success: true,
        data: {
          mode: 'project',
          language: params.language,
          entry: params.entry,
          files: params.files.map((file) => ({ path: file.path, content: file.content })),
        },
      })),
    };

    const result = await toolManager.executeTool('document-workflow', {
      action: 'generate-suite',
      request: 'Mock me up a website with a soundtrack system.',
      formats: ['html'],
      buildMode: 'sandbox',
      useSandbox: true,
    }, {
      sessionId: 'session-1',
      documentService,
      toolManager: nestedToolManager,
      model: 'gpt-5.4-mini',
    });

    expect(result.success).toBe(true);
    expect(nestedToolManager.executeTool).toHaveBeenCalledWith(
      'code-sandbox',
      expect.objectContaining({
        mode: 'project',
        language: 'html',
        entry: 'index.html',
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'index.html', content: expect.stringContaining('data-component="soundtrack-system"') }),
          expect.objectContaining({ path: 'AGENT_SANDBOX_BUILD.md' }),
        ]),
      }),
      expect.any(Object),
    );
    expect(result.data.sandboxBuild.files.find((file) => file.path === 'index.html').content).not.toContain('Document Suite');
  });

  test('builds a sandbox project for single html document generation when requested', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const documentService = {
      recommendDocumentWorkflow: jest.fn(() => ({
        inferredType: 'document',
        recommendedFormat: 'html',
        blueprint: { label: 'Sandbox Brief' },
      })),
      buildDocumentPlan: jest.fn(),
      assemble: jest.fn(),
      generatePresentation: jest.fn(),
      aiGenerate: jest.fn(async () => ({
        id: 'doc-html',
        filename: 'brief.html',
        mimeType: 'text/html',
        content: '<!DOCTYPE html><html><head><title>Brief</title></head><body><main><h1>Brief</h1></main></body></html>',
        contentBuffer: Buffer.from('<!DOCTYPE html><html><head><title>Brief</title></head><body><main><h1>Brief</h1></main></body></html>'),
        metadata: { format: 'html' },
      })),
    };
    const nestedToolManager = {
      executeTool: jest.fn(async (id, params) => {
        if (id !== 'code-sandbox') {
          throw new Error(`Unexpected nested tool call: ${id}`);
        }
        return {
          success: true,
          data: {
            mode: 'project',
            files: params.files.map((file) => ({ path: file.path })),
          },
        };
      }),
    };

    const result = await toolManager.executeTool('document-workflow', {
      action: 'generate',
      prompt: 'Create an HTML brief and build it in the sandbox.',
      format: 'html',
      buildMode: 'sandbox',
    }, {
      documentService,
      toolManager: nestedToolManager,
      model: 'gpt-5.4-mini',
    });

    expect(result.success).toBe(true);
    expect(nestedToolManager.executeTool).toHaveBeenCalledWith(
      'code-sandbox',
      expect.objectContaining({
        mode: 'project',
        language: 'vite',
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'index.html' }),
          expect.objectContaining({
            path: 'AGENT_SANDBOX_BUILD.md',
            content: expect.stringContaining('You are in sandbox build mode'),
          }),
          expect.objectContaining({ path: 'brief.html' }),
        ]),
      }),
      expect.any(Object),
    );
    const handoff = nestedToolManager.executeTool.mock.calls[0][1].files.find((file) => file.path === 'AGENT_SANDBOX_BUILD.md').content;
    expect(handoff).toContain('Kimi K2.6-style creation loop');
    expect(handoff).toContain('alignment snapshot');
    expect(handoff).toContain('acceptance checks');
    expect(handoff).toContain('CodeMirror');
    expect(handoff).toContain('PDF.js');
    expect(result.data.sandboxBuild).toEqual(expect.objectContaining({ mode: 'project' }));
  });

  test('builds a sandboxed multi-format document suite with attached images', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const documentService = {
      recommendDocumentWorkflow: jest.fn(({ format }) => ({
        inferredType: format === 'pptx' ? 'presentation' : 'document',
        recommendedFormat: format || 'html',
        blueprint: { label: 'Research Suite' },
      })),
      buildDocumentPlan: jest.fn(),
      assemble: jest.fn(),
      generatePresentation: jest.fn(),
      aiGenerate: jest.fn(async (_prompt, options) => ({
        id: `doc-${options.format}`,
        filename: options.format === 'xlsx' ? 'research-data.xlsx' : `research-${options.format}.html`,
        mimeType: options.format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/html',
        content: options.format === 'xlsx'
          ? Buffer.from('xlsx-bytes')
          : `<!DOCTYPE html><html><body><h1>${options.format}</h1></body></html>`,
        contentBuffer: options.format === 'xlsx'
          ? Buffer.from('xlsx-bytes')
          : Buffer.from(`<!DOCTYPE html><html><body><h1>${options.format}</h1></body></html>`),
        metadata: { format: options.format },
        downloadUrl: `/api/documents/doc-${options.format}/download`,
      })),
    };
    const nestedToolManager = {
      executeTool: jest.fn(async (id, params) => {
        if (id !== 'code-sandbox') {
          throw new Error(`Unexpected nested tool call: ${id}`);
        }
        return {
          success: true,
          data: {
            mode: 'project',
            workspacePath: 'output/sandboxes/research-suite',
            files: params.files.map((file) => ({ path: file.path })),
            artifact: {
              id: 'sandbox-artifact-1',
              downloadUrl: '/api/artifacts/sandbox-artifact-1/download',
            },
          },
        };
      }),
    };

    const result = await toolManager.executeTool('document-workflow', {
      action: 'generate-suite',
      prompt: 'Build a research-backed document bundle.',
      formats: ['html', 'pptx', 'xlsx'],
      buildMode: 'sandbox',
      includeContent: false,
      maxPages: 20,
      images: [{
        filename: 'chart.png',
        contentBase64: Buffer.from('image-bytes').toString('base64'),
        mimeType: 'image/png',
        alt: 'Research chart',
      }],
      sources: [{
        title: 'Research source',
        sourceUrl: 'https://example.com/research',
        content: 'The researched signal is up 18%.',
      }],
    }, {
      documentService,
      toolManager: nestedToolManager,
      model: 'gpt-5.4-mini',
    });

    expect(result.success).toBe(true);
    expect(documentService.aiGenerate).toHaveBeenCalledWith(
      expect.stringContaining('Target depth: up to 20 pages'),
      expect.objectContaining({
        maxPages: 20,
      }),
    );
    expect(result.data.formats).toEqual(['html', 'pptx', 'xlsx']);
    expect(nestedToolManager.executeTool).toHaveBeenCalledWith(
      'code-sandbox',
      expect.objectContaining({
        mode: 'project',
        language: 'vite',
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'index.html' }),
          expect.objectContaining({ path: 'assets/chart.png', contentBase64: expect.any(String) }),
          expect.objectContaining({ path: 'assets/images.json' }),
        ]),
      }),
      expect.any(Object),
    );
    expect(result.data.sandboxBuild).toEqual(expect.objectContaining({
      mode: 'project',
      artifact: expect.objectContaining({ id: 'sandbox-artifact-1' }),
    }));
  });

  test('carries frontend bundle files into sandboxed document suites', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const bundlePayload = {
      content: '<!DOCTYPE html><html><head><title>Ops</title><link rel="stylesheet" href="./styles.css"></head><body><main><h1>Ops</h1></main></body></html>',
      metadata: {
        title: 'Ops Dashboard',
        language: 'html',
        frameworkTarget: 'static',
        bundle: {
          entry: 'index.html',
          files: [
            {
              path: 'index.html',
              language: 'html',
              content: '<!DOCTYPE html><html><head><title>Ops</title><link rel="stylesheet" href="./styles.css"></head><body><main><h1>Ops</h1></main></body></html>',
            },
            {
              path: 'styles.css',
              language: 'css',
              content: 'body { margin: 0; color: #111827; background: #ffffff; }',
            },
            {
              path: 'app.js',
              language: 'javascript',
              content: 'document.documentElement.dataset.ready = "true";',
            },
          ],
        },
      },
    };

    artifactService.generateArtifact.mockResolvedValueOnce({
      artifact: {
        id: 'artifact-dashboard-bundle',
        filename: 'ops-dashboard.zip',
        mimeType: 'application/zip',
        sizeBytes: 4096,
        downloadUrl: '/api/artifacts/artifact-dashboard-bundle/download',
        bundleDownloadUrl: '/api/artifacts/artifact-dashboard-bundle/bundle',
        preview: {
          type: 'site',
          entry: 'index.html',
          fileCount: 3,
        },
        metadata: {
          siteBundle: {
            entry: 'index.html',
            fileCount: 3,
            htmlPageCount: 1,
          },
        },
      },
      outputText: JSON.stringify(bundlePayload),
    });

    const documentService = {
      recommendDocumentWorkflow: jest.fn(({ format }) => ({
        inferredType: 'html-dashboard-kpi',
        recommendedFormat: format || 'html',
        blueprint: { label: 'Ops Dashboard' },
      })),
      buildDocumentPlan: jest.fn(),
      assemble: jest.fn(),
      generatePresentation: jest.fn(),
      aiGenerate: jest.fn(),
    };
    const nestedToolManager = {
      executeTool: jest.fn(async (id, params) => {
        if (id !== 'code-sandbox') {
          throw new Error(`Unexpected nested tool call: ${id}`);
        }
        return {
          success: true,
          data: {
            mode: 'project',
            files: params.files.map((file) => ({ path: file.path })),
          },
        };
      }),
    };

    const result = await toolManager.executeTool('document-workflow', {
      action: 'generate-suite',
      prompt: 'Build a dashboard-style HTML for support operations.',
      formats: ['html'],
      buildMode: 'sandbox',
    }, {
      documentService,
      toolManager: nestedToolManager,
      sessionId: 'session-1',
    });

    expect(result.success).toBe(true);
    expect(documentService.aiGenerate).not.toHaveBeenCalled();
    expect(nestedToolManager.executeTool).toHaveBeenCalledWith(
      'code-sandbox',
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'styles.css' }),
          expect.objectContaining({ path: 'app.js' }),
          expect.objectContaining({ path: 'AGENT_SANDBOX_BUILD.md' }),
        ]),
      }),
      expect.any(Object),
    );
  });

  test('uses graph-diagram before building a visual document suite', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const documentService = {
      recommendDocumentWorkflow: jest.fn(({ format }) => ({
        inferredType: 'data-story',
        recommendedFormat: format || 'html',
        blueprint: { label: 'Data Story' },
      })),
      buildDocumentPlan: jest.fn(),
      assemble: jest.fn(),
      generatePresentation: jest.fn(),
      aiGenerate: jest.fn(async (_prompt, options) => ({
        id: `doc-${options.format}`,
        filename: `data-story-${options.format}.html`,
        mimeType: 'text/html',
        content: `<!DOCTYPE html><html><body><h1>${options.format}</h1></body></html>`,
        contentBuffer: Buffer.from(`<!DOCTYPE html><html><body><h1>${options.format}</h1></body></html>`),
        metadata: { format: options.format },
        downloadUrl: `/api/documents/doc-${options.format}/download`,
      })),
    };
    const nestedToolManager = {
      executeTool: jest.fn(async (id, params) => {
        if (id === 'graph-diagram') {
          return {
            success: true,
            data: {
              graphCount: 1,
              images: [{
                title: 'Adoption Flow',
                url: '/api/artifacts/graph-1/download',
              }],
              artifacts: [{ id: 'graph-1' }],
              graphs: [{ id: 'adoption-flow', formats: { svg: '<svg></svg>' } }],
            },
          };
        }
        if (id === 'code-sandbox') {
          return {
            success: true,
            data: {
              mode: 'project',
              files: params.files.map((file) => ({ path: file.path })),
            },
          };
        }
        throw new Error(`Unexpected nested tool call: ${id}`);
      }),
    };

    const result = await toolManager.executeTool('document-workflow', {
      action: 'generate-suite',
      prompt: 'Build a visual data-story bundle.',
      formats: ['html'],
      buildMode: 'sandbox',
      graphs: [{
        type: 'flowchart',
        title: 'Adoption Flow',
        nodes: [{ id: 'lead', label: 'Lead' }, { id: 'active', label: 'Active' }],
        edges: [{ from: 'lead', to: 'active', label: 'converts' }],
      }],
    }, {
      documentService,
      toolManager: nestedToolManager,
      sessionId: 'session-1',
    });

    expect(result.success).toBe(true);
    expect(nestedToolManager.executeTool).toHaveBeenCalledWith(
      'graph-diagram',
      expect.objectContaining({
        graphs: expect.arrayContaining([
          expect.objectContaining({ title: 'Adoption Flow' }),
        ]),
        renderMode: 'artifact',
      }),
      expect.any(Object),
    );
    expect(documentService.aiGenerate).toHaveBeenCalledWith(
      expect.stringContaining('/api/artifacts/graph-1/download'),
      expect.objectContaining({ format: 'html' }),
    );
    expect(nestedToolManager.executeTool).toHaveBeenCalledWith(
      'code-sandbox',
      expect.objectContaining({
        language: 'vite',
        files: expect.arrayContaining([
          expect.objectContaining({
            path: 'assets/images.json',
            content: expect.stringContaining('/api/artifacts/graph-1/download'),
          }),
        ]),
      }),
      expect.any(Object),
    );
    expect(result.data.graphBuild).toEqual(expect.objectContaining({
      graphCount: 1,
    }));
  });

  test('generates a research-backed presentation through the deep research workflow tool', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const nestedToolManager = {
      executeTool: jest.fn(async (id, params) => {
        if (id === 'document-workflow' && params.action === 'recommend') {
          return {
            success: true,
            data: {
              recommendation: {
                inferredType: 'presentation',
                recommendedFormat: 'pptx',
                blueprint: { label: 'Presentation' },
              },
            },
          };
        }

        if (id === 'document-workflow' && params.action === 'plan') {
          return {
            success: true,
            data: {
              plan: {
                titleSuggestion: 'Halifax Travel Pricing',
                themeSuggestion: 'executive',
                outline: [
                  { title: 'Title Slide' },
                  { title: 'Pricing Snapshot' },
                ],
              },
            },
          };
        }

        if (id === 'web-search') {
          return {
            success: true,
            data: {
              totalResults: 1,
              results: [{
                title: 'Nova Scotia Travel Packages',
                url: 'https://travel.example.com/packages',
                source: 'travel.example.com',
              }],
            },
          };
        }

        if (id === 'web-fetch') {
          return {
            success: true,
            data: {
              url: 'https://travel.example.com/packages',
              title: 'Nova Scotia Travel Packages',
              body: '<main>Weekend package: $799. Flights from Halifax start at $214.</main>',
            },
          };
        }

        if (id === 'image-search-unsplash') {
          return {
            success: true,
            data: {
              images: [{
                url: 'https://images.example.com/halifax.jpg',
                alt: 'Halifax waterfront',
                author: 'Jane Doe',
              }],
            },
          };
        }

        if (id === 'image-from-url') {
          return {
            success: true,
            data: {
              image: {
                url: params.url,
                alt: params.alt,
                host: 'images.example.com',
                mimeType: 'image/jpeg',
                verified: true,
                verificationMethod: 'GET',
              },
            },
          };
        }

        if (id === 'document-workflow' && params.action === 'generate') {
          return {
            success: true,
            data: {
              document: {
                id: 'deck-1',
                filename: 'halifax-travel-pricing.pptx',
                mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                downloadUrl: '/api/documents/deck-1/download',
              },
            },
          };
        }

        throw new Error(`Unexpected nested tool call: ${id}`);
      }),
    };

    const documentService = {
      recommendDocumentWorkflow: jest.fn(),
      buildDocumentPlan: jest.fn(),
      aiGenerate: jest.fn(),
      assemble: jest.fn(),
      generatePresentation: jest.fn(),
      inferSlideCount: jest.fn(() => 6),
      aiGenerator: {
        generatePresentationContent: jest.fn(async () => ({
          title: 'Halifax Travel Pricing',
          subtitle: 'Research-backed deck',
          theme: 'executive',
          slides: [
            { layout: 'title', title: 'Halifax Travel Pricing', subtitle: 'Research-backed deck' },
            {
              layout: 'image',
              title: 'Pricing Snapshot',
              imagePrompt: 'Halifax waterfront travel hero image',
              bullets: ['Weekend package: $799', 'Flights from Halifax start at $214'],
            },
          ],
        })),
      },
    };

    const result = await toolManager.executeTool('deep-research-presentation', {
      prompt: 'Research vacation pricing in Halifax and build a slide deck I can review.',
      researchPasses: 1,
      imageLimit: 1,
      imageSettleDelayMs: 1,
    }, {
      documentService,
      toolManager: nestedToolManager,
      model: 'gpt-5.4-mini',
    });

    expect(result.success).toBe(true);
    expect(documentService.aiGenerator.generatePresentationContent).toHaveBeenCalledWith(
      expect.stringContaining('Do not ask the user to supply website lists or source URLs'),
      expect.objectContaining({
        documentType: 'presentation',
        model: 'gpt-5.4-mini',
      }),
    );
    expect(documentService.aiGenerator.generatePresentationContent).toHaveBeenCalledWith(
      expect.stringContaining('Weekend package: $799'),
      expect.any(Object),
    );

    expect(nestedToolManager.executeTool.mock.calls.map(([id]) => id)).toEqual([
      'document-workflow',
      'document-workflow',
      'web-search',
      'web-fetch',
      'image-search-unsplash',
      'image-from-url',
      'document-workflow',
    ]);

    const webSearchCall = nestedToolManager.executeTool.mock.calls.find(([id]) => id === 'web-search');
    expect(webSearchCall?.[1]).toEqual(expect.objectContaining({
      limit: Math.min(config.memory.researchSearchLimit, config.search.maxLimit),
      engine: 'perplexity',
      researchMode: 'deep-research',
    }));

    const finalGenerateCall = nestedToolManager.executeTool.mock.calls.find(([id, params]) => (
      id === 'document-workflow' && params.action === 'generate'
    ));
    expect(finalGenerateCall?.[1]).toEqual(expect.objectContaining({
      presentation: expect.objectContaining({
        slides: expect.arrayContaining([
          expect.objectContaining({
            imageUrl: 'https://images.example.com/halifax.jpg',
            imageSource: 'Jane Doe / Unsplash',
          }),
        ]),
      }),
      sources: expect.arrayContaining([
        expect.objectContaining({
          sourceUrl: 'https://travel.example.com/packages',
          kind: 'web-fetch',
          content: expect.stringContaining('Weekend package: $799'),
        }),
      ]),
    }));
    expect(result.data.document).toEqual(expect.objectContaining({
      filename: 'halifax-travel-pricing.pptx',
      downloadUrl: '/api/documents/deck-1/download',
    }));
  });

  test('refines later deep research passes from stored research-note keywords', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const nestedToolManager = {
      executeTool: jest.fn(async (id, params) => {
        if (id === 'document-workflow' && params.action === 'recommend') {
          return {
            success: true,
            data: {
              recommendation: {
                inferredType: 'presentation',
                recommendedFormat: 'pptx',
              },
            },
          };
        }

        if (id === 'document-workflow' && params.action === 'plan') {
          return {
            success: true,
            data: {
              plan: {
                titleSuggestion: 'Halifax Travel Pricing',
                outline: [
                  { title: 'Title Slide' },
                  { title: 'Pricing Snapshot' },
                ],
              },
            },
          };
        }

        if (id === 'web-search') {
          return {
            success: true,
            data: {
              totalResults: 1,
              results: [{
                title: 'Nova Scotia Travel Packages',
                url: 'https://travel.example.com/packages',
                source: 'travel.example.com',
              }],
            },
          };
        }

        if (id === 'web-fetch') {
          return {
            success: true,
            data: {
              url: 'https://travel.example.com/packages',
              title: 'Nova Scotia Travel Packages',
              body: '<main>Weekend package pricing is $799 and flight costs start at $214.</main>',
            },
          };
        }

        if (id === 'image-search-unsplash') {
          return {
            success: true,
            data: {
              images: [],
            },
          };
        }

        if (id === 'document-workflow' && params.action === 'generate') {
          return {
            success: true,
            data: {
              document: {
                id: 'deck-2',
                filename: 'halifax-research-pass.pptx',
                mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                downloadUrl: '/api/documents/deck-2/download',
              },
            },
          };
        }

        throw new Error(`Unexpected nested tool call: ${id}`);
      }),
    };

    const memoryService = {
      rememberResearchNote: jest.fn().mockResolvedValue('note-1'),
      recallDetailed: jest.fn().mockResolvedValue({
        entries: [
          {
            text: 'Weekend package pricing and flight costs for Halifax travel.',
            metadata: {
              keywords: ['weekend package', 'flight costs', 'halifax travel'],
            },
          },
        ],
      }),
    };

    const documentService = {
      recommendDocumentWorkflow: jest.fn(),
      buildDocumentPlan: jest.fn(),
      aiGenerate: jest.fn(),
      assemble: jest.fn(),
      generatePresentation: jest.fn(),
      inferSlideCount: jest.fn(() => 6),
      aiGenerator: {
        generatePresentationContent: jest.fn(async () => ({
          title: 'Halifax Travel Pricing',
          slides: [
            { layout: 'title', title: 'Halifax Travel Pricing' },
          ],
        })),
      },
    };

    const result = await toolManager.executeTool('deep-research-presentation', {
      prompt: 'Research vacation pricing in Halifax and build a slide deck I can review.',
      researchPasses: 2,
      imageLimit: 0,
    }, {
      documentService,
      toolManager: nestedToolManager,
      memoryService,
      sessionId: 'session-1',
      memoryScope: 'web-chat',
    });

    expect(result.success).toBe(true);
    expect(memoryService.rememberResearchNote).toHaveBeenCalled();
    expect(memoryService.recallDetailed).toHaveBeenCalledWith(
      'Research vacation pricing in Halifax and build a slide deck I can review.',
      expect.objectContaining({
        sessionId: 'session-1',
        memoryScope: 'web-chat',
        profile: 'research',
      }),
    );

    const webSearchCalls = nestedToolManager.executeTool.mock.calls.filter(([id]) => id === 'web-search');
    expect(webSearchCalls).toHaveLength(2);
    expect(webSearchCalls[1][1].query).toContain('weekend package');
  });

  test('creates a workload from structured cron fields when request is omitted', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const createWorkload = jest.fn(async (payload) => ({
      id: 'workload-1',
      ...payload,
    }));

    const result = await toolManager.executeTool('agent-workload', {
      action: 'create_from_scenario',
      prompt: 'summarize blockers from this conversation',
      trigger: {
        type: 'cron',
        expression: '5 23 * * *',
        timezone: 'America/Halifax',
      },
    }, {
      ownerId: 'user-1',
      sessionId: 'session-1',
      timezone: 'America/Halifax',
      workloadService: {
        isAvailable: () => true,
        createWorkload,
      },
    });

    expect(result.success).toBe(true);
    expect(createWorkload).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      title: 'Summarize Blockers From This Conversation',
      prompt: 'summarize blockers from this conversation',
      trigger: {
        type: 'cron',
        expression: '5 23 * * *',
        timezone: 'America/Halifax',
      },
      metadata: expect.objectContaining({
        createdFromScenario: true,
        scenarioRequest: 'summarize blockers from this conversation',
      }),
    }), 'user-1');
    expect(result.data.message).toContain('Every day at 11:05 PM');
  });

  test('passes ownerId context into managed-app actions', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const createApp = jest.fn(async () => ({
      app: { id: 'app-1', slug: 'upload-test' },
      message: 'Queued build.',
    }));

    const result = await toolManager.executeTool('managed-app', {
      action: 'create',
      slug: 'upload-test',
      prompt: 'Create a managed app upload test.',
    }, {
      ownerId: 'user-1',
      sessionId: 'session-1',
      managedAppService: {
        isAvailable: () => true,
        createApp,
      },
    });

    expect(result.success).toBe(true);
    expect(createApp).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'upload-test',
      sessionId: 'session-1',
    }), 'user-1', expect.objectContaining({
      ownerId: 'user-1',
      sessionId: 'session-1',
    }));
  });

  test('does not treat auto-filled slug as the managed-app mutation reference when a public host is present', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const iterateApp = jest.fn(async () => ({
      app: { id: 'app-tetris', slug: 'tetris-game', publicHost: 'awesome.demoserver2.buzz' },
      message: 'Queued iteration.',
    }));

    const result = await toolManager.executeTool('managed-app', {
      action: 'iterate',
      slug: 'update-desktop-css-so-start-game',
      publicHost: 'awesome.demoserver2.buzz',
      prompt: 'Update the existing Tetris app at https://awesome.demoserver2.buzz.',
    }, {
      ownerId: 'user-1',
      sessionId: 'session-1',
      managedAppService: {
        isAvailable: () => true,
        iterateApp,
      },
    });

    expect(result.success).toBe(true);
    expect(iterateApp).toHaveBeenCalledWith(undefined, expect.objectContaining({
      slug: 'update-desktop-css-so-start-game',
      publicHost: 'awesome.demoserver2.buzz',
      sessionId: 'session-1',
    }), 'user-1', expect.objectContaining({
      ownerId: 'user-1',
      sessionId: 'session-1',
    }));
  });

  test('routes sub-agent spawning through the workload service with the caller model', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const spawnSubAgents = jest.fn(async () => ({
      orchestrationId: 'subagent-1',
      taskCount: 2,
      requestedModel: 'gpt-5.4',
      tasks: [
        { workloadId: 'w1', runId: 'r1', title: 'Research facts', status: 'queued' },
        { workloadId: 'w2', runId: 'r2', title: 'Build html', status: 'queued' },
      ],
    }));

    const result = await toolManager.executeTool('agent-delegate', {
      action: 'spawn',
      title: 'Parallel batch',
      tasks: [{
        title: 'Research facts',
        prompt: 'Research the topic and save the findings.',
        writeTargets: ['notes/research.md'],
      }, {
        title: 'Build html',
        prompt: 'Create the html output file.',
        writeTargets: ['frontend/index.html'],
      }],
    }, {
      ownerId: 'user-1',
      sessionId: 'session-1',
      model: 'gpt-5.4',
      workloadService: {
        isAvailable: () => true,
        spawnSubAgents,
      },
    });

    expect(result.success).toBe(true);
    expect(spawnSubAgents).toHaveBeenCalledWith(expect.objectContaining({
      action: 'spawn',
      title: 'Parallel batch',
      tasks: expect.arrayContaining([
        expect.objectContaining({ title: 'Research facts' }),
        expect.objectContaining({ title: 'Build html' }),
      ]),
    }), 'user-1', expect.objectContaining({
      sessionId: 'session-1',
      model: 'gpt-5.4',
      subAgentDepth: 0,
    }));
    expect(result.data.message).toContain('Queued 2 sub-agent tasks');
  });

  test('returns sub-agent orchestration status through the workload service', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const getSubAgentOrchestration = jest.fn(async () => ({
      orchestrationId: 'subagent-1',
      title: 'Parallel batch',
      counts: {
        total: 2,
        active: 1,
        queued: 0,
        running: 1,
        completed: 1,
        failed: 0,
        cancelled: 0,
        idle: 0,
      },
      tasks: [
        { workloadId: 'w1', title: 'Research facts', status: 'completed' },
        { workloadId: 'w2', title: 'Build html', status: 'running' },
      ],
    }));

    const result = await toolManager.executeTool('agent-delegate', {
      action: 'status',
      orchestrationId: 'subagent-1',
    }, {
      ownerId: 'user-1',
      sessionId: 'session-1',
      workloadService: {
        isAvailable: () => true,
        getSubAgentOrchestration,
      },
    });

    expect(result.success).toBe(true);
    expect(getSubAgentOrchestration).toHaveBeenCalledWith('subagent-1', 'user-1', 'session-1');
    expect(result.data.orchestration.counts.running).toBe(1);
  });

  test('infers a cron trigger for create when the prompt still contains schedule text', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const createWorkload = jest.fn(async (payload) => ({
      id: 'workload-2',
      ...payload,
    }));

    const result = await toolManager.executeTool('agent-workload', {
      action: 'create',
      prompt: 'Every weekday at 8:30 AM review the latest repo activity and summarize blockers.',
    }, {
      ownerId: 'user-1',
      sessionId: 'session-1',
      timezone: 'America/Halifax',
      workloadService: {
        isAvailable: () => true,
        createWorkload,
      },
    });

    expect(result.success).toBe(true);
    expect(createWorkload).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      title: 'Review The Latest Repo Activity',
      prompt: 'Every weekday at 8:30 AM review the latest repo activity and summarize blockers.',
      trigger: {
        type: 'cron',
        expression: '30 8 * * 1-5',
        timezone: 'America/Halifax',
      },
      metadata: expect.objectContaining({
        createdFromScenario: true,
        scenarioRequest: 'Every weekday at 8:30 AM review the latest repo activity and summarize blockers.',
      }),
    }), 'user-1');
    expect(result.data.message).toContain('Every weekday at 8:30 AM');
  });

  test('extracts a structured remote execution from a scheduled server command request', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const createWorkload = jest.fn(async (payload) => ({
      id: 'workload-remote-1',
      ...payload,
    }));

    const result = await toolManager.executeTool('agent-workload', {
      action: 'create_from_scenario',
      request: 'Run `date` on the server in 5 minutes.',
      timezone: 'UTC',
    }, {
      ownerId: 'user-1',
      sessionId: 'session-1',
      timezone: 'UTC',
      now: '2026-04-02T09:00:00.000Z',
      workloadService: {
        isAvailable: () => true,
        createWorkload,
        sessionStore: {
          getOwned: jest.fn(async () => ({
            id: 'session-1',
            metadata: {
              lastSshTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
              },
            },
          })),
        },
      },
    });

    expect(result.success).toBe(true);
    expect(createWorkload).toHaveBeenCalledWith(expect.objectContaining({
      execution: {
        tool: 'remote-command',
        params: {
          host: '10.0.0.5',
          username: 'ubuntu',
          port: 22,
          command: 'date',
        },
      },
      trigger: expect.objectContaining({
        type: 'once',
        runAt: '2026-04-02T09:05:00.000Z',
      }),
    }), 'user-1');
  });

  test('canonicalizes malformed remote command workload params into a scheduled structured create', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const createWorkload = jest.fn(async (payload) => ({
      id: 'workload-remote-2',
      ...payload,
    }));

    const result = await toolManager.executeTool('agent-workload', {
      action: 'create_from_scenario',
      command: 'date',
      schedule: 'in 5 minutes',
      title: 'Check remote time',
      tool: 'remote-command',
    }, {
      ownerId: 'user-1',
      sessionId: 'session-1',
      timezone: 'UTC',
      now: '2026-04-02T09:00:00.000Z',
      workloadService: {
        isAvailable: () => true,
        createWorkload,
        sessionStore: {
          getOwned: jest.fn(async () => ({
            id: 'session-1',
            metadata: {
              lastSshTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
              },
            },
          })),
        },
      },
    });

    expect(result.success).toBe(true);
    expect(createWorkload).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Check remote time',
      trigger: {
        type: 'once',
        runAt: '2026-04-02T09:05:00.000Z',
      },
      execution: {
        tool: 'remote-command',
        params: {
          host: '10.0.0.5',
          username: 'ubuntu',
          port: 22,
          command: 'date',
        },
      },
      metadata: expect.objectContaining({
        createdFromScenario: true,
        scenarioRequest: 'Run `date` on the server in 5 minutes',
      }),
    }), 'user-1');
  });

  test('maps brutal builder docx requests to html output', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const createWorkload = jest.fn(async (payload) => ({
      id: 'workload-brutal-docx-1',
      ...payload,
    }));

    const result = await toolManager.executeTool('agent-workload', {
      action: 'create',
      prompt: 'Use brutal builder to make a DOCX executive brief for the launch plan and take a couple passes quickly.',
    }, {
      ownerId: 'user-1',
      sessionId: 'session-1',
      timezone: 'UTC',
      now: '2026-04-02T09:00:00.000Z',
      workloadService: {
        isAvailable: () => true,
        createWorkload,
      },
    });

    expect(result.success).toBe(true);
    expect(createWorkload).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        requestedOutputFormat: 'html',
        resolvedOutputFormat: 'html',
        defaultOutputFormat: 'html',
      }),
    }), 'user-1');
    expect(result.data.message).not.toContain('DOCX output was requested');
  });

  test('reconstructs a fragmented scheduled workload request from recent transcript context', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const createWorkload = jest.fn(async (payload) => ({
      id: 'workload-fragmented-1',
      ...payload,
    }));

    const result = await toolManager.executeTool('agent-workload', {
      action: 'create_from_scenario',
      request: 'run it five minutes from now',
    }, {
      ownerId: 'user-1',
      sessionId: 'session-1',
      timezone: 'UTC',
      now: '2026-04-02T09:00:00.000Z',
      recentMessages: [
        { role: 'user', content: 'gather information on the k3s cluster on the server' },
      ],
      workloadService: {
        isAvailable: () => true,
        createWorkload,
      },
    });

    expect(result.success).toBe(true);
    expect(createWorkload).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('gather information on the k3s cluster on the server'),
      trigger: {
        type: 'once',
        runAt: '2026-04-02T09:05:00.000Z',
      },
      metadata: expect.objectContaining({
        createdFromScenario: true,
        scenarioRequest: expect.stringContaining('gather information on the k3s cluster on the server'),
      }),
    }), 'user-1');
  });

  test('persists the caller model on created workloads so deferred runs can reuse it', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const createWorkload = jest.fn(async (payload) => ({
      id: 'workload-model-1',
      ...payload,
    }));

    const result = await toolManager.executeTool('agent-workload', {
      action: 'create_from_scenario',
      request: 'Run `date` on the server in 5 minutes.',
    }, {
      ownerId: 'user-1',
      sessionId: 'session-1',
      timezone: 'UTC',
      now: '2026-04-02T09:00:00.000Z',
      model: 'gpt-5.3-instant',
      workloadService: {
        isAvailable: () => true,
        createWorkload,
      },
    });

    expect(result.success).toBe(true);
    expect(createWorkload).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        requestedModel: 'gpt-5.3-instant',
      }),
    }), 'user-1');
  });

  test('rejects ambiguous scenario requests instead of silently creating a manual workload', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const createWorkload = jest.fn(async (payload) => ({
      id: 'workload-3',
      ...payload,
    }));

    const result = await toolManager.executeTool('agent-workload', {
      action: 'create_from_scenario',
      request: 'Can you run one that',
    }, {
      ownerId: 'user-1',
      sessionId: 'session-1',
      timezone: 'America/Halifax',
      workloadService: {
        isAvailable: () => true,
        createWorkload,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('explicit manual request');
    expect(createWorkload).not.toHaveBeenCalled();
  });

  test('returns project plans through the workload tool', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const getProjectPlan = jest.fn(async () => ({
      title: 'Long project',
      milestones: [{ id: 'm1', title: 'Approve the rollout plan' }],
    }));

    const result = await toolManager.executeTool('agent-workload', {
      action: 'get_project',
      workloadId: 'workload-1',
    }, {
      ownerId: 'user-1',
      sessionId: 'session-1',
      workloadService: {
        isAvailable: () => true,
        getProjectPlan,
      },
    });

    expect(result.success).toBe(true);
    expect(getProjectPlan).toHaveBeenCalledWith('workload-1', 'user-1');
    expect(result.data.project.title).toBe('Long project');
  });

  test('updates project plans through the workload tool', async () => {
    const toolManager = new ToolManager();
    await toolManager.initialize();

    const updateProjectPlan = jest.fn(async () => ({
      workload: { id: 'workload-1' },
      project: {
        title: 'Long project',
        milestones: [{ id: 'm1', title: 'Approve the rollout plan', status: 'completed' }],
      },
    }));

    const result = await toolManager.executeTool('agent-workload', {
      action: 'update_project',
      workloadId: 'workload-1',
      project: {
        milestones: [{ id: 'm1', title: 'Approve the rollout plan', status: 'completed' }],
      },
      changeReason: {
        type: 'status_update',
        summary: 'Marked the milestone complete.',
      },
    }, {
      ownerId: 'user-1',
      sessionId: 'session-1',
      workloadService: {
        isAvailable: () => true,
        updateProjectPlan,
      },
    });

    expect(result.success).toBe(true);
    expect(updateProjectPlan).toHaveBeenCalledWith(
      'workload-1',
      'user-1',
      expect.objectContaining({
        milestones: [expect.objectContaining({ status: 'completed' })],
      }),
      expect.objectContaining({
        changeReason: expect.objectContaining({
          type: 'status_update',
        }),
      }),
    );
  });
});
