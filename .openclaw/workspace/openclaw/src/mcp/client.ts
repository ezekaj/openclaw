import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";

// MCP Protocol Constants
const MCP_PROTOCOL_VERSION = "2024-11-05";

const DEFAULT_CLIENT_CAPABILITIES = {
  sampling: { tools: true, createMessage: true },
  elicitation: { url: true, form: true },
  roots: { list: true },
} as const;

const CLIENT_INFO = { name: "OpenClaw", version: "1.0.0" } as const;

/**
 * MCP Capabilities - Matches Claude Code capability structure
 *
 * Client Capabilities:
 * - sampling: Can handle tools during model sampling/generation
 * - elicitation: Can handle user input elicitation (URL/form)
 * - roots: Can provide filesystem roots
 *
 * Server Capabilities:
 * - tools: Tool support with list change notifications
 * - resources: Resource support with subscribe and list changes
 * - prompts: Prompt support with list change notifications
 */
export interface McpCapabilities {
  // Server capabilities (what the server supports)
  tools?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
  // Client capabilities (what the client supports)
  sampling?: {
    tools?: boolean; // Can handle tools during sampling (Line 27381, 27655)
    createMessage?: boolean; // Supports sampling/createMessage method (Line 27466)
  };
  elicitation?: {
    url?: boolean; // Supports URL elicitation (Line 27413)
    form?: boolean; // Supports form elicitation (Line 27417)
  };
  roots?: {
    list?: boolean; // Supports roots/list method
  };
}

// MCP Tool Definition
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// MCP Tool Result
export interface McpToolResult {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
    resource?: {
      uri: string;
      mimeType?: string;
      text?: string;
      blob?: string;
    };
  }>;
  isError?: boolean;
}

// JSON-RPC message types
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// Tools list response
interface ToolsListResponse {
  tools: McpTool[];
}

// MCP Server Configuration
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
}

// MCP Client Events
export interface McpEvents {
  "server:connected": { name: string; capabilities: McpCapabilities };
  "server:disconnected": { name: string; reason: string };
  "tools:changed": { serverName: string };
  error: { serverName: string; error: Error };
}

class McpServer extends EventEmitter {
  private process: ChildProcess | null = null;
  private messageId = 0;
  private pendingRequests: Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  > = new Map();
  private capabilities: McpCapabilities = {};
  private tools: McpTool[] = [];
  private connected = false;
  private initPromise: Promise<void> | null = null;

  constructor(
    public readonly name: string,
    private readonly config: McpServerConfig,
  ) {
    super();
  }

  async initialize(): Promise<void> {
    // Already connected
    if (this.connected) {
      return;
    }

    // Wait for ongoing initialization
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {

    try {
      this.process = spawn(this.config.command, this.config.args || [], {
        env: { ...process.env, ...this.config.env },
        cwd: this.config.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Handle stdout
      let buffer = "";
      this.process.stdout?.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            try {
              const message = JSON.parse(line);
              this.handleMessage(message);
            } catch (error) {
              this.emit("error", {
                serverName: this.name,
                error: new Error(`Failed to parse message: ${error}`),
              });
            }
          }
        }
      });

      // Handle stderr (logging)
      this.process.stderr?.on("data", (data: Buffer) => {
        console.error(`[MCP ${this.name}]`, data.toString());
      });

      // Handle process exit
      this.process.on("exit", (code: number | null) => {
        this.connected = false;
        this.initPromise = null;
        this.emit("server:disconnected", { name: this.name, reason: `Exited with code ${code}` });

        // Reject all pending requests
        const pendingEntries = Array.from(this.pendingRequests.entries());
        for (const [id, { reject }] of pendingEntries) {
          reject(new Error(`Server exited with code ${code}`));
          this.pendingRequests.delete(id);
        }
      });

      // Handle process error
      this.process.on("error", (error: Error) => {
        this.connected = false;
        this.initPromise = null;
        this.emit("error", { serverName: this.name, error });
      });

      const initResponse = (await this.sendRequest("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: DEFAULT_CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO,
      })) as { capabilities?: McpCapabilities };

      // Store server capabilities
      if (initResponse?.capabilities) {
        this.capabilities = initResponse.capabilities;
      }

      // Send initialized notification
      await this.sendNotification("notifications/initialized");

      this.connected = true;

      // Fetch tools
      await this.refreshTools();

