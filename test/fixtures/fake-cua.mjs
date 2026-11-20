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
//        this text (the action still counts as executed: "delivered 58 of 59"),
//        and with structured too the two go out together (0.55's "it ran, but
//        the result could not be vouched for": {code, execution_state:"unknown"});
//        refusal = {code, message?, form?} is a 0.55 refusal: NOT executed, not
//        in actions, the entry in calls gets refused:code. form "refusal"
//        (default) = {status:"refused", refusal:{code,message}} (identity,
//        session and token refusals); form "background" = the background-input
//        refusals (window_not_key, same_pid_keyboard_ambiguity…): {code,
//        effect:"refused", pid, window_id, reason, escalation:{recommended:
//        "foreground", reason}} with the text "Background input refused
//        (code): reason"; form "effect" = {effect:"refused", route, summary,
//        error:{code,hint}}; message:"" sends no text at all
//   fake_log {keep?}  → {calls, actions}, then both are cleared (keep:true
//        leaves them). calls = every non-control call {tool, args, sid?,
//        stale?} (sid = what a walk minted); actions = executed actions
//        {tool, args, target?:{idx, role, label, siblings:[labels]}} where
//        target is the element the token named in ITS snapshot
//   fake_mode {compact034}   true = cua ≥ 0.34: get_window_state returns
//        tree_markdown only, elements[] only with full_output:true
//   fake_mode {v055}         true = cua 0.55: all of compact034, plus
//        - rows in the 0.55 bracket grammar (trees.mjs grammar "055");
//        - get_window_state takes timeout_ms (and lists it in its schema); a
//          walk that would take longer than it (default 1000 ms, see
//          fake_walk_cost) or that meets the node cap (fake_node_cap) comes
//          back with the rows reached by then, truncated:true,
//          truncation_reason "timeout" | "node_budget", nodes_visited,
//          nodes_pending, timeout_ms, and — as the driver does for EVERY cut
//          walk — a last markdown line "⚠️ PARTIAL TREE: …" in its wording;
//          a complete walk says truncated:false;
//        - a snapshot belongs to (session, pid, window): a walk retires only
//          the same session's older snapshot of that window, a token resolves
//          by its snapshot id whichever session uses it, and ending a session
//          retires all of its snapshots;
//        - refusals carry structuredContent {status:"refused", refusal:{code,
//          message}}: a stale token (stale_element_token), an ended session
//          (session_ended, see fake_session_end).
//        Without it get_window_state refuses timeout_ms, the way a closed
//        schema does.
//   fake_walk_cost {ms}      how long a COMPLETE walk of any window takes in
//        v055 mode (0 = no time at all). Nothing really waits: the budget only
//        decides how many rows come back.
//   fake_node_cap {n}        v055 mode: a walk stops after n rows (0 = no cap;
//        the driver's own cap with full_output is 2000)
//   fake_session_end {session?}  that session label (none = the connection's
//        own unnamed session) has ended: every call in it is refused and not
//        run until start_session with the same label (or none) revives it.
//        Wording follows the mode: v055 = the 0.55 sentences, else 0.28.2's.
//   fake_exit {next?}        the driver process exits after replying (an
//        upgrade, a rollback, a crash): the hub's next call starts a new one.
//        next = the fake_mode arguments the new one starts with (default: none,
//        the 0.28.2 shape)
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
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
// What fake_exit {next} left for the process the same hub starts after this one.
const HANDOFF = join(tmpdir(), `fake-cua-next-${process.ppid}.json`);
let boot = {};
if (existsSync(HANDOFF)) {
  try {
    boot = JSON.parse(readFileSync(HANDOFF, "utf8"));
  } catch {
    /* an unreadable note = the default mode */
  }
  try {
    unlinkSync(HANDOFF);
  } catch {
    /* gone already */
  }
}
let compact = boot.compact034 === true;
let v055 = boot.v055 === true;
let walkCost = 0;
let nodeCap = 0;
const ended = new Set(); // session labels that have ended; "" = the unnamed one
let degrade = 0;
let slowMs = 0;
let untrusted = false;
let windows = [
  { window_id: WID, pid: PID, app_name: "示例应用", title: "样例窗", bounds: { x: 100, y: 50, width: 1000, height: 700 }, is_on_screen: true, layer: 0, z_index: 10 },
];

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const json = (o) => text(JSON.stringify(o));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const refusal = (code, message, form = "refusal", a = {}) => {
  if (form === "background") {
    return {
      content: [{ type: "text", text: `Background input refused (${code}): ${message}` }],
      structuredContent: { code, effect: "refused", pid: a.pid ?? PID, window_id: a.window_id ?? WID, reason: message, escalation: { recommended: "foreground", reason: message } },
      isError: true,
    };
  }
  return {
    content: message === "" ? [] : [{ type: "text", text: message }],
    structuredContent: form === "effect" ? { effect: "refused", route: "synthetic_events", summary: "no input was sent", error: { code, hint: message } } : { status: "refused", refusal: { code, message } },
    isError: true,
  };
};
// walk_budget.rs note(): the last line of a cut walk's tree_markdown.
const NARROW = "or narrow with query / max_depth";
const partialNote = (reason, timeoutMs, visited, pending) => {
  const [why, remedy] =
    reason === "timeout"
      ? [`the ${timeoutMs} ms timeout_ms budget ran out`, `retry with a larger timeout_ms (e.g. 5000) ${NARROW}`]
      : ["the max_elements node budget ran out", `retry with a larger max_elements ${NARROW}`];
  return `⚠️ PARTIAL TREE: ${why} after ${visited} node(s) (${pending} discovered but not visited). Every element listed is real; elements after the cut are missing. If the element you need is absent, ${remedy}.`;
};
// The snapshot a walk replaces: the window's in 0.28, the same session's snapshot of the window later.
const ownerOf = (a) => (v055 ? `${a.session ?? ""}|${keyOf(a)}` : keyOf(a));

