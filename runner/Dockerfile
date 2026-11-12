# The Intern's runner on Railway (or any Docker host). One copy only: two runners with the same keys clash.
# Secrets come from the host's environment variables (see .env.example); no .env file is copied in.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
# Round logs and the raw AI exchanges go to /app/logs: mount a volume there so they survive restarts.
CMD ["node", "src/cli/run.ts", "loop", "--contract", "coin.desk-lab-2026.testnet"]