      this.emit("server:connected", { name: this.name, capabilities: this.capabilities });
    } catch (error) {
      // Clean up on failure
      if (this.process) {
        this.process.kill();
        this.process = null;
      }
      throw error;
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if ("id" in message && ("result" in message || "error" in message)) {
      // This is a response to a request
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || "Unknown error"));
        } else {
          pending.resolve(message.result);
        }
      }
    } else if ("method" in message) {
      // This is a request or notification from server
      if (message.method === "notifications/tools/list_changed") {
        this.refreshTools()
          .then(() => {
            this.emit("tools:changed", { serverName: this.name });
          })
          .catch((error) => {
            this.emit("error", {
              serverName: this.name,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          });
      }
    }
  }

  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.process) {
      throw new Error("Server not connected");
    }

    const id = ++this.messageId;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, this.config.timeout ?? 30000);

      this.pendingRequests.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });

      const line = JSON.stringify(message) + "\n";
      this.process?.stdin?.write(line, (error) => {
        if (error) {
          this.pendingRequests.delete(id);
          clearTimeout(timeoutId);
          reject(error);
        }
      });
    });
  }

  private async sendNotification(method: string, params?: unknown): Promise<void> {
    if (!this.process) {
      throw new Error("Server not connected");
    }

    const message = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const line = JSON.stringify(message) + "\n";
    const timeout = this.config.timeout ?? 30000;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Notification ${method} timed out`));
      }, timeout);

      this.process?.stdin?.write(line, (error) => {
        clearTimeout(timeoutId);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async refreshTools(): Promise<void> {
    const response = (await this.sendRequest("tools/list")) as ToolsListResponse;
    this.tools = response?.tools ?? [];
  }

  async listTools(): Promise<McpTool[]> {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    // Check if server supports tools
    if (!this.capabilities.tools) {
      throw new Error("Server does not support tools capability");
    }

    const result = (await this.sendRequest("tools/call", {
      name,
      arguments: args,
    })) as McpToolResult;
    return result;
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      // Remove all listeners to prevent further callbacks
      this.process.removeAllListeners();
      this.process.kill();
      this.process = null;
    }

    // Reject any pending requests
    for (const [id, { reject }] of Array.from(this.pendingRequests.entries())) {
      reject(new Error("Server disconnected"));
      this.pendingRequests.delete(id);
    }

    this.connected = false;
    this.initPromise = null;
  }
}

// Main MCP Client
export class McpClient extends EventEmitter {
  private servers: Map<string, McpServer> = new Map();
  private tools: Map<string, { server: McpServer; tool: McpTool }> = new Map();

  private removeServerTools(server: McpServer): void {
    const entries = Array.from(this.tools.entries());
    for (const [key, value] of entries) {
      if (value.server === server) {
        this.tools.delete(key);
      }
    }
  }

  private registerServerTools(name: string, server: McpServer, tools: McpTool[]): void {
    for (const tool of tools) {
      this.tools.set(`${name}/${tool.name}`, { server, tool });
    }
  }

  async connectServer(name: string, config: McpServerConfig): Promise<void> {
    if (this.servers.has(name)) {
      throw new Error(`Server already connected: ${name}`);
    }

    const server = new McpServer(name, config);

    server.on("server:connected", (event) => this.emit("server:connected", event));

    server.on("server:disconnected", (event) => {
      this.emit("server:disconnected", event);
      this.removeServerTools(server);
    });

    server.on("tools:changed", async (event) => {
      try {
        this.removeServerTools(server);
        const tools = await server.listTools();
        this.registerServerTools(name, server, tools);
        this.emit("tools:changed", event);
      } catch (error) {
        this.emit("error", {
          serverName: name,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    });

    server.on("error", (event) => this.emit("error", event));

    this.servers.set(name, server);
    await server.initialize();
    const tools = await server.listTools();
    this.registerServerTools(name, server, tools);
  }

  /**
   * Connect to an HTTP-based MCP server.
   * @throws Error - HTTP transport is not yet implemented
   */
  async connectHttpServer(
    _name: string,
    _config: { url: string; headers?: Record<string, string>; timeout?: number },
  ): Promise<void> {
    throw new Error("HTTP MCP transport is not yet implemented");
  }

  async disconnectServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (server) {
      await server.disconnect();
      this.servers.delete(name);
      this.removeServerTools(server);
    }
  }

  async callTool(fullName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const entry = this.tools.get(fullName);

    if (!entry) {
      throw new Error(`Tool not found: ${fullName}`);
    }

    // Extract tool name from full name (format: "serverName/toolName")
    const toolName = fullName.includes("/") ? fullName.split("/")[1] : fullName;
    if (!toolName) {
      throw new Error(`Invalid tool name format: ${fullName}`);
    }

    return await entry.server.callTool(toolName, args);
  }

  listTools(): Array<{ name: string; description?: string; server: string }> {
    return Array.from(this.tools.entries()).map(([key, value]) => ({
      name: key,
      description: value.tool.description,
      server: value.server.name,
    }));
  }

  getTool(name: string): McpTool | undefined {
    return this.tools.get(name)?.tool;
  }

  getServers(): string[] {
    return Array.from(this.servers.keys());
  }

  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.servers.values()).map((server) =>
      server.disconnect().catch((error) => {
        // Log but don't throw - we want to disconnect all servers
        console.error(`Error disconnecting server:`, error);
      }),
    );
    await Promise.all(disconnectPromises);
    this.servers.clear();
    this.tools.clear();
  }
}
