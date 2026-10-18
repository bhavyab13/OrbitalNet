# @orbitalnet/operator — independent satellite provider node

One codebase, any node: `NODE_ID` + `OPERATOR_ID` select the scenario entry (compute or relay), the Ed25519 key (`keys/<operator_id>.json`) and the payment recipient.

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run dev:phisat     # PHISAT-2  / orbital-foundry  / compute :7001
npm run dev:edrs       # EDRS-C    / lumen-relay      / relay   :7002
npm run dev:starlink   # STARLINK-3005 / northstar-relay / relay :7003 (the late joiner)
npm test               # vitest: signing, pricing, grant rejections, mock reserve, real inference
```
Env (root `.env`): `PAY_RAIL=tempo|stripe|mock`, `MPP_SECRET_KEY`, `TEMPO_RECIPIENT_<operator_id>`, `SIM_URL`, `BROKER_URL`, `PUBLIC_URL`, `ADMIN_TOKEN`.

Pay a reservation by hand (Tempo testnet, account `main` funded via `npx mppx account fund --network testnet`):
```bash
curl -s -X POST localhost:7002/quote -H 'content-type: application/json' -d '{"mission_id":"fire-001","capability":"relay","window_id":"w_C_GS_1","units":{"mb":0.04}}'
npx mppx http://localhost:7002/reserve -X POST -J '{"quote_id":"<id>","holder":"buyer:emergency-ops"}' --network testnet
```
See `deploy-instabox.md` for running each operator on its own InstaBox and `../../docs/PROTOCOL.md` for OCGP.
