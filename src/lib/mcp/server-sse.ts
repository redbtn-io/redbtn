/**
 * MCP Server Base Class - SSE Transport
 * Implements MCP protocol over HTTP with Server-Sent Events
 */

import express, { Request, Response } from 'express';
import { Server as HttpServer } from 'http';
import {
  ServerInfo,
  ServerCapabilities,
  Tool,
  CallToolResult,
  InitializeParams,
  InitializeResult,
  ToolsListResult,
  ToolCallParams,
  Resource,
  ResourceContents,
} from './types';

export abstract class McpServerSSE {
  protected app: express.Application;
  protected server: HttpServer | null = null;
  protected serverInfo: ServerInfo;
  protected capabilities: ServerCapabilities = {};
  protected tools: Map<string, Tool> = new Map();
  protected resources: Map<string, Resource> = new Map();
  private port: number;
  private endpoint: string;
  private running = false;
  private sseConnections: Map<string, Response> = new Map();

  constructor(name: string, version: string, port: number, endpoint: string = '/mcp') {
    this.serverInfo = { name, version };
    this.port = port;
    this.endpoint = endpoint;
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
  }

  /**
   * Setup HTTP routes for MCP protocol
   */
  private setupRoutes(): void {
    // SSE endpoint for receiving messages from server
    this.app.get(`${this.endpoint}/sse`, (req: Request, res: Response) => {
      const clientId = req.query.sessionId as string || `client-${Date.now()}`;
      
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      this.sseConnections.set(clientId, res);
      
      // Send initial connection event
      res.write(`data: ${JSON.stringify({ type: 'connection', sessionId: clientId })}\n\n`);
      
      req.on('close', () => {
        this.sseConnections.delete(clientId);
      });
    });

    // POST endpoint for receiving JSON-RPC requests
    this.app.post(`${this.endpoint}/message`, async (req: Request, res: Response) => {
      try {
        const request = req.body;
        const response = await this.handleRequest(request);
        res.json(response);
      } catch (error) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: `Internal error: ${error}`
          },
          id: req.body.id || null
        });
      }
    });

    // Health check
    this.app.get(`${this.endpoint}/health`, (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        server: this.serverInfo,
        tools: Array.from(this.tools.keys()),
        resources: Array.from(this.resources.keys())
      });
    });
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    console.log(`[MCP Server] Starting ${this.serverInfo.name} v${this.serverInfo.version}`);
    
    // Call setup to define tools and capabilities
    await this.setup();
    
    console.log(`[MCP Server] ${this.serverInfo.name} registered ${this.tools.size} tools, ${this.resources.size} resources`);
    
    // Start HTTP server
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        this.running = true;
        console.log(`[MCP Server] ${this.serverInfo.name} listening on http://localhost:${this.port}${this.endpoint}`);
        resolve();
      });
    });
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    console.log(`[MCP Server] Stopping ${this.serverInfo.name}`);
    this.running = false;
    
    // Close all SSE connections
    for (const [clientId, res] of this.sseConnections.entries()) {
      res.end();
    }
    this.sseConnections.clear();
    
    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          console.log(`[MCP Server] ${this.serverInfo.name} stopped`);
          resolve();
        });
      });
    }
  }

  /**
   * Setup method - subclasses override to define tools and resources
   */
  protected abstract setup(): Promise<void>;

  /**
   * Execute tool - subclasses override to implement tool logic
   */
  protected abstract executeTool(
    name: string,
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult>;

  /**
   * Read resource - subclasses override to implement resource reading
   */
  protected async readResource(uri: string): Promise<ResourceContents[]> {
    throw new Error(`Resource reading not implemented: ${uri}`);
  }

  /**
   * Define a tool
   */
  protected defineTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Define a resource
   */
  protected defineResource(resource: Resource): void {
    this.resources.set(resource.uri, resource);
  }

  /**
   * Handle incoming JSON-RPC request
   */
  private async handleRequest(request: any): Promise<any> {
    const { jsonrpc, id, method, params } = request;

    // Validate JSON-RPC 2.0
    if (jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Invalid Request: jsonrpc must be "2.0"'
        },
        id: id || null
      };
    }

    try {
      let result: any;

      switch (method) {
        case 'initialize':
          result = await this.handleInitialize(params as InitializeParams);
          break;

        case 'tools/list':
          result = await this.handleListTools();
          break;

        case 'tools/call':
          result = await this.handleCallTool(params as ToolCallParams);
          break;

        case 'resources/list':
          result = await this.handleListResources();
          break;

        case 'resources/read':
          result = await this.handleReadResource(params);
          break;

        case 'notifications/initialized':
          // Acknowledge initialization
          return { jsonrpc: '2.0', result: {}, id };

        default:
          return {
            jsonrpc: '2.0',
            error: {
              code: -32601,
              message: `Method not found: ${method}`
            },
            id
          };
      }

      return {
        jsonrpc: '2.0',
        result,
        id
      };

    } catch (error) {
      console.error(`[MCP Server] ${this.serverInfo.name} error handling ${method}:`, error);
      
      return {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error)
        },
        id
      };
    }
  }

  /**
   * Handle initialize request
   */
  private async handleInitialize(params: InitializeParams): Promise<InitializeResult> {
    return {
      protocolVersion: '2024-11-05',
      capabilities: this.capabilities,
      serverInfo: this.serverInfo,
    };
  }

  /**
   * Handle tools/list request
   */
  private async handleListTools(): Promise<ToolsListResult> {
    return {
      tools: Array.from(this.tools.values()),
    };
  }

  /**
   * Handle tools/call request
   */
  private async handleCallTool(params: ToolCallParams): Promise<CallToolResult> {
    const { name, arguments: args, _meta } = params;

    if (!this.tools.has(name)) {
      throw new Error(`Tool not found: ${name}`);
    }

    return await this.executeTool(name, args as Record<string, unknown>, _meta);
  }

  /**
   * Handle resources/list request
   */
  private async handleListResources(): Promise<{ resources: Resource[] }> {
    return {
      resources: Array.from(this.resources.values())
    };
  }

  /**
   * Handle resources/read request
   */
  private async handleReadResource(params: any): Promise<{ contents: ResourceContents[] }> {
    const { uri } = params;
    
    if (!this.resources.has(uri)) {
      throw new Error(`Resource not found: ${uri}`);
    }

    const contents = await this.readResource(uri);
    return { contents };
  }

  /**
   * Send event to all connected clients (for future notifications)
   */
  protected sendEventToAll(event: string, data: any): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    
    for (const [clientId, res] of this.sseConnections.entries()) {
      try {
        res.write(message);
      } catch (error) {
        console.error(`Failed to send to client ${clientId}:`, error);
        this.sseConnections.delete(clientId);
      }
    }
  }
}
