# Live PII XLSX Web-Chat Check

- Base URL: https://lilly.secdevsolutions.help
- Live backend image: ghcr.io/philly1084/lilly:sha-502c8d4
- Live checks: /live=live, /ready=ready
- Session ID: 07b9dcf3-11ee-45e8-ab5f-0a81617e1941
- Uploaded artifact ID: 5ed3acbf-31af-49fc-bed1-c806a94d4dce
- Generated XLSX artifact ID: a1699369-7808-4e8b-aa33-9febaa19346d
- Generated XLSX filename: pii-vault-calculation-mpiun2.xlsx
- Backend returned artifacts: 1

## Agent-Facing Output

- Tool calls: pii-relationship-calculate
- Raw private sample values in tool arguments/result: none
- Raw private sample values in assistant content: none
- PII replacement count: 18
- Restored count for trusted presentation: 1

## Ingestion Back

- Upload status: 201
- Frontend upload preview suppressed: true
- Local extractor saw real XLSX shared-string values before privacy protection: patientKey=true, name=true, dob=true, healthCard=true
- Structured table count: 1

## XLSX Output

- Downloaded output: C:\Users\phill\KimiBuilt\outputs\pii-xlsx-live-check-2026-05-20-run2\pii-vault-calculation-mpiun2.xlsx
- Downloaded byte length: 2799
- Trusted restored private sample values in downloaded output text: P-1001
- This restored value appears only in the trusted generated XLSX output. It did not appear in the tool arguments/result or assistant model-facing content.

## Frontend Proof

- Live web-chat files screenshot: C:\Users\phill\KimiBuilt\outputs\pii-xlsx-live-check-2026-05-20-run2\live-web-chat-files.png

## Files

- sample-pii-balances.xlsx
- request-payload.json
- upload-response.json
- chat-response.json
- agent-facing-output.json
- ingestion-back-output.json
- xlsx-output.json
