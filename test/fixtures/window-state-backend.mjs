#!/usr/bin/env node
// Test fixture: scripted get_window_state responses so the hub's window_state
// diff mode can be tested deterministically. Non-query calls advance a
// counter through this sequence (snapshot ids s1, s2, …):
//   1 base            — 5-element tree (baseline)
//   2 base            — identical tree, new snapshot (no-change one-liner)
//   3 mod3            — AXButton "Cancel" inserted at [2]; "Name" value
//                       ""→"kevin" and shifts 2→3; Quit/Help shift +1;
//                       static-text markdown line changes
//   4 degraded        — ax_window_unresolved shape (must NOT move baseline)
//   5 mod5            — vs mod3: Quit removed, Help frame +30px x
//   6 churn           — completely different tree (>50% churn → full tree)
//   7 churn2          — churn tree with one value changed (used WITHOUT diff
//                       to prove plain window_state moves the baseline)
//   8+ churn2         — repeated (diff after 7 must report no changes)
// Calls WITH query get their own single response (cache-key separation).
// Every payload echoes received_include_screenshot (diff mode must default it
// to false upstream). Spawned by smoke.mjs via DESKTOP_HUB_CUA_BIN.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "window-state-backend", version: "0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "get_window_state", description: "scripted", inputSchema: { type: "object" } }],
}));

const el = (sid, idx, role, label, frame, extra = {}) => ({
  element_index: idx,
  element_token: `${sid}:${idx}`,
  role,
  ...(label !== null ? { label } : {}),
  frame,
  depth: idx === 0 ? 0 : 1,
  ...(idx !== 0 ? { parent_index: 0 } : {}),
  enabled: true,
  ...extra,
});

const WIN = { x: 100, y: 100, w: 800, h: 600 };
const base = (sid) => ({
  elements: [
    el(sid, 0, "AXWindow", "Main", WIN),
    el(sid, 1, "AXButton", "OK", { x: 110, y: 130, w: 60, h: 20 }),
    el(sid, 2, "AXTextField", "Name", { x: 110, y: 160, w: 200, h: 24 }, { value: "" }),
    el(sid, 3, "AXMenuItem", "Quit", { x: 110, y: 200, w: 80, h: 20 }),
    el(sid, 4, "AXButton", "Help", { x: 110, y: 230, w: 60, h: 20 }),
  ],
  tree_markdown: '- [0] AXWindow "Main"\n- AXStaticText = "hello world"',
});
const mod3 = (sid) => ({
  elements: [
    el(sid, 0, "AXWindow", "Main", WIN),
    el(sid, 1, "AXButton", "OK", { x: 110, y: 130, w: 60, h: 20 }),
    el(sid, 2, "AXButton", "Cancel", { x: 180, y: 130, w: 60, h: 20 }),
    el(sid, 3, "AXTextField", "Name", { x: 110, y: 160, w: 200, h: 24 }, { value: "kevin" }),
    el(sid, 4, "AXMenuItem", "Quit", { x: 110, y: 200, w: 80, h: 20 }),
    el(sid, 5, "AXButton", "Help", { x: 110, y: 230, w: 60, h: 20 }),
  ],
  tree_markdown: '- [0] AXWindow "Main"\n- AXStaticText = "hello kevin"',
});
const mod5 = (sid) => ({
  elements: [
    el(sid, 0, "AXWindow", "Main", WIN),
    el(sid, 1, "AXButton", "OK", { x: 110, y: 130, w: 60, h: 20 }),
    el(sid, 2, "AXButton", "Cancel", { x: 180, y: 130, w: 60, h: 20 }),
    el(sid, 3, "AXTextField", "Name", { x: 110, y: 160, w: 200, h: 24 }, { value: "kevin" }),
    el(sid, 4, "AXButton", "Help", { x: 140, y: 230, w: 60, h: 20 }),
  ],
  tree_markdown: '- [0] AXWindow "Main"\n- AXStaticText = "hello kevin"',
});
const churn = (sid, fieldValue) => ({
  elements: [
    el(sid, 0, "AXWindow", "Other", WIN),
    el(sid, 1, "AXButton", "Alpha", { x: 110, y: 130, w: 60, h: 20 }),
    el(sid, 2, "AXButton", "Beta", { x: 110, y: 160, w: 60, h: 20 }),
    el(sid, 3, "AXTextField", "Gamma", { x: 110, y: 190, w: 200, h: 24 }, { value: fieldValue }),
  ],
  tree_markdown: '- [0] AXWindow "Other"',
});
const degraded = (sid) => ({
  degraded: true,
  degraded_reason: "ax_window_unresolved:test",
  elements: [],
  element_count: 0,
  tree_markdown: "",
});

let n = 0;
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {};
  if (req.params.name !== "get_window_state") {
    return { isError: true, content: [{ type: "text", text: `unknown tool ${req.params.name}` }] };
  }
  let sid, body;
  if (args.query !== undefined) {
    sid = "sq1";
    body = base(sid);
  } else {
    n += 1;
    sid = `s${n}`;
    body = n <= 2 ? base(sid) : n === 3 ? mod3(sid) : n === 4 ? degraded(sid) : n === 5 ? mod5(sid) : n === 6 ? churn(sid, "x") : churn(sid, "y");
  }
  const payload = {
    pid: args.pid,
    window_id: args.window_id,
    snapshot_id: sid,
    elements_complete: true,
    element_count: body.elements.length,
    returned_element_count: body.elements.length,
    total_element_count: body.elements.length,
    received_include_screenshot: args.include_screenshot ?? null,
    ...body,
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
});

await server.connect(new StdioServerTransport());
