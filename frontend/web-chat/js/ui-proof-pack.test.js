const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadHelper() {
  const source = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8')
    .replace(/const uiHelpers = new UIHelpers\(\);[\s\S]*$/, 'globalThis.UIHelpers = UIHelpers;');
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
            return String(this._text || '')
              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
          },
        });
        return element;
      },
    },
    navigator: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    marked: { setOptions: () => {}, Renderer: function Renderer() {}, use: () => {}, parse: (value) => value },
    DOMPurify: { sanitize: (html) => html },
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'ui.js' });
  return Object.create(context.UIHelpers.prototype);
}

describe('Web Chat proof pack and artifact lineage', () => {
  test('remote autonomy requires an explicit saved opt-in', () => {
    const helper = loadHelper();
    for (const value of [null, undefined, '', ' ', 'false', '0', 'off', 'invalid']) {
      expect(helper.parseRemoteBuildAutonomyPreference(value)).toBe(false);
    }
    for (const value of ['true', '1', 'yes', 'on']) {
      expect(helper.parseRemoteBuildAutonomyPreference(value)).toBe(true);
    }
  });
  test('renders typed run evidence, usage, approvals, links, and missing gates honestly', () => {
    const helper = loadHelper();
    const message = {
      agentRun: {
        id: 'run-7',
        evidence: {
          checks: [{ label: 'Focused tests', passed: true }],
          screenshots: [{ label: 'Desktop route', url: '/ui-checks/desktop.png', verified: true }],
        },
        approvals: [{ label: 'Deploy approval', status: 'approved' }],
        outputs: [{ id: 'artifact-2', title: 'Launch brief', parentArtifactId: 'artifact-1', revision: 4 }],
        usage: { durationMs: 65000, costUsd: 0.0123 },
      },
      proofPack: {
        summary: 'Source, artifact, and browser checks are attached.',
        urls: [{ label: 'Live route', url: 'https://demo.example.test', verified: true }],
        missingGates: ['Mobile screenshot'],
      },
    };

    const normalized = helper.normalizeProofPack(message);
    const markup = helper.buildProofPackMarkup(message);

    expect(normalized.status).toBe('partial');
    expect(normalized.durationMs).toBe(65000);
    expect(normalized.costUsd).toBe(0.0123);
    expect(markup).toContain('Proof needs attention');
    expect(markup).toContain('Focused tests');
    expect(markup).toContain('Live route');
    expect(markup).toContain('Mobile screenshot');
    expect(markup).toContain('Open in Notes');
    expect(markup).toContain('parentArtifactId=artifact-1');
    expect(markup).toContain('revision=4');
  });

  test('rejects unsafe proof links and exposes an honest empty state', () => {
    const helper = loadHelper();
    const markup = helper.buildProofPackMarkup({
      proofPack: { urls: [{ label: 'Unsafe', url: 'javascript:alert(1)' }] },
    });

    expect(markup).not.toContain('javascript:');
    expect(helper.buildProofPackMarkup({}, { empty: true })).toContain('No typed proof');
  });

  test('builds Notes and Canvas URLs with stable mission lineage', () => {
    const helper = loadHelper();
    const artifact = { id: 'artifact current', parentArtifactId: 'artifact parent', revision: 2 };

    const notesUrl = helper.buildArtifactLineageUrl('notes', artifact, 'mission 1');
    const canvasUrl = helper.buildArtifactLineageUrl('canvas', artifact, 'mission 1');

    expect(notesUrl).toBe('/notes/?artifactId=artifact+current&missionId=mission+1&parentArtifactId=artifact+parent&revision=2');
    expect(canvasUrl).toBe('/canvas/?artifactId=artifact+current&missionId=mission+1&parentArtifactId=artifact+parent&revision=2');
  });

  test('hides saved download-only rows from the artifact lineage tray', () => {
    const helper = loadHelper();
    const fakeMarkup = helper.buildArtifactLineageTrayMarkup([{
      id: 'managed-app-saved-1',
      downloadUrl: '/api/artifacts/managed-app-saved-1/download',
    }]);
    const realMarkup = helper.buildArtifactLineageTrayMarkup([{
      id: 'artifact-report-1',
      filename: 'report.pdf',
      downloadUrl: '/api/artifacts/artifact-report-1/download',
    }]);

    expect(fakeMarkup).toBe('');
    expect(realMarkup).toContain('Open in Notes');
    expect(realMarkup).toContain('Open in Canvas');
    expect(realMarkup).toContain('Build with Agent');
    expect(realMarkup).toContain('data-artifact-lineage-action="build-agent"');
    expect(realMarkup).not.toContain('data-artifact-lineage-action="deploy"');
  });

  test('reads the canonical run proof pack and typed verdicts', () => {
    const helper = loadHelper();
    const normalized = helper.normalizeProofPack({
      agentRun: {
        id: 'run-canonical',
        proofPack: {
          status: 'verified',
          checks: [{ label: 'Tests', verdict: 'pass' }],
          screenshots: ['/ui-checks/mobile.png'],
          missingGates: [],
        },
      },
    });

    expect(normalized.status).toBe('verified');
    expect(normalized.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Tests', status: 'passed' }),
    ]));
  });
});
