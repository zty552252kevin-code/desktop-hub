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
import { spawn, execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  parseTree, renderTree, renderRows, renderQuery, renderDiff, diffTrees, carryIndex, sameTrees, findNodes, hitTest,
  contextOf, describeNode, describeAll, nearOf, orderHintOf, nearScore, recordOf, besideRows, mateOf, contextDiff, sayRow, sharedBy, sameContext, nameRank, foldName, FIELD_ROLE, wrapperOf, pressableLabels, rowText, headerLine, parseToken, clip, addressOf,
} from "./lib/tree.mjs";
import { windowsOf, renderWindows, windowDelta } from "./lib/windows.mjs";

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
    // A new cua transport: tokens minted through the old one may be void, so
    // forget every snapshot rather than rebase onto a tree nobody can use.
    if (name === "cua") {
      for (const [k, w] of winStore) forget(k, w);
      winStore.clear();
      snapOwners.clear();
      lastSidNum = -1;
      // …and what was learnt about the driver behind it: the next one may be another version (an upgrade, or a
      // rollback — an older driver refuses the parameters a newer one needs)
      needFullOutput = false;
      walkTimeout = false;
    }
  }
}

function getClient(name) {
  if (!Object.hasOwn(BACKENDS, name)) throw new Error(`unknown backend ${JSON.stringify(clip(String(name), 40))} (use "cua" or "oss")`);
  if (!clients[name]) {
    const entry = (async () => {
      const transport = new StdioClientTransport({
        command: BACKENDS[name].command,
        args: BACKENDS[name].args,
        stderr: "pipe",
        // Default 10MB read cap kills the connection on big base64 screenshots.
        maxBufferSize: 256 * 1024 * 1024,
      });
      const client = new Client({ name: "desktop-hub", version: "0.3.0" }, { jsonSchemaValidator: passthroughValidator });
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

async function rawBackendCall(backend, tool, args, signal, timeoutMs = CALL_TIMEOUT_MS) {
  const entry = getClient(backend);
  const client = await entry;
  try {
    return await client.callTool({ name: tool, arguments: args ?? {} }, undefined, {
      timeout: timeoutMs,
      signal,
    });
  } catch (err) {
    // A hung-but-alive backend never fires onclose; evict + kill this
    // generation so the next call respawns instead of eating 180s per call.
    // ONLY for the hub's own timeout: the SDK wraps every abort (host Esc,
    // act_batch budget) into the same RequestTimeout code, and evicting on
    // those killed a healthy cua — every element_token, the diff baselines
    // and any named session died with it.
    if (!signal?.aborted && err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
      evict(backend, entry);
      client.close().catch(() => {});
    }
    throw err;
  }
}

// After a hub-internal deadline (not a host cancel) aborted a call, the
// backend may be genuinely hung. Probe it off the response path with a cheap
// read-only call; only a probe timeout evicts.
const LIVENESS_PROBE_MS = Number(process.env.DESKTOP_HUB_PROBE_MS) || 8_000;
function probeBackendAfterDeadline(backend) {
  const tool = backend === "cua" ? "list_windows" : null;
  if (!tool || !clients[backend]) return;
  rawBackendCall(backend, tool, { on_screen_only: true }, undefined, LIVENESS_PROBE_MS).catch(() => {});
}

// cua rejects any call whose lifecycle session has idle-expired with a fixed
// "…has ended…" error naming the rejected tool; the action is NOT executed
// ("was rejected"), so one start_session (idempotent upstream) + one retry is
// safe and replaces the 2-3 call recovery dance the model would otherwise
// perform. The retry is not itself revive-eligible, so a re-expiry just
// surfaces. Lazy groups: session labels are free-form and may contain quotes.
const SESSION_ENDED_RE = /session '(.+?)' has ended; tool call '(.+?)' was rejected/;
// Later drivers word it differently and no longer name the tool; the refusal carries a code instead
// (structuredContent.refusal = {code:"session_ended", message}), which only the daemon puts on the call it
// refused. A call without a session label runs in the transport's own unnamed session, which ends the same way.
const SESSION_ENDED_NEW_RE = /^session '(.+?)' has ended; call start_session with session /;
const SESSION_ENDED_UNNAMED_RE = /^this transport's unnamed session has ended; call start_session without a session label/;
// → null (not that refusal), or { label, how } — label undefined = the unnamed session. A 0.28 driver ends a
// session that sat idle; a later one restarts an idle session by itself and refuses only one that was ended
// (end_session, a revoke, its connection closing).
function endedSession(result, tool) {
  const t = resultText(result);
  const m = SESSION_ENDED_RE.exec(t);
  // The not-executed premise only holds when the rejection is of THIS call:
  // an isError result that merely QUOTES an inner rejection (e.g.
  // replay_trajectory reporting a failed inner turn) names a different tool,
  // and blindly re-running the outer call would double-execute whatever side
  // effects it already had.
  if (m) return m[2] === tool ? { label: m[1], how: "expired" } : null;
  const named = (msg) => {
    const s = String(msg ?? "").trim();
    const n = SESSION_ENDED_NEW_RE.exec(s);
    if (n) return { label: n[1], how: "been ended" };
    return SESSION_ENDED_UNNAMED_RE.test(s) ? { label: undefined, how: "been ended" } : null;
  };
  const sc = result?.structuredContent;
  if (sc && typeof sc === "object") {
    // a structured result that is some OTHER refusal (or a tool's own failure report) is never this one, whatever
    // text it quotes
    const code = sc.refusal?.code ?? sc.code;
    return code === "session_ended" ? named(sc.refusal?.message ?? sc.message ?? t) : null;
  }
  // text only: the whole reply must BE that sentence (a quoted inner rejection sits inside a longer text)
  return named(t);
}

function resultText(res) {
  return (res?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

function withNote(result, note) {
  return { ...result, content: [...(result.content ?? []), { type: "text", text: note }] };
}

async function backendCall(backend, tool, args, signal) {
  const result = await rawBackendCall(backend, tool, args, signal);
  if (backend !== "cua" || tool === "start_session" || !result?.isError) return result;
  const end = endedSession(result, tool);
  if (!end) return result;
  const ended = end.label;
  const which = ended === undefined ? "the hub's unnamed session" : `session '${ended}'`;
  let revive;
  try {
    revive = await rawBackendCall("cua", "start_session", ended === undefined ? {} : { session: ended }, signal);
  } catch (err) {
    // Revive died (timeout/abort/backend crash) — the original rejection
    // stands and the action still never ran; report both.
    return withNote(result, `[desktop-hub] auto-revive attempt failed to complete: ${err?.message ?? err}`);
  }
  if (revive.isError) {
    const why = resultText(revive).slice(0, 300);
    // Only the cross-transport case is a dead end (a name minted on a prior
    // hub/backend process can never be revived here, despite upstream's
    // "revive it" hint); other start_session failures may be transient.
    const hint = /not available to this transport/.test(why)
      ? ` This name was minted on a previous hub/backend process and cannot be revived here (ignore the "revive it" hint above) — use a NEW session label, or omit session.`
      : "";
    return withNote(result, `[desktop-hub] auto-revive of ${which} failed: ${why}.${hint}`);
  }
  let retried;
  try {
    retried = await rawBackendCall(backend, tool, args, signal);
  } catch (err) {
    // The retry was dispatched to a LIVE session — unlike the original
    // rejection it may have executed before dying. Never echo the original
    // "not executed" text here; the honest answer is outcome-unknown.
    return textResult(
      `[desktop-hub] ${which} had ${end.how}; auto-revived it and retried '${tool}', but the retry failed to complete: ${err?.message ?? err}. Outcome UNKNOWN — the action may have executed; re-observe (window_state / desktop_screenshot) before re-issuing.`,
      true
    );
  }
  // (the note says which call this answer belongs to: a token of the ended session is refused as stale here)
  if (retried?.isError) return withNote(retried, `[desktop-hub] ${which} had ${end.how}; auto-revived it, and the answer above is the retry's.`);
  return withNote(
    retried,
    `[desktop-hub] ${which} had ${end.how}; auto-revived it and retried this call (result above is the retry). ` +
      `element_tokens/snapshot_ids minted before the expiry may be stale — re-run window_state before element-indexed actions.`
  );
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
// the upstream tool's exact parameter names. A step may only carry params its
// action understands: silently dropping the rest (the old behaviour) let the
// PreToolUse guard and the hub disagree about what a call does — a hotkey
// carrying a stray `key` no longer matched the guard's cmd+q rule while the
// hub still sent cmd+q upstream.
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

// press: a "did anything happen" question is meaningful after it (clicks and
// friends).
const ACTIONS = {
  click: { tool: "click", press: true, map: { ...TARGETING, x: "x", y: "y", button: "button", count: "count", from_zoom: "from_zoom", modifiers: "modifier", scope: "scope" } },
  double_click: { tool: "double_click", press: true, map: { ...TARGETING, x: "x", y: "y" } },
  right_click: { tool: "right_click", press: true, map: { ...TARGETING, x: "x", y: "y", modifiers: "modifier" } },
  type: { tool: "type_text", req: ["text"], map: { ...TARGETING, x: "x", y: "y", text: "text", scope: "scope" } },
  key: { tool: "press_key", req: ["key"], map: { ...TARGETING, x: "x", y: "y", key: "key", modifiers: "modifiers", scope: "scope" } },
  hotkey: { tool: "hotkey", req: ["keys"], map: { ...TARGETING, x: "x", y: "y", keys: "keys", scope: "scope" } },
  scroll: { tool: "scroll", req: ["direction"], map: { ...TARGETING, x: "x", y: "y", direction: "direction", amount: "amount", by: "by", scope: "scope" } },
  drag: { tool: "drag", req: ["x", "y", "to_x", "to_y"], map: { pid: "pid", window_id: "window_id", session: "session", delivery_mode: "delivery_mode", x: "from_x", y: "from_y", to_x: "to_x", to_y: "to_y", button: "button", from_zoom: "from_zoom", modifiers: "modifier", scope: "scope" } },
  set_value: { tool: "set_value", press: true, req: ["value"], map: { pid: "pid", window_id: "window_id", element_token: "element_token", element_index: "element_index", snapshot_id: "snapshot_id", session: "session", value: "value" } },
  menu: { tool: "invoke_menu", press: true, req: ["window_id", "path"], map: { pid: "pid", window_id: "window_id", session: "session", path: "path" } },
};

// Keys every step may carry regardless of action: the facade's own controls,
// plus the batch-level defaults (merged into every step, ignored where the
// upstream tool has no such parameter).
const STEP_KEYS = new Set(["action", "find", "if_present", "wait_ms", "repeat", "again", "extra", "pid", "window_id", "session", "delivery_mode"]);
const STEP_WAIT_CAP_MS = 10_000;
// repeat:N is for moving around, not for acting: twenty blind deletes, returns
// or cmd+w land on whatever happens to hold focus.
const REPEATABLE_KEYS = new Set(["up", "down", "left", "right", "tab", "pageup", "pagedown", "home", "end"]);
const REPEAT_MODIFIERS = new Set(["shift", "option", "alt"]);
const REPEAT_BATCH_CAP = 60;

// extra is merged last into the upstream call. It may add driver parameters
// the facade does not model, never restate one it does: `extra:{delivery_mode:
// "foreground"}` would slip past every check made on the regular parameter.
const EXTRA_RESERVED = new Set([
  ...Object.keys(TARGETING),
  ...Object.values(ACTIONS).flatMap((a) => [...Object.keys(a.map), ...Object.values(a.map)]),
  "target",
]);

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// The whole key vocabulary, shared word for word with the PreToolUse guard.
// Anything outside it is refused here: the guard compares key names, and a
// spelling it does not know ("cmd-q", "⌘", ["cmd"] nested in an array, a
// full-width ｑ) used to compare unequal to its cmd+q rule and pass, while
// whatever upstream made of it still ran.
const MODIFIER_NAMES = new Set(["cmd", "command", "shift", "option", "alt", "ctrl", "control", "fn"]);
const KEY_NAMES = new Set([
  "return", "enter", "tab", "escape", "esc", "space", "delete", "backspace", "forwarddelete",
  "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
  ...Array.from({ length: 20 }, (_, i) => `f${i + 1}`),
]);
const isModifier = (k) => typeof k === "string" && MODIFIER_NAMES.has(k.toLowerCase());
const isKeyName = (k) => typeof k === "string" && (KEY_NAMES.has(k.toLowerCase()) || /^[\x21-\x7e]$/.test(k));
const KEY_HELP = "return, tab, escape, space, delete, up/down/left/right, home, end, pageup, pagedown, f1-f20, or one printable ASCII character";

// Throws with a message the model can act on in one go. Returns the merged
// step (batch defaults + step).
function validateStep(raw, defaults = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("step must be an object");
  const spec = typeof raw.action === "string" && Object.hasOwn(ACTIONS, raw.action) ? ACTIONS[raw.action] : null;
  if (!spec) throw new Error(`unknown action ${JSON.stringify(clip(String(raw.action), 40))} (use ${Object.keys(ACTIONS).join(", ")})`);
  for (const k of Object.keys(raw)) {
    if (raw[k] === undefined || raw[k] === null || k in spec.map || STEP_KEYS.has(k)) continue;
    throw new Error(`${JSON.stringify(clip(k, 40))} is not a parameter of action "${raw.action}" (it takes: ${Object.keys(spec.map).filter((x) => !(x in TARGETING)).join(", ") || "no own parameters"})`);
  }
  // null = not given, in the step and in the batch defaults alike — and
  // dropped BEFORE merging, so a step-level null cannot blank a top-level
  // value (the guard hook merges in this order too).
  const given = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
  const s = { ...given(defaults), ...given(raw) };
  for (const r of spec.req ?? []) {
    if (s[r] === undefined) throw new Error(`action "${s.action}" requires "${r}"`);
  }
  // cua refuses window-scope input without pid even when a token is given
  // (its schema says otherwise); fail here, before anything runs.
  if (s.scope !== "desktop" && !Number.isInteger(s.pid)) {
    throw new Error(`action "${s.action}" requires "pid" (the pid you passed to window_state)`);
  }
  if (spec.press && s.action !== "menu" && s.element_token === undefined && s.element_index === undefined && s.find === undefined && !(typeof s.x === "number" && typeof s.y === "number")) {
    throw new Error(`action "${s.action}" needs a target: element_token, find, or x+y`);
  }
  if (s.delivery_mode !== undefined && s.delivery_mode !== "background" && s.delivery_mode !== "foreground") {
    throw new Error('delivery_mode must be exactly "background" or "foreground"');
  }
  if (s.scope !== undefined && s.scope !== "window" && s.scope !== "desktop") throw new Error('scope must be exactly "window" or "desktop"');
  if (s.window_id !== undefined && !Number.isInteger(s.window_id)) throw new Error("window_id must be an integer");
  for (const k of ["x", "y", "to_x", "to_y"]) {
    if (s[k] !== undefined && !(typeof s[k] === "number" && Number.isFinite(s[k]))) throw new Error(`${k} must be a number`);
  }
  if (s.modifiers !== undefined && !(Array.isArray(s.modifiers) && s.modifiers.every(isModifier))) {
    throw new Error("modifiers must be an array of: cmd, shift, option (alt), ctrl, fn");
  }
  if (s.action === "key" && !isKeyName(s.key)) {
    throw new Error(`key must be one key name — ${KEY_HELP}. Modifiers go in "modifiers"; a combo is action:"hotkey".`);
  }
  if (s.action === "type" && typeof s.text !== "string") throw new Error("type.text must be a string");
  if (s.action === "set_value" && typeof s.value !== "string") throw new Error("set_value.value must be a string");
  if (s.count !== undefined && !isInt(s.count, 1, 3)) throw new Error("count must be 1, 2 or 3");
  if (s.from_zoom !== undefined && typeof s.from_zoom !== "boolean") throw new Error("from_zoom must be a boolean");
  if (s.action === "hotkey") {
    const k = s.keys;
    if (!(Array.isArray(k) && k.length >= 2 && k.length <= 5 && k.slice(0, -1).every(isModifier) && isKeyName(k[k.length - 1]))) {
      throw new Error(`hotkey.keys must be an array of modifiers (cmd, shift, option, ctrl, fn) followed by ONE key, each its own element — e.g. ["cmd","a"], never "cmd+a". Keys: ${KEY_HELP}. A single key is action:"key".`);
    }
  }
  if (s.action === "scroll") {
    if (!["up", "down", "left", "right"].includes(s.direction)) throw new Error("scroll.direction must be up, down, left or right");
    if (s.amount !== undefined && !isInt(s.amount, 1, 50)) throw new Error("scroll.amount must be an integer 1-50");
  }
  if (s.action === "menu" && !(Array.isArray(s.path) && s.path.length >= 1 && s.path.length <= 16 && s.path.every((p) => typeof p === "string" && p.length > 0))) {
    throw new Error('menu.path must be an array of 1-16 exact menu titles, e.g. ["File","Export…"]');
  }
  if (s.action === "type" && /[\u{10000}-\u{10FFFF}]/u.test(String(s.text))) {
    // cua's key-event path cannot emit code points beyond U+FFFF: it drops
    // the character, reports "delivered N-1 of N" and suggests a retry that
    // drops it again. Refuse before anything runs instead of half-typing.
    throw new Error(
      'type cannot send characters beyond U+FFFF (rare CJK such as extension-B, some emoji) — they are silently dropped. Put the text on the clipboard (Bash: pbcopy) and use action:"menu" path ["编辑","粘贴"] / ["Edit","Paste"] on the focused field; type the rest normally.'
    );
  }
  if (s.repeat !== undefined) {
    if (!isInt(s.repeat, 1, 20)) throw new Error("repeat must be an integer 1-20");
    const navKey =
      s.action === "key" &&
      REPEATABLE_KEYS.has(String(s.key).toLowerCase()) &&
      (s.modifiers ?? []).every((m) => REPEAT_MODIFIERS.has(String(m).toLowerCase()));
    if (s.action !== "scroll" && !navKey) {
      throw new Error("repeat is only for scroll and navigation keys (arrows, tab, page up/down, home, end; shift/option allowed) — list other keys as separate steps");
    }
  }
  if (s.again !== undefined && typeof s.again !== "boolean") throw new Error("again must be a boolean");
  if (s.wait_ms !== undefined && !isInt(s.wait_ms, 0, STEP_WAIT_CAP_MS)) throw new Error(`wait_ms must be an integer 0-${STEP_WAIT_CAP_MS}`);
  if (s.extra !== undefined && (typeof s.extra !== "object" || s.extra === null || Array.isArray(s.extra))) throw new Error("extra must be an object");
  const clash = Object.keys(s.extra ?? {}).find((k) => EXTRA_RESERVED.has(k));
  if (clash) throw new Error(`extra may not set "${clash}" — pass it as a regular parameter`);
  if (s.if_present && !s.find) throw new Error("if_present requires find");
  if (s.find !== undefined) {
    if (s.find && typeof s.find === "object" && !Array.isArray(s.find)) s.find = Object.fromEntries(Object.entries(s.find).filter(([, v]) => v !== null && v !== undefined)); // null = not given
    const f = s.find;
    if (!f || typeof f !== "object" || Array.isArray(f) || (f.role === undefined && f.label === undefined && f.value === undefined && f.near === undefined)) {
      throw new Error("find needs at least one of role/label/value");
    }
    for (const k of ["role", "label", "value"]) {
      if (f[k] !== undefined && typeof f[k] !== "string") throw new Error(`find.${k} must be a string`);
      if (f[k] !== undefined && f[k].trim() === "") throw new Error(`find.${k} is empty — it would match every row; leave it out or name the control`);
    }
    const strange = Object.keys(f).find((k) => !["role", "label", "value", "near", "nth", "menus"].includes(k));
    if (strange) throw new Error(`find takes role, label, value, near, nth — not "${strange}"`);
    if (f.nth !== undefined && !isInt(f.nth, 0, 10_000)) throw new Error("find.nth must be an integer ≥ 0 (it counts from 0)");
    if (f.near !== undefined && !(typeof f.near === "string" && f.near.trim() !== "")) throw new Error("find.near must be a non-empty string — a text on the target's line, or in its table row or card");
    if (f.near !== undefined && f.role === undefined && f.label === undefined && f.value === undefined) throw new Error("find.near narrows a role/label/value match — give at least one of those too");
    if (!spec.map.element_token) throw new Error(`find is not supported for action "${s.action}" (no element targeting upstream)`);
    if (s.window_id === undefined) throw new Error("find needs pid + window_id (top-level or per-step)");
  }
  return s;
}

function buildActArgs(s) {
  const spec = ACTIONS[s.action];
  const args = {};
  for (const [facadeKey, upstreamKey] of Object.entries(spec.map)) {
    if (s[facadeKey] !== undefined) args[upstreamKey] = s[facadeKey];
  }
  Object.assign(args, s.extra ?? {});
  // Upstream refuses "desktop scope cannot be combined with pid or window_id";
  // models naturally keep the pid they already have, so drop them here.
  if (args.scope === "desktop") {
    delete args.pid;
    delete args.window_id;
  }
  return { tool: spec.tool, args };
}

// ---------------------------------------------------------------------------
// Observation store. One entry per (pid, window_id):
//   latest — the newest parsed tree from ANY hub walk. cua kills a window's
//            older element_tokens on every walk (the hub's own included).
//   shown  — sid → { tree, rows, known, retired? } for every snapshot whose
//            id was printed to the model. `rows` are the row numbers actually
//            printed: a token is honoured only for a row the model was shown
//            under that id (a hand-spliced "<newest sid>:<old index>" must
//            fail, not click a neighbour). `known` is how far the model's
//            knowledge of the window reaches from that snapshot: the newest
//            tree such that every change since has been put in front of it
//            (an uncut delta), or that differs in nothing. An older token is
//            carried forward only when `known` is the latest tree — otherwise
//            the hub first refuses and shows what changed.
//   seen   — the tree the model last saw IN FULL (an uncut tree, or an uncut
//            delta on top of the previous `seen`): the baseline of diff:true.
//            Independent of the query: with per-query baselines a model that
//            varied its query (it always does) never had one.
//   scale  — screenshot px per window point, learned from the last screenshot.
// A tree found identical to a newer walk gets `.same` → that walk; canon()
// follows the chain, so "known" and "seen" advance for free when a look
// finds nothing changed. The rendering itself lives in lib/tree.mjs.
// ---------------------------------------------------------------------------

const WIN_MAX = 16;
const SHOWN_MAX = 64;
const SHOWN_ROWS_MAX = 40_000; // per window, across the snapshots kept for it
const TOTAL_ROWS_MAX = 160_000; // across all windows
const MAX_TREE_CHARS = Number(process.env.DESKTOP_HUB_MAX_TREE_CHARS) || 20_000;
const winStore = new Map();
let lastSidNum = -1;
let lastSidAt = 0; // when the highest snapshot id seen so far arrived
// cua >= 0.34 answers get_window_state with compact markdown only; the
// parser, find and rebase need elements[]. Detected from the first reply
// rather than from a version string: `cua-driver mcp` is a proxy and its
// reported version can differ from the daemon that does the work.
let needFullOutput = false;
// Later drivers bound an AX walk at 1 s by default and return whatever they reached by then
// (`truncated:true, truncation_reason:"timeout"`); full_output does not lift that. The hub wants the whole
// window, so once a driver has answered that way it is asked for more time on every walk. Learnt from the
// reply, like needFullOutput: an older driver refuses a parameter it does not know, and only a driver that has
// the parameter reports this reason.
const WALK_TIMEOUT_MS = 20_000; // the driver's own backstop is twice this plus 5 s: inside the 50 s batch budget
let walkTimeout = false;

const winKey = (pid, windowId) => `${pid}:${windowId}`;
// Windows the model had looked at whose record the hub dropped to bound memory: a find there
// must not behave as if the model had never seen the window (keys only; a few hundred).
const forgotten = new Map();
function forget(key, e) {
  if (!e || !((e.lookTick ?? 0) > 0)) return;
  forgotten.delete(key);
  forgotten.set(key, true);
  if (forgotten.size > 256) forgotten.delete(forgotten.keys().next().value);
}
const peekEntry = (pid, windowId) => winStore.get(winKey(pid, windowId));

function winEntry(pid, windowId) {
  const k = winKey(pid, windowId);
  let e = winStore.get(k);
  if (e) winStore.delete(k); // re-insert = most recently used
  else {
    e = { latest: null, shown: new Map(), seen: null, scale: null, walkMs: 0, lastPress: null };
    if (forgotten.delete(k)) {
      // the model has looked at this window before; what it saw is gone: it is behind on all of it
      e.lookTick = e.readTick = 1;
      e.forgot = true;
      markUntold(e);
    }
  }
  winStore.set(k, e);
  if (winStore.size > WIN_MAX) {
    const old = winStore.keys().next().value;
    forget(old, winStore.get(old));
    winStore.delete(old);
  }
  return e;
}

function rememberTree(tree) {
  // Snapshot ids come from one counter inside the cua daemon. An id at or
  // below one already seen means the daemon restarted: everything stored
  // belongs to a dead namespace whose ids will collide with new ones.
  // Replies of parallel calls can arrive a few ids out of order, so "restart"
  // means the id fell well back, or an id this hub already got from a walk came again.
  // …or the walk that returned it STARTED after a higher id had already
  // arrived: one counter cannot go backwards, whatever other sessions do.
  const num = parseInt(String(tree.snapshotId).slice(1), 16);
  if (Number.isFinite(num)) {
    const started = (tree.at ?? Date.now()) - (tree.walkMs ?? 0);
    if (num < lastSidNum - 8 || snapOwners.has(tree.snapshotId) || (num <= lastSidNum && started > lastSidAt)) {
      for (const [k, w] of winStore) forget(k, w); // the model's views are gone with the daemon's ids: it is behind on every window it looked at
      winStore.clear();
      snapOwners.clear();
      deskMenus.clear();
      lastSidNum = -1;
    }
    if (num > lastSidNum) {
      lastSidNum = num;
      lastSidAt = tree.at ?? Date.now();
    }
  }
  tree.num = Number.isFinite(num) ? num : lastSidNum;
  snapOwners.set(tree.snapshotId, { pid: tree.pid, windowId: tree.windowId });
  if (snapOwners.size > 512) snapOwners.delete(snapOwners.keys().next().value);
  const e = winEntry(tree.pid, tree.windowId);
  if (!e.latest || tree.num >= (e.latest.num ?? -1)) {
    if (e.latest && e.latest !== tree) e.latest.toldSheets = new Set(e.sheetsTold ?? []); // what the model knew of ITS sheets, for toldAll
    tree.tick = eventTick; // walked after every action and look counted so far
    e.latest = tree; // cua's newest snapshot is the only valid one
    if (e.sheetsTold?.size) {
      const now = sheetsOf(tree);
      // (A forced tick box that has since become changeable makes it another sheet, even reading what it read:
      // rounds 13 to 15 handed the "shown" mark on when the box was released with the state it had, and each
      // round found a changed state passing as that — a look-alike matched by its folded text, then by a place
      // a nameless button had shifted, then by a place an empty value had freed. The hub no longer tries; a
      // wizard page that finishes loading costs one held call.)
      for (const sig of e.sheetsTold) if (!now.has(sig)) e.sheetsTold.delete(sig); // a sheet that went away is news again when it comes back
    }
    if (e.maybeGone?.size) {
      // a sheet that is gone needs no doubt any more; one still up at a walk made moments after the
      // action that might have dismissed it was not dismissed by it
      // ("moments after" counts from THAT action: typing afterwards, with its own report walk, settles nothing)
      const up = sheetsOf(tree);
      for (const [sig, at] of e.maybeGone) if (!up.has(sig) || Date.now() - at < BLIND_WINDOW_MS) e.maybeGone.delete(sig);
    }
    // What the model knows stays whole when this walk found nothing new.
    const olds = new Set();
    if (e.seen) olds.add(canon(e.seen));
    for (const rec of e.shown.values()) olds.add(canon(rec.known));
    for (const t of olds) if (t !== tree && sameTrees(t, tree)) t.same = tree;
  }
  e.walkMs = tree.walkMs ?? 0;
  return e;
}

function canon(tree) {
  let end = tree;
  while (end?.same) end = end.same;
  // Path compression: a window walked a hundred times without a change must
  // not keep a hundred trees alive through the chain.
  while (tree?.same && tree.same !== end) {
    const next = tree.same;
    tree.same = end;
    tree = next;
  }
  return end;
}

// The model has now been shown every change from `base` to `tree`.
function toldAll(e, base, tree) {
  const b = canon(base);
  // the list starts from the model's own whole-window view — uncut, or cut by the size cap past every row of
  // its sheets (round 16: in a window larger than the cap this was never true): every sheet text `base` held was shown
  const mine = !!e.seen && canon(e.seen) === b && (!e.seenPart || e.seenSheets === true);
  for (const rec of e.shown.values()) if (canon(rec.known) === b) rec.known = tree;
  if (e.seen && canon(e.seen) === b) {
    e.seen = tree;
    e.seenTick = eventTick; // when the model was brought up to here (a `.same` hop to an identical later walk does not count)
    if (tree === e.latest) e.untold = 0; // every change since the model's last whole-window view has now been listed
  }
  // The sheets of `base` had all been shown, and every change since is listed: the sheets as they are now
  // have been shown too (a wizard's "第 2 步" after 下一步, a value typed into the sheet's field). Not when
  // `base` held a sheet the model never saw — the list says nothing about that one.
  if (tree === e.latest && b !== tree && b.toldSheets && [...sheetsOf(b).keys()].every((sig) => b.toldSheets.has(sig))) {
    e.sheetsTold ??= new Set();
    // …but a list of changes says nothing about a sheet that stood in `base` too and may have been dismissed
    // in between: its doubt stays until a walk made right after the action, or a reply that prints it, settles
    // it (round 13: a report listing one typed value cleared the doubt, and the sheet that had come back by
    // itself was confirmed).
    // Nor does it say what a progress sheet reads now, unless its texts in `base` were the ones the model
    // had been shown: a list made against a walk nobody showed ("vs the previous look") starts from texts
    // the model never saw (round 14: such a report stored the present texts as shown, and the sheet's own
    // button went out on a copy that had moved on to another file).
    // (From the model's own whole view it does, whatever a later hold or look has printed since — round 15:
    // the test compared with the newest texts shown only, and after a hold had printed the sheet, or a tick
    // box had been released, a complete list from the model's view was not credited.)
    const was = sheetsOf(b);
    const now = sheetsOf(tree);
    const unseen = (sig, o) => !mine && !!o.words && (e.barWords?.get(sig) ?? null) !== o.words;
    // With another button in it the sheet has another signature and is new in `tree`: when a progress sheet of
    // `base` whose texts there were not the ones shown is gone, the new one is told as up — its texts are not.
    const lost = (sh) => [...was].some(([osig, o]) => !now.has(osig) && o.node.role === sh.node.role && unseen(osig, o));
    for (const [sig, sh] of now) {
      const o = was.get(sig);
      if (o && (e.maybeGone?.has(sig) || (sh.words && unseen(sig, o)))) continue;
      // (When the new one has no bar — it turned indeterminate, or went away — its texts are what it is: it is
      // not told at all; the next find here is held once and the reply prints it. Round 16.)
      if (!o && lost(sh)) {
        if (sh.words) markTold(e, sig, null);
        continue;
      }
      markTold(e, sig, sh);
    }
  }
}

// The model has been handed the whole of `tree`. Snapshots it was never told
// the changes for are retired: it holds fresh tokens for every row now, and an
// old one would be carried across changes it only saw as a second full tree.
function sawWhole(e, tree) {
  for (const rec of e.shown.values()) {
    if (rec.tree !== tree && !rec.retired && canon(rec.known) !== tree) rec.retired = tree.snapshotId;
  }
  e.seen = tree;
  e.seenTick = eventTick;
  e.seenPart = null;
  e.untold = 0;
  e.forgot = false;
}

// The model is behind on this window: a reply had to leave changes out (an
// action report cut at its cap, an outline of a page that changed wholesale,
// a query look that found more news than fits). e.untold counts such gaps
// (0 = none). It is cleared when the model gets the whole window, or a
// complete change list that starts from its last whole-window view. While it
// is set, older tokens are refused anyway (carry); a find that only names a
// control is held once per gap, with the place it found.
function markUntold(e) {
  if (!e) return;
  e.gapSeq = (e.gapSeq ?? 0) + 1;
  e.untold = e.gapSeq;
}
const onHold = (e) => e?.untold || 0;

// The Set render functions fill with every row number they print for `tree`.
function shownRows(e, tree) {
  let s = e.shown.get(tree.snapshotId);
  if (!s) {
    s = { tree, rows: new Set(), known: tree };
    e.shown.set(tree.snapshotId, s);
    // Bounded by count and by rows: 64 walks of a 6,000-row window are ~0.8 GB.
    let rows = 0;
    for (const r of e.shown.values()) rows += r.tree.nodes.length;
    // The whole-window view the model is working from goes last: on a large
    // window it is the oldest record and the one whose tokens are in use.
    // …and so does the view with the most rows shown — the one the model
    // took its tokens from (action reports show a handful of rows each).
    let main = null;
    for (const r of e.shown.values()) if (!r.retired && r.tree !== tree && (!main || r.rows.size > main.rows.size)) main = r;
    // …and the model's last few looks (window_state calls): on a large window
    // it works from two or three query views at once. Over the limit, all
    // but the two newest of them give way before the rest does.
    const looks = e.looks ?? [];
    // The views in use must fit whatever the window's size: the whole view, the newest walk, the one whose
    // token was just used and the last looks. (At 7,000 rows a fixed 40,000 dropped the first of three
    // query views the model was using in turn.) TOTAL_ROWS_MAX below still bounds it across windows.
    const rowCap = Math.max(SHOWN_ROWS_MAX, (LOOKS_KEPT + 4) * tree.nodes.length);
    while (e.shown.size > 2 && (e.shown.size > SHOWN_MAX || rows > rowCap)) {
      let k;
      for (const [sid, r] of e.shown) {
        if (r.tree !== tree && r.tree !== e.seen && r !== main && r !== e.lastUsed && r !== e.placed?.[0] && !looks.includes(r)) {
          k = sid;
          break;
        }
      }
      if (k === undefined && looks.length > 2) {
        const old = looks.pop();
        if (e.shown.get(old.tree.snapshotId) === old && old.tree !== tree && old.tree !== e.seen && old !== main && old !== e.lastUsed && old !== e.placed?.[0]) k = old.tree.snapshotId;
        else continue;
      }
      if (k === undefined) break;
      rows -= e.shown.get(k).tree.nodes.length;
      e.shown.delete(k);
    }
    // Across windows too: the least recently used windows give way (their tokens then read "too old").
    e.rowsHeld = rows;
    let total = 0;
    for (const w of winStore.values()) total += w.rowsHeld ?? 0;
    for (const [key, w] of winStore) {
      if (total <= TOTAL_ROWS_MAX) break;
      if (w === e) continue;
      total -= w.rowsHeld ?? 0;
      forget(key, w);
      winStore.delete(key);
    }
  }
  tree.shown = s.rows; // describeNode() marks candidates it prints
  return s.rows;
}

// Which window a snapshot id belongs to, for any walk this hub made (shown to
// the model or not).
const snapOwners = new Map();
const deskMenus = new Map(); // snapshot id → row numbers of menu-bar items, for walks made through desk_call
function ownerOfSnapshot(sid) {
  return snapOwners.get(sid) ?? null;
}

function findShown(sid) {
  for (const e of winStore.values()) {
    const s = e.shown.get(sid);
    if (s) return { entry: e, rec: s, tree: s.tree, rows: s.rows };
  }
  return null;
}

function payloadOf(res) {
  const ok = (o) => o && typeof o === "object" && (Array.isArray(o.elements) || typeof o.tree_markdown === "string" || o.degraded);
  if (ok(res?.structuredContent)) return res.structuredContent;
  try {
    const parsed = JSON.parse(resultText(res));
    return ok(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// One AX walk. Returns { res, tree, images, ms }; tree is null when the
// upstream result is an error or not a window tree (caller passes res on).
async function fetchTree(a, signal, o = {}) {
  const args = { pid: a.pid, window_id: a.window_id, include_screenshot: o.screenshot === true };
  if (a.session !== undefined) args.session = a.session;
  const once = async () => {
    const t0 = Date.now();
    const more = { ...(needFullOutput ? { full_output: true } : {}), ...(walkTimeout ? { timeout_ms: WALK_TIMEOUT_MS } : {}) };
    const res = await backendCall("cua", "get_window_state", { ...args, ...more }, signal);
    return { res, ms: Date.now() - t0 };
  };
  let { res, ms } = await once();
  let sc = res?.isError ? null : payloadOf(res);
  if (sc && !Array.isArray(sc.elements) && sc.tree_markdown && !needFullOutput) {
    needFullOutput = true;
    ({ res, ms } = await once());
    sc = res?.isError ? null : payloadOf(res);
  }
  if (sc && sc.truncated === true && sc.truncation_reason === "timeout" && !walkTimeout) {
    walkTimeout = true;
    const again = await once();
    const sc2 = again.res?.isError ? null : payloadOf(again.res);
    if (sc2) ({ res, ms } = again), (sc = sc2);
    else walkTimeout = false; // refused all the same (something in between does not know the parameter): keep the cut walk
  }
  const tree = sc ? parseTree(sc, { pid: a.pid, windowId: a.window_id, at: Date.now(), walkMs: ms }) : null;
  const images = (res?.content ?? []).filter((c) => c.type === "image");
  if (tree && !tree.degraded && tree.snapshotId) {
    const e = rememberTree(tree);
    if (sc.screenshot_width && tree.win?.w) e.scale = sc.screenshot_width / tree.win.w;
  }
  return { res, tree, images, ms };
}

// Screenshot only, no AX walk: element_tokens survive it (measured) and it
// costs ~50ms instead of a walk that takes seconds on a heavy page.
async function fetchShot(a, signal) {
  const args = { pid: a.pid, window_id: a.window_id, include_screenshot: true, include_accessibility_tree: false };
  if (a.session !== undefined) args.session = a.session;
  const res = await backendCall("cua", "get_window_state", args, signal);
  const sc = res?.structuredContent;
  const e = res?.isError ? peekEntry(a.pid, a.window_id) : winEntry(a.pid, a.window_id);
  const w = sc?.window_bounds?.width ?? e?.latest?.win?.w;
  if (e && sc?.screenshot_width && w) e.scale = sc.screenshot_width / w;
  return { res, images: (res?.content ?? []).filter((c) => c.type === "image"), sc };
}

// The host hands the model `structuredContent` as raw JSON and drops the text
// blocks whenever a result carries one, so a hub note appended to such a
// result never arrives. Strip it when (and only when) the hub added a note.
function withVisibleNote(result, note) {
  const { structuredContent, ...rest } = result ?? {};
  const body = resultText(result) || (structuredContent !== undefined ? JSON.stringify(structuredContent) : "");
  const others = (result?.content ?? []).filter((c) => c.type !== "text");
  return { ...rest, content: [{ type: "text", text: body ? `${body}\n${note}` : note }, ...others] };
}

// A hub-native tool that has to hand an upstream result through (an error, a
// shape it does not understand) still returns text: with structuredContent
// attached the host would show the model raw JSON instead of the message.
function plain(res) {
  if (!res || res.structuredContent === undefined || !resultText(res)) return res;
  const { structuredContent, ...rest } = res;
  return rest;
}

// A locked screen makes every window's AX tree unreadable and every
// background action refused; the model used to burn ten calls trying other
// routes before guessing. Checked only when a tree comes back degraded.
function screenLocked() {
  if (process.env.DESKTOP_HUB_TEST_LOCKED) return Promise.resolve(process.env.DESKTOP_HUB_TEST_LOCKED === "1");
  return new Promise((resolve) => {
    execFile("ioreg", ["-n", "Root", "-d1"], { timeout: 2000 }, (err, out) => {
      if (err) return resolve(false);
      resolve(/"(IOConsoleLocked|CGSSessionScreenIsLocked)"\s*=\s*Yes/.test(String(out)));
    });
  });
}

const LOCKED_TEXT =
  "[desktop-hub] The screen is LOCKED: no window's accessibility tree can be read and every background action will be refused. Do not try other routes (foreground, scripts, other backends) — stop and ask the user to unlock.";

// Why a window that exists cannot be read or driven, when the hub can tell:
// the screen is locked, or the window sits on a Space the user is not on
// (they are on another desktop or in a full-screen app). With cua 0.28.x AX
// then lists no windows for that process at all; the model used to burn a
// dozen calls on other routes before giving up. null = no specific reason.
async function unreachableReason(a, signal) {
  if (await screenLocked()) return LOCKED_TEXT;
  const w = (await listWins(signal))?.find((x) => x.window_id === a.window_id);
  if (w && w.on_current_space === false) {
    return (
      `[desktop-hub] win ${a.window_id} (${w.app_name ?? "?"} ${JSON.stringify(clip(w.title ?? "", 40))}) is on ANOTHER SPACE — the user is on a different desktop or in a full-screen app. ` +
      "This driver cannot read a window's accessibility tree there, and it refuses background input to it. Nothing you can call changes that: do not retry and do not go foreground (it would pull the user over to that Space). " +
      "window_state tree:false still returns a screenshot. Report it and continue once the user is on that Space."
    );
  }
  return null;
}

async function degradedText(a, tree, signal) {
  return (
    (await unreachableReason(a, signal)) ??
    `win ${a.window_id} pid ${a.pid} · accessibility tree unavailable (${tree?.degradedReason ?? "unresolved"}). ` +
      "Usual causes: the window closed, or it belongs to another process (system Open/Save panels do), or it is minimized. " +
      "list_windows pid:<pid> shows what the process owns; window_state tree:false still returns a screenshot of a window that exists."
  );
}

async function listWins(signal) {
  try {
    const res = await backendCall("cua", "list_windows", {}, signal);
    return res?.isError ? null : windowsOf(res.structuredContent) ?? null;
  } catch {
    return null;
  }
}

// Menu-bar path of a node, e.g. ["文件","导出…"], for the "use menu" hint.
function menuPathOf(tree, n) {
  const path = [];
  for (let p = n.pos; p >= 0; p = tree.nodes[p].parent) {
    const a = tree.nodes[p];
    if ((a.role === "AXMenuItem" || a.role === "AXMenuBarItem") && a.label) path.unshift(a.label);
  }
  return path;
}

// Resolve a model-supplied element_token to a token of the window's latest
// snapshot. Throws (nothing executed) unless the element is identified beyond
// doubt. Returns { token, node, tree, note? }.
// Everything about a token that can be checked without touching the window.
// Throws (nothing executed); returns the snapshot it belongs to.
function checkToken(s) {
  const tk = parseToken(s.element_token);
  if (!tk) throw new Error(`element_token "${String(s.element_token).slice(0, 40)}" is not of the form "<snapshot>:<row>" — copy a token whole, exactly as a window_state / act reply printed it (in a tree, the header's snapshot id + the number in [ ] or ( ) of a row of that same reply)`);
  const hit = findShown(tk.sid);
  if (!hit) {
    throw new Error(
      `snapshot ${tk.sid} is not one this hub showed you (the hub or the driver restarted; it is too old — ${SHOWN_MAX} views of a window are kept, fewer on a very large one; or the id was mistyped). Nothing was executed. Every token of that snapshot is gone: take ONE fresh window_state of the window (whole, or a query naming what you still need) and use the tokens it prints, or target with find.`
    );
  }
  const { tree, rows } = hit;
  if (tree.pid !== s.pid || (s.window_id !== undefined && tree.windowId !== s.window_id)) {
    throw new Error(`element_token ${s.element_token} belongs to pid ${tree.pid} window ${tree.windowId}, not to pid ${s.pid}${s.window_id !== undefined ? ` window ${s.window_id}` : ""}. Nothing was executed.`);
  }
  if (!rows.has(tk.idx)) {
    throw new Error(
      `row ${tk.idx} was never shown to you under snapshot ${tk.sid}. A token is "<snapshot>:<row>" exactly as one reply printed them together — a row number from one reply does not go with the snapshot id of another. Nothing was executed. Use a token as printed (older ones keep working), or target with find.`
    );
  }
  // In use: this snapshot goes to the young end of the store.
  hit.entry.shown.delete(tk.sid);
  hit.entry.shown.set(tk.sid, hit.rec);
  hit.entry.lastUsed = hit.rec;
  return { ...hit, tk };
}

// Why tokens of snapshot `a` must not be carried over to the newer tree `b`
// of the same window, whatever the rows look like: it is another page, or a
// dialog now sits on top of the control.
// Native sheets/dialogs of a tree, by signature (role + first words, numbers
// folded so a progress count does not make a new sheet of it).
const sayOf = (m) => String(m.label || m.value || (m.idx === null ? m.text : "") || "").replace(/^ (?:= )?"|"$/g, "").trim();
// …and a row with a name and a value says both: 收款人 = 李四
const sayFull = (m) => (m.idx !== null && m.label && m.value !== undefined && String(m.value).trim() !== "" && m.value !== m.label ? `${String(m.label).trim()} = ${String(m.value).trim()}` : sayOf(m));
const INDICATOR = /^AX(ProgressIndicator|BusyIndicator|LevelIndicator)$/;
const SHEET_LIST_ROWS = 8;
// What a sheet is, for "has the model been shown this one":
//   - every word of it: its title, its texts, the names of its controls, the values of controls the model
//     cannot change (a disabled field 收款人 = 李四 is content) and the rows of a list in it;
//   - not what the model can type or tick in it (an enabled control's value), nor how far a progress bar is;
//   - a countdown in a disabled button's name ("重新发送(55s)") is folded;
//   - in a sheet with a busy/progress indicator, counts are folded ("3/20", "45%", "00:12", "5 秒", "1.3 GB").
//     Anywhere else a date, a time or a percentage is what the sheet asks about;
//   - a sheet with a progress BAR (an AXProgressIndicator that has a numeric value — not a level indicator:
//     a password-strength meter or a capacity gauge sits in confirm sheets) is an operation running: its
//     texts change by themselves (the file being copied) and are not part of what it is — its controls
//     are. `words` keeps those texts apart: a find that lands INSIDE such a sheet is held when they are not
//     the ones the model was shown (pressing its own button answers what it says now); work outside it is not.
// msg = the rows that say what it asks, which a reply must have printed for the sheet to count as shown:
// its title, its texts outside lists, disabled controls with a value, and the rows of a short list in it (a
// table of the three customers to delete, up to 8 rows and as long as it all fits a hold reply; not a file
// browser — `left` then says how many rows were left out). Failing all of those, its other rows with words.
function sheetsOf(tree) {
  if (tree.sheets) return tree.sheets;
  const out = new Map();
  for (const n of tree.nodes) {
    if (n.role !== "AXSheet" && n.role !== "AXDialog") continue;
    let end = n.pos + 1;
    while (end < tree.nodes.length && tree.nodes[end].depth > n.depth) end++;
    const all = [];
    const texts = []; // signature lines of plain texts (left out for a sheet with a progress bar)
    const forcedAt = new Map(); // place in `all` of a disabled tick box / radio button / button with a state → its line without the state
    const msg = [];
    const inList = [];
    let listRows = 0; // rows (direct children of a list) that say something
    let rowAt = -1;
    let rowSeen = -1;
    const alt = [];
    const btns = [];
    let listDepth = -1;
    let ticking = false;
    let bar = false;
    for (let x = n.pos; x < end; x++) {
      const m = tree.nodes[x];
      if (listDepth >= 0 && m.depth <= listDepth) listDepth = -1;
      if (listDepth < 0 && x > n.pos && /^AX(Table|Outline|List|Browser|Grid)$/.test(m.role)) {
        listDepth = m.depth;
        rowAt = x;
      } else if (listDepth >= 0 && m.depth === listDepth + 1) rowAt = x;
      const ind = INDICATOR.test(m.role);
      const field = FIELD_ROLE.test(m.role);
      const ctl = m.press || field;
      const off = m.enabled === false;
      if (ind) {
        ticking = true;
        if (m.role === "AXProgressIndicator" && m.value !== undefined && /^\s*\d+(?:\.\d+)?\s*%?\s*$/.test(String(m.value))) bar = true;
      }
      const name = String(m.label ?? "").trim();
      if (ind || (ctl && !off)) {
        if (name) all.push(`${m.role}:${name}`);
      } else if (ctl && !field) {
        // a disabled button, tick box, radio button: a countdown in its name is folded ("重新发送(55s)"); its state is content
        const dv = String(m.value ?? "").trim();
        if (name || dv) all.push(`${m.role}:${name.replace(/\d+/g, "#")}${dv && dv !== name ? `=${dv}` : ""}`);
        if (dv && dv !== name) forcedAt.set(all.length - 1, name ? `${m.role}:${name.replace(/\d+/g, "#")}` : "");
      } else {
        const line = [name, m.idx === null ? sayOf(m) : String(m.value ?? "").trim()].filter((t, k, a) => t && a.indexOf(t) === k).join("=");
        if (line) (ctl || x === n.pos ? all : texts).push(`${m.role}:${line}`);
      }
      const t = sayOf(m);
      if (!t) continue;
      if (x === n.pos) msg.push(x); // its title
      else if (m.press && !(off && String(m.value ?? "").trim() !== "")) {
        if (btns.length < 4 && !btns.includes(t)) btns.push(clip(t, 40));
      } else if (ind) continue;
      else if (listDepth >= 0) {
        inList.push(x);
        if (rowSeen !== rowAt) {
          rowSeen = rowAt;
          listRows++;
        }
      } else if (!field) msg.push(x); // a text — or a tick box the model cannot change: "同时删除全部历史订单 = 1"
      else if (off && String(m.value ?? "").trim() !== "") msg.push(x); // 收款人 = 李四, not editable: content
      else alt.push(x);
    }
    const short = listRows <= SHEET_LIST_ROWS && msg.length + inList.length <= SAYS_TEXTS;
    if (short) msg.push(...inList);
    msg.sort((a, b) => a - b);
    const fold = (t) => (!ticking ? t : t.replace(/\d+(?:\.\d+)?\s*%/g, "#%").replace(/\d+\s*(?:\/|／|of)\s*\d+/gi, "#/#").replace(/\d{1,2}:\d{2}(?::\d{2})?/g, "#:#").replace(/\d+(?:\.\d+)?\s*(?=(?:秒|分钟|小时|s|sec|secs|seconds?|min|mins|minutes?)(?![a-z]))/gi, "#").replace(/\d+(?:\.\d+)?\s*(?=(?:[kmgt]i?b|bytes?|字节)(?:\/s|ps)?(?![a-z]))/gi, "#"));
    const sha = (t) => createHash("sha1").update(t).digest("hex").slice(0, 20);
    // In a sheet with a progress bar the stage ticks ("下载 ✓ 校验 ✓ 安装 …" as disabled tick boxes) move by
    // themselves like its texts: their state goes with `words`, not into what the sheet is (round 13: every
    // stage made it another sheet, and each step OUTSIDE it was held).
    const text = fold((bar ? all.map((t, k) => (forcedAt.has(k) ? forcedAt.get(k) : t)).filter(Boolean) : [...all, ...texts]).join("\n"));
    const words = bar ? sha(fold([...texts, ...[...forcedAt.keys()].map((k) => all[k])].join("\n"))) : null;
    out.set(`${n.role}|${sha(text)}`, { node: n, end, msg: msg.length ? msg : alt, btns, words, left: short ? 0 : listRows });
  }
  return (tree.sheets = out);
}
// A sheet in words, for a reply: what it says (up to 12 texts, each up to 160 characters), then its buttons.
// full = every one of its texts is in there uncut — only then has the reply shown the sheet.
const SAYS_TEXTS = 12;
const SAYS_CHARS = 160;
// The model has been shown sheet `sig` (as `sh` stands now).
function markTold(e, sig, sh) {
  (e.sheetsTold ??= new Set()).add(sig);
  if (sh?.words) (e.barWords ??= new Map()).set(sig, sh.words);
  e.maybeGone?.delete(sig);
}
function sheetSays(tree, sh) {
  const texts = sh.msg.map((x) => sayFull(tree.nodes[x]));
  const parts = texts.slice(0, SAYS_TEXTS).map((t) => clip(t, SAYS_CHARS));
  const more = texts.length > SAYS_TEXTS ? ` / (+${texts.length - SAYS_TEXTS} more texts)` : "";
  const left = sh.left ? ` / (+ a list of ${sh.left} rows not printed here)` : "";
  const words = [...parts, ...sh.btns].join(" / ");
  return { text: `${sh.node.role}${words ? ` (${words}${more}${left})` : ""}`, full: texts.length <= SAYS_TEXTS && texts.every((t) => t.length <= SAYS_CHARS) };
}
// A reply has just shown rows of `tree` to the model: which sheets it now
// knows of, and the page address as of that reply. A sheet is known when the
// reply printed what it says — each row of its msg (see sheetsOf). Its bare
// line (max_depth) when it has more to say than its title, or one of its
// buttons a query happened to match, says a sheet is up but not what it
// asks. A sheet without a word is known by any row printed in it. The
// address is known when its row was printed.
function noteTold(e, tree) {
  e.sheetsTold ??= new Set();
  const shown = e.shown.get(tree.snapshotId)?.rows;
  const printed = (x) => !!shown && (shown.pos ? shown.pos.has(x) : tree.nodes[x].idx !== null && shown.has(tree.nodes[x].idx));
  for (const [sig, sh] of sheetsOf(tree)) {
    let told = false;
    if (sh.msg.length) told = sh.msg.every(printed);
    else for (let x = sh.node.pos + (sh.end > sh.node.pos + 1 ? 1 : 0); !told && x < sh.end; x++) told = printed(x);
    if (told) markTold(e, sig, sh);
  }
  const addr = addressOf(tree) ?? null;
  if (addr === null || printed(tree.addressPos)) e.addrTold = addr;
}
// …and when the reply did not print the address row while the address is not the one the model was last
// shown: one line that says so (a query view, an outline, a change list that was cut).
function addrNote(e, tree) {
  const addr = addressOf(tree) ?? null;
  if (addr === null || addr === e.addrTold) return "";
  const was = e.addrTold;
  e.addrTold = addr;
  return was ? `(page address now "${clip(addr, 100)}" — it was "${clip(was, 70)}" when you were last shown this window)` : `(page address: "${clip(addr, 100)}")`;
}
// The model was sent a picture of the window, with no walk: the hub does not
// know what was on it. Sheets the hub's last walk had, if that walk was made
// moments before the picture, are taken as seen; one that came up since is
// not (it may have opened after the picture), nor one from a walk long ago
// (it may have closed before the picture and come back after).
const SHOT_VOUCH_MS = 15_000;
function noteShot(e) {
  if (!e) return;
  e.lookTick = ++eventTick; // a look — but not one that ends "acted without looking" (readTick)
  e.holdPass = null;
  if (e.latest && Date.now() - (e.latest.at ?? 0) < SHOT_VOUCH_MS) {
    e.sheetsTold ??= new Set();
    for (const sig of sheetsOf(e.latest).keys()) e.sheetsTold.add(sig);
  }
}
// The model's last few looks at this window (window_state): where its tokens come from.
const LOOKS_KEPT = 4;
function noteLook(e, tree) {
  const r = e.shown.get(tree.snapshotId);
  if (!r) return;
  r.tick = eventTick; // when the model was shown it: views are asked newest first
  e.looks = [r, ...(e.looks ?? []).filter((x) => x !== r)].slice(0, LOOKS_KEPT);
}
// …and the last two action reports: rows they printed are rows the model was shown as well (not kept from eviction).
function noteReport(e, tree) {
  const r = e.shown.get(tree.snapshotId);
  if (!r) return;
  r.tick = eventTick;
  e.reports = [r, ...(e.reports ?? []).filter((x) => x !== r)].slice(0, 2);
}
// The state of the window the model was last told about in full: its last
// whole-window view, moved on by every complete change list since. (A
// snapshot it only saw some rows of is not that.)
const knownRef = (e) => canon(e.seen) ?? null;

function pageShift(a, b) {
  const ua = addressOf(a);
  const ub = addressOf(b);
  if (ua && ub && ua !== ub) return { kind: "address", from: clip(ua, 70), to: clip(ub, 70) };
  const count = (t) => t.nodes.filter((n) => n.role === "AXSheet" || n.role === "AXDialog").length;
  if (count(b) > count(a)) {
    const had = sheetsOf(a);
    const fresh = [...sheetsOf(b)].filter(([sig]) => !had.has(sig));
    const list = (fresh.length ? fresh : [...sheetsOf(b)].slice(-2)).slice(0, 3);
    const says = list.map(([, sh]) => sheetSays(b, sh));
    return { kind: "dialog", what: says.map((x) => x.text).join("; ") + (fresh.length > 3 ? `; (+${fresh.length - 3} more)` : ""), shown: list.filter((_, k) => says[k].full).map(([sig]) => sig) };
  }
  return null;
}
function voidReason(a, b, e) {
  const sh = pageShift(a, b);
  if (!sh) return null;
  const sid = a.snapshotId;
  if (sh.kind === "address") {
    if (e) e.addrTold = addressOf(b) ?? null; // this refusal names it
    return `the page address changed from "${sh.from}" to "${sh.to}" since snapshot ${sid}; its tokens are void. Nothing was executed — take a fresh window_state (whole, or a query naming what you need; diff:true prints no tokens) and use its tokens, or target with find + near.`;
  }
  if (e && b === e.latest) {
    const up = sheetsOf(b);
    for (const sig of sh.shown) markTold(e, sig, up.get(sig)); // …and says what these ask
  }
  return `a dialog/sheet opened in this window after snapshot ${sid}: ${sh.what}. Older tokens are void. Nothing was executed — look at it first (window_state with a query of its words, or whole), then use the tokens that view prints.`;
}

// Carry row `idx` of a shown snapshot over to the newer tree `to` of the same
// window. Throws (nothing executed) unless (1) the model has been shown every
// change since that snapshot and (2) the row is still unmistakably that row.
// The hub cannot know that a unique [删除] now acts on another record; what
// it can do is make sure the model saw the record change before the press.
function carry(entry, rec, to, idx) {
  const from = rec.tree;
  if (rec.retired) {
    const r = carryIndex(from, to, idx);
    shownRows(entry, to);
    const now = r.error === undefined ? [describeNode(to, r.node)] : r.candidates ?? [];
    throw new Error(
      `snapshot ${from.snapshotId} is retired: the window had changed in ways you were not shown, and then you were given the whole window again (snapshot ${rec.retired}). Nothing was executed. Take the row from that newer view${now.length ? ` — by name it would be: ${now.join("; ")}` : ""}.`
    );
  }
  const gate = voidReason(from, to, entry);
  if (gate) throw new Error(gate);
  const known = canon(rec.known);
  if (known !== to) {
    const o = { ...renderOpts({}, entry, to), maxChars: REPORT_CHARS, since: `what you had been shown (snapshot ${known.snapshotId})` };
    const d = renderDiff(known, to, o);
    if (d.text !== null && !o.used.cut) {
      toldAll(entry, known, to);
      entry.told = { tree: to, at: Date.now() };
      throw new Error(
        `the window changed after the view your token comes from, and you had not been shown how. Nothing was executed for this step. What changed:\n${d.text}\nIf this step is still what you want, send it again as it is — only this step and any after it, not the ones that already ran. The token will be accepted now.`
      );
    }
    throw new Error(
      `the window changed after the view your token comes from (snapshot ${from.snapshotId}), by more than fits here. Nothing was executed. Look again: a window_state query naming what you need prints fresh tokens (diff:true lists the changes but no tokens); or say which control by content with find + near.`
    );
  }
  const r = carryIndex(from, to, idx);
  if (r.error) {
    shownRows(entry, to); // the candidates are printed, so their tokens must be honoured
    const c = carryIndex(from, to, idx).candidates ?? [];
    const cut = to.partial ? ` — or it was not reached: the last walk of this window was cut short (${clip(to.truncated ?? "walk cut short", 100)}), which says nothing about the row being gone; look again (window_state)` : "";
    throw new Error(`${r.error}${cut}. Nothing was executed.${c.length ? ` Current candidates (usable as element_token): ${c.join("; ")}.` : ""}`);
  }
  return r;
}

// Resolve a model-supplied element_token to a token of the window's latest
// snapshot. Returns { token, node, tree, entry, note? }.
function resolveToken(s) {
  const { entry, rec, tree, tk } = checkToken(s);
  const latest = entry.latest;
  if (latest && latest.snapshotId !== tk.sid) {
    const r = carry(entry, rec, latest, tk.idx);
    return { token: `${latest.snapshotId}:${r.idx}`, node: r.node, tree: latest, entry, note: `token ${s.element_token} → ${latest.snapshotId}:${r.idx}`, carried: true };
  }
  return { token: s.element_token, node: tree.byIdx.get(tk.idx), tree, entry };
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
    const lang = typeof language === "string" ? language.toLowerCase() : "";
    if (typeof script !== "string" || !script.trim()) return resolve({ ok: false, text: "run_script needs script: the source text" });
    if (lang !== "applescript" && lang !== "jxa") {
      return resolve({ ok: false, text: `unknown language ${JSON.stringify(clip(String(language), 40))} (use "applescript" or "jxa")` });
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
// Facade tool definitions (hand-written, deliberately terse). Every session
// pays for these characters, used or not; the host silently cuts a
// description past 4,096 chars.
// ---------------------------------------------------------------------------

const TARGET_NOTE =
  'Target, in order of preference. (1) element_token "<snapshot>:<row>", copied whole from a window_state/act reply ([n] rows are pressable; (n) rows are not — an AX click there does nothing); any token a reply prints can be sent back. A token from an older reply keeps working while every change since was reported to you AND its control is the only one of that name in the window; a control that repeats (the 删除 of every table row) keeps its token only until the window changes. A refused step runs nothing and says what changed or lists current candidates. (2) find:{role?,label?,value?,near?,nth?} — located on a fresh walk: exact role, substring label/value (an exact label wins). near:"text" keeps only matches with that text (whole word) on their own visual line or in their table row — the way to press a per-row button ("删除" near "DD1005"). nth = index (from 0) in the list a refused find prints. No match or several = error listing candidate tokens. A find without near is held once (resend to confirm) if a dialog you were not shown is up or its surroundings changed unseen. (3) Pixel x,y (window-screenshot px), last resort.';

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
    description: 'Candidate windows, front-most first, one per line: window_id pid app "title" WxH @x,y (other-Space = unreachable until the user is on that Space). Covers titled windows incl. minimized/off-Space ones; untitled helper surfaces are hidden — pid:<pid> lists every window of one process (how to find an untitled sheet/dialog), all:true lists everything.',
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "integer", description: "Only this process, unfiltered." },
        on_screen_only: { type: "boolean", description: "Only the current Space. Default false." },
        all: { type: "boolean", description: "Include untitled/tiny helper windows." },
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
    description:
      'Observe one window as compact text: a header `win … snapshot <sid> · N rows`, then one row per element — `[n] Role "label" = "value"` (pressable) or `(n) …` (not pressable); rows without a number are static text. The menu bar is hidden (menus:true). query:"a|b" keeps only rows containing a term (plus ancestors; ≤3 hits in a large window: also the rows around each) — the cheap way to find a control. diff:true lists only what changed since you last saw the whole window (it prints no tokens). A screenshot costs a vision turn (include_screenshot defaults true; false with diff): use it as a checkpoint. tree:false = screenshot only, no AX walk (fast, tokens survive). Output past ~20k chars is cut with a count — narrow with query. Each walk makes cua retire the window\'s older tokens; the hub carries them forward when you have seen every change since and the row is unmistakable.',
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "integer" },
        window_id: { type: "integer", description: "From list_windows." },
        query: { description: 'Case-insensitive substring filter over role/label/value; "a|b" or an array = any term.' },
        diff: { type: "boolean", description: "Only changes since your last full view of this window (first call, or a page that mostly changed, returns the tree)." },
        include_screenshot: { type: "boolean", description: "Default true (false in diff mode)." },
        tree: { type: "boolean", description: "false = screenshot only." },
        menus: { type: "boolean", description: "Include the menu bar." },
        frames: { type: "boolean", description: "Append each element's centre as @x,y (screenshot px once a screenshot was taken) — usable as act x,y. Unlabeled icons carry it by default." },
        full_text: { type: "boolean", description: "Do not clip long values (default 500 chars per row)." },
        max_elements: { type: "integer", minimum: 1, description: "Show at most N rows." },
        max_depth: { type: "integer", minimum: 0, description: "Show rows up to this depth." },
        session: { type: "string" },
      },
      required: ["pid", "window_id"],
    },
  },
  {
    name: "act",
    description:
      "One desktop action (via cua; background delivery — no cursor/focus steal). Actions: click, double_click, right_click, type (insert text), key (one key e.g. return/tab/escape, +modifiers), hotkey (combo e.g. [\"cmd\",\"a\"]), scroll, drag, set_value (set a field/dropdown directly), menu (exact app-menu path). " +
      TARGET_NOTE +
      " pid is required (the pid given to window_state). Per action: type→text; key→key; hotkey→keys; scroll→direction(+amount,by) — pass a target or x,y to wheel-scroll that spot, otherwise arrow/Page keys go to the focused control; drag→x,y + to_x,to_y; set_value→value; menu→window_id,path; click→count:2 = pixel double-click, from_zoom:true = x,y are from the last zoom image. The reply already reports what changed in the window (observe, default on: false skips it, an object {query|include_screenshot|tree:false…} asks for a window_state-style look instead). \"NO change\" after a press means look before pressing again. Limits: background typing bypasses the IME (no pinyin composition) and cannot send characters beyond U+FFFF; there is no background hover; in web rich-text editors delete a selection before typing and move the caret with arrow keys (clicks don't); iPad-ported apps ignore synthetic scroll/drag (only desk_call oss pointer tools work there, moving the real cursor).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["click", "double_click", "right_click", "type", "key", "hotkey", "scroll", "drag", "set_value", "menu"] },
        pid: { type: "integer" },
        window_id: { type: "integer", description: "Needed for find, pixel x,y, menu, and for the change report." },
        element_token: { type: "string", description: '"<snapshot>:<n>" as printed by window_state / act.' },
        find: { type: "object", description: '{role?,label?,value?,near?,nth?} — locate the target on a fresh walk. near = a text on its line / in its table row (whole word); nth = index in the list a refused find prints.' },
        x: { type: "number", description: "Window-screenshot px (drag: start X)." },
        y: { type: "number" },
        to_x: { type: "number", description: "drag end." },
        to_y: { type: "number" },
        text: { type: "string", description: "for type." },
        key: { type: "string", description: "for key: return, tab, escape, up, down…" },
        keys: { type: "array", items: { type: "string" }, description: "for hotkey: modifiers + one key." },
        value: { type: "string", description: "for set_value." },
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "for scroll." },
        amount: { type: "integer", description: "scroll notches 1-50, default 3." },
        by: { type: "string", enum: ["line", "page"], description: "scroll granularity, default line." },
        path: { type: "array", items: { type: "string" }, description: 'for menu: exact titles, e.g. ["File","Export…"].' },
        button: { type: "string", enum: ["left", "right", "middle"] },
        modifiers: { type: "array", items: { type: "string" }, description: "cmd/shift/option/ctrl held during click/key." },
        count: { type: "integer", description: "click count 1-3 (pixel clicks)." },
        from_zoom: { type: "boolean", description: "x,y are in the last zoom image of this pid." },
        repeat: { type: "integer", description: "Repeat 1-20 times: scroll and navigation keys (arrows, tab, page up/down, home, end) only." },
        wait_ms: { type: "integer", description: "Pause after the action, 0-10000 (also the settle time before the change report)." },
        again: { type: "boolean", description: "Confirms a deliberate repeat of a press that just reported no change." },
        observe: { description: "false, true (uncapped change list), or window_state params." },
        scope: { type: "string", enum: ["window", "desktop"], description: "desktop = no pid/window_id; x,y are true screen px from desktop_screenshot." },
        delivery_mode: { type: "string", enum: ["background", "foreground"], description: "Default background." },
        session: { type: "string" },
        extra: { type: "object", description: "Escape hatch: merged into the upstream cua call." },
      },
      required: ["action"],
    },
  },
  {
    name: "act_batch",
    description:
      "Up to 8 act steps in ONE call — batch the steps you already know instead of act → look → act. Each step takes act's params; top-level pid/window_id/session/delivery_mode apply to every step. if_present:true (with find) skips a step whose target is absent. Every step is validated before any runs; the batch stops at the first failure or doubtful effect and says exactly which steps took effect. The reply ends with what changed in the window (observe as in act). 50s budget for the whole call; keep long typing in its own call.",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "object", description: "act params (action required) + optional if_present." },
        },
        pid: { type: "integer" },
        window_id: { type: "integer" },
        session: { type: "string" },
        delivery_mode: { type: "string", enum: ["background", "foreground"] },
        observe: { description: "false, true, or window_state params." },
      },
      required: ["steps"],
    },
  },
  {
    name: "verify",
    description:
      "Deterministically verify predicates against one window (via cua verify_state). expect items (ANDed, 1-8): {window:{exists:true}} | {window:{bounds:{x,y,width,height,tolerance_px}}} | {element:{selector:{role?,label_contains?}, exists:true, value_equals?, enabled?, selected?}}. Results: satisfied/unsatisfied/unknown (unknown ≠ success). Web-page content always comes back unknown (cua does not trust AX values there) — read it with window_state query instead.",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "integer" },
        window_id: { type: "integer" },
        expect: { type: "array", items: { type: "object" }, description: "Predicate objects, see tool description." },
        timeout_ms: { type: "integer", minimum: 0, maximum: 10000, description: "Wait up to this many ms (default 5000); 0 = single sample." },
        include_screenshot: { type: "boolean", description: "Also return the final screenshot." },
        session: { type: "string" },
      },
      required: ["pid", "window_id", "expect"],
    },
  },
  {
    name: "zoom",
    description: "Close-up JPEG of a window region (x1,y1)-(x2,y2) in window-screenshot px (via cua), for small text. Output is ~500px wide: a region wider than that is shrunk, not magnified. To click what you see: zoom WITH pid, then act click with from_zoom:true and x,y in zoom-image px.",
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
    description: "Escape hatch: call ANY tool on the underlying servers — cua (cua-driver: windows/browser/clipboard/recording/sessions…) or oss (computer-use-oss: AX tree, find_element, fill_form, get_app_dictionary, Spaces…). Unsure about params? desk_describe first. oss spawns on first use (a few seconds). A pixel click here is routed exactly like act's (same AX hit-test) — it is not a way around a dead click. Tokens belong in act: here an element_token is refused unless its snapshot was walked through this hub for that pid. oss pointer tools take LOGICAL screen points (1x), not desktop_screenshot's Retina pixels.",
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
].map((t) => ({ ...t, _meta: { "anthropic/alwaysLoad": true } })); // a hot tool must not sit behind tool search

