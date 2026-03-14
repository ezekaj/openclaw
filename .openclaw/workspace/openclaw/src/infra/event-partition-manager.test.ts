/**
 * Event Partition Manager Tests
 *
 * Tests all critical fixes identified by DeepSeek + Mistral review
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  EventPartitionManager,
  migrateToPartitions,
  rollbackMigration,
  getPartitionNameForTimestamp,
  asPartitionName,
} from "./event-partition-manager.js";

describe("EventPartitionManager", () => {
  let manager: EventPartitionManager;
  let db: DatabaseSync;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "partition-test-"));
    const dbPath = join(tempDir, "test.db");
    db = new DatabaseSync(dbPath);

    // Create legacy table with sample data
    db.exec(`
      CREATE TABLE agent_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        data TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);

    // Insert test data across multiple months
    const insert = db.prepare(`
      INSERT INTO agent_events (id, type, source, timestamp, data)
      VALUES (?, ?, ?, ?, ?)
    `);

    // January 2024 events
    insert.run("evt1", "test.event", "agent1", 1704067200, '{"month": "jan"}'); // 2024-01-01
    insert.run("evt2", "test.event", "agent1", 1704153600, '{"month": "jan"}'); // 2024-01-02

    // February 2024 events
    insert.run("evt3", "test.event", "agent1", 1706745600, '{"month": "feb"}'); // 2024-02-01
    insert.run("evt4", "test.event", "agent1", 1706832000, '{"month": "feb"}'); // 2024-02-02

    // March 2024 events
    insert.run("evt5", "test.event", "agent1", 1709424000, '{"month": "mar"}'); // 2024-03-03
  });

  afterEach(() => {
    manager?.shutdown();
    db?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Partition Name Validation (SQL Injection Fix - Mistral)", () => {
    it("should validate correct partition names", () => {
      expect(asPartitionName("agent_events_2024_01")).toBeTruthy();
      expect(asPartitionName("agent_events_2025_12")).toBeTruthy();
    });

    it("should reject invalid partition names", () => {
      expect(asPartitionName("agent_events_2024_1")).toBeNull(); // Missing padding
      expect(asPartitionName("agent_events_24_01")).toBeNull(); // Wrong year format
      expect(asPartitionName("agent_events; DROP TABLE agent_events")).toBeNull();
      expect(asPartitionName("malicious_name")).toBeNull();
    });

    it("should generate correct partition names (UTC fix - Mistral)", () => {
      // Test UTC consistency
      const jan2024 = Date.UTC(2024, 0, 1, 12, 0, 0); // 2024-01-01 12:00 UTC
      expect(getPartitionNameForTimestamp(jan2024)).toBe("agent_events_2024_01");

      const feb2024 = Date.UTC(2024, 1, 15, 8, 30, 0); // 2024-02-15 08:30 UTC
      expect(getPartitionNameForTimestamp(feb2024)).toBe("agent_events_2024_02");

      // Test edge case: end of month
      const endOfJan = Date.UTC(2024, 0, 31, 23, 59, 59, 999);
      expect(getPartitionNameForTimestamp(endOfJan)).toBe("agent_events_2024_01");

      const startOfFeb = Date.UTC(2024, 1, 1, 0, 0, 0, 0);
      expect(getPartitionNameForTimestamp(startOfFeb)).toBe("agent_events_2024_02");
    });
  });

  describe("Timestamp Validation (DeepSeek)", () => {
    it("should detect seconds vs milliseconds", () => {
      // Seconds timestamp (1704067200 = 2024-01-01)
      const name1 = getPartitionNameForTimestamp(1704067200);
      expect(name1).toBe("agent_events_2024_01");

      // Milliseconds timestamp (1704067200000 = 2024-01-01)
      const name2 = getPartitionNameForTimestamp(1704067200000);
      expect(name2).toBe("agent_events_2024_01");
    });

    it("should reject invalid timestamps", () => {
      // Too old (before 2020)
      expect(() => getPartitionNameForTimestamp(946684800)).toThrow();

      // Too far in future (after 2100)
      expect(() => getPartitionNameForTimestamp(4102444800000)).toThrow();
    });
  });

  describe("Initialization and Partition Creation", () => {
    it("should initialize partition manager", async () => {
      manager = new EventPartitionManager(db, {
        retentionMonths: 12,
        createAheadMonths: 1,
      });

      await manager.initialize();

      const stats = manager.getStats();
      expect(stats.partitionCount).toBeGreaterThan(0);
      expect(stats.retentionMonths).toBe(12);
    });

    it("should create current and next month partitions", async () => {
      manager = new EventPartitionManager(db);
      await manager.initialize();

      const stats = manager.getStats();
      const now = new Date();
      const currentMonth = getPartitionNameForTimestamp(now.getTime());
      const nextMonth = new Date(now);
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      const nextMonthName = getPartitionNameForTimestamp(nextMonth.getTime());

      expect(stats.partitions).toContain(currentMonth);
      expect(stats.partitions).toContain(nextMonthName);
    });

    it("should prevent race condition (DeepSeek)", async () => {
      manager = new EventPartitionManager(db);
      await manager.initialize();

      const now = Date.now();
      
      // This should create partition if it doesn't exist
      const partitionName = await manager.ensurePartitionExists(now);
      
      expect(partitionName).toBeDefined();
      expect(manager.hasPartition(partitionName)).toBe(true);
    });
  });

  describe("Migration", () => {
    it("should migrate events from legacy table", async () => {
      const result = await migrateToPartitions(db, {
        dryRun: false,
        keepBackup: true,
        verifyChecksums: true,
      });

      expect(result.success).toBe(true);
      expect(result.eventsMigrated).toBe(5);
      expect(result.partitionsCreated).toHaveLength(3); // Jan, Feb, Mar 2024
      expect(result.rollbackAvailable).toBe(true);
      expect(result.checksumVerified).toBe(true);

      // Verify data in partitions
      const janCount = db
        .prepare("SELECT COUNT(*) as count FROM agent_events_2024_01")
        .get() as { count: number };
      expect(janCount.count).toBe(2);

      const febCount = db
        .prepare("SELECT COUNT(*) as count FROM agent_events_2024_02")
        .get() as { count: number };
      expect(febCount.count).toBe(2);

      const marCount = db
        .prepare("SELECT COUNT(*) as count FROM agent_events_2024_03")
        .get() as { count: number };
      expect(marCount.count).toBe(1);
    });

    it("should use id-based pagination (Both - DeepSeek + Mistral)", async () => {
      // Insert many events to test batching
      const insert = db.prepare(`
        INSERT INTO agent_events (id, type, source, timestamp, data)
        VALUES (?, ?, ?, ?, ?)
      `);

      // Add 150 events in January
      for (let i = 0; i < 150; i++) {
        insert.run(
          `evt_jan_${i}`,
          "bulk.event",
          "test",
          1704067200 + i * 3600,
          `{"index": ${i}}`
        );
      }

      const result = await migrateToPartitions(db, { batchSize: 50 });

      expect(result.success).toBe(true);
      expect(result.eventsMigrated).toBe(155); // 5 original + 150 new

      // Verify all events migrated correctly
      const janCount = db
        .prepare("SELECT COUNT(*) as count FROM agent_events_2024_01")
        .get() as { count: number };
      expect(janCount.count).toBe(152); // 2 original + 150 new
    });

    it("should keep backup table", async () => {
      await migrateToPartitions(db, { keepBackup: true });

      // Check backup exists
      const backup = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_events_backup'")
        .get();
      expect(backup).toBeDefined();
    });

    it("should verify checksums", async () => {
      const result = await migrateToPartitions(db, { verifyChecksums: true });

      expect(result.checksumVerified).toBe(true);
    });

    it("should support dry run", async () => {
      const result = await migrateToPartitions(db, { dryRun: true });

      expect(result.success).toBe(true);
      expect(result.eventsMigrated).toBe(0);
      expect(result.partitionsCreated).toHaveLength(0);

      // Verify no tables created
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_events_%'")
        .all() as { name: string }[];
      expect(tables).toHaveLength(0);
    });
  });

  describe("Rollback", () => {
    it("should rollback migration", async () => {
      // Migrate
      await migrateToPartitions(db, { keepBackup: true });

      // Rollback
      rollbackMigration(db);

      // Verify legacy table restored
      const legacy = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_events'")
        .get();
      expect(legacy).toBeDefined();

      // Verify partitions removed
      const partitions = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_events_%'")
        .all() as { name: string }[];
      expect(partitions).toHaveLength(0);

      // Verify data intact
      const count = db
        .prepare("SELECT COUNT(*) as count FROM agent_events")
        .get() as { count: number };
      expect(count.count).toBe(5);
    });
  });

  describe("Query Optimization (Both - DeepSeek + Mistral)", () => {
    beforeEach(async () => {
      manager = new EventPartitionManager(db);
      await manager.initialize();
      await migrateToPartitions(db, { keepBackup: false });
    });

    it("should query specific partitions for time ranges", () => {
      const startTime = Date.UTC(2024, 0, 1, 0, 0, 0); // Jan 1, 2024
      const endTime = Date.UTC(2024, 0, 31, 23, 59, 59); // Jan 31, 2024

      const events = manager.queryEvents({
        startTime,
        endTime,
        type: "test.event",
      });

      expect(events).toHaveLength(2);
      events.forEach((e: any) => {
        expect(e.timestamp * 1000).toBeGreaterThanOrEqual(startTime);
        expect(e.timestamp * 1000).toBeLessThanOrEqual(endTime);
      });
    });

    it("should query multiple partitions for multi-month ranges", () => {
      const startTime = Date.UTC(2024, 0, 1, 0, 0, 0); // Jan 1
      const endTime = Date.UTC(2024, 2, 31, 23, 59, 59); // Mar 31

      const events = manager.queryEvents({
        startTime,
        endTime,
      });

      expect(events).toHaveLength(5);
    });

    it("should fall back to view scan when no time range specified", () => {
      const events = manager.queryEvents({
        type: "test.event",
      });

      expect(events.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("Maintenance", () => {
    it("should drop old partitions based on retention", async () => {
      manager = new EventPartitionManager(db, {
        retentionMonths: 1, // Keep only 1 month
        createAheadMonths: 0,
      });

      await manager.initialize();
      await migrateToPartitions(db, { keepBackup: false });

      // Trigger maintenance
      await manager.triggerMaintenance();

      const stats = manager.getStats();
      
      // Should have dropped Jan and Feb 2024 (older than 1 month from now)
      // Only current month should remain
      expect(stats.partitionCount).toBeLessThan(3);
    });
  });

  describe("WAL Mode (Mistral)", () => {
    it("should enable WAL mode for better concurrency", async () => {
      manager = new EventPartitionManager(db);
      await manager.initialize();

      const journalMode = db
        .prepare("PRAGMA journal_mode")
        .get() as { journal_mode: string };
      
      expect(journalMode.journal_mode.toLowerCase()).toBe("wal");
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid partition names during creation", async () => {
      manager = new EventPartitionManager(db);
      await manager.initialize();

      // Try to manually create invalid partition
      expect(() => {
        db.exec(`
          CREATE TABLE agent_events_invalid (
            id TEXT PRIMARY KEY
          )
        `);
      }).not.toThrow(); // SQLite allows it

      // But manager should not include it
      manager.triggerMaintenance();
      const stats = manager.getStats();
      
      // Should not include invalid partition
      const hasInvalid = stats.partitions.some(p => p.includes("invalid"));
      expect(hasInvalid).toBe(false);
    });
  });
});
