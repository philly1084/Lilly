jest.mock('../../../../routes/admin/settings.controller', () => ({
  getEffectiveDeployConfig: jest.fn(() => ({
    repositoryUrl: '',
    targetDirectory: '/opt/kimibuilt',
    manifestsPath: 'k8s',
    namespace: 'kimibuilt',
    deployment: 'backend',
    container: 'backend',
    branch: 'master',
    publicDomain: 'demoserver2.buzz',
    ingressClassName: 'traefik',
    tlsClusterIssuer: 'letsencrypt-prod',
  })),
  getEffectiveGitProviderConfig: jest.fn(() => ({
    provider: 'gitlab',
    enabled: true,
    baseURL: 'https://gitlab.demoserver2.buzz',
    token: 'gitlab_test_token',
    org: 'agent-apps',
    registryHost: 'registry.gitlab.demoserver2.buzz',
    registryUsername: 'git',
  })),
}));

const settingsController = require('../../../../routes/admin/settings.controller');
const { K3sDeployTool } = require('./K3sDeployTool');

describe('K3sDeployTool', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GITHUB_TOKEN: 'ghp_test_token',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  test('keeps generic sync-and-apply command behavior without an implicit rollout target', async () => {
    const tool = new K3sDeployTool();
    tool.sshTool.handler = jest.fn().mockResolvedValue({
      stdout: 'applied',
      stderr: '',
      exitCode: 0,
      duration: 25,
      host: 'server:22',
    });

    const result = await tool.execute({
      action: 'sync-and-apply',
      repositoryUrl: 'https://github.com/example/app.git',
      ref: 'main',
      targetDirectory: '/opt/app',
      manifestsPath: 'k8s',
      namespace: 'web',
    });

    expect(result.success).toBe(true);
    expect(tool.sshTool.handler).toHaveBeenCalledTimes(1);
    const request = tool.sshTool.handler.mock.calls[0][0];
    const command = request.command;
    expect(command).toContain("git clone --branch 'main' --single-branch 'https://github.com/example/app.git' '/opt/app'");
    expect(command).toContain('export GIT_ASKPASS="$git_askpass_script"');
    expect(command).toContain('if [ -f "$manifest_dir/namespace.yaml" ]; then kubectl apply -f "$manifest_dir/namespace.yaml"; fi');
    expect(command).toContain('if [ -f "$manifest_dir/cluster-issuer.yaml" ]; then kubectl apply -f "$manifest_dir/cluster-issuer.yaml"; fi');
    expect(command).toContain('namespace.yaml|cluster-issuer.yaml|secret.yaml|rancher-simple.yaml|rancher-stack-update.yaml');
    expect(command).not.toContain('namespace.yaml|cluster-issuer.yaml|secret.yaml|rancher-simple.yaml|rancher-stack-update.yaml|backend-deployment.yaml|frontend-nginx-config.yaml');
    expect(command).toContain('ingress-https.yaml)');
    expect(command).toContain('if [ -f "$manifest_dir/ingress.yaml" ]; then continue; fi');
    expect(command).not.toContain('kubectl rollout status deployment/');
    expect(request.environment).toEqual(expect.objectContaining({
      GITHUB_TOKEN: 'ghp_test_token',
      KIMIBUILT_GIT_PASSWORD: 'ghp_test_token',
    }));
  });

  test('infers sync-and-apply when action is omitted for deploy-shaped params', async () => {
    const tool = new K3sDeployTool();
    tool.sshTool.handler = jest.fn().mockResolvedValue({
      stdout: 'deployment "backend" successfully rolled out',
      stderr: '',
      exitCode: 0,
      duration: 18,
      host: 'server:22',
    });

    const result = await tool.execute({
      repositoryUrl: 'https://github.com/example/app.git',
      ref: 'main',
      targetDirectory: '/opt/app',
      manifestsPath: 'k8s',
      namespace: 'web',
    });

    expect(result.success).toBe(true);
    expect(result.data.action).toBe('sync-and-apply');
    expect(tool.sshTool.handler).toHaveBeenCalledTimes(1);
    expect(tool.sshTool.handler.mock.calls[0][0].command).not.toContain('kubectl rollout status deployment/');
  });

  test('includes rollout status in sync-and-apply only when deployment is explicitly provided', async () => {
    const tool = new K3sDeployTool();
    tool.sshTool.handler = jest.fn().mockResolvedValue({
      stdout: 'deployment "backend" successfully rolled out',
      stderr: '',
      exitCode: 0,
      duration: 18,
      host: 'server:22',
    });

    const result = await tool.execute({
      action: 'sync-and-apply',
      repositoryUrl: 'https://github.com/example/app.git',
      ref: 'main',
      targetDirectory: '/opt/app',
      manifestsPath: 'k8s',
      namespace: 'web',
      deployment: 'site',
    });

    expect(result.success).toBe(true);
    expect(tool.sshTool.handler.mock.calls[0][0].command).toContain("kubectl rollout status deployment/site -n 'web' --timeout=180s");
  });

  test('coordinates kimibuilt/backend set-image with a CAS guard and one release command', () => {
    const tool = new K3sDeployTool();
    const command = tool.buildCommand('set-image', {
      namespace: 'kimibuilt',
      deployment: 'backend',
      container: 'backend',
      image: 'ghcr.io/philly1084/kimibuilt:sha-abcdef1',
      expectedImage: 'ghcr.io/philly1084/kimibuilt:sha-1234567',
      sourceSha: '178e4a178e4a178e4a178e4a178e4a178e4a178e4a',
      targetDirectory: '/opt/kimibuilt',
    });

    expect(command).toContain("/opt/kimibuilt/scripts/k3s-deployment-coordinator.js' run");
    expect(command).toContain("--expected-image 'ghcr.io/philly1084/kimibuilt:sha-1234567'");
    expect(command).toContain("--source-sha '178e4a178e4a178e4a178e4a178e4a178e4a178e4a'");
    expect(command).toContain('deploy-release');
    expect(command).toContain('/opt/kimibuilt/k8s/frontend-nginx-config.yaml');
    expect(command).not.toContain('kubectl rollout restart');
  });

  test('fails closed for uncoordinated kimibuilt/backend manifest application', () => {
    const tool = new K3sDeployTool();

    expect(() => tool.buildCommand('apply-manifests', {
      namespace: 'kimibuilt',
      manifestsPath: '/opt/kimibuilt/k8s/backend-deployment.yaml',
    })).toThrow('Uncoordinated apply-manifests is disabled for kimibuilt/backend');
  });

  test('puts primary sync-and-apply mutation under coordinator run', () => {
    const tool = new K3sDeployTool();
    const command = tool.buildCommand('sync-and-apply', {
      repositoryUrl: 'https://github.com/example/app.git',
      ref: 'master',
      targetDirectory: '/opt/kimibuilt',
      manifestsPath: 'k8s',
      namespace: 'kimibuilt',
      deployment: 'backend',
      container: 'backend',
      image: 'ghcr.io/philly1084/kimibuilt:sha-abcdef1',
      expectedImage: 'ghcr.io/philly1084/kimibuilt:sha-1234567',
      sourceSha: '178e4a178e4a178e4a178e4a178e4a178e4a178e4a',
    });
    const runIndex = command.indexOf("/opt/kimibuilt/scripts/k3s-deployment-coordinator.js' run");
    const firstApplyIndex = command.indexOf('kubectl apply');

    expect(runIndex).toBeGreaterThanOrEqual(0);
    expect(firstApplyIndex).toBeGreaterThan(runIndex);
    expect(command).not.toContain('kubectl apply -f "$manifest_dir/backend-deployment.yaml"');
    expect(command).not.toContain('kubectl rollout restart deployment/backend');
  });

  test('rejects repository urls outside GitHub and configured Git provider', async () => {
    const tool = new K3sDeployTool();

    const result = await tool.execute({
      action: 'sync-repo',
      repositoryUrl: 'https://bitbucket.org/example/app.git',
      targetDirectory: '/opt/app',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Only GitHub clone URLs or the configured Git provider host are allowed');
  });

  test('allows configured GitLab repositories and supplies GitLab credentials', async () => {
    const tool = new K3sDeployTool();
    tool.sshTool.handler = jest.fn().mockResolvedValue({
      stdout: 'synced',
      stderr: '',
      exitCode: 0,
      duration: 11,
      host: 'server:22',
    });

    const result = await tool.execute({
      action: 'sync-repo',
      repositoryUrl: 'https://gitlab.demoserver2.buzz/agent-apps/site.git',
      ref: 'main',
      targetDirectory: '/srv/apps/site',
    });

    expect(result.success).toBe(true);
    const request = tool.sshTool.handler.mock.calls[0][0];
    expect(request.command).toContain("git clone --branch 'main' --single-branch 'https://gitlab.demoserver2.buzz/agent-apps/site.git' '/srv/apps/site'");
    expect(request.environment).toEqual(expect.objectContaining({
      GITLAB_TOKEN: 'gitlab_test_token',
      KIMIBUILT_GIT_USERNAME: 'git',
      KIMIBUILT_GIT_PASSWORD: 'gitlab_test_token',
    }));
  });

  test('normalizes configured GitLab SSH clone URLs to HTTPS when a token is available', () => {
    const tool = new K3sDeployTool();
    const command = tool.buildSyncRepoCommand({
      repositoryUrl: 'git@gitlab.demoserver2.buzz:agent-apps/site.git',
      ref: 'main',
      targetDirectory: '/srv/apps/site',
    });

    expect(command).toContain("git clone --branch 'main' --single-branch 'https://gitlab.demoserver2.buzz/agent-apps/site.git' '/srv/apps/site'");
  });

  test('converts GitHub SSH clone URLs to HTTPS when a token is available', () => {
    const tool = new K3sDeployTool();
    const command = tool.buildSyncRepoCommand({
      repositoryUrl: 'git@github.com:example/app.git',
      ref: 'main',
      targetDirectory: '/opt/app',
    });

    expect(command).toContain("git clone --branch 'main' --single-branch 'https://github.com/example/app.git' '/opt/app'");
  });

  test('uses admin deploy defaults when rollout-status omits deployment details', () => {
    settingsController.getEffectiveDeployConfig.mockReturnValue({
      repositoryUrl: '',
      targetDirectory: '/opt/kimibuilt',
      manifestsPath: 'k8s',
      namespace: 'web',
      deployment: 'site',
      container: 'site',
      branch: 'main',
      publicDomain: 'demoserver2.buzz',
      ingressClassName: 'traefik',
      tlsClusterIssuer: 'letsencrypt-prod',
    });

    const tool = new K3sDeployTool();
    const command = tool.buildRolloutStatusCommand({}, { allowDefaultDeployment: true });

    expect(command).toContain("kubectl rollout status deployment/site -n 'web' --timeout=180s");
  });
});
