#!/bin/bash
# Evolution Agent Daemon - runs continuously
# Discovers and improves one file at a time, then picks a new target

cd "$(dirname "$0")/.." || exit 1

LOG_FILE="/tmp/evolution-agent.log"
SLEEP_BETWEEN_TASKS=30  # seconds to wait between tasks

echo "========================================" >> "$LOG_FILE"
echo "Evolution Daemon Started at $(date)" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"

while true; do
    echo "" >> "$LOG_FILE"
    echo "[$(date)] Starting new evolution task..." >> "$LOG_FILE"

    # Run one evolution task with --discover
    bun src/services/evolution/run-agentic.ts --discover >> "$LOG_FILE" 2>&1

    EXIT_CODE=$?
    echo "[$(date)] Task completed with exit code: $EXIT_CODE" >> "$LOG_FILE"

    # Wait between tasks to avoid hammering the API
    echo "[$(date)] Sleeping ${SLEEP_BETWEEN_TASKS}s before next task..." >> "$LOG_FILE"
    sleep $SLEEP_BETWEEN_TASKS
done
