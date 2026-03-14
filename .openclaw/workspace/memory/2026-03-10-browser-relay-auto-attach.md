# Browser Extension Auto-Attach Implementation

## Problem
Recurring issue: Chrome extension relay requires manual tab attachment via toolbar button click. This breaks automation workflows.

## Solution: "Control Channel" Pattern
Instead of passive proxy, add an orchestration layer where backend can command the extension to find/create/attach tabs.

## Implementation

### 1. Background.js - Add Control Protocol

Add message routing for URL patterns matching:

```javascript
// Intercept OpenClaw Control messages
if (message.type === '__OPENCLAW_CONTROL__') {
  if (message.command === 'ATTACH_TO_URL') {
    await handleAutoAttach(message.urlPattern, message.fallbackUrl);
  }
  return; // Forward standard CDP...
}

`;

async function handleAutoAttach(urlPattern, fallbackUrl) {
  try {
    // 1. Query existing tabs matching the pattern
    const tabs = await chrome.tabs.query({ url: urlPattern });
    let targetTab;
    
    if (tabs.length > 0) {
      // Use existing tab
      targetTab = tabs[0];
      await chrome.tabs.update(targetTab.id, { active: true });
      // Bring to front
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      // 2. Create new tab if needed
      const newTab = await chrome.tabs.create({ url: fallbackUrl, active: false });
      targetTab = newTab;
      
      // 3. Wait for tab to load
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // 4. Programmatically attach debugger
    await chrome.debugger.attach({ tabId: targetTab.id }, '1.3');
    
    // 5. Notify relay of success
    ws.send(JSON.stringify({
      type: '__OPENCLAW_STATUS__',
      status: 'ATTACHED',
      tabId: targetTab.id,
      url: newTab.url
    }));
  } catch (error) {
    ws.send(JSON.stringify({
      type: '__OPENCLAW_ERROR__',
      error: error.message
    }));
  }
}
```

### 2. extension-relay.ts - Add Auto-Attach Command
Add command to forward `ATTACH_TO_URL` to extension:
```typescript
// Control protocol message types
type OpenClawControlMessage = {
  type: '__OPENCLAW_CONTROL__';
  command: 'ATTACH_TO_URL';
  urlPattern: string;
  fallbackUrl: string;
};

type OpenClawStatusMessage = {
  type: '__OPENCLAW_STATUS__';
  status: 'ATTACHED';
  tabId: number;
  url: string;
};

type OpenClawErrorMessage = {
  type: '__OPENCLAW_ERROR__';
  error: string;
};

// When the AI requests LinkedIn automation:
// the server-context.ts for check if tab is attached
async function ensureTabAttached(urlPattern: string): Promise<void> {
  // Send control message to extension
  const response = await sendControlMessage({
    type: '__OPENCLAW_CONTROL__',
    command: 'ATTACH_TO_URL',
    urlPattern,
    fallbackUrl: 'https://www.linkedin.com',
  });
  
  if (response.status === 'ATTACHED') {
    // Tab attached successfully, Continue
  return;
  }
  
  throw new Error(response.error || 'Failed to attach tab');
}
```

### 3. server-context.ts - Lazy Tab Attachment
Instead of throwing error, check and attach first
```typescript
async function ensureBrowserAvailableWithAutoAttach(): Promise<void> {
  const current = state();
  const remoteCdp = !profile.cdpIsLoopback;
  const isExtension = profile.driver === "extension";
  const profileState = getProfileState();
  const httpReachable = await isHttpReachable();

  if (isExtension && remoteCdp) {
    throw new Error(
      `Profile "${profile.name}" uses driver=extension but cdpUrl is not loopback (${profile.cdpUrl}).`,
    );
  }

  if (isExtension) {
    if (!httpReachable) {
      // Start relay server if not running
      await ensureChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl });
      if (await isHttpReachable(1200)) {
        // continue: we still need the extension to connect for CDP websocket.
      } else {
        throw new Error(
          `Chrome extension relay for profile "${profile.name}" is not reachable at ${profile.cdpUrl}.`,
        );
      }
    }

    // Check if already attached
    if (await isReachable(600)) {
      return;
    }
    
    // No tab attached yet - try to auto-attach
    try {
      await sendControlMessage({
        type: '__OPENCLAW_CONTROL__',
        command: 'ATTACH_TO_URL',
        urlPattern: '*://*.linkedin.com/*',
        fallbackUrl: 'https://www.linkedin.com',
      });
      return;
    } catch (err) {
      // Fallback: just use the isolated browser
      throw new Error(
        `Failed to attach to LinkedIn tab: ${err.message}. ` +
          'Use profile="openclaw" for isolated browser automation instead.',
      );
    }
  }

  // HTTP reachable but WebSocket fails - port in use
  if (!profileState.running) {
    throw new Error(
      `Port ${profile.cdpPort} is in use for profile "${profile.name}" but not by openclaw. ` +
        `Run action=reset-profile profile=${profile.name} to kill the process.`,
      );
    }
    // We own it but WebSocket failed - restart
    if (current.resolved.attachOnly || remoteCdp) {
      if (opts.onEnsureAttachTarget) {
        await opts.onEnsureAttachTarget(profile);
        if (await isReachable(1200)) {
          return;
        }
      }
      throw new Error(
        remoteCdp
          ? `Remote CDP websocket for profile "${profile.name}" is not reachable.`
          : `Browser attachOnly is enabled and CDP websocket for profile "${profile.name}" is not reachable.`,
      );
    }
    await stopOpenClawChrome(profileState.running);
    setProfileRunning(null);
    const relaunched = await launchOpenClawChrome(current.resolved, profile);
    attachRunning(relaunched);
    if (!(await isReachable(600))) {
      throw new Error(
        `Chrome CDP websocket for profile "${profile.name}" is not reachable after restart.`,
      );
    }
  }
```
  const ensureTabAvailable = async (targetId?: string): Promise<BrowserTab> => {
    await ensureBrowserAvailableWithAutoAttach();
    // ... rest of function
};
```

### 4. Update Chrome Extension Manifest
Ensure these permissions are present:
```json
{
  "permissions": ["debugger", "tabs", "activeTab"],
  "host_permissions": ["http://*/*", "https://*/*"]
}
```

### Testing the1. Install the updated extension in Chrome
2. Reload the extension to pick up the changes
3. Verify auto-attach works

- Open LinkedIn in Chrome
- Navigate to https://www.linkedin.com
- Open the extension icon
- Wait for "ATTACHED" status
- Verify automation works

- Close the isolated browser tab

- Test error handling

- Test fallback behavior (- User navigates away manually
- Test URL pattern matching
- Test that openclaw profile works as fallback
- Verify Caching works
- Clean up
})

["activeForm": "Updating Chrome extension manifest"}]