// ---------------------------------------------------------------------------
// window_state
// ---------------------------------------------------------------------------

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function renderOpts(input, e, tree) {
  const o = {
    menus: input.menus === true,
    frames: input.frames === true,
    fullText: input.full_text === true,
    maxChars: MAX_TREE_CHARS,
    scale: e.scale ?? undefined,
    shown: shownRows(e, tree),
    used: {},
  };
  if (Number.isInteger(input.max_elements)) o.maxRows = input.max_elements;
  if (Number.isInteger(input.max_depth)) o.maxDepth = input.max_depth;
  return o;
}

// Text for one observation of `tree` under window_state-style params.
// Advances `seen` only when the model ends up knowing the whole window.
function observationText(input, e, tree) {
  const o = renderOpts(input, e, tree);
  const capped = o.maxRows !== undefined || o.maxDepth !== undefined;
  const hasQuery = Array.isArray(input.query) ? input.query.length > 0 : input.query !== undefined && String(input.query).trim() !== "";
  if (hasQuery) {
    let t = renderQuery(tree, input.query, o);
    // A narrow look hands out fresh tokens without the news: say when the
    // window has moved on from what the model last saw in full.
    // The newest state the model is up to date on: its last full view, else
    // the newest snapshot it holds tokens for.
    let ref = canon(e.seen);
    if (!ref) for (const rec of e.shown.values()) if (!rec.retired && rec.tree !== tree && (!ref || canon(rec.known).num > ref.num)) ref = canon(rec.known);
    if (ref && ref !== tree) {
      const oo = { ...renderOpts({}, e, tree), maxChars: QUERY_NEWS_CHARS, since: `what you had been shown (snapshot ${ref.snapshotId})` };
      const d = renderDiff(ref, tree, oo);
      // News too large to list: the rows of this look are then all the model
      // has to go on, so each hit comes with the record it sits in.
      const withRecords = () => renderQuery(tree, input.query, { ...o, context: true });
      if (d.text === null) {
        t = `${withRecords()}\n(most of the window differs from what you had been shown — tokens from earlier views will be refused)`;
        markUntold(e);
      }
      else if (d.changes && !oo.used.cut) {
        // Small enough to say outright: the model is then up to date, and its
        // older tokens need no refusal round (a page with a ticking clock
        // would otherwise cost one on every second look).
        t += `\nAlso changed since then:\n${d.text.split("\n").slice(1).join("\n")}`;
        toldAll(e, ref, tree);
      } else if (d.changes) {
        t = `${withRecords()}\n(${d.changes} row(s) of this window changed since what you had been shown — diff:true lists them; tokens from earlier views are on hold until then)`;
        markUntold(e);
      }
    }
    return input.diff === true ? `${t}\n(diff ignored: a query was given — call diff:true without query for the change list)` : t;
  }
  const full = (why) => {
    const t = renderTree(tree, o);
    // A whole-window look is the baseline for diff:true even when the size cap
    // cut it: later diffs list what changes, in the unprinted part too. Only a
    // view the caller narrowed (max_depth / max_elements) is not one.
    if (!capped && !o.used.cut) sawWhole(e, tree);
    else if (!capped) {
      e.seen = tree;
      e.seenTick = eventTick;
      e.seenPart = e.shown.get(tree.snapshotId) ?? null; // …but it vouches only for the rows it printed (a find for a control past the cut)
      // …and for the sheets it printed whole: every row of every sheet came before the cut (toldAll)
      const pp = e.seenPart?.rows.pos;
      e.seenSheets = !!pp && [...sheetsOf(tree).values()].every((sh) => { for (let k = sh.node.pos; k < sh.end; k++) if (!pp.has(k)) return false; return true; });
    }
    return why ? `[${why}]\n${t}` : t;
  };
  if (input.diff !== true) return full();
  if (!e.seen) return full("no earlier full view of this window to diff against — full tree; later diff:true calls return only changes");
  if (e.seen.snapshotId === tree.snapshotId) return full();
  const base = e.seen;
  const d = renderDiff(base, tree, o);
  if (d.text === null) return full("more than half of the window changed since your last view — full tree");
  if (!o.used.cut) toldAll(e, base, tree);
  return d.text;
}

