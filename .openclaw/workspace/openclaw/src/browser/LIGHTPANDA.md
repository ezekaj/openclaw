# Lightpanda Browser Integration

Lightpanda is a fast, headless browser that uses 9x less memory than Chromium. It's CDP-compatible but doesn't render pixels visually.

## Configuration

Add to your OpenClaw config:

```yaml
browser:
  engine: lightpanda  # or "chromium" (default), "auto"
  lightpanda:
    enabled: true
    autoInstall: true
    fallbackToChromium: true  # if Lightpanda fails
    binaryPath: /usr/local/bin/lightpanda  # optional
    version: latest  # optional
```

## How It Works

When `engine: lightpanda`:
1. `server-context.ts` routes browser launch to `LightpandaManager`
2. Lightpanda binary is auto-installed (if `autoInstall: true`)
3. CDP operations work normally (navigate, evaluate, etc.)
4. If Lightpanda fails and `fallbackToChromium: true`, falls back to Chrome

## Limitations

⚠️ **Screenshots won't work** - Lightpanda has no visual rendering. For screenshots, use `engine: chromium` or `auto`.

## Auto Mode

With `engine: auto`, OpenClaw smart-routes based on task:
- Simple tasks (scraping, navigation) → Lightpanda (fast)
- Complex tasks (screenshots, SPAs) → Chromium (compatible)

## Implementation

- **Config:** `src/config/types.browser.ts` + `src/browser/config.ts`
- **Manager:** `src/browser/lightpanda-manager.ts` (download, install, lifecycle)
- **Client:** `src/browser/lightpanda-client.ts` (CDD operations)
- **Router:** `src/browser/server-context.ts` (engine selection at launch)
