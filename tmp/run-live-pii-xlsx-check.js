const fs = require('fs');
const path = require('path');
const { buildXlsxBufferFromWorkbookSpec } = require('../src/artifacts/artifact-renderer');
const { extractArtifact } = require('../src/artifacts/artifact-extractor');

const baseUrl = process.env.LILLY_BASE_URL || 'https://lilly.secdevsolutions.help';
const username = process.env.LILLY_AUTH_USERNAME;
const password = process.env.LILLY_AUTH_PASSWORD;
const outDir = process.env.PII_XLSX_OUT_DIR || path.join(process.cwd(), 'outputs', 'pii-xlsx-live-check');

if (!username || !password) {
  throw new Error('LILLY_AUTH_USERNAME and LILLY_AUTH_PASSWORD are required');
}

const rawPrivateValues = [
  'P-1001',
  'P-1002',
  'P-1003',
  'Jamie Sampleton',
  'Mina Halbrook',
  'Owen Callis',
  '10/08/84',
  '02/14/79',
  '12/01/88',
  '046 454 286',
  '5584-486-721-MB',
  'AB 1234 5678',
  'K1A 0B1',
  'B3H 2Y9',
  'M5V 2T6',
];

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
  } catch (error) {
    return { parseError: error.message, raw: text.slice(0, 2000) };
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await readJson(response);
  if (!response.ok) {
    const error = new Error(`${options.method || 'GET'} ${url} failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return { response, data };
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function containsAnyRawPrivateValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return rawPrivateValues.filter((privateValue) => text.includes(privateValue));
}

function summarizeToolEvents(toolEvents = []) {
  return toolEvents.map((event) => {
    let args = {};
    try {
      args = JSON.parse(event?.toolCall?.function?.arguments || '{}');
    } catch (_error) {
      args = { parseError: true };
    }
    return {
      name: event?.toolCall?.function?.name || '',
      arguments: args,
      result: event?.result || null,
      rawPrivateValuesInArguments: containsAnyRawPrivateValue(args),
      rawPrivateValuesInResult: containsAnyRawPrivateValue(event?.result || null),
    };
  });
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const workbookSpec = {
    title: 'PII XLSX Live Smoke Sample',
    sheets: [{
      name: 'Patient Balances',
      rows: [
        ['Patient Key', 'Patient Balance', 'Subscriber Name', 'DOB', 'Health Card Number', 'Postal Code'],
        ['P-1001', 325.5, 'Jamie Sampleton', '10/08/84', '046 454 286', 'K1A 0B1'],
        ['P-1002', 875.0, 'Mina Halbrook', '02/14/79', '5584-486-721-MB', 'B3H 2Y9'],
        ['P-1001', 710.25, 'Jamie Sampleton', '10/08/84', '046 454 286', 'K1A 0B1'],
        ['P-1003', 940.75, 'Owen Callis', '12/01/88', 'AB 1234 5678', 'M5V 2T6'],
      ],
    }],
  };
  const sampleBuffer = buildXlsxBufferFromWorkbookSpec(workbookSpec);
  const samplePath = path.join(outDir, 'sample-pii-balances.xlsx');
  fs.writeFileSync(samplePath, sampleBuffer);

  const localExtraction = await extractArtifact({
    filename: 'sample-pii-balances.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: sampleBuffer,
  });
  writeJson('local-extraction-check.json', {
    format: localExtraction.format,
    textContainsExpectedSharedStrings: {
      patientKey: localExtraction.extractedText.includes('P-1001'),
      name: localExtraction.extractedText.includes('Jamie Sampleton'),
      dob: localExtraction.extractedText.includes('10/08/84'),
      healthCard: localExtraction.extractedText.includes('046 454 286'),
    },
    structuredTables: localExtraction.metadata?.structuredTables || [],
  });

  const login = await fetchJson(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, returnTo: '/web-chat/' }),
  });
  const cookie = cookieFromSetCookie(login.response.headers.get('set-cookie'));

  const sessionResult = await fetchJson(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({
      metadata: {
        clientSurface: 'web-chat',
        taskType: 'chat',
        mode: 'chat',
        memoryScope: 'web-chat',
        sessionIsolation: true,
        testRun: 'pii-xlsx-live-check',
      },
    }),
  });
  let sessionId = sessionResult.data.id;

  const form = new FormData();
  form.append('sessionId', sessionId);
  form.append('mode', 'chat');
  form.append('taskType', 'chat');
  form.append('clientSurface', 'web-chat');
  form.append('memoryScope', 'web-chat');
  form.append('file', new Blob([sampleBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }), 'sample-pii-balances.xlsx');

  const uploadResponse = await fetch(`${baseUrl}/api/artifacts/upload`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form,
  });
  const uploadData = await readJson(uploadResponse);
  if (!uploadResponse.ok) {
    const error = new Error(`upload failed: ${uploadResponse.status}`);
    error.data = uploadData;
    throw error;
  }

  const uploadedArtifact = uploadData.artifact || uploadData;
  const uploadedArtifactId = uploadedArtifact.id;
  if (uploadedArtifact.sessionId && uploadedArtifact.sessionId !== sessionId) {
    sessionId = uploadedArtifact.sessionId;
  }
  const promptMode = String(process.env.PII_XLSX_PROMPT_MODE || 'top').trim().toLowerCase();
  const prompt = promptMode === 'batch'
    ? [
      'Using the uploaded spreadsheet, create an XLSX output file.',
      'Run a batch calculation plan: top 3 patient balances, also calculate average and count.',
      'Use the PII vault relationship calculation path; do not expose raw names, DOBs, health-card numbers, postal codes, or patient keys to the agent.',
      'Return the batch calculation result as an XLSX artifact.',
    ].join(' ')
    : [
      'Using the uploaded spreadsheet, create an XLSX output file.',
      'Find the patient key with the highest total Patient Balance.',
      'Use the PII vault relationship calculation path; do not expose raw names, DOBs, health-card numbers, postal codes, or patient keys to the agent.',
      'Return the calculation result as an XLSX artifact.',
    ].join(' ');

  const requestPayload = {
    message: prompt,
    sessionId,
    stream: false,
    artifactIds: [uploadedArtifactId],
    outputFormat: 'xlsx',
    reasoningEffort: 'low',
    metadata: {
      clientSurface: 'web-chat',
      taskType: 'chat',
      mode: 'chat',
      memoryScope: 'web-chat',
      sessionIsolation: true,
      testRun: 'pii-xlsx-live-check',
      promptMode,
    },
  };

  const chat = await fetchJson(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify(requestPayload),
  });

  const artifacts = Array.isArray(chat.data.artifacts) ? chat.data.artifacts : [];
  const outputArtifact = artifacts.find((artifact) => String(artifact.format || artifact.extension || '').toLowerCase() === 'xlsx') || artifacts[0] || null;
  let downloadedOutput = null;
  let downloadedExtraction = null;
  if (outputArtifact?.downloadUrl) {
    const downloadResponse = await fetch(new URL(outputArtifact.downloadUrl, baseUrl), {
      headers: { Cookie: cookie },
    });
    const outputBuffer = Buffer.from(await downloadResponse.arrayBuffer());
    const outputPath = path.join(outDir, outputArtifact.filename || 'pii-vault-calculation-result.xlsx');
    fs.writeFileSync(outputPath, outputBuffer);
    downloadedOutput = {
      status: downloadResponse.status,
      path: outputPath,
      filename: outputArtifact.filename || path.basename(outputPath),
      byteLength: outputBuffer.length,
    };
    downloadedExtraction = await extractArtifact({
      filename: downloadedOutput.filename,
      mimeType: outputArtifact.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: outputBuffer,
    });
  }

  const toolSummary = summarizeToolEvents(chat.data.toolEvents || []);
  const agentFacingOutput = {
    toolSummary,
    assistantContent: chat.data.response || chat.data.message || chat.data.content || '',
    rawPrivateValuesInToolEvents: containsAnyRawPrivateValue(chat.data.toolEvents || []),
    rawPrivateValuesInAssistantContent: containsAnyRawPrivateValue(chat.data.response || chat.data.message || chat.data.content || ''),
    piiCleansing: chat.data.assistantMetadata?.piiCleansing || chat.data.assistant_metadata?.piiCleansing || null,
  };
  const ingestionBackOutput = {
    uploadStatus: uploadResponse.status,
    uploadedArtifact: {
      id: uploadedArtifact.id,
      filename: uploadedArtifact.filename,
      format: uploadedArtifact.format || uploadedArtifact.extension,
      mimeType: uploadedArtifact.mimeType,
      sizeBytes: uploadedArtifact.sizeBytes,
      previewSuppressed: uploadedArtifact.metadata?.previewSuppressed === true || !uploadedArtifact.preview,
      metadataKeysReturnedToFrontend: Object.keys(uploadedArtifact.metadata || {}),
    },
    localExtractorProof: {
      sawPatientKey: localExtraction.extractedText.includes('P-1001'),
      sawName: localExtraction.extractedText.includes('Jamie Sampleton'),
      sawDob: localExtraction.extractedText.includes('10/08/84'),
      sawHealthCard: localExtraction.extractedText.includes('046 454 286'),
      structuredTableCount: (localExtraction.metadata?.structuredTables || []).length,
    },
    protectedContextFromChat: agentFacingOutput.piiCleansing,
  };
  const xlsxOutput = {
    artifact: outputArtifact,
    downloadedOutput,
    extractedText: downloadedExtraction?.extractedText || '',
    rawPrivateValuesInDownloadedOutput: containsAnyRawPrivateValue(downloadedExtraction?.extractedText || ''),
  };

  writeJson('request-payload.json', {
    ...requestPayload,
    message: prompt,
  });
  writeJson('upload-response.json', uploadData);
  writeJson('chat-response.json', chat.data);
  writeJson('agent-facing-output.json', agentFacingOutput);
  writeJson('ingestion-back-output.json', ingestionBackOutput);
  writeJson('xlsx-output.json', xlsxOutput);

  const report = [
    '# Live PII XLSX Web-Chat Check',
    '',
    `- Base URL: ${baseUrl}`,
    `- Session ID: ${sessionId}`,
    `- Uploaded artifact ID: ${uploadedArtifactId}`,
    `- Generated XLSX artifact ID: ${outputArtifact?.id || 'none'}`,
    `- Generated XLSX filename: ${outputArtifact?.filename || 'none'}`,
    `- Backend returned artifacts: ${artifacts.length}`,
    `- Prompt mode: ${promptMode}`,
    '',
    '## Agent-Facing Output',
    '',
    `- Tool calls: ${toolSummary.map((entry) => entry.name).filter(Boolean).join(', ') || 'none'}`,
    `- Raw private sample values in tool arguments/result: ${agentFacingOutput.rawPrivateValuesInToolEvents.length ? agentFacingOutput.rawPrivateValuesInToolEvents.join(', ') : 'none'}`,
    `- Raw private sample values in assistant content: ${agentFacingOutput.rawPrivateValuesInAssistantContent.length ? agentFacingOutput.rawPrivateValuesInAssistantContent.join(', ') : 'none'}`,
    `- PII replacement count: ${agentFacingOutput.piiCleansing?.replacementCount ?? 'n/a'}`,
    `- Restored count for trusted presentation: ${agentFacingOutput.piiCleansing?.restoredCount ?? 'n/a'}`,
    '',
    '## Ingestion Back',
    '',
    `- Upload status: ${uploadResponse.status}`,
    `- Frontend upload preview suppressed: ${ingestionBackOutput.uploadedArtifact.previewSuppressed}`,
    `- Local extractor saw real XLSX shared-string values before privacy protection: patientKey=${ingestionBackOutput.localExtractorProof.sawPatientKey}, name=${ingestionBackOutput.localExtractorProof.sawName}, dob=${ingestionBackOutput.localExtractorProof.sawDob}, healthCard=${ingestionBackOutput.localExtractorProof.sawHealthCard}`,
    `- Structured table count: ${ingestionBackOutput.localExtractorProof.structuredTableCount}`,
    '',
    '## XLSX Output',
    '',
    `- Downloaded output: ${downloadedOutput?.path || 'none'}`,
    `- Downloaded byte length: ${downloadedOutput?.byteLength || 0}`,
    `- Raw private sample values in downloaded output text: ${xlsxOutput.rawPrivateValuesInDownloadedOutput.length ? xlsxOutput.rawPrivateValuesInDownloadedOutput.join(', ') : 'none'}`,
    '',
    '## Files',
    '',
    '- sample-pii-balances.xlsx',
    '- request-payload.json',
    '- upload-response.json',
    '- chat-response.json',
    '- agent-facing-output.json',
    '- ingestion-back-output.json',
    '- xlsx-output.json',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'README.md'), report);

  console.log(JSON.stringify({
    ok: true,
    outDir,
    sessionId,
    uploadedArtifactId,
    outputArtifactId: outputArtifact?.id || null,
    outputArtifactFilename: outputArtifact?.filename || null,
    rawPrivateValuesInToolEvents: agentFacingOutput.rawPrivateValuesInToolEvents,
    rawPrivateValuesInAssistantContent: agentFacingOutput.rawPrivateValuesInAssistantContent,
    rawPrivateValuesInDownloadedOutput: xlsxOutput.rawPrivateValuesInDownloadedOutput,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    message: error.message,
    status: error.status || null,
    data: error.data || null,
    stack: error.stack,
  }, null, 2));
  process.exit(1);
});
