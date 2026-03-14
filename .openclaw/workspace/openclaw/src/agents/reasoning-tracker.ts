/**
 * Reasoning Tracker
 * 
 * SQLite-based storage for reasoning traces and performance metrics.
 * Provides analytics queries for the MetaCognitiveEngine.
 */

import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { optimizeDatabase, safeOpenDatabase } from "../infra/sqlite-utils.js";
import type { ReasoningTrace, PerformanceMetrics, DetectedPattern } from "./meta-cognitive-types.js";

const log = createSubsystemLogger("reasoning-tracker");

export class ReasoningTracker {
  private db: any;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.initDB();
  }

  /**
   * Initialize SQLite database with schema
   */
  private initDB(): void {
    try {
      const { DatabaseSync } = require("node:sqlite");
      
      // Use safe open with automatic corruption recovery
      this.db = safeOpenDatabase(this.dbPath, DatabaseSync);
      
      if (!this.db) {
        throw new Error("Failed to open database (corruption recovery failed)");
      }
      
      optimizeDatabase(this.db);
      this.ensureTables();
      log.info(`✅ Reasoning tracker initialized: ${this.dbPath}`);
    } catch (error) {
      log.error("Failed to initialize reasoning tracker:", error);
      throw error;
    }
  }

  /**
   * Create database tables
   */
  private ensureTables(): void {
    // Reasoning traces table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reasoning_traces (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        
        -- Predictions
        expected_outcome TEXT,
        prediction_confidence REAL,
        actual_outcome TEXT,
        prediction_correct INTEGER,
        
        -- Performance
        response_time INTEGER NOT NULL,
        surprise_score REAL,
        user_correction INTEGER DEFAULT 0,
        user_satisfaction REAL,
        retry_count INTEGER DEFAULT 0,
        error_occurred INTEGER DEFAULT 0,
        
        -- Insights (filled later)
        pattern_detected TEXT,
        confidence_delta REAL,
        new_heuristic TEXT,
        improvement_area TEXT,
        
        -- Context
        time_of_hour INTEGER,
        day_of_week INTEGER,
        is_weekend INTEGER,
        conversation_id TEXT,
        user_action TEXT,
        session_type TEXT,
        
        -- Reflection
        reflected INTEGER DEFAULT 0,
        reflection_timestamp INTEGER,
        
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);

    // Detected patterns table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS detected_patterns (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        frequency INTEGER DEFAULT 1,
        confidence REAL NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        examples TEXT,
        recommendation TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);

    // Create indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_traces_event_type ON reasoning_traces(event_type, timestamp)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON reasoning_traces(timestamp)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_traces_reflected ON reasoning_traces(reflected, timestamp)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_patterns_type ON detected_patterns(type, last_seen)`);
  }

  /**
   * Store a reasoning trace
   */
  storeTrace(trace: ReasoningTrace): void {
    const stmt = this.db.prepare(`
      INSERT INTO reasoning_traces (
        id, event_id, event_type, timestamp,
        expected_outcome, prediction_confidence, actual_outcome, prediction_correct,
        response_time, surprise_score, user_correction, user_satisfaction,
        retry_count, error_occurred,
        pattern_detected, confidence_delta, new_heuristic, improvement_area,
        time_of_hour, day_of_week, is_weekend, conversation_id, user_action, session_type,
        reflected, reflection_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      trace.id,
      trace.eventId,
      trace.eventType,
      trace.timestamp,
      trace.predictions?.expectedOutcome ?? null,
      trace.predictions?.confidence ?? null,
      trace.predictions?.actualOutcome ?? null,
      trace.predictions?.wasCorrect ? 1 : 0,
      trace.performance.responseTime,
      trace.performance.surpriseScore ?? null,
      trace.performance.userCorrection ? 1 : 0,
      trace.performance.userSatisfaction ?? null,
      trace.performance.retryCount ?? 0,
      trace.performance.errorOccurred ? 1 : 0,
      trace.insights?.patternDetected ?? null,
      trace.insights?.confidenceDelta ?? null,
      trace.insights?.newHeuristic ?? null,
      trace.insights?.improvementArea ?? null,
      trace.context.timeOfDay,
      trace.context.dayOfWeek,
      trace.context.isWeekend ? 1 : 0,
      trace.context.conversationId ?? null,
      trace.context.userAction ?? null,
      trace.context.sessionType ?? null,
      trace.reflected ? 1 : 0,
      trace.reflectionTimestamp ?? null
    );
  }

  /**
   * Get unreflected traces
   */
  getUnreflectedTraces(limit: number = 1000): ReasoningTrace[] {
    const stmt = this.db.prepare(`
      SELECT * FROM reasoning_traces 
      WHERE reflected = 0 
      ORDER BY timestamp DESC 
      LIMIT ?
    `);
    
    const rows = stmt.all(limit);
    return rows.map((row: any) => this.rowToTrace(row));
  }

  /**
   * Mark traces as reflected
   */
  markReflected(traceIds: string[]): void {
    const stmt = this.db.prepare(`
      UPDATE reasoning_traces 
      SET reflected = 1, reflection_timestamp = ? 
      WHERE id = ?
    `);
    
    const now = Date.now();
    const updateMany = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        stmt.run(now, id);
      }
    });
    
    updateMany(traceIds);
  }

  /**
   * Get performance metrics for time range
   */
  getPerformanceMetrics(since?: number): PerformanceMetrics {
    const sinceClause = since ? `WHERE timestamp >= ${since}` : "";
    
    // Total events
    const totalStmt = this.db.prepare(`SELECT COUNT(*) as count FROM reasoning_traces ${sinceClause}`);
    const total = totalStmt.get() as { count: number };
    
    // Average response time
    const avgStmt = this.db.prepare(`
      SELECT AVG(response_time) as avg, 
             MAX(response_time) as max,
             MIN(response_time) as min
      FROM reasoning_traces 
      ${sinceClause}
    `);
    const avgResult = avgStmt.get() as { avg: number; max: number; min: number };
    
    // P95 response time (approximation)
    const p95Stmt = this.db.prepare(`
      SELECT response_time 
      FROM reasoning_traces 
      ${sinceClause}
      ORDER BY response_time DESC 
      LIMIT 1 OFFSET (SELECT COUNT(*) * 0.05 FROM reasoning_traces ${sinceClause})
    `);
    const p95Result = p95Stmt.get() as { response_time: number } | undefined;
    
    // Error rate
    const errorStmt = this.db.prepare(`
      SELECT SUM(error_occurred) as errors, COUNT(*) as total
      FROM reasoning_traces 
      ${sinceClause}
    `);
    const errorResult = errorStmt.get() as { errors: number; total: number };
    
    // Average surprise score
    const surpriseStmt = this.db.prepare(`
      SELECT AVG(surprise_score) as avg 
      FROM reasoning_traces 
      WHERE surprise_score IS NOT NULL 
      ${since ? `AND timestamp >= ${since}` : ""}
    `);
    const surpriseResult = surpriseStmt.get() as { avg: number };
    
    // Top event types
    const typesStmt = this.db.prepare(`
      SELECT event_type, COUNT(*) as count 
      FROM reasoning_traces 
      ${sinceClause}
      GROUP BY event_type 
      ORDER BY count DESC 
      LIMIT 10
    `);
    const types = typesStmt.all() as Array<{ event_type: string; count: number }>;
    
    // Hourly distribution
    const hourlyStmt = this.db.prepare(`
      SELECT time_of_hour as hour, COUNT(*) as count 
      FROM reasoning_traces 
      ${sinceClause}
      GROUP BY time_of_hour 
      ORDER BY hour
    `);
    const hourly = hourlyStmt.all() as Array<{ hour: number; count: number }>;
    
    // Time range
    const timeRangeStmt = this.db.prepare(`
      SELECT MIN(timestamp) as start, MAX(timestamp) as end 
      FROM reasoning_traces 
      ${sinceClause}
    `);
    const timeRange = timeRangeStmt.get() as { start: number; end: number };
    
    return {
      totalEvents: total.count,
      avgResponseTime: avgResult.avg || 0,
      p95ResponseTime: p95Result?.response_time || avgResult.max || 0,
      errorRate: errorResult.total > 0 ? errorResult.errors / errorResult.total : 0,
      avgSurpriseScore: surpriseResult.avg || 0,
      topEventTypes: types,
      hourlyDistribution: hourly,
      timeRange: {
        start: timeRange.start || 0,
        end: timeRange.end || 0,
      },
    };
  }

  /**
   * Store a detected pattern
   */
  storePattern(pattern: DetectedPattern): void {
    const stmt = this.db.prepare(`
      INSERT INTO detected_patterns (
        id, type, description, frequency, confidence, 
        first_seen, last_seen, examples, recommendation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      pattern.id,
      pattern.type,
      pattern.description,
      pattern.frequency,
      pattern.confidence,
      pattern.firstSeen,
      pattern.lastSeen,
      JSON.stringify(pattern.examples),
      pattern.recommendation ?? null
    );
  }

  /**
   * Get recent patterns
   */
  getRecentPatterns(limit: number = 20): DetectedPattern[] {
    const stmt = this.db.prepare(`
      SELECT * FROM detected_patterns 
      ORDER BY last_seen DESC 
      LIMIT ?
    `);
    
    const rows = stmt.all(limit);
    return rows.map((row: any) => ({
      id: row.id,
      type: row.type,
      description: row.description,
      frequency: row.frequency,
      confidence: row.confidence,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      examples: JSON.parse(row.examples || "[]"),
      recommendation: row.recommendation,
    }));
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
    }
  }

  /**
   * Convert database row to ReasoningTrace
   */
  private rowToTrace(row: any): ReasoningTrace {
    return {
      id: row.id,
      eventId: row.event_id,
      timestamp: row.timestamp,
      eventType: row.event_type,
      predictions: row.expected_outcome ? {
        expectedOutcome: row.expected_outcome,
        confidence: row.prediction_confidence,
        actualOutcome: row.actual_outcome ?? undefined,
        wasCorrect: row.prediction_correct === 1,
      } : undefined,
      performance: {
        responseTime: row.response_time,
        surpriseScore: row.surprise_score ?? undefined,
        userCorrection: row.user_correction === 1,
        userSatisfaction: row.user_satisfaction ?? undefined,
        retryCount: row.retry_count,
        errorOccurred: row.error_occurred === 1,
      },
      insights: row.pattern_detected ? {
        patternDetected: row.pattern_detected,
        confidenceDelta: row.confidence_delta ?? undefined,
        newHeuristic: row.new_heuristic ?? undefined,
        improvementArea: row.improvement_area ?? undefined,
      } : undefined,
      context: {
        timeOfDay: row.time_of_hour,
        dayOfWeek: row.day_of_week,
        isWeekend: row.is_weekend === 1,
        conversationId: row.conversation_id ?? undefined,
        userAction: row.user_action ?? undefined,
        sessionType: row.session_type ?? undefined,
      },
      reflected: row.reflected === 1,
      reflectionTimestamp: row.reflection_timestamp ?? undefined,
    };
  }
}

// Singleton instance
let trackerInstance: ReasoningTracker | null = null;

export function getReasoningTracker(dbPath?: string): ReasoningTracker {
  if (!trackerInstance) {
    const path = dbPath || process.env.REASONING_DB_PATH || `${process.env.HOME}/.openclaw/reasoning.db`;
    trackerInstance = new ReasoningTracker(path);
  }
  return trackerInstance;
}
