/**
 * GoalTree - SelfGoal Pattern Implementation
 *
 * Language-conditioned goal decomposition with hierarchical structure
 * and usefulness scoring. Based on arXiv:2406.04784 (SelfGoal)
 */

export interface GoalNode {
  id: string;
  goal: string;
  parentId: string | null;
  children: string[];
  status: 'pending' | 'active' | 'completed' | 'failed';
  usefulnessScore: number; // 0-1, higher = more useful
  attempts: number;
  successRate: number; // 0-1, tracks historical success
  createdAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Simple binary heap for priority queue (avoids external dependencies)
 */
class PriorityHeap<T> {
  private heap: T[] = [];
  private comparator: (a: T, b: T) => number;

  constructor(comparator: (a: T, b: T) => number) {
    this.comparator = comparator;
  }

  push(item: T): void {
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  peek(): T | undefined {
    return this.heap[0];
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.comparator(this.heap[index], this.heap[parentIndex]) > 0) {
        [this.heap[index], this.heap[parentIndex]] = [this.heap[parentIndex], this.heap[index]];
        index = parentIndex;
      } else {
        break;
      }
    }
  }

  private bubbleDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let largest = index;

      if (leftChild < length && this.comparator(this.heap[leftChild], this.heap[largest]) > 0) {
        largest = leftChild;
      }
      if (rightChild < length && this.comparator(this.heap[rightChild], this.heap[largest]) > 0) {
        largest = rightChild;
      }

      if (largest !== index) {
        [this.heap[index], this.heap[largest]] = [this.heap[largest], this.heap[index]];
        index = largest;
      } else {
        break;
      }
    }
  }
}

export class GoalTree {
  private nodes: Map<string, GoalNode> = new Map();
  private rootId: string | null = null;
  // PERFORMANCE OPTIMIZATION: Priority queue for O(1) retrieval
  private pendingHeap: PriorityHeap<GoalNode>;

  constructor() {
    this.nodes = new Map();
    this.rootId = null;
    // Higher usefulnessScore = higher priority
    this.pendingHeap = new PriorityHeap<GoalNode>((a, b) => b.usefulnessScore - a.usefulnessScore);
  }

  /**
   * Add a root goal (top-level objective)
   */
  addRootGoal(goal: string, usefulnessScore = 0.5): string {
    if (this.rootId) {
      throw new Error('Root goal already exists. Use decompose() to add subgoals.');
    }

    const id = this.generateId();
    const node: GoalNode = {
      id,
      goal,
      parentId: null,
      children: [],
      status: 'active',
      usefulnessScore,
      attempts: 0,
      successRate: 0,
      createdAt: Date.now(),
    };

    this.nodes.set(id, node);
    this.rootId = id;
    
    // PERFORMANCE: Add to priority heap for O(1) retrieval
    this.pendingHeap.push(node);

    return id;
  }

  /**
   * Decompose a goal into subgoals (SelfGoal pattern)
   */
  decompose(parentId: string, subgoals: Array<{ goal: string; usefulnessScore?: number }>): string[] {
    const parent = this.nodes.get(parentId);
    if (!parent) {
      throw new Error(`Parent goal ${parentId} not found`);
    }

    const ids: string[] = [];

    for (const subgoal of subgoals) {
      const id = this.generateId();
      const node: GoalNode = {
        id,
        goal: subgoal.goal,
        parentId,
        children: [],
        status: 'pending',
        usefulnessScore: subgoal.usefulnessScore ?? parent.usefulnessScore * 0.9, // Inherit parent score with decay
        attempts: 0,
        successRate: 0,
        createdAt: Date.now(),
      };

      this.nodes.set(id, node);
      parent.children.push(id);
      ids.push(id);
      
      // PERFORMANCE: Add to priority heap for O(1) retrieval
      this.pendingHeap.push(node);
    }

    return ids;
  }

  /**
   * Mark a goal as completed
   */
  completeGoal(goalId: string): void {
    const node = this.nodes.get(goalId);
    if (!node) {
      throw new Error(`Goal ${goalId} not found`);
    }

    node.status = 'completed';
    node.completedAt = Date.now();
    node.successRate = node.attempts > 0 ? 1 / node.attempts : 1;

    // Update parent's success rate
    if (node.parentId) {
      this.updateParentSuccessRate(node.parentId);
    }
  }

  /**
   * Mark a goal as failed
   */
  failGoal(goalId: string): void {
    const node = this.nodes.get(goalId);
    if (!node) {
      throw new Error(`Goal ${goalId} not found`);
    }

    node.status = 'failed';
    node.attempts++;

    // Update parent's success rate
    if (node.parentId) {
      this.updateParentSuccessRate(node.parentId);
    }
  }

  /**
   * Get next pending goal to work on (priority queue based on usefulness)
   * PERFORMANCE OPTIMIZATION: O(1) using priority heap instead of O(n log n)
   */
  getNextPendingGoal(): GoalNode | null {
    // Pop from heap until we find a valid pending/active goal
    while (!this.pendingHeap.isEmpty()) {
      const next = this.pendingHeap.peek();
      if (!next) break;
      
      // Check if still valid (not completed/failed)
      if (next.status === 'pending' || next.status === 'active') {
        return next;
      }
      
      // Remove invalid goal from heap
      this.pendingHeap.pop();
    }
    
    return null;
  }

  /**
   * Get all goals in tree
   */
  getAllGoals(): GoalNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Get goal by ID
   */
  getGoal(id: string): GoalNode | null {
    return this.nodes.get(id) || null;
  }

  /**
   * Get root goal
   */
  getRootGoal(): GoalNode | null {
    return this.rootId ? this.nodes.get(this.rootId) : null;
  }

  /**
   * Get tree statistics
   */
  getStats(): {
    total: number;
    pending: number;
    active: number;
    completed: number;
    failed: number;
    avgSuccessRate: number;
  } {
    const nodes = Array.from(this.nodes.values());

    return {
      total: nodes.length,
      pending: nodes.filter(n => n.status === 'pending').length,
      active: nodes.filter(n => n.status === 'active').length,
      completed: nodes.filter(n => n.status === 'completed').length,
      failed: nodes.filter(n => n.status === 'failed').length,
      avgSuccessRate: nodes.reduce((sum, n) => sum + n.successRate, 0) / nodes.length,
    };
  }

  /**
   * Update parent's success rate based on children
   */
  private updateParentSuccessRate(parentId: string): void {
    const parent = this.nodes.get(parentId);
    if (!parent || parent.children.length === 0) return;

    const children = parent.children.map(id => this.nodes.get(id)!);
    parent.successRate = children.reduce((sum, child) => sum + child.successRate, 0) / children.length;
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `goal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
