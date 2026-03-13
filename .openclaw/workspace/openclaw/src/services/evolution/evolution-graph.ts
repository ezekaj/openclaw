/**
 * EvolutionGraph - Persistent DAG storage for all evolution alternatives
 *
 * Based on EvoLattice (arXiv:2512.13857):
 * - Keeps ALL variants in a DAG, not just the best one
 * - Multi-path evaluation: each alternative scored across ALL paths it appears in
 * - Self-repair mechanism: auto-fixes structural issues (acyclicity, deps)
 * - Quality-Diversity: emerges from internal representation
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Node types in the evolution DAG
export type NodeType = 'baseline' | 'proposal' | 'refinement' | 'merge';

// Proposal status
export type ProposalStatus = 'pending' | 'testing' | 'passed' | 'failed' | 'applied' | 'rolled_back';

// A node in the evolution DAG
export interface EvolutionNode {
  id: string;
  type: NodeType;
  status: ProposalStatus;
  timestamp: string;

  // Code change information
  proposal: {
    description: string;
    reasoning: string;
    patches: Array<{
      file: string;
      search: string;
      replace: string;
    }>;
    affectedFiles: string[];
    focus: string;
    priority: 'high' | 'medium' | 'low';
  };

  // Scoring
  scores: {
    confidence: number;        // Initial AI confidence (0-1)
    simplicity: number;        // Code simplicity score (0-1)
    testPassRate: number;      // Test pass rate (0-1)
    pathScore: number;         // Aggregated score across all paths (0-1)
    humanPreference?: number;  // Optional human rating (0-1)
  };

  // Test results
  testResult?: {
    passed: boolean;
    passedCount: number;
    failedCount: number;
    duration: number;
    output: string;
  };

  // Lineage
  parents: string[];          // IDs of parent nodes
  children: string[];         // IDs of child nodes

  // Git integration
  commitHash?: string;

  // Feedback for refinement
  feedback?: string[];
  refinements: string[];      // IDs of refinement attempts
}

// Edge in the DAG
export interface EvolutionEdge {
  id: string;
  from: string;
  to: string;
  type: 'derives' | 'refines' | 'merges' | 'replaces';
  timestamp: string;
}

// The complete evolution graph
export interface EvolutionGraphData {
  nodes: Map<string, EvolutionNode>;
  edges: Map<string, EvolutionEdge>;
  baselines: Set<string>;     // Root nodes (original code states)
  activeNodes: Set<string>;   // Currently applied nodes
  archive: Set<string>;       // Historical nodes kept for reference
}

/**
 * EvolutionGraph - Manages the DAG of all evolution alternatives
 */
