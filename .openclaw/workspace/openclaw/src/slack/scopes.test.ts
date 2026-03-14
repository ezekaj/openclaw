import { describe, expect, it, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import { fetchSlackScopes } from "./scopes.js";

vi.mock("./client.js", () => ({
  createSlackWebClient: vi.fn(() => ({
    apiCall: vi.fn(),
  })),
}));

describe("fetchSlackScopes", () => {
  it("returns error for empty token", async () => {
    const result = await fetchSlackScopes("", 5000);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("token is required");
  });

  it("returns error for whitespace-only token", async () => {
    const result = await fetchSlackScopes("   ", 5000);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("token is required");
  });

  it("returns error for non-positive timeout", async () => {
    const result = await fetchSlackScopes("xoxb-test", 0);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeoutMs must be a positive number");
  });

  it("returns error for negative timeout", async () => {
    const result = await fetchSlackScopes("xoxb-test", -100);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeoutMs must be a positive number");
  });

  it("returns error for NaN timeout", async () => {
    const result = await fetchSlackScopes("xoxb-test", Number.NaN);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeoutMs must be a positive number");
  });

  it("returns error for Infinity timeout", async () => {
    const result = await fetchSlackScopes("xoxb-test", Number.POSITIVE_INFINITY);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeoutMs must be a positive number");
  });
});