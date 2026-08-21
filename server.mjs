#!/usr/bin/env node
// desktop-hub: compact facade MCP server for macOS desktop automation.
//
// Motivation: cua-driver (56 tools, ~37k tokens of definitions) and
// computer-use-oss (64 tools, ~21k tokens) together cost ~58k context tokens
// per session while their high-frequency surface is small. This server
// exposes ~10 compact tools (~3k tokens) and proxies to the real servers,
// spawned lazily over stdio. Long-tail tools stay reachable via desk_call,
// with on-demand schema lookup via desk_describe.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";

const CALL_TIMEOUT_MS = 180_000;

// The hub is a pass-through proxy: backend results must reach the host
// verbatim even when a backend violates its own declared outputSchema.
// cua-driver 0.20.0 does exactly that (several tools omit declared envelope
// fields like effect/route/status), and the SDK client arms outputSchema
// validation lazily — only after listTools() caches the schemas. With a real
// validator every cua tool works until the first desk_describe, then every
// call throws -32602 — AFTER the upstream action already executed, the worst
// failure mode for automation (success misreported as failure). Skipping
// output validation entirely defuses that; it also avoids Ajv's ~50
// unknown-format warnings per listTools from cua's uint64/uint32 schemas.
// getValidator must return undefined, NOT an always-valid function: the SDK
// gates a SECOND check ("has an output schema but did not return structured
// content" → -32600) on the cached validator being truthy, and that check
// runs before the validator is ever invoked. Both SDK consumers of the cache
// (callTool and the experimental tasks path) guard with `if (validator)`, so
// a cached undefined disarms both branches.
const passthroughValidator = {
  getValidator: () => undefined,
};

// ---------------------------------------------------------------------------
// Downstream backends, spawned lazily and kept alive. On transport close the
// cached client is dropped so the next call respawns.
// ---------------------------------------------------------------------------

const BACKENDS = {
  cua: {
    command: process.env.DESKTOP_HUB_CUA_BIN || `${process.env.HOME}/.local/bin/cua-driver`,
    args: ["mcp"],
  },
  oss: {
    command: "npx",
    // Exact-pinned: a surprise major bump would silently change tool
    // names/behavior under desk_call. Bump deliberately via env or here.
    args: ["--yes", "--prefer-offline", process.env.DESKTOP_HUB_OSS_SPEC || "@zavora-ai/computer-use-mcp@7.0.0"],
  },
};

const clients = {}; // name -> Promise<Client>
const toolCatalog = {}; // name -> Promise<tools[]>
const liveTransports = new Set(); // for shutdown's force-exit path only

// Evict a cache entry only if it is still the current generation. A stale
// onclose (the old child exits up to ~4s after close() starts SIGTERM) or a
// second late timeout must not delete a freshly respawned client — that
// orphans a live backend process and strands the agent's new element_tokens.
function evict(name, entry) {
  if (clients[name] === entry) {
    delete clients[name];
    delete toolCatalog[name];
  }
}

function getClient(name) {
  if (!BACKENDS[name]) throw new Error(`unknown backend "${name}" (use "cua" or "oss")`);
  if (!clients[name]) {
    const entry = (async () => {
      const transport = new StdioClientTransport({
        command: BACKENDS[name].command,
        args: BACKENDS[name].args,
        stderr: "pipe",
        // Default 10MB read cap kills the connection on big base64 screenshots.
        maxBufferSize: 256 * 1024 * 1024,
      });
      const client = new Client({ name: "desktop-hub", version: "0.1.1" }, { jsonSchemaValidator: passthroughValidator });
      liveTransports.add(transport);
      let errTail = "";
      // Without setEncoding, string+Buffer concat splits multibyte UTF-8 at
      // chunk boundaries into U+FFFD.
      transport.stderr?.setEncoding("utf8");
      transport.stderr?.on("data", (d) => {
        errTail = (errTail + d).slice(-2000);
      });
      try {
        // Explicit handshake timeout: default is 60s, too tight for a cold
        // npx spawn, and CALL_TIMEOUT_MS otherwise only covers callTool.
        await client.connect(transport, { timeout: CALL_TIMEOUT_MS });
      } catch (err) {
        // SDK's connect() already closed the transport (child gets the
        // SIGTERM cascade) on handshake failure — just untrack it.
        liveTransports.delete(transport);
        throw new Error(
          `backend "${name}" failed to start: ${err?.message ?? err}` +
            (errTail ? `\n--- ${name} stderr ---\n${errTail}` : "")
        );
      }
      // Client.connect() takes over transport.onclose, so evict through the
      // client-level callback — otherwise a dead backend is never respawned.
      client.onclose = () => {
        liveTransports.delete(transport);
        evict(name, entry);
      };
      return client;
    })();
    clients[name] = entry;
    entry.catch(() => evict(name, entry));
  }
  return clients[name];
}

