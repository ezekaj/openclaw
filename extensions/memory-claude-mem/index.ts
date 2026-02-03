/**
 * Claude-Mem Memory Extension for Moltbot
 * ========================================
 * Provides persistent memory across sessions using claude-mem's
 * SQLite + ChromaDB vector storage system.
 *
 * Integration points:
 * - Connects to claude-mem's HTTP API (default: localhost:37777)
 * - Provides memory_search and memory_get tools
 * - Stores observations from Moltbot conversations
 * - Enables cross-session context retrieval
 *
 * Based on: github.com/thedotmack/claude-mem
 */

import type { MoltbotPluginApi, PluginContext } from "clawdbot/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { ClaudeMemClient, type Observation, type SearchResult } from "./client.js";

const configSchema = Type.Object({
  apiUrl: Type.Optional(
    Type.String({
      description: "Claude-mem API URL (default: http://localhost:37777)",
      default: "http://localhost:37777",
    })
  ),
  enabled: Type.Optional(
    Type.Boolean({
      description: "Enable claude-mem integration",
      default: true,
    })
  ),
  maxResults: Type.Optional(
    Type.Number({
      description: "Maximum search results to return",
      default: 10,
    })
  ),
  autoCapture: Type.Optional(
    Type.Boolean({
      description: "Automatically capture observations from conversations",
      default: true,
    })
  ),
});

type ClaudeMemConfig = typeof configSchema.static;

