#!/usr/bin/env node
// test/fixtures/fake-cua.mjs — a cua-driver stand-in that follows the real
// driver's snapshot rules, for test/smoke.mjs (spawned via DESKTOP_HUB_CUA_BIN;
// the "mcp" argv is ignored). Trees come from trees.mjs payload(), so they have
// the cua 0.28.2 shape. All labels are invented.
//
// Rules copied from the real driver:
//   - every get_window_state that walks the AX tree mints a fresh snapshot id
//     ("s" + 8 hex digits, one counter for the whole daemon) and retires every
//     older snapshot of THAT window;
//   - an action whose element_token names a retired (or unknown) snapshot is
//     refused — isError "element_token is stale; call get_window_state again
//     to refresh" — and nothing runs (it is not logged as an action);
//   - include_accessibility_tree:false is a screenshot only: no walk, no new
//     snapshot, tokens survive.
//
// Control tools — call them through the hub (desk_call server:"cua"); they are
// never logged. pid/window_id default to 4242/777.
//   fake_set_window {pid?,window_id?,rows,title?,win?}
//        the window's content from now on. rows = trees.mjs rows
//        ([depth, role, label, opts]); win = {x,y,w,h} (default trees.WIN)
//   fake_after_action {pid?,window_id?,rows,title?,win?}
//        queue: the next EXECUTED action replaces that window's content
//   fake_next_reply {structured?, error?, text?}
//        queue: the reply to the next executed action. structured = a cua
//        envelope ({effect, escalation:{reason,target}, delivery:{mode}} …),
//        sent as structuredContent + its JSON as text; error = isError with
//        this text (the action still counts as executed: "delivered 58 of 59")
//   fake_log {keep?}  → {calls, actions}, then both are cleared (keep:true
//        leaves them). calls = every non-control call {tool, args, sid?,
//        stale?} (sid = what a walk minted); actions = executed actions
//        {tool, args, target?:{idx, role, label, siblings:[labels]}} where
//        target is the element the token named in ITS snapshot
//   fake_mode {compact034}   true = cua ≥ 0.34: get_window_state returns
//        tree_markdown only, elements[] only with full_output:true
//   fake_restart {}          daemon restart: counter back to 0, all snapshots
//        forgotten
//   fake_counter {next}      the next walk mints snapshot number `next`; nothing
//        is forgotten (replies of parallel calls arriving out of order)
//   fake_degrade {count?}    the next count (default 1) walks come back
//        degraded (no new snapshot retires anything)
//   fake_slow {ms}           every AX walk takes ms longer (0 = off)
//   fake_windows {windows}   list_windows content, cua fields: window_id, pid,
//        app_name, title, bounds{x,y,width,height}, is_on_screen, layer, z_index
//   fake_verify {untrusted}  verify_state answers unknown(untrusted_source)
// verify_state echoes its arguments as structuredContent.received.
// Schema errors (for desk_call's hint): get_window_state without integer
// pid/window_id → isError "Missing required argument"; zoom without
// window_id/x1/y1/x2/y2 → JSON-RPC error -32602.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { payload, WIN } from "./trees.mjs";

const PID = 4242;
const WID = 777;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const IMAGE = { type: "image", data: PNG, mimeType: "image/png" };
const ACTIONS = new Set(["click", "double_click", "right_click", "type_text", "press_key", "hotkey", "scroll", "drag", "set_value", "invoke_menu"]);

