#!/usr/bin/env node
// Test fixture: deterministic cua stand-in for act_batch tests. Serves a
// fixed 6-element tree from get_window_state (session "trunc" → truncated
// tree, session "degraded" → ax-unresolved shape) and records every action
// call (click / type_text / press_key / set_value) into a log retrievable
// via the get_actions_log tool — tests assert execution order, fresh-token
// injection, and that facade-only keys (find/if_present/wait_ms) never leak
// upstream. set_value with value "boom" fails (mid-batch failure path).
// Spawned by smoke.mjs via DESKTOP_HUB_CUA_BIN.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "act-batch-backend", version: "0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ["get_window_state", "click", "type_text", "press_key", "set_value", "get_actions_log"].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
  })),
}));

let snap = 0;
const el = (sid, idx, role, label, extra = {}) => ({
  element_index: idx,
  element_token: `${sid}:${idx}`,
  role,
  label,
  frame: { x: 100 + idx, y: 100, w: 60, h: 20 },
  depth: idx === 0 ? 0 : 1,
  enabled: true,
  ...extra,
});

const log = [];
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  switch (name) {
    case "get_window_state": {
      snap += 1;
      const sid = `sb${snap}`;
      if (args.session === "degraded") {
        return { content: [{ type: "text", text: JSON.stringify({ degraded: true, degraded_reason: "ax_window_unresolved:test", elements: [], tree_markdown: "" }) }] };
      }
      const truncated = args.session === "trunc";
      const elements = truncated
        ? [el(sid, 0, "AXWindow", "Batch")]
        : [
            el(sid, 0, "AXWindow", "Batch", { frame: { x: 100, y: 100, w: 800, h: 600 } }),
            el(sid, 1, "AXButton", "OK"),
            el(sid, 2, "AXButton", "Cancel"),
            el(sid, 3, "AXTextField", "Name", { value: "" }),
            el(sid, 4, "AXButton", "Dup"),
            el(sid, 5, "AXButton", "Dup"),
          ];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            pid: args.pid, window_id: args.window_id, snapshot_id: sid,
            elements_complete: !truncated, elements,
            tree_markdown: '- [0] AXWindow "Batch"',
            received_include_screenshot: args.include_screenshot ?? null,
          }),
        }],
      };
    }
    case "click":
    case "type_text":
    case "press_key":
    case "set_value":
      log.push({ tool: name, args });
      if (name === "set_value" && args.value === "boom") {
        return { isError: true, content: [{ type: "text", text: "set_value exploded" }] };
      }
      return { content: [{ type: "text", text: `${name}-ok` }] };
    case "get_actions_log":
      return { content: [{ type: "text", text: JSON.stringify(log) }] };
    default:
      return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
  }
});

await server.connect(new StdioServerTransport());
