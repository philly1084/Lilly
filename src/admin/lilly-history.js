const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const PHASES = [
  {
    id: 'ignition',
    label: 'Ignition',
    from: '2026-03-04',
    to: '2026-03-11',
    summary: 'The first backend, frontends, Rancher/k3s path, Docker publishing, and document generation pieces came online.',
  },
  {
    id: 'notes-admin',
    label: 'Notes + Admin Spine',
    from: '2026-03-12',
    to: '2026-03-18',
    summary: 'Notes became a real working surface while admin, auth, chat continuity, PDFs, and crash recovery kept getting repaired.',
  },
  {
    id: 'runtime',
    label: 'Agent Runtime',
    from: '2026-03-19',
    to: '2026-03-25',
    summary: 'Tool calls, memory, artifacts, remote command routing, and conversation orchestration turned Lilly into an agent platform.',
  },
  {
    id: 'remote-builds',
    label: 'Remote Builds',
    from: '2026-03-26',
    to: '2026-04-18',
    summary: 'The system learned to build, deploy, repair, and continue work across local, remote, and generated artifact paths.',
  },
  {
    id: 'polish-pipeline',
    label: 'Polish Pipeline',
    from: '2026-04-19',
    to: '2026-04-25',
    summary: 'Session polish, document workflows, voxel/web UI improvements, remote runners, and artifact handling tightened into a bigger loop.',
  },
  {
    id: 'media-symphony',
    label: 'Media + Symphony',
    from: '2026-04-26',
    to: '2026-05-01',
    summary: 'Podcast, video, image gateways, Symphony orchestration, GitLab, and diagnostics became major growth branches.',
  },
  {
    id: 'live-learning',
    label: 'Live Learning',
    from: '2026-05-02',
    to: '2026-05-13',
    summary: 'Kokoro, k3s proof loops, skills, frontend standards, and prompt state machines made the platform more durable and self-aware.',
  },
  {
    id: 'privacy-trust',
    label: 'Privacy + Trust Layer',
    from: '2026-05-14',
    to: '2099-12-31',
    summary: 'PII vault routing, trusted workbook calculations, admin-preview hardening, self-reflection approvals, and safer note cleanup became the newest platform layer.',
  },
];

const CATEGORY_RULES = [
  { id: 'privacy', label: 'Privacy + Trust', pattern: /\b(privacy|pii|vault|mask|masked|redact|redaction|identity|private|trusted|audit|approval|permission)\b/i },
  { id: 'repair', label: 'Repair', pattern: /\b(fix|harden|restore|stabilize|recover|crash|fallback|retry|prevent|patch)\b/i },
  { id: 'growth', label: 'Growth', pattern: /\b(add|implement|enable|support|introduce|create|expand|include)\b/i },
  { id: 'interface', label: 'Interface', pattern: /\b(ui|frontend|web chat|web-chat|notes|canvas|dashboard|visual|theme|voxel|cli)\b/i },
  { id: 'ops', label: 'Ops', pattern: /\b(k3s|docker|rancher|gitlab|runner|deploy|ingress|secret|pvc|remote|kube|ghcr)\b/i },
  { id: 'media', label: 'Media + Docs', pattern: /\b(podcast|audio|tts|image|video|pdf|pptx|document|docx|template)\b/i },
  { id: 'intelligence', label: 'Intelligence', pattern: /\b(memory|orchestration|agent|model|tool|planner|symphony|prompt|skills?)\b/i },
];

function getPhaseForDate(date) {
  return PHASES.find((phase) => date >= phase.from && date <= phase.to) || PHASES[0];
}

function getTags(subject = '') {
  const tags = CATEGORY_RULES
    .filter((rule) => rule.pattern.test(subject))
    .map((rule) => rule.id);

  return tags.length ? tags : ['maintenance'];
}

function parseMergePullRequestSubject(subject = '') {
  const match = String(subject || '').trim().match(/^Merge pull request #(\d+)(?:\s+from\s+(.+))?/i);
  if (!match) {
    return null;
  }

  return {
    number: Number(match[1]),
    source: String(match[2] || '').trim() || null,
  };
}

function normalizeGitHubRepositoryUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  const httpsMatch = raw.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/)?$/i);
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  const sshMatch = raw.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/)?$/i);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
  }

  return null;
}

