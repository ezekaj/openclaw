import type { WebClient } from "@slack/web-api";
import { createSlackWebClient } from "./client.js";

export type SlackScopesResult = {
  ok: boolean;
  scopes?: string[];
  source?: string;
  error?: string;
};

type SlackScopesSource = "auth.scopes" | "apps.permissions.info";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function collectScopes(value: unknown, into: string[]): void {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) {
        into.push(entry.trim());
      }
    }
    return;
  }
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) {
      return;
    }
    const parts = raw.split(/[,\s]+/).map((part) => part.trim());
    for (const part of parts) {
      if (part) {
        into.push(part);
      }
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const entry of Object.values(value)) {
    if (Array.isArray(entry) || typeof entry === "string") {
      collectScopes(entry, into);
    }
  }
}

function normalizeScopes(scopes: string[]): string[] {
  return Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean))).sort();
}

function extractScopes(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }
  const scopes: string[] = [];
  collectScopes(payload.scopes, scopes);
  collectScopes(payload.scope, scopes);
  if (isRecord(payload.info)) {
    collectScopes(payload.info.scopes, scopes);
    collectScopes(payload.info.scope, scopes);
    collectScopes((payload.info as { user_scopes?: unknown }).user_scopes, scopes);
    collectScopes((payload.info as { bot_scopes?: unknown }).bot_scopes, scopes);
  }
  return normalizeScopes(scopes);
}

function readError(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const error = payload.error;
  return typeof error === "string" && error.trim() ? error.trim() : undefined;
}

type SlackApiResult = 
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

async function callSlack(
  client: WebClient,
  method: SlackScopesSource,
): Promise<SlackApiResult> {
  try {
    const result = await client.apiCall(method);
    if (isRecord(result)) {
      return { ok: true, payload: result };
    }
    return { ok: false, error: "invalid response" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchSlackScopes(
  token: string,
  timeoutMs: number,
): Promise<SlackScopesResult> {
  if (!token || typeof token !== "string" || !token.trim()) {
    return { ok: false, error: "token is required" };
  }
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { ok: false, error: "timeoutMs must be a positive number" };
  }

  const client = createSlackWebClient(token, { timeout: timeoutMs });
  const attempts: SlackScopesSource[] = ["auth.scopes", "apps.permissions.info"];
  const errors: string[] = [];

  for (const method of attempts) {
    const result = await callSlack(client, method);
    if (result.ok) {
      const scopes = extractScopes(result.payload);
      if (scopes.length > 0) {
        return { ok: true, scopes, source: method };
      }
      const error = readError(result.payload);
      if (error) {
        errors.push(`${method}: ${error}`);
      }
    } else {
      errors.push(`${method}: ${result.error}`);
    }
  }

  return {
    ok: false,
    error: errors.length > 0 ? errors.join(" | ") : "no scopes returned",
  };
}
