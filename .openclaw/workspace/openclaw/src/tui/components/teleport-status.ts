/**
 * Teleport Status Component for TUI
 *
 * Displays teleport status in the TUI interface.
 * Uses the session teleport manager to show when a session has been
 * transferred from another device/context.
 */

import { Text } from "@mariozechner/pi-tui";
import { createText } from "./component-helpers.js";
import { getSessionTeleportManager } from "../../agents/session-teleport-manager.js";

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Get a shortened session ID for display (first 8 characters)
 * Safely handles empty or malformed session IDs.
 */
function formatShortSessionId(sessionId: string): string {
  if (!sessionId || sessionId.length === 0) {
    return "unknown";
  }
  return sessionId.slice(0, 8);
}

/**
 * Get status styling based on whether first message has been logged
 */
function getStatusStyle(hasLoggedFirstMessage: boolean): { color: "green" | "yellow"; symbol: string } {
  if (hasLoggedFirstMessage) {
    return { color: "green", symbol: "✓" };
  }
  return { color: "yellow", symbol: "~" };
}

// ============================================================================
// TELEPORT STATUS COMPONENT
// ============================================================================

/**
 * Render teleport status display
 *
 * Returns a styled Text component if session is teleported, null otherwise.
 */
export function renderTeleportStatus(): Text | null {
  const manager = getSessionTeleportManager();
  const info = manager.getTeleportedSessionInfo();

  if (!info?.isTeleported) {
    return null;
  }

  const { color, symbol } = getStatusStyle(info.hasLoggedFirstMessage);
  const shortSessionId = formatShortSessionId(info.sessionId);

  return createText(`${symbol} Teleported ${shortSessionId}...`, { color });
}

/**
 * Render compact teleport status (for status bar)
 *
 * Returns a styled Text component if session is teleported, null otherwise.
 */
export function renderCompactTeleportStatus(): Text | null {
  const manager = getSessionTeleportManager();
  const info = manager.getTeleportedSessionInfo();

  if (!info?.isTeleported) {
    return null;
  }

  const { color, symbol } = getStatusStyle(info.hasLoggedFirstMessage);
  const shortSessionId = formatShortSessionId(info.sessionId);

  return createText(`${symbol} Teleport ${shortSessionId}`, { color });
}

/**
 * Render teleport info for display
 *
 * Returns a styled Text component with full teleport details,
 * or a message indicating no active teleport.
 */
export function renderTeleportInfo(): Text {
  const manager = getSessionTeleportManager();
  const info = manager.getTeleportedSessionInfo();

  if (!info) {
    return createText("No active teleport", { color: "gray", italic: true });
  }

  const { color } = getStatusStyle(info.hasLoggedFirstMessage);
  const statusText = info.hasLoggedFirstMessage ? "First message logged" : "Awaiting first message";
  const shortSessionId = formatShortSessionId(info.sessionId);
  const teleportTime = info.teleportedAt
    ? new Date(info.teleportedAt).toLocaleTimeString()
    : "Unknown";

  return createText(
    `Teleported: ${shortSessionId}\nTime: ${teleportTime}\nStatus: ${statusText}`,
    { color },
  );
}
