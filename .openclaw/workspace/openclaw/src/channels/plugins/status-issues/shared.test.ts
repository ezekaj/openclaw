import { describe, expect, it } from "vitest";
import { asString, appendMatchMetadata, formatMatchMetadata } from "./shared.js";

describe("asString", () => {
  it("returns trimmed string for valid strings", () => {
    expect(asString("hello")).toBe("hello");
    expect(asString("  hello  ")).toBe("hello");
  });

  it("returns undefined for empty or whitespace-only strings", () => {
    expect(asString("")).toBeUndefined();
    expect(asString("   ")).toBeUndefined();
    expect(asString("\t\n")).toBeUndefined();
  });

  it("returns undefined for non-strings", () => {
    expect(asString(123)).toBeUndefined();
    expect(asString(true)).toBeUndefined();
    expect(asString(null)).toBeUndefined();
    expect(asString(undefined)).toBeUndefined();
    expect(asString({})).toBeUndefined();
    expect(asString([])).toBeUndefined();
  });
});

describe("formatMatchMetadata", () => {
  describe("matchKey", () => {
    it("formats string matchKey", () => {
      expect(formatMatchMetadata({ matchKey: "user-123" })).toBe("matchKey=user-123");
    });

    it("trims whitespace from string matchKey", () => {
      expect(formatMatchMetadata({ matchKey: "  user-123  " })).toBe("matchKey=user-123");
    });

    it("rejects empty string matchKey", () => {
      expect(formatMatchMetadata({ matchKey: "" })).toBeUndefined();
      expect(formatMatchMetadata({ matchKey: "   " })).toBeUndefined();
    });

    it("formats numeric matchKey", () => {
      expect(formatMatchMetadata({ matchKey: 123 })).toBe("matchKey=123");
      expect(formatMatchMetadata({ matchKey: 0 })).toBe("matchKey=0");
      expect(formatMatchMetadata({ matchKey: -456 })).toBe("matchKey=-456");
      expect(formatMatchMetadata({ matchKey: 3.14 })).toBe("matchKey=3.14");
    });

    it("rejects NaN and Infinity for matchKey", () => {
      expect(formatMatchMetadata({ matchKey: NaN })).toBeUndefined();
      expect(formatMatchMetadata({ matchKey: Infinity })).toBeUndefined();
      expect(formatMatchMetadata({ matchKey: -Infinity })).toBeUndefined();
    });

    it("rejects non-string/non-number matchKey", () => {
      expect(formatMatchMetadata({ matchKey: true })).toBeUndefined();
      expect(formatMatchMetadata({ matchKey: {} })).toBeUndefined();
      expect(formatMatchMetadata({ matchKey: [] })).toBeUndefined();
    });
  });

  describe("matchSource", () => {
    it("formats string matchSource", () => {
      expect(formatMatchMetadata({ matchSource: "config" })).toBe("matchSource=config");
    });

    it("trims whitespace from string matchSource", () => {
      expect(formatMatchMetadata({ matchSource: "  config  " })).toBe("matchSource=config");
    });

    it("rejects empty string matchSource", () => {
      expect(formatMatchMetadata({ matchSource: "" })).toBeUndefined();
      expect(formatMatchMetadata({ matchSource: "   " })).toBeUndefined();
    });

    it("rejects non-string matchSource", () => {
      expect(formatMatchMetadata({ matchSource: 123 })).toBeUndefined();
      expect(formatMatchMetadata({ matchSource: true })).toBeUndefined();
    });
  });

  describe("combined", () => {
    it("formats both matchKey and matchSource", () => {
      expect(formatMatchMetadata({ matchKey: "user-123", matchSource: "config" })).toBe(
        "matchKey=user-123 matchSource=config",
      );
    });

    it("formats numeric matchKey with string matchSource", () => {
      expect(formatMatchMetadata({ matchKey: 123, matchSource: "db" })).toBe(
        "matchKey=123 matchSource=db",
      );
    });

    it("returns undefined when both are empty", () => {
      expect(formatMatchMetadata({})).toBeUndefined();
      expect(formatMatchMetadata({ matchKey: "", matchSource: "" })).toBeUndefined();
      expect(formatMatchMetadata({ matchKey: NaN, matchSource: "" })).toBeUndefined();
    });

    it("ignores invalid matchKey when matchSource is valid", () => {
      expect(formatMatchMetadata({ matchKey: NaN, matchSource: "config" })).toBe(
        "matchSource=config",
      );
    });

    it("ignores invalid matchSource when matchKey is valid", () => {
      expect(formatMatchMetadata({ matchKey: 123, matchSource: 456 })).toBe("matchKey=123");
    });
  });
});

describe("appendMatchMetadata", () => {
  it("appends metadata to message", () => {
    expect(appendMatchMetadata("Error occurred", { matchKey: "user-123" })).toBe(
      "Error occurred (matchKey=user-123)",
    );
  });

  it("appends both matchKey and matchSource", () => {
    expect(
      appendMatchMetadata("Error occurred", { matchKey: "user-123", matchSource: "config" }),
    ).toBe("Error occurred (matchKey=user-123 matchSource=config)");
  });

  it("returns message unchanged when no metadata", () => {
    expect(appendMatchMetadata("Error occurred", {})).toBe("Error occurred");
    expect(appendMatchMetadata("Error occurred", { matchKey: "", matchSource: "" })).toBe(
      "Error occurred",
    );
  });

  it("handles numeric matchKey", () => {
    expect(appendMatchMetadata("Error occurred", { matchKey: 123 })).toBe(
      "Error occurred (matchKey=123)",
    );
  });
});