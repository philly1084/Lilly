#!/usr/bin/env node

import process from 'node:process';

const DEFAULTS = {
  kimibuiltUrl: 'https://lilly.secdevsolutions.help',
  gatewayUrl: 'https://router.secdevsolutions.help',
  usernameEnv: 'KIMIBUILT_SMOKE_USERNAME',
  passwordEnv: 'KIMIBUILT_SMOKE_PASSWORD',
  gatewayTokenEnv: 'KIMIBUILT_SMOKE_GATEWAY_TOKEN',
  timeoutMs: 30000,
  chatMessage: 'Reply with exactly: web-chat smoke ok',
  smokeWorkspaceKey: 'web-chat-smoke',
};

function usage() {
  console.log(`Usage: node scripts/smoke-web-chat-gateway.mjs [options]

Secret-safe live smoke for KimiBuilt web-chat -> n8n-gateway.

Options:
  --kimibuilt-url <url>        KimiBuilt origin (default: ${DEFAULTS.kimibuiltUrl})
  --gateway-url <url>          n8n gateway origin (default: ${DEFAULTS.gatewayUrl})
  --username-env <name>        Env var for KimiBuilt login username (default: ${DEFAULTS.usernameEnv})
  --password-env <name>        Env var for KimiBuilt login password (default: ${DEFAULTS.passwordEnv})
  --gateway-token-env <name>   Env var for direct gateway key (default: ${DEFAULTS.gatewayTokenEnv})
  --model <id>                 Optional model for the tiny /api/chat request
  --session-id <id>            Optional explicit smoke session id
  --workspace-key <key>        Isolated smoke workspace key (default: ${DEFAULTS.smokeWorkspaceKey})
  --chat-message <text>        Tiny chat prompt to send
  --timeout <ms>               Per-request timeout (default: ${DEFAULTS.timeoutMs})
  --skip-chat                  Do not send the tiny /api/chat request
  --skip-direct-gateway        Do not probe the public n8n gateway directly
  --dry-run                    Print sanitized plan only
  --help                       Show this help

Required env:
  ${DEFAULTS.usernameEnv}=...
  ${DEFAULTS.passwordEnv}=...

Optional env:
  ${DEFAULTS.gatewayTokenEnv}=...  # enables direct ${DEFAULTS.gatewayUrl}/v1/models proof
`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] || '';
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--kimibuilt-url') options.kimibuiltUrl = next();
    else if (arg === '--gateway-url') options.gatewayUrl = next();
    else if (arg === '--username-env') options.usernameEnv = next();
    else if (arg === '--password-env') options.passwordEnv = next();
    else if (arg === '--gateway-token-env') options.gatewayTokenEnv = next();
    else if (arg === '--model') options.model = next();
    else if (arg === '--session-id') options.sessionId = next();
    else if (arg === '--workspace-key') options.smokeWorkspaceKey = next();
    else if (arg === '--chat-message') options.chatMessage = next();
    else if (arg === '--timeout') options.timeoutMs = Math.max(1000, Number(next()) || options.timeoutMs);
    else if (arg === '--skip-chat') options.skipChat = true;
    else if (arg === '--skip-direct-gateway') options.skipDirectGateway = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  options.kimibuiltUrl = normalizeOrigin(options.kimibuiltUrl);
  options.gatewayUrl = normalizeOrigin(options.gatewayUrl);
  return options;
}

function normalizeOrigin(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '');
  if (!normalized) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) ? normalized : `https://${normalized}`;
}

function getEnvValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function redact(value = '') {
  return String(value || '')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]')
    .replace(/((?:access_token|api_key|token|password|secret)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/"((?:access_)?token|api[_-]?key|password|secret|username)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/(set-cookie|cookie):[^\n\r]+/gi, '$1: [redacted]');
}

function shortSnippet(value = '', limit = 220) {
  return redact(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, limit);
}

function jsonSummary(data) {
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data)) return { count: data.length };
  if (Array.isArray(data.data)) {
    return {
      count: data.data.length,
      sampleIds: data.data
        .map((entry) => String(entry?.id || '').trim())
        .filter(Boolean)
        .slice(0, 5),
    };
  }
  if (Array.isArray(data.sessions)) return { count: data.sessions.length };
  if (Array.isArray(data.items)) return { count: data.items.length };
  return null;
}

function wsTokenSummary(data) {
  return {
    authRequired: data?.authRequired === true,
    hasToken: Boolean(data?.token),
    expiresAtPresent: Boolean(data?.expiresAt),
  };
}

