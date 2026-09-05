'use strict';

const { createEvidenceAttestation, stableSha256 } = require('../agent-evidence');
const { attestCommandResult, attestTestResult, attestDeploymentResult } = require('../evidence-producers');

function collectRuntimeEvidence(toolId, params = {}, result = {}) {
  if (result.success !== true) return [];
  const data = result.data || {};
  const command = String(params.command || '').trim();
  const receipts = [];
  if (['remote-command', 'ssh-execute'].includes(toolId) && Number.isInteger(data.exitCode)) {
    const input = { command, exitCode: data.exitCode, outputDigest: stableSha256(data.stdout || ''),
      sourceInvocationId: result.invocation?.id || null };
    receipts.push(attestCommandResult(input));
    if (/^(?:npm (?:test|run test\S*)|npx (?:jest|vitest)|pytest|python -m pytest|node .*jest[^ ]*|node --test)(?:\s|$)/.test(command)) {
      receipts.push(attestTestResult({ ...input, subject: command }));
    }
    const rollout = command.match(/^kubectl(?:\s+-n\s+[\w-]+)?\s+rollout\s+status\s+(\S+)/);
    if (rollout && data.exitCode === 0 && /successfully rolled out/.test(data.stdout || '')) {
      receipts.push(attestDeploymentResult({ subject: rollout[1], rolloutStatus: 'ready', sourceInvocationId: input.sourceInvocationId }));
    }
  }
  if (['web-fetch', 'web-scrape'].includes(toolId)) {
    const content = data.content || data.text || data.body;
    const status = data.statusCode || data.status;
    if (typeof content === 'string' && content.trim() && (!status || (Number(status) >= 200 && Number(status) < 400))) {
      receipts.push(createEvidenceAttestation({ kind: 'source', subject: data.url || params.url,
        verdict: 'pass', details: { contentDigest: stableSha256(content) }, sourceInvocationId: result.invocation?.id || null }));
    }
  }
  return receipts;
}

module.exports = { collectRuntimeEvidence };
