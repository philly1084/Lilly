/**
 * SandboxTool - Execute code in isolated Docker containers
 */

const { ToolBase } = require('../../ToolBase');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { artifactService } = require('../../../../artifacts/artifact-service');
const {
  buildFrontendBundleArtifact,
  ensureFrontendBundleStyling,
  normalizeBundlePath,
} = require('../../../../frontend-bundles');
const { buildSandboxBrowserLibraryInstructions } = require('../../../../sandbox-browser-libraries');

class SandboxTool extends ToolBase {
  constructor() {
    super({
      id: 'code-sandbox',
      name: 'Code Sandbox',
      description: 'Execute code in isolated Docker containers with resource limits and optional package installs, or persist previewable frontend project files with local sandbox browser libraries such as Three.js, Chart.js, D3, Mermaid, Cytoscape, Plotly, ECharts, vis-network, GSAP, Matter.js, p5.js, and force-graph',
      category: 'sandbox',
      version: '1.0.0',
      backend: {
        sideEffects: ['execute', 'filesystem'],
        sandbox: { network: false, filesystem: 'isolated' },
        timeout: 60000
      },
      inputSchema: {
        type: 'object',
        required: ['language'],
        properties: {
          mode: {
            type: 'string',
            enum: ['execute', 'project'],
            default: 'execute',
            description: 'Use execute for short code runs, or project to save previewable frontend files'
          },
          language: {
            type: 'string',
            enum: ['javascript', 'python', 'java', 'bash', 'sql', 'ruby', 'go', 'rust', 'html', 'vite', 'react', 'tailwind'],
            description: 'Programming language or project type. Use project mode with html, vite, react, or tailwind for previewable sites.'
          },
          code: {
            type: 'string',
            description: 'Code to execute, or fallback content for project mode'
          },
          projectName: {
            type: 'string',
            description: 'Optional project name for persisted project workspaces'
          },
          entry: {
            type: 'string',
            description: 'Frontend project entry file, usually index.html'
          },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
                contentBase64: { type: 'string' },
                dataBase64: { type: 'string' },
                purpose: { type: 'string' },
                language: { type: 'string' }
              }
            },
            description: 'Project files to persist and expose as a previewable bundle'
          },
          inputs: {
            type: 'object',
            description: 'Input data for the code'
          },
          dependencies: {
            type: 'array',
            items: { type: 'string' },
            description: 'Package dependencies to install before execution. Supported for javascript/npm and python/pip execution; frontend project previews should prefer static browser imports from /api/sandbox-libraries or CDN fallbacks so the saved site works immediately.'
          },
          environment: {
            type: 'object',
            description: 'Environment variables'
          },
          limits: {
            type: 'object',
            description: 'Resource limits',
            properties: {
              cpu: { type: 'string', default: '0.5' },
              memory: { type: 'string', default: '512m' },
              timeout: { type: 'integer', default: 30000 },
              maxOutput: { type: 'integer', default: 100000 }
            }
          },
          network: {
            type: 'boolean',
            default: false,
            description: 'Allow network access'
          }
        }
      },
      outputSchema: {
        type: 'object',
        properties: {
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          exitCode: { type: 'integer' },
          executionTime: { type: 'number' },
          memoryUsage: { type: 'number' },
          killed: { type: 'boolean' },
          killReason: { type: 'string' },
          workspacePath: { type: 'string' },
          files: { type: 'array' },
          artifact: { type: 'object' },
          previewUrl: { type: 'string' },
          sandboxUrl: { type: 'string' },
          workspacePreviewUrl: { type: 'string' },
          workspaceSandboxUrl: { type: 'string' },
          bundleDownloadUrl: { type: 'string' }
        }
      }
    });

    // Track running containers
    this.containers = new Map();
    this.tempDir = path.join(os.tmpdir(), 'agent-sandbox');
  }

  async execute(params = {}, context = {}) {
    return super.execute(this.normalizeExecutionParams(params), context);
  }

  normalizeExecutionParams(params = {}) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return params;
    }

    if (params.files === undefined || Array.isArray(params.files)) {
      return params;
    }

    const files = params.files && typeof params.files === 'object'
      ? Object.entries(params.files)
        .map(([filePath, value]) => {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            return {
              path: value.path || value.name || filePath,
              ...value,
            };
          }

          return {
            path: filePath,
            content: typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2),
          };
        })
      : [];

    return {
      ...params,
      files,
    };
  }

  async handler(params, context, tracker) {
    const {
      mode = 'execute',
      language,
      code,
      projectName = '',
      entry = '',
      files = [],
      inputs = {},
      dependencies = [],
      environment = {},
      limits = {},
      network = false
    } = params;

    if (mode === 'project') {
      return this.createProjectWorkspace({
        language,
        code,
        projectName,
        entry,
        files,
        context,
        tracker
      });
    }

    if (['html', 'vite', 'react', 'tailwind'].includes(String(language || '').trim().toLowerCase())) {
      throw new Error(`Language "${language}" is only supported with mode: "project".`);
    }

    const {
      cpu = '0.5',
      memory = '512m',
      timeout = 30000,
      maxOutput = 100000
    } = limits;

    // Create temp workspace
    const workspaceId = `sandbox-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const workspacePath = path.join(this.tempDir, workspaceId);
    
    await fs.mkdir(workspacePath, { recursive: true });

    try {
      // Write code file
      const codeFile = await this.writeCodeFile(workspacePath, language, code);
      
      // Write inputs
      if (Object.keys(inputs).length > 0) {
        await fs.writeFile(
          path.join(workspacePath, 'input.json'),
          JSON.stringify(inputs, null, 2)
        );
      }

      // Get Docker configuration
      const dockerConfig = this.getDockerConfig(language, dependencies);

      tracker.recordExecution(`docker run ${dockerConfig.image}`, {
        language,
        timeout,
        network: network ? 'enabled' : 'disabled'
      });

      // Execute in Docker
      const result = await this.executeInDocker({
        workspacePath,
        image: dockerConfig.image,
        command: dockerConfig.command,
        codeFile,
        cpu,
        memory,
        timeout,
        maxOutput,
        network,
        environment
      });

      // Track container
      if (result.containerId) {
        this.containers.set(result.containerId, {
          createdAt: new Date().toISOString(),
          language,
          status: result.exitCode === 0 ? 'success' : 'failed'
        });
      }

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        executionTime: result.executionTime,
        memoryUsage: result.memoryUsage,
        killed: result.killed,
        killReason: result.killReason
      };

    } finally {
      // Cleanup
      await this.cleanup(workspacePath);
    }
  }

  normalizeProjectName(projectName = '', fallback = 'sandbox-project') {
    return String(projectName || fallback)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || fallback;
  }

  normalizeProjectFiles({ language = '', code = '', files = [], entry = '' } = {}) {
    const normalizedFiles = [];

    (Array.isArray(files) ? files : []).forEach((file) => {
      if (!file || typeof file !== 'object') {
        return;
      }

      const filePath = normalizeBundlePath(file.path || file.name || '');
      const content = typeof file.content === 'string'
        ? file.content
        : (typeof file.contents === 'string' ? file.contents : '');
      const contentBase64 = String(file.contentBase64 || file.dataBase64 || '').trim();
      const contentBuffer = contentBase64 ? Buffer.from(contentBase64, 'base64') : null;

      if (!filePath || (!content && !contentBuffer)) {
        return;
      }

      normalizedFiles.push({
        path: filePath,
        content,
        ...(contentBuffer ? { contentBuffer } : {}),
        ...(contentBase64 ? { contentBase64 } : {}),
        language: String(file.language || '').trim() || null,
        purpose: String(file.purpose || '').trim() || null
      });
    });

    if (normalizedFiles.length === 0 && String(code || '').trim()) {
      const normalizedLanguage = String(language || '').trim().toLowerCase();
      const fallbackPath = normalizedLanguage === 'javascript'
        ? 'index.js'
        : ['vite', 'react', 'tailwind', 'html'].includes(normalizedLanguage)
          ? 'index.html'
          : 'index.txt';

      normalizedFiles.push({
        path: normalizeBundlePath(entry || fallbackPath) || fallbackPath,
        content: String(code || ''),
        language: normalizedLanguage || null,
        purpose: 'Fallback project content from code parameter.'
      });
    }

    const normalizedLanguage = String(language || '').trim().toLowerCase();
    if (!['html', 'vite', 'react', 'tailwind'].includes(normalizedLanguage)) {
      return normalizedFiles;
    }

    const styledBundle = ensureFrontendBundleStyling({
      entry: normalizeBundlePath(entry || '') || 'index.html',
      frameworkTarget: normalizedLanguage === 'html' ? 'static' : normalizedLanguage,
      routing: 'multipage',
      files: normalizedFiles,
    });

    return this.ensureProjectSupportFiles(styledBundle, normalizedLanguage).files;
  }

  ensureProjectSupportFiles(bundle = null, language = '') {
    const normalizedLanguage = String(language || '').trim().toLowerCase();
    const normalizedBundle = {
      ...bundle,
      files: (Array.isArray(bundle?.files) ? bundle.files : []).map((file) => ({ ...file })),
    };

    if (!['vite', 'react'].includes(normalizedLanguage)) {
      return normalizedBundle;
    }

    const hasFile = (filePath) => normalizedBundle.files.some((file) => (
      String(file.path || '').trim().toLowerCase() === filePath
    ));

    if (!hasFile('package.json')) {
      const dependencies = normalizedLanguage === 'react'
        ? { '@vitejs/plugin-react': 'latest', vite: 'latest', react: 'latest', 'react-dom': 'latest' }
        : { vite: 'latest' };
      normalizedBundle.files.push({
        path: 'package.json',
        language: 'json',
        purpose: 'Vite handoff scripts for running the sandbox bundle in a real project.',
        content: `${JSON.stringify({
          scripts: {
            dev: 'vite --host 0.0.0.0',
            build: 'vite build',
            preview: 'vite preview --host 0.0.0.0',
          },
          dependencies,
          devDependencies: {},
        }, null, 2)}\n`,
      });
    }

    if (!hasFile('vite.config.js')) {
      normalizedBundle.files.push({
        path: 'vite.config.js',
        language: 'javascript',
        purpose: 'Minimal Vite config for repo handoff.',
        content: normalizedLanguage === 'react'
          ? "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n"
          : "import { defineConfig } from 'vite';\n\nexport default defineConfig({});\n",
      });
    }

    return normalizedBundle;
  }

  async writeProjectFiles(workspacePath, files, tracker) {
    const written = [];

    for (const file of files) {
      const targetPath = path.resolve(workspacePath, file.path);
      const relativeCheck = path.relative(workspacePath, targetPath);
      if (!relativeCheck || relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
        throw new Error(`Unsafe project file path: ${file.path}`);
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const payload = file.contentBuffer || file.content;
      await fs.writeFile(targetPath, payload, file.contentBuffer ? undefined : 'utf8');
      written.push({
        path: file.path,
        sizeBytes: file.contentBuffer ? file.contentBuffer.length : Buffer.byteLength(file.content, 'utf8'),
        language: file.language || null,
        purpose: file.purpose || null
      });
      tracker.recordWrite(targetPath, {
        sizeBytes: file.contentBuffer ? file.contentBuffer.length : Buffer.byteLength(file.content, 'utf8')
      });
    }

    return written;
  }

  async persistProjectArtifact({ projectName, entry, files, language, context }) {
    const sessionId = String(context?.sessionId || '').trim();
    if (!sessionId) {
      return {
        artifact: null,
        artifactError: 'No active sessionId was available for artifact persistence.'
      };
    }

    try {
      const bundleArtifact = buildFrontendBundleArtifact({
        entry: normalizeBundlePath(entry || '') || 'index.html',
        frameworkTarget: String(language || '').trim().toLowerCase() === 'html' ? 'static' : (String(language || '').trim().toLowerCase() || 'vite'),
        routing: 'spa',
        files
      }, projectName || 'Sandbox Project');

      const stored = await artifactService.createStoredArtifact({
        sessionId,
        direction: 'generated',
        sourceMode: 'sandbox',
        filename: bundleArtifact.filename,
        extension: bundleArtifact.format,
        mimeType: bundleArtifact.mimeType,
        buffer: bundleArtifact.buffer,
        extractedText: bundleArtifact.extractedText,
        previewHtml: bundleArtifact.previewHtml,
        metadata: {
          ...bundleArtifact.metadata,
          createdByAgentTool: true,
          toolId: this.id,
          projectName,
          projectMode: 'frontend',
        },
        vectorize: false
      });

      return {
        artifact: artifactService.serializeArtifact(stored),
        artifactError: null
      };
    } catch (error) {
      return {
        artifact: null,
        artifactError: error.message
      };
    }
  }

  async createProjectWorkspace({ language, code, projectName, entry, files, context, tracker }) {
    const startTime = Date.now();
    const safeProjectName = this.normalizeProjectName(projectName);
    const workspaceId = `${safeProjectName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workspacePath = path.join(process.cwd(), 'output', 'sandboxes', workspaceId);
    const normalizedFiles = this.normalizeProjectFiles({ language, code, files, entry });

    if (normalizedFiles.length === 0) {
      throw new Error('Project mode requires at least one file or non-empty code content.');
    }

    await fs.mkdir(workspacePath, { recursive: true });
    const writtenFiles = await this.writeProjectFiles(workspacePath, normalizedFiles, tracker);
    const { artifact, artifactError } = await this.persistProjectArtifact({
      projectName: safeProjectName,
      entry,
      files: normalizedFiles,
      language,
      context
    });

    tracker.recordExecution('code-sandbox project workspace', {
      mode: 'project',
      workspacePath,
      files: writtenFiles.length,
      artifactId: artifact?.id || null
    });

    const workspacePreviewUrl = `/api/sandbox-workspaces/${encodeURIComponent(workspaceId)}/preview/`;
    const workspaceSandboxUrl = `/api/sandbox-workspaces/${encodeURIComponent(workspaceId)}/sandbox`;
    const previewUrl = artifact?.sandboxUrl || artifact?.previewUrl || workspaceSandboxUrl;
    const stdout = [
      `Project workspace created: ${workspacePath}`,
      previewUrl ? `Preview: ${previewUrl}` : '',
      artifact?.bundleDownloadUrl ? `Bundle: ${artifact.bundleDownloadUrl}` : '',
      'Browser libraries: /api/sandbox-libraries/catalog.json',
      artifactError ? `Artifact persistence skipped: ${artifactError}` : ''
    ].filter(Boolean).join('\n');

    return {
      stdout,
      stderr: artifactError ? `Artifact persistence skipped: ${artifactError}` : '',
      exitCode: 0,
      executionTime: Date.now() - startTime,
      memoryUsage: 0,
      killed: false,
      killReason: null,
      mode: 'project',
      workspacePath,
      files: writtenFiles,
      artifact,
      artifacts: artifact ? [artifact] : [],
      previewUrl,
      sandboxUrl: artifact?.sandboxUrl || workspaceSandboxUrl,
      workspacePreviewUrl,
      workspaceSandboxUrl,
      bundleDownloadUrl: artifact?.bundleDownloadUrl || '',
      artifactError
    };
  }

  async writeCodeFile(workspacePath, language, code) {
    const extensions = {
      javascript: 'js',
      python: 'py',
      java: 'java',
      bash: 'sh',
      sql: 'sql',
      ruby: 'rb',
      go: 'go',
      rust: 'rs'
    };

    const filenames = {
      javascript: 'index.js',
      python: 'main.py',
      java: 'Main.java',
      bash: 'script.sh',
      sql: 'query.sql',
      ruby: 'main.rb',
      go: 'main.go',
      rust: 'main.rs'
    };

    const filename = filenames[language] || `main.${extensions[language]}`;
    const filepath = path.join(workspacePath, filename);
    
    await fs.writeFile(filepath, code);
    
    return filename;
  }

  normalizeDependencies(dependencies = []) {
    return (Array.isArray(dependencies) ? dependencies : [])
      .map((dependency) => String(dependency || '').trim())
      .filter(Boolean)
      .filter((dependency) => dependency.length <= 120)
      .filter((dependency) => /^[A-Za-z0-9@._/:+\-~<>=!,[\]]+$/.test(dependency))
      .slice(0, 30);
  }

  shellQuote(value = '') {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  }

  buildInstallCommand(language, dependencies = []) {
    const safeDependencies = this.normalizeDependencies(dependencies);
    if (safeDependencies.length === 0) {
      return '';
    }

    const quotedDependencies = safeDependencies.map((dependency) => this.shellQuote(dependency)).join(' ');
    if (language === 'javascript') {
      return `npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund ${quotedDependencies}`;
    }
    if (language === 'python') {
      return `python -m pip install --no-cache-dir ${quotedDependencies}`;
    }
    return '';
  }

  getDockerConfig(language, dependencies) {
    const installCommand = this.buildInstallCommand(language, dependencies);
    const withInstall = (runCommand) => installCommand
      ? ['sh', '-c', `${installCommand} && ${runCommand}`]
      : null;

    const configs = {
      javascript: {
        image: 'node:18-alpine',
        command: (file) => withInstall(`node ${this.shellQuote(file)}`) || ['node', file]
      },
      python: {
        image: 'python:3.11-alpine',
        command: (file) => withInstall(`python ${this.shellQuote(file)}`) || ['python', file]
      },
      java: {
        image: 'eclipse-temurin:21-jdk-alpine',
        command: (file) => ['sh', '-c', `javac ${this.shellQuote(file)} && java Main`]
      },
      bash: {
        image: 'alpine:latest',
        command: (file) => ['sh', file]
      },
      ruby: {
        image: 'ruby:3.2-alpine',
        command: (file) => ['ruby', file]
      },
      go: {
        image: 'golang:1.21-alpine',
        command: (file) => ['go', 'run', file]
      },
      rust: {
        image: 'rust:1.73-alpine',
        command: (file) => ['sh', '-c', `rustc ${file} -o main && ./main`]
      }
    };

    return configs[language] || configs.javascript;
  }

  async executeInDocker(config) {
    const {
      workspacePath,
      image,
      command,
      codeFile,
      cpu,
      memory,
      timeout,
      maxOutput,
      network,
      environment
    } = config;

    return new Promise(async (resolve, reject) => {
      const startTime = Date.now();
      let killed = false;
      let killReason = null;
      let stdout = '';
      let stderr = '';
      let containerId = '';

      // Build docker create command. The backend may itself be containerized and
      // connected to a remote/socket-proxied Docker daemon, so host bind mounts
      // are not reliable. Copy the prepared workspace into the container instead.
      const dockerArgs = [
        'create',
        '--cpus', cpu,
        '--memory', memory,
        '--memory-swap', memory,
        '--pids-limit', '100',
        '--network', network ? 'bridge' : 'none',
        '-w', '/workspace',
        '--tmpfs', '/tmp:noexec,nosuid,size=100m'
      ];

      // Add environment variables
      Object.entries(environment).forEach(([key, value]) => {
        dockerArgs.push('-e', `${key}=${value}`);
      });

      dockerArgs.push(image);
      dockerArgs.push(...command(codeFile));

      const appendLimited = (target, chunk) => {
        let next = target + chunk.toString();
        if (next.length > maxOutput) {
          next = next.substring(0, maxOutput) + '\n... (output truncated)';
        }
        return next;
      };

      const runDocker = (args, options = {}) => new Promise((runResolve, runReject) => {
        const child = spawn('docker', args, options);
        let runStdout = '';
        let runStderr = '';

        child.stdout.on('data', (data) => {
          runStdout = appendLimited(runStdout, data);
        });

        child.stderr.on('data', (data) => {
          runStderr = appendLimited(runStderr, data);
        });

        child.on('close', (exitCode, signal) => {
          runResolve({
            stdout: runStdout,
            stderr: runStderr,
            exitCode: exitCode || 0,
            signal
          });
        });

        child.on('error', runReject);
      });

      const cleanupContainer = async () => {
        if (!containerId) return;
        await runDocker(['rm', '-f', containerId]).catch(() => null);
      };

      try {
        const created = await runDocker(dockerArgs);
        if (created.exitCode !== 0) {
          await cleanupContainer();
          return resolve({
            stdout: created.stdout,
            stderr: created.stderr,
            exitCode: created.exitCode,
            executionTime: Date.now() - startTime,
            memoryUsage: 0,
            killed,
            killReason
          });
        }

        containerId = created.stdout.trim();
        const copied = await runDocker(['cp', `${workspacePath}${path.sep}.`, `${containerId}:/workspace`]);
        if (copied.exitCode !== 0) {
          await cleanupContainer();
          return resolve({
            stdout: copied.stdout,
            stderr: copied.stderr,
            exitCode: copied.exitCode,
            executionTime: Date.now() - startTime,
            memoryUsage: 0,
            killed,
            killReason
          });
        }

        const timeoutId = setTimeout(() => {
          killed = true;
          killReason = 'timeout';
          runDocker(['kill', containerId]).catch(() => null);
        }, timeout);

        await runDocker(['start', containerId]);
        const waited = await runDocker(['wait', containerId]);
        clearTimeout(timeoutId);

        const logs = await runDocker(['logs', containerId]);
        stdout = logs.stdout;
        stderr = logs.stderr;
        const exitCode = Number.parseInt(waited.stdout, 10);

        await cleanupContainer();

        resolve({
          stdout,
          stderr,
          exitCode: Number.isFinite(exitCode) ? exitCode : waited.exitCode,
          executionTime: Date.now() - startTime,
          memoryUsage: 0, // Would need cgroups for accurate measurement
          killed,
          killReason
        });
      } catch (error) {
        await cleanupContainer();
        reject(error);
      }
    });
  }

  async cleanup(workspacePath) {
    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
    } catch (error) {
      console.error(`[SandboxTool] Cleanup failed: ${error.message}`);
    }
  }

  /**
   * Get running container stats
   */
  getContainerStats() {
    return Array.from(this.containers.entries()).map(([id, info]) => ({
      id,
      ...info
    }));
  }

  /**
   * Prune old containers from tracking
   */
  pruneContainers(maxAge = 3600000) {
    const now = Date.now();
    for (const [id, info] of this.containers) {
      const created = new Date(info.createdAt).getTime();
      if (now - created > maxAge) {
        this.containers.delete(id);
      }
    }
  }

  getBrowserLibraryGuidance() {
    return buildSandboxBrowserLibraryInstructions();
  }
}

module.exports = { SandboxTool };
