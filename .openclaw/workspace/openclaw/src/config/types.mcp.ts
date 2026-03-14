/**
 * MCP (Model Context Protocol) Server Configuration
 *
 * Defines how to launch and configure MCP servers that provide
 * additional tools to the agent (vision, browser, file access, etc.)
 */

/** stdio-based local MCP server */
export type McpStdioServerConfig = {
  /** Command to start the MCP server (e.g., "npx", "node", "python"). */
  command: string;
  /** Arguments to pass to the command. */
  args?: string[];
  /** Environment variables to set for the MCP server process. */
  env?: Record<string, string>;
  /** Working directory for the MCP server. */
  cwd?: string;
  /** Whether this MCP server is enabled. Default: true. */
  enabled?: boolean;
};

/** HTTP-based remote MCP server */
export type McpHttpServerConfig = {
  /** URL of the remote MCP server endpoint. */
  url: string;
  /** HTTP headers to include in requests (e.g., Authorization). */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. Default: 30000. */
  timeout?: number;
  /** Whether this MCP server is enabled. Default: true. */
  enabled?: boolean;
};

/** Union of all MCP server config types */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** Type guard: check if config is stdio-based */
export function isStdioConfig(config: McpServerConfig): config is McpStdioServerConfig {
  return 'command' in config;
}

/** Type guard: check if config is HTTP-based */
export function isHttpConfig(config: McpServerConfig): config is McpHttpServerConfig {
  return 'url' in config;
}
