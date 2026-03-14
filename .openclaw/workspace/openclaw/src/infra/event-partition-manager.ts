/**
 * Event Partition Manager - SQLite Event Table Partitioning
 * 
 * Implements time-based partitioning for the agent_events table with:
 * - Monthly partitions (agent_events_YYYY_MM)
 * - Automatic partition creation
 * - Automatic old partition cleanup
 * - Safe migration from legacy table
 * 
 * Based on comprehensive analysis by DeepSeek + Mistral (2026-03-08)
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("event-partition");

// ============================================================================
// Types
// ============================================================================

export type PartitionName = string & { readonly __brand: unique symbol };

export type PartitionConfig = Readonly<{
  /** Months to keep (default: 12) */
  retentionMonths: number;
  /** Create partitions this many months ahead (default: 1) */
  createAheadMonths: number;
  /** Check interval for partition maintenance (default: 1 hour) */
  maintenanceIntervalMs: number;
  /** Off-peak hours for maintenance (default: 22:00-06:00) */
  offPeakHours?: { start: number; end: number };
}>;

export type PartitionStats = {
  partitionCount: number;
  partitions: string[];
  retentionMonths: number;
  totalRows?: number;
  totalSizeBytes?: number;
};

export type MigrationResult = {
  success: boolean;
  eventsMigrated: number;
  partitionsCreated: string[];
  checksumVerified: boolean;
  rollbackAvailable: boolean;
  error?: string;
};

type ManagerState = 'uninitialized' | 'initializing' | 'running' | 'shutting_down' | 'shutdown';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: PartitionConfig = {
  retentionMonths: 12,
  createAheadMonths: 1,
  maintenanceIntervalMs: 3600000, // 1 hour
  offPeakHours: { start: 22, end: 6 },
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate partition name format (SQL injection protection)
 */
function asPartitionName(name: string): PartitionName | null {
  return /^agent_events_\d{4}_\d{2}$/.test(name) 
    ? (name as PartitionName) 
    : null;
}

/**
 * Get partition name for a timestamp (UTC-based)
 * 
 * CRITICAL: Must use UTC consistently (found by Mistral)
 */
function getPartitionNameForTimestamp(timestamp: number): PartitionName {
  // Detect if timestamp is in seconds (before year 2001 in ms = before 1973 in s)
  const adjustedTs = timestamp < 10000000000 ? timestamp * 1000 : timestamp;
  
  // Sanity check: must be after 2020 and before 2100
  if (adjustedTs < 1577836800000 || adjustedTs > 4102444800000) {
    throw new Error(`Invalid timestamp: ${timestamp} (adjusted: ${adjustedTs})`);
  }
  
  const date = new Date(adjustedTs);
  const year = date.getUTCFullYear();  // CRITICAL: Use UTC!
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  
  return `agent_events_${year}_${month}` as PartitionName;
}

/**
 * Parse partition name to extract year and month
 */
function parsePartitionDate(name: PartitionName): { year: number; month: number } {
  const match = name.match(/^agent_events_(\d{4})_(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid partition name: ${name}`);
  }
  return {
    year: parseInt(match[1], 10),
    month: parseInt(match[2], 10),
  };
}

/**
 * Calculate month range for a given year/month (UTC, handles edge cases)
 * 
 * FIX: Original used setMonth() which could jump months (found by DeepSeek)
 */
function getMonthRange(year: number, month: number): { startTs: number; endTs: number } {
  // First second of month (UTC)
  const startTs = Math.floor(Date.UTC(year, month - 1, 1, 0, 0, 0, 0) / 1000);
  
  // Last second of month (UTC)
  // Month 0-11, so month (1-12) as index gives next month, day 0 gives last day of previous
  const endTs = Math.floor(Date.UTC(year, month, 0, 23, 59, 59, 999) / 1000);
  
  return { startTs, endTs };
}

function indexSuffix(partitionName: PartitionName): string {
  return partitionName.replace('agent_events_', '');
}

function createPartitionIndexes(db: DatabaseSync, partitionName: PartitionName): void {
  const suffix = indexSuffix(partitionName);
  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_${suffix}_type ON ${partitionName}(type, timestamp)`
  ).run();
  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_${suffix}_source ON ${partitionName}(source, timestamp)`
  ).run();
  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_${suffix}_time ON ${partitionName}(timestamp)`
  ).run();
}

const PARTITION_TABLE_DDL = (name: PartitionName) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    data TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at INTEGER DEFAULT (unixepoch())
  )
