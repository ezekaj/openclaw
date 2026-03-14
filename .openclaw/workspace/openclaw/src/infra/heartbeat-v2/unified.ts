import * as path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type { SchedulerConfig, HeartbeatAnalytics, HeartbeatState } from "./types.js";
import { resolveDefaultAgentId, resolveAgentConfig } from "../../agents/agent-scope.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runHeartbeatOnce } from "../heartbeat-runner.js";
import { resolveHeartbeatVisibility } from "../heartbeat-visibility.js";
import {
  HeartbeatScheduler,
  type HeartbeatSchedulerOptions,
  type HeartbeatExecutionHandler,
  getHeartbeatScheduler,
  setHeartbeatScheduler,
} from "./scheduler.js";
import { HeartbeatStateManager } from "./state-manager.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./types.js";

// Helper function to normalize agent IDs
function normalizeAgentId(agentId?: string): string {
  return (agentId?.trim().toLowerCase() ?? "default");
}

const log = createSubsystemLogger("heartbeat-v2/unified");