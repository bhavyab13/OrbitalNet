#!/usr/bin/env bash
# Starts the OrbitalNet world simulator on :8000
cd "$(dirname "$0")"
set -a; [ -f ../.env ] && source ../.env; set +a
exec uv run uvicorn app.main:app --host 0.0.0.0 --port "${SIM_PORT:-8000}" "$@"
