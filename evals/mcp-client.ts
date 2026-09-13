/**
 * Plumbline — evals/mcp-client.ts
 * Connects the eval harness to the MCP server.
 *
 * This is a real MCP connection: the server runs as a separate process and
 * speaks the protocol over stdio. The harness discovers the tool list at
 * runtime rather than hardcoding it, so the same server can be dropped into
 * Claude Desktop unchanged.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";
import { SERVER_INSTRUCTIONS } from "../mcp/server";

let client: Client | null = null;

async function connect(): Promise<Client> {
  if (client) return client;
  const transport = new StdioClientTransport({
    command: process.execPath,          // node itself, not npx (npx re-resolves every spawn)
    args: [require.resolve("tsx/cli"), "mcp/server.ts"],
    env: process.env as Record<string, string>,
  });
  client = new Client({ name: "plumbline-eval", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

/** Discovers the server's tools and converts them to Anthropic tool schemas. */
export async function buildMcpCondition(): Promise<{
  system: string; tools: Anthropic.Tool[];
}> {
  const c = await connect();
  const { tools } = await c.listTools();
  return {
    system: SERVER_INSTRUCTIONS,
    tools: tools.map(t => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.inputSchema as any,
    })),
  };
}

/** Dispatches one tool call through the MCP protocol. */
export async function callMcpTool(name: string, args: any): Promise<string> {
  const c = await connect();
  const res = await c.callTool({ name, arguments: args ?? {} });
  const content = (res.content as any[]) ?? [];
  return content.map(b => (b.type === "text" ? b.text : JSON.stringify(b))).join("\n")
    || "(empty response)";
}

export async function closeMcp() {
  if (client) { await client.close(); client = null; }
}
