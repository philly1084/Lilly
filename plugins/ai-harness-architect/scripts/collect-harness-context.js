#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'coverage',
  'output',
  'tmp',
  '.playwright-cli',
]);

const TEXT_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
  '.md',
  '.mjs',
  '.cjs',
  '.html',
  '.css',
  '.yaml',
  '.yml',
]);

const HARNESS_PATTERNS = [
  'harness',
  'agent',
  'orchestrator',
  'planner',
  'runtime',
  'response',
  'model',
  'tool',
  'sandbox',
  'eval',
  'fixture',
  'memory',
  'prompt',
  'trace',
  'router',
  'workflow',
];

const SURFACE_RULES = [
  {
    name: 'coreRuntime',
    test: (rel) => rel.startsWith('src/') && /(orchestrator|runtime|runner|conversation|agent|openai|route|server)/i.test(rel),
  },
  {
    name: 'tooling',
    test: (rel) => /(tool|adapter|sdk|bin\/|scripts\/)/i.test(rel),
  },
  {
    name: 'memoryContext',
    test: (rel) => /(memory|skill|prompt|context|trace)/i.test(rel),
  },
  {
    name: 'evalsTests',
    test: (rel) => /(\.test\.|__tests__|fixture|eval|harness)/i.test(rel),
  },
  {
    name: 'frontendSandbox',
    test: (rel) => rel.startsWith('frontend/') || /(sandbox|preview|canvas|web-chat|notation|ui-check)/i.test(rel),
  },
  {
    name: 'deploymentOps',
    test: (rel) => /(^k8s\/|docker|ingress|deploy|rancher|cluster)/i.test(rel),
  },
  {
    name: 'pluginSkill',
    test: (rel) => rel.startsWith('plugins/') || rel.startsWith('data/skills/') || rel.endsWith('skill.md'),
  },
  {
    name: 'docs',
    test: (rel) => /\.(md|markdown)$/i.test(rel) || /agents\.md|readme\.md/i.test(rel),
  },
];

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    maxFiles: 5000,
    maxCandidates: 80,
    includePluginFiles: false,
    format: 'json',
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      args.root = argv[index + 1] || args.root;
      index += 1;
    } else if (arg === '--max-files') {
      args.maxFiles = Number(argv[index + 1]) || args.maxFiles;
      index += 1;
    } else if (arg === '--max-candidates') {
      args.maxCandidates = Number(argv[index + 1]) || args.maxCandidates;
      index += 1;
    } else if (arg === '--include-plugin-files') {
      args.includePluginFiles = true;
    } else if (arg === '--format') {
      args.format = argv[index + 1] || args.format;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node collect-harness-context.js --root <repo>

Options:
  --root <path>             Repository root. Defaults to current directory.
  --max-files <number>      Stop scanning after this many text files.
  --max-candidates <number> Limit candidate files in the output.
  --include-plugin-files    Include this plugin's files in candidate scoring.
  --format <json|markdown>  Output JSON or a Markdown architecture brief.
`);
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function safeReadText(filePath, maxChars = 6000) {
  try {
    return fs.readFileSync(filePath, 'utf8').slice(0, maxChars);
  } catch (_error) {
    return '';
  }
}

function walk(root, options, state = { files: [] }) {
  if (state.files.length >= options.maxFiles) {
    return state.files;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_error) {
    return state.files;
  }

  for (const entry of entries) {
    if (state.files.length >= options.maxFiles) {
      break;
    }

    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const isSelfPlugin = options.selfPluginRoot
        && path.resolve(fullPath).toLowerCase() === options.selfPluginRoot.toLowerCase();
      if (!EXCLUDED_DIRS.has(entry.name) && (options.includePluginFiles || !isSelfPlugin)) {
        walk(fullPath, options, state);
      }
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (entry.isFile() && TEXT_EXTENSIONS.has(ext)) {
      state.files.push(fullPath);
    }
  }

  return state.files;
}

function relative(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function scoreFile(root, filePath) {
  const rel = relative(root, filePath).toLowerCase();
  const text = safeReadText(filePath).toLowerCase();
  const haystack = `${rel}\n${text}`;
  const matches = HARNESS_PATTERNS
    .map((pattern) => ({
      pattern,
      count: (haystack.match(new RegExp(pattern, 'g')) || []).length,
    }))
    .filter((match) => match.count > 0);

  const pathBoost = [
    '/src/',
    '/bin/',
    '/frontend/',
    '/plugins/',
    '/data/skills/',
    '.test.',
    'skill.md',
    'package.json',
  ].reduce((total, token) => total + (rel.includes(token) ? 3 : 0), 0);

  const score = matches.reduce((total, match) => total + Math.min(match.count, 12), 0) + pathBoost;
  const categories = classifySurface(relative(root, filePath));
  return {
    path: relative(root, filePath),
    score,
    categories,
    matches: matches.map((match) => match.pattern),
  };
}

function classifySurface(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  const categories = SURFACE_RULES
    .filter((rule) => rule.test(normalized))
    .map((rule) => rule.name);
  return categories.length ? categories : ['uncategorized'];
}

function groupByCategory(candidates) {
  return SURFACE_RULES.reduce((groups, rule) => {
    const paths = candidates
      .filter((candidate) => candidate.categories.includes(rule.name))
      .slice(0, 8)
      .map((candidate) => candidate.path);
    if (paths.length) {
      groups[rule.name] = paths;
    }
    return groups;
  }, {});
}

function collectNamedFiles(root, names) {
  return names
    .map((name) => path.join(root, name))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => relative(root, filePath));
}

function summarizePackage(root) {
  const packagePath = path.join(root, 'package.json');
  const pkg = safeReadJson(packagePath);
  if (!pkg) {
    return null;
  }

  return {
    name: pkg.name || null,
    version: pkg.version || null,
    main: pkg.main || null,
    bin: pkg.bin || {},
    scripts: pkg.scripts || {},
    dependencies: Object.keys(pkg.dependencies || {}).sort(),
    devDependencies: Object.keys(pkg.devDependencies || {}).sort(),
  };
}

function listItems(items, fallback = '- None found') {
  if (!items || !items.length) {
    return fallback;
  }
  return items.map((item) => `- ${item}`).join('\n');
}

function listChecks(checks) {
  if (!checks || !checks.length) {
    return '- None inferred';
  }
  return checks.map((check) => `- ${check.name}: \`${check.command}\``).join('\n');
}

