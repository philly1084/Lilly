'use strict';

const yaml = require('js-yaml');
const {
    buildDefaultScaffoldFiles,
    normalizeGeneratedManagedAppSourceFiles,
} = require('./scaffold');

describe('managed app scaffold', () => {
    test('generates a BuildKit-based GitLab CI pipeline for the external control plane', () => {
        const files = buildDefaultScaffoldFiles({
            appName: 'Arcade Demo',
            slug: 'arcade-demo',
            publicHost: 'arcade-demo.demoserver2.buzz',
            namespace: 'app-arcade-demo',
            sourcePrompt: 'Build an arcade demo.',
            gitProviderOrg: 'agent-apps',
            imageRepo: 'registry.gitlab.demoserver2.buzz/agent-apps/arcade-demo',
            registryHost: 'registry.gitlab.demoserver2.buzz',
            buildEventsUrl: 'https://kimibuilt.demoserver2.buzz/api/integrations/gitlab/build-events',
        });

        const workflow = files.find((entry) => entry.path === '.gitlab-ci.yml');

        expect(workflow).toBeTruthy();
        expect(workflow.content).toContain('build-and-publish:');
        expect(workflow.content).toContain('image: alpine:3.20');
        expect(workflow.content).toContain('tags:\n    - kimibuilt');
        expect(workflow.content).toContain('apk add --no-cache bash curl wget tar git ca-certificates coreutils');
        expect(workflow.content).toContain('test -f Dockerfile');
        expect(workflow.content).toContain('BUILDKIT_ADDR="${BUILDKIT_HOST:-tcp://buildkitd.agent-platform.svc.cluster.local:1234}"');
        expect(workflow.content).toContain('DEFAULT_TARGET_PLATFORMS: linux/amd64,linux/arm64');
        expect(workflow.content).toContain('linux/amd64,linux/arm64');
        expect(workflow.content).toContain('TARGET_PLATFORMS="${TARGET_PLATFORMS:-$DEFAULT_TARGET_PLATFORMS}"');
        expect(workflow.content).toContain('download() {');
        expect(workflow.content).toContain('curl or wget is required on the runner image');
        expect(workflow.content).toContain('buildctl --addr "$BUILDKIT_ADDR" build');
        expect(workflow.content).toContain('--opt platform="$TARGET_PLATFORMS"');
        expect(workflow.content).toContain('--output "type=image,name=$IMAGE_REPO:$IMAGE_TAG,push=true"');
        expect(workflow.content).toContain('--import-cache "type=registry,ref=$IMAGE_REPO:latest"');
        expect(workflow.content).toContain('BUILD_EVENTS_URL: https://kimibuilt.demoserver2.buzz/api/integrations/gitlab/build-events');
        expect(workflow.content).toContain('notify_kimibuilt() {');
        expect(workflow.content).toContain("trap 'rc=$?; notify_kimibuilt \"$rc\"; exit $?' EXIT");
        expect(workflow.content).toContain('KIMIBUILT_BUILD_EVENTS_SECRET');
        expect(workflow.content).toContain('X-KimiBuilt-Webhook-Secret');
        expect(workflow.content).toContain('KIMIBUILT_BUILD_EVENTS_INSECURE');
        expect(workflow.content).toContain('"buildStatus":"$build_status"');
        expect(workflow.content).toContain('\n      {"repoOwner":"$GIT_PROVIDER_ORG"');
        expect(workflow.content).toContain('\n      EOF\n\n        header_secret=');
        expect(workflow.content).toContain('\n      {"auths":{"$target_registry_host"');
        expect(workflow.content).toContain('\n      EOF\n\n      test -n "$IMAGE_REPO"');
        expect(workflow.content).toContain('"deployRequested":true');
        expect(workflow.content).toContain('CI_PIPELINE_ID');
        expect(workflow.content).toContain('CI_PIPELINE_URL');
        expect(workflow.content).not.toContain('--method=POST');
        expect(workflow.content).not.toContain('--body-file="$payload_file"');
        expect(workflow.content).not.toContain('uses: actions/checkout@v4');
        expect(workflow.content).not.toContain('GITEA_REGISTRY_USERNAME');
        expect(() => yaml.safeLoad(workflow.content)).not.toThrow();
    });

    test('normalizes generated source files down to the supported public bundle', () => {
        const files = normalizeGeneratedManagedAppSourceFiles([
            {
                path: 'public/index.html',
                content: '<!DOCTYPE html><html><body>Hello</body></html>',
            },
            {
                path: 'public/styles.css',
                content: 'body{margin:0;}',
            },
            {
                path: 'README.md',
                content: '# ignored',
            },
            {
                path: 'public/app.js',
                content: 'console.log("ok");',
            },
        ]);

        expect(files).toEqual([
            {
                path: 'public/index.html',
                content: '<!DOCTYPE html><html><body>Hello</body></html>',
            },
            {
                path: 'public/styles.css',
                content: 'body{margin:0;}',
            },
            {
                path: 'public/app.js',
                content: 'console.log("ok");',
            },
        ]);
    });
});