async function backendCall(backend, tool, args, signal) {
  const entry = getClient(backend);
  const client = await entry;
  try {
    return await client.callTool({ name: tool, arguments: args ?? {} }, undefined, {
      timeout: CALL_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    // A hung-but-alive backend never fires onclose; evict + kill this
    // generation so the next call respawns instead of eating 180s per call.
    if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
      evict(backend, entry);
      client.close().catch(() => {});
    }
    throw err;
  }
}

async function backendTools(backend) {
  if (!toolCatalog[backend]) {
    const catEntry = (async () => {
      const clientEntry = getClient(backend);
      const client = await clientEntry;
      const out = [];
      let cursor;
      try {
        do {
          const page = await client.listTools({ cursor }, { timeout: CALL_TIMEOUT_MS });
          out.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
      } catch (err) {
        // Mirror backendCall: without eviction here, every desk_describe on a
        // hung backend waits the full timeout on the same dead client forever.
        if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
          evict(backend, clientEntry);
          client.close().catch(() => {});
        }
        throw err;
      }
      return out;
    })();
    toolCatalog[backend] = catEntry;
    catEntry.catch(() => {
      if (toolCatalog[backend] === catEntry) delete toolCatalog[backend];
    });
  }
  return toolCatalog[backend];
}

// ---------------------------------------------------------------------------
// act: one tool covering cua's action verbs. Each entry maps facade params to
// the upstream tool's exact parameter names; unlisted params are dropped so
// upstream additionalProperties:false schemas never reject the call.
// ---------------------------------------------------------------------------

const TARGETING = {
  pid: "pid",
  window_id: "window_id",
  element_token: "element_token",
  element_index: "element_index",
  snapshot_id: "snapshot_id",
  session: "session",
  delivery_mode: "delivery_mode",
};

const ACTIONS = {
  click: { tool: "click", map: { ...TARGETING, x: "x", y: "y", button: "button", count: "count", modifiers: "modifier", scope: "scope" } },
  double_click: { tool: "double_click", req: ["pid"], map: { ...TARGETING, x: "x", y: "y" } },
  right_click: { tool: "right_click", req: ["pid"], map: { ...TARGETING, x: "x", y: "y", modifiers: "modifier" } },
  type: { tool: "type_text", req: ["text"], map: { ...TARGETING, x: "x", y: "y", text: "text", scope: "scope" } },
  key: { tool: "press_key", req: ["key"], map: { ...TARGETING, x: "x", y: "y", key: "key", modifiers: "modifiers", scope: "scope" } },
  hotkey: { tool: "hotkey", req: ["keys"], map: { ...TARGETING, x: "x", y: "y", keys: "keys", scope: "scope" } },
  scroll: { tool: "scroll", req: ["direction"], map: { ...TARGETING, x: "x", y: "y", direction: "direction", amount: "amount", by: "by", scope: "scope" } },
  drag: { tool: "drag", req: ["x", "y", "to_x", "to_y"], map: { pid: "pid", window_id: "window_id", session: "session", delivery_mode: "delivery_mode", x: "from_x", y: "from_y", to_x: "to_x", to_y: "to_y", button: "button", modifiers: "modifier", scope: "scope" } },
  set_value: { tool: "set_value", req: ["pid", "value"], map: { pid: "pid", window_id: "window_id", element_token: "element_token", element_index: "element_index", snapshot_id: "snapshot_id", session: "session", value: "value" } },
  menu: { tool: "invoke_menu", req: ["pid", "window_id", "path"], map: { pid: "pid", window_id: "window_id", session: "session", path: "path" } },
};

function buildActArgs(input) {
  const spec = ACTIONS[input.action];
  if (!spec) throw new Error(`unknown action "${input.action}"`);
  for (const r of spec.req ?? []) {
    if (input[r] === undefined) throw new Error(`action "${input.action}" requires "${r}"`);
  }
  const args = {};
  for (const [facadeKey, upstreamKey] of Object.entries(spec.map)) {
    if (input[facadeKey] !== undefined) args[upstreamKey] = input[facadeKey];
  }
  Object.assign(args, input.extra ?? {});
  // Upstream refuses "desktop scope cannot be combined with pid or window_id";
  // models naturally keep the pid they already have, so drop them here.
  if (args.scope === "desktop") {
    delete args.pid;
    delete args.window_id;
  }
  return { tool: spec.tool, args };
}

// ---------------------------------------------------------------------------
// run_script: native osascript, no backend spawn. Script goes via stdin to
// avoid argv length limits.
// ---------------------------------------------------------------------------

function runOsascript(language, script, timeoutS, signal) {
  return new Promise((resolve) => {
    // The low-level Server never enforces inputSchema enums; without this,
    // "JXA"/"javascript" silently runs the source as AppleScript and yields a
    // baffling syntax error pointing at the wrong language.
    const lang = String(language ?? "").toLowerCase();
    if (lang !== "applescript" && lang !== "jxa") {
      return resolve({ ok: false, text: `unknown language "${language}" (use "applescript" or "jxa")` });
    }
    const child = spawn("osascript", ["-l", lang === "jxa" ? "JavaScript" : "AppleScript", "-"], {
      timeout: Math.min(Math.max(timeoutS ?? 60, 1), 600) * 1000,
    });
    // setEncoding buffers partial multibyte sequences across pipe chunks
    // (naive `+= buffer` splits CJK chars into U+FFFD at chunk boundaries).
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // Past CAP, stop accumulating but KEEP DRAINING so the pipe never blocks
    // and the script runs to completion — killing it would lose side effects
    // mid-flight (JXA console.log goes to stderr and can be huge). RETURN_CAP
    // clips what goes back to the model: a full 1MB body is ~260k tokens.
    const CAP = 1 << 20;
    const RETURN_CAP = 8 * 1024;
    let stdout = "", stderr = "", droppedOut = 0, droppedErr = 0;
    child.stdout.on("data", (d) => {
      if (stdout.length < CAP) stdout += d;
      else droppedOut += d.length;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < CAP) stderr += d;
      else droppedErr += d.length;
    });
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => resolve({ ok: false, text: `spawn error: ${err.message}` }));
    child.on("close", (code, sig) => {
      signal?.removeEventListener("abort", onAbort);
      const clip = (s, dropped) => {
        const over = Math.max(0, s.length - RETURN_CAP) + dropped;
        return over > 0 ? `${s.slice(0, RETURN_CAP)}\n…[+${over} chars dropped; script DID run to completion]` : s;
      };
      const body = [clip(stdout.trim(), droppedOut), clip(stderr.trim(), droppedErr)]
        .filter(Boolean)
        .join("\n--- stderr ---\n");
      if (sig) return resolve({ ok: false, text: `killed by ${sig} (timeout or cancelled; side effects may be partial)\n${stderr.slice(0, RETURN_CAP)}`.trim() });
      resolve({ ok: code === 0, text: code === 0 ? (body || "(no output)") : `exit ${code}\n${body}` });
    });
    // If osascript dies before draining stdin, the pending write emits an
    // 'error' that would otherwise crash the process; 'close' reports the
    // real failure, so swallow the stream error.
    child.stdin.on("error", () => {});
    child.stdin.end(script);
  });
}

