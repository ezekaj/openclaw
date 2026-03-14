import { beforeEach, describe, expect, it, vi } from "vitest";

describe("telegram audit", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("collects unmentioned numeric group ids and flags wildcard", async () => {
    const { collectTelegramUnmentionedGroupIds } = await import("./audit.js");
    const res = collectTelegramUnmentionedGroupIds({
      "*": { requireMention: false },
      "-1001": { requireMention: false },
      "@group": { requireMention: false },
      "-1002": { requireMention: true },
      "-1003": { requireMention: false, enabled: false },
    });
    expect(res.hasWildcardUnmentionedGroups).toBe(true);
    expect(res.groupIds).toEqual(["-1001"]);
    expect(res.unresolvedGroups).toBe(1);
  });

  it("handles undefined groups in collectTelegramUnmentionedGroupIds", async () => {
    const { collectTelegramUnmentionedGroupIds } = await import("./audit.js");
    const res = collectTelegramUnmentionedGroupIds(undefined);
    expect(res.groupIds).toEqual([]);
    expect(res.unresolvedGroups).toBe(0);
    expect(res.hasWildcardUnmentionedGroups).toBe(false);
  });

  it("handles empty groups object", async () => {
    const { collectTelegramUnmentionedGroupIds } = await import("./audit.js");
    const res = collectTelegramUnmentionedGroupIds({});
    expect(res.groupIds).toEqual([]);
    expect(res.unresolvedGroups).toBe(0);
    expect(res.hasWildcardUnmentionedGroups).toBe(false);
  });

  it("audits membership via getChatMember", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { status: "member" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
    expect(res.groups[0]?.chatId).toBe("-1001");
    expect(res.groups[0]?.status).toBe("member");
  });

  it("reports bot not in group when status is left", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { status: "left" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    expect(res.groups[0]?.ok).toBe(false);
    expect(res.groups[0]?.status).toBe("left");
  });

  it("handles kicked status", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { status: "kicked" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    expect(res.groups[0]?.status).toBe("kicked");
    expect(res.groups[0]?.error).toBe("bot not in group");
  });

  it("handles administrator status", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { status: "administrator" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
    expect(res.groups[0]?.status).toBe("administrator");
  });

  it("handles creator status", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { status: "creator" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
    expect(res.groups[0]?.status).toBe("creator");
  });

  it("handles restricted status (bot is member but restricted)", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { status: "restricted" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    expect(res.groups[0]?.status).toBe("restricted");
    expect(res.groups[0]?.error).toBe("bot not in group");
  });

  it("returns early with empty result for empty groupIds", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: [],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
    expect(res.checkedGroups).toBe(0);
    expect(res.groups).toEqual([]);
  });

  it("returns early with empty result for empty token", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    const res = await auditTelegramGroupMembership({
      token: "",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
    expect(res.checkedGroups).toBe(0);
    expect(res.groups).toEqual([]);
  });

  it("handles invalid JSON response", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response("not valid json", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      ),
    );
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    expect(res.groups[0]?.error).toBe("invalid JSON response (200)");
  });

  it("handles Telegram API error response", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    expect(res.groups[0]?.error).toBe("Bad Request: chat not found");
  });

  it("handles network error", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("network error")),
    );
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    expect(res.groups[0]?.error).toBe("network error");
  });

  it("handles non-Error thrown value", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce("string error"),
    );
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    expect(res.groups[0]?.error).toBe("string error");
  });

  it("handles unknown status value", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { status: "unknown_status" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    expect(res.groups[0]?.status).toBe(null);
    expect(res.groups[0]?.error).toBe("bot not in group");
  });

  it("handles missing status in result", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    expect(res.groups[0]?.status).toBe(null);
  });

  it("handles multiple groups with mixed results", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, result: { status: "member" } }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, result: { status: "left" } }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was blocked by the user" }), {
            status: 403,
          }),
        ),
    );
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: ["-1001", "-1002", "-1003"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    expect(res.checkedGroups).toBe(3);
    expect(res.groups[0]?.ok).toBe(true);
    expect(res.groups[1]?.ok).toBe(false);
    expect(res.groups[2]?.ok).toBe(false);
    expect(res.groups[2]?.error).toBe("Forbidden: bot was blocked by the user");
  });
});