async function walk(a) {
  for (const k of ["pid", "window_id"]) if (!Number.isInteger(a[k])) return text(`Missing required argument: ${k}`, true);
  if (!v055 && a.timeout_ms !== undefined) return text("Invalid arguments: unknown field `timeout_ms`", true);
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
  let rows = w.rows;
  let cut = null;
  if (v055) {
    const budget = Number.isInteger(a.timeout_ms) ? a.timeout_ms : 1000;
    let keep = rows.length;
    let reason;
    if (walkCost > budget) {
      keep = Math.max(1, Math.floor((rows.length * budget) / walkCost));
      reason = "timeout";
    }
    if (nodeCap > 0 && nodeCap < keep) {
      keep = nodeCap;
      reason = "node_budget";
    }
    cut = { truncated: false, nodes_visited: keep, nodes_pending: 0, timeout_ms: budget };
    if (reason) {
      // nodes_pending = nodes seen and not visited (here: one, the next row), never the rows left
      cut = { truncated: true, truncation_reason: reason, nodes_visited: keep, nodes_pending: 1, timeout_ms: budget };
      rows = rows.slice(0, keep);
    }
  }
  const full = payload(sid, rows, { pid: a.pid, windowId: a.window_id, title: w.title, win, ...(v055 ? { grammar: "055" } : {}) });
  if (cut?.truncated) full.tree_markdown = `${full.tree_markdown.replace(/\n+$/, "")}\n${partialNote(cut.truncation_reason, cut.timeout_ms, cut.nodes_visited, cut.nodes_pending)}`;
  latest.set(ownerOf(a), sid);
  snaps.set(sid, { k, owner: ownerOf(a), elements: full.elements });
  const sc = { ...full, ...cut };
  if ((compact || v055) && a.full_output !== true) delete sc.elements;
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
    if (!snap || latest.get(snap.owner) !== m[1]) {
      entry.stale = true;
      const msg = "element_token is stale; call get_window_state again to refresh";
      return v055 ? refusal("stale_element_token", msg) : text(msg, true);
    }
    const el = snap.elements.find((e) => e.element_index === Number(m[2]));
    if (!el) return text(`element ${m[2]} not found in snapshot ${m[1]}`, true);
    const siblings = snap.elements.filter((e) => e !== el && e.parent_index === el.parent_index && e.label !== undefined).map((e) => e.label);
    target = { idx: el.element_index, role: el.role, label: el.label, siblings };
  }
  if (replyQ[0]?.refusal) {
    const { code, message, form } = replyQ.shift().refusal;
    entry.refused = code;
    return refusal(code, message ?? `${tool} refused: ${code}`, form, a);
  }
  actions.push({ tool, args: a, ...(target ? { target } : {}) });
  const after = afterQ.shift();
  if (after) wins.set(after.k, { rows: after.rows, title: after.title, win: after.win });
  const r = replyQ.shift();
  if (r?.error) return r.structured ? { ...text(r.error, true), structuredContent: r.structured } : text(r.error, true);
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
      v055 = a.v055 === true;
      return json({ compact, v055 });
    case "fake_walk_cost":
      walkCost = Number(a.ms) || 0;
      return json({ walkCost });
    case "fake_node_cap":
      nodeCap = Number(a.n) || 0;
      return json({ nodeCap });
    case "fake_session_end":
      ended.add(a.session ?? "");
      // a later driver retires the snapshots of a session that ends
      if (v055) for (const [owner] of latest) if (owner.startsWith(`${a.session ?? ""}|`)) latest.delete(owner);
      return json({ ended: [...ended] });
    case "fake_exit":
      if (a.next) writeFileSync(HANDOFF, JSON.stringify(a.next));
      setTimeout(() => process.exit(0), 20);
      return json({ exiting: true });
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
    ["fake_set_window", "fake_after_action", "fake_next_reply", "fake_log", "fake_mode", "fake_walk_cost", "fake_node_cap", "fake_session_end", "fake_exit", "fake_restart", "fake_counter", "fake_degrade", "fake_slow", "fake_windows", "fake_verify"].map((t) => [t, S()])
  ),
};

const server = new Server({ name: "fake-cua", version: "0" }, { capabilities: { tools: {} } });
// 0.55 adds these to get_window_state; a client that wants to know what this
// driver takes reads them here.
const GWS_055 = { timeout_ms: I, max_elements: I, tree_format: { type: "string" }, since: { type: "string" }, query: { type: "string" } };
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(SCHEMAS).map(([name, inputSchema]) => ({
    name,
    description: `${name} (fake)`,
    inputSchema: v055 && name === "get_window_state" ? { ...inputSchema, properties: { ...inputSchema.properties, ...GWS_055 } } : inputSchema,
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  if (name.startsWith("fake_")) return control(name, a);
  const entry = { tool: name, args: a };
  calls.push(entry);
  if (name === "start_session") ended.delete(a.session ?? "");
  else if (ended.has(a.session ?? "")) {
    entry.refused = "session_ended";
    const label = a.session;
    if (!v055) return text(`session '${label ?? ""}' has ended; tool call '${name}' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id.`, true);
    return refusal(
      "session_ended",
      label === undefined
        ? "this transport's unnamed session has ended; call start_session without a session label to start a new one"
        : `session '${label}' has ended; call start_session with session '${label}' to start it again, or use a new session label`
    );
  }
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
