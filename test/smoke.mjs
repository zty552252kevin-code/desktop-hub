#!/usr/bin/env node
// Regression smoke test for desktop-hub. Run: npm test
// Covers: tool surface + token budget, facade validation fast-fails, cua
// backend round-trip, run_script, output-validation passthrough (real cua +
// deterministic fixture), session auto-revive (deterministic fixture),
// window_state diff mode (deterministic fixture), clean shutdown (no orphans).
// Set DESKTOP_HUB_TEST_OSS=1 to also exercise the oss backend (slow npx spawn).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}
function textOf(res) {
  return (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

const transport = new StdioClientTransport({ command: "node", args: [SERVER] });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);
const serverPid = transport.pid ?? transport._process?.pid;

// 1. Tool surface + token budget
const { tools } = await client.listTools();
check("11 facade tools", tools.length === 11, `got ${tools.length}`);
const defTokens = Math.round(JSON.stringify(tools).length / 4);
check("tool defs under 3k tokens", defTokens < 3000, `~${defTokens}`);

// 2. Facade validation fast-fails (no backend spawn needed)
for (const [args, needle] of [
  [{ action: "type" }, 'requires "text"'],
  [{ action: "double_click", element_token: "tok" }, 'requires "pid"'],
  [{ action: "set_value", value: "x" }, 'requires "pid"'],
  [{ action: "nope" }, "unknown action"],
]) {
  const r = await client.callTool({ name: "act", arguments: args });
  check(`act ${JSON.stringify(args)} fast-fails`, r.isError && textOf(r).includes(needle), textOf(r).slice(0, 120));
}

// 3. run_script (local osascript, no backend)
const rs = await client.callTool({ name: "run_script", arguments: { language: "applescript", script: "return 1 + 1" } });
check("run_script 1+1", !rs.isError && textOf(rs).trim() === "2", textOf(rs).slice(0, 120));
const rsCjk = await client.callTool({ name: "run_script", arguments: { language: "applescript", script: 'return "中文输出正常"' } });
check("run_script CJK intact", !rsCjk.isError && textOf(rsCjk).includes("中文输出正常"), textOf(rsCjk).slice(0, 120));
const rsErr = await client.callTool({ name: "run_script", arguments: { language: "applescript", script: "error \"boom\"" } });
check("run_script error surfaces", rsErr.isError && textOf(rsErr).includes("boom"), textOf(rsErr).slice(0, 120));
// Language is normalized (uppercase "JXA" must NOT silently run as AppleScript)
const rsJxa = await client.callTool({ name: "run_script", arguments: { language: "JXA", script: "'jxa-ok'" } });
check("run_script JXA case-insensitive", !rsJxa.isError && textOf(rsJxa).trim() === "jxa-ok", textOf(rsJxa).slice(0, 120));
const rsBadLang = await client.callTool({ name: "run_script", arguments: { language: "python", script: "1" } });
check("run_script rejects unknown language", rsBadLang.isError && textOf(rsBadLang).includes("unknown language"), textOf(rsBadLang).slice(0, 120));
// Huge output must NOT kill the script (side effects after the flood must
// land) and the returned body must be clipped, not the raw megabytes.
const SFX = `/tmp/hub-smoke-sfx-${process.pid}`;
try { unlinkSync(SFX); } catch { /* stale */ }
const rsBig = await client.callTool({ name: "run_script", arguments: { language: "jxa", script: `
  ObjC.import('Foundation');
  const out = $.NSFileHandle.fileHandleWithStandardOutput;
  const data = $('x'.repeat(1 << 20)).dataUsingEncoding($.NSUTF8StringEncoding);
  out.writeData(data); out.writeData(data); out.writeData(data);
  $.NSFileManager.defaultManager.createFileAtPathContentsAttributes(${JSON.stringify(SFX)}, $.NSData.data, $());
  'end';
` } }, undefined, { timeout: 120_000 });
const bigText = textOf(rsBig);
check("run_script 3MB output: script survives (side effect landed)", existsSync(SFX));
check("run_script 3MB output: returned body clipped", !rsBig.isError && bigText.includes("chars dropped") && bigText.length < 20_000, `len=${bigText.length}`);
try { unlinkSync(SFX); } catch { /* already gone */ }

// 4. cua backend round-trip (spawns backend lazily)
const lw = await client.callTool({ name: "list_windows", arguments: {} }, undefined, { timeout: 60_000 });
check("list_windows via cua", !lw.isError && textOf(lw).length > 0, textOf(lw).slice(0, 120));
const dd = await client.callTool({ name: "desk_describe", arguments: { server: "cua" } });
check("desk_describe cua catalog", !dd.isError && /cua: \d+ tools/.test(textOf(dd)), textOf(dd).slice(0, 80));
const ddTool = await client.callTool({ name: "desk_describe", arguments: { server: "cua", tool: "clipboard_read" } });
check("desk_describe cua tool schema", !ddTool.isError && textOf(ddTool).includes("inputSchema"));
const ddMiss = await client.callTool({ name: "desk_describe", arguments: { server: "cua", tool: "no_such" } });
check("desk_describe unknown tool errors", ddMiss.isError && textOf(ddMiss).includes("not found"));
// 5. -32602 time bomb regression: desk_describe's listTools() makes the SDK
// client cache output validators, and cua 0.20.0 responses violate their own
// declared outputSchema — with real validation every cua tool is broken from
// this point on (worst case: upstream action ran, caller told it failed).
// Must stay green with the passthrough validator.
const lw2 = await client.callTool({ name: "list_windows", arguments: {} }, undefined, { timeout: 60_000 });
check("cua tools survive desk_describe (-32602 defused)", !lw2.isError && textOf(lw2).length > 0, textOf(lw2).slice(0, 160));

// 6. deterministic validation-arming guard: the real-cua check above only
// fails when the live response happens to violate cua's schema (it is
// content-dependent — drag/scroll envelopes do, list_windows sometimes
// doesn't). This fixture backend ALWAYS violates its declared outputSchema,
// covering both lazily-armed SDK checks: schema-invalid structuredContent
// (-32602) and missing structuredContent on a schema-declaring tool (-32600,
// which fires on a merely truthy cached validator — the reason the hub's
// getValidator returns undefined). Any reintroduction of output validation
// fails here reliably.
{
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "schema-violating-backend.mjs");
  const t2 = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: { ...process.env, DESKTOP_HUB_CUA_BIN: FIXTURE },
  });
  const c2 = new Client({ name: "smoke-fixture", version: "0" });
  try {
    await c2.connect(t2);
    // The guard is meaningless unless arming actually happened — the hub wraps
    // internal failures (fixture spawn, listTools throw) into isError results.
    const arm = await c2.callTool({ name: "desk_describe", arguments: { server: "cua" } });
    check("fixture desk_describe arms validation", !arm.isError, textOf(arm).slice(0, 160));
    const dv = await c2.callTool({ name: "desk_call", arguments: { server: "cua", tool: "list_windows", args: {} } });
    check("schema-violating structuredContent passes through post-listTools (-32602 guard)", !dv.isError && textOf(dv).includes("violating-ok"), textOf(dv).slice(0, 160));
    const dv2 = await c2.callTool({ name: "desk_call", arguments: { server: "cua", tool: "content_only", args: {} } });
    check("missing structuredContent passes through post-listTools (-32600 guard)", !dv2.isError && textOf(dv2).includes("content-only-ok"), textOf(dv2).slice(0, 160));
  } catch (e) {
    check("fixture guard block ran without protocol errors", false, String(e).slice(0, 160));
  } finally {
    await c2.close().catch(() => {});
  }
}