// ---------------------------------------------------------------------------
// Facade tool definitions (hand-written, deliberately terse).
// ---------------------------------------------------------------------------

const TARGET_NOTE =
  "Target: prefer element_token (from window_state structuredContent.elements[].element_token; works on background/hidden windows, no focus steal). Else element_index+snapshot_id+window_id. Pixel x,y (window-local screenshot px) is last resort.";

const TOOLS = [
  {
    name: "desktop_screenshot",
    description: "Full-display screenshot in true screen pixels (via cua get_desktop_state). Returns screen size + scale factor. Use its PNG as coordinate source for act scope:'desktop' (cua only — oss tools via desk_call use logical points instead).",
    inputSchema: {
      type: "object",
      properties: { session: { type: "string", description: "Optional short session label; repeat on related calls." } },
    },
  },
  {
    name: "list_windows",
    description: "List all top-level windows incl. minimized/off-Space/hidden (via cua). Fields: window_id, pid, app_name, title, bounds. Use to find window_id before window_state.",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "integer", description: "Filter to one process." },
        on_screen_only: { type: "boolean", description: "Only current Space. Default false." },
      },
    },
  },
  {
    name: "launch_app",
    description: "Launch a macOS app in the BACKGROUND (does not steal focus; via cua). Prefer bundle_id.",
    inputSchema: {
      type: "object",
      properties: {
        bundle_id: { type: "string", description: "e.g. com.apple.calculator (preferred)." },
        name: { type: "string", description: "App display name, used when bundle_id absent." },
        urls: { type: "array", items: { type: "string" }, description: "Files/URLs/folders to open." },
      },
    },
  },
  {
    name: "window_state",
    description: "AX-tree walk of one window (via cua get_window_state): returns actionable elements (each with element_index + element_token) AND a grounding screenshot. Refresh after UI changes; element handles go stale. The screenshot can lag the live frame — re-verify critical UI via desktop_screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "integer" },
        window_id: { type: "integer", description: "From list_windows." },
        query: { type: "string", description: "Case-insensitive filter on elements (cheap way to find a button)." },
        include_screenshot: { type: "boolean", description: "Default true; false = tree only (cheaper)." },
        session: { type: "string" },
      },
      required: ["pid", "window_id"],
    },
  },
  {
    name: "act",
    description:
      "Perform one desktop action (via cua; background delivery by default — no cursor/focus steal). Actions: click, double_click, right_click, type (insert text), key (single key e.g. return/tab/escape), hotkey (combo e.g. [\"cmd\",\"c\"]), scroll, drag, set_value (text field/dropdown direct set), menu (invoke exact app-menu path). " +
      TARGET_NOTE +
      " Per-action params: type→text; key→key(+modifiers); hotkey→keys; scroll→direction(+amount,by); drag→x,y (from) + to_x,to_y; set_value→pid,value; menu→pid,window_id,path. pid is REQUIRED for double_click, right_click, set_value, menu (element_token alone insufficient; scope:'desktop' unsupported for these — desktop double-click = action:'click' with extra:{count:2}). scroll: pass element_token or x,y to wheel-scroll that spot (required for inner/nested scrollers); pid-only scroll instead sends arrow/PageDown keys to the focused control. iPad-ported (Designed-for-iPad) apps ignore synthetic scroll/drag/long-press entirely — the only working fallback is desk_call into oss pointer tools (HID-level; moves the real cursor); run_script can't help (no AppleScript dictionary, and System Events has no scroll/drag primitives).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["click", "double_click", "right_click", "type", "key", "hotkey", "scroll", "drag", "set_value", "menu"] },
        pid: { type: "integer", description: "Target process ID. Required for double_click, right_click, set_value, menu." },
        window_id: { type: "integer", description: "Required with element_index; optional with element_token. For pixel x,y (click/drag/scroll) pass the window_id the screenshot came from — multi-window apps refuse pid-only pixel actions as ambiguous." },
        element_token: { type: "string", description: "Preferred: opaque handle from window_state elements." },
        element_index: { type: "integer", description: "From window_state; needs snapshot_id + window_id." },
        snapshot_id: { type: "string", description: "From window_state; required with element_index." },
        x: { type: "number", description: "Window-local screenshot px (drag: start X)." },
        y: { type: "number", description: "Window-local screenshot px (drag: start Y)." },
        to_x: { type: "number", description: "drag end X." },
        to_y: { type: "number", description: "drag end Y." },
        text: { type: "string", description: "for type." },
        key: { type: "string", description: "for key: return, tab, escape, up, down…" },
        keys: { type: "array", items: { type: "string" }, description: "for hotkey: modifiers + one key." },
        value: { type: "string", description: "for set_value." },
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "for scroll." },
        amount: { type: "integer", description: "scroll notches, default 3." },
        by: { type: "string", enum: ["line", "page"], description: "scroll granularity, default line (page = PageDown/PageUp-sized steps)." },
        path: { type: "array", items: { type: "string" }, description: "for menu: exact menu path, e.g. [\"File\",\"Export…\"]. Case-sensitive." },
        button: { type: "string", enum: ["left", "right", "middle"] },
        modifiers: { type: "array", items: { type: "string" }, description: "cmd/shift/option/ctrl held during click/key." },
        scope: { type: "string", enum: ["window", "desktop"], description: "desktop = OMIT pid/window_id entirely (hub drops them); x,y then are true screen px from desktop_screenshot." },
        delivery_mode: { type: "string", enum: ["background", "foreground"], description: "Default background (no focus steal)." },
        session: { type: "string" },
        extra: { type: "object", description: "Escape hatch: merged verbatim into the upstream cua call (e.g. {count:2}; {from_zoom:true} — click/drag only)." },
      },
      required: ["action"],
    },
  },
  {
    name: "verify",
    description:
      "Deterministically verify predicates against one window (via cua verify_state) — use after acting instead of trusting transport success. expect items (ANDed, 1-8): {window:{exists:true}} | {window:{bounds:{x,y,width,height,tolerance_px}}} | {element:{selector:{role?,label_contains?}, exists:true, value_equals?, enabled?, selected?}}. Results: satisfied/unsatisfied/unknown (unknown ≠ success).",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "integer" },
        window_id: { type: "integer" },
        expect: { type: "array", items: { type: "object" }, description: "Predicate objects, see tool description." },
        timeout_ms: { type: "integer", minimum: 0, maximum: 10000, description: "Wait up to this many ms (0-10000, default 5000); 0 = single sample." },
        include_screenshot: { type: "boolean", description: "Also return final screenshot as visual evidence." },
        session: { type: "string" },
      },
      required: ["pid", "window_id", "expect"],
    },
  },
  {
    name: "zoom",
    description: "Cropped close-up JPEG of a window region (x1,y1)-(x2,y2) in screenshot px (via cua). For small text. To act on what you see: call zoom WITH pid, then act click/drag with extra:{from_zoom:true} (x,y in zoom-image px). Other actions ignore from_zoom (coords would land wrong) — from_zoom-click the field first, then act type.",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "integer", description: "Required if you will use from_zoom afterwards." },
        window_id: { type: "integer" },
        x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" },
      },
      required: ["window_id", "x1", "y1", "x2", "y2"],
    },
  },
  {
    name: "run_script",
    description: "Run AppleScript or JXA via osascript (true background automation for scriptable apps — most reliable path when the app has a dictionary; no cursor/focus impact). Returns stdout/stderr.",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["applescript", "jxa"] },
        script: { type: "string" },
        timeout_s: { type: "integer", description: "Default 60, max 600." },
      },
      required: ["language", "script"],
    },
  },
  {
    name: "desk_call",
    description: "Escape hatch: call ANY tool on the underlying servers — cua (cua-driver: windows/browser/clipboard/recording/sessions…) or oss (computer-use-oss: AX tree, find_element, fill_form, get_app_dictionary, Spaces…). Unsure about params? desk_describe first. oss spawns on first use (a few seconds). NOTE: oss pointer tools take LOGICAL screen points (1x), not desktop_screenshot's Retina true pixels — get coords from desk_call oss screenshot, or divide by the scale factor desktop_screenshot returns.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", enum: ["cua", "oss"] },
        tool: { type: "string" },
        args: { type: "object", description: "Arguments passed verbatim." },
      },
      required: ["server", "tool"],
    },
  },
  {
    name: "desk_describe",
    description: "On-demand docs for underlying tools. Without `tool`: catalog of all tool names + one-liners for the server. With `tool`: that tool's full description and JSON schema.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", enum: ["cua", "oss"] },
        tool: { type: "string", description: "Exact underlying tool name." },
      },
      required: ["server"],
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function handleCall(name, input, signal) {
  switch (name) {
    case "desktop_screenshot":
      return backendCall("cua", "get_desktop_state", pick(input, ["session"]), signal);
    case "list_windows":
      return backendCall("cua", "list_windows", pick(input, ["pid", "on_screen_only"]), signal);
    case "launch_app":
      return backendCall("cua", "launch_app", pick(input, ["bundle_id", "name", "urls"]), signal);
    case "window_state":
      return backendCall("cua", "get_window_state", pick(input, ["pid", "window_id", "query", "include_screenshot", "session"]), signal);
    case "act": {
      const { tool, args } = buildActArgs(input);
      return backendCall("cua", tool, args, signal);
    }
    case "verify": {
      const a = pick(input, ["pid", "window_id", "expect", "timeout_ms", "include_screenshot", "session"]);
      // Upstream rejects (not clamps) out-of-range AND non-integer timeout_ms.
      if (typeof a.timeout_ms === "number") a.timeout_ms = Math.round(Math.min(Math.max(a.timeout_ms, 0), 10000));
      return backendCall("cua", "verify_state", a, signal);
    }
    case "zoom":
      return backendCall("cua", "zoom", pick(input, ["pid", "window_id", "x1", "y1", "x2", "y2"]), signal);
    case "run_script": {
      const r = await runOsascript(input.language, input.script, input.timeout_s, signal);
      return textResult(r.text, !r.ok);
    }
    case "desk_call":
      return backendCall(input.server, input.tool, input.args ?? {}, signal);
    case "desk_describe": {
      const tools = await backendTools(input.server);
      if (input.tool) {
        const t = tools.find((x) => x.name === input.tool);
        if (!t) return textResult(`tool "${input.tool}" not found on ${input.server}. Available: ${tools.map((x) => x.name).join(", ")}`, true);
        return textResult(JSON.stringify(t, null, 1));
      }
      const lines = tools.map((t) => `${t.name} — ${firstSentence(t.description)}`);
      return textResult(`${input.server}: ${tools.length} tools\n${lines.join("\n")}`);
    }
    default:
      return textResult(`unknown tool ${name}`, true);
  }
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

function firstSentence(s) {
  if (!s) return "";
  const clean = s.replace(/\s+/g, " ").trim();
  const cut = clean.search(/[.。!?](\s|$)/);
  return (cut > 0 ? clean.slice(0, cut + 1) : clean).slice(0, 160);
}

// ---------------------------------------------------------------------------

const server = new Server(
  { name: "desktop-hub", version: "0.1.1" },
  {
    capabilities: { tools: {} },
    instructions:
      "macOS desktop automation facade over cua-driver (background, no cursor/focus steal) + computer-use-oss + osascript. " +
      "Prefer app APIs/CLI/Bash for non-GUI outcomes and Playwright for web pages. Scriptable app → run_script first. " +
      "GUI workflow: launch_app → list_windows → window_state(pid, window_id) → act with element_token → verify. " +
      "Never advance on transport success alone — verify or re-observe. " +
      "Full 120-tool surface of both underlying servers reachable via desk_call; schemas via desk_describe.",
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args } = req.params;
  try {
    // extra.signal aborts on notifications/cancelled (user pressed Esc):
    // threading it through cancels the upstream request / kills osascript
    // instead of letting the queued desktop action land after cancellation.
    return await handleCall(name, args ?? {}, extra?.signal);
  } catch (err) {
    return textResult(`desktop-hub error: ${err?.message ?? err}`, true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// SDK 1.30.0's StdioServerTransport never fires onclose on stdin EOF (it only
// listens for 'data'), and the spawned backends are ref'd children that would
// keep this process — and themselves — alive forever after the host exits.
let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Bound the sweep: an in-flight connect (handshake timeout 180s, e.g. cold
  // npx spawn) must never keep a host-less hub alive that long. close() itself
  // resolves within ~4s (stdin.end → SIGTERM → SIGKILL), so 5s covers the
  // normal path; the timer force-exits and reaps any still-connecting child.
  setTimeout(() => {
    for (const t of liveTransports) {
      try { if (t.pid) process.kill(t.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    process.exit(code);
  }, 5000).unref();
  const pending = Object.values(clients);
  await Promise.allSettled(pending.map((p) => p.then((c) => c.close()))); // stdin.end → SIGTERM → SIGKILL
  process.exit(code);
}
process.stdin.on("end", () => shutdown(0));
process.stdin.on("close", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
server.onclose = () => shutdown(0);