async function handleWindowState(input, signal) {
  input = stripNulls(input); // null = not given
  if (!Number.isInteger(input.pid) || !Number.isInteger(input.window_id)) {
    return textResult("window_state requires integer pid and window_id (list_windows gives both)", true);
  }
  const qTerms = input.query === undefined || input.query === null ? [] : Array.isArray(input.query) ? input.query : [input.query];
  if (qTerms.some((t) => typeof t !== "string")) {
    return textResult('window_state: query must be text — one string ("保存|提交") or a list of strings', true);
  }
  const qLen = qTerms.reduce((n, t) => n + t.length, 0);
  if (qLen > QUERY_MAX_CHARS || (Array.isArray(input.query) && input.query.length > 30)) {
    return textResult(`window_state: query is ${qLen} characters — give a few short terms (at most ${QUERY_MAX_CHARS} characters, 30 terms), e.g. "保存|提交"`, true);
  }
  if (input.tree === false) {
    const { res, images, sc } = await fetchShot(input, signal);
    if (res?.isError || !images.length) return plain(res);
    const pe = peekEntry(input.pid, input.window_id);
    if (pe?.lastPress) pe.lastPress.noChange = false; // the model looked
    noteShot(pe);
    const size = sc?.screenshot_width ? ` ${sc.screenshot_width}x${sc.screenshot_height} px` : "";
    return { content: [{ type: "text", text: `win ${input.window_id} pid ${input.pid} · screenshot only${size} (no AX walk, element_tokens stay valid)` }, ...images] };
  }
  const wantShot = input.include_screenshot ?? input.diff !== true;
  const { res, tree, images } = await fetchTree(input, signal, { screenshot: wantShot === true });
  if (!tree) return plain(res); // upstream error / not a tree
  if (tree.degraded || !tree.snapshotId) return { content: [{ type: "text", text: await degradedText(input, tree) }, ...images] };
  const e = winEntry(input.pid, input.window_id);
  if (e.lastPress) e.lastPress.noChange = false; // the model looked: the re-press gate has done its job
  e.lookTick = e.readTick = ++eventTick;
  e.holdPass = null; // a held step's free pass ends with the next look or action on the window
  if (e.forgot) {
    // the hub had dropped this window's record; the model looks again of its own accord: start afresh
    e.forgot = false;
    e.untold = 0;
  }
  let text = observationText(input, e, tree);
  noteTold(e, tree);
  const addrLine = addrNote(e, tree);
  if (addrLine) text += `\n${addrLine}`;
  noteLook(e, tree);
  return { content: [{ type: "text", text }, ...images] };
}

