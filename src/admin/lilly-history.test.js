const {
  buildPullRequestUrl,
  normalizeGitHubRepositoryUrl,
  parseGitLog,
  parseMergePullRequestSubject,
  summarizeCommits,
} = require('./lilly-history');

describe('lilly-history', () => {
  test('parses git log lines into categorized Lilly pulls', () => {
    const commits = parseGitLog([
      'aaa1111\t2026-03-05\tAdd Web CLI interface',
      'bbb2222\t2026-03-14\tFix admin dashboard API errors',
      'ccc3333\t2026-05-02\tDeploy Kokoro TTS service with backend',
      'ddd4444\t2026-05-19\tHarden PII relationship calculator inputs',
    ].join('\n'));

    expect(commits).toHaveLength(4);
    expect(commits[0]).toMatchObject({
      shortHash: 'aaa1111',
      phase: 'ignition',
      primaryTag: 'growth',
    });
    expect(commits[1].tags).toContain('repair');
    expect(commits[2].tags).toContain('ops');
    expect(commits[2].tags).toContain('media');
    expect(commits[3]).toMatchObject({
      phase: 'privacy-trust',
      primaryTag: 'privacy',
    });
  });

  test('summarizes phases, categories, and all tile dots', () => {
    const commits = parseGitLog([
      'aaa1111\t2026-03-05\tAdd Web CLI interface',
      'bbb2222\t2026-03-14\tFix admin dashboard API errors',
      'ccc3333\t2026-05-02\tMerge pull request #12 from philly1084/codex/example',
    ].join('\n'));

    const summary = summarizeCommits(commits, {
      repositoryUrl: 'https://github.com/philly1084/KimiBuilt.git',
    });

    expect(summary.totalPulls).toBe(3);
    expect(summary.mergedPullRequests).toBe(1);
    expect(summary.recentPullRequests).toEqual([
      expect.objectContaining({
        number: 12,
        source: 'philly1084/codex/example',
        url: 'https://github.com/philly1084/KimiBuilt/pull/12',
      }),
    ]);
    expect(summary.recent[0].pullRequest).toMatchObject({
      number: 12,
      url: 'https://github.com/philly1084/KimiBuilt/pull/12',
    });
    expect(summary.primaryCategories.reduce((sum, category) => sum + category.count, 0)).toBe(3);
    expect(summary.recentVelocity).toMatchObject({
      latestDate: '2026-05-02',
      last7Days: 1,
      last14Days: 1,
      last30Days: 1,
    });
    expect(summary.phases[0]).toMatchObject({
      percent: 33,
      repairCount: 0,
      growthCount: 1,
    });
    expect(summary.tiles).toHaveLength(3);
    expect(summary.phases.map((phase) => phase.id)).toEqual([
      'ignition',
      'notes-admin',
      'live-learning',
    ]);
  });

  test('extracts and links GitHub pull request merge subjects', () => {
    expect(parseMergePullRequestSubject('Merge pull request #427 from philly1084/codex/wiki-prs')).toEqual({
      number: 427,
      source: 'philly1084/codex/wiki-prs',
    });
    expect(parseMergePullRequestSubject('Fix admin dashboard')).toBeNull();
    expect(normalizeGitHubRepositoryUrl('git@github.com:philly1084/KimiBuilt.git')).toBe('https://github.com/philly1084/KimiBuilt');
    expect(normalizeGitHubRepositoryUrl('https://github.com/philly1084/KimiBuilt.git')).toBe('https://github.com/philly1084/KimiBuilt');
    expect(buildPullRequestUrl('git@github.com:philly1084/KimiBuilt.git', 427)).toBe('https://github.com/philly1084/KimiBuilt/pull/427');
  });
});
