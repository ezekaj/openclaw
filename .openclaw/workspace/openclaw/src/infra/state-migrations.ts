import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { SessionScope } from "../config/sessions/types.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  resolveLegacyStateDirs,
  resolveNewStateDir,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/paths.js";
import { saveSessionStore } from "../config/sessions.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
} from "../routing/session-key.js";
import {
  ensureDir,
  existsDir,
  fileExists,
  isLegacyWhatsAppAuthFile,
  readSessionStoreJson5,
  type SessionEntryLike,
  safeReadDir,
} from "./state-migrations.fs.js";