export class EvolutionGraph {
  private data: EvolutionGraphData;
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = {
      nodes: new Map(),
      edges: new Map(),
      baselines: new Set(),
      activeNodes: new Set(),
      archive: new Set(),
    };
  }

  /**
   * Load graph from disk
   */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const raw = JSON.parse(content);

      this.data.nodes = new Map(Object.entries(raw.nodes || {}));
      this.data.edges = new Map(Object.entries(raw.edges || {}));
      this.data.baselines = new Set(raw.baselines || []);
      this.data.activeNodes = new Set(raw.activeNodes || []);
      this.data.archive = new Set(raw.archive || []);

      // Repair any structural issues
      await this.repair();
    } catch {
      // No existing file, start fresh
      this.data = {
        nodes: new Map(),
        edges: new Map(),
        baselines: new Set(),
        activeNodes: new Set(),
        archive: new Set(),
      };
    }
  }

  /**
   * Save graph to disk
   */
  async save(): Promise<void> {
    const raw = {
      nodes: Object.fromEntries(this.data.nodes),
      edges: Object.fromEntries(this.data.edges),
      baselines: Array.from(this.data.baselines),
      activeNodes: Array.from(this.data.activeNodes),
      archive: Array.from(this.data.archive),
    };

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(raw, null, 2));
  }

  /**
   * Add a baseline node (original code state)
   */
  addBaseline(description: string, files: string[]): string {
    const id = `baseline-${randomUUID().substring(0, 8)}`;

    const node: EvolutionNode = {
      id,
      type: 'baseline',
      status: 'applied',
      timestamp: new Date().toISOString(),
      proposal: {
        description,
        reasoning: 'Original baseline state',
        patches: [],
        affectedFiles: files,
        focus: 'stability',
        priority: 'high',
      },
      scores: {
        confidence: 1.0,
        simplicity: 1.0,
        testPassRate: 1.0,
        pathScore: 1.0,
      },
      parents: [],
      children: [],
      refinements: [],
    };

    this.data.nodes.set(id, node);
    this.data.baselines.add(id);
    this.data.activeNodes.add(id);

    return id;
  }

  /**
   * Add a proposal node
   */
  addProposal(
    proposal: EvolutionNode['proposal'],
    parents: string[],
    scores: Partial<EvolutionNode['scores']> = {}
  ): string {
    const id = `proposal-${randomUUID().substring(0, 8)}`;

    const node: EvolutionNode = {
      id,
      type: 'proposal',
      status: 'pending',
      timestamp: new Date().toISOString(),
      proposal,
      scores: {
        confidence: scores.confidence ?? 0.5,
        simplicity: scores.simplicity ?? 0.5,
        testPassRate: 0,
        pathScore: scores.confidence ?? 0.5,
      },
      parents,
      children: [],
      refinements: [],
    };

    this.data.nodes.set(id, node);

    // Add edges from parents
    for (const parentId of parents) {
      this.addEdge(parentId, id, 'derives');
    }

    return id;
  }

  /**
   * Add an edge between nodes
   */
  addEdge(from: string, to: string, type: EvolutionEdge['type']): string {
    const id = `edge-${randomUUID().substring(0, 8)}`;

    const edge: EvolutionEdge = {
      id,
      from,
      to,
      type,
      timestamp: new Date().toISOString(),
    };

    this.data.edges.set(id, edge);

    // Update parent/child references
    const fromNode = this.data.nodes.get(from);
    const toNode = this.data.nodes.get(to);

    if (fromNode) {
      fromNode.children.push(to);
    }
    if (toNode) {
      toNode.parents.push(from);
    }

    return id;
  }

  /**
   * Update node status
   */
  updateStatus(nodeId: string, status: ProposalStatus): void {
    const node = this.data.nodes.get(nodeId);
    if (node) {
      node.status = status;
    }
  }

  /**
   * Update node scores
   */
  updateScores(nodeId: string, scores: Partial<EvolutionNode['scores']>): void {
    const node = this.data.nodes.get(nodeId);
    if (node) {
      node.scores = { ...node.scores, ...scores };
      // Recalculate path score
      this.recalculatePathScore(nodeId);
    }
  }

  /**
   * Add test result to node
   */
  addTestResult(nodeId: string, result: EvolutionNode['testResult']): void {
    const node = this.data.nodes.get(nodeId);
    if (node) {
      node.testResult = result;
      node.status = result?.passed ? 'passed' : 'failed';
      if (result) {
        node.scores.testPassRate = result.passedCount / Math.max(result.passedCount + result.failedCount, 1);
      }
    }
  }

  /**
   * Add feedback for refinement
   */
  addFeedback(nodeId: string, feedback: string): void {
    const node = this.data.nodes.get(nodeId);
    if (node) {
      node.feedback = node.feedback || [];
      node.feedback.push(feedback);
    }
  }

  /**
   * Create a refinement node from failed proposal
   */
  createRefinement(parentId: string, newProposal: EvolutionNode['proposal']): string {
    const parent = this.data.nodes.get(parentId);
    if (!parent) {
      throw new Error(`Parent node not found: ${parentId}`);
    }

    const id = `refinement-${randomUUID().substring(0, 8)}`;

    const node: EvolutionNode = {
      id,
      type: 'refinement',
      status: 'pending',
      timestamp: new Date().toISOString(),
      proposal: newProposal,
      scores: {
        confidence: 0.5,
        simplicity: 0.5,
        testPassRate: 0,
        pathScore: 0.5,
      },
      parents: [parentId],
      children: [],
      refinements: [],
    };

    this.data.nodes.set(id, node);
    this.addEdge(parentId, id, 'refines');

    // Track refinements
    parent.refinements.push(id);

    return id;
  }

  /**
   * Mark node as applied (active)
   */
  markApplied(nodeId: string, commitHash?: string): void {
    const node = this.data.nodes.get(nodeId);
    if (node) {
      node.status = 'applied';
      node.commitHash = commitHash;

      // Deactivate siblings (only one path active at a time)
      for (const parentId of node.parents) {
        const parent = this.data.nodes.get(parentId);
        if (parent) {
          for (const siblingId of parent.children) {
            if (siblingId !== nodeId) {
              this.data.activeNodes.delete(siblingId);
            }
          }
        }
      }

      this.data.activeNodes.add(nodeId);
    }
  }

  /**
   * Rollback to a previous node
   */
  rollback(toNodeId: string): string[] {
    const target = this.data.nodes.get(toNodeId);
    if (!target) {
      throw new Error(`Target node not found: ${toNodeId}`);
    }

    const rolledBack: string[] = [];

    // Find all nodes that need to be rolled back
    for (const [id, node] of this.data.nodes) {
      if (node.status === 'applied' && !this.data.baselines.has(id)) {
        // Check if this node is in the path to current state
        if (this.isInActivePath(id) && !this.isAncestor(id, toNodeId)) {
          node.status = 'rolled_back';
          this.data.activeNodes.delete(id);
          rolledBack.push(id);
        }
      }
    }

    // Activate target node
    target.status = 'applied';
    this.data.activeNodes.add(toNodeId);

    return rolledBack;
  }

  /**
   * Get all paths from baseline to a node
   */
  getAllPaths(nodeId: string): string[][] {
    const node = this.data.nodes.get(nodeId);
    if (!node) return [];

    if (node.type === 'baseline' || node.parents.length === 0) {
      return [[nodeId]];
    }

    const paths: string[][] = [];
    for (const parentId of node.parents) {
      const parentPaths = this.getAllPaths(parentId);
      for (const path of parentPaths) {
        paths.push([...path, nodeId]);
      }
    }

    return paths;
  }

  /**
   * Calculate path score - aggregate score across all paths
   */
  private recalculatePathScore(nodeId: string): void {
    const node = this.data.nodes.get(nodeId);
    if (!node) return;

    const paths = this.getAllPaths(nodeId);
    if (paths.length === 0) {
      node.scores.pathScore = node.scores.confidence;
      return;
    }

    // Average score across all paths
    let totalScore = 0;
    for (const path of paths) {
      const pathScore = this.calculatePathQuality(path);
      totalScore += pathScore;
    }

    node.scores.pathScore = totalScore / paths.length;
  }

  /**
   * Calculate quality of a single path
   */
  private calculatePathQuality(path: string[]): number {
    if (path.length === 0) return 0;

    let score = 0;
    let weight = 1;

    // Weight recent nodes more heavily
    for (let i = path.length - 1; i >= 0; i--) {
      const node = this.data.nodes.get(path[i]);
      if (node) {
        const nodeScore = (
          node.scores.confidence * 0.4 +
          node.scores.simplicity * 0.3 +
          node.scores.testPassRate * 0.3
        );
        score += nodeScore * weight;
        weight *= 0.9; // Decay weight for older nodes
      }
    }

    return score / path.length;
  }

  /**
   * Check if a node is an ancestor of another
   */
  private isAncestor(potentialAncestor: string, nodeId: string): boolean {
    const node = this.data.nodes.get(nodeId);
    if (!node) return false;

    if (node.parents.includes(potentialAncestor)) {
      return true;
    }

    return node.parents.some(parent => this.isAncestor(potentialAncestor, parent));
  }

  /**
   * Check if a node is in the active path
   */
  private isInActivePath(nodeId: string): boolean {
    for (const activeId of this.data.activeNodes) {
      if (this.isAncestor(nodeId, activeId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Repair structural issues (acyclicity, missing references)
   */
  private async repair(): Promise<void> {
    const toRemove: string[] = [];

    // 1. Check for cycles (should not exist in a proper DAG)
    for (const [id, node] of this.data.nodes) {
      if (this.hasCycle(id, new Set())) {
        console.warn(`[EvolutionGraph] Cycle detected at ${id}, removing...`);
        toRemove.push(id);
      }
    }

    // 2. Remove dangling references
    for (const [id, node] of this.data.nodes) {
      node.parents = node.parents.filter(p => this.data.nodes.has(p));
      node.children = node.children.filter(c => this.data.nodes.has(c));
    }

    // Remove broken nodes
    for (const id of toRemove) {
      this.data.nodes.delete(id);
      this.data.activeNodes.delete(id);
      this.data.archive.delete(id);
    }
  }

  /**
   * Detect cycles using DFS
   */
  private hasCycle(nodeId: string, visited: Set<string>, path: Set<string> = new Set()): boolean {
    if (path.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;

    visited.add(nodeId);
    path.add(nodeId);

    const node = this.data.nodes.get(nodeId);
    if (node) {
      for (const childId of node.children) {
        if (this.hasCycle(childId, visited, path)) {
          return true;
        }
      }
    }

    path.delete(nodeId);
    return false;
  }

  /**
   * Get best proposals sorted by path score
   */
  getBestProposals(limit: number = 10): EvolutionNode[] {
    const proposals = Array.from(this.data.nodes.values())
      .filter(n => n.type === 'proposal' || n.type === 'refinement')
      .filter(n => n.status === 'passed' || n.status === 'pending')
      .sort((a, b) => b.scores.pathScore - a.scores.pathScore);

    return proposals.slice(0, limit);
  }

  /**
   * Get failed proposals for potential recombination
   */
  getFailedProposals(): EvolutionNode[] {
    return Array.from(this.data.nodes.values())
      .filter(n => n.status === 'failed' && n.feedback && n.feedback.length > 0);
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalNodes: number;
    proposals: number;
    refinements: number;
    passed: number;
    failed: number;
    applied: number;
    activePaths: number;
  } {
    const nodes = Array.from(this.data.nodes.values());
    return {
      totalNodes: nodes.length,
      proposals: nodes.filter(n => n.type === 'proposal').length,
      refinements: nodes.filter(n => n.type === 'refinement').length,
      passed: nodes.filter(n => n.status === 'passed').length,
      failed: nodes.filter(n => n.status === 'failed').length,
      applied: nodes.filter(n => n.status === 'applied').length,
      activePaths: this.data.activeNodes.size,
    };
  }

  /**
   * Export graph for visualization
   */
  exportForVisualization(): { nodes: EvolutionNode[]; edges: EvolutionEdge[] } {
    return {
      nodes: Array.from(this.data.nodes.values()),
      edges: Array.from(this.data.edges.values()),
    };
  }
}
