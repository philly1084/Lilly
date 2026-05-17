jest.mock('fs', () => ({
  constants: {
    F_OK: 0,
    W_OK: 2,
  },
  accessSync: jest.fn(() => undefined),
  promises: {
    mkdir: jest.fn().mockResolvedValue(),
    writeFile: jest.fn().mockResolvedValue(),
    readFile: jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  },
}));

jest.mock('../../config', () => ({
  config: {
    auth: {
      username: '',
      password: '',
      jwtSecret: '',
    },
    deploy: {
      defaultRepositoryUrl: 'https://github.com/philly1084/KimiBuilt.git',
      defaultTargetDirectory: '/opt/kimibuilt',
      defaultManifestsPath: 'k8s',
      defaultNamespace: 'kimibuilt',
      defaultDeployment: 'backend',
      defaultContainer: 'backend',
      defaultBranch: 'master',
      defaultPublicDomain: 'demoserver2.buzz',
      defaultIngressClassName: 'traefik',
      defaultTlsClusterIssuer: 'letsencrypt-prod',
    },
    gitea: {
      enabled: false,
      baseURL: 'https://gitea.demoserver2.buzz',
      token: 'gitea-token',
      webhookSecret: 'webhook-secret',
      org: 'agent-apps',
      registryHost: '',
      registryUsername: 'builder',
      registryPassword: 'registry-password',
    },
    gitlab: {
      enabled: true,
      baseURL: 'https://gitlab.demoserver2.buzz',
      token: 'gitlab-token',
      webhookSecret: 'webhook-secret',
      org: 'agent-apps',
      registryHost: 'registry.gitlab.demoserver2.buzz',
      registryUsername: 'builder',
      registryPassword: 'registry-password',
      runnerToken: 'runner-token',
    },
    managedApps: {
      enabled: true,
      deployTarget: 'ssh',
      appBaseDomain: 'demoserver2.buzz',
      namespacePrefix: 'app-',
      platformNamespace: 'agent-platform',
      platformRuntimeSecretName: 'agent-platform-runtime',
      defaultBranch: 'main',
      defaultContainerPort: 80,
      registryPullSecretName: 'gitlab-registry-credentials',
      webhookEndpointPath: '/api/integrations/gitlab/build-events',
    },
  },
}));

jest.mock('../../agent-soul', () => ({
  getEffectiveSoulConfig: jest.fn((settings = {}) => ({
    enabled: settings.enabled !== false,
    displayName: settings.displayName || 'Agent Soul',
    content: '# Soul\n',
    defaultContent: '# Default Soul\n',
    filePath: 'soul.md',
    absoluteFilePath: 'C:/Users/phill/KimiBuilt/soul.md',
    updatedAt: '2026-04-04T00:00:00.000Z',
    source: 'file',
  })),
  writeSoulFile: jest.fn(),
  resetSoulFile: jest.fn(),
}));

jest.mock('../../agent-notes', () => ({
  getEffectiveAgentNotesConfig: jest.fn((settings = {}) => ({
    enabled: settings.enabled !== false,
    displayName: settings.displayName || 'Carryover Notes',
    content: '# Carryover Notes\n',
    defaultContent: '# Default Carryover Notes\n',
    filePath: 'agent-notes.md',
    absoluteFilePath: 'C:/Users/phill/KimiBuilt/agent-notes.md',
    updatedAt: '2026-04-04T00:00:00.000Z',
    source: 'file',
    characterLimit: 4000,
    characterCount: 19,
  })),
  writeAgentNotesFile: jest.fn(),
  resetAgentNotesFile: jest.fn(),
}));

jest.mock('../../postgres', () => ({
  postgres: {
    getStatus: jest.fn(() => ({ initialized: false })),
    query: jest.fn(),
  },
}));

jest.mock('../../audio/audio-processing-service', () => ({
  audioProcessingService: {
    updateConfig: jest.fn(),
  },
}));

