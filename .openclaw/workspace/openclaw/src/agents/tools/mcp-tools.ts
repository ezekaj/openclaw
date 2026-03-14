/**
 * MCP Tools Integration
 *
 * Connects MCP (Model Context Protocol) servers to OpenClaw agents,
 * exposing their tools for use in agent sessions.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { isStdioConfig, isHttpConfig } from "../../config/types.mcp.js";
import { McpClient, type McpTool } from "../../mcp/client.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const log = createSubsystemLogger("mcp-tools");

// Global MCP client instance (shared across agent sessions)
let globalMcpClient: McpClient | null = null;
let clientInitPromise: Promise<void> | null = null;

/**
 * Initialize the global MCP client from config
 */
export async function initMcpClient(config?: OpenClawConfig): Promise<McpClient | null> {
  const mcpServers = config?.mcpServers;
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    return null;
  }

  // Return existing client if already initialized
  if (globalMcpClient) {
    return globalMcpClient;
  }

  // Wait for ongoing initialization
  if (clientInitPromise) {
    await clientInitPromise;
    return globalMcpClient;
  }

  // Start initialization
  clientInitPromise = (async () => {
    const client = new McpClient();

    for (const [name, serverConfig] of Object.entries(mcpServers)) {
      // Skip disabled servers
      if (serverConfig.enabled === false) {
        log.debug(`Skipping disabled MCP server: ${name}`);
        continue;
      }

      try {
        if (isStdioConfig(serverConfig)) {
          log.info(`Connecting stdio MCP server: ${name}`);
          await client.connectServer(name, {
            command: serverConfig.command,
            args: serverConfig.args,
            env: serverConfig.env,
            cwd: serverConfig.cwd,
          });
        } else if (isHttpConfig(serverConfig)) {
          log.info(`Connecting HTTP MCP server: ${name}`);
          await client.connectHttpServer(name, {
            url: serverConfig.url,
            headers: serverConfig.headers,
            timeout: serverConfig.timeout,
          });
        }
        log.info(`Connected MCP server: ${name}`);
      } catch (error) {
        log.error(`Failed to connect MCP server ${name}: ${error}`);
      }
    }

    globalMcpClient = client;
  })();

  await clientInitPromise;
  return globalMcpClient;
}

/**
 * Get the global MCP client
 */
export function getMcpClient(): McpClient | null {
  return globalMcpClient;
}

/**
 * Create an agent tool from an MCP tool
 */
function createMcpAgentTool(client: McpClient, serverName: string, tool: McpTool): AnyAgentTool {
  const fullName = `${serverName}/${tool.name}`;

  const properties: Record<string, ReturnType<typeof Type.Any>> = {};

  for (const [key, value] of Object.entries(tool.inputSchema.properties || {})) {
    const prop = value as { type?: string; description?: string };
    // Simple type mapping - could be more sophisticated
    if (prop.type === "string") {
      properties[key] = Type.String({ description: prop.description });
    } else if (prop.type === "number" || prop.type === "integer") {
      properties[key] = Type.Number({ description: prop.description });
    } else if (prop.type === "boolean") {
      properties[key] = Type.Boolean({ description: prop.description });
    } else if (prop.type === "array") {
      properties[key] = Type.Array(Type.Any(), { description: prop.description });
    } else {
      properties[key] = Type.Any({ description: prop.description });
    }
  }

  const schema = Type.Object(properties, {
    additionalProperties: false,
  });

  return {
    label: `MCP: ${tool.name}`,
    name: `mcp__${serverName}__${tool.name}`,
    description: tool.description || `MCP tool: ${fullName}`,
    parameters: schema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async call(args) {
      try {
        const result = await client.callTool(fullName, args as Record<string, unknown>);

        // Format result content
        const content = result.content
          .map((c) => {
            if (c.type === "text") {
              return c.text;
            } else if (c.type === "image") {
              return `[Image: ${c.mimeType || "image"}${c.data ? ` (${c.data.length} bytes base64)` : ""}]`;
            } else if (c.type === "resource") {
              return c.resource?.text || `[Resource: ${c.resource?.uri}]`;
            }
            return "[Unknown content type]";
          })
          .join("\n");

        if (result.isError) {
          return jsonResult({
            error: content,
            isError: true,
          });
        }

        return jsonResult({
          result: content,
        });
      } catch (error) {
        return jsonResult({
          error: error instanceof Error ? error.message : String(error),
          isError: true,
        });
      }
    },
  };
}

function buildToolsFromClient(client: McpClient): AnyAgentTool[] {
  const tools: AnyAgentTool[] = [];
  for (const toolInfo of client.listTools()) {
    const mcpTool = client.getTool(toolInfo.name);
    if (mcpTool) {
      tools.push(createMcpAgentTool(client, toolInfo.server, mcpTool));
    }
  }
  return tools;
}

/**
 * Create all MCP tools from the configured servers
 */
export async function createMcpTools(config?: OpenClawConfig): Promise<AnyAgentTool[]> {
  const client = await initMcpClient(config);
  if (!client) {
    return [];
  }

  const tools = buildToolsFromClient(client);
  log.info(`Created ${tools.length} MCP tools`);
  return tools;
}

/**
 * Create MCP tools synchronously from already-initialized client
 * Call initMcpClient first during agent startup
 */
export function createMcpToolsSync(): AnyAgentTool[] {
  if (!globalMcpClient) {
    return [];
  }
  return buildToolsFromClient(globalMcpClient);
}

/**
 * Shutdown MCP client and disconnect all servers
 */
export async function shutdownMcpClient(): Promise<void> {
  if (globalMcpClient) {
    await globalMcpClient.disconnectAll();
    globalMcpClient = null;
    clientInitPromise = null;
    log.info("MCP client shutdown");
  }
}
