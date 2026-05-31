#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PUBLIC_NAME = 'Lilly Suite';
const DEFAULT_PROJECT_NAME = 'lilly-suite';
const COMPOSE_FILE_NAMES = [
  'compose.yml',
  'compose.yaml',
  'docker-compose.yml',
  'docker-compose.yaml',
];
const ENV_FILE_NAMES = [
  'release.env',
  '.env',
  '.env.local',
];

function usage() {
  return `${PUBLIC_NAME} compose uninstall

Usage:
  node suite/scripts/uninstall-compose.mjs --install-root <path> --state-root <path> [options]

Options:
  --install-root <path>  Installed compose file root. Env: LILLY_SUITE_INSTALL_ROOT, KIMI_SUITE_INSTALL_ROOT.
  --state-root <path>    State/data root. Env: LILLY_SUITE_STATE_ROOT, KIMI_SUITE_STATE_ROOT.
  --project-name <name>  Docker Compose project name. Default: lilly-suite.
  --wipe-data           Also remove the state/data root. Requires --yes.
  --yes                 Execute removal. Without this flag the script is a dry run.
  --dry-run             Print planned actions only.
  --help                Show this help.

Safety:
  Compose files are only removed from the resolved install root.
  State/data is only removed when --wipe-data and --yes are both present.
`;
}

function parseArgs(argv) {
  const options = {
    installRoot: process.env.LILLY_SUITE_INSTALL_ROOT || process.env.KIMI_SUITE_INSTALL_ROOT || null,
    stateRoot: process.env.LILLY_SUITE_STATE_ROOT || process.env.KIMI_SUITE_STATE_ROOT || null,
    projectName: process.env.LILLY_SUITE_COMPOSE_PROJECT || process.env.KIMI_SUITE_COMPOSE_PROJECT || DEFAULT_PROJECT_NAME,
    wipeData: false,
    yes: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--wipe-data') {
      options.wipeData = true;
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--install-root') {
      options.installRoot = requireValue(argv, i, arg);
      i += 1;
    } else if (arg.startsWith('--install-root=')) {
      options.installRoot = arg.slice('--install-root='.length);
    } else if (arg === '--state-root') {
      options.stateRoot = requireValue(argv, i, arg);
      i += 1;
    } else if (arg.startsWith('--state-root=')) {
      options.stateRoot = arg.slice('--state-root='.length);
    } else if (arg === '--project-name') {
      options.projectName = requireValue(argv, i, arg);
      i += 1;
    } else if (arg.startsWith('--project-name=')) {
      options.projectName = arg.slice('--project-name='.length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.effectiveDryRun = options.dryRun || !options.yes;
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function defaultInstallRoot() {
  if (process.platform === 'win32') {
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    return path.join(programData, DEFAULT_PROJECT_NAME);
  }
  return path.join('/opt', DEFAULT_PROJECT_NAME);
}

function defaultStateRoot() {
  if (process.platform === 'win32') {
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    return path.join(programData, DEFAULT_PROJECT_NAME, 'state');
  }
  return path.join('/var/lib', DEFAULT_PROJECT_NAME);
}

async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function statIfExists(target) {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function resolveRoot(input, fallback, label) {
  const source = input || fallback;
  const resolved = path.resolve(source);
  assertSafeRoot(resolved, label);
  return resolved;
}

function assertSafeRoot(resolvedRoot, label) {
  const parsed = path.parse(resolvedRoot);
  const home = path.resolve(os.homedir());
  const cwd = path.resolve(process.cwd());

  if (!path.isAbsolute(resolvedRoot)) {
    throw new Error(`${label} must resolve to an absolute path: ${resolvedRoot}`);
  }
  if (resolvedRoot === parsed.root) {
    throw new Error(`${label} cannot be a filesystem root: ${resolvedRoot}`);
  }
  if (resolvedRoot === home) {
    throw new Error(`${label} cannot be the current user's home directory: ${resolvedRoot}`);
  }
  if (resolvedRoot === cwd) {
    throw new Error(`${label} cannot be the repository working directory: ${resolvedRoot}`);
  }
}

function assertInsideRoot(target, root, label) {
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(root, resolvedTarget);
  const inside = relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));

  if (!inside) {
    throw new Error(`${label} is outside configured root. target=${resolvedTarget} root=${root}`);
  }
  return resolvedTarget;
}

async function discoverFiles(root, names) {
  const files = [];
  for (const name of names) {
    const candidate = assertInsideRoot(path.join(root, name), root, name);
    if (await pathExists(candidate)) {
      files.push(candidate);
    }
  }
  return files;
}

function logPlan(message) {
  console.log(`[uninstall] ${message}`);
}

async function runComposeDown({ installRoot, composeFiles, envFiles, projectName, dryRun }) {
  const args = ['compose', '--project-name', projectName];

  for (const composeFile of composeFiles) {
    args.push('--file', composeFile);
  }

  if (envFiles.length > 0) {
    args.push('--env-file', envFiles[0]);
  }

  args.push('down', '--remove-orphans');

  if (composeFiles.length === 0) {
    logPlan('No installed compose files found; skipping docker compose down.');
    return;
  }

  if (dryRun) {
    logPlan(`DRY RUN docker ${args.map(quoteArg).join(' ')}`);
    return;
  }

  logPlan(`Stopping compose project ${projectName}.`);
  await new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      cwd: installRoot,
      stdio: 'inherit',
      shell: false,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`docker compose down exited with code ${code}`));
      }
    });
  });
}

