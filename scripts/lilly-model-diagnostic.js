'use strict';
const config = require('/app/src/config');
const OpenAI = require('/app/node_modules/openai');
const client = new OpenAI({ apiKey: config.openai.apiKey, baseURL: config.openai.baseURL, maxRetries: 0, timeout: 20000 });
client.responses.create({ model: config.openai.model, input: [{ role: 'user', content: 'Reply with OK. This is a connectivity diagnostic; do not perform actions.' }],
  max_output_tokens: 64, store: false }).then(result => console.log(JSON.stringify({ success: true, outputTypes: result.output?.map(item => item.type) }))).catch(error => {
  let message = String(error.message || '').split(config.openai.apiKey || '\0').join('[REDACTED]');
  message = message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 500);
  console.log(JSON.stringify({ success: false, status: error.status, code: error.code, name: error.name, message }));
  process.exitCode = 1;
});
