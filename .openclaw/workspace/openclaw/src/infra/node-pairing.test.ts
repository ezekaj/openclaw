import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  approveNodePairing,
  getPairedNode,
  listNodePairing,
  rejectNodePairing,
  renamePairedNode,
  requestNodePairing,
  updatePairedNodeMetadata,
  verifyNodeToken,
} from "./node-pairing.js";

describe("node pairing", () => {
  test("request and approve node pairing", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));

    // Request pairing
    const request = await requestNodePairing(
      {
        nodeId: "node-1",
        displayName: "Test Node",
        platform: "darwin",
        version: "1.0.0",
      },
      baseDir,
    );
    expect(request.status).toBe("pending");
    expect(request.created).toBe(true);
    expect(request.request.nodeId).toBe("node-1");
    expect(request.request.displayName).toBe("Test Node");
    expect(request.request.platform).toBe("darwin");

    // List should show pending
    const list1 = await listNodePairing(baseDir);
    expect(list1.pending).toHaveLength(1);
    expect(list1.paired).toHaveLength(0);

    // Approve pairing
    const approved = await approveNodePairing(request.request.requestId, baseDir);
    expect(approved).not.toBeNull();
    expect(approved?.node.nodeId).toBe("node-1");
    expect(approved?.node.displayName).toBe("Test Node");
    expect(approved?.node.token).toBeDefined();

    // List should show paired
    const list2 = await listNodePairing(baseDir);
    expect(list2.pending).toHaveLength(0);
    expect(list2.paired).toHaveLength(1);

    // Get paired node
    const paired = await getPairedNode("node-1", baseDir);
    expect(paired).not.toBeNull();
    expect(paired?.nodeId).toBe("node-1");

    // Verify token
    const verification = await verifyNodeToken("node-1", paired!.token, baseDir);
    expect(verification.ok).toBe(true);
    expect(verification.node?.nodeId).toBe("node-1");

    // Wrong token should fail
    const badVerification = await verifyNodeToken("node-1", "wrong-token", baseDir);
    expect(badVerification.ok).toBe(false);
  });

  test("duplicate request returns existing", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));

    const request1 = await requestNodePairing({ nodeId: "node-1" }, baseDir);
    expect(request1.created).toBe(true);

    const request2 = await requestNodePairing({ nodeId: "node-1" }, baseDir);
    expect(request2.created).toBe(false);
    expect(request2.request.requestId).toBe(request1.request.requestId);
  });

  test("reject pairing", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));

    const request = await requestNodePairing({ nodeId: "node-1" }, baseDir);
    const rejected = await rejectNodePairing(request.request.requestId, baseDir);
    expect(rejected).not.toBeNull();
    expect(rejected?.nodeId).toBe("node-1");

    const list = await listNodePairing(baseDir);
    expect(list.pending).toHaveLength(0);
  });

  test("update paired node metadata", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));

    const request = await requestNodePairing({ nodeId: "node-1", version: "1.0.0" }, baseDir);
    await approveNodePairing(request.request.requestId, baseDir);

    await updatePairedNodeMetadata("node-1", { version: "2.0.0", bins: ["node", "npm"] }, baseDir);

    const paired = await getPairedNode("node-1", baseDir);
    expect(paired?.version).toBe("2.0.0");
    expect(paired?.bins).toEqual(["node", "npm"]);
  });

  test("rename paired node", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));

    const request = await requestNodePairing({ nodeId: "node-1", displayName: "Old Name" }, baseDir);
    await approveNodePairing(request.request.requestId, baseDir);

    const renamed = await renamePairedNode("node-1", "New Name", baseDir);
    expect(renamed?.displayName).toBe("New Name");

    const paired = await getPairedNode("node-1", baseDir);
    expect(paired?.displayName).toBe("New Name");
  });

  test("rename with empty name throws", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));

    const request = await requestNodePairing({ nodeId: "node-1" }, baseDir);
    await approveNodePairing(request.request.requestId, baseDir);

    await expect(renamePairedNode("node-1", "   ", baseDir)).rejects.toThrow("displayName required");
  });

  test("isRepair flag set when re-pairing existing node", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));

    // First pairing
    const request1 = await requestNodePairing({ nodeId: "node-1" }, baseDir);
    expect(request1.request.isRepair).toBe(false);
    await approveNodePairing(request1.request.requestId, baseDir);

    // Second pairing (repair)
    const request2 = await requestNodePairing({ nodeId: "node-1" }, baseDir);
    expect(request2.request.isRepair).toBe(true);
  });

  test("approve non-existent request returns null", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));
    const result = await approveNodePairing("non-existent-id", baseDir);
    expect(result).toBeNull();
  });

  test("reject non-existent request returns null", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));
    const result = await rejectNodePairing("non-existent-id", baseDir);
    expect(result).toBeNull();
  });

  test("get non-existent node returns null", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));
    const result = await getPairedNode("non-existent-node", baseDir);
    expect(result).toBeNull();
  });

  test("verify token for non-existent node returns not ok", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));
    const result = await verifyNodeToken("non-existent-node", "token", baseDir);
    expect(result.ok).toBe(false);
  });

  test("update metadata for non-existent node does nothing", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));
    // Should not throw
    await updatePairedNodeMetadata("non-existent-node", { version: "2.0.0" }, baseDir);
  });

  test("rename non-existent node returns null", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));
    const result = await renamePairedNode("non-existent-node", "New Name", baseDir);
    expect(result).toBeNull();
  });
});
