# 3-minute demo script (screen recording for the SIH submission / finale)

Setup: `uvicorn server.app:app --port 8000` with `AUDIT_LOG=1`; extension loaded from `dist/`;
open <http://localhost:8000/demo/>. Keep a terminal visible with
`tail -f server/audit/requests.jsonl | jq .prompt` — the "server's view".

| Time | Show | Say |
|---|---|---|
| 0:00 | KYC page | "An AI agent that can act on this page would normally see my Aadhaar, PAN, face and signature." |
| 0:15 | Popup → **Privacy X-ray → Preview this page** | "This is exactly what the server receives, computed on my laptop by three small models — faces, a vision transformer, a PII model. Every box is labelled with a token." |
| 0:40 | Point at `ID_CARD`, `SIGNATURE`, `AADHAAR_1` | "Text PII is boxed pixel-exactly from the DOM; images are understood by the ViT — this one is an ID card, that one a signature." |
| 1:00 | Registration page, chip 1 → Run | "Now: register me, with my name, email and phone." |
| 1:10 | Terminal with the server's prompt | "The server only ever saw [NAME_1], [EMAIL_1], [PHONE_1]." |
| 1:30 | Form filled with real values, submitted | "It still filled the form — the tokens become real values only on my device." |
| 1:45 | Inbox page, chip 2 | "What is my OTP?" — answer shows 482913; terminal shows the server answered `[OTP_1]`. |
| 2:10 | Metrics tab | "~0.35 s on-device per step on a 2014 laptop CPU, 37–173 MB total; models load while I type." |
| 2:30 | `eval/results/SUMMARY.md` | "Every number is reproducible: 73% screen understanding on unseen sites, PII F1 0.97, pixel redaction precision 0.91, zero leaks in five tasks." |
| 2:50 | README | "Open-weights server, Chrome and Firefox, fully offline-deployable." |