const keyOf = (a) => `${a.pid ?? PID}:${a.window_id ?? WID}`;
const wins = new Map([[`${PID}:${WID}`, { rows: [[0, "AXWindow", "样例窗", { a: ["AXRaise"] }], [1, "AXButton", "确定", { press: true }]] }]]);
const latest = new Map(); // window key → newest snapshot id
const snaps = new Map(); // snapshot id → { k, elements }
let counter = 0x100;
let calls = [];
let actions = [];
const afterQ = [];
const replyQ = [];
let compact = false;
let degrade = 0;
let slowMs = 0;
let untrusted = false;
let windows = [
  { window_id: WID, pid: PID, app_name: "示例应用", title: "样例窗", bounds: { x: 100, y: 50, width: 1000, height: 700 }, is_on_screen: true, layer: 0, z_index: 10 },
];

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const json = (o) => text(JSON.stringify(o));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function walk(a) {
  for (const k of ["pid", "window_id"]) if (!Number.isInteger(a[k])) return text(`Missing required argument: ${k}`, true);
  const k = keyOf(a);
  const w = wins.get(k);
  const win = w?.win ?? WIN;
  if (a.include_accessibility_tree === false) {
    const sc = { window_bounds: { x: win.x, y: win.y, width: win.w, height: win.h }, screenshot_width: win.w * 2, screenshot_height: win.h * 2 };
    return { content: [{ type: "text", text: "screenshot only" }, IMAGE], structuredContent: sc };
  }
  // The snapshot is numbered when the walk starts: two walks in flight can
  // come back out of order (the harder case for a client that watches ids).
  const sid = `s${(++counter).toString(16).padStart(8, "0")}`;
  if (slowMs) await wait(slowMs);
  if (!w || degrade > 0) {
    if (w) degrade--;
    const sc = { snapshot_id: sid, pid: a.pid, window_id: a.window_id, degraded: true, degraded_reason: "ax_window_unresolved:fake", elements: [], element_count: 0, tree_markdown: "" };
    return { content: [{ type: "text", text: "degraded" }], structuredContent: sc, sid };
  }
  const full = payload(sid, w.rows, { pid: a.pid, windowId: a.window_id, title: w.title, win });
  latest.set(k, sid);
  snaps.set(sid, { k, elements: full.elements });
  const sc = { ...full };
  if (compact && a.full_output !== true) delete sc.elements;
  const content = [{ type: "text", text: sc.tree_markdown }];
  if (a.include_screenshot === true) {
    sc.screenshot_width = win.w * 2;
    sc.screenshot_height = win.h * 2;
    content.push(IMAGE);
  }
  return { content, structuredContent: sc, sid };
}

function act(tool, a, entry) {
  let target;
  if (a.element_token !== undefined) {
    const m = /^(s[0-9a-f]+):(\d+)$/.exec(String(a.element_token));
    const snap = m && snaps.get(m[1]);
    if (!snap || latest.get(snap.k) !== m[1]) {
      entry.stale = true;
      return text("element_token is stale; call get_window_state again to refresh", true);
    }
    const el = snap.elements.find((e) => e.element_index === Number(m[2]));
    if (!el) return text(`element ${m[2]} not found in snapshot ${m[1]}`, true);
    const siblings = snap.elements.filter((e) => e !== el && e.parent_index === el.parent_index && e.label !== undefined).map((e) => e.label);
    target = { idx: el.element_index, role: el.role, label: el.label, siblings };
  }
  actions.push({ tool, args: a, ...(target ? { target } : {}) });
  const after = afterQ.shift();
  if (after) wins.set(after.k, { rows: after.rows, title: after.title, win: after.win });
  const r = replyQ.shift();
  if (r?.error) return text(r.error, true);
  if (r?.structured) return { content: [{ type: "text", text: JSON.stringify(r.structured) }], structuredContent: r.structured };
  return text(r?.text ?? `${tool}: done`);
}

