# The Tail or Fade testnet faucet on Railway. FAUCET_HL_PRIVATE_KEY (the owner's Hyperliquid TESTNET key) is set in
# the host's private variables, never in a file. Grants are recorded in /app/data: mount a volume there.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
ENV DATA_DIR=/app/data
CMD ["node", "src/faucet-server.ts"]
