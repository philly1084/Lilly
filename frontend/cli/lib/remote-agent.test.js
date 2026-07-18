'use strict';

const {
  collectRemoteAgentArtifacts,
  formatRemoteAgentArtifactOutput,
  formatRemoteAgentStatusOutput,
  formatRemoteAgentTextOutput,
  formatSessionArtifactLine,
  parseRemoteAgentCommand,
} = require('./remote-agent');

describe('remote agent CLI command', () => {
  test('keeps the existing task-only form backward compatible', () => {
    expect(parseRemoteAgentCommand('Build and deploy the weather site')).toEqual({
      task: 'Build and deploy the weather site',
      artifactIds: [],
    });
  });

  test('parses repeatable full artifact IDs and returned-file collection', () => {
    expect(parseRemoteAgentCommand([
      '--artifact artifact-019f-full-first',
      '--artifact=artifact-019f-full-second',
      '--artifact artifact-019f-full-first',
      '--collect',
      'Improve the HTML XML and SVG',
    ].join(' '))).toEqual({
      task: 'Improve the HTML XML and SVG',
      artifactIds: ['artifact-019f-full-first', 'artifact-019f-full-second'],
      collectResultFiles: true,
    });
  });

  test('supports a terminator when option-looking text belongs to the task', () => {
    expect(parseRemoteAgentCommand('--collect -- Explain the literal --artifact flag')).toEqual({
      task: 'Explain the literal --artifact flag',
      artifactIds: [],
      collectResultFiles: true,
    });
  });

  test('preserves option-looking text literally after the first task token', () => {
    expect(parseRemoteAgentCommand(
      '--collect Update  CLI help for --collect and --artifact=artifact-example-id handling',
    )).toEqual({
      task: 'Update  CLI help for --collect and --artifact=artifact-example-id handling',
      artifactIds: [],
      collectResultFiles: true,
    });
  });

  test.each([
    '--artifact --collect Build a site',
    '--artifact=--collect Build a site',
    '--artifact short Build a site',
    '--artifact artifact/other Build a site',
  ])('rejects an invalid or option-like artifact ID in %s', (command) => {
    expect(() => parseRemoteAgentCommand(command))
      .toThrow('--artifact requires a full artifact ID.');
  });
});

