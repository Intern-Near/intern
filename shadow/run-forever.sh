#!/usr/bin/env bash
# Keeps a shadow run going for its whole length: restarts it after a crash (30 s pause) and stops when it
# reports that it has finished. A set-up error (exit code 2, for example no API key) stops it instead of looping.
#
# Usage, from intern/shadow:   ./run-forever.sh data/<run-id>
# On a laptop, stop it from sleeping for the run's length:
#   systemd-inhibit --what=sleep:idle --why="INTERN shadow run" ./run-forever.sh data/<run-id>
set -u
cd "$(dirname "$0")"
RUN_DIR="${1:?usage: ./run-forever.sh <run-dir>}"
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

while true; do
  node --env-file-if-exists=.env --env-file-if-exists=../runner/.env src/cli/shadow.ts run --run-dir "$RUN_DIR"
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "$(stamp) shadow run finished"
    exit 0
  fi
  if [ "$code" -eq 2 ]; then
    echo "$(stamp) shadow run cannot start (exit code 2); fix the message above, then start it again" >&2
    exit 2
  fi
  echo "$(stamp) shadow run stopped with exit code $code; restarting in 30 s" >&2
  sleep 30
done
