#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const suiteRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(suiteRoot, '..');

const requiredFiles = [
  'suite/install-compose.sh',
  'suite/install-compose.cmd',
  'suite/templates/release.env.example',
  'suite/templates/release-compose.yaml',
  'suite/docs/online-setup.md',
  'suite/docs/package-matrix.md',
  'suite/npm/kimibuilt-suite/package.json',
  'suite/npm/kimibuilt-suite/bin/kimibuilt-suite.js',
  'suite/npm/kimibuilt-suite/lib/cli.js',
  'suite/npm/lilly-suite/package.json',
  'suite/homebrew/Formula/kimibuilt-suite.rb',
  'suite/scripts/build-release-bundle.mjs',
  'suite/scripts/release-gate.mjs',
];

const requiredEnvKeys = [
  'KIMIBUILT_VERSION',
  'KIMIBUILT_IMAGE',
  'KIMIBUILT_PUBLIC_ORIGIN',
  'KIMIBUILT_AUTH_REQUIRED',
  'KIMIBUILT_AUTH_USERNAME',
  'KIMIBUILT_AUTH_PASSWORD',
  'KIMIBUILT_JWT_SECRET',
  'KIMIBUILT_FRONTEND_API_KEY',
  'SESSION_SECRET',
  'OPENAI_API_KEY',
  'POSTGRES_PASSWORD',
  'KIMIBUILT_REMOTE_RUNNER_TOKEN',
];

const generatedKeys = [
  'KIMIBUILT_AUTH_PASSWORD',
  'KIMIBUILT_JWT_SECRET',
  'KIMIBUILT_FRONTEND_API_KEY',
  'SESSION_SECRET',
  'POSTGRES_PASSWORD',
  'KIMIBUILT_REMOTE_RUNNER_TOKEN',
];

const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function fail(message) {
  failures.push(message);
}

function parseEnv(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

function hasScript(packageJson, scriptName) {
  return Boolean(packageJson.scripts && packageJson.scripts[scriptName]);
}

for (const file of requiredFiles) {
  if (!exists(file)) {
    fail(`Missing required release file: ${file}`);
  }
}

const rootPackage = JSON.parse(read('package.json'));
for (const scriptName of ['release:bundle', 'release:gate', 'release:package']) {
  if (!hasScript(rootPackage, scriptName)) {
    fail(`package.json is missing script ${scriptName}`);
  }
}

const envExample = parseEnv(read('suite/templates/release.env.example'));
for (const key of requiredEnvKeys) {
  if (!envExample.has(key)) {
    fail(`release.env.example is missing ${key}`);
  }
}
for (const key of generatedKeys) {
  const value = envExample.get(key) || '';
  if (!value.startsWith('GENERATE_ME_')) {
    fail(`${key} should use a GENERATE_ME_* placeholder`);
  }
}

const envText = read('suite/templates/release.env.example');
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bghp_[A-Za-z0-9_]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
];
for (const pattern of secretPatterns) {
  if (pattern.test(envText)) {
    fail(`release.env.example appears to contain a real secret matching ${pattern}`);
  }
}

const composeText = read('suite/templates/release-compose.yaml');
for (const expected of ['${KIMIBUILT_IMAGE}', '${KIMIBUILT_STATE_ROOT', 'release.env']) {
  if (!composeText.includes(expected)) {
    fail(`release-compose.yaml is missing expected token ${expected}`);
  }
}

const kimibuiltPackage = JSON.parse(read('suite/npm/kimibuilt-suite/package.json'));
if (kimibuiltPackage.name !== 'kimibuilt-suite') {
  fail(`kimibuilt-suite package name is wrong: ${kimibuiltPackage.name}`);
}
if (!kimibuiltPackage.bin || !kimibuiltPackage.bin['kimibuilt-suite']) {
  fail('kimibuilt-suite package must expose the kimibuilt-suite CLI');
}
if (!kimibuiltPackage.files || !kimibuiltPackage.files.includes('bundle/')) {
  fail('kimibuilt-suite package files must include bundle/');
}

const lillyPackage = JSON.parse(read('suite/npm/lilly-suite/package.json'));
if (lillyPackage.name !== 'lilly-suite') {
  fail(`lilly-suite compatibility package name is wrong: ${lillyPackage.name}`);
}

const gitignore = read('.gitignore');
if (!gitignore.includes('suite/npm/*/bundle/')) {
  fail('.gitignore should ignore generated npm bundle payloads');
}

const setupGuide = read('suite/docs/online-setup.md');
for (const phrase of ['KIMIBUILT_AUTH_PASSWORD', 'KIMIBUILT_FRONTEND_API_KEY', 'OPENAI_API_KEY', 'online URL']) {
  if (!setupGuide.includes(phrase)) {
    fail(`online setup guide is missing ${phrase}`);
  }
}

if (failures.length > 0) {
  console.error('KimiBuilt release gate failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('KimiBuilt release gate passed.');