function chatSummary(data, text) {
  if (!data || typeof data !== 'object') {
    return { bodySnippet: shortSnippet(text) };
  }
  return {
    sessionIdPresent: Boolean(data.sessionId || data.session_id),
    responseIdPresent: Boolean(data.responseId || data.id),
    messageChars: String(data.message || data.output_text || '').length,
    artifactCount: Array.isArray(data.artifacts) ? data.artifacts.length : 0,
    gateway: data.gateway ? {
      requested_model: data.gateway.requested_model || null,
      resolved_model: data.gateway.resolved_model || null,
      provider_id: data.gateway.provider_id || null,
      usage_source: data.gateway.usage_source || null,
    } : undefined,
  };
}

function setCookieLines(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function mergeCookies(cookieJar, response) {
  for (const line of setCookieLines(response.headers)) {
    const first = String(line || '').split(';')[0];
    const index = first.indexOf('=');
    if (index > 0) {
      cookieJar.set(first.slice(0, index), first.slice(index + 1));
    }
  }
}

function cookieHeader(cookieJar) {
  return Array.from(cookieJar.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

async function request(name, url, {
  method = 'GET',
  headers = {},
  body = null,
  cookieJar = null,
  timeoutMs = DEFAULTS.timeoutMs,
  summarize = null,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const requestHeaders = {
      accept: 'application/json, text/html;q=0.9, */*;q=0.8',
      ...headers,
    };
    if (cookieJar && cookieJar.size > 0) {
      requestHeaders.cookie = cookieHeader(cookieJar);
    }
    if (body && !requestHeaders['content-type']) {
      requestHeaders['content-type'] = 'application/json';
    }

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (cookieJar) mergeCookies(cookieJar, response);

    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    return {
      name,
      ok: response.ok,
      status: response.status,
      ms: Date.now() - started,
      location: response.headers.get('location') || undefined,
      summary: summarize ? summarize(parsed, text, response) : (jsonSummary(parsed) || { snippet: shortSnippet(text) }),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: error?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : shortSnippet(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function printPlan(options, facts) {
  console.log('[web-chat-gateway-smoke] Plan');
  console.log(JSON.stringify({
    kimibuiltUrl: options.kimibuiltUrl,
    gatewayUrl: options.gatewayUrl,
    usernameEnv: options.usernameEnv,
    passwordEnv: options.passwordEnv,
    gatewayTokenEnv: options.gatewayTokenEnv,
    hasUsername: Boolean(facts.username),
    hasPassword: Boolean(facts.password),
    hasGatewayToken: Boolean(facts.gatewayToken),
    smokeWorkspaceKey: options.smokeWorkspaceKey,
    hasExplicitSessionId: Boolean(options.sessionId),
    skipChat: Boolean(options.skipChat),
    skipDirectGateway: Boolean(options.skipDirectGateway),
    timeoutMs: options.timeoutMs,
  }, null, 2));
}

function printResults(results) {
  let failed = 0;
  for (const result of results) {
    if (result.skipped) {
      console.log(`[web-chat-gateway-smoke] SKIP ${result.name}: ${result.reason}`);
      continue;
    }
    if (!result.ok) failed += 1;
    const base = `[web-chat-gateway-smoke] ${result.ok ? 'PASS' : 'FAIL'} ${result.name} status=${result.status} ms=${result.ms}`;
    const extra = result.location ? ` location=${shortSnippet(result.location)}` : '';
    console.log(`${base}${extra}`);
    if (result.summary !== undefined) {
      console.log(`[web-chat-gateway-smoke] ${result.name} summary=${shortSnippet(JSON.stringify(result.summary), 500)}`);
    }
    if (result.error) {
      console.log(`[web-chat-gateway-smoke] ${result.name} error=${shortSnippet(result.error, 500)}`);
    }
  }
  console.log(`[web-chat-gateway-smoke] ${failed === 0 ? 'PASS' : 'FAIL'} total=${results.filter((r) => !r.skipped).length} failed=${failed}`);
  return failed;
}

async function run(options, env = process.env) {
  const facts = {
    username: getEnvValue(options.usernameEnv, 'LILLYBUILT_AUTH_USERNAME'),
    password: getEnvValue(options.passwordEnv, 'LILLYBUILT_AUTH_PASSWORD'),
    gatewayToken: getEnvValue(options.gatewayTokenEnv, 'N8N_API_KEY', 'OPENAI_API_KEY'),
  };

  if (options.help) {
    usage();
    return 0;
  }
  if (!options.kimibuiltUrl) throw new Error('--kimibuilt-url is required');

  printPlan(options, facts);
  if (options.dryRun) return 0;
  if (!facts.username || !facts.password) {
    throw new Error(`Missing login env. Set ${options.usernameEnv} and ${options.passwordEnv}. Values are never printed.`);
  }

  const cookies = new Map();
  const results = [];

  results.push(await request('auth-login', `${options.kimibuiltUrl}/api/auth/login`, {
    method: 'POST',
    cookieJar: cookies,
    timeoutMs: options.timeoutMs,
    body: {
      username: facts.username,
      password: facts.password,
      returnTo: '/web-chat/',
    },
    summarize: (data) => ({
      success: data?.success === true,
      returnTo: data?.returnTo || null,
      expiresAtPresent: Boolean(data?.expiresAt),
      cookieCount: cookies.size,
    }),
  }));

  results.push(await request('web-chat-load', `${options.kimibuiltUrl}/web-chat/`, {
    cookieJar: cookies,
    timeoutMs: options.timeoutMs,
    summarize: (_data, text, response) => ({
      redirected: response.status >= 300 && response.status < 400,
      title: /<title[^>]*>([^<]+)<\/title>/i.exec(text)?.[1] || '',
      bodyChars: text.length,
      hasWebChatSurface: /web-chat|chat-app|message-input|KimiBuilt|Lilly/i.test(text),
    }),
  }));

  results.push(await request('auth-ws-token', `${options.kimibuiltUrl}/api/auth/ws-token`, {
    cookieJar: cookies,
    timeoutMs: options.timeoutMs,
    summarize: wsTokenSummary,
  }));

  results.push(await request('api-sessions', `${options.kimibuiltUrl}/api/sessions?clientSurface=web-chat&taskType=chat&workspaceKey=web-chat`, {
    cookieJar: cookies,
    timeoutMs: options.timeoutMs,
    summarize: (data) => jsonSummary(data) || {
      keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 8) : [],
    },
  }));

  results.push(await request('kimibuilt-v1-models', `${options.kimibuiltUrl}/v1/models`, {
    cookieJar: cookies,
    timeoutMs: options.timeoutMs,
    summarize: (data, text) => jsonSummary(data) || { snippet: shortSnippet(text) },
  }));

  if (!options.skipDirectGateway) {
    results.push(await request('gateway-healthz', `${options.gatewayUrl}/healthz`, {
      timeoutMs: options.timeoutMs,
      summarize: (data, text) => data || { snippet: shortSnippet(text) },
    }));
    if (facts.gatewayToken) {
      results.push(await request('gateway-v1-models', `${options.gatewayUrl}/v1/models`, {
        timeoutMs: options.timeoutMs,
        headers: {
          authorization: `Bearer ${facts.gatewayToken}`,
          'x-api-key': facts.gatewayToken,
        },
        summarize: (data, text) => jsonSummary(data) || { snippet: shortSnippet(text) },
      }));
    } else {
      results.push({
        name: 'gateway-v1-models',
        skipped: true,
        reason: `set ${options.gatewayTokenEnv} to prove direct gateway /v1/models`,
      });
    }
  }

  if (!options.skipChat) {
    const smokeSessionId = String(options.sessionId || `web-chat-smoke-${Date.now()}`).trim();
    const smokeWorkspaceKey = String(options.smokeWorkspaceKey || DEFAULTS.smokeWorkspaceKey).trim();
    const chatBody = {
      sessionId: smokeSessionId,
      message: options.chatMessage,
      stream: false,
      ...(options.model ? { model: options.model } : {}),
      clientSurface: 'web-chat',
      taskType: 'chat',
      metadata: {
        clientSurface: 'web-chat',
        taskType: 'chat',
        workspaceKey: smokeWorkspaceKey,
        memoryScope: smokeWorkspaceKey,
        sessionIsolation: true,
        smokeTest: 'web-chat-gateway',
      },
    };
    results.push(await request('api-chat', `${options.kimibuiltUrl}/api/chat`, {
      method: 'POST',
      cookieJar: cookies,
      timeoutMs: options.timeoutMs,
      body: chatBody,
      summarize: chatSummary,
    }));
  }

  return printResults(results) === 0 ? 0 : 1;
}

run(parseArgs()).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(`[web-chat-gateway-smoke] ERROR ${shortSnippet(error?.message || error, 500)}`);
  process.exitCode = 1;
});
