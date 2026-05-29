'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PUBLIC_NAME = 'Lilly Suite';
const DEFAULT_PROJECT_NAME = 'lilly-suite';
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BUNDLE_DIR = path.join(PACKAGE_ROOT, 'bundle');
const INSTALLER_NAME = process.platform === 'win32' ? 'install-compose.cmd' : 'install-compose.sh';
const UNIX_INSTALLER_NAME = 'install-compose.sh';
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
  return `${PUBLIC_NAME} npm wrapper

Usage:
  lilly-suite install [--dry-run] [install-compose args...]
  lilly-suite uninstall [uninstall args...]
  lilly-suite doctor
  lilly-suite env-example
  lilly-suite bundle-path
  lilly-suite help

Commands:
  install       Delegates to the bundled compose installer.
  uninstall     Stops/removes installed compose files. Dry run unless --yes is supplied.
  doctor        Verifies Docker, Docker Compose v2, and bundle files.
  env-example   Prints bundle/templates/release.env.example.
  bundle-path   Prints the package bundle directory.

Safety:
  npm install does not start containers.
  Use install --dry-run and uninstall --dry-run for CI/package smoke checks.
`;
}

async function main(argv) {
  const command = argv[0] || 'help';
  const args = argv.length > 0 ? argv.slice(1) : [];

  if (command === 'help' || command === '-h' || command === '--help') {
    console.log(usage());
    return;
  }

  if (command === 'bundle-path') {
    console.log(DEFAULT_BUNDLE_DIR);
    return;
  }

  if (command === 'env-example') {
    await printEnvExample();
    return;
  }

  if (command === 'doctor') {
    await doctor();
    return;
  }

  if (command === 'install') {
    await install(args);
    return;
  }

  if (command === 'uninstall') {
    await uninstall(args);
    return;
  }

  const error = new Error(`Unknown command: ${command}. Run: lilly-suite help`);
  error.exitCode = 64;
  throw error;
}

async function printEnvExample() {
  const envExample = path.join(DEFAULT_BUNDLE_DIR, 'templates', 'release.env.example');
  if (!fs.existsSync(envExample)) {
    throw new Error(`Missing env example: ${envExample}`);
  }
  process.stdout.write(await fsp.readFile(envExample, 'utf8'));
}

async function doctor() {
  console.log(`${PUBLIC_NAME} bundle: ${DEFAULT_BUNDLE_DIR}`);
  requireFileOrDirectory(DEFAULT_BUNDLE_DIR, 'bundle directory');

  const installer = resolveInstaller();
  requireFileOrDirectory(installer, 'compose installer');
  console.log(`installer: ${installer}`);

  await runCommand('docker', ['--version'], { dryRun: false, optional: false });
  await runCommand('docker', ['compose', 'version'], { dryRun: false, optional: false });
}

async function install(args) {
  const dryRun = args.includes('--dry-run');
  const installer = resolveInstaller();

  if (dryRun) {
    console.log(`[install] DRY RUN ${quoteCommand(installer, args.filter((arg) => arg !== '--dry-run'))}`);
    if (!fs.existsSync(installer)) {
      console.log(`[install] bundle installer is not present yet: ${installer}`);
    }
    return;
  }

  requireFileOrDirectory(installer, 'compose installer');
  await runCommand(installer, args, {
    cwd: DEFAULT_BUNDLE_DIR,
    dryRun: false,
    optional: false,
    shell: process.platform === 'win32',
  });
}

