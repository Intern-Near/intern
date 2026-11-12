# The Intern's runner on Railway (or any Docker host). One copy only: two runners with the same keys clash.
# Secrets come from the host's environment variables (see .env.example); no .env file is copied in.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
# Round logs, the raw AI exchanges, the trick queue and the Hyperliquid order evidence go to /app/logs: mount a
# volume there so they survive restarts. With PORT set (Railway sets it), `loop` also serves the trick page.
ENV HL_SAVE_DIR=/app/logs/hl-exchange
CMD ["node", "src/cli/run.ts", "loop", "--contract", "coin.desk-lab-2026.testnet"]
