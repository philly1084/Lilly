#!/usr/bin/env node

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const suiteRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(suiteRoot, '..');
const rootPackagePath = path.join(repoRoot, 'package.json');
const distRoot = path.join(repoRoot, 'dist', 'release');
const npmPackages = [
  {
    name: 'kimibuilt-suite',
    dir: path.join(suiteRoot, 'npm', 'kimibuilt-suite'),
    cli: 'kimibuilt-suite',
    compatibility: false,
  },
  {
    name: 'lilly-suite',
    dir: path.join(suiteRoot, 'npm', 'lilly-suite'),
    cli: 'lilly-suite',
    compatibility: true,
  },
];

const args = new Set(process.argv.slice(2));
const skipTar = args.has('--skip-tar');
const skipNpmPayload = args.has('--skip-npm-payload');
const version = getArgValue('--version') || readJson(rootPackagePath).version || '0.0.0';
const image = getArgValue('--image') || `ghcr.io/philly1084/kimibuilt:${version}`;
const packageName = 'kimibuilt-suite';
const buildName = `${packageName}-compose-${version}`;
const buildDir = path.join(distRoot, buildName);
const tarballPath = path.join(distRoot, `${buildName}.tar.gz`);
const manifestPath = path.join(distRoot, `${buildName}.manifest.json`);

function getArgValue(name) {
  const prefix = `${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  const index = process.argv.indexOf(name);
  if (index !== -1) {
    return process.argv[index + 1];
  }
  return '';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function ensureCleanDir(dir) {
  await assertInsideWorkspace(dir);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
}

async function assertInsideWorkspace(target) {
  const resolved = path.resolve(target);
  const relative = path.relative(repoRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside repository: ${resolved}`);
  }
}

async function copyFile(source, destination, replacements = null) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  if (replacements) {
    let text = await fsp.readFile(source, 'utf8');
    for (const [needle, value] of Object.entries(replacements)) {
      text = text.split(needle).join(value);
    }
    await fsp.writeFile(destination, text);
    return;
  }
  await fsp.copyFile(source, destination);
}

async function copyDir(source, destination, replacementsByBasename = {}) {
  await fsp.mkdir(destination, { recursive: true });
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, destinationPath, replacementsByBasename);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, destinationPath, replacementsByBasename[entry.name] || null);
    }
  }
}

async function writeExecutable(source, destination, replacements = null) {
  await copyFile(source, destination, replacements);
  await fsp.chmod(destination, 0o755).catch(() => {});
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function run(command, commandArgs, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd || repoRoot,
      stdio: options.stdio || 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function buildBundleTree() {
  const replacements = {
    __KIMIBUILT_VERSION__: version,
    __KIMIBUILT_IMAGE__: image,
  };

  await ensureCleanDir(buildDir);
  await writeExecutable(path.join(suiteRoot, 'install-compose.sh'), path.join(buildDir, 'install-compose.sh'), replacements);
  await copyFile(path.join(suiteRoot, 'install-compose.cmd'), path.join(buildDir, 'install-compose.cmd'), replacements);
  await copyDir(path.join(suiteRoot, 'templates'), path.join(buildDir, 'templates'), {
    'release.env.example': replacements,
    'release-compose.yaml': replacements,
  });
  await copyDir(path.join(suiteRoot, 'docs'), path.join(buildDir, 'docs'));
  await fsp.mkdir(path.join(buildDir, 'scripts'), { recursive: true });
  await copyFile(path.join(suiteRoot, 'scripts', 'uninstall-compose.mjs'), path.join(buildDir, 'scripts', 'uninstall-compose.mjs'));
  await copyFile(path.join(repoRoot, 'README.md'), path.join(buildDir, 'README.md'));
  await copyFile(path.join(repoRoot, 'LICENSE'), path.join(buildDir, 'LICENSE')).catch(async () => {
    await fsp.writeFile(path.join(buildDir, 'LICENSE'), 'MIT\n');
  });

  const manifest = {
    name: packageName,
    version,
    image,
    generatedAt: new Date().toISOString(),
    entrypoints: {
      composeInstaller: 'install-compose.sh',
      composeTemplate: 'templates/release-compose.yaml',
      envTemplate: 'templates/release.env.example',
      onlineSetup: 'docs/online-setup.md',
    },
    packageChannels: [
      { type: 'compose-bundle', name: buildName, file: `${buildName}.tar.gz` },
      { type: 'npm', name: 'kimibuilt-suite', cli: 'kimibuilt-suite' },
      { type: 'npm', name: 'lilly-suite', cli: 'lilly-suite', compatibility: true },
      { type: 'homebrew', name: 'kimibuilt-suite', formula: 'suite/homebrew/Formula/kimibuilt-suite.rb' },
    ],
    secrets: {
      generatedByInstaller: [
        'KIMIBUILT_AUTH_PASSWORD',
        'KIMIBUILT_JWT_SECRET',
        'KIMIBUILT_FRONTEND_API_KEY',
        'SESSION_SECRET',
        'POSTGRES_PASSWORD',
        'KIMIBUILT_REMOTE_RUNNER_TOKEN',
      ],
      userProvided: [
        'OPENAI_API_KEY',
        'OPENAI_MEDIA_API_KEY',
        'PERPLEXITY_API_KEY',
        'UNSPLASH_ACCESS_KEY',
        'REMOTE_CLI_MCP_BEARER_TOKEN',
      ],
    },
  };
  await fsp.writeFile(path.join(buildDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function copyBundleIntoNpmPackages() {
  for (const npmPackage of npmPackages) {
    if (!fs.existsSync(path.join(npmPackage.dir, 'package.json'))) {
      throw new Error(`Missing npm package: ${npmPackage.dir}`);
    }
    const target = path.join(npmPackage.dir, 'bundle');
    await ensureCleanDir(target);
    await copyDir(buildDir, target);
  }
}

async function createTarball() {
  await fsp.rm(tarballPath, { force: true });
  await run('tar', ['-czf', tarballPath, '-C', distRoot, buildName]);
  const digest = await sha256(tarballPath);
  await fsp.writeFile(`${tarballPath}.sha256`, `${digest}  ${path.basename(tarballPath)}\n`);
  return digest;
}

async function writeDistManifest(manifest, tarballSha256 = null) {
  const distManifest = {
    ...manifest,
    artifacts: {
      bundleDirectory: path.relative(repoRoot, buildDir).replace(/\\/g, '/'),
      tarball: skipTar ? null : path.relative(repoRoot, tarballPath).replace(/\\/g, '/'),
      sha256: tarballSha256,
    },
  };
  await fsp.writeFile(manifestPath, `${JSON.stringify(distManifest, null, 2)}\n`);
}

const manifest = await buildBundleTree();
if (!skipNpmPayload) {
  await copyBundleIntoNpmPackages();
}
const tarballSha256 = skipTar ? null : await createTarball();
await writeDistManifest(manifest, tarballSha256);

console.log(`Built ${path.relative(repoRoot, buildDir)}`);
if (!skipTar) {
  console.log(`Wrote ${path.relative(repoRoot, tarballPath)}`);
  console.log(`sha256 ${tarballSha256}`);
}
if (!skipNpmPayload) {
  for (const npmPackage of npmPackages) {
    console.log(`Updated ${path.relative(repoRoot, path.join(npmPackage.dir, 'bundle'))}`);
  }
}
