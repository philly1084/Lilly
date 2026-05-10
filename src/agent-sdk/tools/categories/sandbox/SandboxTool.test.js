const { SandboxTool } = require('./SandboxTool');

describe('SandboxTool runtime configuration', () => {
  test('exposes Java and frontend project framework language options', () => {
    const tool = new SandboxTool();

    expect(tool.inputSchema.properties.language.enum).toEqual(expect.arrayContaining([
      'java',
      'react',
      'tailwind',
    ]));
  });

  test('builds dependency install commands for JavaScript and Python execution', () => {
    const tool = new SandboxTool();

    const javascript = tool.getDockerConfig('javascript', ['react', 'chart.js']).command('index.js');
    const python = tool.getDockerConfig('python', ['fastapi', 'uvicorn[standard]']).command('main.py');

    expect(javascript).toEqual([
      'sh',
      '-c',
      "npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund 'react' 'chart.js' && node 'index.js'",
    ]);
    expect(python).toEqual([
      'sh',
      '-c',
      "python -m pip install --no-cache-dir 'fastapi' 'uvicorn[standard]' && python 'main.py'",
    ]);
  });

  test('uses a Java 21 image and Main entrypoint for Java execution', () => {
    const tool = new SandboxTool();
    const config = tool.getDockerConfig('java', []);

    expect(config.image).toBe('eclipse-temurin:21-jdk-alpine');
    expect(config.command('Main.java')).toEqual([
      'sh',
      '-c',
      "javac 'Main.java' && java Main",
    ]);
  });

  test('normalizes React and Tailwind project fallback content to index.html', () => {
    const tool = new SandboxTool();

    expect(tool.normalizeProjectFiles({ language: 'react', code: '<div id="root"></div>' })[0].path).toBe('index.html');
    expect(tool.normalizeProjectFiles({ language: 'tailwind', code: '<main></main>' })[0].path).toBe('index.html');
  });

  test('normalizes planner object-shaped project files before schema validation', () => {
    const tool = new SandboxTool();

    expect(tool.normalizeExecutionParams({
      mode: 'project',
      language: 'vite',
      files: {
        'index.html': '<div id="app"></div>',
        'src/main.js': {
          content: 'document.body.dataset.ready = "true";',
          language: 'javascript',
        },
      },
    }).files).toEqual([
      {
        path: 'index.html',
        content: '<div id="app"></div>',
      },
      {
        path: 'src/main.js',
        content: 'document.body.dataset.ready = "true";',
        language: 'javascript',
      },
    ]);
  });

  test('applies bundle styling normalization before workspace preview writes', () => {
    const tool = new SandboxTool();

    const files = tool.normalizeProjectFiles({
      language: 'vite',
      files: [{
        path: 'index.html',
        content: '<!DOCTYPE html><html><head><title>Preview</title></head><body><main><h1>Preview</h1></main></body></html>',
      }],
    });

    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'index.html',
        content: expect.stringContaining('rel="stylesheet"'),
      }),
      expect.objectContaining({
        path: 'styles.css',
        language: 'css',
      }),
    ]));
  });

  test('adds Vite handoff files for Vite project previews', () => {
    const tool = new SandboxTool();

    const files = tool.normalizeProjectFiles({
      language: 'vite',
      files: [{
        path: 'index.html',
        content: '<!DOCTYPE html><html><head><title>Game</title></head><body><canvas id="game"></canvas><script type="module" src="./src/main.js"></script></body></html>',
      }, {
        path: 'src/main.js',
        content: 'document.body.dataset.ready = "true";',
      }],
    });

    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'package.json',
        content: expect.stringContaining('"dev": "vite --host 0.0.0.0"'),
      }),
      expect.objectContaining({
        path: 'vite.config.js',
        content: expect.stringContaining('defineConfig'),
      }),
    ]));
  });

  test('drops unsafe dependency strings before building install commands', () => {
    const tool = new SandboxTool();

    expect(tool.normalizeDependencies(['fastapi', 'bad;rm -rf /', 'react && echo no'])).toEqual(['fastapi']);
  });
});
