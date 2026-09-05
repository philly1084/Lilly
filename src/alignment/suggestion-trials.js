'use strict';

const fs = require('fs/promises');
const path = require('path');
const { getStateDirectory } = require('../runtime-state-paths');
const { candidateHash, runTaskTrials } = require('../agent-evals/task-trials');
const cases = require('../agent-evals/outcome-cases.json');

async function evaluateSuggestion(suggestion) {
  const actions = suggestion.input?.actions || [];
  const hash = candidateHash(actions);
  const directory = path.join(getStateDirectory(), 'harness-trials', hash);
  await fs.mkdir(directory, { recursive: true });
  const { execute } = require('../agent-evals/sandbox-adapter');
  // Immutable trial directories preserve the actual artifacts for independent inspection.
  const baseline = await runTaskTrials({ cases, execute, workspace: directory, label: 'baseline' });
  const candidate = await runTaskTrials({ cases, execute, workspace: directory, actions, label: 'candidate' });
  await fs.writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ baseline, candidate }, null, 2));
  return { baseline, candidate };
}

module.exports = { evaluateSuggestion };
