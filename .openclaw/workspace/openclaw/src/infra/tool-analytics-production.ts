import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type {
  AnalyticsConfig,
  AnalyticsBackend,
  ToolExecutionRecord,
  ToolInsights,
  ToolRecommendation,
  TimeRange,
  ToolContext,
} from "./tool-analytics-types.js";