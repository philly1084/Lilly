const baseUrl = process.env.LILLY_BASE_URL || 'https://lilly.secdevsolutions.help';
const username = process.env.LILLY_AUTH_USERNAME;
const password = process.env.LILLY_AUTH_PASSWORD;
const activeSessionId = process.env.LILLY_ACTIVE_SESSION_ID;

if (!username || !password || !activeSessionId) {
  throw new Error('LILLY_AUTH_USERNAME, LILLY_AUTH_PASSWORD, and LILLY_ACTIVE_SESSION_ID are required');
}

function cookieFromSetCookie(setCookie = '') {
  return String(setCookie || '')
    .split(/,(?=[^;,]+=)/)
    .map((entry) => entry.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (_error) {
    return { raw: text.slice(0, 2000) };
  }
}

async function main() {
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, returnTo: '/web-chat/' }),
  });
  if (!loginResponse.ok) {
    throw new Error(`login failed: ${loginResponse.status}`);
  }
  const cookie = cookieFromSetCookie(loginResponse.headers.get('set-cookie'));
  const response = await fetch(`${baseUrl}/api/sessions/state`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({
      activeSessionId,
      clientSurface: 'web-chat',
      taskType: 'chat',
      mode: 'chat',
      memoryScope: 'web-chat',
    }),
  });
  const data = await readJson(response);
  if (!response.ok) {
    const error = new Error(`session state update failed: ${response.status}`);
    error.data = data;
    throw error;
  }
  console.log(JSON.stringify({
    ok: true,
    activeSessionId: data.activeSessionId || null,
    sessionId: data.session?.id || null,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    message: error.message,
    data: error.data || null,
  }, null, 2));
  process.exit(1);
});
