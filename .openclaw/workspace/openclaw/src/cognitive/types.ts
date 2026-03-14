/**
 * Meta-Cognitive System Types
 * 
 * Core types for self-reflection, reasoning tracking, and autonomous improvement.
 */

/**
 * A single metric event captured during event processing.
 * Lightweight - used for batch writes to SQLite.
 */
export interface MetricEvent {
  eventId: string;
  eventType: string;
  responseTime: number; // ms
  surpriseScore?: number; // from neuro-memory
  timestamp: number;
  batchId?: string;
}

/**
 * Full reasoning trace - captures the complete context of a decision.
 * Used for deep reflection and pattern learning.
 */
export interface ReasoningTrace {
  eventId: string;
  timestamp: number;
  eventType: string;
  
  // What I predicted would happen
  predictions?: {
    expectedOutcome: string;
    confidence: number;
    actualOutcome?: string; // filled in later
    wasCorrect?: boolean; // calculated after the fact
  };
  
  // How I performed
  performance: {
    responseTime: number;
    surpriseScore?: number;
    userCorrection?: boolean; // did user fix my output?
    userSatisfaction?: number; // 0-1 if detectable
  };
  
  // What I learned (filled by MetaCognitiveEngine)
  insights?: {
    patternDetected?: string;
    confidenceDelta?: number; // how much my confidence changed
    newHeuristic?: string; // new rule I discovered
    shouldAvoid?: string; // anti-pattern identified
  };
  
  // Context for learning
  context: {
    timeOfDay: number; // hour 0-23
    dayOfWeek: number; // 0-6
    conversationId?: string;
    userAction?: string; // what did user do after?
    previousEventTypes?: string[]; // what led to this?
  };
}

/**
 * Result of meta-cognitive reflection.
 * Output of the MetaCognitiveEngine.
 */
export interface ReflectionResult {
  timestamp: number;
  period: {
    start: number;
    end: number;
  };
  
  // Patterns discovered
  patterns: {
    type: 'success' | 'failure' | 'surprise' | 'user_correction';
    description: string;
    frequency: number;
    confidence: number;
    examples: string[]; // event IDs
  }[];
  
  // Insights extracted
  insights: {
    category: 'performance' | 'accuracy' | 'timing' | 'social';
    finding: string;
    recommendation: string;
    priority: 'high' | 'medium' | 'low';
  }[];
  
  // Self-model updates
  selfModel?: {
    strengthsIdentified: string[];
    weaknessesIdentified: string[];
    capabilityChanges: Record<string, number>; // capability → delta
  };
  
  // Actionable improvements
  actions: {
    type: 'config_change' | 'heuristic_add' | 'pattern_learn' | 'knowledge_gap';
    description: string;
    impact: number; // 0-1 estimated improvement
    effort: number; // 0-1 implementation difficulty
  }[];
}

/**
 * Configuration for MetaCognitiveEngine
 */
export interface MetaCognitiveConfig {
  /** How often to run reflection (default: 6 hours) */
  reflectionIntervalMs?: number;
  /** Minimum events before reflecting (default: 100) */
  minEventsForReflection?: number;
  /** SQLite database path */
  dbPath?: string;
  /** Enable background reflection (default: true) */
  enabled?: boolean;
  /** Write insights to MEMORY.md (default: true) */
  updateMemory?: boolean;
}

/**
 * Statistics about reasoning performance
 */
export interface ReasoningStats {
  totalEvents: number;
  avgResponseTime: number;
  p95ResponseTime: number;
  avgSurprise: number;
  highSurpriseEvents: number; // surprise > 0.5
  userCorrections: number;
  patternsLearned: number;
  topEventTypes: { type: string; count: number }[];
  hourlyDistribution: number[]; // 24-element array
}