// ---------------------------------------------------------------------------
// act / act_batch: one engine. The expensive part of a GUI sequence is not the
// actions but the model round-trips between them, so (1) several steps ride in
// one call, (2) a step can locate its own target (find) and (3) the reply
// already says what changed — 80% of single actions used to be followed by a
// separate observation turn, and 131 of 133 clicks came back "unverifiable",
// identical whether they landed or not.
// Discipline: validate every step before executing any; stop at the first
// failure or suspicious effect; say exactly which steps took effect.
// ---------------------------------------------------------------------------

// DESKTOP_HUB_BATCH_BUDGET_MS / DESKTOP_HUB_PROBE_MS are test knobs (the
// regression suite cannot wait 50s per case); leave them unset in real use.
const BATCH_BUDGET_MS = Number(process.env.DESKTOP_HUB_BATCH_BUDGET_MS) || 50_000;
const OBSERVE_BUDGET_MS = 10_000;
const SLOW_WALK_MS = 8_000;
const REPORT_CHARS = 1_500;
const QUERY_NEWS_CHARS = 1_500;
const OBSERVE_KEYS = new Set(["query", "diff", "include_screenshot", "tree", "menus", "frames", "full_text", "max_elements", "max_depth"]);
const QUERY_MAX_CHARS = 500;
const WHOLE_TREE_CHARS = 6_000;
const REPRESS_WINDOW_MS = 120_000;
const BLIND_WINDOW_MS = Number(process.env.DESKTOP_HUB_TEST_BLIND_MS) || 15_000;
const HOLD_PASS_MS = 60_000;
let eventTick = 0;
let deskTick = 0; // the last desktop-scoped action: it names neither a window nor a pid
const FG_SWITCH_DIR = "/var/db/desktop-hub";

