const fs = require('fs');
const path = require('path');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('KimiBuilt coordinated deployment contract', () => {
  test('wraps CI mutation and verification in a non-cancelling coordinator run', () => {
    const workflow = read('.github/workflows/deploy-k3s.yml');
    expect(() => require('js-yaml').load(workflow)).not.toThrow();
    const run = workflow.indexOf('node scripts/k3s-deployment-coordinator.js run');
    const firstMutation = workflow.indexOf('kubectl apply -f k8s/namespace.yaml');
    const heredocEnd = workflow.indexOf('          RELEASE_SCRIPT', firstMutation);

    expect(workflow).toContain('concurrency:');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('--expected-image "$expected_image"');
    expect(workflow).toContain('--source-sha "$RELEASE_SHA"');
    expect(workflow).toContain('export RELEASE_IMAGE="$release_image" RELEASE_ID="$release_id"');
    expect(workflow).toContain('--image "$RELEASE_IMAGE"');
    expect(workflow).toContain('--release-id "$RELEASE_ID"');
    expect(workflow).toContain('-- bash -se <<\'RELEASE_SCRIPT\'');
    expect(run).toBeGreaterThanOrEqual(0);
    expect(firstMutation).toBeGreaterThan(run);
    expect(heredocEnd).toBeGreaterThan(workflow.indexOf('curl --fail', firstMutation));
    expect(workflow).toContain('deploy-release');
    expect(workflow).toContain('frontend-nginx-config.yaml');
    expect(workflow).not.toMatch(/kubectl\s+(apply|patch|create|delete|set)\s+[^\n]*secret/i);
    expect(workflow).not.toContain('kubectl rollout restart deployment/backend');
    expect(workflow).toContain('git rev-parse origin/master');
  });

  test('defines an independent nginx liveness endpoint while retaining proxied readiness', () => {
    const config = read('k8s/frontend-nginx-config.yaml');
    const stack = read('k8s/rancher-stack-update.yaml');
    const frontend = stack.slice(stack.indexOf('name: frontend', stack.indexOf('kind: Deployment')));

    expect(config).toContain('location = /_local/health');
    expect(config).toContain('return 200 "ok\\n";');
    expect(frontend).toContain('readinessProbe:\n            httpGet:\n              path: /');
    expect(frontend).toContain('livenessProbe:\n            httpGet:\n              path: /_local/health');
  });
});