function control(name, a) {
  switch (name) {
    case "fake_set_window":
      wins.set(keyOf(a), { rows: a.rows, title: a.title, win: a.win });
      return json({ ok: true });
    case "fake_after_action":
      afterQ.push({ k: keyOf(a), rows: a.rows, title: a.title, win: a.win });
      return json({ queued: afterQ.length });
    case "fake_next_reply":
      replyQ.push(a);
      return json({ queued: replyQ.length });
    case "fake_log": {
      const out = { calls, actions };
      if (a.keep !== true) {
        calls = [];
        actions = [];
      }
      return json(out);
    }
    case "fake_mode":
      compact = a.compact034 === true;
      return json({ compact });
    case "fake_restart":
      counter = 0;
      latest.clear();
      snaps.clear();
      return json({ ok: true });
    case "fake_counter":
      counter = Number(a.next) - 1;
      return json({ next: Number(a.next) });
    case "fake_degrade":
      degrade = a.count ?? 1;
      return json({ degrade });
    case "fake_slow":
      slowMs = Number(a.ms) || 0;
      return json({ slowMs });
    case "fake_windows":
      windows = a.windows;
      return json({ windows: windows.length });
    case "fake_verify":
      untrusted = a.untrusted === true;
      return json({ untrusted });
    default:
      return text(`unknown control tool ${name}`, true);
  }
}

const S = (properties = {}, required = []) => ({ type: "object", properties, required });
const I = { type: "integer" };
const N = { type: "number" };
const B = { type: "boolean" };
const SCHEMAS = {
  get_window_state: S({ pid: I, window_id: I, include_screenshot: B, include_accessibility_tree: B, full_output: B, session: { type: "string" } }, ["pid", "window_id"]),
  zoom: S({ pid: I, window_id: I, x1: N, y1: N, x2: N, y2: N }, ["window_id", "x1", "y1", "x2", "y2"]),
  list_windows: S({ pid: I, on_screen_only: B }),
  verify_state: S({ pid: I, window_id: I, expect: { type: "array" }, timeout_ms: I, include_screenshot: B, session: { type: "string" } }, ["pid", "window_id", "expect"]),
  get_desktop_state: S(),
  launch_app: S(),
  start_session: S(),
  ...Object.fromEntries([...ACTIONS].map((t) => [t, S({ pid: I, window_id: I, element_token: { type: "string" } })])),
  ...Object.fromEntries(
    ["fake_set_window", "fake_after_action", "fake_next_reply", "fake_log", "fake_mode", "fake_restart", "fake_counter", "fake_degrade", "fake_slow", "fake_windows", "fake_verify"].map((t) => [t, S()])
  ),
};

const server = new Server({ name: "fake-cua", version: "0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(SCHEMAS).map(([name, inputSchema]) => ({ name, description: `${name} (fake)`, inputSchema })),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  if (name.startsWith("fake_")) return control(name, a);
  const entry = { tool: name, args: a };
  calls.push(entry);
  if (name === "get_window_state") {
    const r = await walk(a);
    if (r.sid) entry.sid = r.sid;
    delete r.sid;
    return r;
  }
  if (ACTIONS.has(name)) return act(name, a, entry);
  switch (name) {
    case "list_windows": {
      let ws = windows;
      if (Number.isInteger(a.pid)) ws = ws.filter((w) => w.pid === a.pid);
      if (a.on_screen_only) ws = ws.filter((w) => w.is_on_screen);
      return { content: [{ type: "text", text: `Found ${ws.length} window(s).` }], structuredContent: { windows: ws } };
    }
    case "verify_state": {
      const sc = { received: a, results: [{ index: 0, status: untrusted ? "unknown" : "satisfied", ...(untrusted ? { reason: "untrusted_source" } : {}) }] };
      return { content: [{ type: "text", text: JSON.stringify(sc) }], structuredContent: sc };
    }
    case "zoom":
      for (const k of ["window_id", "x1", "y1", "x2", "y2"]) {
        // A plain Error carrying the code: McpError would bake its own "MCP
        // error -32602:" prefix into the wire message, which no real backend does.
        if (typeof a[k] !== "number") throw Object.assign(new Error(`Invalid arguments for tool zoom: "${k}" is required`), { code: ErrorCode.InvalidParams });
      }
      return { content: [IMAGE] };
    case "get_desktop_state":
      return { content: [{ type: "text", text: "screen 3024x1964 scale 2" }, IMAGE] };
    case "launch_app":
    case "start_session":
      return json({ ok: true });
    default:
      return text(`unknown tool ${name}`, true);
  }
});
await server.connect(new StdioServerTransport());
