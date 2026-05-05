'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  collectHarnessContext,
  renderMarkdownReport,
} = require('./collect-harness-context');

function writeFile(root, relPath, content) {
  const filePath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe('collect-harness-context', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-context-'));
    writeFile(tempDir, 'package.json', JSON.stringify({
      name: 'demo-harness',
      scripts: {
        test: 'jest',
        'test:harness': 'jest harness.test.js',
        build: 'node build.js',
      },
      dependencies: {
        openai: '^4.0.0',
      },
    }));
    writeFile(tempDir, 'AGENTS.md', '# Instructions');
    writeFile(tempDir, 'src/conversation-orchestrator.js', 'const tool = require("./tool"); function routePrompt() {}');
    writeFile(tempDir, 'src/memory/context.js', 'function selectMemoryChunks() {}');
    writeFile(tempDir, 'frontend/web-chat/js/agent-orchestrator-integration.js', 'function renderSandboxPreview() {}');
    writeFile(tempDir, 'src/perceived-intelligence-harness.test.js', 'test("prompt regression", () => {});');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('emits classified harness surfaces and regression decision inputs', () => {
    const output = collectHarnessContext({
      root: tempDir,
      maxFiles: 5000,
      maxCandidates: 20,
      includePluginFiles: false,
    });
    expect(output.instructions).toContain('AGENTS.md');
    expect(output.package.scripts['test:harness']).toBe('jest harness.test.js');
    expect(output.surfaceMap.coreRuntime).toContain('src/conversation-orchestrator.js');
    expect(output.surfaceMap.memoryContext).toContain('src/memory/context.js');
    expect(output.surfaceMap.frontendSandbox).toContain('frontend/web-chat/js/agent-orchestrator-integration.js');
    expect(output.regressionDecisionInputs.controlCandidates).toContain('src/perceived-intelligence-harness.test.js');
    expect(output.suggestedChecks).toEqual(expect.arrayContaining([
      { name: 'test:harness', command: 'jest harness.test.js' },
    ]));
  });

  test('renders a Markdown architecture pass brief from scanner output', () => {
    const output = collectHarnessContext({
      root: tempDir,
      maxFiles: 5000,
      maxCandidates: 20,
      includePluginFiles: false,
    });
    const markdown = renderMarkdownReport(output);

    expect(markdown).toContain('# Harness Architecture Pass');
    expect(markdown).toContain('## Repo Model');
    expect(markdown).toContain('### coreRuntime');
    expect(markdown).toContain('src/conversation-orchestrator.js');
    expect(markdown).toContain('## Regression Decision Inputs');
    expect(markdown).toContain('Decision: <what architecture choice is being made>');
    expect(markdown).toContain('- test:harness: `jest harness.test.js`');
  });
});