// AbortSignal.any is Node ≥20.3; engines allows 18 — compose by hand.
function scopedSignal(signal, ms, why) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal?.aborted) ctrl.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new Error(why)), ms);
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

function fmtFind(f) {
  const o = pick(f, ["role", "label", "value", "near", "nth"]);
  for (const k of Object.keys(o)) if (typeof o[k] === "string") o[k] = clip(o[k], 60);
  return JSON.stringify(o);
}

// How a reply names a row it acted on: the full token, never a bare row
// number — the header of the same reply carries a NEWER snapshot id, and a
// model that pairs that id with this row's number presses something else.
// A row as a reply names it: the whole token first. Printing it is a promise
// that the token works, so the row is registered as shown.
const nodeName = (tree, n) => {
  if (tree?.snapshotId && Number.isInteger(tree.pid) && Number.isInteger(tree.windowId) && n.idx !== null) shownRows(winEntry(tree.pid, tree.windowId), tree).add(n.idx);
  return `${tree?.snapshotId ?? "?"}:${n.idx} ${n.role}${n.label ? ` ${JSON.stringify(clip(n.label, 40))}` : n.help ? ` help=${JSON.stringify(clip(n.help, 40))}` : ""}${n.press ? "" : " (not pressable)"}${n.enabled === false ? " [disabled]" : ""}`;
};

// Where a control sits, for a reply: texts find.near would accept for it, else its place in reading order.
function whereOf(tree, n, isPeer, o = {}) {
  const near = nearOf(tree, n, isPeer);
  if (near) return ` near "${near}"`;
  const h = orderHintOf(tree, n, isPeer, o);
  return h ? ` (${h} in reading order)` : "";
}

// find → the rows a step may act on. No state and no errors, so the same find can be asked of an older tree.
//   cands  every row the find matches            named  after "the name itself wins" and "what the action can use"
//   peers  the look-alikes (named before the action's kind chose among them)        pool   named, narrowed by near
const CLICKS = new Set(["click", "double_click", "right_click"]);
function findPool(tree, find, action) {
  const spec = ACTIONS[action] ?? {};
  const valueish = action === "set_value" || action === "type";
  const live = (n) => n.enabled !== false;
  const fields = (list) => (valueish ? list.filter((n) => FIELD_ROLE.test(n.role) && live(n)) : []);
  const fitOf = (list, narrowing = false) => {
    const f = fields(list);
    if (f.length) return f;
    if (narrowing && valueish && list.some((n) => FIELD_ROLE.test(n.role))) return []; // the field of that name is disabled: its value does not go into the button of that name instead
    return spec.press ? list.filter((n) => (n.press && live(n)) || (CLICKS.has(action) && wrapperOf(tree, n))) : [];
  };
  // What a click can use although it carries no AXPress: a field (a click focuses it), and outside web
  // content the text of a list, outline or table row (a click selects the row — native rows have no press
  // action at all: a mail sidebar's 收件箱, a file's name in a Finder list).
  const inNativeRow = (n) => {
    let row = false;
    for (let p = n.parent; p >= 0; p = tree.nodes[p].parent) {
      if (tree.nodes[p].role === "AXWebArea") return false;
      if (/^AX(Row|Cell|Outline|List|Table|Browser)$/.test(tree.nodes[p].role)) row = true;
    }
    return row;
  };
  const clickable = (n) => live(n) && CLICKS.has(action) && (FIELD_ROLE.test(n.role) || inNativeRow(n));
  const tier = (list) => (fields(list).length ? 2 : fitOf(list).length || list.some(clickable) ? 1 : 0);
  const cands = findNodes(tree, find);
  let named = cands;
  // "密码" also matches "确认密码", "删除" also "删除并拉黑": rows whose label IS the wanted text win over
  // substring matches — as written first, then but for spacing and width forms ("确 定", "ＯＫ"). Unless
  // none of them is something this action can use while another match is (the static "设置" above the
  // button "打开设置", the text "姓名" beside the field "请输入姓名"): then nothing is settled here and the
  // caller lists them all.
  if (find.label !== undefined && cands.length > 1) {
    const r2 = cands.filter((n) => nameRank(n, find.label) === 2);
    const r12 = cands.filter((n) => nameRank(n, find.label) > 0);
    // the name as written wins over the name but for spacing only if the action can use one of those rows
    // (a heading "删除" does not keep the click from the button "删 除")
    const exact = r2.length && tier(r2) >= tier(r12) ? r2 : r12;
    if (exact.length && tier(exact) >= tier(cands)) named = exact;
  }
  // Rows the action cannot do anything with give way to rows it can: a click on an inert or disabled row
  // is a no-op, and a value goes into a field. Only among rows of ONE name, though: "订单 DD1005" and
  // [删除 DD1005] are two things a label happened to match, and a press must not settle which was meant.
  // A find without a label or value names no thing; there the action's kind may choose.
  const peers = named; // a disabled [移除] is still a look-alike: it splits its line
  const oneName = new Set(named.map((n) => foldName(n.label))).size === 1;
  if (named.length > 1 && (oneName || (find.label === undefined && find.value === undefined))) {
    const fit = fitOf(named, true);
    if (fit.length && fit.length < named.length) named = fit;
  }
  const peerSet = new Set(peers);
  const isPeer = (m) => peerSet.has(m);
  const pool = find.near !== undefined ? named.filter((n) => nearScore(tree, n, isPeer, find.near) > 0) : named;
  return { cands, named, peers, isPeer, pool };
}
// An action was sent to window entry `w` (or may have been): for "who acted last, who looked last".
// `doubt` = it may have dismissed a sheet without the hub seeing it go — a click on a button or link
// inside one (that sheet), a return/escape/space key, a hotkey or a pixel click (any sheet that was up).
function noteActed(w, doubt) {
  w.actedAt = Date.now();
  w.actTick = ++eventTick; // order of acting and looking, by count (two of them can share a millisecond)
  w.holdPass = null;
  if (!doubt || !w.latest) return;
  const up = sheetsOf(w.latest);
  for (const [sig, sh] of up) {
    if (doubt === true || (doubt.tree === w.latest && doubt.node.pos > sh.node.pos && doubt.node.pos < sh.end)) {
      w.maybeGone ??= new Map();
      if (!w.maybeGone.has(sig)) w.maybeGone.set(sig, w.actedAt);
    }
  }
}
const DISMISS_KEYS = /^(return|enter|escape|esc|space)$/i;
const DESK_INPUT = new Set(["click", "double_click", "right_click", "type_text", "press_key", "hotkey", "scroll", "drag", "set_value", "invoke_menu"]);
const roleChain = (tree, n) => {
  const out = [];
  for (let p = n.parent; p >= 0; p = tree.nodes[p].parent) out.push(tree.nodes[p].role);
  return out.join("<");
};

// Is control `chosen` of `tree` as the model last saw it? Asked only when the hub knows the model is
// behind on this window (an earlier reply left changes out). `latest` = the hub's own newest tree when
// this call began. → { ok } or { ok:false, cd } (cd.changed = beside rows whose text differs).
//
// Go back through the views that showed this control, newest first (by when the model was shown them,
// not by snapshot number: a walk that happens to equal an old view is not a newer look) — replies that
// located it by find and said where it sat (a hold, or "find → … near …"), its recent looks and action
// reports, its last full view. The first one that printed the control TOGETHER WITH the texts beside it
// decides. A view that printed it bare (an outline listing [通过]) settles nothing and the next older one
// is asked — unless it printed a text beside it that is not there now.
//
// The view that decides stands for what the model knows: its tree, moved on by every complete change
// list since (rec.known). If that is all the hub itself knew when this call began — its newest walk,
// made after the last action sent to the window — nothing was kept from the model about this control
// and the step goes: what the page did by itself since is not something the hub could have told it (a
// countdown beside the button; the same holds for a token of the newest snapshot). Otherwise — the hub
// has seen more than the model, or an action went out that nobody looked after — the control must stand
// there as it does now: same ancestors, same texts beside it, one for one; and for a find with nth, the
// same find must count to it there.
function seenAs(fe, tree, chosen, s, latest) {
  const views = [];
  for (const r of [...(fe.placed ?? []), ...(fe.looks ?? []), ...(fe.reports ?? [])]) {
    if (fe.shown.get(r.tree.snapshotId) === r && (r.rows.pos || r.placed) && !views.some((v) => v.rec === r)) views.push({ tree: r.tree, pos: r.rows.pos ?? new Set(), placed: r.placed, tick: r.tick ?? 0, known: r.known ?? r.tree, rec: r });
  }
  const ref = knownRef(fe);
  if (ref) views.push({ tree: ref, all: true, part: fe.seenPart?.rows.pos ? fe.seenPart : null, tick: fe.seenTick ?? 0, known: ref });
  views.sort((a, b) => b.tick - a.tick); // stable: of two shown in one reply, the look or report (by what it printed) comes before the full view
  const nowRows = besideRows(tree, chosen);
  const fresh = new Set(); // rows beside the control now that a newer view printed as they stand
  for (const v of views) {
    const was = mateOf(v.tree, tree, chosen);
    if (!was) continue;
    const placed = v.placed?.has(was.pos) === true; // that reply said where this very control sat
    const shownCtl = v.all || placed || v.pos.has(was.pos);
    if (v.part) {
      // the whole-window look was cut at the size cap: what lay past the cut, the model has not seen
      const p0 = mateOf(v.part.tree, tree, chosen);
      if (!p0 || !v.part.rows.pos.has(p0.pos) || !besideRows(v.part.tree, p0).every((m) => v.part.rows.pos.has(m.pos))) continue;
    }
    if (!v.all && !placed) {
      const thenRows = besideRows(v.tree, was);
      const printed = thenRows.filter((m) => v.pos.has(m.pos));
      if (!shownCtl || printed.length !== thenRows.length) {
        // It printed the control bare, or only texts that stood beside it (a query for "选中" printed
        // "选中：客户 张伟" and not the [删除] next to it): that settles nothing — unless one of those
        // texts is not beside the control now. Then the model's newest knowledge of this spot is
        // another record, whatever an older view happens to agree with.
        // (…and unless a newer view has already printed everything that stands beside it now: after two
        // observed steps the report before last shows the previous text, which is no news to the model.)
        // (…or has printed, as it reads now, each row whose older text this view shows, while whatever else
        // stands beside the control stands as it did in this view's tree: a row that did not change is in no
        // report and need not be — round 13, "状态：待审" beside the record text.)
        const mates = new Map(nowRows.map((c) => [mateOf(v.tree, tree, c), c]));
        const stale = printed.filter((m) => !mates.has(m));
        if (stale.length && !(nowRows.length && nowRows.every((c) => fresh.has(c)))) {
          const cd = contextDiff(v.tree, tree, chosen);
          const redone = new Set(cd.changed.filter((p) => fresh.has(p.now)).map((p) => p.then));
          const then = new Set(thenRows);
          const stood = new Set([...mates].filter(([m]) => m && then.has(m)).map(([, c]) => c));
          if (!stale.every((m) => redone.has(m)) || !nowRows.every((c) => fresh.has(c) || stood.has(c))) return { ok: false, cd };
        }
        for (const m of printed) if (mates.has(m)) fresh.add(mates.get(m));
        continue;
      }
    } else if (!shownCtl) continue;
    const k = canon(v.known);
    if (latest && k === latest && (latest.tick ?? 0) >= Math.max(fe.actTick ?? 0, deskTick)) return { ok: true };
    const cd = contextDiff(k, tree, chosen);
    if (!cd.same) return { ok: false, cd };
    return s.find.nth === undefined || k === tree || findPool(k, s.find, s.action).pool[s.find.nth] === cd.was ? { ok: true } : { ok: false, nth: true };
  }
  return { ok: false };
}
// A reply located `n` of `tree` by find and said where it sits: a view of that control, like a look.
function notePlaced(e, tree, n, tick) {
  shownRows(e, tree);
  const rec = e.shown.get(tree.snapshotId);
  if (!rec) return;
  (rec.placed ??= new Set()).add(n.pos);
  rec.tick = tick;
  e.placed = [rec, ...(e.placed ?? []).filter((r) => r !== rec)].slice(0, 8); // a press with a report places twice (where it found, where it lands now)
}

// Foreground input goes to the real screen, where cua neither ties window_id
// to pid nor keeps a point inside the window (it does both in the
// background). A guard reviews the call by its pid, so the hub makes the
// pid's claim true before anything is sent. → null, or why not.
async function foregroundProblem(a, signal) {
  if (!Number.isInteger(a.window_id)) return "foreground needs an explicit integer window_id (the window to bring forward)";
  const w = (await listWins(signal))?.find((x) => x.window_id === a.window_id);
  if (!w) return `foreground needs a window this hub can see: window ${a.window_id} is not in the window list`;
  if (w.pid !== a.pid) return `window ${a.window_id} belongs to pid ${w.pid} (${clip(String(w.app_name ?? "?"), 30)}), not to pid ${a.pid}`;
  const pts = a.points.filter(([x, y]) => x !== undefined && x !== null || (y !== undefined && y !== null));
  if (!pts.length) return null;
  if (a.from_zoom) return "from_zoom coordinates cannot be checked against the window: in the foreground give window-screenshot px";
  const k = peekEntry(a.pid, a.window_id)?.scale;
  if (!k) return `the hub has not seen a screenshot of window ${a.window_id}, so it cannot tell whether a point lies inside it — take one first (window_state tree:false) and read the coordinates off it`;
  const W = (w.bounds?.width ?? 0) * k;
  const H = (w.bounds?.height ?? 0) * k;
  for (const [x, y, what] of pts) {
    if (!(typeof x === "number" && typeof y === "number" && x >= 0 && y >= 0 && x <= W + 1 && y <= H + 1)) {
      return `${what} = ${clip(String(x), 12)},${clip(String(y), 12)} lies outside window ${a.window_id} (${Math.round(W)}x${Math.round(H)} px): a foreground click there would land on whatever else is at that screen point`;
    }
  }
  return null;
}

// A step that carries its own failure category: "none" = nothing was sent
// upstream, "partial" = upstream says it delivered part, "unknown" = the call
// was cut off mid-flight and may have landed.
class StepError extends Error {
  constructor(message, executed = "none") {
    super(message);
    this.executed = executed;
  }
}

// cua action envelopes carry effect / route / escalation. Two of them are
// routine and say nothing (unverifiable; effect_unconfirmed on web content,
// where cua refuses to trust AX read-back — 26 of 26 web typings carried it
// and all had landed). The rest were right 4 times out of 4: flag those and
// stop the batch, so a dead click is not followed by typing into whatever
// holds focus.
// What a later driver puts in structuredContent when it REFUSED a call and sent nothing: either
// {status:"refused", refusal:{code,…}} or {effect:"refused", error:{code}} / {effect:"refused", code}. Any other
// structured error says nothing of the kind — code:"tool_invocation_failed" is the driver's catch-all for a call
// that died on the way, and such a call may have run.
// A later driver turns a call that RAN into an error when it cannot vouch for its own result
// ({code:"action_outcome_mismatch"|"typed_output_mismatch", execution_state:"unknown"}, "…; the tool may have
// executed"); such a text can hold the very words a refusal is recognised by ("invalid public projection",
// "missing field").
function mayHaveRun(res) {
  const sc = res?.structuredContent;
  return (!!sc && typeof sc === "object" && sc.execution_state === "unknown") || /may have executed/i.test(resultText(res));
}
function refusalCode(res) {
  const sc = res?.structuredContent;
  if (!sc || typeof sc !== "object") return undefined;
  if (sc.refusal && typeof sc.refusal === "object" && typeof sc.refusal.code === "string" && (sc.status === undefined || sc.status === "refused")) return sc.refusal.code;
  if (sc.effect === "refused") return String(sc.error?.code ?? sc.code ?? "refused");
  return undefined;
}

function actionEffect(res, s) {
  let sc = res?.structuredContent;
  if (!sc || typeof sc !== "object") {
    try { sc = JSON.parse(resultText(res)); } catch { sc = null; }
  }
  if (!sc || typeof sc !== "object") return { text: "", stop: false };
  const parts = [];
  if (sc.effect !== undefined) parts.push(`effect=${sc.effect}`);
  if (sc.route !== undefined) parts.push(`route=${sc.route}`);
  const esc = sc.escalation && typeof sc.escalation === "object" ? String(sc.escalation.reason ?? "?") : null;
  const routine = esc === null || esc === "effect_unconfirmed";
  if (esc && !routine) parts.push(`escalation=${esc}→${sc.escalation.target ?? "?"}`);
  const badEffect = sc.effect !== undefined && !["confirmed", "unverifiable"].includes(String(sc.effect));
  const wentForeground = sc.delivery?.mode === "foreground" && s.delivery_mode !== "foreground";
  const stop = badEffect || !routine || wentForeground;
  let advice = "";
  if (wentForeground) advice = " — upstream ESCALATED TO FOREGROUND (focus/cursor were taken) although background was requested";
  else if (esc === "delivery_failed" && s.action === "hotkey") advice = ' — the shortcut did not reach the background window; for paste/copy/select-all use action:"menu" with the Edit-menu path';
  else if (esc === "delivery_failed") advice = " — the input did not reach the background window";
  else if (esc === "suspected_noop" || sc.effect === "suspected_noop") advice = " — the press probably did nothing: target the nearest [n] row via find, or look at a screenshot";
  // What the driver adds in words. A later driver writes a hint and a summary on EVERY action ("The click was
  // sent but nothing confirmed it. Read what changed before clicking again…", advice to use its own batch tool):
  // on a routine result that is some 250 characters per step saying what the hub's report below it shows, so
  // they are passed on only when something is off.
  let hint = "";
  if (stop) {
    for (const k of ["hint", "next_call", "summary"]) {
      if (typeof sc[k] === "string" && sc[k]) hint += ` · ${k}: ${clip(sc[k], 200)}`;
    }
  }
  const webNote = esc === "effect_unconfirmed";
  return { text: parts.length ? ` · ${stop ? "⚠ " : ""}${parts.join(" ")}${advice}${hint}` : hint, stop, webNote };
}

// Foreground delivery takes the real cursor and focus. Where the user has
// installed the root-owned time switch (see README), the hub honours it too,
// so the rule does not rest on the PreToolUse hook alone. No directory = no
// policy configured = nothing enforced here.
function foregroundAllowed() {
  if (!existsSync(FG_SWITCH_DIR)) return true;
  try {
    const p = `${FG_SWITCH_DIR}/fg-switch.json`;
    const st = lstatSync(p);
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) !== 0 || st.nlink !== 1) return false;
    const j = JSON.parse(readFileSync(p, "utf8"));
    const now = Date.now() / 1000;
    return j?.v === 1 && Number(j.opened_at) <= now && now < Number(j.expires_at) && Number(j.expires_at) - Number(j.opened_at) <= 7200;
  } catch {
    return false;
  }
}

function outline(tree, e, why) {
  const o = { shown: shownRows(e, tree), scale: e.scale ?? undefined };
  const web = tree.nodes.find((n) => n.role === "AXWebArea");
  const rows = [];
  for (const n of tree.nodes) {
    if (n.idx === null || !n.press || !n.label || n.inMenuBar || (web && n.pos < web.pos)) continue;
    rows.push(rowText(n, o));
    if (rows.length >= 15) break;
  }
  return [`${headerLine(tree)} · ${why} — ${tree.nodes.length} rows now; first pressable rows:`, ...rows, "(window_state with a query for more)"].join("\n");
}

