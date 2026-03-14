import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_BOOTSTRAP_MAX_CHARS, resolveBootstrapMaxChars } from "./pi-embedded-helpers.js";

describe("resolveBootstrapMaxChars", () => {
  it("returns default when unset", () => {
    expect(resolveBootstrapMaxChars()).toBe(DEFAULT_BOOTSTRAP_MAX_CHARS);
  });
  it("uses configured value when valid", () => {
    const cfg = {
      agents: { defaults: { bootstrapMaxChars: 12345 } },
    } as OpenClawConfig;
    expect(resolveBootstrapMaxChars(cfg)).toBe(12345);
  });
  it("falls back when invalid", () => {
    const cfg = {
      agents: { defaults: { bootstrapMaxChars: -1 } },
    } as OpenClawConfig;
    expect(resolveBootstrapMaxChars(cfg)).toBe(DEFAULT_BOOTSTRAP_MAX_CHARS);
  });
});