function quoteArg(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

async function removeFiles(files, dryRun) {
  for (const file of files) {
    const stat = await statIfExists(file);
    if (!stat) {
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Refusing to remove non-file compose artifact: ${file}`);
    }

    if (dryRun) {
      logPlan(`DRY RUN remove file ${file}`);
    } else {
      logPlan(`Removing file ${file}`);
      await fs.rm(file, { force: false });
    }
  }
}

async function removeEmptyInstallRoot(installRoot, plannedRemovedFiles, dryRun) {
  if (!(await pathExists(installRoot))) {
    return;
  }

  const plannedBasenames = new Set(plannedRemovedFiles.map((file) => path.basename(file)));
  const existingEntries = await fs.readdir(installRoot);
  const remaining = dryRun
    ? existingEntries.filter((entry) => !plannedBasenames.has(entry))
    : existingEntries;

  if (remaining.length > 0) {
    logPlan(`Leaving install root in place because it is not empty: ${installRoot}`);
    return;
  }

  if (dryRun) {
    logPlan(`DRY RUN remove empty install root ${installRoot}`);
  } else {
    logPlan(`Removing empty install root ${installRoot}`);
    await fs.rmdir(installRoot);
  }
}

async function wipeStateRoot(stateRoot, { wipeData, yes, dryRun }) {
  if (!wipeData) {
    logPlan(`State/data root preserved: ${stateRoot}`);
    return;
  }

  if (!yes) {
    throw new Error('--wipe-data requires --yes. Re-run with both flags to remove state/data.');
  }

  if (!(await pathExists(stateRoot))) {
    logPlan(`State/data root does not exist: ${stateRoot}`);
    return;
  }

  if (dryRun) {
    logPlan(`DRY RUN recursively remove state/data root ${stateRoot}`);
  } else {
    logPlan(`Recursively removing state/data root ${stateRoot}`);
    await fs.rm(stateRoot, { recursive: true, force: false });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const installRoot = resolveRoot(options.installRoot, defaultInstallRoot(), 'install root');
  const stateRoot = resolveRoot(options.stateRoot, defaultStateRoot(), 'state root');

  const composeFiles = await discoverFiles(installRoot, COMPOSE_FILE_NAMES);
  const envFiles = await discoverFiles(installRoot, ENV_FILE_NAMES);
  const filesToRemove = [...composeFiles, ...envFiles];

  logPlan(`install root: ${installRoot}`);
  logPlan(`state root: ${stateRoot}`);
  logPlan(`project name: ${options.projectName}`);
  logPlan(options.effectiveDryRun ? 'mode: dry run' : 'mode: execute');
  if (!options.yes) {
    logPlan('No --yes flag supplied; no files or data will be removed.');
  }

  await runComposeDown({
    installRoot,
    composeFiles,
    envFiles,
    projectName: options.projectName,
    dryRun: options.effectiveDryRun,
  });
  await removeFiles(filesToRemove, options.effectiveDryRun);
  await removeEmptyInstallRoot(installRoot, filesToRemove, options.effectiveDryRun);
  await wipeStateRoot(stateRoot, {
    wipeData: options.wipeData,
    yes: options.yes,
    dryRun: options.effectiveDryRun,
  });

  logPlan('Complete.');
}

main().catch((error) => {
  console.error(`[uninstall] ERROR ${error.message}`);
  process.exitCode = 1;
});