function renderMarkdownReport(context) {
  const packageName = context.package?.name || 'unknown';
  const generatedDate = context.generatedAt.split('T')[0];
  const surfaces = Object.entries(context.surfaceMap || {})
    .map(([name, paths]) => `### ${name}\n${listItems(paths)}`)
    .join('\n\n') || 'No harness surfaces found.';
  const topCandidates = (context.likelyHarnessFiles || [])
    .slice(0, 12)
    .map((item) => `- ${item.path} (${item.categories.join(', ')}; score ${item.score})`)
    .join('\n') || '- None found';

  return [
    '# Harness Architecture Pass',
    '',
    `Generated: ${context.generatedAt}`,
    `Repository: ${context.root}`,
    `Package: ${packageName}`,
    `Scanned text files: ${context.scannedTextFiles}`,
    '',
    '## Repo Model',
    '',
    'Instructions:',
    listItems(context.instructions),
    '',
    'Suggested next reads:',
    listItems(context.suggestedNextReads),
    '',
    'Top harness candidates:',
    topCandidates,
    '',
    '## Surface Map',
    '',
    surfaces,
    '',
    '## Regression Decision Inputs',
    '',
    'Control candidates:',
    listItems(context.regressionDecisionInputs?.controlCandidates),
    '',
    'Implementation candidates:',
    listItems(context.regressionDecisionInputs?.implementationCandidates),
    '',
    'Visual verification candidates:',
    listItems(context.regressionDecisionInputs?.visualVerificationCandidates),
    '',
    '## Suggested Checks',
    '',
    listChecks(context.suggestedChecks),
    '',
    '## Decision Breakdown Template',
    '',
    'Decision: <what architecture choice is being made>',
    'Repo Evidence: <files, tests, routes, or logs inspected>',
    'Options: <2-3 short options>',
    'Chosen Path: <selected option and why>',
    'Risks: <regression/cost/latency/context/user-experience risks>',
    'Checks: <tests, harness runs, sandbox/browser checks>',
    'Result: <pass/fail evidence and next action>',
    '',
    `Report Date: ${generatedDate}`,
  ].join('\n');
}

function collectHarnessContext(args) {
  const root = path.resolve(args.root);
  args.selfPluginRoot = path.resolve(__dirname, '..');
  const files = walk(root, args);
  const scored = files
    .map((filePath) => scoreFile(root, filePath))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, args.maxCandidates);

  const packageSummary = summarizePackage(root);
  return {
    generatedAt: new Date().toISOString(),
    root,
    scannedTextFiles: files.length,
    instructions: collectNamedFiles(root, ['AGENTS.md', 'agents.md', 'README.md']),
    package: packageSummary,
    likelyHarnessFiles: scored,
    surfaceMap: groupByCategory(scored),
    suggestedNextReads: scored.slice(0, 12).map((item) => item.path),
    suggestedChecks: packageSummary
      ? Object.entries(packageSummary.scripts)
        .filter(([name]) => /test|lint|check|harness|eval|intelligence/i.test(name))
        .map(([name, command]) => ({ name, command }))
      : [],
    regressionDecisionInputs: {
      controlCandidates: scored
        .filter((item) => item.categories.includes('evalsTests'))
        .slice(0, 8)
        .map((item) => item.path),
      implementationCandidates: scored
        .filter((item) => item.categories.some((category) => [
          'coreRuntime',
          'tooling',
          'memoryContext',
          'frontendSandbox',
        ].includes(category)))
        .slice(0, 12)
        .map((item) => item.path),
      visualVerificationCandidates: scored
        .filter((item) => item.categories.includes('frontendSandbox'))
        .slice(0, 8)
        .map((item) => item.path),
    },
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const output = collectHarnessContext(args);
  if (args.format === 'markdown') {
    console.log(renderMarkdownReport(output));
    return;
  }

  if (args.format !== 'json') {
    console.error(`Unsupported format: ${args.format}`);
    process.exitCode = 2;
    return;
  }

  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  collectHarnessContext,
  classifySurface,
  groupByCategory,
  renderMarkdownReport,
};