function buildPullRequestUrl(repositoryUrl, number) {
  const repo = normalizeGitHubRepositoryUrl(repositoryUrl);
  const prNumber = Number(number || 0);
  return repo && prNumber ? `${repo}/pull/${prNumber}` : null;
}

function parseGitLog(stdout = '') {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, date, ...subjectParts] = line.split('\t');
      const subject = subjectParts.join('\t').trim();
      const phase = getPhaseForDate(date);
      const tags = getTags(subject);

      return {
        hash,
        shortHash: String(hash || '').slice(0, 7),
        date,
        subject,
        pullRequest: parseMergePullRequestSubject(subject),
        phase: phase.id,
        tags,
        primaryTag: tags[0],
      };
    });
}

function countSince(commits, latestDate, days) {
  if (!latestDate) {
    return 0;
  }

  const latest = new Date(`${latestDate}T00:00:00Z`);
  if (Number.isNaN(latest.getTime())) {
    return 0;
  }

  const cutoff = new Date(latest.getTime() - ((days - 1) * 24 * 60 * 60 * 1000));
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  return commits.filter((commit) => commit.date >= cutoffIso && commit.date <= latestDate).length;
}

function summarizeCommits(commits = [], options = {}) {
  const orderedCommits = [...commits].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const chronologicalCommits = [...commits].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const totalPulls = commits.length;
  const repositoryUrl = normalizeGitHubRepositoryUrl(options.repositoryUrl || '');
  const pullRequestCommits = orderedCommits.filter((commit) => Number(commit.pullRequest?.number || 0) > 0);
  const mergedPullRequests = pullRequestCommits.length;
  const repairPulls = commits.filter((commit) => commit.tags.includes('repair')).length;
  const growthPulls = commits.filter((commit) => commit.tags.includes('growth')).length;
  const firstDate = chronologicalCommits[0]?.date || null;
  const lastDate = orderedCommits[0]?.date || null;
  const maintenancePulls = commits.filter((commit) => commit.tags.includes('maintenance')).length;
  const taggedPulls = totalPulls - maintenancePulls;
  const multiLanePulls = commits.filter((commit) => commit.tags.length > 1).length;

  const categories = CATEGORY_RULES.map((rule) => ({
    id: rule.id,
    label: rule.label,
    count: commits.filter((commit) => commit.tags.includes(rule.id)).length,
    primaryCount: commits.filter((commit) => commit.primaryTag === rule.id).length,
    percent: totalPulls ? Math.round((commits.filter((commit) => commit.tags.includes(rule.id)).length / totalPulls) * 100) : 0,
  })).filter((category) => category.count > 0);

  const primaryCategories = [
    ...CATEGORY_RULES.map((rule) => ({
      id: rule.id,
      label: rule.label,
      count: commits.filter((commit) => commit.primaryTag === rule.id).length,
    })),
    {
      id: 'maintenance',
      label: 'Maintenance',
      count: commits.filter((commit) => commit.primaryTag === 'maintenance').length,
    },
  ].filter((category) => category.count > 0)
    .map((category) => ({
      ...category,
      percent: totalPulls ? Math.round((category.count / totalPulls) * 100) : 0,
    }));

  const phases = PHASES.map((phase) => {
    const phaseCommits = orderedCommits.filter((commit) => commit.phase === phase.id);
    const tagCounts = CATEGORY_RULES.map((rule) => ({
      id: rule.id,
      label: rule.label,
      count: phaseCommits.filter((commit) => commit.tags.includes(rule.id)).length,
    })).filter((item) => item.count > 0);

    return {
      ...phase,
      count: phaseCommits.length,
      repairCount: phaseCommits.filter((commit) => commit.tags.includes('repair')).length,
      growthCount: phaseCommits.filter((commit) => commit.tags.includes('growth')).length,
      percent: totalPulls ? Math.round((phaseCommits.length / totalPulls) * 100) : 0,
      tagCounts,
      primaryTagCounts: [
        ...CATEGORY_RULES.map((rule) => ({
          id: rule.id,
          label: rule.label,
          count: phaseCommits.filter((commit) => commit.primaryTag === rule.id).length,
        })),
        {
          id: 'maintenance',
          label: 'Maintenance',
          count: phaseCommits.filter((commit) => commit.primaryTag === 'maintenance').length,
        },
      ].filter((item) => item.count > 0),
      highlights: phaseCommits.slice(0, 5),
    };
  }).filter((phase) => phase.count > 0);

  return {
    totalPulls,
    mergedPullRequests,
    repairPulls,
    growthPulls,
    maintenancePulls,
    taggedPulls,
    multiLanePulls,
    recentVelocity: {
      latestDate: lastDate,
      last7Days: countSince(commits, lastDate, 7),
      last14Days: countSince(commits, lastDate, 14),
      last30Days: countSince(commits, lastDate, 30),
    },
    firstDate,
    lastDate,
    categories,
    primaryCategories,
    phases,
    tiles: orderedCommits.map((commit, index) => ({
      index: totalPulls - index,
      shortHash: commit.shortHash,
      date: commit.date,
      subject: commit.subject,
      phase: commit.phase,
      primaryTag: commit.primaryTag,
      pullRequest: commit.pullRequest,
    })),
    recent: orderedCommits.slice(0, 48).map((commit) => ({
      ...commit,
      pullRequest: commit.pullRequest
        ? {
          ...commit.pullRequest,
          url: buildPullRequestUrl(repositoryUrl, commit.pullRequest.number),
        }
        : null,
    })),
    recentPullRequests: pullRequestCommits.slice(0, 24).map((commit) => ({
      hash: commit.hash,
      shortHash: commit.shortHash,
      date: commit.date,
      subject: commit.subject,
      phase: commit.phase,
      primaryTag: commit.primaryTag,
      number: commit.pullRequest.number,
      source: commit.pullRequest.source,
      url: buildPullRequestUrl(repositoryUrl, commit.pullRequest.number),
    })),
  };
}

