#!/usr/bin/env node
// Test fixture: a cua stand-in whose calls can be made slow on demand, used
// to prove that cancellation and the act_batch budget do NOT evict/kill a
// healthy backend. `whoami` returns this process's pid — if the hub killed
// and respawned the backend, the pid changes. `sleep {ms}` and
// `press_key {key:"f20"}` block for the given time (press_key: 3s) but stay
// responsive to nothing else, like a long CGEvent typing run. `hang` never
// answers (a genuinely hung backend). Spawned via DESKTOP_HUB_CUA_BIN.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "slow-backend", version: "0" }, { capabilities: { tools: {} } });
const names = ["whoami", "sleep", "press_key", "hang", "list_windows"];
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: names.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
}));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let hung = false;
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (hung) await new Promise(() => {}); // once hung, nothing answers (incl. the liveness probe)
  switch (name) {
    case "whoami":
      return { content: [{ type: "text", text: String(process.pid) }] };
    case "sleep":
      await wait(Number(args.ms) || 1000);
      return { content: [{ type: "text", text: "slept" }] };
    case "press_key":
      if (args.key === "f20") await wait(3000);
      return { content: [{ type: "text", text: `pressed ${args.key}` }] };
    case "list_windows":
      return { content: [{ type: "text", text: "Found 0 window(s)." }], structuredContent: { windows: [] } };
    case "hang":
      hung = true;
      await new Promise(() => {});
      return { content: [] };
    default:
      return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
  }
});
await server.connect(new StdioServerTransport());