describe('remote agent CLI artifact output', () => {
  const result = {
    finalOutput: 'Finished the design pass.',
    artifactIds: [
      'artifact-returned-svg-full-id',
      'artifact-site-bundle-full-id',
    ],
    resultFiles: [{
      artifactId: 'artifact-returned-svg-full-id',
      storedFilename: 'diagram.svg',
    }],
    artifacts: [{
      id: 'artifact-returned-svg-full-id',
      filename: 'diagram.svg',
      downloadUrl: '/api/artifacts/artifact-returned-svg-full-id/download',
      previewUrl: '/api/artifacts/artifact-returned-svg-full-id/preview',
    }, {
      id: 'artifact-site-bundle-full-id',
      filename: 'design-site.zip',
      downloadUrl: '/api/artifacts/artifact-site-bundle-full-id/download',
      previewUrl: '/api/artifacts/artifact-site-bundle-full-id/preview',
      bundleDownloadUrl: '/api/artifacts/artifact-site-bundle-full-id/bundle',
    }],
    siteBundleArtifactId: 'artifact-site-bundle-full-id',
  };

  test('separates the site bundle from returned component artifacts', () => {
    expect(collectRemoteAgentArtifacts(result)).toEqual({
      siteBundle: expect.objectContaining({
        id: 'artifact-site-bundle-full-id',
        filename: 'design-site.zip',
      }),
      artifacts: [expect.objectContaining({
        id: 'artifact-returned-svg-full-id',
        filename: 'diagram.svg',
      })],
    });
  });

  test('prints full IDs, filenames, and all returned URLs', () => {
    expect(formatRemoteAgentArtifactOutput(result)).toEqual([
      'Site bundle:',
      '  ID: artifact-site-bundle-full-id',
      '  Filename: design-site.zip',
      '  Download: /api/artifacts/artifact-site-bundle-full-id/download',
      '  Preview: /api/artifacts/artifact-site-bundle-full-id/preview',
      '  Bundle: /api/artifacts/artifact-site-bundle-full-id/bundle',
      '',
      'Returned artifacts:',
      '  ID: artifact-returned-svg-full-id',
      '  Filename: diagram.svg',
      '  Download: /api/artifacts/artifact-returned-svg-full-id/download',
      '  Preview: /api/artifacts/artifact-returned-svg-full-id/preview',
    ]);
  });

  test('backfills a safe session artifact download URL from an ID-only result', () => {
    expect(formatRemoteAgentArtifactOutput({ artifactIds: ['artifact-only-full-id'] }))
      .toEqual([
        'Returned artifacts:',
        '  ID: artifact-only-full-id',
        '  Filename: (not provided)',
        '  Download: /api/artifacts/artifact-only-full-id/download',
      ]);
  });

  test('strips signed parameters and replaces arbitrary artifact URLs with safe routes', () => {
    const secret = 'do-not-print-this-secret';
    const lines = formatRemoteAgentArtifactOutput({
      artifactIds: ['artifact-safe-full-id'],
      artifacts: [{
        id: 'artifact-safe-full-id',
        filename: 'diagram.svg',
        downloadUrl: `https://evil.example.test/api/artifacts/artifact-safe-full-id/download?token=${secret}`,
        previewUrl: `/api/artifacts/artifact-safe-full-id/preview?X-Amz-Credential=${secret}&client_secret=${secret}&view=1`,
        sandboxUrl: `javascript:alert('${secret}')`,
        bundleDownloadUrl: `/api/artifacts/artifact-other-full-id/bundle?sig=${secret}`,
      }],
    });

    expect(lines).toEqual([
      'Returned artifacts:',
      '  ID: artifact-safe-full-id',
      '  Filename: diagram.svg',
      '  Download: /api/artifacts/artifact-safe-full-id/download',
      '  Preview: /api/artifacts/artifact-safe-full-id/preview?view=1',
      '  Sandbox: /api/artifacts/artifact-safe-full-id/sandbox',
      '  Bundle: /api/artifacts/artifact-safe-full-id/bundle',
    ]);
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.join('\n')).not.toContain('evil.example.test');
    expect(lines.join('\n')).not.toContain('artifact-other-full-id');
    expect(lines.join('\n')).not.toContain('javascript:');
  });

  test('surfaces blocked result-file collection before terminal output is printed', () => {
    expect(formatRemoteAgentStatusOutput({
      completionStatus: 'blocked',
      blocker: 'Returned SVG failed structural validation.',
      resultFilesError: 'Remote agent output files could not be persisted safely.',
      finalOutput: 'The remote coding turn itself completed.',
    })).toEqual([
      'Status: blocked',
      'Blocker: Returned SVG failed structural validation.',
      'Result files: Remote agent output files could not be persisted safely.',
    ]);
  });

  test('redacts signed credentials from free-form remote agent output', () => {
    const secret = 'do-not-print-this-secret';
    const output = formatRemoteAgentTextOutput(
      [
        `Preview: https://example.test/?X-Amz-Credential=${secret}&X-Amz-Signature=${secret}`,
        `Authorization: Bearer ${secret}`,
        `key=${secret} credentials=${secret} client_secret=${secret}`,
        `Published at https://deploy-user:${secret}@demo.example.test/result`,
        `Encoded URL: https://demo.example.test/?%2574oken=${secret}&client%255Fsecret=${secret}&X%252DAmz%252DSignature=${secret}&keyboard=compact#view=1&%2574oken=${secret}`,
        `JSON: {"token":"${secret}"} {'client_secret':'${secret}'}`,
        'keyboard=compact keynote=deck monkey=ape',
      ].join('\n'),
    );

    expect(output).toContain('Preview: https://example.test/');
    expect(output).toContain('Authorization: [redacted]');
    expect(output).toContain('key=[redacted]');
    expect(output).toContain('credentials=[redacted]');
    expect(output).toContain('client_secret=[redacted]');
    expect(output).toContain('Published at https://demo.example.test/result');
    expect(output).toContain('Encoded URL: https://demo.example.test/?keyboard=compact');
    expect(output).toContain('JSON: {"token":[redacted]}');
    expect(output).toContain("{'client_secret':[redacted]}");
    expect(output).toContain('keyboard=compact keynote=deck monkey=ape');
    expect(output).not.toContain(secret);
  });

  test('keeps the complete session artifact ID visible for copying into --artifact', () => {
    expect(formatSessionArtifactLine({
      id: 'artifact-019f-complete-session-id',
      filename: 'design.xml',
      format: 'xml',
    })).toBe('  artifact-019f-complete-session-id  design.xml  [xml]');
  });
});
