/**
 * Cache Status Component for TUI
 *
 * Displays cache metrics in the TUI interface.
 */

import { Box, Text } from "@mariozechner/pi-tui";
import { createText, createBox } from "./component-helpers.js";
import { getCacheMetricsTracker } from "../../agents/cache-metrics-tracker.js";
import type { CacheMetrics } from "../../config/types.cache.js";

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Get color for hit rate display
 * @param hitRate - Hit rate (0.0 - 1.0)
 * @returns ANSI color name
 */
function getHitRateColor(hitRate: number): "green" | "yellow" | "red" {
  if (hitRate > 0.8) return "green";
  if (hitRate > 0.5) return "yellow";
  return "red";
}

/**
 * Get status symbol for hit rate
 * @param hitRate - Hit rate (0.0 - 1.0)
 * @returns Status symbol
 */
function getHitRateSymbol(hitRate: number): string {
  if (hitRate > 0.8) return "✓";
  if (hitRate > 0.5) return "~";
  return "✗";
}

/**
 * Format hit rate as percentage string
 * @param hitRate - Hit rate (0.0 - 1.0)
 * @param decimals - Number of decimal places
 * @returns Formatted percentage string
 */
function formatHitRate(hitRate: number, decimals = 0): string {
  const clampedRate = Math.max(0, Math.min(1, hitRate));
  return (clampedRate * 100).toFixed(decimals);
}

// ============================================================================
// CACHE STATUS COMPONENT
// ============================================================================

/**
 * Render cache status display
 *
 * Creates a boxed display showing cache performance metrics including
 * hit rate, token counts, and estimated cost savings.
 */
export function renderCacheStatus(): Box {
  const tracker = getCacheMetricsTracker();
  const metrics: CacheMetrics = tracker.getMetrics();

  const hitRateColor = getHitRateColor(metrics.hitRate);

  return createBox({
    children: [
      createText("Cache Status", {
        bold: true,
        color: "cyan",
      }),
      createText("\n"),
      createText(`Hit Rate: ${formatHitRate(metrics.hitRate, 1)}%`, {
        color: hitRateColor,
      }),
      createText("\n"),
      createText(`Read: ${metrics.cacheReadTokens.toLocaleString()} tokens`, {
        color: "gray",
      }),
      createText("\n"),
      createText(`Creation: ${metrics.cacheCreationTokens.toLocaleString()} tokens`, {
        color: "gray",
      }),
      createText("\n"),
      createText(`Input: ${metrics.inputTokens.toLocaleString()} tokens`, {
        color: "gray",
      }),
      createText("\n"),
      createText(`Savings: $${metrics.estimatedSavings.toFixed(4)}`, {
        color: "green",
      }),
    ],
    border: {
      type: "rounded",
      color: "cyan",
    },
    padding: 1,
    margin: { top: 1, bottom: 0 },
  });
}

/**
 * Render compact cache status (single line)
 *
 * Creates a single-line display showing cache hit rate and savings.
 */
export function renderCompactCacheStatus(): Text {
  const tracker = getCacheMetricsTracker();
  const metrics: CacheMetrics = tracker.getMetrics();

  const hitRateColor = getHitRateColor(metrics.hitRate);

  return createText(
    `Cache: ${formatHitRate(metrics.hitRate)}% | $${metrics.estimatedSavings.toFixed(3)}`,
    { color: hitRateColor },
  );
}

/**
 * Render cache summary for status bar
 *
 * Creates a compact status indicator with symbol and percentage.
 */
export function renderCacheStatusBar(): Text {
  const tracker = getCacheMetricsTracker();
  const metrics: CacheMetrics = tracker.getMetrics();

  const status = getHitRateSymbol(metrics.hitRate);
  const color = getHitRateColor(metrics.hitRate);

  return createText(`${status} Cache ${formatHitRate(metrics.hitRate)}%`, {
    color,
  });
}