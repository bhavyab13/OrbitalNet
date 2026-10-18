import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type McpToolDef = { name: string; description?: string; inputSchema: Record<string, unknown> };

export class Broker {
  private client: Client;
  tools: McpToolDef[] = [];
  constructor(private url: string) {
    this.client = new Client({ name: "orbitalnet-buyer", version: "0.1.0" });
  }
  async connect() {
    const transport = new StreamableHTTPClientTransport(new URL(this.url));
    await this.client.connect(transport);
    const list = await this.client.listTools();
    this.tools = list.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
    return this.tools;
  }
  /** Call a tool; returns structuredContent when present, else parsed text, else raw content. */
  async call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res: any = await this.client.callTool({ name, arguments: args });
    if (res.isError) {
      const txt = (res.content ?? []).map((c: any) => c.text ?? "").join("\n");
      throw new Error(`tool ${name} failed: ${txt}`);
    }
    if (res.structuredContent) return res.structuredContent as T;
    const txt = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    try { return JSON.parse(txt) as T; } catch { return txt as unknown as T; }
  }
  async close() { await this.client.close(); }
}
