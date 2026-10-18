# OrbitalNet dashboard (mission control)

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm install
VITE_MOCK=1 npm run dev          # standalone scripted replay of the whole mission (no sim needed)
npm run dev                      # live: connects to VITE_SIM_URL (default http://localhost:8000) REST + /ws
npm run build && npm run preview
```

Routes: `/` control room · `/judge` phone console (disruptions + clock). Top bar: pause/accel/reset, Story mode (caption strip for the pitch).
Mock mode: `?t=<sim_seconds>` jumps the replay (e.g. `/?t=70` transfer in progress, `/?t=300` after the outage, `/?t=440` delivered). The replay loops at T+560.

Env: `VITE_SIM_URL`, `VITE_MOCK`, `VITE_EXPLORER_TX_URL` (default `https://explore.tempo.xyz/tx/`).

Live-mode endpoints used: `GET /scenario` (falls back to the bundled copy), `GET /state`, `GET /positions?from&to&step`, `GET /scene/hotspots`, `GET /scene/image`, `GET /scene/truecolor`, `POST /disrupt`, `POST /clock`, `POST /reset`, `WS /ws`.
