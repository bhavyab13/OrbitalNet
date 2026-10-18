# OrbitalNet operator node — one image, any node (NODE_ID/OPERATOR_ID via env).
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir --break-system-packages numpy pillow
WORKDIR /app
# Build context = repo root:  docker build -f packages/operator/Dockerfile -t orbitalnet-operator .
COPY package.json ./
COPY packages/protocol ./packages/protocol
COPY packages/operator ./packages/operator
COPY data ./data
COPY keys ./keys
RUN npm install --workspaces --include-workspace-root --omit=dev --ignore-scripts && npm install -g tsx
ENV ORBITALNET_ROOT=/app PYTHON=python3 SCENARIO=/app/data/scenario.json PORT=7000
EXPOSE 7000
CMD ["sh", "-c", "cd packages/operator && tsx src/index.ts"]