const claudeMemPlugin = {
  id: "memory-claude-mem",
  name: "Memory (Claude-Mem)",
  description: "Persistent memory via claude-mem with semantic search",
  kind: "memory",
  configSchema,

  register(api: MoltbotPluginApi) {
    // Register memory search tool
    api.registerTool(
      (ctx: PluginContext<ClaudeMemConfig>) => {
        const config = ctx.config ?? {};
        if (config.enabled === false) return null;

        const client = new ClaudeMemClient(config.apiUrl);

        return {
          name: "claudemem_search",
          description: `Search persistent memory from claude-mem.
Uses semantic search across past observations, decisions, and learnings.
Returns relevant context from previous sessions.`,
          inputSchema: Type.Object({
            query: Type.String({ description: "Search query for memory retrieval" }),
            limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
            type: Type.Optional(
              Type.String({
                description: "Filter by observation type: decision, bugfix, feature, refactor, discovery, change",
              })
            ),
          }),
          async execute({ query, limit, type }) {
            const results = await client.search(query, {
              limit: limit ?? config.maxResults ?? 10,
              type,
            });

            if (results.length === 0) {
              return { content: "No relevant memories found." };
            }

            const formatted = results
              .map((r, i) => {
                const obs = r.observation;
                return `[${i + 1}] ${obs.type ?? "observation"} (${obs.created_at?.split("T")[0] ?? "unknown"})
   ${obs.content?.slice(0, 200) ?? ""}${(obs.content?.length ?? 0) > 200 ? "..." : ""}
   Concepts: ${obs.concepts?.join(", ") ?? "none"}
   Files: ${obs.files?.join(", ") ?? "none"}`;
              })
              .join("\n\n");

            return {
              content: `Found ${results.length} relevant memories:\n\n${formatted}`,
              data: results,
            };
          },
        };
      },
      { names: ["claudemem_search"] }
    );

    // Register memory timeline tool
    api.registerTool(
      (ctx: PluginContext<ClaudeMemConfig>) => {
        const config = ctx.config ?? {};
        if (config.enabled === false) return null;

        const client = new ClaudeMemClient(config.apiUrl);

        return {
          name: "claudemem_timeline",
          description: `Get chronological timeline of observations around a specific point.
Useful for understanding the sequence of events and decisions.`,
          inputSchema: Type.Object({
            observationId: Type.Optional(
              Type.Number({ description: "Center timeline around this observation ID" })
            ),
            limit: Type.Optional(Type.Number({ description: "Number of observations to return" })),
          }),
          async execute({ observationId, limit }) {
            const timeline = await client.getTimeline({
              observationId,
              limit: limit ?? 20,
            });

            if (timeline.length === 0) {
              return { content: "No timeline data available." };
            }

            const formatted = timeline
              .map((obs) => {
                return `[${obs.id}] ${obs.created_at?.split("T")[0] ?? ""} | ${obs.type ?? "obs"}: ${obs.content?.slice(0, 100) ?? ""}`;
              })
              .join("\n");

            return {
              content: `Timeline (${timeline.length} observations):\n\n${formatted}`,
              data: timeline,
            };
          },
        };
      },
      { names: ["claudemem_timeline"] }
    );

    // Register memory context injection tool
    api.registerTool(
      (ctx: PluginContext<ClaudeMemConfig>) => {
        const config = ctx.config ?? {};
        if (config.enabled === false) return null;

        const client = new ClaudeMemClient(config.apiUrl);

        return {
          name: "claudemem_context",
          description: `Get recent context for session injection.
Returns the most relevant recent observations for the current context.`,
          inputSchema: Type.Object({
            projectPath: Type.Optional(
              Type.String({ description: "Filter by project path" })
            ),
            limit: Type.Optional(Type.Number({ description: "Max observations to return" })),
          }),
          async execute({ projectPath, limit }) {
            const context = await client.getRecentContext({
              projectPath,
              limit: limit ?? 5,
            });

            if (!context || context.length === 0) {
              return { content: "No recent context available." };
            }

            const formatted = context
              .map((obs) => `• ${obs.type ?? "obs"}: ${obs.content?.slice(0, 150) ?? ""}`)
              .join("\n");

            return {
              content: `Recent context:\n\n${formatted}`,
              data: context,
            };
          },
        };
      },
      { names: ["claudemem_context"] }
    );

    // Register observation capture hook
    api.registerHook?.(
      "afterAgentResponse",
      async (ctx: PluginContext<ClaudeMemConfig>, event) => {
        const config = ctx.config ?? {};
        if (config.enabled === false || config.autoCapture === false) return;

        const client = new ClaudeMemClient(config.apiUrl);

        // Only capture significant responses
        const response = event.response;
        if (!response || response.length < 100) return;

        try {
          await client.addObservation({
            type: "discovery",
            content: response.slice(0, 1000),
            concepts: [],
            files: [],
            sessionId: event.sessionId,
          });
        } catch (err) {
          // Silent fail - don't break the response flow
          console.debug("Failed to capture observation:", err);
        }
      }
    );

    // Register CLI commands
    api.registerCli(
      ({ program }) => {
        const claudemem = program
          .command("claudemem")
          .description("Claude-mem memory management");

        claudemem
          .command("status")
          .description("Check claude-mem service status")
          .action(async () => {
            const client = new ClaudeMemClient();
            const status = await client.getStatus();
            console.log("Claude-mem status:", status);
          });

        claudemem
          .command("search <query>")
          .description("Search memory")
          .option("-l, --limit <n>", "Max results", "10")
          .option("-t, --type <type>", "Filter by type")
          .action(async (query: string, opts: { limit: string; type?: string }) => {
            const client = new ClaudeMemClient();
            const results = await client.search(query, {
              limit: parseInt(opts.limit, 10),
              type: opts.type,
            });
            console.log(`Found ${results.length} results:`);
            results.forEach((r, i) => {
              console.log(`\n[${i + 1}] ${r.observation.type}: ${r.observation.content?.slice(0, 100)}`);
            });
          });

        claudemem
          .command("stats")
          .description("Show memory statistics")
          .action(async () => {
            const client = new ClaudeMemClient();
            const stats = await client.getStats();
            console.log("Memory statistics:", stats);
          });
      },
      { commands: ["claudemem"] }
    );
  },
};

export default claudeMemPlugin;