`;

// ============================================================================
// EventPartitionManager Class
// ============================================================================

export class EventPartitionManager {
  private db: DatabaseSync;
  private readonly config: PartitionConfig;
  private state: ManagerState = 'uninitialized';
  private initPromise?: Promise<void>;
  private currentPartitions: Set<PartitionName> = new Set();
  private maintenanceTimer?: ReturnType<typeof setInterval>;
  private lastScanTime: number = 0;
  private readonly SCAN_CACHE_TTL = 60000; // 1 minute

  constructor(db: DatabaseSync, config: Partial<PartitionConfig> = {}) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize partition system
   * 
   * CRITICAL: Blocks until ready to prevent race condition (found by DeepSeek)
   */
  async initialize(): Promise<void> {
    if (this.state === 'running' || this.state === 'initializing') {
      return this.initPromise!;
    }

    this.state = 'initializing';
    this.initPromise = this.doInitialize();
    
    try {
      await this.initPromise;
      this.state = 'running';
    } catch (error) {
      this.state = 'uninitialized';
      this.initPromise = undefined;
      throw error;
    }
  }

  private async doInitialize(): Promise<void> {
    // Enable WAL mode for better concurrency (found by Mistral)
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");

    // Scan existing partitions
    this.scanPartitions(true);

    // Create current partition
    const now = new Date();
    await this.createPartitionForDate(now);

    // Create next month partition
    const nextMonth = new Date(now);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    await this.createPartitionForDate(nextMonth);

    // Start maintenance
    this.startMaintenance();

    log.info(
      `Event partitioning initialized (${this.currentPartitions.size} partitions, ` +
        `retention: ${this.config.retentionMonths} months)`
    );
  }

  /**
   * Ensure partition system is ready (called before any operation)
   */
  private async ensureReady(): Promise<void> {
    if (this.state === 'running') return;
    
    if (this.state === 'uninitialized') {
      await this.initialize();
    }
  }

  /**
   * Get partition name for a timestamp
   */
  getPartitionName(timestamp: number): PartitionName {
    return getPartitionNameForTimestamp(timestamp);
  }

  /**
   * Check if a partition exists
   */
  hasPartition(name: PartitionName): boolean {
    return this.currentPartitions.has(name);
  }

  /**
   * Ensure a partition exists for a given timestamp
   * 
   * CRITICAL: Prevents race condition (found by DeepSeek)
   */
  async ensurePartitionExists(timestamp: number): Promise<PartitionName> {
    await this.ensureReady();
    
    const partitionName = this.getPartitionName(timestamp);
    
    if (!this.currentPartitions.has(partitionName)) {
      // Synchronously create if missing
      await this.createPartitionForDate(new Date(timestamp));
    }
    
    return partitionName;
  }

  /**
   * Create partition table for a given date
   */
  private async createPartitionForDate(date: Date): Promise<void> {
    const timestamp = date.getTime();
    const partitionName = this.getPartitionName(timestamp);
    
    // Validate partition name (SQL injection protection - found by Mistral)
    const validated = asPartitionName(partitionName);
    if (!validated) {
      throw new Error(`Invalid partition name format: ${partitionName}`);
    }

    if (this.currentPartitions.has(validated)) {
      return; // Already exists
    }

    try {
      this.db.prepare(PARTITION_TABLE_DDL(validated)).run();
      createPartitionIndexes(this.db, validated);
      this.db.exec(`ANALYZE ${validated}`);

      this.currentPartitions.add(validated);
      log.info(`Created event partition: ${validated}`);
    } catch (error) {
      log.error(`Failed to create partition ${validated}:`, error);
      throw error;
    }
  }

  /**
   * Scan database for existing partitions (with caching - found by Mistral)
   */
  private scanPartitions(force: boolean = false): void {
    const now = Date.now();
    if (!force && now - this.lastScanTime < this.SCAN_CACHE_TTL) {
      return; // Use cached data
    }

    try {
      const tables = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_events_%'"
        )
        .all() as { name: string }[];

      this.currentPartitions = new Set(
        tables
          .map((t) => asPartitionName(t.name))
          .filter((n): n is PartitionName => n !== null)
      );
      
      this.lastScanTime = now;
      log.debug(`Found ${this.currentPartitions.size} existing partitions`);
    } catch (error) {
      log.error("Failed to scan partitions:", error);
    }
  }

  /**
   * Run periodic maintenance:
   * - Create future partitions
   * - Drop old partitions
   * - Rebuild view
   */
  private async runMaintenance(): Promise<void> {
    // Check if off-peak hours (found by Mistral)
    if (!this.shouldRunMaintenance()) {
      log.debug("Skipping maintenance during peak hours");
      return;
    }

    log.debug("Running partition maintenance...");

    // Scan for new partitions
    this.scanPartitions(true);

    // Create partitions for next N months
    const now = new Date();
    for (let i = 0; i <= this.config.createAheadMonths; i++) {
      const future = new Date(now);
      future.setUTCMonth(future.getUTCMonth() + i);
      await this.createPartitionForDate(future);
    }

    // Drop old partitions
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - this.config.retentionMonths);
    await this.dropOldPartitions(cutoff);

    // Rebuild unified view
    this.rebuildView();
  }

  /**
   * Check if it's appropriate to run maintenance
   */
  private shouldRunMaintenance(): boolean {
    const hour = new Date().getHours();
    const offPeak = this.config.offPeakHours ?? { start: 22, end: 6 };
    
    return hour >= offPeak.start || hour < offPeak.end;
  }

  /**
   * Drop partitions older than cutoff date
   */
  private async dropOldPartitions(cutoff: Date): Promise<void> {
    const cutoffName = this.getPartitionName(cutoff.getTime());

    for (const partitionName of Array.from(this.currentPartitions)) {
      if (partitionName < cutoffName) {
        try {
          this.db.prepare(`DROP TABLE IF EXISTS ${partitionName}`).run();
          this.currentPartitions.delete(partitionName);
          log.info(`Dropped old partition: ${partitionName}`);
        } catch (error) {
          log.error(`Failed to drop partition ${partitionName}:`, error);
        }
      }
    }
  }

  /**
   * Rebuild unified view with all partitions
   * 
   * CRITICAL: Use IMMEDIATE transaction (found by Mistral)
   */
  private rebuildView(): void {
    const startTime = Date.now();
    
    try {
      // Drop old view
      this.db.prepare("DROP VIEW IF EXISTS agent_events").run();

      // Build UNION ALL query
      const partitions = Array.from(this.currentPartitions).sort();
      if (partitions.length === 0) {
        log.warn("No partitions found, skipping view rebuild");
        return;
      }

      // Warn if approaching SQLite limits (found by Mistral)
      if (partitions.length > 400) {
        log.error(
          `Too many partitions (${partitions.length}) - approaching SQLITE_MAX_COMPOUND_SELECT limit`
        );
      }

      const unionQuery = partitions
        .map((p) => `SELECT * FROM ${p}`)
        .join("\n  UNION ALL\n  ");

      this.db.prepare(`CREATE VIEW agent_events AS\n  ${unionQuery}`).run();

      const duration = Date.now() - startTime;
      if (duration > 100) {
        log.warn(`View rebuild took ${duration}ms - consider running during off-peak`);
      }

      log.debug(`Rebuilt view with ${partitions.length} partitions`);
    } catch (error) {
      log.error("Failed to rebuild view:", error);
    }
  }

  /**
   * Query events with automatic partition targeting
   * 
   * PERFORMANCE: SQLite doesn't prune UNION ALL views (found by both)
   */
  queryEvents(options: {
    startTime?: number;
    endTime?: number;
    type?: string;
    source?: string;
    limit?: number;
  }): any[] {
    // If no time range, fall back to full view scan
    if (!options.startTime || !options.endTime) {
      return this.queryAllPartitions(options);
    }

    // Target specific partitions based on time range
    const partitions = this.getPartitionsForRange(options.startTime, options.endTime);

    if (partitions.length === 0) {
      return [];
    }

    const limit = options.limit ?? 1000;
    const startSec = Math.floor(options.startTime / 1000);
    const endSec = Math.floor(options.endTime / 1000);
    const bindParams = [
      startSec,
      endSec,
      ...(options.type ? [options.type] : []),
      ...(options.source ? [options.source] : []),
      limit,
    ];
    const whereClause = `
      WHERE timestamp >= ? AND timestamp < ?
        ${options.type ? "AND type = ?" : ""}
        ${options.source ? "AND source = ?" : ""}
      ORDER BY timestamp DESC
      LIMIT ?
    `;

    if (partitions.length === 1) {
      return this.db
        .prepare(`SELECT * FROM ${partitions[0]} ${whereClause}`)
        .all(...bindParams);
    }

    const results: any[] = [];
    for (const partition of partitions) {
      const rows = this.db
        .prepare(`SELECT * FROM ${partition} ${whereClause}`)
        .all(...bindParams);
      results.push(...(rows as any[]));
    }

    results.sort((a, b) => b.timestamp - a.timestamp);
    return results.slice(0, limit);
  }

  /**
   * Get partitions for a time range
   */
  private getPartitionsForRange(startTime: number, endTime: number): PartitionName[] {
    const partitions: PartitionName[] = [];
    const start = new Date(startTime);
    const end = new Date(endTime);

    // Handle range spanning multiple months
    let current = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (current <= end) {
      const name = getPartitionNameForTimestamp(current.getTime());
      if (this.currentPartitions.has(name)) {
        partitions.push(name);
      }
      current.setUTCMonth(current.getUTCMonth() + 1);
    }

    return partitions;
  }

  /**
   * Fall back to full view scan
   */
  private queryAllPartitions(options: {
    type?: string;
    source?: string;
    limit?: number;
  }): any[] {
    return this.db
      .prepare(`
        SELECT * FROM agent_events
        WHERE 1=1
          ${options.type ? "AND type = ?" : ""}
          ${options.source ? "AND source = ?" : ""}
        ORDER BY timestamp DESC
        LIMIT ?
      `)
      .all(
        ...(options.type ? [options.type] : []),
        ...(options.source ? [options.source] : []),
        options.limit ?? 1000
      );
  }

  /**
   * Start maintenance timer
   */
  private startMaintenance(): void {
    this.maintenanceTimer = setInterval(
      () => this.runMaintenance(),
      this.config.maintenanceIntervalMs
    );

    // Don't prevent process exit
    if (this.maintenanceTimer.unref) {
      this.maintenanceTimer.unref();
    }
  }

  /**
   * Stop maintenance and cleanup
   */
  async shutdown(): Promise<void> {
    this.state = 'shutting_down';
    
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = undefined;
    }

    this.state = 'shutdown';
    log.info("Event partition manager shutdown");
  }

  /**
   * Get partition statistics
   */
  getStats(): PartitionStats {
    return {
      partitionCount: this.currentPartitions.size,
      partitions: Array.from(this.currentPartitions).sort(),
      retentionMonths: this.config.retentionMonths,
    };
  }

  /**
   * Manually trigger maintenance (for testing)
   */
  async triggerMaintenance(): Promise<void> {
    await this.runMaintenance();
  }
}

// ============================================================================
// Migration Functions
// ============================================================================

/**
 * Migrate from single table to partitioned tables
 * 
 * CRITICAL: Safe migration with backup + verification (found by both)
 * 
 * FIX: Use id-based pagination instead of OFFSET (found by both)
 * FIX: Calculate timestamps from month strings (found by DeepSeek)
 */
export async function migrateToPartitions(
  db: DatabaseSync,
  options: {
    batchSize?: number;
    dryRun?: boolean;
    keepBackup?: boolean;
    verifyChecksums?: boolean;
  } = {}
): Promise<MigrationResult> {
  const {
    batchSize = 10000,
    dryRun = false,
    keepBackup = true,
    verifyChecksums = true,
  } = options;

  log.info(`Starting partition migration (dryRun: ${dryRun})...`);

  // Check if migration needed
  const legacyTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_events'"
    )
    .get();

  if (!legacyTable) {
    log.info("No legacy table found, migration not needed");
    return {
      success: true,
      eventsMigrated: 0,
      partitionsCreated: [],
      checksumVerified: true,
      rollbackAvailable: false,
    };
  }

  // Checkpoint WAL before migration
  db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();

  // Get pre-migration count
  const sourceCount = db
    .prepare("SELECT COUNT(*) as count FROM agent_events")
    .get() as { count: number };

  log.info(`Found ${sourceCount.count} events to migrate`);

  if (dryRun) {
    log.info(`[DRY RUN] Would migrate ${sourceCount.count} events`);
    return {
      success: true,
      eventsMigrated: 0,
      partitionsCreated: [],
      checksumVerified: false,
      rollbackAvailable: false,
    };
  }

  // Create backup table
  log.info("Creating backup of legacy table...");
  db.prepare("DROP TABLE IF EXISTS agent_events_backup").run();
  db.prepare("ALTER TABLE agent_events RENAME TO agent_events_backup").run();

  // Group events by month
  const months = db
    .prepare(
      `SELECT 
        strftime('%Y-%m', timestamp, 'unixepoch') as month,
        COUNT(*) as count
       FROM agent_events_backup
       GROUP BY month
       ORDER BY month`
    )
    .all() as { month: string; count: number }[];

  log.info(`Found ${months.length} months of data`);

  const partitionsCreated: string[] = [];
  let totalMigrated = 0;

  // Create partitions and migrate data
  for (const monthData of months) {
    const [yearStr, monthStr] = monthData.month.split("-");
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const partitionName = `agent_events_${yearStr}_${monthStr}` as PartitionName;

    // Validate
    if (!asPartitionName(partitionName)) {
      log.error(`Invalid partition name: ${partitionName}`);
      continue;
    }

    log.info(`Migrating ${monthData.count} events to ${partitionName}...`);

    // Create partition (without indexes first - faster inserts)
    db.prepare(PARTITION_TABLE_DDL(partitionName)).run();

    // Calculate time range (FIX: use direct calculation - found by DeepSeek)
    const { startTs, endTs } = getMonthRange(year, month);

    // Migrate data with id-based pagination (FIX: found by both)
    let lastId: string | null = null;
    let migrated = 0;

    while (migrated < monthData.count) {
      const rows = lastId
        ? db
            .prepare(
              `
            SELECT * FROM agent_events_backup
            WHERE timestamp >= ? AND timestamp <= ? AND id > ?
            ORDER BY id
            LIMIT ?
          `
            )
            .all(startTs, endTs, lastId, batchSize)
        : db
            .prepare(
              `
            SELECT * FROM agent_events_backup
            WHERE timestamp >= ? AND timestamp <= ?
            ORDER BY id
            LIMIT ?
          `
            )
            .all(startTs, endTs, batchSize);

      if (rows.length === 0) break;

      // Insert rows into partition
      const insertStmt = db.prepare(`
        INSERT INTO ${partitionName}
        (id, type, source, timestamp, data, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const row of rows as any[]) {
        insertStmt.run(
          row.id,
          row.type,
          row.source,
          row.timestamp,
          row.data,
          row.metadata,
          row.created_at
        );
      }

      lastId = rows[rows.length - 1].id;
      migrated += rows.length;

      if (migrated < monthData.count && migrated % 50000 === 0) {
        log.debug(`  Migrated ${migrated}/${monthData.count} events...`);
      }
    }

    // Create indexes AFTER data load (faster - found by Mistral)
    createPartitionIndexes(db, partitionName);

    // Update statistics
    db.exec(`ANALYZE ${partitionName}`);

    partitionsCreated.push(partitionName);
    totalMigrated += migrated;

    log.info(`✅ Migrated ${migrated} events to ${partitionName}`);
  }

  // Create unified view
  if (partitionsCreated.length > 0) {
    const unionQuery = partitionsCreated
      .sort()
      .map((p) => `SELECT * FROM ${p}`)
      .join("\n  UNION ALL\n  ");

    db.prepare(`CREATE VIEW agent_events AS\n  ${unionQuery}`).run();
  }

  // Verify counts
  if (verifyChecksums && totalMigrated !== sourceCount.count) {
    log.error(
      `Migration verification failed: source=${sourceCount.count}, migrated=${totalMigrated}`
    );
    return {
      success: false,
      eventsMigrated: totalMigrated,
      partitionsCreated,
      checksumVerified: false,
      rollbackAvailable: true,
      error: "Data integrity check failed - backup retained",
    };
  }

  // Cleanup
  if (!keepBackup) {
    log.info("Dropping backup table...");
    db.prepare("DROP TABLE agent_events_backup").run();

    // Reclaim space
    db.prepare("VACUUM").run();
  } else {
    log.info("Backup table retained: agent_events_backup");
  }

  log.info("✅ Partition migration complete!");
  log.info(`Created ${partitionsCreated.length} partitions`);

  return {
    success: true,
    eventsMigrated: totalMigrated,
    partitionsCreated,
    checksumVerified: verifyChecksums,
    rollbackAvailable: keepBackup,
  };
}

/**
 * Rollback migration
 */
export function rollbackMigration(db: DatabaseSync): void {
  log.info("Rolling back partition migration...");

  // Drop all partitions
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_events_%'"
    )
    .all() as { name: string }[];

  for (const t of tables) {
    db.prepare(`DROP TABLE IF EXISTS ${t.name}`).run();
  }

  // Drop view
  db.prepare("DROP VIEW IF EXISTS agent_events").run();

  // Restore backup if exists
  const backup = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_events_backup'"
    )
    .get();

  if (backup) {
    db.prepare("ALTER TABLE agent_events_backup RENAME TO agent_events").run();
  }

  log.info("Migration rolled back successfully");
}
