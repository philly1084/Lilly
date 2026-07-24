'use strict';

const {
    ACTIVE_PROJECT_PLAN_STATUS,
    COMPLETED_PROJECT_PLAN_STATUS,
    FOREGROUND_PROJECT_PLAN_KIND,
    advanceForegroundProjectPlan,
    inferForegroundProjectPlan,
    normalizeForegroundProjectPlan,
    shouldResumeRemoteCliProject,
} = require('./foreground-project-plan');

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

describe('foreground project plan', () => {
    test('creates an active foreground project plan for substantial project work', () => {
        const plan = inferForegroundProjectPlan({
            objective: 'Refactor the web chat UI, validate the result, and polish the final interaction flow.',
        });

        expect(plan).toEqual(expect.objectContaining({
            kind: FOREGROUND_PROJECT_PLAN_KIND,
            status: ACTIVE_PROJECT_PLAN_STATUS,
            objective: 'Refactor the web chat UI, validate the result, and polish the final interaction flow.',
            milestones: expect.arrayContaining([
                expect.objectContaining({
                    title: 'Implement the requested changes',
                    status: 'in_progress',
                }),
                expect.objectContaining({
                    title: 'Validate and review the result',
                    status: 'planned',
                }),
            ]),
        }));
    });

    test('creates a multi-session concept to remote build lifecycle plan', () => {
        const plan = inferForegroundProjectPlan({
            objective: 'I want natural software development where we start with an idea, sandbox it local, deploy it with the remote CLI agent, update the page, use git, and continue repo work over many sessions.',
        });

        expect(plan).toEqual(expect.objectContaining({
            kind: FOREGROUND_PROJECT_PLAN_KIND,
            status: ACTIVE_PROJECT_PLAN_STATUS,
            milestones: [
                expect.objectContaining({
                    id: 'shape-build-idea',
                    title: 'Shape the idea or goal into a compact build brief',
                    status: 'in_progress',
                }),
                expect.objectContaining({
                    id: 'sandbox-local-prototype',
                    title: 'Build and review a local sandbox prototype',
                    status: 'planned',
                }),
                expect.objectContaining({
                    id: 'promote-remote-cli',
                    title: 'Promote the local prototype to a remote build candidate',
                    status: 'planned',
                }),
                expect.objectContaining({
                    id: 'deploy-and-verify',
                    title: 'Deploy live and verify the remote result',
                    status: 'planned',
                }),
                expect.objectContaining({
                    id: 'save-git-and-continue-repo',
                    title: 'Save Git state and continue repo work',
                    status: 'planned',
                }),
            ],
        }));
    });

    test('creates the lifecycle plan for local builds, remote builds, and local-to-live promotion wording', () => {
        const plan = inferForegroundProjectPlan({
            objective: 'Supercharge sandbox designs for webpages with React and Three.js so we have local builds, remote builds, and the ability to move local to live.',
        });

        expect(plan).toEqual(expect.objectContaining({
            kind: FOREGROUND_PROJECT_PLAN_KIND,
            status: ACTIVE_PROJECT_PLAN_STATUS,
            milestones: expect.arrayContaining([
                expect.objectContaining({
                    id: 'sandbox-local-prototype',
                    title: 'Build and review a local sandbox prototype',
                }),
                expect.objectContaining({
                    id: 'promote-remote-cli',
                    title: 'Promote the local prototype to a remote build candidate',
                }),
                expect.objectContaining({
                    id: 'deploy-and-verify',
                    title: 'Deploy live and verify the remote result',
                }),
            ]),
        }));
    });

    test('reuses and updates a stored foreground plan on skip instructions', () => {
        const stored = normalizeForegroundProjectPlan({
            kind: FOREGROUND_PROJECT_PLAN_KIND,
            status: 'active',
            source: 'objective',
            title: 'Ship the new landing page',
            objective: 'Build and deploy the new landing page.',
            governance: {
                lockedPlan: false,
                modificationPolicy: 'flexible',
            },
            milestones: [{
                id: 'implement',
                title: 'Implement the requested changes',
                status: 'completed',
            }, {
                id: 'deploy',
                title: 'Deploy or publish the result',
                status: 'in_progress',
            }, {
                id: 'validate',
                title: 'Validate and review the result',
                status: 'planned',
            }],
        });

        const plan = inferForegroundProjectPlan({
            objective: 'Skip deployment and just validate it locally.',
            session: {
                metadata: {
                    controlState: {
                        projectPlan: stored,
                    },
                },
            },
        });

        expect(plan).toEqual(expect.objectContaining({
            status: ACTIVE_PROJECT_PLAN_STATUS,
            source: 'interaction',
            milestones: expect.arrayContaining([
                expect.objectContaining({
                    id: 'deploy',
                    status: 'skipped',
                }),
                expect.objectContaining({
                    id: 'validate',
                    status: 'planned',
                }),
            ]),
            changeLog: expect.arrayContaining([
                expect.objectContaining({
                    type: 'operator_override',
                }),
            ]),
        }));
    });

    test('resumes remote CLI work only when the follow-up matches the stored project context', () => {
        const storedPlan = normalizeForegroundProjectPlan({
            kind: FOREGROUND_PROJECT_PLAN_KIND,
            status: 'active',
            title: 'Project dashboard',
            objective: 'Build and deploy the project dashboard.',
            milestones: [{
                id: 'deliver-requested-work',
                title: 'Implement the dashboard changes',
                status: 'in_progress',
            }],
        });
        const priorAgentState = {
            lastTask: 'Build and deploy the project dashboard.',
            cwd: '/srv/apps/project-dashboard',
        };

        expect(shouldResumeRemoteCliProject(
            'Make the cards tighter and change the accent color to blue.',
            { storedPlan, priorAgentState },
        )).toBe(true);
        expect(shouldResumeRemoteCliProject(
            'Continue the dashboard work and verify it live.',
            { storedPlan, priorAgentState },
        )).toBe(true);
        expect(shouldResumeRemoteCliProject(
            'Write better copy for the dashboard cards.',
            { storedPlan, priorAgentState },
        )).toBe(true);
        expect(shouldResumeRemoteCliProject(
            'Explain how photosynthesis works.',
            { storedPlan, priorAgentState },
        )).toBe(false);
        expect(shouldResumeRemoteCliProject(
            'Write a poem about the ocean.',
            { storedPlan, priorAgentState },
        )).toBe(false);
        expect(shouldResumeRemoteCliProject(
            'Make me a page about dolphins.',
            { storedPlan, priorAgentState },
        )).toBe(false);
        expect(shouldResumeRemoteCliProject(
            'Fix the parser tests in the local API repository.',
            { storedPlan, priorAgentState },
        )).toBe(false);
        expect(shouldResumeRemoteCliProject(
            'Start a new project about writing a local poem instead.',
            { storedPlan, priorAgentState },
        )).toBe(false);
    });

    test('advances a foreground project plan after successful tool work', () => {
        const plan = normalizeForegroundProjectPlan({
            kind: FOREGROUND_PROJECT_PLAN_KIND,
            status: 'active',
            source: 'objective',
            title: 'Polish the chat',
            objective: 'Polish the chat.',
            governance: {
                lockedPlan: false,
                modificationPolicy: 'flexible',
            },
            milestones: [{
                id: 'inspect',
                title: 'Inspect the current state',
                status: 'in_progress',
            }, {
                id: 'implement',
                title: 'Implement the requested changes',
                status: 'planned',
            }, {
                id: 'validate',
                title: 'Validate and review the result',
                status: 'planned',
            }],
        });

        const advanced = advanceForegroundProjectPlan({
            projectPlan: plan,
            toolEvents: [
                buildToolEvent('file-read'),
            ],
        });

        expect(advanced).toEqual(expect.objectContaining({
            status: ACTIVE_PROJECT_PLAN_STATUS,
            milestones: expect.arrayContaining([
                expect.objectContaining({
                    id: 'inspect',
                    status: 'completed',
                }),
                expect.objectContaining({
                    id: 'implement',
                    status: 'in_progress',
                }),
            ]),
            reviewHistory: expect.arrayContaining([
                expect.objectContaining({
                    status: 'completed',
                }),
            ]),
        }));
    });

    test('syncs the foreground project plan from an active workflow task list', () => {
        const plan = inferForegroundProjectPlan({
            objective: 'continue',
            workflow: {
                objective: 'Fix the repo, push it, and deploy it.',
                status: 'active',
                taskList: [{
                    id: 'implement-repository',
                    title: 'Implement repository changes',
                    status: 'completed',
                }, {
                    id: 'save-and-push-repository',
                    title: 'Inspect, save, and push repository changes',
                    status: 'in_progress',
                }, {
                    id: 'deploy-release',
                    title: 'Deploy requested release',
                    status: 'planned',
                }],
            },
        });

        expect(plan).toEqual(expect.objectContaining({
            kind: FOREGROUND_PROJECT_PLAN_KIND,
            status: ACTIVE_PROJECT_PLAN_STATUS,
            source: 'workflow',
            milestones: expect.arrayContaining([
                expect.objectContaining({
                    id: 'implement-repository',
                    status: 'completed',
                }),
                expect.objectContaining({
                    id: 'save-and-push-repository',
                    status: 'in_progress',
                }),
            ]),
        }));
    });

    test('marks the foreground plan completed when all milestones are complete or skipped', () => {
        const plan = normalizeForegroundProjectPlan({
            kind: FOREGROUND_PROJECT_PLAN_KIND,
            title: 'Done plan',
            objective: 'Done plan',
            milestones: [{
                id: 'one',
                title: 'One',
                status: 'completed',
            }, {
                id: 'two',
                title: 'Two',
                status: 'skipped',
            }],
        });

        expect(plan.status).toBe(COMPLETED_PROJECT_PLAN_STATUS);
    });
});
