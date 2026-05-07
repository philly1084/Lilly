'use strict';

const {
    extractBrutalBuilderPlan,
    hasWorkloadIntent,
    inferWorkloadPolicy,
    parseWorkloadScenario,
    translateCronExpression,
} = require('./natural-language');

describe('workload natural language parsing', () => {
    test('parses a daily scenario into a cron workload', () => {
        const result = parseWorkloadScenario(
            'Every day at 11:05 PM summarize blockers from this conversation.',
            {
                timezone: 'America/Halifax',
                now: new Date('2026-04-01T10:00:00.000Z'),
            },
        );

        expect(result).toMatchObject({
            title: 'Summarize Blockers From This Conversation',
            prompt: 'summarize blockers from this conversation.',
            trigger: {
                type: 'cron',
                expression: '5 23 * * *',
                timezone: 'America/Halifax',
            },
            scheduleDetected: true,
        });
    });

    test('accepts everyday phrasing for daily workloads', () => {
        const result = parseWorkloadScenario('Everyday 11:05pm summarize blockers.', {
            timezone: 'America/Halifax',
            now: new Date('2026-04-01T10:00:00.000Z'),
        });

        expect(result.trigger).toEqual({
            type: 'cron',
            expression: '5 23 * * *',
            timezone: 'America/Halifax',
        });
    });

    test('parses a one-time scenario for tomorrow morning', () => {
        const result = parseWorkloadScenario(
            'Tomorrow at 9 AM review the latest repo activity and summarize blockers.',
            {
                timezone: 'UTC',
                now: new Date('2026-04-01T12:00:00.000Z'),
            },
        );

        expect(result.trigger.type).toBe('once');
        expect(result.trigger.runAt).toBe('2026-04-02T09:00:00.000Z');
        expect(result.prompt).toBe('review the latest repo activity and summarize blockers.');
    });

    test('parses a relative one-time scenario in five minutes', () => {
        const result = parseWorkloadScenario(
            'In 5 minutes run `date` on the server.',
            {
                timezone: 'UTC',
                now: new Date('2026-04-01T12:00:00.000Z'),
            },
        );

        expect(result.trigger.type).toBe('once');
        expect(result.trigger.runAt).toBe('2026-04-01T12:05:00.000Z');
        expect(result.prompt).toBe('run `date` on the server.');
    });

    test('does not round vague later or now-not-later requests into deferred workloads', () => {
        const options = {
            timezone: 'UTC',
            now: new Date('2026-04-01T12:31:00.000Z'),
        };

        expect(parseWorkloadScenario('Run the command later.', options).trigger)
            .toEqual({ type: 'manual' });
        expect(parseWorkloadScenario('Ask an agent to do it now, not later.', options).trigger)
            .toEqual({ type: 'manual' });
        expect(hasWorkloadIntent('Run the command later.')).toBe(false);
        expect(hasWorkloadIntent('Ask an agent to do it now, not later.')).toBe(false);
    });

    test('still treats explicit clock times as one-time workloads', () => {
        const result = parseWorkloadScenario(
            'Run `date` on the server at 8 PM.',
            {
                timezone: 'UTC',
                now: new Date('2026-04-01T12:31:00.000Z'),
            },
        );

        expect(result.trigger).toEqual({
            type: 'once',
            runAt: '2026-04-01T20:00:00.000Z',
        });
    });

    test('parses spelled relative delays and treats them as workload intent', () => {
        const result = parseWorkloadScenario(
            'Run `date` on the server in five minutes from now.',
            {
                timezone: 'UTC',
                now: new Date('2026-04-01T12:00:00.000Z'),
            },
        );

        expect(result.trigger.type).toBe('once');
        expect(result.trigger.runAt).toBe('2026-04-01T12:05:00.000Z');
        expect(hasWorkloadIntent('Run `date` on the server in five minutes from now.')).toBe(true);
    });

    test('does not treat today content references as scheduled workloads', () => {
        const result = parseWorkloadScenario(
            'Make me a PDF of today\'s news.',
            {
                timezone: 'UTC',
                now: new Date('2026-04-01T12:00:00.000Z'),
            },
        );

        expect(result.trigger).toEqual({ type: 'manual' });
        expect(result.prompt).toBe('Make me a PDF of today\'s news.');
    });

    test('does not treat news for today as a deferred workload', () => {
        const options = {
            timezone: 'UTC',
            now: new Date('2026-05-03T12:00:00.000Z'),
        };

        const result = parseWorkloadScenario('Make the news for today.', options);

        expect(result.trigger).toEqual({ type: 'manual' });
        expect(result.prompt).toBe('Make the news for today.');
        expect(hasWorkloadIntent('Make the news for today.')).toBe(false);
    });

    test('does not treat standalone tomorrow phrasing as workload intent', () => {
        expect(hasWorkloadIntent('Tomorrow works for me.')).toBe(false);
        expect(hasWorkloadIntent('We can talk about it tomorrow.')).toBe(false);
    });

    test('still treats today as a schedule when attached to an executable task', () => {
        const result = parseWorkloadScenario('Run `date` on the server today at 8 PM.', {
            timezone: 'UTC',
            now: new Date('2026-05-03T12:00:00.000Z'),
        });

        expect(result.trigger).toEqual({
            type: 'once',
            runAt: '2026-05-03T20:00:00.000Z',
        });
        expect(result.prompt).toBe('Run `date` on the server.');
    });

    test('strips scheduling wrapper language from deferred workload prompts', () => {
        const result = parseWorkloadScenario(
            'Can you run a cron later every day at 8 PM to remote into the server and get a health report',
            {
                timezone: 'America/Halifax',
                now: new Date('2026-04-03T10:00:00.000Z'),
            },
        );

        expect(result.trigger).toEqual({
            type: 'cron',
            expression: '0 20 * * *',
            timezone: 'America/Halifax',
        });
        expect(result.prompt).toBe('remote into the server and get a health report');
    });

    test('detects explicit workload setup requests', () => {
        expect(hasWorkloadIntent('Set up a daily agent workload to summarize blockers every day at 11:05 PM.')).toBe(true);
        expect(hasWorkloadIntent('Set this up every day at 11:05 PM to summarize blockers.')).toBe(true);
        expect(hasWorkloadIntent('Run `date` on the server in 5 minutes.')).toBe(true);
        expect(hasWorkloadIntent('Set up cron jobs for security updates and security checks.')).toBe(true);
        expect(hasWorkloadIntent('Explain what a cron expression is.')).toBe(false);
        expect(hasWorkloadIntent('I keep getting cron calls too quickly and every message turns into a workload.')).toBe(false);
        expect(hasWorkloadIntent('I want a planning agent to decide when something should become a job.')).toBe(false);
    });

    test('infers a conservative recurring trigger from plural cron jobs', () => {
        const result = parseWorkloadScenario('Set up cron jobs for security updates and security checks.', {
            timezone: 'UTC',
            now: new Date('2026-04-01T12:00:00.000Z'),
        });

        expect(result.trigger).toEqual({
            type: 'cron',
            expression: '0 2 * * 1',
            timezone: 'UTC',
        });
        expect(result.prompt).toBe('security updates and security checks.');
    });

    test('infers remote-build policy for environment-building work', () => {
        const policy = inferWorkloadPolicy('Build out the server environment on the cluster and repair the deployment.');

        expect(policy).toMatchObject({
            executionProfile: 'remote-build',
            allowSideEffects: true,
        });
    });

    test('infers remote-build policy for remote app creation language', () => {
        const policy = inferWorkloadPolicy('Use the remote server, Gitea, and this web app environment as the sandbox to create and ship the app.');

        expect(policy).toMatchObject({
            executionProfile: 'remote-build',
            allowSideEffects: true,
        });
    });

    test('translates simple cron expressions into readable labels', () => {
        expect(translateCronExpression('5 23 * * *', 'America/Halifax')).toBe('Every day at 11:05 PM');
        expect(translateCronExpression('0 9 * * 1-5', 'America/Halifax')).toBe('Every weekday at 9:00 AM');
    });

    test('detects a brutal builder quick-pass plan and schedules it immediately', () => {
        const now = new Date('2026-04-01T12:00:00.000Z');
        const plan = extractBrutalBuilderPlan('Use brutal builder to make a PDF product spec for this feature and take a couple passes quickly.');
        const scenario = parseWorkloadScenario(
            'Use brutal builder to make a PDF product spec for this feature and take a couple passes quickly.',
            {
                timezone: 'UTC',
                now,
            },
        );

        expect(plan).toEqual(expect.objectContaining({
            totalRuns: 4,
            intervalMs: 10 * 60 * 1000,
            requestedStyle: 'quick',
        }));
        expect(scenario.prompt).toBe('make a PDF product spec for this feature.');
        expect(scenario.trigger).toEqual({
            type: 'once',
            runAt: '2026-04-01T12:00:00.000Z',
        });
        expect(hasWorkloadIntent('Use brutal builder to make a PDF product spec for this feature and take a couple passes quickly.')).toBe(true);
    });

    test('detects a brutal builder time-boxed plan from count and duration language', () => {
        const plan = extractBrutalBuilderPlan('Use brutal builder to draft a design brief, take 4 hours and do it 8 times in that 4 hours.');

        expect(plan).toEqual(expect.objectContaining({
            totalRuns: 8,
            intervalMs: 30 * 60 * 1000,
            windowMs: 4 * 60 * 60 * 1000,
        }));
    });

    test('does not treat brutal builder feature discussion as an executable workload request', () => {
        expect(extractBrutalBuilderPlan('I want a feature called brutal builder that can be asked for to make a document and take a couple passes quickly.')).toBeNull();
    });
});