async function runSteps(input, signal, single) {
  const tag = single ? "act" : "act_batch";
  const steps = input.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 8) {
    return textResult("act_batch requires steps: an array of 1-8 act steps", true);
  }
  const obs = input.observe === null ? undefined : input.observe && typeof input.observe === "object" && !Array.isArray(input.observe) ? stripNulls(input.observe) : input.observe;
  if (obs !== undefined && typeof obs !== "boolean" && (typeof obs !== "object" || Array.isArray(obs))) {
    return textResult(`${tag}: observe must be true, false or an object of window_state params`, true);
  }
  if (obs && typeof obs === "object") {
    const odd = Object.keys(obs).find((k) => !OBSERVE_KEYS.has(k));
    if (odd) return textResult(`${tag} invalid (nothing executed): observe takes ${[...OBSERVE_KEYS].join(", ")} — not "${odd}"`, true);
  }
  const defaults = pick(input, ["pid", "window_id", "session", "delivery_mode"]);
  // Atomic pre-validation: NOTHING executes unless every step parses. A batch
  // that dies on step 4's typo after steps 1-3 already clicked is the worst
  // outcome — half-mutated UI plus an error message.
  const prepared = [];
  let repeats = 0;
  for (let i = 0; i < steps.length; i++) {
    try {
      const s = validateStep(steps[i], defaults);
      if (s.element_index !== undefined && s.element_token === undefined) {
        if (s.snapshot_id === undefined) throw new Error("element_index needs snapshot_id (or pass element_token)");
        s.element_token = `${s.snapshot_id}:${s.element_index}`;
      }
      if (s.element_token !== undefined && !s.find) {
        const hit = checkToken(s); // format, known snapshot, owner, shown row
        if (s.window_id === undefined) s.window_id = hit.tree.windowId; // the token names its window: report on it, gate re-presses there
      }
      if (s.delivery_mode === "foreground" && !foregroundAllowed()) {
        throw new Error("delivery_mode:foreground needs the foreground switch to be open — a valid, unexpired, root-owned /var/db/desktop-hub/fg-switch.json, which only the user can write (README: Optional foreground switch). Stay in background, or ask them.");
      }
      repeats += s.repeat ?? 0;
      prepared.push(s);
    } catch (err) {
      return textResult(`${tag}${single ? "" : ` step ${i + 1}`} invalid (nothing executed): ${err?.message ?? err}`, true);
    }
  }
  if (repeats > REPEAT_BATCH_CAP) return textResult(`${tag} invalid (nothing executed): repeat totals ${repeats}, the cap per call is ${REPEAT_BATCH_CAP}`, true);

  // Which window to report on: the top-level pair, else the single pair the
  // steps agree on.
  let target = null;
  if (Number.isInteger(input.pid) && Number.isInteger(input.window_id)) target = { pid: input.pid, window_id: input.window_id };
  else {
    const pairs = new Set(prepared.filter((s) => Number.isInteger(s.pid) && Number.isInteger(s.window_id)).map((s) => `${s.pid}:${s.window_id}`));
    if (pairs.size === 1) {
      const [p, w] = [...pairs][0].split(":").map(Number);
      target = { pid: p, window_id: w };
    }
  }
  if (target && input.session !== undefined) target.session = input.session;
  const wantObs = obs !== false && target !== null;
  const e0 = target ? peekEntry(target.pid, target.window_id) : null;
  // What the hub knew of each window these steps name, BEFORE any of them runs (a step may name another
  // window than the call's own; an earlier step must not vouch for a later one):
  //   gap    an earlier reply left changes of that window out
  //   blind  the model's last action there ran without a look after it, moments ago — a dialog that is
  //          open now is most likely its own doing (click 删除, then find 确认). A picture taken since
  //          does not change that: the hub cannot tell what was on it.
  //   latest the hub's newest tree of it
  const entryOf = new Map();
  for (const w of [target, ...prepared]) {
    if (!w || !Number.isInteger(w.pid) || !Number.isInteger(w.window_id) || entryOf.has(winKey(w.pid, w.window_id))) continue;
    const e = peekEntry(w.pid, w.window_id);
    entryOf.set(winKey(w.pid, w.window_id), { gap: onHold(e) || (!e && forgotten.has(winKey(w.pid, w.window_id)) ? -1 : 0), forgot: e ? !!e.forgot : forgotten.has(winKey(w.pid, w.window_id)), doubt: new Set(e?.maybeGone?.keys() ?? []), blind: !!e && (e.actTick ?? 0) > (e.readTick ?? 0) && Date.now() - (e.actedAt ?? 0) < BLIND_WINDOW_MS, latest: e?.latest ?? null });
  }
  const sentTo = new Map(); // window → actions this call has sent to it
  const upBefore = new Map(); // window → sheets up before this call sent anything there (the hub's entry tree, this call's first walk), minus those seen gone since
  const firstWalk = new Map(); // window → this call's first walk of it, made before it sent anything there
  const lastFind = new Map(); // window → the last find (without near) this call executed there, for the report
  // This call has walked window `wk` (`sent` = actions it had sent there by then).
  const noteWalk = (wk, en, tree, sent) => {
    const upNow = sheetsOf(tree);
    let ub = upBefore.get(wk);
    if (!ub) upBefore.set(wk, (ub = new Set(en.latest ? sheetsOf(en.latest).keys() : [])));
    if (sent === 0) for (const sig of upNow.keys()) ub.add(sig);
    for (const sig of ub) if (!upNow.has(sig)) ub.delete(sig); // dismissed meanwhile: one of the same words that comes up later in this call is this call's doing
    if (sent === 0 && !firstWalk.has(wk)) firstWalk.set(wk, tree);
  };
  let base = e0?.latest ?? null; // the window as the hub last knew it before acting
  let baseOwn = false; // …or, failing that, this call's own first walk
  const t0 = Date.now();
  const winsBefore = wantObs ? await listWins(signal) : null;

  const deadline = Date.now() + BATCH_BUDGET_MS;
  const lines = [];
  let ok = 0;
  let skipped = 0;
  let stopAt = 0;
  let stopKind = "";
  let webNote = false;
  let lastWait = undefined;
  let pressed = null; // { entry, sig } of the last press-type step, for the re-press gate

  for (let i = 0; i < prepared.length; i++) {
    const s = prepared[i];
    const spec = ACTIONS[s.action];
    const label = single ? s.action : `step ${i + 1} ${s.action}`;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      stopAt = i + 1;
      stopKind = "budget";
      break;
    }
    const scoped = scopedSignal(signal, remaining, `${BATCH_BUDGET_MS / 1000}s budget exhausted during ${label}`);
    let sent = false;
    try {
      let exec = s;
      let node = null;
      let tree = null;
      let placedNote = false; // the step's reply says where the find landed…
      let located = null; // …for this control
      const notes = [];
      if (s.find) {
        // Fresh walk right before the step: the previous step may have
        // changed the tree, and tokens die with every walk anyway.
        const f = await fetchTree(s, scoped.signal);
        if (!f.tree) throw new StepError(`find: window_state failed: ${resultText(f.res).slice(0, 200)}`);
        if (f.tree.degraded || !f.tree.snapshotId) throw new StepError(`find: ${await degradedText(s, f.tree)}`);
        // A find answers "the one control with this name"; a walk the driver cut short at its time limit cannot
        // show that there is only one, nor that there is none.
        if (f.tree.partial) {
          throw new StepError(
            `find: the driver did not get through this window (${clip(f.tree.truncated ?? "walk cut short", 120)}), so what a find would pick cannot be shown to be the only match, and what it misses cannot be shown to be absent. Nothing was sent. Look at what was reached (window_state) and act on a row's token, or try again once the app responds.`,
            "none"
          );
        }
        tree = f.tree;
        if (!base && ok === 0) {
          base = tree;
          baseOwn = true;
        }
        const wk = winKey(tree.pid, tree.windowId);
        const en = entryOf.get(wk) ?? { gap: 0, blind: false, latest: null };
        const sentHere = sentTo.get(wk) ?? 0;
        noteWalk(wk, en, tree, sentHere);
        const { cands, named, peers, isPeer, pool: matched } = findPool(tree, s.find, s.action);
        if (!cands.length) {
          if (s.if_present) {
            lines.push(`${label}: skipped (if_present, ${fmtFind(s.find)} absent)`);
            skipped++;
            continue;
          }
          const labels = pressableLabels(tree, 8);
          throw new StepError(
            `find: nothing matches ${fmtFind(s.find)} in "${clip(tree.title, 50)}" (${tree.nodes.length} rows; menu bar not searched unless role is AXMenu*).` +
              (labels.length ? ` Pressable there: ${labels.join(", ")}.` : "") +
              ` If the page is not what you expected, look first (window_state query).`
          );
        }
        const pool = matched;
        const listOf = (arr) => {
          shownRows(winEntry(tree.pid, tree.windowId), tree);
          return describeAll(tree, arr.slice(0, 6), isPeer).join("; ") + (arr.length > 6 ? `; (+${arr.length - 6} more)` : "");
        };
        const bare = fmtFind({ ...s.find, near: undefined, nth: undefined });
        if (s.find.near !== undefined) {
          // pool = every control the text can be shown to sit next to — no ranking among them
          if (!pool.length) {
            // The text may name a card/section that several of them share ("DD1002" over its line items): list those.
            const sharing = sharedBy(tree, named, s.find.near);
            if (sharing.length) {
              throw new StepError(
                `find: ${sharing.length} controls matching ${bare} sit in the card/section that says ${JSON.stringify(clip(s.find.near, 40))}, and nothing shows which of them it belongs to. Nothing was executed. Use one of them as element_token: ${listOf(sharing)}`
              );
            }
            if (s.if_present) {
              lines.push(`${label}: skipped (if_present, nothing matching ${fmtFind(s.find)} is next to that text)`);
              skipped++;
              continue;
            }
            // The text may sit beside a same-named row this action cannot use (a disabled [移除], a static "删除").
            const unfit = peers.find((n) => !named.includes(n) && nearScore(tree, n, isPeer, s.find.near) > 0);
            throw new StepError(
              `find: ${named.length} control(s) match ${bare}, but ${JSON.stringify(clip(s.find.near, 40))} cannot be shown to be next to any of them — near counts a text on the control's own visual line or in its table row, as a whole word.` +
                (unfit ? ` It IS next to ${nodeName(tree, unfit)}, which ${s.action} cannot use.` : "") +
                ` Nothing was executed. They are: ${listOf(named)} — if one of them is the one you mean, use it as element_token.`
            );
          }
          // A same-named row the action cannot use (a disabled [移除], a static "删除") that the text is
          // next to as well, in another record than every match: the text does not say which was meant.
          const rec = (n) => recordOf(tree, n, isPeer).full; // not the rows near accepts: with the line's ends taken away, two neighbours are left with the same middle text
          const sameRec = (a, b) => rec(a).length === rec(b).length && rec(a).every((m, i) => m === rec(b)[i]);
          // A plain text of the control's own name whose texts all stand beside a match too is that control's
          // title, not another record ("通知 · 有新订单时发短信 · [开关 通知] · 全天").
          const titleOf = (n, f) => !n.press && n.pos < f.pos && /^AX(StaticText|Heading)$/.test(n.role) && rec(n).every((m) => rec(f).includes(m)); // a title stands in front of its control
          const rivals = s.find.nth === undefined ? peers.filter((n) => !named.includes(n) && nearScore(tree, n, isPeer, s.find.near) > 0 && !pool.some((f) => sameRec(f, n) || titleOf(n, f))) : [];
          if (rivals.length) {
            const both = [...pool, ...rivals].sort((a, b) => a.pos - b.pos);
            throw new StepError(`find: ${JSON.stringify(clip(s.find.near, 40))} is next to ${both.length} rows matching ${bare}, ${rivals.length} of which ${s.action} cannot use — the text does not say which of them it belongs to. Nothing was executed. Use the one you mean as element_token: ${listOf(both)}`);
          }
        }
        let chosen;
        if (s.find.nth !== undefined) {
          chosen = pool[s.find.nth];
          if (!chosen) throw new StepError(`find: nth=${s.find.nth} out of range — ${pool.length} match(es), counted from 0`);
        } else if (pool.length > 1) {
          throw new StepError(`find: ${pool.length} controls match ${fmtFind(s.find)} — say which by near:"<text on its line / in its table row>" or nth (from 0 in this list), or use one of these as element_token: ${listOf(pool)}`);
        } else chosen = pool[0];
        const where = whereOf(tree, chosen, isPeer, { both: !!en.gap });
        // the page moved on since the hub last looked: the reply then says where the press landed
        const drifted = !!en.latest && en.latest !== tree && sentHere === 0 && !sameTrees(en.latest, tree);
        // A find that only names a control acts on whatever carries the name
        // now. Two things hold it once (nothing sent; the same step again
        // goes through), both about what the HUB knows the model has not seen:
        //   - a native sheet/dialog is up that no reply has shown the model
        //     (or the page address is not the one it was last shown) — unless
        //     it follows the model's own unobserved action of a moment ago
        //     (click 删除 with observe:false, then find 确认删除), or it came
        //     up after a step of this very call;
        //   - an earlier reply had to leave changes out, and this control or
        //     the texts beside it are not as the model last saw them (seenAs).
        // Text that changed on its own between the hub's last look and this
        // call is not detected — as for a token of the newest snapshot, which
        // goes out without a walk. The reply says where the press landed.
        const fe = peekEntry(tree.pid, tree.windowId);
        if (s.find.near === undefined && fe && (fe.lookTick ?? 0) > 0) {
          const reasons = [];
          const told = (fe.sheetsTold ??= new Set());
          // News: a sheet no reply has shown; one the model was shown that may have been dismissed since (a doubt
          // that stood when this call began counts for its later steps too); and a progress sheet whose own
          // button this find is about to press while its texts are not the ones the model was shown.
          const inside = (sh) => chosen.pos > sh.node.pos && chosen.pos < sh.end;
          // (For a later step of the call, its texts as they stood before the call sent anything here: what
          // an earlier step changed is the call's own doing, what had changed before it is not — round 14:
          // [新建文件夹, 停止] in one batch pressed 停止 on a copy that had moved on to another file.)
          const before = firstWalk.get(wk) ?? en.latest;
          const behind = (sig, sh) => fe.barWords?.get(sig) !== sh.words && (sentHere === 0 || (before ? sheetsOf(before).get(sig)?.words : undefined) !== fe.barWords?.get(sig));
          // (…and a progress sheet that took, during this call, the place of one whose texts had moved on unseen
          // before it — another button, another signature: its own button is held all the same.)
          const swapped = (sig, sh) => sentHere > 0 && inside(sh) && !upBefore.get(wk).has(sig) && !!before && [...sheetsOf(before)].some(([osig, o]) => o.words && o.node.role === sh.node.role && !sheetsOf(tree).has(osig) && fe.barWords?.get(osig) !== o.words);
          const news = [...sheetsOf(tree)].filter(
            ([sig, sh]) =>
              ((!told.has(sig) || (fe.maybeGone?.has(sig) && (sentHere === 0 || en.doubt?.has(sig))) || (!!sh.words && inside(sh) && behind(sig, sh))) && (sentHere === 0 || upBefore.get(wk).has(sig))) || swapped(sig, sh)
          );
          const addr = addressOf(tree);
          let moved = sentHere === 0 && fe.addrTold !== undefined && !!addr && addr !== fe.addrTold; // addrTold null = shown while the bar held no address
          // An address that keeps moving under the same path (a time parameter, a hash that follows the
          // scroll position): held once; for a minute after that — and on as long as it keeps moving —
          // the reply says the new address instead of holding every step.
          const stem = (a) => String(a).split(/[?#]/)[0];
          // (Right after the model's own unobserved action nothing is held either; the reply still says it.)
          const flux = !!fe.addrFlux && Date.now() - fe.addrFlux.at < HOLD_PASS_MS && fe.addrFlux.stem === stem(addr) && stem(fe.addrTold ?? "") === stem(addr);
          if (moved && (en.blind || flux)) {
            notes.push(`page address now "${clip(addr, 70)}"`);
            fe.addrTold = addr;
            if (flux) fe.addrFlux.at = Date.now();
            moved = false;
          }
          if ((news.length || moved) && !en.blind) {
            // Held once per step: the same step again, for the same control in the same place, goes
            // through once within a minute if nothing else was done or looked at here in between — a
            // sheet whose words keep changing must not hold it forever.
            const passKey = `${s.action}\u0000${JSON.stringify(s.find)}\u0000${chosen.role}\u0000${chosen.label ?? ""}\u0000${roleChain(tree, chosen)}`;
            const passed = fe.holdPass?.key === passKey && Date.now() < fe.holdPass.until;
            const says = news.map(([sig, sh]) => {
              const t = sheetSays(tree, sh);
              // this reply says what it asks — or every word of it was shown before, and this reply says it is up now
              if (t.full || (told.has(sig) && !sh.words)) markTold(fe, sig, sh);
              // A progress sheet shown before whose texts this reply cuts: the reply still says it is up now, which
              // is all the doubt asked — its own buttons stay guarded by its texts (barWords), whichever step of
              // a call presses them and whatever change list comes in between. (Round 13: with no change list
              // settling a doubt any more, nothing did, and every find in the window was held for good.)
              else if (told.has(sig)) fe.maybeGone?.delete(sig);
              return t.text;
            });
            const what = says.slice(0, 3).join("; ") + (says.length > 3 ? `; (+${says.length - 3} more)` : "");
            const was = fe.addrTold;
            if (moved) {
              fe.addrTold = addr; // named below, held or not
              fe.addrFlux = { at: Date.now(), stem: stem(addr) };
            }
            fe.holdPass = passed ? null : { key: passKey, until: Date.now() + HOLD_PASS_MS };
            if (passed) {
              if (news.length) notes.push(`dialog/sheet up now: ${what}`);
              if (moved) notes.push(`page address now "${clip(addr, 70)}"`);
            } else {
              if (news.length) reasons.push(`a dialog/sheet is up in this window that you have not been shown: ${what}`);
              if (moved) reasons.push(was ? `the page address changed from "${clip(was, 70)}" to "${clip(addr, 70)}" since you were last shown this window` : `the page address is now "${clip(addr, 70)}" — the address bar held no address when you were last shown this window`);
            }
          }
          // A control that an earlier step of this very call brought out is not something the model fell behind on.
          // "Brought out" = it was not there in this call's own first walk of the window, made before the
          // call sent anything there: a control that appeared by itself before the call is not this call's
          // doing. Failing such a walk — the first step was a token of the newest snapshot, which goes out
          // without one, and a walk would retire it — the hub's tree as the call began stands in for it.
          const beforeTree = firstWalk.get(wk) ?? en.latest;
          const ownDoing = sentHere > 0 && !!beforeTree && !mateOf(beforeTree, tree, chosen);
          if (en.gap && !ownDoing) {
            const seen = seenAs(fe, tree, chosen, s, en.latest ? canon(en.latest) : null);
            if (!seen.ok) {
              const diff = (seen.cd?.changed ?? []).slice(0, 2).map((c) => `"${sayRow(c.now)}" (it was "${sayRow(c.then)}")`);
              if (en.forgot) {
                reasons.push("the hub no longer holds what you last saw of this window (its record was dropped, to bound memory or because the driver restarted), so it cannot tell whether anything here is as you saw it");
                // said once: from here on this is a window the hub starts afresh on, like one never looked at
                fe.forgot = false;
                fe.untold = 0;
              } else reasons.push(
                `this window has changed by more than you were shown, and ${seen.nth ? `nth=${s.find.nth} does not count to the control it counted to in your last view of it` : `this control or the text beside it is not as you last saw it${diff.length ? ` — beside it now: ${diff.join(", ")}` : ""}`}`
              );
            }
          }
          if (reasons.length) {
            const err = new StepError(`find located ${nodeName(tree, chosen)}${where} — but ${reasons.join("; and ")}. Nothing was executed. If this is the control you mean, send the step again as it is, before doing or looking at anything else in this window; otherwise look first (window_state query).`);
            notePlaced(fe, tree, chosen, ++eventTick); // this reply has shown the model the control and where it sits
            throw err;
          }
        }
        node = chosen;
        // a bare text inside an unnamed clickable wrapper that holds nothing else: the press goes to the wrapper
        const wrap = CLICKS.has(s.action) ? wrapperOf(tree, chosen) : null;
        if (wrap) node = wrap;
        exec = { ...s, element_token: `${tree.snapshotId}:${node.idx}` };
        // The fresh token is the target; stale coordinates/indices from the
        // model's plan must not ride along and win upstream.
        delete exec.x;
        delete exec.y;
        placedNote = cands.length > 1 || s.find.near !== undefined || !!en.gap || drifted;
        located = chosen;
        notes.push(`find → ${nodeName(tree, chosen)}${wrap ? ` inside clickable ${nodeName(tree, wrap)} (pressed)` : ""}${placedNote ? where : ""}`);
      } else if (s.element_token === undefined && s.scope !== "desktop" && Number.isInteger(s.pid) && Number.isInteger(s.window_id)) {
        // A step that needs no walk (a key, typed text, a pixel click) is the first this call sends to its
        // window, the model is behind there, and a later step finds by name: walk now. Otherwise "what was
        // there before this call acted" would be read off the hub's older tree, and a control that appeared
        // by itself since would pass for one this call brought out.
        const wk = winKey(s.pid, s.window_id);
        const en = entryOf.get(wk);
        const later = prepared.slice(i + 1).filter((t) => t.pid === s.pid && t.window_id === s.window_id);
        // …unless a token step comes before the first find: this walk would retire its token. (One after a
        // find is retired by that find's own walk whatever is done here — round 13: skipping for it let a
        // sheet that came up by itself pass as this call's doing.)
        const firstFind = later.findIndex((t) => !!t.find);
        const tokenFirst = later.slice(0, firstFind < 0 ? later.length : firstFind).some((t) => t.element_token !== undefined);
        if (en?.gap && !(sentTo.get(wk) > 0) && !firstWalk.has(wk) && later.some((t) => t.find && t.find.near === undefined) && !tokenFirst) {
          const f = await fetchTree(s, scoped.signal).catch(() => null);
          if (f?.tree && !f.tree.degraded && f.tree.snapshotId) noteWalk(wk, en, f.tree, 0);
        }
      } else if (s.element_token !== undefined) {
        const r = resolveToken(s);
        node = r.node;
        tree = r.tree;
        exec = { ...s, element_token: r.token };
        delete exec.x;
        delete exec.y;
        notes.push(r.carried ? `token ${s.element_token} → ${nodeName(tree, node)}${whereOf(tree, node)}` : nodeName(tree, node));
      }
      delete exec.element_index;
      delete exec.snapshot_id;
      if (exec.extra) {
        // extra is merged last upstream; it must not re-target the step.
        const { x, y, element_token, element_index, snapshot_id, pid, window_id, ...rest } = exec.extra;
        exec = { ...exec, extra: rest };
      }
      if (node?.inMenuBar && s.action !== "menu") {
        throw new StepError(`${nodeName(tree, node)} is a menu-bar item — invoke it with action:"menu" path ${JSON.stringify(menuPathOf(tree, node))}`);
      }
      const entry = Number.isInteger(s.window_id) ? winEntry(s.pid, s.window_id) : null;
      // Re-press gate: the same control, right after a press that changed
      // nothing visible. Blind repeats are how a toggle that DID flip (with a
      // late UI update) gets flipped back.
      let sig = null;
      if (spec.press && entry) {
        if (node) {
          // which of the look-alikes (unlabeled icons, swatches), and what was asked of it
          const nth = tree.nodes.filter((m) => m.idx !== null && m.role === node.role && (m.label ?? "") === (node.label ?? "") && m.pos < node.pos).length;
          sig = `el:${s.action}\u0000${node.role}\u0000${node.label ?? ""}\u0000${node.help ?? ""}\u0000${nth}\u0000${s.action === "set_value" ? s.value : ""}\u0000${contextOf(tree, node) ?? ""}`;
        }
        else if (typeof s.x === "number" && typeof s.y === "number" && !s.from_zoom) sig = `px:${Math.round(s.x / 6)}:${Math.round(s.y / 6)}`;
        const lp = entry.lastPress;
        if (sig && lp && lp.sig === sig && lp.noChange && Date.now() - lp.at < REPRESS_WINDOW_MS && !s.again) {
          throw new StepError(
            `you pressed this same control ${Math.round((Date.now() - lp.at) / 1000)}s ago and nothing in the window changed. It may have worked with a late update (re-pressing would undo a toggle) or it may be dead (pressing again won't help). Look first — any window_state of this window clears this gate (tree:false is a quick screenshot) — or, if you are already sure, repeat the step with again:true.`
          );
        }
      }
      // What did a pixel click actually hit? cua resolves it to the AX
      // element under the point and "presses" it even when that element has
      // no press action — success is reported either way.
      if (spec.press && !node && typeof s.x === "number" && typeof s.y === "number" && entry?.scale && entry.latest && Date.now() - (entry.latest.at ?? 0) < 15_000 && s.scope !== "desktop" && !s.from_zoom) {
        const h = hitTest(entry.latest, s.x / entry.scale, s.y / entry.scale);
        if (h && !h.node.press) {
          shownRows(entry, entry.latest);
          notes.push(`pixel is over ${nodeName(entry.latest, h.node)}${h.pressableAncestor ? ` — nearest pressable: ${describeNode(entry.latest, h.pressableAncestor)}` : ""}`);
        }
      }

      if (s.delivery_mode === "foreground" && s.scope !== "desktop") {
        const why = await foregroundProblem({ pid: s.pid, window_id: s.window_id, from_zoom: s.from_zoom === true, points: [[s.x, s.y, "x,y"], [s.to_x, s.to_y, "to_x,to_y"]] }, scoped.signal);
        if (why) throw new StepError(`${why}. Nothing was executed.`);
      }

      const { tool, args } = buildActArgs(exec);
      const times = s.repeat ?? 1;
      let res;
      let eff = { text: "", stop: false };
      let done = 0;
      for (let k = 0; k < times; k++) {
        sent = true;
        res = await backendCall("cua", tool, args, scoped.signal);
        if (res?.isError && k === 0 && node && (/stale/i.test(resultText(res)) || refusalCode(res) === "stale_element_token")) {
          // Something outside this hub walked the window (another session
          // shares the daemon). The refusal means nothing ran: re-identify
          // the element in a fresh tree, once.
          // …or the token's session had ended and was just revived: a later driver retires a session's
          // snapshots with it.
          const revivedFirst = /\[desktop-hub\][^\n]*auto-revived/.test(resultText(res));
          const f = await fetchTree({ pid: s.pid, window_id: tree.windowId, session: s.session }, scoped.signal);
          if (!f.tree || f.tree.degraded || !f.tree.snapshotId) throw new StepError("upstream refused a stale token and the window could not be read again");
          // Same instant, same window: only an identical tree is re-targeted
          // (by position — it is the same walk again), anything else goes back
          // to the model.
          const twin = sameTrees(tree, f.tree, { menus: true }) ? f.tree.nodes[node.pos] : null;
          if (!twin || twin.idx === null || twin.role !== node.role || (twin.label ?? "") !== (node.label ?? "")) {
            throw new StepError("upstream refused a stale token (something else walked this window) and the window has changed since the hub looked at it — look again before repeating the step");
          }
          const r = { idx: twin.idx, node: twin };
          args.element_token = `${f.tree.snapshotId}:${r.idx}`;
          notes.push(`re-identified after ${revivedFirst ? "its session had ended and was revived" : "an outside walk"} → ${nodeName(f.tree, r.node)}`);
          res = await backendCall("cua", tool, args, scoped.signal);
        }
        if (res?.isError) break;
        done++;
        eff = actionEffect(res, s);
        if (eff.stop) break;
        if (k + 1 < times) await sleep(40, scoped.signal);
      }
      if (res?.isError) {
        const code = refusalCode(res);
        let t = resultText(res);
        if (code !== undefined) {
          // the code is what the branches below go by; the text of a structured refusal need not repeat it
          const sc = res.structuredContent;
          if (!t.trim()) t = String(sc.refusal?.message ?? sc.summary ?? sc.error?.hint ?? "refused");
          if (!t.includes(code)) t = `${t.trimEnd()} (${code})`;
        }
        const hubNote = t.indexOf("[desktop-hub]");
        const up = hubNote >= 0 ? `${t.slice(0, Math.min(hubNote, 200))} ${t.slice(hubNote)}` : t.slice(0, 300);
        if (/delivered \d+ of \d+/.test(t)) {
          throw new StepError(`${up.trim()} — [desktop-hub] delivery counts are unreliable in BOTH directions and upstream's "retry the suffix" advice repeats text: read what is actually in the field (window_state query) before typing anything more.`, "partial");
        }
        if (done > 0) throw new StepError(`repeat stopped after ${done} of ${times}: ${up.trim() || "upstream error"}`, "partial");
        if (code !== undefined && s.action === "type" && res.structuredContent?.effect === "refused") {
          // A later driver's refusal of a `type` does not always come before everything (read from its source,
          // not measured): the x,y form moves the focus to the point before it checks the key window and the
          // typing budget; with an element, a call the keyboard rules refuse still tries the accessibility write
          // first, and answers with that refusal when it cannot confirm the write.
          if (!node && Number.isFinite(s.x) && /^(window_not_key|type_text_synthesis_budget_exceeded)$/.test(code)) {
            throw new StepError(`${up.trim()} — [desktop-hub] no key was sent, but the driver moves the focus to the point before it decides this: the focus may now be at (${s.x},${s.y}).`, "unknown");
          }
          if (node && /^(same_pid_keyboard_ambiguity|minimized_or_hidden_window)$/.test(code)) {
            throw new StepError(`${up.trim()} — [desktop-hub] no keystroke was sent, but with an element the driver first tries to write the text through accessibility and answers with this refusal when it cannot confirm that write: the text may be in the field. Read the field before typing again (set_value replaces whatever it holds).`, "unknown");
          }
        }
        if (/same_pid_keyboard_ambiguity/.test(t)) {
          // Measured on cua 0.28.2 (an Edge with two windows): type, key, hotkey and the px form of type_text are all refused.
          throw new StepError(
            `${up.trim()} — [desktop-hub] this app has another top-level window, and cua cannot aim background keystrokes at one of them: type, key and hotkey are all refused here, and repeating them will not help. Still possible in the background: clicks, menu, and set_value on a field (in web pages not for purely numeric text, which the page discards). Otherwise this step needs the user — the other window closed, or the foreground switch. Say so and stop rather than work around it.`,
            "none"
          );
        }
        if (/window_not_key/.test(t)) {
          // Later drivers aim keys at one window of a multi-window app by making it the app's key window first;
          // when that cannot be confirmed they refuse with this code and send nothing.
          throw new StepError(`${up.trim()} — [desktop-hub] the driver could not make this window the app's key window, so no key was sent. A click into the field first (find, then click) may give it the focus; set_value on a field and menu do not depend on it.`, "none");
        }
        if (/off_space_or_ax_unresolved|ax_unresolved/.test(t) && Number.isInteger(s.window_id)) {
          const why = await unreachableReason(s, scoped.signal);
          if (why) throw new StepError(why, "none");
        }
        throw new StepError(up.trim() || "upstream error", !mayHaveRun(res) && (code !== undefined || /refus|rejected|stale|not found|invalid|missing/i.test(t)) ? "none" : "unknown");
      }
      // Measured on cua 0.28.2 / Edge: an AX-written value that reads as a number
      // ("888", "12.5", "-5", "1e3") leaves a web <input> EMPTY, while "888a" or "1,000" stick.
      if (s.action === "set_value" && node && /^AXText(Field|Area)$/.test(node.role) && /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$|^\s*[+-]?(inf(inity)?|nan)\s*$/i.test(String(s.value))) {
        let web = false;
        for (let p = node.parent; p >= 0 && !web; p = tree.nodes[p].parent) web = tree.nodes[p].role === "AXWebArea";
        if (web) notes.push("⚠ a purely numeric value written this way usually leaves a web input EMPTY (the page discards it) — check the field; if it is empty, only typing can fill it");
      }
      const revived = /\[desktop-hub\][^\n]*auto-revived[^\n]*/.exec(resultText(res))?.[0];
      lines.push(`${label}: ok${times > 1 ? ` ×${done}${done < times ? ` of ${times}` : ""}` : ""}${notes.length ? ` (${notes.join("; ")})` : ""}${eff.text}${revived ? ` · ${revived}` : ""}`);
      webNote ||= !!eff.webNote;
      ok++;
      if (entry) entry.lastPress = spec.press && sig ? { sig, at: Date.now(), noChange: false } : null; // any other action in between resets the gate
      // An action may have closed a sheet. Until a walk made moments after it finds the sheet still up, or
      // a reply shows it again, one of the same words that is up at a LATER call (after the moment in which
      // the model's own follow-up is let through) may be another one: "会话即将过期" dismissed, and back by
      // itself. What can dismiss: a click on a button or link in the sheet; return/escape/space (aimed at a
      // control or not), a key with a modifier other than shift, a hotkey, a menu item; a pixel click. Typing
      // into its fields or ticking its boxes does not (round 11: every step of a login sheet was held as
      // "not shown").
      // …nor does an editing key aimed at a text field: select all, copy/cut/paste, undo, the caret by word or
      // line (round 13: cmd+a, cmd+v into the two fields of a login sheet, and every later step was held).
      const editKey = s.action === "key" && !!node && /^AX(TextField|TextArea|SecureTextField|SearchField|ComboBox)$/.test(node.role) && /^(a|c|v|x|z|left|right)$/i.test(String(s.key ?? "")) && (s.modifiers ?? []).every((m) => /^(cmd|command|option|alt|shift)$/i.test(String(m)));
      const keyish = s.action === "hotkey" || s.action === "menu" || (s.action === "key" && !editKey && (DISMISS_KEYS.test(String(s.key ?? "")) || (s.modifiers ?? []).some((m) => !/^shift$/i.test(String(m)))));
      const doubt = keyish || (node && tree ? CLICKS.has(s.action) && /^AX(Button|Link|MenuButton)$/.test(node.role) && { tree, node } : CLICKS.has(s.action) && typeof s.x === "number");
      if (entry) {
        if (placedNote && located && tree) notePlaced(entry, tree, located, eventTick); // as it stood before this action
        noteActed(entry, doubt);
        sentTo.set(winKey(s.pid, s.window_id), (sentTo.get(winKey(s.pid, s.window_id)) ?? 0) + 1);
        if (s.find && s.find.near === undefined && located) lastFind.set(winKey(s.pid, s.window_id), { find: s.find, action: s.action, role: located.role, label: located.label ?? "", part: s.find.label !== undefined && nameRank(located, s.find.label) === 0 });
        else lastFind.delete(winKey(s.pid, s.window_id));
      } else if (s.scope !== "desktop" && Number.isInteger(s.pid)) {
        // no window named (a key or typed text with a pid only): it went to one of this app's windows
        for (const [key, w] of winStore) if (key.startsWith(`${s.pid}:`)) noteActed(w, doubt);
      } else if (s.scope === "desktop") deskTick = ++eventTick; // only "has anything been done since the hub last walked" asks for this
      if (spec.press && entry && sig) pressed = entry;
      else if (entry === pressed) pressed = null;
      if (eff.stop) {
        stopAt = i + 1;
        stopKind = "effect";
        break;
      }
    } catch (err) {
      const aborted = scoped.signal.aborted;
      const how = err instanceof StepError ? err.executed : sent && !/^backend "\w+" failed to start/.test(String(err?.message ?? "")) ? "unknown" : "none";
      const what = how === "none" ? "not executed" : how === "partial" ? "PARTIALLY executed" : "outcome UNKNOWN — it may have executed or still be running";
      lines.push(`${label}: FAILED (${what}) — ${err?.message ?? err}`);
      if (how !== "none" && s.scope === "desktop") deskTick = ++eventTick;
      else if (how !== "none" && Number.isInteger(s.pid)) {
        // it may have run: for "who acted last, who looked last" it did
        for (const [key, w] of winStore) if (Number.isInteger(s.window_id) ? key === winKey(s.pid, s.window_id) : key.startsWith(`${s.pid}:`)) noteActed(w, true);
      }
      stopAt = i + 1;
      stopKind = how;
      // The batch deadline (not a host cancel) cut the call short: the
      // backend is probably just slow, but make sure it is not hung.
      if (aborted && !signal?.aborted) probeBackendAfterDeadline("cua");
      break;
    } finally {
      scoped.cleanup();
    }
    lastWait = s.wait_ms;
    if (s.wait_ms) await sleep(Math.min(s.wait_ms, Math.max(0, deadline - Date.now())), signal);
  }

  const total = prepared.length;
  let head = "";
  if (stopKind === "budget") {
    head = `[${tag}] ${BATCH_BUDGET_MS / 1000}s budget exhausted before step ${stopAt}: ${ok} step(s) ran and took effect, ${total - stopAt + 1} not run.`;
  } else if (stopKind === "effect") {
    head = `[${tag}] STOPPED after step ${stopAt} of ${total}: it ran but its effect is doubtful (⚠ below); ${total - stopAt} later step(s) not run.`;
  } else if (stopAt) {
    const self = stopKind === "partial" ? "the failing step PARTIALLY executed" : stopKind === "unknown" ? "the failing step may have executed (outcome unknown)" : "";
    const before = ok ? `${ok} earlier step(s) DID take effect — do not re-issue them` : self || "nothing took effect";
    head = `[${tag}] FAILED at step ${stopAt} of ${total}: ${before}; ${total - stopAt} later step(s) not run.${ok && self ? ` Also: ${self}.` : ""}`;
  } else if (!single) {
    head = `[${tag}] all ${total} steps done — ${ok} ok, ${skipped} skipped.`;
  }
  if (single && stopAt && stopKind !== "effect") head = ""; // the one step line says it all
  if (webNote) lines.push("(web content: cua cannot confirm typed text by read-back there — that is normal, not a failure)");

  const out = [head, ...lines].filter(Boolean);
  let images = [];
  if (obs !== false && !target && obs !== undefined) out.push("observe: skipped — needs pid + window_id");
  if (wantObs && (ok > 0 || stopKind === "unknown" || stopKind === "partial")) {
    let e = winEntry(target.pid, target.window_id);
    if (lastWait === undefined && !signal?.aborted) await sleep(300, signal);
    const scoped = scopedSignal(signal, OBSERVE_BUDGET_MS, "observation timed out");
    const tickAtObserve = eventTick + 1;
    try {
      if (obs && typeof obs === "object" && obs.tree === false) {
        const sh = await fetchShot(target, scoped.signal);
        images = sh.images;
        if (!sh.res?.isError) {
          e = winEntry(target.pid, target.window_id);
          noteShot(e);
        }
        out.push(sh.res?.isError ? `observe: ${resultText(sh.res).slice(0, 200)}` : `win ${target.window_id} · screenshot only (no AX walk)`);
      } else if (e.walkMs > SLOW_WALK_MS && !(obs && typeof obs === "object")) {
        out.push(`observation skipped: the last AX walk of this window took ${(e.walkMs / 1000).toFixed(1)}s — call window_state (with a query) when you need to look.`);
      } else {
        const wantShot = obs && typeof obs === "object" && obs.include_screenshot === true;
        const q = await fetchTree(target, scoped.signal, { screenshot: wantShot });
        images = q.images;
        // This walk may have revealed a driver restart, which empties the
        // store: `e` would then be an orphan and the tokens printed below
        // would be refused as "not shown".
        e = winEntry(target.pid, target.window_id);
        if (!q.tree) out.push(`observe: ${resultText(q.res).slice(0, 200) || "window_state failed"}`);
        else if (q.tree.degraded || !q.tree.snapshotId) out.push(await degradedText(target, q.tree));
        else {
          const winsAfter = await listWins(scoped.signal);
          const delta = windowDelta(winsBefore, winsAfter, target.pid);
          out.push(...delta);
          e.lookTick = e.readTick = ++eventTick; // this reply reports a look
          e.holdPass = null;
          if (obs && typeof obs === "object") {
            out.push(observationText({ ...obs, pid: target.pid, window_id: target.window_id }, e, q.tree));
          } else {
            // Report the delta since the hub's last look before this call: that is
            // what THIS call did (plus whatever the page did meanwhile). Diffing
            // against an older full view would repeat the same large delta in
            // every report once one of them had been clipped.
            // …unless a step of this call was refused with a change list: the
            // model is then up to date as of that list, and the report goes on
            // from there (else the retried step would be refused once more).
            let from = base && ownerOfSnapshot(base.snapshotId) ? base : null; // a base from before a driver restart is no base
            if (from && e.told && e.told.at >= t0 && (e.told.tree.num ?? -1) > (from.num ?? -1)) from = e.told.tree;
            if (!from || from.snapshotId === q.tree.snapshotId) {
              out.push(firstLook(q.tree, e, "no earlier observation of this window to compare with"));
            } else {
              const o = { ...renderOpts({}, e, q.tree), maxChars: obs === true ? MAX_TREE_CHARS : REPORT_CHARS };
              o.since =
                e.seen && canon(from) === canon(e.seen) ? "your last view" : baseOwn ? "just before this action" : `the previous look ${Math.max(0, Math.round((t0 - (from.at ?? t0)) / 1000))}s ago`;
              const gap = e.seen && canon(e.seen) !== canon(from) ? diffTrees(canon(e.seen), from).changes : 0;
              const d = renderDiff(from, q.tree, o);
              if (d.text === null) out.push(firstLook(q.tree, e, "more than half of the window changed"));
              else {
                out.push(d.text);
                if (!o.used.cut) toldAll(e, from, q.tree); // every snapshot that was current up to `from` stays current
                else markUntold(e);
                if (o.used.cut) out.push("(not every change is listed above, so element_tokens from earlier views are on hold — look again before reusing one, or say which control by content: find + near)");
                if (gap) out.push(`(${gap} earlier change(s) since your last full view are not listed — window_state diff:true shows everything)`);
                if (!d.changes && !d.moved && !delta.length && pressed === e && e.lastPress) {
                  e.lastPress.noChange = true;
                  out.push(
                    "The press may not have landed, the effect may be outside the AX tree (canvas, another window), or the page updates late. Do NOT blindly repeat a toggle or a submit — look first (window_state tree:false = quick screenshot)."
                  );
                }
              }
            }
          }
        }
      }
      if (e.latest && e.shown.has(e.latest.snapshotId) && (e.readTick ?? 0) >= tickAtObserve) { // a walk was reported (a picture shows no rows)
        noteTold(e, e.latest);
        const addrLine = addrNote(e, e.latest);
        if (addrLine) out.push(addrLine);
        noteReport(e, e.latest);
        // While the model is behind on this window, the report also says where the find it just used lands
        // NOW. That line is a view of the control on the hub's newest tree, so the next press of it is not
        // held for what this very report listed (the queue's head gone, the step's title changed, a clock
        // beside it): approving five orders in a row cost nine calls without it.
        const lf = stopAt ? null : lastFind.get(winKey(target.pid, target.window_id));
        if (lf && onHold(e)) {
          const fp = findPool(e.latest, lf.find, lf.action);
          const now = lf.find.nth !== undefined ? fp.pool[lf.find.nth] : fp.pool.length === 1 ? fp.pool[0] : null;
          if (now) {
            const wrap = CLICKS.has(lf.action) ? wrapperOf(e.latest, now) : null;
            out.push(`(find ${fmtFind(lf.find)} now lands on ${nodeName(e.latest, now)}${wrap ? ` inside clickable ${nodeName(e.latest, wrap)}` : ""}${whereOf(e.latest, now, fp.isPeer, { both: true })})`);
            // a view of the control the model just pressed — not of another thing the find matches now that
            // the last one of that name is gone ("通过" used up, the link "通过记录" left): that one is held.
            // A find that named only part of the label ("通过" for "通过 DD1001", "通过下一条 (剩 3)") lands on
            // the next such one: a name that carries the order or a count differs every time (round 13).
            if (now.role === lf.role && ((now.label ?? "") === lf.label || (lf.part && nameRank(now, lf.find.label) === 0))) notePlaced(e, e.latest, now, eventTick);
          }
        }
      }
    } catch (err) {
      out.push(`observe: failed — ${err?.message ?? err}`);
    } finally {
      scoped.cleanup();
    }
  }
  return { content: [{ type: "text", text: out.join("\n") }, ...images], isError: !!stopAt };
}

