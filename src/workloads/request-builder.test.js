'use strict';

const {
    buildCanonicalWorkloadAction,
    buildCanonicalWorkloadPayload,
} = require('./request-builder');

describe('workload request builder', () => {
    test('builds a structured scheduled remote workload from a natural-language request', () => {
        const canonical = buildCanonicalWorkloadAction({
            request: 'Run `date` on the server in 5 minutes.',
        }, {
            now: '2026-04-02T09:00:00.000Z',
            timezone: 'UTC',
            session: {
                metadata: {
                    lastSshTarget: {
                        host: '10.0.0.5',
                        username: 'ubuntu',
                        port: 22,
                    },
                },
            },
        });

        expect(canonical).toEqual(expect.objectContaining({
            action: 'create',
            title: 'Run Date On The Server',
            prompt: 'Run `date` on the server.',
            trigger: {
                type: 'once',
                runAt: '2026-04-02T09:05:00.000Z',
            },
            execution: {
                tool: 'remote-command',
                params: {
                    host: '10.0.0.5',
                    username: 'ubuntu',
                    port: 22,
                    command: 'date',
                },
            },
        }));
    });

    test('reconstructs malformed workload params into a canonical scheduled payload', () => {
        const canonical = buildCanonicalWorkloadPayload({
            title: 'Check remote time',
            command: 'date',
            schedule: 'in 5 minutes',
            tool: 'remote-command',
        }, {
            now: '2026-04-02T09:00:00.000Z',
            timezone: 'UTC',
            session: {
                metadata: {
                    lastSshTarget: {
                        host: '10.0.0.5',
                        username: 'ubuntu',
                        port: 22,
                    },
                },
            },
        });

        expect(canonical).toEqual(expect.objectContaining({
            scenarioSource: 'Run `date` on the server in 5 minutes',
            payload: expect.objectContaining({
                title: 'Check remote time',
                trigger: {
                    type: 'once',
                    runAt: '2026-04-02T09:05:00.000Z',
                },
                execution: {
                    tool: 'remote-command',
                    params: {
                        host: '10.0.0.5',
                        username: 'ubuntu',
                        port: 22,
                        command: 'date',
                    },
                },
            }),
        }));
    });

    test('reconstructs a schedule-only follow-up using recent user messages', () => {
        const canonical = buildCanonicalWorkloadAction({
            request: 'run it five minutes from now',
        }, {
            now: '2026-04-02T09:00:00.000Z',
            timezone: 'UTC',
            recentMessages: [
                { role: 'user', content: 'gather information on the k3s cluster on the server' },
            ],
        });

        expect(canonical).toEqual(expect.objectContaining({
            action: 'create',
            title: 'Gather Information On The K3s',
            prompt: expect.stringContaining('gather information on the k3s cluster on the server'),
            trigger: {
                type: 'once',
                runAt: '2026-04-02T09:05:00.000Z',
            },
            metadata: expect.objectContaining({
                createdFromScenario: true,
                scenarioRequest: expect.stringContaining('gather information on the k3s cluster on the server'),
                creationContext: expect.objectContaining({
                    originalRequest: 'run it five minutes from now',
                    resolvedRequest: expect.stringContaining('gather information on the k3s cluster on the server'),
                    recentMessages: [
                        {
                            role: 'user',
                            content: 'gather information on the k3s cluster on the server',
                        },
                    ],
                }),
            }),
        }));
    });

    test('does not keep prior schedule context sticky for a new task-only turn', () => {
        const canonical = buildCanonicalWorkloadAction({
            request: 'gather information on the k3s cluster on the server',
        }, {
            now: '2026-04-02T09:00:00.000Z',
            timezone: 'UTC',
            recentMessages: [
                { role: 'user', content: 'run it five minutes from now' },
            ],
        });

        expect(canonical).toBeNull();
    });

    test('filters unrelated recent messages from new workload creation context', () => {
        const canonical = buildCanonicalWorkloadAction({
            request: 'Set up an hourly workload to make a Halifax weather app with full week and hourly reports.',
        }, {
            now: '2026-04-02T09:00:00.000Z',
            timezone: 'UTC',
            recentMessages: [
                { role: 'user', content: 'Just try again to fix the Tetris deployment to awesome.demoserver2.buzz' },
                { role: 'assistant', content: 'The Tetris host is still serving the wrong app.' },
                { role: 'user', content: 'Show me todays weather in Halifax NS and include the hourly report.' },
            ],
        });

        expect(canonical).toEqual(expect.objectContaining({
            action: 'create',
            metadata: expect.objectContaining({
                creationContext: expect.objectContaining({
                    recentMessages: [
                        {
                            role: 'user',
                            content: 'Show me todays weather in Halifax NS and include the hourly report.',
                        },
                    ],
                }),
            }),
        }));
        expect(JSON.stringify(canonical.metadata.creationContext)).not.toContain('Tetris');
        expect(JSON.stringify(canonical.metadata.creationContext)).not.toContain('awesome.demoserver2.buzz');
    });

    test('does not turn vague later or explicit now requests into deferred workloads', () => {
        expect(buildCanonicalWorkloadAction({
            request: 'Run the command later.',
        }, {
            now: '2026-04-02T09:31:00.000Z',
            timezone: 'UTC',
        })).toBeNull();

        expect(buildCanonicalWorkloadAction({
            request: 'Ask an agent to do it now, not later.',
        }, {
            now: '2026-04-02T09:31:00.000Z',
            timezone: 'UTC',
        })).toBeNull();
    });

    test('does not create a canonical workload from tomorrow as a standalone timing word', () => {
        expect(buildCanonicalWorkloadAction({
            request: 'Tomorrow sounds good.',
        }, {
            now: '2026-04-02T09:31:00.000Z',
            timezone: 'UTC',
        })).toBeNull();
    });

    test('does not treat abstract workload discussion as a canonical scheduled workload', () => {
        const canonical = buildCanonicalWorkloadAction({
            request: 'I keep getting cron calls too quickly and every message turns into a workload. I want a planning agent to decide when something should become a job.',
        }, {
            timezone: 'UTC',
        });

        expect(canonical).toBeNull();
    });

    test('splits scheduled research-to-pdf requests into content and export stages', () => {
        const canonical = buildCanonicalWorkloadAction({
            request: 'In 5 minutes can you do some research on ADHD and make a PDF document on it I can review, make it designed to questions on diagnosis and why its ADHD traits.',
        }, {
            now: '2026-04-02T09:00:00.000Z',
            timezone: 'UTC',
        });

        expect(canonical).toEqual(expect.objectContaining({
            action: 'create',
            trigger: {
                type: 'once',
                runAt: '2026-04-02T09:05:00.000Z',
            },
            metadata: expect.objectContaining({
                requestedOutputFormat: 'pdf',
            }),
            stages: [expect.objectContaining({
                when: 'on_success',
                outputFormat: 'pdf',
            })],
        }));
        expect(canonical.prompt).toContain('This scheduled run is split into content generation followed by PDF export.');
        expect(canonical.prompt).toContain('produce only the final document/report content');
        expect(canonical.prompt).toContain('do some research on ADHD and write the document on it I can review');
    });

    test('infers a conservative default schedule for security update cron requests without explicit timing', () => {
        const canonical = buildCanonicalWorkloadAction({
            request: 'Set up a cron job to reach out to the server and do security updates.',
        }, {
            timezone: 'America/Halifax',
        });

        expect(canonical).toEqual(expect.objectContaining({
            action: 'create',
            trigger: {
                type: 'cron',
                expression: '0 2 * * 1',
                timezone: 'America/Halifax',
            },
        }));
    });

    test('infers a conservative default schedule for security check cron requests without explicit timing', () => {
        const canonical = buildCanonicalWorkloadAction({
            request: 'Set up a cron job to reach out to the server and do security checks.',
        }, {
            timezone: 'America/Halifax',
        });

        expect(canonical).toEqual(expect.objectContaining({
            action: 'create',
            trigger: {
                type: 'cron',
                expression: '0 9 * * *',
                timezone: 'America/Halifax',
            },
        }));
    });

    test('builds a brutal builder workload with chained improvement passes', () => {
        const canonical = buildCanonicalWorkloadAction({
            request: 'Use brutal builder to make a PDF product spec for the new onboarding flow and take a couple passes quickly.',
        }, {
            now: '2026-04-02T09:00:00.000Z',
            timezone: 'UTC',
        });

        expect(canonical).toEqual(expect.objectContaining({
            action: 'create',
            trigger: {
                type: 'once',
                runAt: '2026-04-02T09:00:00.000Z',
            },
            metadata: expect.objectContaining({
                brutalBuilderEnabled: true,
                defaultOutputFormat: 'pdf',
                brutalBuilder: expect.objectContaining({
                    totalRuns: 4,
                    intervalMs: 10 * 60 * 1000,
                }),
            }),
        }));
        expect(canonical.prompt).toContain('This is pass 1 of 4.');
        expect(canonical.stages).toHaveLength(3);
        expect(canonical.stages[0]).toEqual(expect.objectContaining({
            when: 'on_success',
            delayMs: 10 * 60 * 1000,
            outputFormat: 'pdf',
        }));
        expect(canonical.stages[0].prompt).toContain('This is pass 2 of 4.');
    });

    test('builds a brutal builder workload from duration and count language', () => {
        const canonical = buildCanonicalWorkloadAction({
            request: 'Use brutal builder to draft a design brief, take 4 hours and do it 8 times in that 4 hours.',
        }, {
            now: '2026-04-02T09:00:00.000Z',
            timezone: 'UTC',
        });

        expect(canonical).toEqual(expect.objectContaining({
            action: 'create',
            trigger: {
                type: 'once',
                runAt: '2026-04-02T09:00:00.000Z',
            },
            metadata: expect.objectContaining({
                brutalBuilderEnabled: true,
                brutalBuilder: expect.objectContaining({
                    totalRuns: 8,
                    intervalMs: 30 * 60 * 1000,
                }),
            }),
        }));
        expect(canonical.stages).toHaveLength(7);
    });

    test('maps brutal builder docx requests to html output', () => {
        const canonical = buildCanonicalWorkloadAction({
            request: 'Use brutal builder to make a DOCX executive brief for the launch plan and take a couple passes quickly.',
        }, {
            now: '2026-04-02T09:00:00.000Z',
            timezone: 'UTC',
        });

        expect(canonical).toEqual(expect.objectContaining({
            action: 'create',
            metadata: expect.objectContaining({
                brutalBuilderEnabled: true,
                requestedOutputFormat: 'html',
                resolvedOutputFormat: 'html',
                defaultOutputFormat: 'html',
            }),
        }));
        expect(canonical.stages[0]).toEqual(expect.objectContaining({
            outputFormat: 'html',
        }));
    });
});