async function getCodexSessionSummary() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sessionsPath = path.join(codexHome, 'sessions');

  try {
    const files = [];
    const stack = [sessionsPath];
    while (stack.length) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
      entries.forEach((entry) => {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          return;
        }
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const stat = fs.statSync(fullPath);
          files.push({ modifiedAt: stat.mtime.toISOString(), bytes: stat.size });
        }
      });
    }

    files.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));

    return {
      available: true,
      count: files.length,
      latestAt: files[0]?.modifiedAt || null,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    };
  } catch (error) {
    return {
      available: false,
      count: 0,
      latestAt: null,
      totalBytes: 0,
      message: error.code === 'ENOENT' ? 'Codex session logs were not found on this server.' : error.message,
    };
  }
}

async function buildLillyHistory({ cwd = process.cwd(), maxCount = 5000 } = {}) {
  const { stdout } = await execFileAsync('git', [
    'log',
    '--all',
    '--format=%H%x09%ad%x09%s',
    '--date=short',
    `--max-count=${maxCount}`,
  ], { cwd, maxBuffer: 1024 * 1024 * 4 });

  let repositoryUrl = null;
  try {
    const remote = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], { cwd });
    repositoryUrl = normalizeGitHubRepositoryUrl(remote.stdout);
  } catch (_error) {
    repositoryUrl = null;
  }

  const commits = parseGitLog(stdout);
  const summary = summarizeCommits(commits, { repositoryUrl });
  const codexSessions = await getCodexSessionSummary();

  return {
    generatedAt: new Date().toISOString(),
    source: 'git log --all plus optional Codex session count',
    repositoryUrl,
    ...summary,
    codexSessions,
  };
}

module.exports = {
  CATEGORY_RULES,
  PHASES,
  buildPullRequestUrl,
  buildLillyHistory,
  getTags,
  normalizeGitHubRepositoryUrl,
  parseGitLog,
  parseMergePullRequestSubject,
  summarizeCommits,
};
