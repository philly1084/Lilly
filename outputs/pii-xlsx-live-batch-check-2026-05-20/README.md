# Live PII XLSX Web-Chat Check

- Base URL: https://lilly.secdevsolutions.help
- Live backend image: ghcr.io/philly1084/lilly:sha-502c8d4
- Live checks: /live=live, /ready=ready
- Session ID: bdb6d2fc-ddd1-4293-88dc-3161b8f6de81
- Uploaded artifact ID: d9e3ee34-c997-4c4d-8e7b-899a6a1a998e
- Generated XLSX artifact ID: c3631450-11bb-4161-988c-3c6bad97d151
- Generated XLSX filename: pii-vault-calculation-1v9i6n.xlsx
- Backend returned artifacts: 1
- Prompt mode: batch

## Agent-Facing Output

- Tool calls: pii-relationship-calculate
- Raw private sample values in tool arguments/result: none
- Raw private sample values in assistant content: none
- PII replacement count: 18
- Restored count for trusted presentation: 3

## Ingestion Back

- Upload status: 201
- Frontend upload preview suppressed: true
- Local extractor saw real XLSX shared-string values before privacy protection: patientKey=true, name=true, dob=true, healthCard=true
- Structured table count: 1

## XLSX Output

- Downloaded output: C:\Users\phill\KimiBuilt\outputs\pii-xlsx-live-batch-check-2026-05-20\pii-vault-calculation-1v9i6n.xlsx
- Downloaded byte length: 2904
- Trusted restored private sample values in downloaded output text: P-1001
- This restored value appears only in the trusted generated XLSX output. It did not appear in the tool arguments/result or assistant model-facing content.

## Frontend Proof

- Fresh web-chat batch session ID: bdb6d2fc-ddd1-4293-88dc-3161b8f6de81

## Files

- sample-pii-balances.xlsx
- request-payload.json
- upload-response.json
- chat-response.json
- agent-facing-output.json
- ingestion-back-output.json
- xlsx-output.json