// 7. session auto-revive: cua rejects every call on an idle-expired lifecycle
// session (action NOT executed). The hub must revive + retry exactly once,
// append an actionable correction to the misleading upstream hint on
// cross-transport revival failures, refuse to blind-retry rejections it did
// not itself receive (embedded/quoted rejections, generic errors), and never
// echo "not executed" once a retry has actually been dispatched.
{
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "session-expiry-backend.mjs");
  const t3 = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: { ...process.env, DESKTOP_HUB_CUA_BIN: FIXTURE },
  });
  const c3 = new Client({ name: "smoke-revive", version: "0" });
  try {
    await c3.connect(t3);
    const ok = await c3.callTool({ name: "desk_call", arguments: { server: "cua", tool: "expires_once", args: {} } });
    check("expired session auto-revived + retried", !ok.isError && textOf(ok).includes("revive-retry-ok"), textOf(ok).slice(0, 160));
    check("auto-revive success carries staleness note", textOf(ok).includes("auto-revived"), textOf(ok).slice(0, 200));
    check("structuredContent survives the staleness note", ok.structuredContent?.elements?.[0]?.element_token === "tok-1", JSON.stringify(ok.structuredContent ?? null).slice(0, 120));
    const q = await c3.callTool({ name: "desk_call", arguments: { server: "cua", tool: "quoted_name", args: {} } });
    check("session label with apostrophe still revives", !q.isError && textOf(q).includes("quoted-retry-ok"), textOf(q).slice(0, 200));
    const loop = await c3.callTool({ name: "desk_call", arguments: { server: "cua", tool: "always_ended", args: {} } });
    check("revive retries exactly once (no loop)", loop.isError && textOf(loop).includes("sess-b-call-2") && !textOf(loop).includes("sess-b-call-3"), textOf(loop).slice(0, 200));
    const named = await c3.callTool({ name: "desk_call", arguments: { server: "cua", tool: "unrevivable", args: {} } });
    check("cross-transport revive failure keeps original error + actionable hint", named.isError && textOf(named).includes("has ended") && textOf(named).includes("NEW session label"), textOf(named).slice(0, 260));
    const gen = await c3.callTool({ name: "desk_call", arguments: { server: "cua", tool: "generic_error", args: {} } });
    check("generic cua error passes through untouched (no spurious revive)", gen.isError && textOf(gen).includes("call 1") && !textOf(gen).includes("[desktop-hub]"), textOf(gen).slice(0, 160));
    const emb = await c3.callTool({ name: "desk_call", arguments: { server: "cua", tool: "embedded_rejection", args: {} } });
    check("quoted inner rejection does NOT re-run the outer call", emb.isError && textOf(emb).includes("call 1") && !textOf(emb).includes("[desktop-hub]"), textOf(emb).slice(0, 200));
    const ws = await c3.callTool({ name: "window_state", arguments: { pid: 1, window_id: 2, max_elements: 50, max_depth: 5, include_screenshot: false } });
    check("window_state passes max_elements/max_depth through", !ws.isError && textOf(ws).includes('"max_elements":50') && textOf(ws).includes('"max_depth":5'), textOf(ws).slice(0, 200));
    // Crash scenarios LAST — each kills the fixture (auto-respawned with
    // fresh state on the next call, exercising the throw paths).
    const rc = await c3.callTool({ name: "desk_call", arguments: { server: "cua", tool: "revive_crash", args: {} } }, undefined, { timeout: 60_000 });
    check("revive-throw keeps original not-executed error + note", rc.isError && textOf(rc).includes("has ended") && textOf(rc).includes("failed to complete"), textOf(rc).slice(0, 220));
    const rc2 = await c3.callTool({ name: "desk_call", arguments: { server: "cua", tool: "retry_crash", args: {} } }, undefined, { timeout: 60_000 });
    check("retry-throw reports outcome UNKNOWN, never 'not executed'", rc2.isError && textOf(rc2).includes("Outcome UNKNOWN") && !textOf(rc2).includes("was rejected"), textOf(rc2).slice(0, 220));
  } catch (e) {
    check("session-revive fixture block ran without protocol errors", false, String(e).slice(0, 160));
  } finally {
    await c3.close().catch(() => {});
  }
}