async function uninstall(args) {
  const options = parseUninstallArgs(args);
  if (options.help) {
    return;
  }

  const installRoot = resolveRoot(options.installRoot, defaultInstallRoot(), 'install root');
  const stateRoot = resolveRoot(options.stateRoot, defaultStateRoot(), 'state root');
  const composeFiles = await discoverFiles(installRoot, COMPOSE_FILE_NAMES);
  const envFiles = await discoverFiles(installRoot, ENV_FILE_NAMES);
  const filesToRemove = [...composeFiles, ...envFiles];

  logUninstall(`install root: ${installRoot}`);
  logUninstall(`state root: ${stateRoot}`);
  logUninstall(`project name: ${options.projectName}`);
  logUninstall(options.effectiveDryRun ? 'mode: dry run' : 'mode: execute');
  if (!options.yes) {
    logUninstall('No --yes flag supplied; no files or data will be removed.');
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

  logUninstall('Complete.');
}

function resolveInstaller() {
  const platformInstaller = path.join(DEFAULT_BUNDLE_DIR, INSTALLER_NAME);
  if (fs.existsSync(platformInstaller)) {
    return platformInstaller;
  }
  return path.join(DEFAULT_BUNDLE_DIR, UNIX_INSTALLER_NAME);
}

function requireFileOrDirectory(target, label) {
  if (!fs.existsSync(target)) {
    throw new Error(`Missing ${label}: ${target}`);
  }
}

async function runCommand(command, args, options) {
  if (options.dryRun) {
    console.log(`DRY RUN ${quoteCommand(command, args)}`);
    return;
  }

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      stdio: 'inherit',
      shell: !!options.shell,
    });

    child.on('error', (error) => {
      if (options.optional) {
        resolve();
      } else {
        reject(error);
      }
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

function parseUninstallArgs(argv) {
  const options = {
    installRoot: process.env.LILLY_SUITE_INSTALL_ROOT || null,
    stateRoot: process.env.LILLY_SUITE_STATE_ROOT || null,
    projectName: process.env.LILLY_SUITE_COMPOSE_PROJECT || DEFAULT_PROJECT_NAME,
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
      throw new Error(`Unknown uninstall option: ${arg}`);
    }
  }

  if (options.help) {
    console.log(uninstallUsage());
    return options;
  }

  options.effectiveDryRun = options.dryRun || !options.yes;
  return options;
}

function uninstallUsage() {
  return `${PUBLIC_NAME} compose uninstall

Usage:
  lilly-suite uninstall --install-root <path> --state-root <path> [options]

Options:
  --install-root <path>  Installed compose file root. Env: LILLY_SUITE_INSTALL_ROOT.
  --state-root <path>    State/data root. Env: LILLY_SUITE_STATE_ROOT.
  --project-name <name>  Docker Compose project name. Default: lilly-suite.
  --wipe-data            Also remove the state/data root. Requires --yes.
  --yes                  Execute removal. Without this flag the script is a dry run.
  --dry-run              Print planned actions only.
  --help                 Show this help.
`;
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

async function pathExists(target) {
  try {
    await fsp.stat(target);
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
    return await fsp.stat(target);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
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

function logUninstall(message) {
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
    logUninstall('No installed compose files found; skipping docker compose down.');
    return;
  }

  if (dryRun) {
    logUninstall(`DRY RUN docker ${args.map(quoteArg).join(' ')}`);
    return;
  }

  logUninstall(`Stopping compose project ${projectName}.`);
  await runCommand('docker', args, { cwd: installRoot, dryRun: false, optional: false });
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
      logUninstall(`DRY RUN remove file ${file}`);
    } else {
      logUninstall(`Removing file ${file}`);
      await fsp.rm(file, { force: false });
    }
  }
}

async function removeEmptyInstallRoot(installRoot, plannedRemovedFiles, dryRun) {
  if (!(await pathExists(installRoot))) {
    return;
  }

  const plannedBasenames = new Set(plannedRemovedFiles.map((file) => path.basename(file)));
  const existingEntries = await fsp.readdir(installRoot);
  const remaining = dryRun
    ? existingEntries.filter((entry) => !plannedBasenames.has(entry))
    : existingEntries;

  if (remaining.length > 0) {
    logUninstall(`Leaving install root in place because it is not empty: ${installRoot}`);
    return;
  }

  if (dryRun) {
    logUninstall(`DRY RUN remove empty install root ${installRoot}`);
  } else {
    logUninstall(`Removing empty install root ${installRoot}`);
    await fsp.rmdir(installRoot);
  }
}

async function wipeStateRoot(stateRoot, { wipeData, yes, dryRun }) {
  if (!wipeData) {
    logUninstall(`State/data root preserved: ${stateRoot}`);
    return;
  }

  if (!yes) {
    throw new Error('--wipe-data requires --yes. Re-run with both flags to remove state/data.');
  }

  if (!(await pathExists(stateRoot))) {
    logUninstall(`State/data root does not exist: ${stateRoot}`);
    return;
  }

  if (dryRun) {
    logUninstall(`DRY RUN recursively remove state/data root ${stateRoot}`);
  } else {
    logUninstall(`Recursively removing state/data root ${stateRoot}`);
    await fsp.rm(stateRoot, { recursive: true, force: false });
  }
}

function quoteCommand(command, args) {
  return [command, ...args].map(quoteArg).join(' ');
}

function quoteArg(value) {
  if (/^[A-Za-z0-9_./:=@\\-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

module.exports = {
  main,
};
