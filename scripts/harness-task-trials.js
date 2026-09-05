#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { runTaskTrials } = require('../src/agent-evals/task-trials');

async function main() {
  const [casePath, adapterPath, outputPath, actionPath] = process.argv.slice(2);
  if (!casePath || !adapterPath || !outputPath) throw new Error('Usage: node scripts/harness-task-trials.js cases.json trusted-adapter.js report.json [actions.json]');
  const cases = JSON.parse(await fs.readFile(casePath, 'utf8'));
  const actions = actionPath ? JSON.parse(await fs.readFile(actionPath, 'utf8')) : [];
  const { execute } = require(path.resolve(adapterPath));
  const workspace = path.resolve(path.dirname(outputPath), 'trial-workspaces');
  await fs.mkdir(workspace, { recursive: true });
  const report = await runTaskTrials({ cases, execute, workspace, actions });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.metrics));
  process.exitCode = report.metrics.verifiedCompletion === 1 ? 0 : 1;
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