// 7.5 window_state diff mode: deterministic scripted-tree fixture. Covers
// baseline establishment (+ screenshot default-off upstream), the no-change
// one-liner, a real delta (value change with index move, insertion, shift-run
// compression, token-rebase header, tree_markdown hint), cache-key separation
// by query, degraded trees never moving the baseline, >50% churn fail-open,
// and plain (non-diff) window_state both staying byte-clean AND moving the
// baseline.
{
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "window-state-backend.mjs");
  const t4 = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: { ...process.env, DESKTOP_HUB_CUA_BIN: FIXTURE },
  });
  const c4 = new Client({ name: "smoke-diff", version: "0" });
  try {
    await c4.connect(t4);
    const ws = (args) => c4.callTool({ name: "window_state", arguments: { pid: 1, window_id: 2, ...args } });

    const r1 = await ws({ diff: true });
    const x1 = textOf(r1);
    check("diff 1st call: full tree + baseline note", !r1.isError && x1.includes("baseline established") && x1.includes('"element_token"'), x1.slice(0, 160));
    check("diff defaults include_screenshot:false upstream", x1.includes('"received_include_screenshot":false'), x1.slice(0, 200));

    const r2 = await ws({ diff: true });
    const x2 = textOf(r2);
    check("diff no-change one-liner", !r2.isError && x2.includes("no changes vs baseline") && x2.includes('"s2:<index>"'), x2.slice(0, 240));
    check("no-change response is compact (no elements JSON)", !x2.includes('"element_token"') && x2.length < 600, `len=${x2.length}`);

    const r3 = await ws({ diff: true });
    const x3 = textOf(r3);
    check("diff header shows snapshot lineage s2→s3", x3.includes("s2→s3"), x3.slice(0, 160));
    check("diff value change + index move rendered", x3.includes('~ [3] AXTextField "Name" (was [2]) value ""→"kevin"'), x3);
    check("diff insertion rendered with frame", x3.includes('+ [2] AXButton "Cancel" (80,30,60×20)'), x3);
    check("diff shift-run compressed", x3.includes("> [4-5] unchanged, indices +1 vs baseline"), x3);
    check("diff token-rebase header", x3.includes('"s3:<index>"'), x3.slice(0, 400));
    check("diff tree_markdown hint with added line", x3.includes('md+ - AXStaticText = "hello kevin"') && x3.includes("+1/−1 lines"), x3);
    check("diff omits unchanged elements", !x3.includes('"element_token"') && !x3.includes('"OK"'), x3);

    const rq = await ws({ diff: true, query: "ok" });
    check("different query = separate baseline (full tree again)", !rq.isError && textOf(rq).includes("baseline established"), textOf(rq).slice(0, 160));

    const r4 = await ws({ diff: true });
    const x4 = textOf(r4);
    check("degraded tree passes through full with note", !r4.isError && x4.includes("degraded/ax-unresolved") && x4.includes('"degraded":true'), x4.slice(0, 200));

    const r5 = await ws({ diff: true });
    const x5 = textOf(r5);
    check("degraded did not move baseline (diff is s3→s5)", x5.includes("s3→s5"), x5.slice(0, 160));
    check("window-relative frame change rendered", x5.includes('~ [4] AXButton "Help" (was [5]) frame (10,130,60×20)→(40,130,60×20)'), x5);
    check("removal rendered with old index", x5.includes('- [4] AXMenuItem "Quit" (old index)'), x5);

    const r6 = await ws({ diff: true });
    const x6 = textOf(r6);
    check("churn >50% falls open to full tree", !r6.isError && x6.includes(">50% of elements changed") && x6.includes('"element_token"'), x6.slice(0, 200));

    const r7 = await ws({});
    const x7 = textOf(r7);
    check("plain window_state stays passthrough (no diff notes)", !r7.isError && x7.includes('"element_token"') && !x7.includes("[diff]"), x7.slice(0, 200));
    const r8 = await ws({ diff: true });
    const x8 = textOf(r8);
    check("plain window_state moved the baseline (s7→s8 no changes)", x8.includes("no changes vs baseline") && x8.includes('"s8:<index>"'), x8.slice(0, 240));
  } catch (e) {
    check("window_state diff fixture block ran without protocol errors", false, String(e).slice(0, 160));
  } finally {
    await c4.close().catch(() => {});
  }
}