describe('settings.controller personality support', () => {
  let controller;
  let fsPromises;
  let soulHelpers;
  let agentNotesHelpers;
  let consoleLogSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    fsPromises = require('fs').promises;
    soulHelpers = require('../../agent-soul');
    agentNotesHelpers = require('../../agent-notes');
    controller = require('./settings.controller');
    controller.settings = controller.getDefaultSettings();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('update writes soul.md content and merges personality metadata', async () => {
    const req = {
      body: {
        personality: {
          enabled: false,
          displayName: 'Quiet Soul',
          content: '# Quiet soul\n',
        },
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    await controller.update(req, res);

    expect(soulHelpers.writeSoulFile).toHaveBeenCalledWith('# Quiet soul\n');
    expect(controller.settings.personality).toEqual({
      enabled: false,
      displayName: 'Quiet Soul',
    });
    expect(fsPromises.writeFile).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        personality: expect.objectContaining({
          enabled: false,
          displayName: 'Quiet Soul',
          content: '# Soul\n',
          filePath: 'soul.md',
        }),
      }),
    }));
  });

  test('update writes agent-notes.md content and merges carryover metadata', async () => {
    const req = {
      body: {
        agentNotes: {
          enabled: false,
          displayName: 'Ops Carryover',
          content: '# Carryover Notes\n- Phil prefers concise summaries.\n',
        },
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    await controller.update(req, res);

    expect(agentNotesHelpers.writeAgentNotesFile).toHaveBeenCalledWith('# Carryover Notes\n- Phil prefers concise summaries.\n');
    expect(controller.settings.agentNotes).toEqual({
      enabled: false,
      displayName: 'Ops Carryover',
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        agentNotes: expect.objectContaining({
          enabled: false,
          displayName: 'Ops Carryover',
          content: '# Carryover Notes\n',
          filePath: 'agent-notes.md',
          characterLimit: 4000,
        }),
      }),
    }));
  });

  test('getPublicSettings exposes effective personality and carryover metadata and strips ssh password', () => {
    controller.settings.integrations.ssh.password = 'super-secret';

    const publicSettings = controller.getPublicSettings();

    expect(soulHelpers.getEffectiveSoulConfig).toHaveBeenCalledWith(controller.settings.personality);
    expect(agentNotesHelpers.getEffectiveAgentNotesConfig).toHaveBeenCalledWith(controller.settings.agentNotes);
    expect(publicSettings.personality).toEqual(expect.objectContaining({
      enabled: true,
      displayName: 'Agent Soul',
      content: '# Soul\n',
      filePath: 'soul.md',
    }));
    expect(publicSettings.agentNotes).toEqual(expect.objectContaining({
      enabled: true,
      displayName: 'Carryover Notes',
      content: '# Carryover Notes\n',
      filePath: 'agent-notes.md',
    }));
    expect(publicSettings.integrations.ssh.password).toBeUndefined();
    expect(publicSettings.orchestration).toEqual(expect.objectContaining({
      enabled: true,
      defaultModel: 'gpt-5.5',
      plannerModel: 'gpt-5.5',
      fallbackModels: ['gemini-3.1-pro', 'groq-compound'],
    }));
  });

  test('normalizes orchestration model routing settings for the admin dashboard', async () => {
    const req = {
      body: {
        orchestration: {
          enabled: true,
          defaultModel: ' gpt-5.5 ',
          plannerModel: ' gpt-5.5 ',
          synthesisModel: '',
          repairModel: 'gpt-5.5',
          evaluatorModel: ' gpt-5.4-mini ',
          fallbackModels: 'gemini-3.1-pro, groq-compound, gemini-3.1-pro',
          plannerReasoningEffort: 'high',
          synthesisReasoningEffort: 'medium',
          repairReasoningEffort: 'high',
          evaluatorReasoningEffort: 'medium',
          enableAlignmentEvaluator: true,
          applyAlignmentGuidance: false,
        },
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    await controller.update(req, res);

    expect(controller.settings.orchestration).toEqual(expect.objectContaining({
      enabled: true,
      defaultModel: 'gpt-5.5',
      plannerModel: 'gpt-5.5',
      repairModel: 'gpt-5.5',
      evaluatorModel: 'gpt-5.4-mini',
      fallbackModels: ['gemini-3.1-pro', 'groq-compound'],
      plannerReasoningEffort: 'high',
      evaluatorReasoningEffort: 'medium',
      enableAlignmentEvaluator: true,
      applyAlignmentGuidance: false,
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        orchestration: expect.objectContaining({
          plannerModel: 'gpt-5.5',
          evaluatorModel: 'gpt-5.4-mini',
          fallbackModels: ['gemini-3.1-pro', 'groq-compound'],
          applyAlignmentGuidance: false,
        }),
      }),
    }));
  });

  test('normalizes privacy PII workflow criteria and detector actions', async () => {
    const req = {
      body: {
        privacyPii: {
          enabled: true,
          webChatEnabled: true,
          placeholderMode: 'stable',
          reintroductionMode: 'admin',
          failClosed: true,
          detectors: ['email', 'phone', 'personName'],
          detectorActions: {
            email: 'vault-placeholder',
            phone: 'mask',
            personName: 'remove',
            unknown: 'made-up',
          },
          enablePersonNames: true,
          auditProfile: 'strict',
          auditCriteria: {
            requiredDetectors: ['email', 'phone', 'personName'],
            requireVaultKey: true,
          },
        },
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    await controller.update(req, res);

    expect(controller.settings.privacyPii).toEqual(expect.objectContaining({
      enabled: true,
      placeholderMode: 'stable-per-value',
      reintroductionMode: 'admin-only',
      auditProfile: 'strict',
      enablePersonNames: true,
      detectorActions: expect.objectContaining({
        email: 'vault-placeholder',
        phone: 'mask',
        personName: 'remove',
        unknown: 'vault-placeholder',
      }),
    }));
    expect(controller.settings.privacyPii.auditCriteria.requiredDetectors).toEqual(['email', 'phone', 'personName']);
  });

  test('defaults PII protection on with opaque placeholder IDs', () => {
    const defaults = controller.getDefaultSettings().privacyPii;

    expect(defaults).toEqual(expect.objectContaining({
      defaultsVersion: 3,
      enabled: true,
      webChatEnabled: true,
      placeholderMode: 'opaque-random',
      failClosed: true,
      enablePersonNames: true,
      auditProfile: 'strict',
    }));
    expect(defaults.detectors).toEqual(expect.arrayContaining(['personName', 'organization']));
  });

  test('upgrades old persisted PII defaults to enabled opaque identity protection on restart', () => {
    const upgraded = controller.upgradeStoredSettingsDefaults({
      privacyPii: {
        enabled: false,
        placeholderMode: 'typed-random',
        failClosed: true,
      },
    });

    expect(upgraded.privacyPii).toEqual(expect.objectContaining({
      defaultsVersion: 3,
      enabled: true,
      placeholderMode: 'opaque-random',
      enablePersonNames: true,
      auditProfile: 'strict',
    }));
    expect(upgraded.privacyPii.detectors).toEqual(expect.arrayContaining(['personName', 'organization']));
    expect(upgraded.privacyPii.auditCriteria.requiredDetectors).toEqual(expect.arrayContaining(['personName', 'organization']));
  });

  test('upgrades persisted v2 PII defaults to include names and organizations', () => {
    const upgraded = controller.upgradeStoredSettingsDefaults({
      privacyPii: {
        defaultsVersion: 2,
        enabled: true,
        placeholderMode: 'opaque-random',
        detectors: ['email', 'phone', 'dateOfBirth'],
        enablePersonNames: false,
        auditProfile: 'baseline',
        auditCriteria: {
          requiredDetectors: ['email', 'phone', 'dateOfBirth'],
        },
      },
    });

    expect(upgraded.privacyPii).toEqual(expect.objectContaining({
      defaultsVersion: 3,
      enabled: true,
      placeholderMode: 'opaque-random',
      enablePersonNames: true,
      auditProfile: 'strict',
    }));
    expect(upgraded.privacyPii.detectors).toEqual(expect.arrayContaining(['email', 'phone', 'dateOfBirth', 'personName', 'organization']));
    expect(upgraded.privacyPii.auditCriteria.requiredDetectors).toEqual(expect.arrayContaining(['personName', 'organization']));
  });

  test('previews PII cleanup without echoing raw matched values', () => {
    const req = {
      body: {
        sampleText: 'Email jane@example.com or call 902-555-0199.',
        settings: {
          detectors: ['email', 'phone'],
          detectorActions: {
            email: 'vault-placeholder',
            phone: 'mask',
          },
          auditCriteria: {
            requiredDetectors: ['email', 'phone'],
          },
        },
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    controller.previewPrivacyPii(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        matchCount: 2,
        placeholderMode: 'opaque-random',
        exposesTypeContext: false,
        sanitizedText: expect.stringContaining('[[PII:PREVIEW_1]]'),
        countsByAction: expect.objectContaining({
          'vault-placeholder': 1,
          mask: 1,
        }),
      }),
    }));
    const payload = res.json.mock.calls[0][0].data;
    expect(payload.sanitizedText).not.toContain('EMAIL');
    expect(payload.sanitizedText).not.toContain('PHONE');
    expect(payload.sanitizedText).not.toContain('jane@example.com');
    expect(payload.sanitizedText).not.toContain('902-555-0199');
  });

  test('previews grounded identity dictionary terms as non-restorable masks', () => {
    const req = {
      body: {
        sampleText: 'Sample Person works at Sample Employer.',
        settings: {
          detectors: [],
          dictionary: [
            { type: 'personName', value: 'Sample Person', action: 'mask' },
            { type: 'employer', value: 'Sample Employer', action: 'mask' },
          ],
          auditCriteria: {
            requiredDetectors: [],
          },
        },
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    controller.previewPrivacyPii(req, res);

    const payload = res.json.mock.calls[0][0].data;
    expect(payload.sanitizedText).toContain('[[PII:PREVIEW_1]]');
    expect(payload.sanitizedText).toContain('[[PII:PREVIEW_2]]');
    expect(payload.sanitizedText).not.toContain('PERSONNAME');
    expect(payload.sanitizedText).not.toContain('EMPLOYER');
    expect(payload.sanitizedText).not.toContain('Sample Person');
    expect(payload.sanitizedText).not.toContain('Sample Employer');
    expect(payload.matches).toEqual([
      expect.objectContaining({ type: 'personName', action: 'mask', restorable: false }),
      expect.objectContaining({ type: 'employer', action: 'mask', restorable: false }),
    ]);
  });

  test('previews person names and DOB values from built-in detectors', () => {
    const req = {
      body: {
        sampleText: 'My name is Sample Person and DOB: 1984-07-04.',
        settings: {
          detectors: ['personName', 'dateOfBirth'],
          enablePersonNames: true,
          detectorActions: {
            personName: 'mask',
            dateOfBirth: 'mask',
          },
          auditCriteria: {
            requiredDetectors: ['personName', 'dateOfBirth'],
          },
        },
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    controller.previewPrivacyPii(req, res);

    const payload = res.json.mock.calls[0][0].data;
    expect(payload.sanitizedText).toContain('My name is [[PII:PREVIEW_1]]');
    expect(payload.sanitizedText).toContain('DOB: [[PII:PREVIEW_2]]');
    expect(payload.sanitizedText).not.toContain('PERSONNAME');
    expect(payload.sanitizedText).not.toContain('DATEOFBIRTH');
    expect(payload.sanitizedText).not.toContain('Sample Person');
    expect(payload.sanitizedText).not.toContain('1984-07-04');
  });

  test('applies updated podcast audio asset paths to the live mixer runtime', async () => {
    const { audioProcessingService } = require('../../audio/audio-processing-service');
    const req = {
      body: {
        audioProcessing: {
          podcastIntroPath: 'C:/audio/intro.wav',
          podcastMusicBedPath: 'C:/audio/music.wav',
        },
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    await controller.update(req, res);

    expect(audioProcessingService.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      podcastIntroPath: 'C:/audio/intro.wav',
      podcastMusicBedPath: 'C:/audio/music.wav',
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
    }));
  });

  test('prefers stored deploy defaults over config defaults and exposes them publicly', () => {
    controller.settings.integrations.deploy.publicDomain = 'apps.demoserver2.buzz';
    controller.settings.integrations.deploy.namespace = 'web';
    controller.settings.integrations.deploy.deployment = 'site';

    const effective = controller.getEffectiveDeployConfig();
    const publicSettings = controller.getPublicSettings();

    expect(effective).toEqual(expect.objectContaining({
      publicDomain: 'apps.demoserver2.buzz',
      namespace: 'web',
      deployment: 'site',
      ingressClassName: 'traefik',
      tlsClusterIssuer: 'letsencrypt-prod',
    }));
    expect(publicSettings.integrations.deploy).toEqual(expect.objectContaining({
      publicDomain: 'apps.demoserver2.buzz',
      namespace: 'web',
      deployment: 'site',
    }));
  });

  test('exposes managed app control-plane settings without leaking secrets', () => {
    controller.settings.integrations.gitlab.baseURL = 'https://gitlab.alt.example';
    controller.settings.integrations.gitlab.registryHost = 'registry.alt.example';
    controller.settings.integrations.managedApps.deployTarget = 'SSH';
    controller.settings.integrations.managedApps.appBaseDomain = 'apps.alt.example';
    controller.settings.integrations.managedApps.namespacePrefix = 'edge-';

    const publicSettings = controller.getPublicSettings();

    expect(publicSettings.integrations.gitlab).toEqual(expect.objectContaining({
      configured: true,
      baseURL: 'https://gitlab.alt.example',
      registryHost: 'registry.alt.example',
      hasToken: true,
      hasWebhookSecret: true,
      hasRunnerToken: true,
    }));
    expect(publicSettings.integrations.gitlab.token).toBeUndefined();
    expect(publicSettings.integrations.gitlab.webhookSecret).toBeUndefined();
    expect(publicSettings.integrations.managedApps).toEqual(expect.objectContaining({
      deployTarget: 'ssh',
      appBaseDomain: 'apps.alt.example',
      namespacePrefix: 'edge-',
      platformNamespace: 'agent-platform',
      platformRuntimeSecretName: 'agent-platform-runtime',
    }));
  });

  test('effective managed app config prefers ssh when remote defaults are configured', () => {
    controller.settings.integrations.ssh = {
      enabled: true,
      host: '10.0.0.5',
      port: 22,
      username: 'ubuntu',
      password: 'secret',
      privateKeyPath: '',
    };
    controller.settings.integrations.managedApps.deployTarget = 'in-cluster';

    const effective = controller.getEffectiveManagedAppsConfig();

    expect(effective.deployTarget).toBe('ssh');
  });

  test('resetting the personality restores default settings and soul file content', async () => {
    controller.settings.personality = {
      enabled: false,
      displayName: 'Custom Soul',
    };

    const req = {
      body: {
        section: 'personality',
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    await controller.reset(req, res);

    expect(soulHelpers.resetSoulFile).toHaveBeenCalled();
    expect(controller.settings.personality).toEqual({
      enabled: true,
      displayName: 'Agent Soul',
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      message: 'personality settings reset',
    }));
  });

  test('resetting the carryover notes restores default settings and notes file content', async () => {
    controller.settings.agentNotes = {
      enabled: false,
      displayName: 'Custom Carryover',
    };

    const req = {
      body: {
        section: 'agentNotes',
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    await controller.reset(req, res);

    expect(agentNotesHelpers.resetAgentNotesFile).toHaveBeenCalled();
    expect(controller.settings.agentNotes).toEqual({
      enabled: true,
      displayName: 'Carryover Notes',
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      message: 'agentNotes settings reset',
    }));
  });
});
