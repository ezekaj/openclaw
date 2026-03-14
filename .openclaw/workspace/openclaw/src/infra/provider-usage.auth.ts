import fs from "node:fs";
import os from "node:os";
import type { UsageProviderId } from "./provider-usage.types.js";
import {
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "../agents/auth-profiles.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../agents/model-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { loadConfig } from "../config/config.js";

export type ProviderAuth = {
  provider: UsageProviderId;
  token: string;
  accountId?: string;
};

function parseGoogleToken(apiKey: string): { token: string } | null {
  if (!apiKey) {
    return null;
  }
  try {
    const parsed = JSON.parse(apiKey) as { token?: unknown };
    if (parsed && typeof parsed.token === "string") {
      return { token: parsed.token };
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveApiKeyFromMultipleSources(
  provider: string,
  envKeys: string[],
  customProviderKeys: string[]
): string | undefined {
  // Try direct environment variables
  for (const key of envKeys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }

  // Try resolved environment API key
  const envResolved = resolveEnvApiKey(provider);
  if (envResolved?.apiKey) return envResolved.apiKey;

  // Try custom provider keys from config
  const cfg = loadConfig();
  for (const keyName of customProviderKeys) {
    const key = getCustomProviderApiKey(cfg, keyName);
    if (key) return key;
  }

  // Try auth profile store
  const store = ensureAuthProfileStore();
  const apiProfile = listProfilesForProvider(store, provider).find((id) => {
    const cred = store.profiles[id];
    return cred?.type === "api_key" || cred?.type === "token";
  });
  if (apiProfile) {
    const cred = store.profiles[apiProfile];
    if (cred?.type === "api_key" && cred.key?.trim()) {
      return cred.key.trim();
    }
    if (cred?.type === "token" && cred.token?.trim()) {
      return cred.token.trim();
    }
  }

  // Fallback to auth.json file
  try {
    const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
    if (fs.existsSync(authPath)) {
      const data = JSON.parse(fs.readFileSync(authPath, "utf-8")) as Record<string, { access?: string }>;
      const normalizedProvider = provider === "zai" ? "z-ai" : provider;
      return data[normalizedProvider]?.access || data[provider]?.access;
    }
  } catch {
    // ignore
  }

  return undefined;
}

function resolveZaiApiKey(): string | undefined {
  return resolveApiKeyFromMultipleSources("zai", ["ZAI_API_KEY", "Z_AI_API_KEY"], ["zai", "z-ai"]);
}

function resolveMinimaxApiKey(): string | undefined {
  return resolveApiKeyFromMultipleSources("minimax", ["MINIMAX_CODE_PLAN_KEY", "MINIMAX_API_KEY"], ["minimax"]);
}

function resolveXiaomiApiKey(): string | undefined {
  return resolveApiKeyFromMultipleSources("xiaomi", ["XIAOMI_API_KEY"], ["xiaomi"]);
}