// 7.6 act_batch: deterministic action-recording fixture. Covers the happy
// path (fresh-token find injection, execution order, facade keys never leak
// upstream, observe appendix), atomic pre-validation (bad step N = zero
// upstream actions), ambiguous-find hard fail with candidates, find.nth,
// if_present skip-and-continue, find-miss failure, truncated-tree absence
// unprovable, mid-batch failure stopping the remainder, and find on
// non-element actions being rejected.
{
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "act-batch-backend.mjs");
  const t5 = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: { ...process.env, DESKTOP_HUB_CUA_BIN: FIXTURE },
  });
  const c5 = new Client({ name: "smoke-batch", version: "0" });
  try {
    await c5.connect(t5);
    const batch = (args) => c5.callTool({ name: "act_batch", arguments: args });
    const logNow = async () => JSON.parse(textOf(await c5.callTool({ name: "desk_call", arguments: { server: "cua", tool: "get_actions_log", args: {} } })));

    const h = await batch({
      pid: 1,
      window_id: 2,
      steps: [
        { action: "click", find: { role: "AXButton", label: "ok" } },
        { action: "type", text: "hi", wait_ms: 10 },
        { action: "key", key: "return" },
      ],
      observe: true,
    });
    const ht = textOf(h);
    check("batch happy path all ok", !h.isError && ht.includes("all 3 steps done — 3 ok, 0 skipped"), ht.slice(0, 200));
    check("batch find injects fresh token", ht.includes("find → sb1:1"), ht.slice(0, 300));
    check("batch observe appends window_state", ht.includes("baseline established"), ht.slice(-200));
    check("batch step line surfaces cua effect/route", ht.includes("step 1 click: ok (find → sb1:1) · effect=confirmed route=accessibility"), ht.slice(0, 400));
    check("batch flags abnormal effect + escalation", ht.includes("step 2 type: ok · ⚠ effect=suspected_noop route=synthetic_events escalation=delivery_failed→foreground"), ht.slice(0, 500));
    check("batch plain-text result keeps bare ok", ht.includes("step 3 key: ok\n") || ht.endsWith("step 3 key: ok"), ht.slice(0, 500));
    const tl = await c5.listTools();
    const ws = tl.tools.find((t) => t.name === "window_state"), ab = tl.tools.find((t) => t.name === "act_batch");
    check("text-first guidance in window_state + act_batch descriptions", /Text-first/.test(ws.description) && /tree-only/.test(ab.description) && /3-6 deterministic steps/.test(ab.description), (ws.description + ab.description).slice(0, 200));
    let lg = await logNow();
    check(
      "batch executes in order with clean upstream args",
      lg.length === 3 && lg[0].tool === "click" && lg[0].args.element_token === "sb1:1" &&
        lg[1].tool === "type_text" && lg[1].args.text === "hi" && lg[2].tool === "press_key" &&
        lg.every((e) => e.args.find === undefined && e.args.if_present === undefined && e.args.wait_ms === undefined),
      JSON.stringify(lg).slice(0, 300)
    );

    const v = await batch({ pid: 1, window_id: 2, steps: [{ action: "click", find: { label: "OK" } }, { action: "type" }] });
    check("batch atomic validation blocks all steps", v.isError && textOf(v).includes("step 2 invalid (nothing executed)"), textOf(v).slice(0, 160));
    check("batch invalid → zero upstream actions", (await logNow()).length === 3);

    const a = await batch({ pid: 1, window_id: 2, steps: [{ action: "click", find: { label: "Dup" } }] });
    check("ambiguous find hard-fails with candidates", a.isError && textOf(a).includes("2 elements match") && textOf(a).includes("[4]") && textOf(a).includes("nth"), textOf(a).slice(0, 300));

    const n2 = await batch({ pid: 1, window_id: 2, steps: [{ action: "click", find: { label: "Dup", nth: 1 } }] });
    lg = await logNow();
    check("find.nth picks the right duplicate", !n2.isError && lg[lg.length - 1].args.element_token?.endsWith(":5"), JSON.stringify(lg[lg.length - 1] ?? null));

    const p = await batch({ pid: 1, window_id: 2, steps: [{ action: "click", find: { label: "Nope" }, if_present: true }, { action: "key", key: "escape" }] });
    const pt = textOf(p);
    check("if_present absent skips and continues", !p.isError && pt.includes("skipped (if_present") && pt.includes("step 2 key: ok") && pt.includes("1 ok, 1 skipped"), pt.slice(0, 300));

    const m = await batch({ pid: 1, window_id: 2, steps: [{ action: "click", find: { label: "Nope" } }] });
    check("find miss without if_present fails", m.isError && textOf(m).includes("no element matches"), textOf(m).slice(0, 200));

    const tr = await batch({ pid: 1, window_id: 2, session: "trunc", steps: [{ action: "click", find: { label: "Nope" }, if_present: true }] });
    const trt = textOf(tr);
    check("if_present miss on incomplete tree skips with caveat", !tr.isError && trt.includes("skipped (if_present") && trt.includes("absence unproven"), trt.slice(0, 260));

    const tr2 = await batch({ pid: 1, window_id: 2, session: "trunc", steps: [{ action: "click", find: { label: "Nope" } }] });
    check("required find miss on incomplete tree says INCOMPLETE", tr2.isError && textOf(tr2).includes("INCOMPLETE") && textOf(tr2).includes("absence unproven"), textOf(tr2).slice(0, 260));

    const before = (await logNow()).length;
    const f = await batch({
      pid: 1,
      window_id: 2,
      steps: [
        { action: "click", find: { label: "Cancel" } },
        { action: "set_value", value: "boom", find: { role: "AXTextField" } },
        { action: "click", find: { label: "OK" } },
      ],
    });
    const ftxt = textOf(f);
    lg = await logNow();
    check("mid-batch failure stops the rest", f.isError && ftxt.includes("FAILED at step 2") && ftxt.includes("1 not run") && ftxt.includes("DID execute"), ftxt.slice(0, 300));
    check("failed batch really stopped upstream", lg.length === before + 2 && lg[lg.length - 1].tool === "set_value", `${lg.length - before} actions after failure point`);

    const u = await batch({ pid: 1, window_id: 2, steps: [{ action: "menu", path: ["File"], find: { label: "x" } }] });
    check("find rejected for non-element action", u.isError && textOf(u).includes('not supported for action "menu"'), textOf(u).slice(0, 160));
  } catch (e) {
    check("act_batch fixture block ran without protocol errors", false, String(e).slice(0, 160));
  } finally {
    await c5.close().catch(() => {});
  }
}

