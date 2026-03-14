/**
 * Neuro-Memory Insights Schema
 * Based on consensus from 6 AI expert analyses (DeepSeek, Mistral)
 * 
 * This defines the interface between neuro-memory-agent (Python) and evolution service (TypeScript)
 */

export interface NeuroMemoryInsights {
  metadata: InsightsMetadata;
  failurePatterns: FailurePattern[];
  successPatterns: SuccessPattern[];
  surpriseEvents: SurpriseEvent[];
  recommendations: Recommendation[];
}

export interface InsightsMetadata {
  period: {
    start: string; // ISO date
    end: string;   // ISO date
  };
  generatedAt: string; // ISO timestamp
  dataQuality: {
    eventCount: number;
    completeness: number; // 0-1
    hasGaps: boolean;
    lastEventAt?: string; // ISO timestamp
  };
}

export type FailureCategory = 
  | 'exec_failure' 
  | 'tool_error' 
  | 'proposal_rejected' 
  | 'test_failure' 
  | 'timeout' 
  | 'hallucination';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface FailurePattern {
  patternId: string;
  category: FailureCategory;
  description: string;
  frequency: number;
  firstSeen: string; // ISO timestamp
  lastSeen: string;  // ISO timestamp
  contexts: Array<{
    trigger?: string;
    errorMessage?: string;
    stackTrace?: string;
    timestamp: string; // ISO timestamp
  }>;
  confidence: number; // 0-1
  severity: Severity;
}

export type SuccessCategory = 
  | 'fast_execution' 
  | 'low_error_rate' 
  | 'user_accepted' 
  | 'test_passed' 
  | 'efficient_resource';

export interface SuccessPattern {
  patternId: string;
  category: SuccessCategory;
  description: string;
  frequency: number;
  avgPerformance?: {
    duration?: number;
    successRate?: number; // 0-1
  };
  conditions: string[]; // Conditions under which this success occurs
  confidence: number; // 0-1
}

export type SurpriseCategory = 
  | 'unexpected_success' 
  | 'unexpected_failure' 
  | 'anomaly' 
  | 'rare_pattern' 
  | 'outlier';

export type Importance = 'low' | 'medium' | 'high';

export interface SurpriseEvent {
  eventId: string;
  category: SurpriseCategory;
  description: string;
  surpriseScore: number; // 0-1
  timestamp: string; // ISO timestamp
  context?: Record<string, any>;
  importance: Importance;
}

export type RecommendationType = 
  | 'avoid'    // Don't do X
  | 'prefer'   // Do more of X
  | 'investigate' // Look into X
  | 'optimize' // Improve X
  | 'caution'; // Be careful with X

export type Priority = 'low' | 'medium' | 'high' | 'critical';

export interface Recommendation {
  recommendationId: string;
  type: RecommendationType;
  description: string;
  rationale: string;
  basedOn: string[]; // References to patternIds or eventIds
  confidence: number; // 0-1
  priority: Priority;
}

/**
 * Query interface for evolution service
 */
export interface EvolutionQuery {
  types?: Array<'failures' | 'successes' | 'surprises' | 'recommendations'>;
  minConfidence?: number; // Default: 0.70
  categories?: FailureCategory[] | SuccessCategory[];
  limit?: number; // Max results per category
  period?: {
    start: string;
    end: string;
  };
}

/**
 * Default confidence thresholds
 */
export const DEFAULT_THRESHOLDS = {
  MIN_FAILURE_FREQUENCY: 3,
  MIN_SUCCESS_FREQUENCY: 5,
  MIN_CONFIDENCE: 0.70,
  SURPRISE_MIN_SCORE: 0.75,
  MAX_PATTERNS_PER_CATEGORY: 10,
  MAX_RECOMMENDATIONS: 10,
} as const;

/**
 * Cold start detection
 */
export function isColdStart(metadata: InsightsMetadata): boolean {
  return metadata.dataQuality.eventCount < 100;
}

/**
 * Data quality check
 */
export function isLowQuality(metadata: InsightsMetadata): boolean {
  return metadata.dataQuality.completeness < 0.70;
}

/**
 * Get data freshness in days
 */
export function getDataFreshness(metadata: InsightsMetadata): number {
  if (!metadata.dataQuality.lastEventAt) return Infinity;
  const lastEvent = new Date(metadata.dataQuality.lastEventAt).getTime();
  const now = Date.now();
  return (now - lastEvent) / (1000 * 60 * 60 * 24); // Days
}
