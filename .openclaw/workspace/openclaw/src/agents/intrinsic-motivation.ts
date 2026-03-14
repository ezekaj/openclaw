/**
 * IntrinsicMotivation - Sophia Pattern Implementation
 *
 * Provides intrinsic motivation signals (curiosity, competence, autonomy)
 * for self-directed exploration and learning. Based on Sophia (System 3)
 */

export type MotivationType = 'curiosity' | 'competence' | 'autonomy';

export interface MotivationState {
  curiosity: number; // 0-1, drives exploration
  competence: number; // 0-1, drives skill development
  autonomy: number; // 0-1, drives self-direction
  lastUpdate: number;
}

export interface MotivationEvent {
  type: MotivationType;
  intensity: number; // 0-1
  trigger: string;
  timestamp: number;
}

export class IntrinsicMotivation {
  private state: MotivationState = {
    curiosity: 0.5,
    competence: 0.5,
    autonomy: 0.5,
    lastUpdate: Date.now(),
  };

  private eventHistory: MotivationEvent[] = [];
  private readonly maxHistorySize = 100;

  /**
   * Get current motivation state
   */
  getState(): MotivationState {
    return { ...this.state };
  }

  /**
   * Update motivation based on experience
   */
  updateMotivation(type: MotivationType, delta: number, trigger: string): void {
    const event: MotivationEvent = {
      type,
      intensity: Math.max(0, Math.min(1, this.state[type] + delta)),
      trigger,
      timestamp: Date.now(),
    };

    // Apply to state
    this.state[type] = event.intensity;
    this.state.lastUpdate = Date.now();

    // Record event
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }
  }

  /**
   * Check if exploration is needed (curiosity threshold)
   */
  shouldExplore(): boolean {
    return this.state.curiosity > 0.7;
  }

  /**
   * Check if skill development is needed (competence threshold)
   */
  shouldDevelopSkills(): boolean {
    return this.state.competence > 0.7;
  }

  /**
   * Check if self-direction is needed (autonomy threshold)
   */
  shouldSelfDirect(): boolean {
    return this.state.autonomy > 0.7;
  }

  /**
   * Generate intrinsic goals based on motivation state
   */
  generateIntrinsicGoals(): string[] {
    const goals: string[] = [];

    if (this.shouldExplore()) {
      goals.push('Explore new patterns in environment');
    }

    if (this.shouldDevelopSkills()) {
      goals.push('Improve capability: test coverage');
    }

    if (this.shouldSelfDirect()) {
      goals.push('Self-initiate optimization task');
    }

    return goals;
  }

  /**
   * Get top patterns from motivation history
   */
  getTopPatterns(limit: number = 10): MotivationEvent[] {
    return this.eventHistory.slice(-limit);
  }

  /**
   * Record success event (increases competence)
   */
  recordSuccess(task: string): void {
    this.updateMotivation('competence', 0.1, `Completed: ${task}`);
  }

  /**
   * Record failure event (increases curiosity)
   */
  recordFailure(task: string): void {
    this.updateMotivation('curiosity', 0.1, `Failed: ${task}`);
  }

  /**
   * Record autonomy event (self-directed action)
   */
  recordAutonomy(action: string): void {
    this.updateMotivation('autonomy', 0.05, `Self-directed: ${action}`);
  }

  /**
   * Decay motivation over time (prevent infinite growth)
   */
  decay(decayRate = 0.01): void {
    const now = Date.now();
    const timeSinceUpdate = (now - this.state.lastUpdate) / 1000; // seconds

    if (timeSinceUpdate > 3600) { // 1 hour
      this.state.curiosity = Math.max(0.3, this.state.curiosity - decayRate);
      this.state.competence = Math.max(0.3, this.state.competence - decayRate);
      this.state.autonomy = Math.max(0.3, this.state.autonomy - decayRate);
      this.state.lastUpdate = now;
    }
  }

  /**
   * Get recent motivation events
   */
  getRecentEvents(limit = 10): MotivationEvent[] {
    return this.eventHistory.slice(-limit);
  }

  /**
   * Reset motivation to baseline
   */
  reset(): void {
    this.state = {
      curiosity: 0.5,
      competence: 0.5,
      autonomy: 0.5,
      lastUpdate: Date.now(),
    };
    this.eventHistory = [];
  }
}
