import { describe, expect, it } from "vitest";
import { isAuthErrorMessage } from "./pi-embedded-helpers.js";

describe("isAuthErrorMessage", () => {
  it("matches credential validation errors", () => {
    const samples = [
      'No credentials found for profile "anthropic:default".',
      "No API key found for profile openai.",
    ];
    for (const sample of samples) {
      expect(isAuthErrorMessage(sample)).toBe(true);
    }
  });
  it("matches OAuth refresh failures", () => {
    const samples = [
      "OAuth token refresh failed for anthropic: Failed to refresh OAuth token for anthropic. Please try again or re-authenticate.",
      "Please re-authenticate to continue.",
    ];
    for (const sample of samples) {
      expect(isAuthErrorMessage(sample)).toBe(true);
    }
  });
  it("ignores unrelated errors", () => {
    expect(isAuthErrorMessage("rate limit exceeded")).toBe(false);
    expect(isAuthErrorMessage("billing issue detected")).toBe(false);
  });
});
