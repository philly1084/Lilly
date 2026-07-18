'use strict';

const {
  ARTIFACT_STRUCTURAL_QUALITY_VERSION,
  validateResultArtifactSet,
} = require('./artifact-quality-gate');

function resultFile(filePath, mimeType, content, role = 'deliverable') {
  return {
    path: filePath,
    filename: filePath.split('/').pop(),
    mimeType,
    role,
    buffer: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
  };
}

function blockerCodes(report) {
  return report.blockers.map((blocker) => blocker.code);
}

describe('artifact structural quality gate', () => {
  test('passes valid HTML, JSON, XML, SVG, and a closed multi-file site', () => {
    const report = validateResultArtifactSet({
      files: [
        resultFile(
          'index.html',
          'text/html; charset=utf-8',
          `<!doctype html>
          <html><head>
            <link rel="stylesheet" href="./styles.css">
            <script type="module" src="./app.js"></script>
          </head><body>
            <main><h1>Ready</h1><img src="assets/hero.png" alt="Abstract hero"></main>
          </body></html>`,
          'site-entry',
        ),
        resultFile('styles.css', 'text/css', 'main { background: url("./assets/background.png"); }', 'site-file'),
        resultFile('app.js', 'text/javascript', 'import "./module.js"; console.log("ready");', 'site-file'),
        resultFile('module.js', 'application/javascript', 'export const ready = true;', 'site-file'),
        resultFile('assets/hero.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'site-file'),
        resultFile('assets/background.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]), 'site-file'),
        resultFile('data.json', 'application/ld+json', '{"ready":true}'),
        resultFile('brief.xml', 'application/xml', '<?xml version="1.0"?><brief><status>ready</status></brief>'),
        resultFile(
          'diagram.svg',
          'image/svg+xml',
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><title>Ready</title><circle cx="10" cy="10" r="8"/></svg>',
        ),
      ],
    });

    expect(report).toMatchObject({
      version: ARTIFACT_STRUCTURAL_QUALITY_VERSION,
      status: 'passed',
      blockers: [],
      site: {
        enabled: true,
        entries: ['index.html'],
        checkedReferences: 5,
      },
    });
    expect(report.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'index.html', format: 'html' }),
      expect.objectContaining({ path: 'data.json', format: 'json' }),
      expect.objectContaining({ path: 'brief.xml', format: 'xml' }),
      expect.objectContaining({ path: 'diagram.svg', format: 'svg' }),
    ]));
  });

  test('blocks invalid UTF-8 and NUL in textual outputs', () => {
    const report = validateResultArtifactSet({
      files: [
        resultFile('invalid.txt', 'text/plain', Buffer.from([0xc3, 0x28])),
        resultFile('nul.xml', 'application/xml', Buffer.from('<root>\0</root>', 'utf8')),
      ],
    });

    expect(report.status).toBe('blocked');
    expect(blockerCodes(report)).toEqual(expect.arrayContaining([
      'REMOTE_AGENT_ARTIFACT_TEXT_UTF8_INVALID',
      'REMOTE_AGENT_ARTIFACT_TEXT_NUL',
    ]));
  });

  test('parses JSON strictly', () => {
    const report = validateResultArtifactSet({
      files: [resultFile('result.json', 'application/json', '{"unfinished":}')],
    });

    expect(report.status).toBe('blocked');
    expect(blockerCodes(report)).toContain('REMOTE_AGENT_ARTIFACT_JSON_INVALID');
  });

  test('rejects XML DTD or entity declarations and malformed XML', () => {
    const report = validateResultArtifactSet({
      files: [
        resultFile(
          'xxe.xml',
          'application/xml',
          '<!DOCTYPE brief [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><brief>&xxe;</brief>',
        ),
        resultFile('malformed.xml', 'text/xml', '<brief><title>Broken</brief>'),
      ],
    });

    expect(report.status).toBe('blocked');
    expect(blockerCodes(report)).toEqual(expect.arrayContaining([
      'REMOTE_AGENT_ARTIFACT_XML_DTD_FORBIDDEN',
      'REMOTE_AGENT_ARTIFACT_XML_INVALID',
    ]));
  });

  test.each([
    [
      'wrong root',
      '<html xmlns="http://www.w3.org/2000/svg"><body/></html>',
      'REMOTE_AGENT_ARTIFACT_SVG_ROOT_INVALID',
    ],
    [
      'missing namespace',
      '<svg viewBox="0 0 10 10"><circle r="4"/></svg>',
      'REMOTE_AGENT_ARTIFACT_SVG_ROOT_INVALID',
    ],
    [
      'script element',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'REMOTE_AGENT_ARTIFACT_SVG_ACTIVE_CONTENT',
    ],
    [
      'event handler',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="4"/></svg>',
      'REMOTE_AGENT_ARTIFACT_SVG_ACTIVE_CONTENT',
    ],
    [
      'foreign object',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>',
      'REMOTE_AGENT_ARTIFACT_SVG_ACTIVE_CONTENT',
    ],
    [
      'javascript URL',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>Run</text></a></svg>',
      'REMOTE_AGENT_ARTIFACT_SVG_ACTIVE_CONTENT',
    ],
    [
      'external active reference',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/private.png"/></svg>',
      'REMOTE_AGENT_ARTIFACT_SVG_ACTIVE_CONTENT',
    ],
    [
      'external CSS URL in a style attribute',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://example.com/paint.svg#gradient)"/></svg>',
      'REMOTE_AGENT_ARTIFACT_SVG_ACTIVE_CONTENT',
    ],
    [
      'external CSS URL in a style block',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.shape { fill: url(//example.com/paint.svg#gradient); }</style><rect class="shape"/></svg>',
      'REMOTE_AGENT_ARTIFACT_SVG_ACTIVE_CONTENT',
    ],
  ])('blocks SVG %s', (_label, content, expectedCode) => {
    const report = validateResultArtifactSet({
      files: [resultFile('diagram.svg', 'image/svg+xml', content)],
    });

    expect(report.status).toBe('blocked');
    expect(blockerCodes(report)).toContain(expectedCode);
  });

  test('allows fragment-only CSS paint references in SVG', () => {
    const report = validateResultArtifactSet({
      files: [resultFile(
        'diagram.svg',
        'image/svg+xml',
        '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="paint"/></defs><style>.shape { fill: url(#paint); }</style><rect class="shape" style="stroke:url(#paint)"/></svg>',
      )],
    });

    expect(report.status).toBe('passed');
    expect(report.blockers).toEqual([]);
  });

  test('requires HTML to contain a non-empty document or renderable surface', () => {
    const empty = validateResultArtifactSet({
      files: [resultFile('empty.html', 'text/html', '<!doctype html><html><head><title>Empty</title></head><body></body></html>')],
    });
    const masqueradingJson = validateResultArtifactSet({
      files: [resultFile('not-html.html', 'text/html', '{"ready":true}')],
    });
    const appShell = validateResultArtifactSet({
      files: [resultFile('app.html', 'text/html', '<!doctype html><div id="app"></div><script>document.querySelector("#app").textContent="Ready"</script>')],
    });

    expect(blockerCodes(empty)).toContain('REMOTE_AGENT_ARTIFACT_HTML_EMPTY');
    expect(blockerCodes(masqueradingJson)).toContain('REMOTE_AGENT_ARTIFACT_HTML_INVALID');
    expect(appShell.status).toBe('passed');
  });

  test('blocks MIME and extension disagreement or an unspecified MIME for recognized formats', () => {
    const report = validateResultArtifactSet({
      files: [
        resultFile('index.html', 'application/json', '<main>Ready</main>'),
        resultFile('diagram.svg', 'application/xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'),
        resultFile('payload.png', 'text/html', '<main>Not a PNG</main>'),
        resultFile('unknown.xml', 'application/octet-stream', '<root/>'),
      ],
    });

    expect(report.status).toBe('blocked');
    expect(blockerCodes(report).filter((code) => code === 'REMOTE_AGENT_ARTIFACT_MIME_EXTENSION_MISMATCH')).toHaveLength(3);
    expect(blockerCodes(report)).toContain('REMOTE_AGENT_ARTIFACT_MIME_REQUIRED');
  });

  test('enforces local-reference closure only when an HTML result has a site role', () => {
    const draft = validateResultArtifactSet({
      files: [resultFile('index.html', 'text/html', '<main><img src="missing.png"></main>')],
    });
    const site = validateResultArtifactSet({
      files: [
        resultFile(
          'pages/index.html',
          'text/html',
          '<main><link rel="stylesheet" href="../Styles.css"><img src="../../secret.png"><script src="missing.js"></script></main>',
          'site-entry',
        ),
        resultFile('styles.css', 'text/css', 'main { color: #111; }', 'site-file'),
      ],
    });

    expect(draft.status).toBe('passed');
    expect(draft.site.enabled).toBe(false);
    expect(site.status).toBe('blocked');
    expect(blockerCodes(site)).toEqual(expect.arrayContaining([
      'REMOTE_AGENT_ARTIFACT_SITE_REFERENCE_CASE_MISMATCH',
      'REMOTE_AGENT_ARTIFACT_SITE_REFERENCE_UNSAFE',
      'REMOTE_AGENT_ARTIFACT_SITE_REFERENCE_MISSING',
    ]));
  });

  test('allows external, data, fragment, and installed sandbox-library references in a site', () => {
    const report = validateResultArtifactSet({
      files: [
        resultFile(
          'index.html',
          'text/html',
          `<!doctype html><main id="top">
          <a href="#top">Top</a>
          <img src="data:image/png;base64,iVBORw0KGgo=" alt="Inline">
          <script src="https://example.com/library.js"></script>
          <script src="/api/sandbox-libraries/d3/d3.min.js"></script>
          <script type="module" src="./app.js"></script>
        </main>`,
          'site-entry',
        ),
        resultFile(
          'app.js',
          'text/javascript',
          'import * as THREE from "three"; console.log(THREE.REVISION);',
          'site-file',
        ),
      ],
    });

    expect(report.status).toBe('passed');
    expect(report.site.checkedReferences).toBe(1);
  });

  test('ignores legacy site-like roles and excludes unrelated deliverables from explicit site closure', () => {
    const legacy = validateResultArtifactSet({
      files: [resultFile('index.html', 'text/html', '<main><img src="missing.png"></main>', 'site')],
    });
    const explicit = validateResultArtifactSet({
      files: [
        resultFile('index.html', 'text/html', '<main><script src="private.js"></script></main>', 'site-entry'),
        resultFile('private.js', 'text/javascript', 'console.log("private");', 'qa'),
      ],
    });

    expect(legacy).toMatchObject({ status: 'passed', site: { enabled: false } });
    expect(explicit.status).toBe('blocked');
    expect(blockerCodes(explicit)).toContain('REMOTE_AGENT_ARTIFACT_SITE_REFERENCE_MISSING');
  });

  test('normalizes operation-scoped paths and detects case-folded duplicates', () => {
    const root = '.kimibuilt/agent-runs/11111111-2222-4333-8444-555555555555/output/files';
    const report = validateResultArtifactSet({
      filesDirectory: root,
      files: [
        resultFile(`${root}/assets/App.js`, 'text/javascript', 'export const one = 1;'),
        resultFile(`${root}/assets/app.js`, 'text/javascript', 'export const two = 2;'),
      ],
    });

    expect(report.files.map((file) => file.path)).toEqual(['assets/App.js', 'assets/app.js']);
    expect(blockerCodes(report)).toContain('REMOTE_AGENT_ARTIFACT_PATH_DUPLICATE');
  });

  test('blocks an empty result set', () => {
    const report = validateResultArtifactSet({ files: [] });

    expect(report).toMatchObject({
      status: 'blocked',
      blockers: [expect.objectContaining({ code: 'REMOTE_AGENT_ARTIFACT_RESULT_SET_EMPTY' })],
    });
  });
});