// 8. optional oss backend
if (process.env.DESKTOP_HUB_TEST_OSS === "1") {
  const dc = await client.callTool({ name: "desk_call", arguments: { server: "oss", tool: "list_running_apps", args: {} } }, undefined, { timeout: 180_000 });
  check("desk_call oss list_running_apps", !dc.isError, textOf(dc).slice(0, 120));
} else {
  console.log("skip oss backend (set DESKTOP_HUB_TEST_OSS=1 to include)");
}

// 9. clean shutdown: closing our side must reap OUR server AND its backends.
// Check by pid, not by pgrep name-match — other MCP hosts (live Claude Code
// sessions) legitimately run their own desktop-hub instances concurrently.
await client.close();
await new Promise((r) => setTimeout(r, 2500));
if (serverPid) {
  let serverAlive = true;
  try { process.kill(serverPid, 0); } catch { serverAlive = false; }
  check("server exits on host close", !serverAlive, `pid ${serverPid} still alive`);
  let kids = "";
  try { kids = execFileSync("pgrep", ["-lP", String(serverPid)], { encoding: "utf8" }); } catch { /* none = good */ }
  check("no orphaned backends", kids.trim() === "", kids.trim());
} else {
  check("server exits on host close", false, "could not determine server pid");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall green");
process.exit(failures ? 1 : 0);