// First look at a window (or a page that mostly changed): the whole compact
// tree when it is small, an outline otherwise.
function firstLook(tree, e, why) {
  const o = { ...renderOpts({}, e, tree), shown: undefined, used: undefined, maxChars: WHOLE_TREE_CHARS };
  if (!renderRows(tree, o).cut) {
    const t = renderTree(tree, renderOpts({}, e, tree));
    sawWhole(e, tree);
    return `[${why} — full tree]\n${t}`;
  }
  if (e.seen || e.shown.size > 1) markUntold(e); // the model held views of this window and got only an outline of the new one
  return outline(tree, e, why);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// A pass-through result that carries a hub note AND structuredContent would
// reach the model as the bare JSON (the host drops the text blocks): fold it
// into one text block so the note survives.
function surfaceHubNotes(res) {
  if (!res || res.structuredContent === undefined) return res;
  const t = resultText(res);
  const at = t.indexOf("[desktop-hub]");
  if (at < 0) return res;
  const { structuredContent, ...rest } = res;
  const others = (res.content ?? []).filter((c) => c.type !== "text");
  return { ...rest, content: [{ type: "text", text: `${JSON.stringify(structuredContent)}\n${t.slice(at)}` }, ...others] };
}

function stripNulls(v) {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (x !== null && x !== undefined) out[k] = stripNulls(x);
    return out;
  }
  return v;
}

