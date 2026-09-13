// Explicit local-only canary. No credentials, external sites, or saved screenshots.
const http = require('http');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const { AgentComputerRuntime } = require('./runtime');

async function run() {
  const executablePath = process.env.AGENT_COMPUTER_CANARY_BROWSER;
  if (!executablePath) throw new Error('Set AGENT_COMPUTER_CANARY_BROWSER to an installed Chromium executable');
  let cookieReadBack = false;
  const server = http.createServer((req, res) => {
    cookieReadBack ||= String(req.headers.cookie || '').includes('lilly_computer_canary=persisted');
    if (req.url === '/set') res.setHeader('Set-Cookie', 'lilly_computer_canary=persisted; Max-Age=300; SameSite=Strict; Path=/');
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Local agent computer canary</title><style>body{background:#193044;color:white}button{margin:40px;width:220px;height:140px;background:#e94444;color:white;font:28px sans-serif}</style><button onclick="this.style.background=\'#00804a\';this.textContent=\'Done\'">Change color</button>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilly-computer-canary-'));
  const identity = { ownerId: 'local-canary', teamId: 'isolated-fixture', agentId: 'browser-one' };
  const runtime = new AgentComputerRuntime({ rootDir, chromium, executablePath, authorize: async ({ url }) => new URL(url).origin === origin });
  try {
    const first = await runtime.open(identity, { url: `${origin}/set` });
    const second = await runtime.act(identity, { computerId: first.computerId, frameId: first.frameId, action: { type: 'click', x: 140, y: 110 } });
    if (first.image.buffer.equals(second.image.buffer)) throw new Error('Action did not change the rendered frame');
    const input = await runtime.getModelInput(identity, { computerId: second.computerId, frameId: second.frameId });
    if (!input[1].image_url.startsWith('data:image/png;base64,')) throw new Error('Private model input missing');
    if (JSON.stringify(second).includes('image') || JSON.stringify(second).includes(origin)) throw new Error('Private observation leaked through JSON');
    await runtime.close(identity, { computerId: first.computerId });
    await runtime.open(identity, { url: `${origin}/read` });
    if (!cookieReadBack) throw new Error('Cookie did not persist after browser close/reopen');
    console.log(JSON.stringify({ ok: true, fixture: 'local-only-no-auth', renderedActionChangedFrame: true, privateModelInput: true, operatorJSONExcludesPixels: true, cookieReadBackAfterReopen: true }));
  } finally {
    await runtime.dispose();
    await new Promise((resolve) => server.close(resolve));
    const resolvedRoot = await fs.realpath(rootDir);
    const tempParent = await fs.realpath(os.tmpdir());
    if (path.dirname(resolvedRoot) !== tempParent || !path.basename(resolvedRoot).startsWith('lilly-computer-canary-')) {
      throw new Error('Refusing cleanup outside the dedicated canary directory');
    }
    await fs.rm(resolvedRoot, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
