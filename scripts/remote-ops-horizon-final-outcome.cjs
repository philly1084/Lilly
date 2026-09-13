'use strict';
const assert=require('node:assert/strict');
const {extractRemoteCliRunMetadata}=require('/app/src/remote-cli/agents-sdk-runner');
const r=require('/tmp/lilly-horizon-proof.json');const final=r.results.feedback.finalAssistantMessage;assert.ok(final);const metadata=extractRemoteCliRunMetadata(final);assert.ok(!metadata.supportAgentRequest);assert.ok(!metadata.blocker);console.log(JSON.stringify({savedFeedbackFinalParsed:true,answeredQuestionRemoved:true,blocker:metadata.blocker||null,final}));