// One extra desk_describe round-trip per mistyped parameter, 4 times in 20
// desk_calls: answer the "what does this tool take" question in the error.
async function schemaHint(server, tool) {
  try {
    const t = (await backendTools(server)).find((x) => x.name === tool);
    if (!t) return "";
    const props = Object.entries(t.inputSchema?.properties ?? {}).map(([k, v]) => `${k}${v?.type ? `:${v.type}` : ""}`);
    return `[desktop-hub] ${tool} takes — required: ${(t.inputSchema?.required ?? []).join(", ") || "none"}; parameters: ${props.join(", ")}`;
  } catch {
    return "";
  }
}

const ACT_TOP_KEYS = ["observe"];
const BATCH_KEYS = new Set(["steps", "pid", "window_id", "session", "delivery_mode", "observe"]);

async function handleCall(name, input, signal) {
  switch (name) {
    case "desktop_screenshot":
      return surfaceHubNotes(await backendCall("cua", "get_desktop_state", pick(input, ["session"]), signal));
    case "list_windows": {
      for (const k of Object.keys(input)) if (input[k] === null) delete input[k]; // null = not given
      if (input.pid !== undefined && !Number.isInteger(input.pid)) return textResult("list_windows: pid must be an integer (omit it to list every app's windows)", true);
      const res = await backendCall("cua", "list_windows", pick(input, ["pid", "on_screen_only"]), signal);
      const wins = res?.isError ? null : windowsOf(res.structuredContent);
      if (!wins) return plain(res);
      return textResult(renderWindows(wins, { pid: input.pid, all: input.all === true }));
    }
    case "launch_app":
      if (!["bundle_id", "name"].some((k) => typeof input[k] === "string" && input[k].trim()) && !(Array.isArray(input.urls) && input.urls.length)) {
        return textResult("launch_app needs bundle_id (preferred), name, or urls", true);
      }
      return surfaceHubNotes(await backendCall("cua", "launch_app", pick(input, ["bundle_id", "name", "urls"]), signal));
    case "window_state":
      return handleWindowState(input, signal);
    case "act": {
      const step = { ...input };
      for (const k of ACT_TOP_KEYS) delete step[k];
      return runSteps({ steps: [step], observe: input.observe, pid: input.pid, window_id: input.window_id, session: input.session }, signal, true);
    }
    case "act_batch": {
      const bad = Object.keys(input).find((k) => !BATCH_KEYS.has(k));
      if (bad) return textResult(`act_batch invalid (nothing executed): "${bad}" is not a top-level parameter (steps, pid, window_id, session, delivery_mode, observe) — per-step params go inside steps[]`, true);
      return runSteps(input, signal, false);
    }
    case "verify": {
      if (!Number.isInteger(input.pid) || !Number.isInteger(input.window_id) || !Array.isArray(input.expect) || !input.expect.length) {
        return textResult("verify requires integer pid and window_id and a non-empty expect list", true);
      }
      // Upstream rejects (not clamps) out-of-range AND non-integer timeout_ms,
      // and from 0.30 rejects nulls where 0.28 accepted them.
      const a = stripNulls(pick(input, ["pid", "window_id", "expect", "timeout_ms", "include_screenshot", "session"]));
      if (typeof a.timeout_ms === "string" && a.timeout_ms.trim() !== "" && Number.isFinite(Number(a.timeout_ms))) a.timeout_ms = Number(a.timeout_ms);
      if (typeof a.timeout_ms === "number") a.timeout_ms = Math.round(Math.min(Math.max(a.timeout_ms, 0), 10000));
      const res = await backendCall("cua", "verify_state", a, signal);
      const t = res?.structuredContent !== undefined ? JSON.stringify(res.structuredContent) : resultText(res);
      if (/untrusted_source/.test(t)) {
        return withVisibleNote(res, "[desktop-hub] unknown(untrusted_source): this is web content, where cua never trusts AX values. It is not a failure signal — read the text with window_state query instead.");
      }
      return surfaceHubNotes(res);
    }
    case "zoom":
      return surfaceHubNotes(await backendCall("cua", "zoom", pick(input, ["pid", "window_id", "x1", "y1", "x2", "y2"]), signal));
    case "run_script": {
      const r = await runOsascript(input.language, input.script, input.timeout_s, signal);
      return textResult(r.text, !r.ok);
    }
    case "desk_call": {
      // Passed through verbatim, with one check: a guard reviews the call by
      // its pid, so an element_token must not point at another process's
      // window. Snapshot ids come from this hub's own walks (cua retires a
      // window's tokens on every walk), so a token of a snapshot the hub knows
      // has a known owner.
      if (input.server === "cua" && input.args && typeof input.args === "object") {
        const a = input.args;
        const given = (v) => v !== undefined && v !== null;
        const tk = typeof a.element_token === "string" ? parseToken(a.element_token) : null;
        const sid = tk ? tk.sid : typeof a.snapshot_id === "string" ? a.snapshot_id : null;
        if (given(a.delivery_mode) && a.delivery_mode !== "background" && a.delivery_mode !== "foreground") {
          return textResult(`desk_call ${clip(String(input.tool), 40)}: delivery_mode must be exactly "background" or "foreground". Nothing was sent.`, true);
        }
        if (a.delivery_mode === "foreground") {
          // the same checks as for act: the user's switch (whatever the scope), the window's owner, the point inside the window
          if (!foregroundAllowed()) return textResult(`desk_call ${clip(String(input.tool), 40)}: delivery_mode:foreground needs the foreground switch to be open — a valid, unexpired, root-owned /var/db/desktop-hub/fg-switch.json, which only the user can write (README: Optional foreground switch). Nothing was sent.`, true);
          const why = a.scope === "desktop" ? null : await foregroundProblem({ pid: a.pid, window_id: a.window_id, from_zoom: a.from_zoom === true, points: [[a.x, a.y, "x,y"], [a.from_x, a.from_y, "from_x,from_y"], [a.to_x, a.to_y, "to_x,to_y"]] }, signal);
          if (why) return textResult(`desk_call ${clip(String(input.tool), 40)}: ${why}. Nothing was sent.`, true);
        }
        if (given(a.element_token) || given(a.snapshot_id) || given(a.element_index)) {
          if (given(a.element_token) && !tk) return textResult(`desk_call ${clip(String(input.tool), 40)}: element_token is not of the form "<snapshot>:<row>". Nothing was sent.`, true);
          if (given(a.element_index) && !Number.isInteger(a.element_index)) return textResult(`desk_call ${clip(String(input.tool), 40)}: element_index must be an integer. Nothing was sent.`, true);
          if (tk && ((given(a.snapshot_id) && a.snapshot_id !== tk.sid) || (given(a.element_index) && a.element_index !== tk.idx))) {
            return textResult(`desk_call ${clip(String(input.tool), 40)}: element_token and snapshot_id / element_index name different elements. Nothing was sent.`, true);
          }
          const owner = sid ? ownerOfSnapshot(sid) : null;
          // A snapshot this hub never saw minted (another session, an earlier
          // daemon) has no owner it can vouch for.
          if (!owner) return textResult(`desk_call ${clip(String(input.tool), 40)}: snapshot ${clip(String(sid ?? "(none given)"), 20)} was not minted through this hub, so the element cannot be tied to a process. Nothing was sent. Take a get_window_state through the hub first — or use act, which does all of this.`, true);
          if (owner.pid !== a.pid || (given(a.window_id) && owner.windowId !== a.window_id)) {
            return textResult(`desk_call ${clip(String(input.tool), 40)}: the element token belongs to pid ${owner.pid} window ${owner.windowId}, not to pid ${a.pid}${given(a.window_id) ? ` window ${a.window_id}` : ""}. Nothing was sent.`, true);
          }
          // Menu-bar items go through act menu (a path a guard can review).
          // The row is looked up in THAT snapshot's own tree, never by number in another.
          const idx = tk ? tk.idx : a.element_index;
          const menuRows = deskMenus.get(sid) ?? (findShown(sid) ? new Set(findShown(sid).tree.nodes.filter((n) => n.inMenuBar && n.idx !== null).map((n) => n.idx)) : peekEntry(owner.pid, owner.windowId)?.latest?.snapshotId === sid ? new Set(peekEntry(owner.pid, owner.windowId).latest.nodes.filter((n) => n.inMenuBar && n.idx !== null).map((n) => n.idx)) : null);
          if (input.tool !== "get_window_state") {
            if (!menuRows) return textResult(`desk_call ${clip(String(input.tool), 40)}: snapshot ${sid} is no longer one this hub holds (cua would refuse it as stale anyway). Nothing was sent — walk the window again.`, true);
            if (menuRows.has(idx)) return textResult(`desk_call ${clip(String(input.tool), 40)}: that element is a menu-bar item — invoke it with act action:"menu" and its path. Nothing was sent.`, true);
          }
        }
      }
      let res;
      // Input sent past the facade is an action all the same: for "who acted last, who looked last", and
      // for a sheet it may have dismissed. As on the act path, typed text, a set value, a scroll or a plain
      // key cannot dismiss one (round 13: after a desk_call type_text every step of a shown sheet was held).
      // A key the hub does not know (" ", "spacebar", "escape " — act refuses those, desk_call passes them on)
      // or modifiers in a form it cannot read count as able to.
      const deskActed = () => {
        if (input.server !== "cua" || !DESK_INPUT.has(input.tool)) return;
        const a = input.args ?? {};
        if (Number.isInteger(a.pid) && a.scope !== "desktop") {
          const plain = input.tool === "type_text" || input.tool === "set_value" || input.tool === "scroll" || (input.tool === "press_key" && isKeyName(a.key) && !DISMISS_KEYS.test(a.key) && (a.modifiers === undefined || (Array.isArray(a.modifiers) && a.modifiers.every((m) => typeof m === "string" && /^shift$/i.test(m)))));
          for (const [key, w] of winStore) if (Number.isInteger(a.window_id) ? key === winKey(a.pid, a.window_id) : key.startsWith(`${a.pid}:`)) noteActed(w, !plain);
        } else deskTick = ++eventTick;
      };
      try {
        res = await backendCall(input.server, input.tool, input.args ?? {}, signal);
        // An error that is not a refusal may have run all the same (a timeout): as in act, it counts.
        if (!(res?.isError && !mayHaveRun(res) && /refus|rejected|stale|not found|invalid|missing|validation error|unknown (field|parameter)/i.test(resultText(res)))) deskActed();
        // A walk made through desk_call mints tokens too: remember whose they are, and which rows are menu-bar items.
        if (input.server === "cua" && input.tool === "get_window_state" && !res?.isError && Number.isInteger(input.args?.pid)) {
          const sc = payloadOf(res);
          if (typeof sc?.snapshot_id === "string") {
            snapOwners.set(sc.snapshot_id, { pid: input.args.pid, windowId: input.args.window_id });
            if (snapOwners.size > 512) snapOwners.delete(snapOwners.keys().next().value);
            try {
              const t = parseTree(sc, { pid: input.args.pid, windowId: input.args.window_id });
              deskMenus.set(sc.snapshot_id, new Set(t.nodes.filter((n) => n.inMenuBar && n.idx !== null).map((n) => n.idx)));
              if (deskMenus.size > 64) deskMenus.delete(deskMenus.keys().next().value);
            } catch {
              // an unparsable walk: its tokens will be refused (no menu information)
            }
          }
        }
      } catch (err) {
        if (/-32602|validation|Invalid arguments/i.test(String(err?.message))) {
          const hint = await schemaHint(input.server, input.tool);
          return textResult(`desktop-hub error: ${err?.message ?? err}${hint ? `\n${hint}` : ""}`, true);
        }
        if (!/^backend "\w+" failed to start/.test(String(err?.message ?? ""))) deskActed(); // sent, and no answer: it may have run
        throw err;
      }
      if (res?.isError && /Missing required|Invalid arguments|invalid_type|validation error|unknown (field|parameter)/i.test(resultText(res))) {
        const hint = await schemaHint(input.server, input.tool);
        if (hint) return withVisibleNote(res, hint);
      }
      return surfaceHubNotes(res);
    }
    case "desk_describe": {
      const tools = await backendTools(input.server);
      if (input.tool) {
        const t = tools.find((x) => x.name === input.tool);
        if (!t) return textResult(`tool ${JSON.stringify(clip(String(input.tool), 60))} not found on ${input.server}. Available: ${tools.map((x) => x.name).join(", ")}`, true);
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
  { name: "desktop-hub", version: "0.3.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "macOS desktop automation facade over cua-driver (background, no cursor/focus steal) + computer-use-oss + osascript. " +
      "Prefer app APIs/CLI/Bash for non-GUI outcomes and Playwright for web pages. Scriptable app → run_script first. " +
      "GUI loop: list_windows → window_state(pid, window_id[, query]) → act / act_batch. Every act reply already says what changed in the window, so look again only when that is not enough. " +
      "TEXT FIRST: the rows from window_state are the primary sense; every image costs a full vision turn, so take screenshots (include_screenshot:true, tree:false, zoom, desktop_screenshot) as checkpoints — when a press reports no change, on canvas/iPad-ported/WebView content, or right before an irreversible step. " +
      "Batch the steps you already know in one act_batch. Never repeat a press that reported no change without looking first. " +
      "After a context compaction or resume, tokens quoted in a summary are void — observe again. " +
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
