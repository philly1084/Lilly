const {
    END_TO_END_WORKFLOW_KIND,
    advanceEndToEndBuilderWorkflow,
    buildEndToEndWorkflowPlan,
    evaluateEndToEndBuilderWorkflow,
    inferEndToEndBuilderWorkflow,
} = require('./end-to-end-builder');

function buildToolEvent(tool, params = {}, result = {}) {
    return {
        toolCall: {
            function: {
                name: tool,
                arguments: JSON.stringify(params),
            },
        },
        result: {
            success: true,
            toolId: tool,
            data: {},
            ...result,
        },
    };
}

describe('end-to-end builder workflow', () => {
    test('classifies repo-to-deploy requests into a repo-then-deploy lane', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Fix the landing page in the repo, push it to GitHub, deploy it to k3s, and verify the rollout.',
            workspacePath: '/workspace/app',
            repositoryPath: '/workspace/app',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });

        expect(workflow).toEqual(expect.objectContaining({
            kind: END_TO_END_WORKFLOW_KIND,
            lane: 'repo-then-deploy',
            stage: 'implementing',
            status: 'active',
            requiresVerification: true,
            completionCriteria: [
                'Repository implementation completed',
                'Remote workspace built and deployed',
                'Deployment verified',
            ],
            verificationCriteria: [
                'Remote workspace build completed',
                'Kubernetes apply completed',
                'Post-deploy remote verification captured',
            ],
            workspacePath: '/workspace/app',
            repositoryPath: '/workspace/app',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        }));
    });

    test('classifies explicit remote CLI create-and-deploy requests into a repo-then-deploy lane', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Use the remote CLI to create a tiny smoke-test app and add it to the k3s cluster.',
            workspacePath: '/workspace/app',
            repositoryPath: '/workspace/app',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });

        expect(workflow).toEqual(expect.objectContaining({
            kind: END_TO_END_WORKFLOW_KIND,
            lane: 'repo-then-deploy',
            stage: 'implementing',
            status: 'active',
        }));
    });

    test('does not claim explicit remote CLI agent authoring requests', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'can you use remote cli agent to build a weather app on the server. use weather.demoserver2.buzz for the dns and build the ingress and tls.',
            workspacePath: '/workspace/app',
            repositoryPath: '/workspace/app',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });

        expect(workflow).toBeNull();
    });

    test('does not claim hyphenated remote-cli-agent authoring requests', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Use remote-cli-agent to build a weather app on the server and deploy weather.demoserver2.buzz.',
            workspacePath: '/workspace/app',
            repositoryPath: '/workspace/app',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });

        expect(workflow).toBeNull();
    });

    test('classifies remote CLI dashboard create-and-deploy requests into a repo-then-deploy lane', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Can you make a dashboard on the remote server with the cli tool and have it take live data on satellite locations and overlay it on a 3d world, then deploy it with k3s routing for world.demoserver2.buzz.',
            workspacePath: '/workspace/app',
            repositoryPath: '/workspace/app',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });

        expect(workflow).toEqual(expect.objectContaining({
            kind: END_TO_END_WORKFLOW_KIND,
            lane: 'repo-then-deploy',
            stage: 'implementing',
            status: 'active',
        }));
    });

    test('classifies make-code-and-deploy requests into a repo-then-deploy lane', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'next.js, I have kimibuilt.secdevsolutions.help and you need to do the tls with traefik, acme, and lets encrypt. We should be able to use remote CLI to make the code and push to github.',
            workspacePath: '/workspace/app',
            repositoryPath: '/workspace/app',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });

        expect(workflow).toEqual(expect.objectContaining({
            kind: END_TO_END_WORKFLOW_KIND,
            lane: 'repo-then-deploy',
            stage: 'implementing',
            status: 'active',
        }));
    });

    test('emits deterministic repo-then-deploy steps in order and stops after save-and-push', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Fix the build in the repo, push it to GitHub, deploy it to k3s, and verify the rollout.',
            workspacePath: '/workspace/app',
            repositoryPath: '/workspace/app',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });
        const toolPolicy = {
            candidateToolIds: ['remote-command', 'git-safe', 'k3s-deploy'],
        };

        const implementationPlan = buildEndToEndWorkflowPlan({
            workflow,
            toolPolicy,
            remoteToolId: 'remote-command',
        });
        expect(implementationPlan).toEqual([
            expect.objectContaining({
                tool: 'remote-command',
                params: expect.objectContaining({
                    workflowAction: 'implement-remote-workspace',
                    workingDirectory: '/workspace/app',
                    command: expect.stringContaining('planned objective'),
                }),
            }),
        ]);

        const afterImplementation = advanceEndToEndBuilderWorkflow({
            workflow,
            toolEvents: [
                buildToolEvent('remote-command', { workflowAction: 'implement-remote-workspace' }, {
                    data: {
                        workspacePath: '/workspace/app',
                        summary: 'Build fixed.',
                    },
                }),
            ],
        });
        expect(afterImplementation).toEqual(expect.objectContaining({
            stage: 'saving',
            progress: expect.objectContaining({
                implemented: true,
            }),
        }));

        const deployPlan = buildEndToEndWorkflowPlan({
            workflow: afterImplementation,
            toolPolicy,
            remoteToolId: 'remote-command',
        });
        expect(deployPlan).toEqual([
            expect.objectContaining({
                tool: 'remote-command',
                params: expect.objectContaining({
                    workflowAction: 'build-and-deploy-remote-workspace',
                    workingDirectory: '/workspace/app',
                }),
            }),
        ]);

        const afterDeploy = advanceEndToEndBuilderWorkflow({
            workflow: afterImplementation,
            toolEvents: [
                buildToolEvent('remote-command', { workflowAction: 'build-and-deploy-remote-workspace' }, {
                    data: {
                        stdout: 'deployment applied',
                    },
                }),
            ],
        });
        const verifyPlan = buildEndToEndWorkflowPlan({
            workflow: afterDeploy,
            toolPolicy,
            remoteToolId: 'remote-command',
        });
        expect(verifyPlan).toEqual([
            expect.objectContaining({
                tool: 'remote-command',
                params: expect.objectContaining({
                    workflowAction: 'verify-deployment',
                }),
            }),
        ]);

        const afterVerify = advanceEndToEndBuilderWorkflow({
            workflow: afterDeploy,
            toolEvents: [
                buildToolEvent('remote-command', { workflowAction: 'verify-deployment' }, {
                    data: {
                        stdout: 'deployment "backend" successfully rolled out',
                    },
                }),
            ],
        });
        expect(afterVerify).toEqual(expect.objectContaining({
            stage: 'completed',
            status: 'completed',
            progress: expect.objectContaining({
                implemented: true,
                deployed: true,
                verified: true,
            }),
        }));
        expect(buildEndToEndWorkflowPlan({
            workflow: afterVerify,
            toolPolicy,
            remoteToolId: 'remote-command',
        })).toEqual([]);
    });

    test('uses remote-command before managed-app when both remote CLI and managed control plane are available', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Fix the hello-stack app and deploy it to k3s on the remote server using Gitea.',
            workspacePath: '/workspace/app',
            repositoryPath: '/workspace/app',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });
        const toolPolicy = {
            candidateToolIds: ['managed-app', 'remote-command'],
            preferredRemoteToolId: 'remote-command',
        };

        const implementationPlan = buildEndToEndWorkflowPlan({
            workflow,
            toolPolicy,
            remoteToolId: 'remote-command',
        });

        expect(implementationPlan).toEqual([
            expect.objectContaining({
                tool: 'remote-command',
                params: expect.objectContaining({
                    workflowAction: 'implement-remote-workspace',
                    workingDirectory: '/workspace/app',
                }),
            }),
        ]);
    });

    test('uses remote-command to implement, build, and deploy a remote workspace', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Fix the app in the remote repo, deploy it to k3s on the same server, and verify the rollout.',
            workspacePath: '/var/www/test.demoserver2.buzz',
            repositoryPath: '/workspace/local-clone',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });
        const toolPolicy = {
            candidateToolIds: ['remote-command'],
            preferredRemoteToolId: 'remote-command',
        };

        expect(workflow).toEqual(expect.objectContaining({
            lane: 'repo-then-deploy',
            deliveryMode: 'remote-workspace',
            completionCriteria: expect.arrayContaining([
                'Remote workspace built and deployed',
            ]),
        }));

        const implementationPlan = buildEndToEndWorkflowPlan({
            workflow,
            toolPolicy,
            remoteToolId: 'remote-command',
        });
        expect(implementationPlan).toEqual([
            expect.objectContaining({
                tool: 'remote-command',
                params: expect.objectContaining({
                    workflowAction: 'implement-remote-workspace',
                    workingDirectory: '/var/www/test.demoserver2.buzz',
                    command: expect.stringContaining('planned objective'),
                }),
            }),
        ]);

        const afterImplementation = advanceEndToEndBuilderWorkflow({
            workflow,
            toolEvents: [
                buildToolEvent('remote-command', { workflowAction: 'implement-remote-workspace' }, {
                    data: {
                        workspacePath: '/var/www/test.demoserver2.buzz',
                        summary: 'Remote repo updated.',
                    },
                }),
            ],
        });
        expect(afterImplementation).toEqual(expect.objectContaining({
            stage: 'saving',
            progress: expect.objectContaining({
                implemented: true,
            }),
        }));

        const deployPlan = buildEndToEndWorkflowPlan({
            workflow: afterImplementation,
            toolPolicy,
            remoteToolId: 'remote-command',
        });
        expect(deployPlan).toEqual([
            expect.objectContaining({
                tool: 'remote-command',
                reason: expect.stringContaining('Build the remote workspace'),
                params: expect.objectContaining({
                    host: '10.0.0.5',
                    username: 'ubuntu',
                    port: 22,
                    workingDirectory: '/var/www/test.demoserver2.buzz',
                    timeout: 600000,
                    workflowAction: 'build-and-deploy-remote-workspace',
                    command: expect.stringContaining('kubectl apply -f'),
                }),
            }),
        ]);
        expect(deployPlan[0].params.command).toContain('app/package.json');

        const completedWorkflow = advanceEndToEndBuilderWorkflow({
            workflow: afterImplementation,
            toolEvents: [
                buildToolEvent('remote-command', {
                    workflowAction: 'build-and-deploy-remote-workspace',
                }, {
                    data: {
                        stdout: 'deployment "backend" successfully rolled out',
                    },
                }),
            ],
        });
        expect(completedWorkflow).toEqual(expect.objectContaining({
            stage: 'verifying',
            status: 'active',
            progress: expect.objectContaining({
                deployed: true,
                verified: false,
            }),
        }));

        const verificationPlan = buildEndToEndWorkflowPlan({
            workflow: completedWorkflow,
            toolPolicy,
            remoteToolId: 'remote-command',
        });
        expect(verificationPlan).toEqual([
            expect.objectContaining({
                tool: 'remote-command',
                reason: expect.stringContaining('Verify the rollout'),
                params: expect.objectContaining({
                    host: '10.0.0.5',
                    username: 'ubuntu',
                    port: 22,
                    timeout: 240000,
                    workflowAction: 'verify-deployment',
                    command: expect.stringContaining('kubectl get svc,ingress -A -o wide'),
                }),
            }),
        ]);
    });

    test('does not seed generic deploy-only workflows with the configured KimiBuilt backend lane', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Sync and apply the manifests for the game to the k3s cluster.',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
            deployDefaults: {
                repositoryUrl: 'https://github.com/philly1084/kimibuilt.git',
                targetDirectory: '/opt/kimibuilt',
                manifestsPath: 'k8s',
                namespace: 'kimibuilt',
                deployment: 'backend',
                publicDomain: 'kimibuilt.demoserver2.buzz',
            },
        });

        expect(workflow).toEqual(expect.objectContaining({
            lane: 'deploy-only',
            deploy: expect.objectContaining({
                repositoryUrl: null,
                targetDirectory: null,
                manifestsPath: null,
                namespace: null,
                deployment: null,
                publicDomain: null,
                targetSource: 'unspecified',
            }),
        }));

        const blockedWorkflow = evaluateEndToEndBuilderWorkflow({
            workflow,
            toolPolicy: {
                candidateToolIds: ['k3s-deploy', 'remote-command'],
                preferredRemoteToolId: 'remote-command',
            },
            remoteToolId: 'remote-command',
            deployDefaults: {
                repositoryUrl: 'https://github.com/philly1084/kimibuilt.git',
                targetDirectory: '/opt/kimibuilt',
                manifestsPath: 'k8s',
                namespace: 'kimibuilt',
                deployment: 'backend',
                publicDomain: 'kimibuilt.demoserver2.buzz',
            },
        });

        expect(blockedWorkflow).toEqual(expect.objectContaining({
            stage: 'blocked',
            status: 'blocked',
            lastError: expect.stringContaining('Refusing to assume `kimibuilt/backend`'),
        }));
    });

    test('reuses the configured deploy lane only when the objective explicitly targets it', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Redeploy the kimibuilt GitHub repo for kimibuilt.demoserver2.buzz on the cluster and verify it comes back.',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
            deployDefaults: {
                repositoryUrl: 'https://github.com/philly1084/kimibuilt.git',
                targetDirectory: '/opt/kimibuilt',
                manifestsPath: 'k8s',
                namespace: 'kimibuilt',
                deployment: 'backend',
                publicDomain: 'kimibuilt.demoserver2.buzz',
            },
        });

        expect(workflow).toEqual(expect.objectContaining({
            lane: 'deploy-only',
            deploy: expect.objectContaining({
                repositoryUrl: 'https://github.com/philly1084/kimibuilt.git',
                targetDirectory: '/opt/kimibuilt',
                manifestsPath: 'k8s',
                namespace: 'kimibuilt',
                deployment: 'backend',
                publicDomain: 'kimibuilt.demoserver2.buzz',
                targetSource: 'configured-default',
            }),
        }));
    });

    test('does not mark deployment verification complete for generic remote-command success without a verification workflow action', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Deploy the penguin site to penguin.demoserver2.buzz on k3s with Traefik TLS and Let\'s Encrypt.',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });

        const afterDeploy = advanceEndToEndBuilderWorkflow({
            workflow,
            toolEvents: [
                buildToolEvent('k3s-deploy', {
                    action: 'sync-and-apply',
                }, {
                    data: {
                        action: 'sync-and-apply',
                        stdout: 'deployment "backend" successfully rolled out',
                    },
                }),
            ],
        });

        const afterGenericRemoteInspection = advanceEndToEndBuilderWorkflow({
            workflow: afterDeploy,
            toolEvents: [
                buildToolEvent('remote-command', {
                    command: 'kubectl get pods -n kimibuilt -o wide',
                }, {
                    data: {
                        stdout: 'backend-7d9c4dfc5b-abcde 1/1 Running',
                    },
                }),
            ],
        });

        expect(afterGenericRemoteInspection).toEqual(expect.objectContaining({
            stage: 'verifying',
            status: 'active',
            progress: expect.objectContaining({
                deployed: true,
                verified: false,
            }),
        }));
    });

    test('requires ingress and HTTPS verification for public website deployments before completing the workflow', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Deploy the penguin site to penguin.demoserver2.buzz on k3s with Traefik TLS and Let\'s Encrypt.',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });

        const afterDeploy = advanceEndToEndBuilderWorkflow({
            workflow,
            toolEvents: [
                buildToolEvent('k3s-deploy', {
                    action: 'sync-and-apply',
                }, {
                    data: {
                        action: 'sync-and-apply',
                        stdout: 'deployment "backend" successfully rolled out',
                    },
                }),
            ],
        });

        expect(afterDeploy).toEqual(expect.objectContaining({
            stage: 'verifying',
            status: 'active',
            progress: expect.objectContaining({
                deployed: true,
                verified: false,
            }),
        }));

        const verificationPlan = buildEndToEndWorkflowPlan({
            workflow: afterDeploy,
            toolPolicy: {
                candidateToolIds: ['k3s-deploy', 'remote-command'],
                preferredRemoteToolId: 'remote-command',
            },
            remoteToolId: 'remote-command',
        });

        expect(verificationPlan).toEqual([
            expect.objectContaining({
                tool: 'remote-command',
                reason: expect.stringContaining('ingress, TLS, and public site reachability'),
                params: expect.objectContaining({
                    workflowAction: 'verify-deployment',
                    command: expect.stringContaining("expected_host='penguin.demoserver2.buzz'"),
                }),
            }),
        ]);
        expect(verificationPlan[0].params.command).toContain('kubectl get ingress -A');
        expect(verificationPlan[0].params.command).toContain('curl -fsSIL --max-time 20 "https://$host"');
        expect(verificationPlan[0].params.command).toContain('kimibuilt-ui-check.js');
    });

    test('falls back to the configured public domain when website deployment verification omits an explicit host', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Deploy the penguin site to k3s with Traefik TLS and Let\'s Encrypt.',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
            deployDefaults: {
                publicDomain: 'demoserver2.buzz',
            },
        });

        const afterDeploy = advanceEndToEndBuilderWorkflow({
            workflow,
            toolEvents: [
                buildToolEvent('k3s-deploy', {
                    action: 'sync-and-apply',
                }, {
                    data: {
                        action: 'sync-and-apply',
                        stdout: 'deployment "backend" successfully rolled out',
                    },
                }),
            ],
        });

        const verificationPlan = buildEndToEndWorkflowPlan({
            workflow: afterDeploy,
            toolPolicy: {
                candidateToolIds: ['k3s-deploy', 'remote-command'],
                preferredRemoteToolId: 'remote-command',
            },
            remoteToolId: 'remote-command',
            deployDefaults: {
                publicDomain: 'demoserver2.buzz',
            },
        });

        expect(verificationPlan[0].params.command).toContain("expected_host='demoserver2.buzz'");
    });

    test('blocks public website deploy verification when only rollout-status access is available', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Deploy the penguin site to penguin.demoserver2.buzz on k3s with Traefik TLS and Let\'s Encrypt.',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });

        const afterDeploy = advanceEndToEndBuilderWorkflow({
            workflow,
            toolEvents: [
                buildToolEvent('k3s-deploy', {
                    action: 'sync-and-apply',
                }, {
                    data: {
                        action: 'sync-and-apply',
                        stdout: 'deployment "backend" successfully rolled out',
                    },
                }),
            ],
        });

        const evaluated = evaluateEndToEndBuilderWorkflow({
            workflow: afterDeploy,
            toolPolicy: {
                candidateToolIds: ['k3s-deploy'],
            },
            remoteToolId: 'remote-command',
        });

        expect(evaluated).toEqual(expect.objectContaining({
            stage: 'blocked',
            status: 'blocked',
            lastError: expect.stringContaining('verify ingress, TLS, and public site reachability'),
        }));
    });

    test('reuses an active stored workflow on continuation prompts', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'continue',
            session: {
                metadata: {
                    controlState: {
                        workflow: {
                            kind: END_TO_END_WORKFLOW_KIND,
                            version: 1,
                            objective: 'Fix the repo, push it, and deploy it.',
                            lane: 'repo-then-deploy',
                            stage: 'saving',
                            status: 'active',
                            workspacePath: '/workspace/app',
                            repositoryPath: '/workspace/app',
                            progress: {
                                implemented: true,
                            },
                        },
                    },
                },
            },
            workspacePath: '/workspace/app',
            repositoryPath: '/workspace/app',
        });

        expect(workflow).toEqual(expect.objectContaining({
            lane: 'repo-then-deploy',
            stage: 'saving',
            progress: expect.objectContaining({
                implemented: true,
            }),
            source: 'stored',
        }));
    });

    test('reuses an active stored workflow on structured checkpoint responses', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Survey response (rollout-date): chose "Tomorrow morning" [tomorrow-morning]. Notes: 9:00 AM Atlantic.',
            session: {
                metadata: {
                    controlState: {
                        workflow: {
                            kind: END_TO_END_WORKFLOW_KIND,
                            version: 1,
                            objective: 'Fix the repo, push it, and deploy it.',
                            lane: 'repo-then-deploy',
                            stage: 'saving',
                            status: 'active',
                            workspacePath: '/workspace/app',
                            repositoryPath: '/workspace/app',
                            progress: {
                                implemented: true,
                            },
                        },
                    },
                },
            },
            workspacePath: '/workspace/app',
            repositoryPath: '/workspace/app',
        });

        expect(workflow).toEqual(expect.objectContaining({
            lane: 'repo-then-deploy',
            stage: 'saving',
            source: 'stored',
            taskList: expect.arrayContaining([
                expect.objectContaining({
                    id: 'implement-repository',
                    status: 'completed',
                }),
                expect.objectContaining({
                    id: 'build-and-deploy-remote-workspace',
                    status: 'in_progress',
                }),
            ]),
        }));
    });

    test('does not classify discovery-first server planning prompts as implementation workflows', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'I want to build on the server, let\'s start with a couple questionnaires to figure out what we should work on. Some kind of web app we can run on our VPS server with demoserver2.buzz DNS. Can you do some research on the server and then provide those questions.',
            workspacePath: '/workspace/app',
            repositoryPath: '/workspace/app',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });

        expect(workflow).toBeNull();
    });

    test('does not classify remote CLI command-help prompts as implementation workflows', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Use remote build to give a command catalog summary.',
            workspacePath: '/workspace/app',
            repositoryPath: '/workspace/app',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });

        expect(workflow).toBeNull();
    });

    test('blocks a repo-then-deploy workflow when repository implementation is required but remote CLI is unavailable', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Fix the auth service in the repo, push it to GitHub, deploy it to k3s, and verify the rollout.',
            workspacePath: '/workspace/app',
            repositoryPath: '/workspace/app',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });

        const blockedWorkflow = evaluateEndToEndBuilderWorkflow({
            workflow,
            toolPolicy: {
                candidateToolIds: ['git-safe', 'k3s-deploy'],
                preferredRemoteToolId: 'remote-command',
            },
        });

        expect(blockedWorkflow).toEqual(expect.objectContaining({
            lane: 'repo-then-deploy',
            stage: 'blocked',
            status: 'blocked',
            lastError: expect.stringContaining('`remote-command` is not ready'),
        }));
    });

    test('does not require git-safe or k3s-deploy for a remote workspace deploy flow', () => {
        const workflow = inferEndToEndBuilderWorkflow({
            objective: 'Fix the app in the remote repo, deploy it to k3s on the same server, and verify the rollout.',
            workspacePath: '/var/www/test.demoserver2.buzz',
            repositoryPath: '/workspace/local-clone',
            remoteTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
        });

        const afterImplementation = advanceEndToEndBuilderWorkflow({
            workflow,
            toolEvents: [
                buildToolEvent('remote-command', { workflowAction: 'implement-remote-workspace' }, {
                    data: {
                        workspacePath: '/var/www/test.demoserver2.buzz',
                    },
                }),
            ],
        });

        const evaluated = evaluateEndToEndBuilderWorkflow({
            workflow: afterImplementation,
            toolPolicy: {
                candidateToolIds: ['remote-command'],
                preferredRemoteToolId: 'remote-command',
            },
        });

        expect(evaluated).toEqual(expect.objectContaining({
            stage: 'saving',
            status: 'active',
            lastError: null,
        }));
    });
});
