'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PUBLIC_NAME = 'KimiBuilt Suite';
const CLI_NAME = 'kimibuilt-suite';
const DEFAULT_PROJECT_NAME = 'kimibuilt-suite';
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BUNDLE_DIR = path.join(PACKAGE_ROOT, 'bundle');
const INSTALLER_NAME = process.platform === 'win32' ? 'install-compose.cmd' : 'install-compose.sh';
const UNIX_INSTALLER_NAME = 'install-compose.sh';
const UNINSTALLER_NAME = path.join('scripts', 'uninstall-compose.mjs');

function usage() {
  return `${PUBLIC_NAME} npm wrapper

Usage:
  ${CLI_NAME} install [--dry-run] [install-compose args...]
  ${CLI_NAME} uninstall [uninstall args...]
  ${CLI_NAME} doctor
  ${CLI_NAME} setup-guide
  ${CLI_NAME} env-example
  ${CLI_NAME} bundle-path
  ${CLI_NAME} help

Commands:
  install       Delegates to the bundled compose installer.
  uninstall     Stops/removes installed compose files. Dry run unless --yes is supplied.
  doctor        Verifies Docker, Docker Compose v2, and bundle files.
  setup-guide   Prints the packaged online setup guide.
  env-example   Prints bundle/templates/release.env.example.
  bundle-path   Prints the package bundle directory.

Safety:
  npm install does not start containers.
  Runtime passwords are generated into release.env on the install host.
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

  if (command === 'setup-guide') {
    await printSetupGuide();
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

  const error = new Error(`Unknown command: ${command}. Run: ${CLI_NAME} help`);
  error.exitCode = 64;
  throw error;
}

async function printEnvExample() {
  const envExample = path.join(DEFAULT_BUNDLE_DIR, 'templates', 'release.env.example');
  requireFileOrDirectory(envExample, 'env example');
  process.stdout.write(await fsp.readFile(envExample, 'utf8'));
}

async function printSetupGuide() {
  const setupGuide = path.join(DEFAULT_BUNDLE_DIR, 'docs', 'online-setup.md');
  requireFileOrDirectory(setupGuide, 'online setup guide');
  process.stdout.write(await fsp.readFile(setupGuide, 'utf8'));
}

async function doctor() {
  console.log(`${PUBLIC_NAME} bundle: ${DEFAULT_BUNDLE_DIR}`);
  requireFileOrDirectory(DEFAULT_BUNDLE_DIR, 'bundle directory');

  const installer = resolveInstaller();
  requireFileOrDirectory(installer, 'compose installer');
  console.log(`installer: ${installer}`);

  const envExample = path.join(DEFAULT_BUNDLE_DIR, 'templates', 'release.env.example');
  const composeTemplate = path.join(DEFAULT_BUNDLE_DIR, 'templates', 'release-compose.yaml');
  const setupGuide = path.join(DEFAULT_BUNDLE_DIR, 'docs', 'online-setup.md');
  requireFileOrDirectory(envExample, 'env example');
  requireFileOrDirectory(composeTemplate, 'compose template');
  requireFileOrDirectory(setupGuide, 'online setup guide');

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
  const dryRun = args.includes('--dry-run') || !args.includes('--yes');
  const uninstaller = path.join(DEFAULT_BUNDLE_DIR, UNINSTALLER_NAME);
  const uninstallerArgs = hasOption(args, '--project-name')
    ? args
    : ['--project-name', DEFAULT_PROJECT_NAME, ...args];

  if (dryRun && !fs.existsSync(uninstaller)) {
    const roots = parseUninstallRoots(args);
    console.log(`[uninstall] DRY RUN install root: ${roots.installRoot}`);
    console.log(`[uninstall] DRY RUN state root: ${roots.stateRoot}`);
    console.log(`[uninstall] bundled uninstaller is not present yet: ${uninstaller}`);
    return;
  }

  requireFileOrDirectory(uninstaller, 'compose uninstaller');
  await runCommand(process.execPath, [uninstaller, ...uninstallerArgs], {
    cwd: DEFAULT_BUNDLE_DIR,
    dryRun: false,
    optional: false,
  });
}

function hasOption(args, name) {
  return args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));
}

function parseUninstallRoots(args) {
  return {
    installRoot: valueAfter(args, '--install-root') || defaultInstallRoot(),
    stateRoot: valueAfter(args, '--state-root') || defaultStateRoot(),
  };
}

function valueAfter(args, name) {
  const direct = args.find((arg) => arg.startsWith(`${name}=`));
  if (direct) {
    return direct.slice(name.length + 1);
  }
  const index = args.indexOf(name);
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return '';
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
