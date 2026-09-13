const fs = require('node:fs');
const path = require('node:path');
const { GROK_SOURCE_REVISION } = require('./acp-client');

describe('Grok source worker container definition', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  test('pins source and toolchain without disabling upstream sandbox features', () => {
    expect(dockerfile).toContain('FROM docker.io/library/rust:1.94.0-bookworm AS builder');
    expect(dockerfile).toContain(`git fetch --depth=1 origin ${GROK_SOURCE_REVISION}`);
    expect(dockerfile).toContain(`test "$(git rev-parse HEAD)" = ${GROK_SOURCE_REVISION}`);
    expect(dockerfile).toContain('https://github.com/facebook/dotslash/releases/download/v0.5.9/');
    expect(dockerfile).toContain('11323ef72fac5885d7c54bff70d666486bd800a8d908d0acd3bd838fd8a9b0db');
    expect(dockerfile).toContain('5cefa0f258e0a58ae53c7a9a5be3890574ddd33d57c66bc9c143cb411012d72a');
    expect(dockerfile).toContain('sha256sum --check --strict');
    expect(dockerfile).not.toContain('cargo install dotslash');
    expect(dockerfile).toContain('cargo build --locked -p xai-grok-pager-bin --release');
    expect(dockerfile).not.toMatch(/--no-default-features|--always-approve/);
  });
  test('preserves upstream source, notices, lockfile and binary digest', () => {
    expect(dockerfile).toContain('cp LICENSE THIRD-PARTY-NOTICES SOURCE_REV Cargo.lock rust-toolchain.toml');
    expect(dockerfile).toContain('git archive --format=tar.gz HEAD');
    expect(dockerfile).toContain('sha256sum /out/bin/xai-grok-pager');
    expect(dockerfile).toContain('COPY --from=builder /out/provenance/ /usr/share/doc/grok-build/');
  });
  test('uses compatible CPU flags and single-job compilation in both clean and recovery recipes', () => {
    const recovery = fs.readFileSync(path.join(__dirname, 'Recovery.Dockerfile'), 'utf8');
    for (const recipe of [dockerfile, recovery]) {
      expect(recipe).toContain('CARGO_BUILD_JOBS=1');
      expect(recipe).toContain('RUSTFLAGS="-C target-cpu=generic -C force-unwind-tables=yes"');
      expect(recipe).toContain('/out/provenance/build-settings.txt');
      expect(recipe).toContain('cargo build --locked -p xai-grok-pager-bin --release');
      expect(recipe).not.toMatch(/--no-default-features|--always-approve/);
    }
    const runtimeStage = (recipe) => recipe.slice(recipe.indexOf('FROM docker.io/library/debian:bookworm-slim AS runtime'))
      .split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#')).join('\n');
    expect(runtimeStage(recovery)).toBe(runtimeStage(dockerfile));
  });
  test('recovery is terminal-attempt gated, exclusive, bounded and non-destructive', () => {
    const script = fs.readFileSync(path.join(__dirname, 'recover-candidate.sh'), 'utf8');
    expect(script).toContain('test "$(cat resume.exit)" = 101');
    expect(script).toContain('mkdir recovery.lock');
    expect(script).toContain('test ! -e recovery.pid');
    expect(script).toContain('--memory=10g --cpu-period=100000 --cpu-quota=200000');
    expect(script).toContain('--kill-after=30s 7200s');
    expect(script).toContain('> recovery.exit');
    expect(script).not.toMatch(/kubectl|podman push|podman prune|rm -/);
  });
  test('uses nonroot safe default and excludes repository/credential build context', () => {
    expect(dockerfile).toContain('USER 10001:10001');
    expect(dockerfile).not.toMatch(/^ENTRYPOINT\s/m);
    expect(dockerfile).toContain('CMD ["/opt/grok/bin/xai-grok-pager", "--no-auto-update", "--version"]');
    expect(dockerfile).not.toMatch(/(?:ENV|ARG)\s+(?:XAI_API_KEY|LILLY_MODEL_API_KEY)/);
    expect(fs.readFileSync(path.join(__dirname, '.dockerignore'), 'utf8').trim()).toBe('**\n!Dockerfile\n!worker-config.toml');
    expect(fs.readFileSync(path.join(__dirname, 'worker-config.toml'), 'utf8')).toContain('auto_update = false');
  });
});
