'use strict';
const config = require('/app/src/config');
async function main() {
  const response = await fetch(`${config.openai.baseURL.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${config.openai.apiKey}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Model catalog unavailable');
  const body = await response.json();
  console.log(JSON.stringify({ models: (body.data || []).filter(m => /astra|deepseek/i.test(m.id)).map(m => ({ id: m.id })) }));
}
main().catch(() => { console.error('Model catalog unavailable'); process.exitCode = 1; });
