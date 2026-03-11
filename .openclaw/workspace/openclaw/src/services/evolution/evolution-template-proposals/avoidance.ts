/**
 * Template: Avoid known bad patterns
 * 
 * Generates constraint-based proposals to avoid repeating known failure patterns.
 * These will be added to the.generateProposals() in TypeScript.
 */

export interface AvoidanceTemplateData {
  patternId: string;
  category: FailureCategory;
  description: string;
  confidence: number;
  severity: Severity;
  rationale: string;
  avoidFilePatterns: string[]; // List of file patterns to avoid
}

