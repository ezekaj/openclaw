/**
 * Claude-Mem API Client
 * ======================
 * HTTP client for interacting with claude-mem's REST API.
 *
 * API runs on localhost:37777 by default.
 * See: github.com/thedotmack/claude-mem
 */

export interface Observation {
  id?: number;
  type?: "decision" | "bugfix" | "feature" | "refactor" | "discovery" | "change";
  content?: string;
  concepts?: string[];
  files?: string[];
  created_at?: string;
  session_id?: string;
  prompt_number?: number;
}

export interface SearchResult {
  observation: Observation;
  score?: number;
  highlights?: string[];
}

export interface SessionSummary {
  id?: string;
  request?: string;
  investigated?: string[];
  learned?: string[];
  completed?: string[];
  next_steps?: string[];
  created_at?: string;
}

export interface SearchOptions {
  limit?: number;
  type?: string;
  projectPath?: string;
  maxDate?: string;
}

export interface TimelineOptions {
  observationId?: number;
  limit?: number;
  before?: boolean;
  after?: boolean;
}

export interface ContextOptions {
  projectPath?: string;
  limit?: number;
}

export interface AddObservationParams {
  type: Observation["type"];
  content: string;
  concepts?: string[];
  files?: string[];
  sessionId?: string;
}

export class ClaudeMemClient {
  private baseUrl: string;

  constructor(baseUrl = "http://localhost:37777") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /**
   * Check if claude-mem service is running
   */
  async getStatus(): Promise<{ running: boolean; version?: string; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });

      if (res.ok) {
        const data = await res.json();
        return { running: true, version: data.version };
      }

      return { running: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return {
        running: false,
        error: err instanceof Error ? err.message : "Connection failed",
      };
    }
  }

  /**
   * Search memory using semantic search
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    try {
      const params = new URLSearchParams({
        query,
        ...(options.limit && { limit: String(options.limit) }),
        ...(options.type && { type: options.type }),
        ...(options.maxDate && { max_date: options.maxDate }),
      });

      const res = await fetch(`${this.baseUrl}/api/search?${params}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        throw new Error(`Search failed: ${res.status}`);
      }

      const data = await res.json();
      return data.results ?? data ?? [];
    } catch (err) {
      console.error("Claude-mem search error:", err);
      return [];
    }
  }

  /**
   * Get timeline of observations
   */
  async getTimeline(options: TimelineOptions = {}): Promise<Observation[]> {
    try {
      const params = new URLSearchParams({
        ...(options.observationId && { observation_id: String(options.observationId) }),
        ...(options.limit && { limit: String(options.limit) }),
      });

      const res = await fetch(`${this.baseUrl}/api/timeline?${params}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        throw new Error(`Timeline failed: ${res.status}`);
      }

      const data = await res.json();
      return data.observations ?? data ?? [];
    } catch (err) {
      console.error("Claude-mem timeline error:", err);
      return [];
    }
  }

  /**
   * Get recent context for session injection
   */
  async getRecentContext(options: ContextOptions = {}): Promise<Observation[]> {
    try {
      const params = new URLSearchParams({
        ...(options.projectPath && { project_path: options.projectPath }),
        ...(options.limit && { limit: String(options.limit) }),
      });

      const res = await fetch(`${this.baseUrl}/api/context/recent?${params}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        // Fallback to inject endpoint
        const injectRes = await fetch(`${this.baseUrl}/api/context/inject?${params}`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(10000),
        });

        if (!injectRes.ok) {
          throw new Error(`Context failed: ${res.status}`);
        }

        const data = await injectRes.json();
        return data.observations ?? data ?? [];
      }

      const data = await res.json();
      return data.observations ?? data ?? [];
    } catch (err) {
      console.error("Claude-mem context error:", err);
      return [];
    }
  }

  /**
   * Add a new observation
   */
  async addObservation(params: AddObservationParams): Promise<{ success: boolean; id?: number }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions/observations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: params.type,
          content: params.content,
          concepts: params.concepts ?? [],
          files: params.files ?? [],
          session_id: params.sessionId,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        throw new Error(`Add observation failed: ${res.status}`);
      }

      const data = await res.json();
      return { success: true, id: data.id };
    } catch (err) {
      console.error("Claude-mem add observation error:", err);
      return { success: false };
    }
  }

  /**
   * Get memory statistics
   */
  async getStats(): Promise<{
    totalObservations?: number;
    totalSessions?: number;
    lastUpdated?: string;
  }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/stats`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        throw new Error(`Stats failed: ${res.status}`);
      }

      return await res.json();
    } catch (err) {
      console.error("Claude-mem stats error:", err);
      return {};
    }
  }

  /**
   * Search by observation type
   */
  async searchByType(
    type: Observation["type"],
    options: { limit?: number } = {}
  ): Promise<Observation[]> {
    try {
      const params = new URLSearchParams({
        type: type ?? "discovery",
        ...(options.limit && { limit: String(options.limit) }),
      });

      const res = await fetch(`${this.baseUrl}/api/search/by-type?${params}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        throw new Error(`Search by type failed: ${res.status}`);
      }

      const data = await res.json();
      return data.observations ?? data ?? [];
    } catch (err) {
      console.error("Claude-mem search by type error:", err);
      return [];
    }
  }

  /**
   * Get decisions (filtered observations)
   */
  async getDecisions(limit = 20): Promise<Observation[]> {
    return this.searchByType("decision", { limit });
  }

  /**
   * Get how-it-works explanations
   */
  async getHowItWorks(query: string): Promise<SearchResult[]> {
    try {
      const params = new URLSearchParams({ query });

      const res = await fetch(`${this.baseUrl}/api/how-it-works?${params}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        // Fallback to regular search
        return this.search(query, { limit: 10 });
      }

      const data = await res.json();
      return data.results ?? data ?? [];
    } catch (err) {
      console.error("Claude-mem how-it-works error:", err);
      return [];
    }
  }
}

export default ClaudeMemClient;
