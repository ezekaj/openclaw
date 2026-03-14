# @openclaw/evolution-daemon

> Autonomous code evolution daemon - runs 24/7 improving your codebase using AI

Based on [karpathy/autoresearch](https://github.com/karpathy/autoresearch) patterns.

## Features

- ✅ **Fully autonomous** - runs continuously without human intervention
- ✅ **Auto-rollback** - discards changes that fail tests
- ✅ **TSV logging** - human-readable results (like autoresearch)
- ✅ **Simplicity scoring** - prefers code removal over addition
- ✅ **Bailian API** - supports qwen3, kimi-k2.5, glm-5, MiniMax models
- ✅ **Zero dependencies** - standalone Node.js script
- ✅ **Easy setup** - just set API key and run

## Installation

```bash
# From npm (when published)
npm install -g @openclaw/evolution-daemon

# Or download and install locally
npm install ./evolution-package.tgz
```

## Quick Start

```bash
# 1. Set your Bailian API key
export BAILIAN_API_KEY='your_key_here'

# 2. Create config (optional)
cp config.example.json evolution-config.json

# 3. Run daemon
evolution-daemon

# Or with custom options
EVOLUTION_MODEL=kimi-k2.5 EVOLUTION_INTERVAL_MS=1800000 evolution-daemon
```

## Configuration

### Environment Variables

```bash
BAILIAN_API_KEY        # Required: Your Bailian API key
EVOLUTION_MODEL        # Optional: Model to use (default: kimi-k2.5)
EVOLUTION_INTERVAL_MS  # Optional: Cooldown in ms (default: 3600000 = 1 hour)
```

### Config File (evolution-config.json)

```json
{
  "apiKey": "your_key",
  "model": "kimi-k2.5",
  "intervalMs": 3600000,
  "targets": [
    "src/services/example.ts"
  ]
}
```

## Available Models

| Model | Context | Best For |
|-------|---------|----------|
| `kimi-k2.5` ⭐ | 262K | General code evolution (RECOMMENDED) |
| `qwen3-coder-plus` | 1M | Large files, complex refactors |
| `qwen3-max` | 262K | Complex reasoning |
| `glm-5` | 202K | Fast iterations |
| `MiniMax-M2.5` | 196K | Balanced performance |

## How It Works

```
┌─────────────────────────────────────┐
│  Evolution Daemon (24/7)            │
├─────────────────────────────────────┤
│  LOOP FOREVER:                      │
│  1. Pick random target file         │
│  2. Call Bailian API for proposal   │
│  3. Apply patch                     │
│  4. Run tests                       │
│  5. If pass → keep                  │
│     If fail → rollback              │
│  6. Log to TSV                      │
│  7. Sleep 1 hour                    │
│  8. Repeat                          │
└─────────────────────────────────────┘
```

## Output

### evolution-results.tsv

```tsv
commit  metric  memory_gb  status    description
a1b2c3d 0.998   4.2        keep      Batch memory storage optimization
b2c3d4e 0.000   0.0        discard   Async SQLite (tests failed)
c3d4e5f 0.995   4.3        keep      Event partition manager
```

### Console Output

```
[Evolution] Starting autonomous evolution daemon...
[Evolution] Model: kimi-k2.5
[Evolution] Interval: 3600000ms
[Evolution] Targets: 4 files

[Evolution] === Starting new cycle ===
[Evolution] Target: src/agents/predictive-engine.ts
[Evolution] Generating proposal via kimi-k2.5...
[Evolution] Proposal: Remove unused imports
[Evolution] Simplicity: 0.700
[Evolution] Running tests...
[Evolution] ✓ Applied: Remove unused imports
[Evolution]   Metric: 0.998000
[Evolution]   Time: 4521ms
[Evolution] Sleeping for 3600000ms...
```

## Monitoring

```bash
# Watch live logs
tail -f /tmp/evolution-daemon.log

# Check results
cat evolution-results.tsv

# Count improvements
grep -c $'\tkeep\t' evolution-results.tsv

# Check if running
ps aux | grep evolution-daemon
```

## Comparison with Autoresearch

| Feature | autoresearch | evolution-daemon |
|---------|-------------|-----------------|
| Loop | Continuous (5min) | Continuous (1h) |
| Logging | TSV | TSV + SQLite |
| Autonomy | Full | Full |
| Rollback | Manual | Auto |
| Simplicity | Manual scoring | Auto scoring |
| Models | Claude only | 8+ models |

**168x more iterations** than weekly cron (24/day vs 1/week)

## Expected Results

- **Per day:** ~24 experiments (1/hour)
- **Per week:** ~168 experiments
- **Per year:** ~8,760 experiments

## Safety Features

1. **Auto-rollback** - Tests fail → revert instantly
2. **Max retries** - 3 attempts before giving up
3. **Cooldown** - 1 hour between experiments
4. **Logging** - All changes tracked in TSV
5. **Simplicity bias** - Removing code > adding code

## Getting Your API Key

1. Visit: https://bailian.console.aliyun.com/
2. Create account / login
3. Generate API key
4. Set: `export BAILIAN_API_KEY='sk-...'`

## Advanced Usage

### Multiple Targets

```bash
# Create target list
cat > targets.txt << EOF
src/services/auth.ts
src/utils/helpers.ts
src/api/routes.ts
EOF

# Run with custom targets
EVOLUTION_TARGETS_FILE=targets.txt evolution-daemon
```

### Faster Iterations

```bash
# Run every 30 minutes
EVOLUTION_INTERVAL_MS=1800000 evolution-daemon
```

### Specific Model

```bash
# Use qwen for large files
EVOLUTION_MODEL=qwen3-coder-plus evolution-daemon
```

## Stopping the Daemon

```bash
# Find PID
ps aux | grep evolution-daemon

# Graceful stop
kill <PID>

# Force stop
kill -9 <PID>
```

## Troubleshooting

### "BAILIAN_API_KEY not set"
```bash
export BAILIAN_API_KEY='your_key_here'
```

### "No targets found"
```bash
# Ensure you're in project root
cd /path/to/your/project
evolution-daemon
```

### "Tests failed"
- Check your test suite works manually: `npm test`
- Daemon will auto-rollback failed changes

### "API rate limit"
- Increase interval: `EVOLUTION_INTERVAL_MS=7200000` (2 hours)

## Architecture

```typescript
evolution-standalone.js (no dependencies)
├── Bailian API client
├── Unified diff parser
├── Test runner (npm test)
├── TSV logger
├── Auto-rollback system
└── Continuous loop (while true)
```

## License

MIT

## Credits

- Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch)
- Uses [Bailian API](https://bailian.console.aliyun.com/)
- Built for [OpenClaw](https://openclaw.ai)

## Support

- Docs: https://docs.openclaw.ai
- Issues: https://github.com/openclaw/openclaw/issues
- Discord: https://discord.gg/clawd

---

**Status:** Production ready
**Version:** 1.0.0
**Node:** >=18.0.0
