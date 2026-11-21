#!/usr/bin/env node
// Regression smoke test for desktop-hub. Run: npm test
// Covers: tool surface + token budget, facade validation fast-fails, cua
// backend round-trip, run_script, output-validation passthrough (real cua +
// deterministic fixture), session auto-revive (deterministic fixture),
// v0.3.0 observation + action engine against a fake cua that follows the
// real snapshot rules (fixtures/fake-cua.mjs), clean shutdown (no orphans).
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

const transport = new StdioClientTransport({ command: "node", args: [SERVER], env: { ...process.env } }); // the SDK passes on six variables by default: DESKTOP_HUB_CUA_BIN and friends must reach the hub
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);
const serverPid = transport.pid ?? transport._process?.pid;

// 1. Tool surface + token budget
const { tools } = await client.listTools();
check("11 facade tools", tools.length === 11, `got ${tools.length}`);
const defChars = JSON.stringify(tools).length;
check("tool defs ≤ 13,500 chars of JSON", defChars <= 13_500, `${defChars}`);
check("every tool carries _meta anthropic/alwaysLoad === true", tools.every((t) => t._meta?.["anthropic/alwaysLoad"] === true), tools.filter((t) => t._meta?.["anthropic/alwaysLoad"] !== true).map((t) => t.name).join(","));
// The host silently cuts a description (and the instructions) past 4,096.
const longDesc = tools.filter((t) => (t.description ?? "").length > 4096).map((t) => `${t.name}=${t.description.length}`);
check("every tool description ≤ 4,096 chars", longDesc.length === 0, longDesc.join(","));
const instr = client.getInstructions() ?? "";
check("server instructions present and ≤ 4,096 chars", instr.length > 0 && instr.length <= 4096, `${instr.length}`);

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
    // The retry carries structuredContent AND a hub note: the host would show
    // only the JSON, so the hub folds both into one text block (JSON first,
    // then the note) and drops structuredContent.
    check("expired session auto-revived + retried", !ok.isError && textOf(ok).startsWith('{"elements":[{"element_token":"tok-1"}]}\n'), textOf(ok).slice(0, 160));
    check("auto-revive success carries staleness note", textOf(ok).includes("\n[desktop-hub] session 'sess-a' had expired; auto-revived it and retried this call"), textOf(ok).slice(0, 200));
    check("structuredContent + hub note → one text block, no structuredContent", ok.structuredContent === undefined && ok.content.length === 1 && ok.content[0].type === "text", JSON.stringify(ok).slice(0, 160));
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
    // v0.3.0 always walks the whole window; max_* only limit what is shown.
    // This fixture echoes its arguments (not a tree, so it passes through).
    const ws = await c3.callTool({ name: "window_state", arguments: { pid: 1, window_id: 2, max_elements: 50, max_depth: 5, query: "x", include_screenshot: false } });
    check("window_state sends neither max_* nor query upstream", !ws.isError && textOf(ws) === 'echo:{"pid":1,"window_id":2,"include_screenshot":false}', textOf(ws).slice(0, 200));
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

// 7.5–7.6 v0.3.0 observation + action engine, against fixtures/fake-cua.mjs:
// a backend that follows the real driver's snapshot rules (every walk mints a
// new snapshot and retires the window's older tokens). "Nothing executed" is
// always proven with the fake's action log, never with reply text alone. Each
// subsection uses its own window_id, so baselines and the re-press gate of
// one never leak into another.
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-cua.mjs");
async function fakeHub(name, env = {}) {
  const t = new StdioClientTransport({ command: "node", args: [SERVER], env: { ...process.env, DESKTOP_HUB_CUA_BIN: FAKE, DESKTOP_HUB_TEST_LOCKED: "0", ...env } });
  const c = new Client({ name, version: "0" });
  await c.connect(t);
  const call = (tool, args) => c.callTool({ name: tool, arguments: args });
  const ctl = async (tool, args = {}) => {
    const r = await call("desk_call", { server: "cua", tool, args });
    if (r.isError) throw new Error(`${tool}: ${textOf(r)}`);
    return JSON.parse(textOf(r));
  };
  const log = () => ctl("fake_log");
  // A window of its own: content set, call log cleared.
  const win = async (window_id, rows, extra = {}) => {
    await ctl("fake_set_window", { pid: P, window_id, rows, ...extra });
    await log();
    return { pid: P, window_id };
  };
  return { c, call, ctl, log, win };
}
// A subsection that throws records one FAIL and the run goes on.
async function section(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(`${name}: runs without throwing`, false, String(e?.stack ?? e).split("\n").slice(0, 2).join(" | "));
  }
}
const J = (v) => JSON.stringify(v);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sidOf = (t) => /snapshot (s[0-9a-f]+)/.exec(t)?.[1];
// Row number printed for `role "label"` ([n] or (n)) in a hub reply.
const rowOf = (t, role, label) => {
  const m = new RegExp(`[\\[(](\\d+)[\\])] ${role} ${esc(J(label))}`).exec(t);
  return m ? Number(m[1]) : undefined;
};
const walks = (lg) => lg.calls.filter((x) => x.tool === "get_window_state");
// Replies name rows by full token ("s0000012a:7 AXButton …"); for comparisons that do not care which snapshot.
const bare = (x) => String(x).replace(/s[0-9a-f]{8}:(\d+) AX/g, "[$1] AX");
const P = 4242;
// A small form; o switches the parts later tests change (top = a button
// inserted above the form, shifting every later row number by one).
const FORM = (o = {}) => [
  [0, "AXWindow", o.title ?? "样例窗", { a: ["AXRaise"] }],
  ...(o.top ? [[1, "AXButton", o.top, { press: true }]] : []),
  [1, "AXGroup", "表单", { a: [] }],
  [2, "AXStaticText", "名称", { a: [] }],
  [2, "AXTextField", "名称", { v: o.name ?? "", press: true }],
  [2, "AXButton", o.save ?? "保存", { press: true }],
  [2, "AXButton", o.sync ?? "开启同步", { press: true }],
  [2, "AXButton", "确 定", { press: true }],
  [2, "AXButton", "导出", { press: true }],
  [2, "AXImage", "徽标", { a: [] }],
  [2, "AXStaticText", "提示文字", { ix: false }],
  ...(o.sheet ? [[1, "AXSheet", "确认框", { a: [] }], [2, "AXStaticText", "要继续吗", { a: [] }], [2, "AXButton", "继续", { press: true }]] : []),
  [0, "AXMenuBar", null, { a: ["AXCancel"] }],
  [1, "AXMenuBarItem", "文件", { a: ["AXPress"] }],
  [2, "AXMenu", null, { a: [] }],
  [3, "AXMenuItem", "导出…", { a: ["AXPress"] }],
];
// A table: one AXRow per entry (row text + a "删除" button).
const TABLE = (names) => [
  [0, "AXWindow", "任务表", { a: ["AXRaise"] }],
  [1, "AXTable", "任务", { a: [] }],
  ...names.flatMap((n) => [[2, "AXRow", null, { a: [] }], [3, "AXStaticText", n, { a: [] }], [3, "AXButton", "删除", { press: true }]]),
];

{
  const H = await fakeHub("smoke-fake");
  const { call, ctl, log, win } = H;
  try {
    // 7.5a rendering (behaviour 1) ------------------------------------------
    await section("7.5a rendering", async () => {
      const W = await win(701, FORM());
      const r = await call("window_state", { ...W, include_screenshot: false });
      const t = textOf(r);
      const sid = sidOf(t);
      const want = [
        `win 701 "样例窗" pid 4242 · snapshot ${sid} · 10 rows`,
        '- (0) AXWindow "样例窗"',
        ' - (1) AXGroup "表单"',
        '  - (2) AXStaticText "名称"',
        '  - [3] AXTextField "名称"',
        '  - [4] AXButton "保存"',
        '  - [5] AXButton "开启同步"',
        '  - [6] AXButton "确 定"',
        '  - [7] AXButton "导出"',
        '  - (8) AXImage "徽标"',
        '  - AXStaticText = "提示文字"',
        "(menu bar hidden: 4 rows — menus:true to list; act menu takes the path directly)",
      ].join("\n");
      check("window_state: text only, no structuredContent", !r.isError && r.structuredContent === undefined && r.content.length === 1 && r.content[0].type === "text", J(Object.keys(r)));
      check("window_state: compact text — header, [n] pressable, (n) not, bare static text, menu bar hidden", t === want, `\n${t}`);
      const m = textOf(await call("window_state", { ...W, include_screenshot: false, menus: true }));
      check(
        "window_state menus:true: menu rows listed, no hidden-menu line",
        m.includes(" · 14 rows\n") && m.includes('\n - [10] AXMenuBarItem "文件"') && m.includes('\n   - [12] AXMenuItem "导出…"') && !m.includes("menu bar hidden"),
        `\n${m}`
      );
    });
    // 7.5b what goes upstream (2, 10-) --------------------------------------
    await section("7.5b upstream args", async () => {
      const W = await win(702, FORM());
      const exact = (inc, extra = {}) => J({ pid: P, window_id: 702, include_screenshot: inc, ...extra });
      const q = textOf(await call("window_state", { ...W, query: "保存|开启" }));
      let lg = await log();
      check("query: upstream walk is the whole window — only pid/window_id/include_screenshot", lg.calls.length === 1 && J(lg.calls[0].args) === exact(true), J(lg.calls));
      check(
        'query "a|b": local filter, hits + ancestors',
        q.split("\n")[0].endsWith(' · 2 match(es) for "保存|开启" of 10 rows') && q.includes('\n  - [4] AXButton "保存"\n  - [5] AXButton "开启同步"') && q.includes(' - (1) AXGroup "表单"') && !q.includes("确 定"),
        `\n${q}`
      );
      const qa = textOf(await call("window_state", { ...W, query: ["保存", "开启"], include_screenshot: false }));
      check("query as array = any term", qa.split("\n")[0].endsWith(' · 2 match(es) for "保存|开启" of 10 rows'), qa.split("\n")[0]);
      const loose = textOf(await call("window_state", { ...W, query: "确定", include_screenshot: false }));
      check("query 0 strict hits → whitespace-insensitive pass", loose.split("\n")[0].endsWith(' · 1 match(es) for "确定" (ignoring whitespace) of 10 rows') && loose.includes('[6] AXButton "确 定"'), loose);
      const strict = textOf(await call("window_state", { ...W, query: "确 定", include_screenshot: false }));
      check("query with a strict hit stays strict", strict.split("\n")[0].endsWith(' · 1 match(es) for "确 定" of 10 rows'), strict.split("\n")[0]);
      const mx = textOf(await call("window_state", { ...W, max_elements: 3, include_screenshot: false }));
      check(
        "max_elements: display cap with a count",
        mx.split("\n")[0].endsWith(" · 3 of 10 rows") && mx.split("\n").length === 6 && mx.includes('\n…[7 more rows not shown — narrow with query:"a|b" (substring, any term)]'),
        `\n${mx}`
      );
      const md = textOf(await call("window_state", { ...W, max_depth: 1, include_screenshot: false }));
      check("max_depth: rows up to that depth only", md.split("\n")[0].endsWith(" · 2 of 10 rows") && md.includes('\n - (1) AXGroup "表单"') && !md.includes("保存") && md.includes("…[8 rows deeper than max_depth 1 not shown]"), `\n${md}`);
      lg = await log();
      check("max_*/query never reach upstream (no full_output either: 0.28 shape)", walks(lg).length === 5 && lg.calls.every((c) => J(c.args) === exact(false)), J(lg.calls.map((c) => c.args)));

      const full = await call("window_state", { ...W });
      const sidF = sidOf(textOf(full));
      check("window_state default: screenshot requested and returned", full.content.some((c) => c.type === "image"), J(full.content.map((c) => c.type)));
      const d1 = await call("window_state", { ...W, diff: true });
      const d2 = await call("window_state", { ...W, diff: true, include_screenshot: true });
      lg = await log();
      check(
        "include_screenshot: default true, false under diff:true unless asked",
        J(lg.calls.map((c) => c.args.include_screenshot)) === J([true, false, true]) && !d1.content.some((c) => c.type === "image") && d2.content.some((c) => c.type === "image"),
        J(lg.calls.map((c) => c.args))
      );
      const f2 = textOf(await call("window_state", { ...W, include_screenshot: false }));
      const sidF2 = sidOf(f2);
      await log();
      const shot = await call("window_state", { ...W, tree: false });
      check(
        "tree:false: screenshot only, says tokens stay valid",
        textOf(shot) === "win 702 pid 4242 · screenshot only 2000x1400 px (no AX walk, element_tokens stay valid)" && shot.content.some((c) => c.type === "image"),
        textOf(shot)
      );
      const a = await call("act", { action: "click", ...W, element_token: `${sidF2}:4`, observe: false });
      lg = await log();
      check("tree:false upstream: include_accessibility_tree:false + include_screenshot:true", J(lg.calls[0]?.args) === exact(true, { include_accessibility_tree: false }), J(lg.calls[0]));
      check(
        "tree:false minted no snapshot: the pre-shot token goes upstream as is and is accepted",
        !a.isError && lg.calls.length === 2 && lg.actions.length === 1 && lg.actions[0].args.element_token === `${sidF2}:4` && lg.actions[0].target.label === "保存" && sidF !== sidF2,
        `${textOf(a)} ${J(lg)}`
      );
    });
    // 7.5c diff baseline (3) -------------------------------------------------
    await section("7.5c diff", async () => {
      const W = await win(703, FORM());
      const set = (rows) => ctl("fake_set_window", { pid: P, window_id: 703, rows });
      const d0 = textOf(await call("window_state", { ...W, diff: true }));
      const s0 = sidOf(d0);
      check(
        "diff without a baseline: full tree, the reason in brackets on line 1",
        d0.split("\n")[0] === "[no earlier full view of this window to diff against — full tree; later diff:true calls return only changes]" && d0.split("\n")[1] === `win 703 "样例窗" pid 4242 · snapshot ${s0} · 10 rows`,
        d0
      );
      const d1 = textOf(await call("window_state", { ...W, diff: true }));
      const s1 = sidOf(d1);
      check("diff, nothing changed: one line naming both snapshots", d1 === `win 703 "样例窗" pid 4242 · snapshot ${s1} (was ${s0}) · no change vs your last view (10 rows)`, d1);
      await set(FORM({ name: "新值" }));
      const q = textOf(await call("window_state", { ...W, query: "名称", diff: true, include_screenshot: false }));
      check("diff + query: the query wins and says diff was ignored", q.includes('[3] AXTextField "名称" = "新值"') && q.endsWith("\n(diff ignored: a query was given — call diff:true without query for the change list)"), q);
      check("a query look lists a small change since the last full view…", q.includes('\nAlso changed since then:\n~ [3] AXTextField "名称" = "新值": value "" → "新值"\n'), q);
      const d2 = textOf(await call("window_state", { ...W, diff: true }));
      check("…so the model is up to date: the next diff:true has nothing to add", d2 === `win 703 "样例窗" pid 4242 · snapshot ${sidOf(d2)} (was ${sidOf(q)}) · no change vs your last view (10 rows)`, d2);
      await set(FORM({ name: "再改" }));
      await call("window_state", { ...W, max_elements: 2, include_screenshot: false });
      const d3 = textOf(await call("window_state", { ...W, diff: true }));
      check("capped output (max_elements) did not advance the baseline", d3.includes(`(was ${sidOf(d2)})`) && d3.includes('value "新值" → "再改"'), d3);
      await set(FORM({ name: "三改" }));
      await call("window_state", { ...W, include_screenshot: false });
      const d4 = textOf(await call("window_state", { ...W, diff: true }));
      check("a full uncut view advances the baseline", d4.endsWith("· no change vs your last view (10 rows)"), d4);
      const other = textOf(await call("window_state", { ...(await win(704, FORM())), diff: true }));
      check("baselines are per window", other.startsWith("[no earlier full view of this window"), other.slice(0, 120));
      await set([[0, "AXWindow", "样例窗", { a: ["AXRaise"] }], [1, "AXButton", "甲", { press: true }], [1, "AXButton", "乙", { press: true }]]);
      const d5 = textOf(await call("window_state", { ...W, diff: true }));
      check("diff, more than half changed: full tree with the reason", d5.split("\n")[0] === "[more than half of the window changed since your last view — full tree]" && d5.includes('\n - [2] AXButton "乙"'), d5);
      const d6 = textOf(await call("window_state", { ...W, diff: true }));
      check("…and that full tree became the baseline", d6.endsWith("· no change vs your last view (3 rows)"), d6);
    });
    // 7.5d degraded, not locked (9) -----------------------------------------
    await section("7.5d degraded", async () => {
      const W = await win(705, FORM());
      const s0 = sidOf(textOf(await call("window_state", { ...W, include_screenshot: false })));
      await ctl("fake_degrade", { count: 1 });
      const r = textOf(await call("window_state", { ...W, include_screenshot: false }));
      check(
        "degraded tree: one explanatory line, not the lock message",
        r.startsWith("win 705 pid 4242 · accessibility tree unavailable (ax_window_unresolved:fake). Usual causes: the window closed") && !r.includes("LOCKED"),
        r
      );
      const d = textOf(await call("window_state", { ...W, diff: true }));
      check("a degraded walk is not remembered: the next diff is still vs the last real view", d.includes(`(was ${s0}) · no change vs your last view`), d);
      await log();
      await ctl("fake_degrade", { count: 1 });
      const f = await call("act", { action: "click", ...W, find: { label: "保存" } });
      const lg = await log();
      check("find on a degraded walk fails, nothing executed", f.isError && textOf(f).startsWith("click: FAILED (not executed) — find: win 705 pid 4242 · accessibility tree unavailable") && lg.actions.length === 0, textOf(f));
      // The window is on a Space the user is not on (they are in a full-screen app): say exactly that.
      const here = { window_id: 100, pid: P, app_name: "别的应用", title: "当前空间", bounds: { x: 0, y: 0, width: 800, height: 600 }, is_on_screen: true, on_current_space: true, layer: 0, z_index: 9 };
      const away = { window_id: 705, pid: P, app_name: "样例应用", title: "样例窗", bounds: { x: 0, y: 0, width: 800, height: 600 }, is_on_screen: false, on_current_space: false, layer: 0, z_index: 5 };
      await ctl("fake_windows", { windows: [here, away] });
      await ctl("fake_degrade", { count: 1 });
      const off = textOf(await call("window_state", { ...W, include_screenshot: false }));
      check("degraded + the window is on another Space: one precise line that says so and says not to retry", off.startsWith('[desktop-hub] win 705 (样例应用 "样例窗") is on ANOTHER SPACE') && off.includes("do not retry and do not go foreground"), off);
      const lw = textOf(await call("list_windows", {}));
      check("list_windows marks other-Space windows and explains the mark once", /\n705 pid 4242 样例应用 "样例窗" 800x600 @0,0 other-Space\n/.test(lw) && lw.includes("(other-Space = on a desktop/full-screen Space the user is not on"), lw);
      await ctl("fake_next_reply", { error: "Background input refused (off_space_or_ax_unresolved): window 705 is not among the process's current AXWindows" });
      await log();
      const ref = await call("act", { action: "click", ...W, x: 30, y: 40, observe: false });
      check("an upstream off-Space refusal of an action is replaced by the same explanation, marked not executed", ref.isError && textOf(ref).startsWith('click: FAILED (not executed) — [desktop-hub] win 705 (样例应用 "样例窗") is on ANOTHER SPACE'), textOf(ref));
      await ctl("fake_windows", { windows: [] });
    });
    // 7.5e list_windows (12) -------------------------------------------------
    await section("7.5e list_windows", async () => {
      const w = (window_id, pid, title, width, height, on, z) => ({ window_id, pid, app_name: pid === P ? "示例应用" : "另一应用", title, bounds: { x: 0, y: 0, width, height }, is_on_screen: on, layer: 0, z_index: z });
      const all = [w(801, P, "后台窗", 800, 600, false, 30), w(802, P, "", 900, 500, true, 25), w(803, P, "小浮窗", 80, 80, true, 22), w(777, P, "样例窗", 1000, 700, true, 10), w(900, 5151, "别的窗", 640, 480, true, 20)];
      await ctl("fake_windows", { windows: all });
      await log();
      const r = await call("list_windows", {});
      const want = [
        '3 window(s), front-most first — window_id pid app "title" WxH @x,y (top-left, screen points)',
        '900 pid 5151 另一应用 "别的窗" 640x480 @0,0',
        '777 pid 4242 示例应用 "样例窗" 1000x700 @0,0',
        '801 pid 4242 示例应用 "后台窗" 800x600 @0,0 off-screen',
        "(2 untitled/tiny helper windows hidden — pid:<pid> lists every window of one app, all:true lists everything)",
      ].join("\n");
      check("list_windows: titled windows > 100px, on-screen first by z, hidden count; text only", !r.isError && r.structuredContent === undefined && textOf(r) === want, `\n${textOf(r)}`);
      const byPid = textOf(await call("list_windows", { pid: P }));
      check(
        "list_windows pid: every window of the process, untitled and tiny included",
        byPid ===
          [
            '4 window(s) of pid 4242, front-most first — window_id pid app "title" WxH @x,y (top-left, screen points)',
            '802 pid 4242 示例应用 "" 900x500 @0,0',
            '803 pid 4242 示例应用 "小浮窗" 80x80 @0,0',
            '777 pid 4242 示例应用 "样例窗" 1000x700 @0,0',
            '801 pid 4242 示例应用 "后台窗" 800x600 @0,0 off-screen',
          ].join("\n"),
        `\n${byPid}`
      );
      const everything = textOf(await call("list_windows", { all: true }));
      check("list_windows all:true: all 5, nothing hidden", everything.startsWith("5 window(s), front-most first") && everything.split("\n").length === 6 && !everything.includes("hidden"), `\n${everything}`);
      const lg = await log();
      check("list_windows upstream args: {}, {pid}, {} (all is local)", J(lg.calls.map((c) => c.args)) === J([{}, { pid: P }, {}]), J(lg.calls));
      await ctl("fake_windows", { windows: [all[3]] });
    });
    // 7.5f desk_call + verify (13, 14) --------------------------------------
    await section("7.5f desk_call/verify", async () => {
      const W = await win(706, FORM());
      const pass = await call("desk_call", { server: "cua", tool: "get_window_state", args: { ...W } });
      check("desk_call passes through verbatim: structuredContent kept, no hub text", !pass.isError && pass.structuredContent?.elements?.length === 13 && !textOf(pass).includes("[desktop-hub]"), J(pass).slice(0, 160));
      const miss = await call("desk_call", { server: "cua", tool: "get_window_state", args: { pid: P } });
      check(
        "desk_call, upstream reports a schema error: hub appends what the tool takes",
        miss.isError &&
          textOf(miss) === "Missing required argument: window_id\n[desktop-hub] get_window_state takes — required: pid, window_id; parameters: pid:integer, window_id:integer, include_screenshot:boolean, include_accessibility_tree:boolean, full_output:boolean, session:string",
        textOf(miss)
      );
      const z = await call("desk_call", { server: "cua", tool: "zoom", args: { window_id: 706 } });
      check(
        "desk_call, upstream JSON-RPC -32602: error plus the same hint",
        z.isError && textOf(z) === 'desktop-hub error: MCP error -32602: Invalid arguments for tool zoom: "x1" is required\n[desktop-hub] zoom takes — required: window_id, x1, y1, x2, y2; parameters: pid:integer, window_id:integer, x1:number, y1:number, x2:number, y2:number',
        textOf(z)
      );
      const zok = await call("desk_call", { server: "cua", tool: "zoom", args: { window_id: 706, x1: 0, y1: 0, x2: 10, y2: 10 } });
      const other = await call("desk_call", { server: "cua", tool: "no_such_tool", args: {} });
      check("desk_call without a schema error: no hint", !zok.isError && zok.content.length === 1 && zok.content[0].type === "image" && other.isError && textOf(other) === "unknown tool no_such_tool", textOf(other));
      await log();
      const expect = [{ element: { selector: { role: "AXButton", label_contains: null }, exists: true, value_equals: null } }];
      const v = await call("verify", { ...W, expect, timeout_ms: 99999, session: null, include_screenshot: null });
      const lg = await log();
      const sent = { pid: P, window_id: 706, expect: [{ element: { selector: { role: "AXButton" }, exists: true } }], timeout_ms: 10000 };
      check("verify: null fields dropped (nested too), timeout_ms clamped", J(lg.calls[0]?.args) === J(sent), J(lg.calls[0]?.args));
      check("verify, trusted result: passed through, no note", !v.isError && J(v.structuredContent?.received) === J(sent) && !textOf(v).includes("[desktop-hub]"), textOf(v));
      await ctl("fake_verify", { untrusted: true });
      const vu = await call("verify", { ...W, expect: [{ window: { exists: true } }] });
      await ctl("fake_verify", { untrusted: false });
      check(
        "verify, untrusted_source: a visible hub note, structuredContent folded into text",
        vu.structuredContent === undefined && textOf(vu).includes('"reason":"untrusted_source"') && textOf(vu).endsWith("\n[desktop-hub] unknown(untrusted_source): this is web content, where cua never trusts AX values. It is not a failure signal — read the text with window_state query instead."),
        textOf(vu)
      );
    });
    // 7.6a tokens (4, 11) ----------------------------------------------------
    await section("7.6a tokens", async () => {
      const W = await win(711, FORM());
      const clicks = (lg) => lg.calls.filter((c) => c.tool === "click");
      const t0 = textOf(await call("window_state", { ...W, include_screenshot: false }));
      const A = sidOf(t0);
      const [save, sync, exp] = ["保存", "开启同步", "导出"].map((l) => rowOf(t0, "AXButton", l));
      // Every row shifts down by one after this press (a button appears on top).
      await ctl("fake_after_action", { pid: P, window_id: 711, rows: FORM({ top: "新增" }) });
      const r1 = await call("act", { action: "click", ...W, element_token: `${A}:${save}` });
      let lg = await log();
      const B = walks(lg).at(-1)?.sid;
      check(
        "token, direct: sent upstream unchanged, the step line names the row",
        !r1.isError && lg.actions.length === 1 && lg.actions[0].args.element_token === `${A}:${save}` && lg.actions[0].target.label === "保存" && textOf(r1).startsWith(`click: ok (${A}:${save} AXButton "保存")\n`),
        textOf(r1)
      );
      const r2 = await call("act", { action: "click", ...W, element_token: `${A}:${exp}` });
      lg = await log();
      check(
        "old token after the window was re-walked: re-identified, upstream gets the NEW snapshot's token",
        !r2.isError && lg.actions.length === 1 && lg.actions[0].args.element_token === `${B}:${exp + 1}` && lg.actions[0].target.label === "导出" && textOf(r2).startsWith(`click: ok (token ${A}:${exp} → ${B}:${exp + 1} AXButton "导出" (after "`),
        `${textOf(r2).split("\n")[0]} ${J(lg.actions)}`
      );
      await ctl("fake_after_action", { pid: P, window_id: 711, rows: FORM({ top: "新增", sync: "关闭同步" }) });
      const r3 = await call("act", { action: "click", ...W, element_token: `${A}:${sync}` });
      const r4 = await call("act", { action: "click", ...W, element_token: `${A}:${sync}` });
      lg = await log();
      check("toggle: the first press executes (flipping the label)", !r3.isError && lg.actions.length === 1 && lg.actions[0].target.label === "开启同步", textOf(r3).split("\n")[0]);
      check(
        "toggle flipped: the same old token is refused, nothing sent upstream",
        r4.isError && textOf(r4).startsWith(`click: FAILED (not executed) — AXButton "开启同步" from snapshot ${A} is now AXButton "关闭同步" — its label changed (a toggle that already flipped?). Nothing was executed. Current candidates (usable as element_token): `) && /: s[0-9a-f]+:\d+ AXButton "关闭同步" \((after|before) /.test(textOf(r4)) && clicks(lg).length === 1,
        textOf(r4)
      );
      const tq = textOf(await call("window_state", { ...W, query: "保存", include_screenshot: false }));
      const Q = sidOf(tq);
      const qs = rowOf(tq, "AXButton", "保存");
      await log();
      const bad = [
        [{ element_token: `${Q}:${qs + 1}` }, `act invalid (nothing executed): row ${qs + 1} was never shown to you under snapshot ${Q}. A token is "<snapshot>:<row>" exactly as one reply printed them together`],
        [{ element_token: "s0000dead:3" }, "act invalid (nothing executed): snapshot s0000dead is not one this hub showed you"],
        [{ element_token: `${Q}:${qs}`, pid: 9999 }, `act invalid (nothing executed): element_token ${Q}:${qs} belongs to pid 4242 window 711, not to pid 9999 window 711. Nothing was executed.`],
      ];
      for (const [args, want] of bad) {
        const r = await call("act", { action: "click", ...W, ...args });
        check(`token refused locally: ${want.slice(29, 70)}…`, r.isError && textOf(r).startsWith(want), textOf(r));
      }
      lg = await log();
      check("…and those refusals sent nothing at all upstream", lg.calls.length === 0, J(lg.calls));
      const wrongWin = await call("act", { action: "click", ...W, window_id: 799, element_token: `${Q}:${qs}`, observe: false });
      const okQ = await call("act", { action: "click", ...W, element_token: `${Q}:${qs}`, observe: false });
      lg = await log();
      check("token of another window: refused, not executed", wrongWin.isError && textOf(wrongWin).includes(`belongs to pid 4242 window 711, not to pid 4242 window 799. Nothing was executed.`), textOf(wrongWin));
      check("a shown row of a query view is a valid token", !okQ.isError && lg.actions.length === 1 && lg.actions[0].args.element_token === `${Q}:${qs}`, J(lg.actions));

      // Someone else walks the window (desk_call here): upstream retires our
      // snapshot; the hub must re-walk, re-identify and resend — once.
      const tv = textOf(await call("window_state", { ...W, include_screenshot: false }));
      const V = sidOf(tv);
      const ex = rowOf(tv, "AXButton", "导出");
      await call("desk_call", { server: "cua", tool: "get_window_state", args: { ...W } });
      await log();
      const r6 = await call("act", { action: "click", ...W, element_token: `${V}:${ex}`, observe: false });
      lg = await log();
      check(
        "outside walk: stale refusal → re-walk → resend with the fresh token",
        !r6.isError && clicks(lg).length === 2 && clicks(lg)[0].stale === true && clicks(lg)[0].args.element_token === `${V}:${ex}` && lg.actions.length === 1 && lg.actions[0].args.element_token === `${walks(lg)[0]?.sid}:${ex}` && lg.actions[0].target.label === "导出" && textOf(r6).includes(`re-identified after an outside walk → ${walks(lg)[0]?.sid}:${ex} AXButton "导出"`),
        `${textOf(r6)} ${J(lg.calls)}`
      );
      const tw = textOf(await call("window_state", { ...W, include_screenshot: false }));
      const V2 = sidOf(tw);
      const sv = rowOf(tw, "AXButton", "保存");
      await ctl("fake_set_window", { pid: P, window_id: 711, rows: FORM({ top: "新增", sync: "关闭同步", save: "另存" }) });
      await call("desk_call", { server: "cua", tool: "get_window_state", args: { ...W } });
      await log();
      const r7 = await call("act", { action: "click", ...W, element_token: `${V2}:${sv}`, observe: false });
      lg = await log();
      check(
        "outside walk and the element changed: refused after the re-walk, nothing executed",
        r7.isError && textOf(r7) === "click: FAILED (not executed) — upstream refused a stale token (something else walked this window) and the window has changed since the hub looked at it — look again before repeating the step" && lg.actions.length === 0 && clicks(lg).length === 1,
        textOf(r7)
      );
    });
    // 7.6a2 tokens: table rows, refusal guards, backend restart (4, 11) -----
    await section("7.6a2 tokens: rows, guards, restart", async () => {
      const clicks = (lg) => lg.calls.filter((c) => c.tool === "click");
      const T = await win(712, TABLE(["甲任务", "乙任务", "丙任务"]));
      const tt = textOf(await call("window_state", { ...T, include_screenshot: false }));
      const TA = sidOf(tt);
      const dels = [...tt.matchAll(/\[(\d+)\] AXButton "删除"/g)].map((m) => Number(m[1]));
      await ctl("fake_after_action", { pid: P, window_id: 712, rows: TABLE(["甲任务", "丙任务"]) });
      const k1 = await call("act", { action: "click", ...T, element_token: `${TA}:${dels[1]}` });
      let lg = await log();
      const TB = walks(lg).at(-1)?.sid;
      check("table: the press on row 乙's 删除 lands on row 乙", !k1.isError && dels.length === 3 && lg.actions.length === 1 && J(lg.actions[0].target.siblings) === J(["乙任务"]), J(lg.actions));
      const gone = await call("act", { action: "click", ...T, element_token: `${TA}:${dels[1]}` });
      const third = await call("act", { action: "click", ...T, element_token: `${TA}:${dels[2]}`, observe: false });
      lg = await log();
      check(
        "table: the deleted row's token is refused, with usable candidates",
        gone.isError &&
          textOf(gone) ===
            `click: FAILED (not executed) — AXButton "删除" from snapshot ${TA} is no longer in the window where you saw it. Nothing was executed. Current candidates (usable as element_token): ${TB}:7 AXButton "删除" near "丙任务"; ${TB}:4 AXButton "删除" near "甲任务".`,
        textOf(gone)
      );
      check(
        "table: row 丙's old token is refused too — a repeated control is not followed across a change — and says how to address it",
        third.isError && clicks(lg).length === 0 && textOf(third).includes('AXButton "删除" is one of 2 controls of that name (3 when you saw it) and the window has changed since') && textOf(third).includes('find {label:"删除", near:"<a text from its row or card>"}'),
        `${textOf(third)} ${J(lg.actions)}`
      );
      const cand = await call("act", { action: "click", ...T, element_token: `${TB}:4`, observe: false });
      lg = await log();
      check("table: a printed candidate works as a token", !cand.isError && lg.actions[0]?.args.element_token === `${TB}:4` && J(lg.actions[0]?.target.siblings) === J(["甲任务"]), J(lg.actions));
      const byNear = await call("act", { action: "click", ...T, find: { label: "删除", near: "丙任务" }, observe: false });
      lg = await log();
      check('table: find {label:"删除", near:"丙任务"} presses row 丙\'s button and says where it landed', !byNear.isError && lg.actions.length === 1 && J(lg.actions[0].target.siblings) === J(["丙任务"]) && /^click: ok \(find → s[0-9a-f]+:7 AXButton "删除" near "丙任务"\)$/.test(textOf(byNear)), textOf(byNear));
      const noNear = await call("act", { action: "click", ...T, find: { label: "删除", near: "乙任务" }, observe: false });
      const partWord = await call("act", { action: "click", ...T, find: { label: "删除", near: "任务" }, observe: false });
      const T2 = await win(718, TABLE(["甲 任务", "丙 任务"]));
      const amb = await call("act", { action: "click", ...T2, find: { label: "删除", near: "任务" }, observe: false });
      const nthNear = await call("act", { action: "click", ...T2, find: { label: "删除", near: "任务", nth: 1 }, observe: false });
      lg = await log();
      check("find.near: part of a word (任务 inside 甲任务) is not a match — refused, nothing sent", partWord.isError && textOf(partWord).includes('"任务" cannot be shown to be next to any of them'), textOf(partWord));
      check("find.near: no row has that text → refused, the rows that exist are listed", noNear.isError && textOf(noNear).includes('2 control(s) match {"label":"删除"}, but "乙任务" cannot be shown to be next to any of them') && textOf(noNear).includes("Nothing was executed. They are: ") && textOf(noNear).includes('near "甲任务"') && textOf(noNear).includes('near "丙任务"'), textOf(noNear));
      check("find.near: two rows have that text → refused with both candidates; nth (from 0) then picks among those", amb.isError && textOf(amb).includes('find: 2 controls match {"label":"删除","near":"任务"} — say which by near:') && !nthNear.isError && lg.actions.length === 1 && J(lg.actions[0].target.siblings) === J(["丙 任务"]), `${textOf(amb)} | ${textOf(nthNear)}`);
      const U = await win(715, TABLE(["甲任务", "乙任务"]));
      const tu = textOf(await call("window_state", { ...U, include_screenshot: false }));
      const UA = sidOf(tu);
      const udel = [...tu.matchAll(/\[(\d+)\] AXButton "删除"/g)].map((m) => Number(m[1]));
      await ctl("fake_set_window", { pid: P, window_id: 715, rows: TABLE(["甲任务", "乙任务（已归档）"]) });
      const uq = textOf(await call("window_state", { ...U, query: "删除", include_screenshot: false }));
      check("row text changed: the next query look says so", uq.includes('\nAlso changed since then:\n~ (6) AXStaticText "乙任务（已归档）" (was "乙任务")'), uq);
      await log();
      const ru = await call("act", { action: "click", ...U, element_token: `${UA}:${udel[1]}`, observe: false });
      const ru0 = await call("act", { action: "click", ...U, element_token: `${UA}:${udel[0]}`, observe: false });
      lg = await log();
      check("row text changed: both old 删除 tokens are refused with candidates, nothing sent", ru.isError && ru0.isError && clicks(lg).length === 0 && textOf(ru).includes("is one of 2 controls of that name (2 when you saw it)") && textOf(ru).includes("Current candidates (usable as element_token): ") && textOf(ru).includes('near "乙任务（已归档）"'), textOf(ru));
      const ru1 = await call("act", { action: "click", ...U, find: { label: "删除", near: "甲任务" }, observe: false });
      lg = await log();
      check("…and the untouched row is reached by content", !ru1.isError && clicks(lg).length === 1 && J(lg.actions[0]?.target.siblings) === J(["甲任务"]), J(lg.calls));

      const X = await win(713, FORM());
      const churn = [[0, "AXWindow", "样例窗", { a: ["AXRaise"] }], [1, "AXGroup", "表单", { a: [] }], [2, "AXButton", "保存", { press: true }], ...Array.from({ length: 12 }, (_, i) => [2, "AXStaticText", `新内容${i}`, { a: [] }])];
      const guards = [
        [FORM({ sheet: true }), (A) => `a dialog/sheet opened in this window after snapshot ${A}: AXSheet (确认框 / 要继续吗 / 继续). Older tokens are void. Nothing was executed — look at it first (window_state with a query of its words, or whole), then use the tokens that view prints.`],
        [churn, (A) => `the window changed after the view your token comes from (snapshot ${A}), by more than fits here. Nothing was executed. Look again: a window_state query naming what you need prints fresh tokens (diff:true lists the changes but no tokens); or say which control by content with find + near.`],
      ];
      // A changed title alone is an ordinary, listed change (a dirty marker, an unread count, a timer in the title).
      {
        await ctl("fake_set_window", { pid: P, window_id: 713, rows: FORM() });
        const t = textOf(await call("window_state", { ...X, include_screenshot: false }));
        await ctl("fake_set_window", { pid: P, window_id: 713, rows: FORM({ title: "样例窗 — 已编辑" }) });
        const q2 = textOf(await call("window_state", { ...X, query: "保存", include_screenshot: false }));
        await log();
        const r = await call("act", { action: "click", ...X, element_token: `${sidOf(t)}:${rowOf(t, "AXButton", "保存")}`, observe: false });
        lg = await log();
        check("title changed and the change was listed: the unique control's old token is carried", q2.includes('(was "样例窗")') && !r.isError && clicks(lg).length === 1 && lg.actions[0].target.label === "保存", `${q2}\n${textOf(r)}`);
      }
      for (const [rows, msg] of guards) {
        await ctl("fake_set_window", { pid: P, window_id: 713, rows: FORM() });
        const t = textOf(await call("window_state", { ...X, include_screenshot: false }));
        await ctl("fake_set_window", { pid: P, window_id: 713, rows });
        await call("window_state", { ...X, query: "保存", include_screenshot: false });
        await log();
        const r = await call("act", { action: "click", ...X, element_token: `${sidOf(t)}:${rowOf(t, "AXButton", "保存")}`, observe: false });
        lg = await log();
        check(`token guard, nothing sent: ${msg("A").slice(0, 34)}…`, r.isError && textOf(r) === `click: FAILED (not executed) — ${msg(sidOf(t))}` && lg.calls.length === 0, textOf(r));
      }
      // The same window changes, but seen only by an OUTSIDE walk: the hub
      // learns of them on upstream's stale refusal and re-identifies. That path
      // must refuse for the same reasons (spec: a changed title / a new dialog
      // = cannot re-identify), or the click lands behind the dialog.
      for (const [rows, msg] of guards.slice(0, 2)) {
        await ctl("fake_set_window", { pid: P, window_id: 713, rows: FORM() });
        const t = textOf(await call("window_state", { ...X, include_screenshot: false }));
        await ctl("fake_set_window", { pid: P, window_id: 713, rows });
        await call("desk_call", { server: "cua", tool: "get_window_state", args: { ...X } });
        await log();
        const r = await call("act", { action: "click", ...X, element_token: `${sidOf(t)}:${rowOf(t, "AXButton", "保存")}`, observe: false });
        lg = await log();
        check(`token guard after an OUTSIDE walk, nothing executed: ${msg("A").slice(0, 34)}…`, r.isError && lg.actions.length === 0, `${textOf(r)} | executed ${lg.actions.length}`);
      }

      // Restart detection (11). Ids come from one daemon-wide counter that never goes back.
      const num = (sid) => parseInt(sid.slice(1), 16);
      const C = await win(716, FORM());
      const R = await win(717, FORM());
      let tc = textOf(await call("window_state", { ...C, include_screenshot: false }));
      let SC = sidOf(tc);
      let tokC = `${SC}:${rowOf(tc, "AXButton", "保存")}`;
      // Two walks in flight: the slow one was numbered first and comes back last. Not a restart.
      await ctl("fake_slow", { ms: 500 });
      const slowWalk = call("window_state", { ...C, query: "保存", include_screenshot: false });
      await new Promise((r) => setTimeout(r, 120));
      await ctl("fake_slow", { ms: 0 });
      const fastTxt = textOf(await call("window_state", { ...R, include_screenshot: false }));
      const slowTxt = textOf(await slowWalk);
      await log();
      const keep = await call("act", { action: "click", ...C, element_token: tokC, observe: false });
      lg = await log();
      check("replies arriving out of order (a lower id after a higher one, from a walk that started earlier) are not a restart: older tokens still work", num(sidOf(slowTxt)) < num(sidOf(fastTxt)) && !keep.isError && clicks(lg).length === 1 && lg.actions[0].target.label === "保存", `${sidOf(slowTxt)} ${sidOf(fastTxt)} ${textOf(keep)}`);
      // A walk that STARTED after a higher id arrived and comes back with a lower one: the counter went back = a new daemon.
      await ctl("fake_counter", { next: num(SC) + 1 });
      const afterBack = textOf(await call("window_state", { ...R, include_screenshot: false }));
      await log();
      const wentBack = await call("act", { action: "click", ...C, element_token: tokC, observe: false });
      lg = await log();
      check("an id below one already received, from a later walk = restart (even by a few): older snapshots forgotten, nothing sent", wentBack.isError && textOf(wentBack).startsWith(`act invalid (nothing executed): snapshot ${SC} is not one this hub showed you`) && lg.calls.length === 0, `${sidOf(afterBack)} ${textOf(wentBack)}`);
      tc = textOf(await call("window_state", { ...C, include_screenshot: false }));
      SC = sidOf(tc);
      tokC = `${SC}:${rowOf(tc, "AXButton", "保存")}`;
      const SA = sidOf(textOf(await call("window_state", { ...R, include_screenshot: false })));
      await ctl("fake_counter", { next: num(SA) }); // an id the hub already showed comes again
      await call("window_state", { ...R, include_screenshot: false });
      await log();
      const forgot = await call("act", { action: "click", ...C, element_token: tokC, observe: false });
      lg = await log();
      check("an already-shown id coming again = restart: other snapshots forgotten, nothing sent", forgot.isError && textOf(forgot).startsWith(`act invalid (nothing executed): snapshot ${SC} is not one this hub showed you`) && lg.calls.length === 0, textOf(forgot));
      const tr = textOf(await call("window_state", { ...R, include_screenshot: false }));
      const tokR = `${sidOf(tr)}:${rowOf(tr, "AXButton", "保存")}`;
      await ctl("fake_restart");
      const RB = sidOf(textOf(await call("window_state", { ...R, include_screenshot: false })));
      await log();
      const old = await call("act", { action: "click", ...R, element_token: tokR, observe: false });
      const fresh = await call("act", { action: "click", ...R, element_token: `${RB}:${rowOf(tr, "AXButton", "保存")}`, observe: false });
      lg = await log();
      check("counter reset (daemon restart): the old snapshot is unknown, nothing sent for it", RB === "s00000001" && old.isError && textOf(old).startsWith(`act invalid (nothing executed): snapshot ${tokR.split(":")[0]} is not one this hub showed you`), textOf(old));
      check("…and the new snapshot's tokens work", !fresh.isError && lg.actions.length === 1 && lg.actions[0].args.element_token === `${RB}:${rowOf(tr, "AXButton", "保存")}`, J(lg.calls));
    });
    // 7.6b one engine, observe, re-press gate (5) ---------------------------
    await section("7.6b act engine", async () => {
      const tools = (lg) => J(lg.calls.map((c) => c.tool));
      const W = await win(721, FORM());
      const A = sidOf(textOf(await call("window_state", { ...W, include_screenshot: false })));
      await log();
      await ctl("fake_after_action", { pid: P, window_id: 721, rows: FORM({ name: "已填" }) });
      const f = await call("act", { action: "click", ...W, find: { role: "AXButton", label: "保存" } });
      let lg = await log();
      const [fw, ow] = walks(lg);
      check("single act with find: fresh walk, its token upstream; default observe = list, walk, list", !f.isError && f.structuredContent === undefined && lg.actions[0]?.args.element_token === `${fw?.sid}:4` && tools(lg) === J(["list_windows", "get_window_state", "click", "get_window_state", "list_windows"]), tools(lg));
      check(
        "receipt vs the model's last full view: exact change list, no repeat warning",
        textOf(f) === `click: ok (find → ${fw?.sid}:4 AXButton "保存")\nwin 721 "样例窗" pid 4242 · snapshot ${ow?.sid} (was ${A}) · +0 −0 ~1 of 10 rows vs your last view\n~ [3] AXTextField "名称" = "已填": value "" → "已填"`,
        textOf(f)
      );
      const d = textOf(await call("window_state", { ...W, diff: true }));
      check("…an uncut receipt vs your last view advances the diff baseline", d.endsWith("· no change vs your last view (10 rows)"), d);
      const v = sidOf(textOf(await call("window_state", { ...W, include_screenshot: false })));
      await log();
      const b1 = await call("act_batch", { ...W, steps: [{ action: "click", element_token: `${v}:5` }], observe: false });
      const s1 = await call("act", { action: "click", ...W, element_token: `${v}:6`, observe: false });
      lg = await log();
      check("act_batch and act share the engine: batch head + step line vs bare step line; text only", b1.structuredContent === undefined && s1.structuredContent === undefined && bare(textOf(b1)) === '[act_batch] all 1 steps done — 1 ok, 0 skipped.\nstep 1 click: ok ([5] AXButton "开启同步")' && textOf(s1) === `click: ok (${v}:6 AXButton "确 定")`, `${textOf(b1)} | ${textOf(s1)}`);
      check("observe:false: no walk, no window list — only the action", tools(lg) === J(["click", "click"]), tools(lg));

      const W2 = await win(722, FORM());
      await ctl("fake_after_action", { pid: P, window_id: 722, rows: FORM({ name: "首见" }) });
      const j = textOf(await call("act", { action: "click", ...W2, find: { label: "保存" } }));
      check("no earlier look: the find walk is the baseline (vs just before this action)", /· \+0 −0 ~1 of 10 rows vs just before this action\n~ \[3\] AXTextField "名称" = "首见"/.test(j), j);
      const j2 = textOf(await call("window_state", { ...W2, diff: true }));
      check("…which is not the model's full view: the diff baseline was not set", j2.startsWith("[no earlier full view of this window"), j2.slice(0, 80));

      const W3 = await win(723, FORM());
      await call("window_state", { ...W3, include_screenshot: false });
      await ctl("fake_set_window", { pid: P, window_id: 723, rows: FORM({ name: "外部改动" }) });
      await call("window_state", { ...W3, max_elements: 2, include_screenshot: false }); // a capped look: walks, tells nothing
      await ctl("fake_after_action", { pid: P, window_id: 723, rows: FORM({ name: "外部改动", sync: "关闭同步" }) });
      await new Promise((r) => setTimeout(r, 20)); // the look must be ≥1 ms older than the act (see the race check below)
      const g = textOf(await call("act", { action: "click", ...W3, find: { label: "保存" } }));
      check(
        "receipt vs a later partial look: 'the previous look Ns ago' + the earlier-changes line",
        /· \+0 −0 ~1 of 10 rows vs the previous look \d+s ago\n/.test(g) && g.includes('\n~ [5] AXButton "关闭同步" (was "开启同步")') && g.endsWith("\n(1 earlier change(s) since your last full view are not listed — window_state diff:true shows everything)"),
        g
      );
      const g2 = textOf(await call("window_state", { ...W3, diff: true }));
      check("…that receipt did not advance the baseline: diff:true still lists both changes", g2.includes('value "" → "外部改动"') && g2.includes('~ [5] AXButton "关闭同步" (was "开启同步")'), g2);
      // The label is decided by `look.at >= t0` on Date.now() milliseconds: a
      // look from the PREVIOUS call that finished in the same millisecond the
      // act started counts as "just before this action" (about half the time
      // when act follows window_state back to back).
      const W6 = await win(726, FORM());
      let mislabeled = 0;
      for (let i = 0; i < 10; i++) {
        const lq = textOf(await call("window_state", { ...W6, query: "保存", include_screenshot: false }));
        const lr = textOf(await call("act", { action: "click", ...W6, element_token: `${sidOf(lq)}:${rowOf(lq, "AXButton", "保存")}`, again: true }));
        if (lr.includes("vs just before this action")) mislabeled++;
      }
      check("a look from the previous call is never labelled 'just before this action' (query → act back to back ×10)", mislabeled === 0, `${mislabeled}/10 mislabelled`);

      const MANY = (v) => [[0, "AXWindow", "长表", { a: ["AXRaise"] }], [1, "AXButton", "全部改写", { press: true }], ...Array.from({ length: 30 }, (_, i) => [1, "AXTextField", `字段${String(i).padStart(2, "0")}`, { v }])];
      const W4 = await win(724, MANY("旧"));
      const tm = textOf(await call("window_state", { ...W4, include_screenshot: false }));
      const all = `${sidOf(tm)}:1`;
      await ctl("fake_after_action", { pid: P, window_id: 724, rows: MANY("一段较长的新取值文字，用来撑开回执") });
      const cap = textOf(await call("act", { action: "click", ...W4, element_token: all }));
      await ctl("fake_after_action", { pid: P, window_id: 724, rows: MANY("另一段较长的取值文字，同样撑开回执") });
      const held = await call("act", { action: "click", ...W4, element_token: all });
      // A find that only names a control, right after a report that left changes out: held once, with where it sits.
      await log();
      const heldFind = await call("act", { action: "click", ...W4, find: { label: "全部改写" }, observe: true });
      const heldLog = await log();
      check(
        "after a cut receipt a find without near is held once, says where the control sits, and sends no action",
        heldFind.isError && /find located s[0-9a-f]+:1 AXButton "全部改写"/.test(textOf(heldFind)) && textOf(heldFind).includes("changed by more than you were shown") && textOf(heldFind).includes("send the step again as it is") && heldLog.actions.length === 0,
        textOf(heldFind)
      );
      const unc = textOf(await call("act", { action: "click", ...W4, find: { label: "全部改写" }, observe: true }));
      await ctl("fake_after_action", { pid: P, window_id: 724, rows: MANY("第三段较长的取值文字，按键之后出现") });
      const nav = textOf(await call("act", { action: "key", key: "down", ...W4 }));
      const more = /…\[\+\d+ more change lines — window_state diff:true lists them all\]/;
      check("default receipt: change lines cut at ~1,500 chars with a count", more.test(cap) && cap.length < 2400 && (cap.match(/\n~ \(/g) ?? []).length >= 10, `len=${cap.length}`);
      check("a cut receipt says older tokens are on hold…", cap.endsWith("\n(not every change is listed above, so element_tokens from earlier views are on hold — look again before reusing one, or say which control by content: find + near)"), cap.slice(-160));
      check("…and the next old token is refused (the changes do not fit a refusal either)", held.isError && textOf(held).includes("by more than fits here. Nothing was executed. Look again"), textOf(held));
      check("observe:true: the full change list", !more.test(unc) && (unc.match(/\n~ \(\d+\) AXTextField/g) ?? []).length === 30, `len=${unc.length}`);
      check("a pure key press gets the same (cut) change list, not counts only", more.test(nav) && (nav.match(/\n~ \(/g) ?? []).length >= 10, nav.slice(0, 200));
      await call("window_state", { ...W4, diff: true }); // the model catches up (the full list) after the cut report: find is not held
      await log();
      const press = { action: "click", ...W4, find: { label: "全部改写" } };
      const oq = await call("act", { ...press, observe: { query: "字段07" } });
      const os = await call("act", { ...press, observe: { include_screenshot: true }, again: true });
      const ot = await call("act", { ...press, observe: { tree: false }, again: true });
      lg = await log();
      const obsWalks = walks(lg).map((c) => J(c.args));
      check("observe:{query}: a window_state-style query view", textOf(oq).includes(' · 1 match(es) for "字段07" of 32 rows'), textOf(oq));
      check("observe:{include_screenshot:true}: walk with a screenshot, image returned", os.content.some((c) => c.type === "image") && obsWalks.includes(J({ pid: P, window_id: 724, include_screenshot: true })), J(obsWalks));
      check(
        "observe:{tree:false}: screenshot only, no walk",
        textOf(ot).endsWith("\nwin 724 · screenshot only (no AX walk)") && ot.content.some((c) => c.type === "image") && obsWalks.at(-1) === J({ pid: P, window_id: 724, include_screenshot: true, include_accessibility_tree: false }),
        textOf(ot)
      );
      const bad = await call("act", { action: "click", ...W4, element_token: all, observe: "yes" });
      const t0 = Date.now();
      const rp = await call("act", { action: "key", key: "down", repeat: 4, wait_ms: 600, ...W4, observe: false });
      const took = Date.now() - t0;
      lg = await log();
      check("observe of the wrong type: refused, nothing sent", bad.isError && textOf(bad) === "act: observe must be true, false or an object of window_state params" && !lg.calls.some((c) => c.tool === "click"), textOf(bad));
      check("single act repeat + wait_ms: 4 presses upstream, then the wait", textOf(rp) === "key: ok ×4" && lg.actions.length === 4 && lg.actions.every((a) => a.tool === "press_key" && a.args.key === "down") && took >= 600, `${textOf(rp)} ${took}ms`);

      const W5 = await win(725, FORM());
      const t5 = textOf(await call("window_state", { ...W5, include_screenshot: false }));
      const tok = `${sidOf(t5)}:${rowOf(t5, "AXButton", "保存")}`;
      const n1 = textOf(await call("act", { action: "click", ...W5, element_token: tok }));
      const n2 = await call("act", { action: "click", ...W5, element_token: tok });
      lg = await log();
      check("a press with no visible change: says so and warns against blind repeats", n1.includes("· no change vs your last view (10 rows)") && n1.endsWith("Do NOT blindly repeat a toggle or a submit — look first (window_state tree:false = quick screenshot)."), n1);
      check("the same control again right away: refused, nothing sent", n2.isError && textOf(n2).startsWith("click: FAILED (not executed) — you pressed this same control 0s ago and nothing in the window changed.") && textOf(n2).includes("again:true") && lg.actions.length === 1, `${textOf(n2)} ${J(lg.actions)}`);
      const n3 = await call("act", { action: "click", ...W5, element_token: tok, again: true, observe: false });
      lg = await log();
      check("…with again:true it runs", !n3.isError && lg.actions.length === 1 && lg.actions[0].target.label === "保存", textOf(n3));
      check("a press that changed something carries no repeat warning", !textOf(f).includes("Do NOT blindly"), "");
    });
    // 7.6c strict params (6) -------------------------------------------------
    await section("7.6c strict params", async () => {
      const W = await win(731, FORM());
      const t = textOf(await call("window_state", { ...W, include_screenshot: false }));
      const tok = `${sidOf(t)}:4`;
      await log();
      const refused = [
        [{ action: "hotkey", keys: ["cmd", "q"], key: "a" }, '"key" is not a parameter of action "hotkey" (it takes: x, y, keys, scope)'],
        [{ action: "click", element_token: tok, pid: "4242" }, 'action "click" requires "pid" (the pid you passed to window_state)'],
        [{ action: "hotkey", keys: ["cmd"] }, "hotkey.keys must be an array of modifiers"],
        [{ action: "scroll", direction: "down", amount: 0 }, "scroll.amount must be an integer 1-50"],
        [{ action: "scroll", direction: "down", amount: 51 }, "scroll.amount must be an integer 1-50"],
        [{ action: "key", key: "return", repeat: 2 }, "repeat is only for scroll and navigation keys"],
        [{ action: "key", key: "down", modifiers: ["cmd"], repeat: 2 }, "repeat is only for scroll and navigation keys"],
        [{ action: "type", text: "生僻\u{20000}字" }, "type cannot send characters beyond U+FFFF"],
        [{ action: "click" }, 'action "click" needs a target: element_token, find, or x+y'],
        [{ action: "set_value", value: "x" }, 'action "set_value" needs a target'],
        [{ action: "double_click", x: 10 }, 'action "double_click" needs a target'],
        [{ action: "key", key: "down", wait_ms: 10001 }, "wait_ms must be an integer 0-10000"],
      ];
      for (const [args, want] of refused) {
        const r = await call("act", { ...W, ...args, observe: false });
        check(`act refuses ${J(args).slice(0, 60)}`, r.isError && textOf(r).startsWith(`act invalid (nothing executed): ${want}`), textOf(r).slice(0, 160));
      }
      let lg = await log();
      check("…and none of those sent anything upstream", lg.calls.length === 0, J(lg.calls));
      const allowed = [
        [{ action: "hotkey", keys: ["cmd", "a"], key: null }, "hotkey", { pid: P, window_id: 731, keys: ["cmd", "a"] }],
        [{ action: "scroll", direction: "down", amount: 50 }, "scroll", { pid: P, window_id: 731, direction: "down", amount: 50 }],
        [{ action: "type", text: "中文テキスト" }, "type_text", { pid: P, window_id: 731, text: "中文テキスト" }],
        [{ action: "double_click", x: 10, y: 20 }, "double_click", { pid: P, window_id: 731, x: 10, y: 20 }],
        [{ action: "key", key: "down", modifiers: ["shift"], repeat: 2 }, "press_key", { pid: P, window_id: 731, key: "down", modifiers: ["shift"] }],
      ];
      for (const [args, tool, sent] of allowed) {
        const r = await call("act", { ...W, ...args, observe: false });
        lg = await log();
        check(`act accepts ${J(args).slice(0, 60)} and sends exactly that`, !r.isError && lg.actions.length >= 1 && lg.actions.every((a) => a.tool === tool && J(a.args) === J(sent)), `${textOf(r)} ${J(lg.actions)}`);
      }
      const top = await call("act_batch", { ...W, steps: [{ action: "key", key: "a" }], foo: 1 });
      const mixed = await call("act_batch", { ...W, steps: [{ action: "click", element_token: tok }, { action: "hotkey", keys: ["cmd", "w"], key: "w" }] });
      const reps = (n) => Array.from({ length: n }, () => ({ action: "scroll", direction: "down", repeat: 20 }));
      const over = await call("act_batch", { ...W, steps: reps(4) });
      lg = await log();
      check("act_batch: unknown top-level key refused", top.isError && textOf(top) === 'act_batch invalid (nothing executed): "foo" is not a top-level parameter (steps, pid, window_id, session, delivery_mode, observe) — per-step params go inside steps[]', textOf(top));
      check("act_batch: one bad step = nothing runs (step 1 was fine)", mixed.isError && textOf(mixed).startsWith('act_batch step 2 invalid (nothing executed): "key" is not a parameter of action "hotkey"'), textOf(mixed));
      check("act_batch: repeat total over 60 refused", over.isError && textOf(over) === "act_batch invalid (nothing executed): repeat totals 80, the cap per call is 60", textOf(over));
      check("…none of the three sent anything upstream", lg.calls.length === 0, J(lg.calls));
      const at = await call("act_batch", { ...W, steps: reps(3), observe: false });
      lg = await log();
      check("act_batch: repeat total of exactly 60 runs all 60", !at.isError && textOf(at).startsWith("[act_batch] all 3 steps done — 3 ok, 0 skipped.\nstep 1 scroll: ok ×20") && lg.actions.length === 60, `${textOf(at)} ${lg.actions.length}`);
    });
    // 7.6d receipts (7) ------------------------------------------------------
    await section("7.6d receipts", async () => {
      const W = await win(741, FORM());
      const t = textOf(await call("window_state", { ...W, include_screenshot: false }));
      const save = `${sidOf(t)}:4`;
      await log();
      const run = async (steps, reply, extra = { observe: false }) => {
        if (reply) await ctl("fake_next_reply", reply);
        const r = await call("act_batch", { ...W, steps, ...extra });
        return { r, x: textOf(r), lg: await log() };
      };
      let o = await run([{ action: "click", element_token: save }, { action: "type", text: "abc" }, { action: "key", key: "return" }]);
      check("batch ok: head + one line per step", !o.r.isError && o.x === `[act_batch] all 3 steps done — 3 ok, 0 skipped.\nstep 1 click: ok (${save} AXButton "保存")\nstep 2 type: ok\nstep 3 key: ok`, o.x);
      check(
        "batch ok: in order upstream, facade keys never leak",
        J(o.lg.actions.map((a) => [a.tool, a.args])) === J([["click", { pid: P, window_id: 741, element_token: save }], ["type_text", { pid: P, window_id: 741, text: "abc" }], ["press_key", { pid: P, window_id: 741, key: "return" }]]),
        J(o.lg.actions)
      );
      o = await run([{ action: "click", find: { label: "不存在" }, if_present: true }, { action: "key", key: "escape" }]);
      check("if_present, target absent: skipped, the batch goes on", !o.r.isError && o.x === '[act_batch] all 2 steps done — 1 ok, 1 skipped.\nstep 1 click: skipped (if_present, {"label":"不存在"} absent)\nstep 2 key: ok' && o.lg.actions.length === 1, o.x);
      o = await run([{ action: "click", find: { label: "不存在" } }, { action: "key", key: "escape" }]);
      check(
        "failure at step 1: nothing took effect, not executed, nothing upstream",
        o.r.isError && o.x.startsWith('[act_batch] FAILED at step 1 of 2: nothing took effect; 1 later step(s) not run.\nstep 1 click: FAILED (not executed) — find: nothing matches {"label":"不存在"} in "样例窗"') && o.lg.actions.length === 0,
        o.x
      );
      o = await run([{ action: "click", element_token: save }, { action: "click", find: { label: "不存在" } }, { action: "key", key: "return" }]);
      check("failure at step 2: step 1 DID take effect, step 3 never ran", o.r.isError && o.x.startsWith("[act_batch] FAILED at step 2 of 3: 1 earlier step(s) DID take effect — do not re-issue them; 1 later step(s) not run.") && J(o.lg.actions.map((a) => a.tool)) === J(["click"]), o.x);
      o = await run([{ action: "click", element_token: save }, { action: "type", text: "x".repeat(59) }], null);
      check("(control) both steps ran", o.lg.actions.length === 2, J(o.lg.actions.length));
      await ctl("fake_next_reply", { text: "clicked" });
      o = await run([{ action: "click", element_token: save }, { action: "type", text: "x".repeat(59) }], { error: "typing stopped: delivered 58 of 59 characters; retry the suffix" });
      check(
        "partial delivery: PARTIALLY executed + do-not-retype note",
        o.r.isError && o.x.includes("\nstep 2 type: FAILED (PARTIALLY executed) — typing stopped: delivered 58 of 59 characters; retry the suffix — [desktop-hub] delivery counts are unreliable in BOTH directions") && o.lg.actions.length === 2,
        o.x
      );
      o = await run([{ action: "key", key: "return" }, { action: "key", key: "tab" }], { error: "event tap timed out while posting" }, {});
      check("cut-off upstream error: outcome UNKNOWN, later steps not run, window still observed", o.r.isError && o.x.includes("step 1 key: FAILED (outcome UNKNOWN — it may have executed or still be running) — event tap timed out while posting") && o.x.includes("\nwin 741 ") && o.lg.actions.length === 1, o.x);
      o = await run([{ action: "key", key: "return" }], { error: "target window not found" }, {});
      check("refusal-type upstream error: not executed, no observation", o.r.isError && o.x.endsWith("step 1 key: FAILED (not executed) — target window not found") && !o.lg.calls.some((c) => c.tool === "get_window_state"), o.x);
      const doubtful = [
        [{ effect: "suspected_noop", route: "ax" }, { action: "click", find: { label: "保存" } }, 'step 1 click: ok (find → [4] AXButton "保存") · ⚠ effect=suspected_noop route=ax — the press probably did nothing'],
        [{ effect: "unverifiable", escalation: { reason: "delivery_failed", target: "foreground" } }, { action: "hotkey", keys: ["cmd", "a"] }, 'step 1 hotkey: ok · ⚠ effect=unverifiable escalation=delivery_failed→foreground — the shortcut did not reach the background window; for paste/copy/select-all use action:"menu"'],
        [{ effect: "confirmed", delivery: { mode: "foreground" } }, { action: "key", key: "a" }, "step 1 key: ok · ⚠ effect=confirmed — upstream ESCALATED TO FOREGROUND (focus/cursor were taken) although background was requested"],
        [{ escalation: { reason: "suspected_noop", target: "pixel" } }, { action: "key", key: "b" }, "step 1 key: ok · ⚠ escalation=suspected_noop→pixel — the press probably did nothing"],
      ];
      for (const [env, step, line] of doubtful) {
        o = await run([step, { action: "key", key: "return" }], { structured: env });
        check(`doubtful effect ${J(env).slice(0, 50)}: ⚠ and the batch stops`, o.r.isError && bare(o.x).startsWith(`[act_batch] STOPPED after step 1 of 2: it ran but its effect is doubtful (⚠ below); 1 later step(s) not run.\n${line}`) && o.lg.actions.length === 1, o.x);
      }
      o = await run([{ action: "type", text: "网页" }, { action: "key", key: "return" }], { structured: { effect: "unverifiable", escalation: { reason: "effect_unconfirmed", target: "none" } } });
      check(
        "effect_unconfirmed (web content): no ⚠, batch continues, one closing note",
        !o.r.isError && o.x === "[act_batch] all 2 steps done — 2 ok, 0 skipped.\nstep 1 type: ok · effect=unverifiable\nstep 2 key: ok\n(the driver could not confirm this by reading it back — usual for web content and for keys sent to a window rather than to an element; not a failure in itself: go by the changes listed)" && o.lg.actions.length === 2,
        o.x
      );
      await ctl("fake_next_reply", { structured: { effect: "suspected_noop" } });
      const one = await call("act", { action: "key", key: "c", ...W, observe: false });
      check("single act, doubtful effect: keeps the STOPPED head", one.isError && textOf(one).startsWith("[act] STOPPED after step 1 of 1: it ran but its effect is doubtful (⚠ below); 0 later step(s) not run.\nkey: ok · ⚠ effect=suspected_noop"), textOf(one));
      await log();
    });
    // 7.6e menu-bar find (8) -------------------------------------------------
    await section("7.6e menu-bar find", async () => {
      const W = await win(751, FORM());
      const m = await call("act", { action: "click", ...W, find: { role: "AXMenuItem", label: "导出" }, observe: false });
      let lg = await log();
      check("find with a menu role hits the menu bar → refused with the menu path", m.isError && bare(textOf(m)) === 'click: FAILED (not executed) — [12] AXMenuItem "导出…" is a menu-bar item — invoke it with action:"menu" path ["文件","导出…"]' && lg.actions.length === 0, textOf(m));
      const b = await call("act", { action: "click", ...W, find: { label: "导出" }, observe: false });
      lg = await log();
      check("find without a menu role never searches the menu bar", !b.isError && bare(textOf(b)) === 'click: ok (find → [7] AXButton "导出")' && lg.actions[0]?.target.label === "导出", textOf(b));
      const mm = await call("act", { action: "menu", ...W, path: ["文件", "导出…"], observe: false });
      lg = await log();
      check("action menu: invoke_menu with the path", !mm.isError && J(lg.actions.map((a) => [a.tool, a.args])) === J([["invoke_menu", { pid: P, window_id: 751, path: ["文件", "导出…"] }]]), J(lg.actions));
      const fitClick = await call("act", { action: "click", ...W, find: { label: "名称" }, observe: false });
      lg = await log();
      check('find {label:"名称"} for a click: the inert static label gives way to the field of that name', !fitClick.isError && lg.actions.length === 1 && lg.actions[0].target.role === "AXTextField", textOf(fitClick));
      const amb = await call("act", { action: "click", ...W, find: { role: "AXButton" }, observe: false });
      const nth = await call("act", { action: "click", ...W, find: { role: "AXButton", nth: 1 }, observe: false });
      lg = await log();
      check("ambiguous find: refused, candidates listed as tokens", amb.isError && /find: 4 controls match \{"role":"AXButton"\} — say which by near:"<text on its line \/ in its table row>" or nth \(from 0 in this list\), or use one of these as element_token: s[0-9a-f]+:4 AXButton "保存"/.test(textOf(amb)), textOf(amb));
      check("find.nth picks the second match; only it ran", !nth.isError && lg.actions.length === 1 && lg.actions[0].target.label === "开启同步", J(lg.actions));
    });
    // 7.6g fixes from the implementation review ----------------------------
    await section("7.6g review fixes", async () => {
      const W = await win(761, FORM());
      const t = textOf(await call("window_state", { ...W, include_screenshot: false }));
      const A = sidOf(t);
      const save = rowOf(t, "AXButton", "保存");
      await log();
      // extra may add driver parameters, never restate one the facade models
      for (const [extra, key] of [[{ delivery_mode: "foreground" }, "delivery_mode"], [{ scope: "desktop" }, "scope"], [{ from_x: 1 }, "from_x"], [{ modifier: ["cmd"] }, "modifier"], [{ element_token: "s1:1" }, "element_token"], [{ target: { display_id: "primary" } }, "target"]]) {
        const r = await call("act", { action: "click", ...W, element_token: `${A}:${save}`, extra, observe: false });
        check(`extra may not set ${key}`, r.isError && textOf(r) === `act invalid (nothing executed): extra may not set "${key}" — pass it as a regular parameter`, textOf(r));
      }
      const proto = await call("act", { action: "constructor", ...W, observe: false });
      check("an action named like an Object.prototype key is just unknown", proto.isError && textOf(proto).startsWith('act invalid (nothing executed): unknown action "constructor"'), textOf(proto));
      let lg = await log();
      check("…nothing of that reached upstream", lg.calls.length === 0, J(lg.calls));
      // a token together with stray coordinates: the token wins, x/y are not sent
      const both = await call("act", { action: "click", ...W, element_token: `${A}:${save}`, x: 5, y: 6, observe: false });
      lg = await log();
      check("token + stray x,y: only the token goes upstream", !both.isError && lg.actions.length === 1 && lg.actions[0].args.x === undefined && lg.actions[0].args.y === undefined && lg.actions[0].target.label === "保存", J(lg.actions[0]?.args));
      // a harmless extra still passes through
      const dbg = await call("act", { action: "click", ...W, x: 30, y: 40, extra: { debug_image_out: "/tmp/x.png" }, observe: false });
      lg = await log();
      check("an extra the facade does not model still passes through", !dbg.isError && lg.actions[0]?.args.debug_image_out === "/tmp/x.png", `${textOf(dbg)} ${J(lg.actions)}`);

      // repeat that fails midway is a PARTIAL execution, and the summary says so
      const W2 = await win(762, FORM());
      await call("window_state", { ...W2, include_screenshot: false });
      const okEnv = { structured: { delivery: { mode: "background" }, effect: "unverifiable", route: "synthetic_events" } };
      await ctl("fake_next_reply", okEnv); // step 1
      await ctl("fake_next_reply", okEnv); // step 2, 1st of 3
      await ctl("fake_next_reply", { error: "driver hiccup" }); // step 2, 2nd of 3
      await log();
      const rp = await call("act_batch", { ...W2, steps: [{ action: "key", key: "up" }, { action: "key", key: "down", repeat: 3 }, { action: "key", key: "tab" }], observe: false });
      lg = await log();
      const rpt = textOf(rp);
      check(
        "repeat failing on its 2nd round: PARTIALLY executed, said in the step line and in the summary",
        rp.isError &&
          rpt.startsWith("[act_batch] FAILED at step 2 of 3: 1 earlier step(s) DID take effect — do not re-issue them; 1 later step(s) not run. Also: the failing step PARTIALLY executed.") &&
          rpt.includes("step 2 key: FAILED (PARTIALLY executed) — repeat stopped after 1 of 3: driver hiccup"),
        rpt
      );
      check("…and upstream saw exactly up + down + the failing down, not the tab", lg.calls.filter((c) => c.tool === "press_key").map((c) => c.args.key).join(",") === "up,down,down", J(lg.calls.map((c) => [c.tool, c.args.key])));
      await ctl("fake_next_reply", { error: "driver hiccup" });
      const rp1 = textOf(await call("act_batch", { ...W2, steps: [{ action: "key", key: "up" }, { action: "key", key: "tab" }], observe: false }));
      check("first step cut off with an unclassifiable upstream error: the summary does not claim 'nothing took effect'", rp1.startsWith("[act_batch] FAILED at step 1 of 2: the failing step may have executed (outcome unknown); 1 later step(s) not run."), rp1);
      await log();

      // the re-press gate: cleared by looking, and by any other action in between
      const W3 = await win(763, FORM());
      const t3 = textOf(await call("window_state", { ...W3, include_screenshot: false }));
      const tok3 = `${sidOf(t3)}:${rowOf(t3, "AXButton", "导出")}`;
      const p1 = await call("act", { action: "click", ...W3, element_token: tok3 });
      check("re-press gate: first press reports no change", !p1.isError && textOf(p1).includes("no change vs") && textOf(p1).includes("Do NOT blindly repeat"), textOf(p1));
      const p2 = await call("act", { action: "click", ...W3, element_token: tok3, observe: false });
      check("re-press gate: immediate repeat refused", p2.isError && textOf(p2).includes("you pressed this same control"), textOf(p2));
      await call("window_state", { ...W3, query: "导出", include_screenshot: false });
      await log();
      const p3 = await call("act", { action: "click", ...W3, element_token: tok3, observe: false });
      lg = await log();
      check("re-press gate: after the model looked, the press goes through without again:true", !p3.isError && lg.actions.length === 1 && lg.actions[0].target.label === "导出", textOf(p3));
      const p4 = await call("act", { action: "click", ...W3, element_token: tok3 });
      check("re-press gate: armed again by another no-change press", !p4.isError && textOf(p4).includes("Do NOT blindly repeat"), textOf(p4));
      await call("act", { action: "key", ...W3, key: "tab", observe: false });
      await log();
      const p5 = await call("act", { action: "click", ...W3, element_token: tok3, observe: false });
      lg = await log();
      check("re-press gate: another action in between clears it", !p5.isError && lg.actions.length === 1, textOf(p5));

      // hub-native tools never hand structuredContent through, even on odd upstream replies
      const lw = await call("list_windows", {});
      check("list_windows result carries no structuredContent", lw.structuredContent === undefined && !lw.isError, J(lw.structuredContent ?? null).slice(0, 80));
    });

    // 7.6h tokens follow what the model was shown (round-3 attack repros) ----
    await section("7.6h shown-first tokens", async () => {
      const clicks = (lg) => lg.calls.filter((c) => c.tool === "click");
      const chrome = (rows, url) => [[0, "AXWindow", "后台", { a: ["AXRaise"] }], [1, "AXToolbar", null, {}], [2, "AXTextField", "地址和搜索栏", { v: url, press: true }], [1, "AXWebArea", "后台", { web: true }], ...rows];
      const projects = (names) => [[2, "AXList", "项目", {}], ...names.flatMap((n) => [[3, "AXGroup", null, {}], [4, "AXStaticText", n, { a: [] }], [4, "AXButton", "设置", { press: true }]])];
      const confirm = (name) => [[2, "AXGroup", "确认删除", {}], [3, "AXStaticText", `确定删除项目「${name}」？此操作不可撤销。`, { a: [] }], [3, "AXGroup", null, {}], [4, "AXButton", "取消", { press: true }], [4, "AXButton", "删除", { press: true }]];
      const NAMES = ["甲项目", "乙项目", "丙项目", "丁项目"];
      const URL = "https://admin.example.test/projects";

      // E1: the confirm box now names another project (same title, same URL, still one box).
      const W = await win(771, chrome([...projects(NAMES), ...confirm("乙项目")], URL));
      const v1 = textOf(await call("window_state", { ...W, include_screenshot: false }));
      const tok = `${sidOf(v1)}:${rowOf(v1, "AXButton", "删除")}`;
      await ctl("fake_set_window", { pid: P, window_id: 771, rows: chrome([...projects(NAMES), ...confirm("丙项目")], URL) });
      await call("window_state", { ...W, max_elements: 3, include_screenshot: false }); // a capped look: the hub walked, the model learned nothing
      await log();
      const e1 = await call("act", { action: "click", ...W, element_token: tok, observe: false });
      let lg = await log();
      check(
        "E1 confirm box swapped unseen: refused, nothing sent, and the swap is spelled out",
        e1.isError && clicks(lg).length === 0 && textOf(e1).includes("you had not been shown how. Nothing was executed for this step.") && textOf(e1).includes('AXStaticText "确定删除项目「丙项目」？此操作不可撤销。" (was "确定删除项目「乙项目」？此操作不可撤销。")'),
        textOf(e1)
      );
      const e1b = await call("act", { action: "click", ...W, element_token: tok, observe: false });
      lg = await log();
      check("E1 …the same step sent again, now knowingly: accepted, lands on the one 删除 there is, and the reply says where", !e1b.isError && lg.actions.length === 1 && lg.actions[0].target.label === "删除" && J(lg.actions[0].target.siblings) === J(["取消"]) && textOf(e1b).includes('AXButton "删除" (after "确认删除 · 确定删除项目「丙项目」？此操作不可撤销。" in reading order)'), `${textOf(e1b)} ${J(lg.actions)}`);
      // The same swap, but the model looks with a query in between: that reply carries the news.
      const Wq = await win(778, chrome([...projects(NAMES), ...confirm("乙项目")], URL));
      const q1 = textOf(await call("window_state", { ...Wq, include_screenshot: false }));
      await ctl("fake_set_window", { pid: P, window_id: 778, rows: chrome([...projects(NAMES), ...confirm("丙项目")], URL) });
      const q2 = textOf(await call("window_state", { ...Wq, query: "设置|删除", include_screenshot: false }));
      await log();
      const e1q = await call("act", { action: "click", ...Wq, element_token: `${sidOf(q1)}:${rowOf(q1, "AXButton", "删除")}`, observe: false });
      lg = await log();
      check("E1 with a query look in between: the look itself reports the swap, so the old token needs no refusal round", q2.includes('Also changed since then:') && q2.includes('(was "确定删除项目「乙项目」？此操作不可撤销。")') && !e1q.isError && clicks(lg).length === 1, `${q2}\n${textOf(e1q)}`);

      // E2: two mails whose subjects differ only at the far end swap places.
      const S1 = "[some-org/some-repo] Run failed: smoke tests on main — commit 4f2a9c1 by someone";
      const S2 = "[some-org/some-repo] Run failed: smoke tests on main — commit 7be03d2 by someone";
      const mail = (subs) => [[2, "AXTable", "收件箱", {}], ...subs.flatMap((s) => [[3, "AXRow", null, {}], [4, "AXStaticText", "某仓库", { a: [] }], [4, "AXStaticText", s, { a: [] }], [4, "AXStaticText", "11月17日", { a: [] }], [4, "AXButton", "删除", { press: true }]])];
      const MURL = "https://mail.example.test/#inbox";
      const M = await win(772, chrome(mail(["周报：本周进展", S1, S2, "发票已开具"]), MURL));
      const m1 = textOf(await call("window_state", { ...M, include_screenshot: false, full_text: true }));
      const lines = m1.split("\n");
      const at = lines.findIndex((l) => l.includes("4f2a9c1"));
      const delRow = Number(/[[(](\d+)[\])] AXButton "删除"/.exec(lines.slice(at).find((l) => l.includes('AXButton "删除"')))[1]);
      await ctl("fake_set_window", { pid: P, window_id: 772, rows: chrome(mail(["周报：本周进展", S2, S1, "发票已开具"]), MURL) });
      const mq = textOf(await call("window_state", { ...M, query: "删除", include_screenshot: false }));
      await log();
      const e2 = await call("act", { action: "click", ...M, element_token: `${sidOf(m1)}:${delRow}`, observe: false });
      lg = await log();
      check("E2 rows swapped unseen: the look reports both subjects changing, quoted where they differ", mq.includes("Also changed since then:") && mq.includes("7be03d2") && mq.includes("4f2a9c1"), mq.slice(-600));
      check("E2 …and the old token is refused all the same (its row lost its landmark), candidates offered, nothing sent", e2.isError && textOf(e2).includes("Current candidates (usable as element_token): ") && clicks(lg).length === 0, `${textOf(e2).slice(0, 300)} ${J(clicks(lg))}`);

      // Round-4 attack B1: a table slot now holds another customer; amount and date happen to match.
      const ordersRows = (recs) => [[2, "AXButton", "刷新", { press: true }], [2, "AXTable", "订单", {}], ...recs.flatMap(([nm, amt, date], k) => [[3, "AXRow", null, {}], [4, "AXStaticText", `${k + 1}`, { a: [] }], [4, "AXStaticText", nm, { a: [] }], [4, "AXStaticText", amt, { a: [] }], [4, "AXStaticText", date, { a: [] }], [4, "AXButton", "删除", { press: true }]])];
      const BASE = [["王一", "¥120.00", "11-02"], ["李二", "¥80.00", "11-05"], ["赵三", "¥300.00", "11-07"], ["周四", "¥45.00", "11-09"]];
      const AFTER = [BASE[0], ["孙五", "¥80.00", "11-05"], BASE[2], BASE[3]];
      const O = await win(779, chrome(ordersRows(BASE), "https://crm.example.test/orders"));
      const ord = textOf(await call("window_state", { ...O, include_screenshot: false }));
      const ol = ord.split("\n");
      const delOf = (name) => Number(/\[(\d+)\] AXButton "删除"/.exec(ol.slice(ol.findIndex((l) => l.includes(name))).find((l) => l.includes('AXButton "删除"')))[1]);
      await ctl("fake_after_action", { pid: P, window_id: 779, rows: chrome(ordersRows(AFTER), "https://crm.example.test/orders") });
      const rf = await call("act", { action: "click", ...O, element_token: `${sidOf(ord)}:${rowOf(ord, "AXButton", "刷新")}` });
      await log();
      const slot = await call("act", { action: "click", ...O, element_token: `${sidOf(ord)}:${delOf("李二")}`, observe: false });
      const slotOk = await call("act", { action: "click", ...O, element_token: `${sidOf(ord)}:${delOf("周四")}`, observe: false });
      lg = await log();
      check("B1 slot now holds another record (reported in the receipt): its old 删除 token is refused, nothing sent for it", textOf(rf).includes('"孙五" (was "李二")') && slot.isError && textOf(slot).includes("Nothing was executed."), `${textOf(rf)}\n${textOf(slot)}`);
      check("B1 …and so are the other rows' old tokens (repeated control, changed window): nothing sent", slotOk.isError && clicks(lg).length === 0, textOf(slotOk));
      const slotNear = await call("act", { action: "click", ...O, find: { label: "删除", near: "周四" }, observe: false });
      const slotGone = await call("act", { action: "click", ...O, find: { label: "删除", near: "李二" }, observe: false });
      lg = await log();
      check("B1 …by content: near 周四 presses 周四's 删除; near 李二 (no longer on the page) presses nothing", !slotNear.isError && slotGone.isError && clicks(lg).length === 1 && lg.actions[0].target.siblings.includes("周四"), `${textOf(slotNear)} | ${textOf(slotGone)}`);

      // Round-4 attack D1: a ticking text must not cost a refusal round after two looks.
      const live = (t) => chrome([[2, "AXStaticText", `已直播 00:0${t}`, { a: [] }], [2, "AXButton", "保存", { press: true }], [2, "AXButton", "导出", { press: true }]], "https://live.example.test/room");
      const Lw = await win(780, live(1));
      const l1 = textOf(await call("window_state", { ...Lw, query: "保存", include_screenshot: false }));
      await ctl("fake_set_window", { pid: P, window_id: 780, rows: live(2) });
      const l2 = textOf(await call("window_state", { ...Lw, query: "导出", include_screenshot: false }));
      await log();
      const tick = await call("act", { action: "click", ...Lw, element_token: `${sidOf(l1)}:${rowOf(l1, "AXButton", "保存")}`, observe: false });
      lg = await log();
      check("D1 ticking clock between two query looks: the second look reports the tick and the first look's token is accepted at once", l2.includes('Also changed since then:') && l2.includes("已直播 00:02") && !tick.isError && clicks(lg).length === 1 && lg.actions[0].target.label === "保存", `${l2}\n${textOf(tick)}`);

      // desk_call: an element token must belong to the pid the call names (a guard reviews the call by its pid).
      await ctl("fake_set_window", { pid: 5151, window_id: 790, rows: FORM({ title: "别的进程" }) });
      const other = textOf(await call("window_state", { pid: 5151, window_id: 790, include_screenshot: false }));
      await log();
      const forged = await call("desk_call", { server: "cua", tool: "click", args: { pid: P, element_token: `${sidOf(other)}:${rowOf(other, "AXButton", "保存")}` } });
      const forged2 = await call("desk_call", { server: "cua", tool: "click", args: { pid: P, window_id: 771, snapshot_id: sidOf(other), element_index: rowOf(other, "AXButton", "保存") } });
      lg = await log();
      check("desk_call: a token of another process's window under this pid is refused by the hub, nothing sent", forged.isError && textOf(forged).includes("belongs to pid 5151 window 790, not to pid 4242") && forged2.isError && lg.calls.length === 0, `${textOf(forged)} | ${textOf(forged2)} ${J(lg.calls)}`);
      const honest = await call("desk_call", { server: "cua", tool: "click", args: { pid: 5151, window_id: 790, element_token: `${sidOf(other)}:${rowOf(other, "AXButton", "保存")}` } });
      lg = await log();
      check("desk_call: the same token with its own pid passes through", !honest.isError && lg.actions.length === 1 && lg.actions[0].target.label === "保存", textOf(honest));

      // A second full view after an unseen change retires the older snapshot.
      const R = await win(773, FORM());
      const r1 = textOf(await call("window_state", { ...R, include_screenshot: false }));
      const old = `${sidOf(r1)}:${rowOf(r1, "AXButton", "保存")}`;
      await ctl("fake_set_window", { pid: P, window_id: 773, rows: FORM({ name: "别人改的" }) });
      const r2 = textOf(await call("window_state", { ...R, include_screenshot: false }));
      await log();
      const ret = await call("act", { action: "click", ...R, element_token: old, observe: false });
      const cur = await call("act", { action: "click", ...R, element_token: `${sidOf(r2)}:${rowOf(r2, "AXButton", "保存")}`, observe: false });
      lg = await log();
      check(
        "retired snapshot: an old token after a changed second full view is refused and points at the newer view",
        ret.isError && textOf(ret).includes(`snapshot ${sidOf(r1)} is retired`) && textOf(ret).includes(`(snapshot ${sidOf(r2)})`) && textOf(ret).includes(`${sidOf(r2)}:${rowOf(r2, "AXButton", "保存")} AXButton "保存"`) && !cur.isError && clicks(lg).length === 1,
        textOf(ret)
      );
      const R2 = await win(774, FORM());
      const s1 = textOf(await call("window_state", { ...R2, include_screenshot: false }));
      const s2 = textOf(await call("window_state", { ...R2, include_screenshot: false }));
      await log();
      const keep = await call("act", { action: "click", ...R2, element_token: `${sidOf(s1)}:${rowOf(s1, "AXButton", "保存")}`, observe: false });
      lg = await log();
      check("…but a second full view of an UNCHANGED window retires nothing", !keep.isError && lg.actions[0]?.args.element_token === `${sidOf(s2)}:${rowOf(s2, "AXButton", "保存")}`, textOf(keep));

      // A change the model caused and was shown: the old token of the one 继续/确定 just works.
      const D = await win(775, FORM({ sheet: true }));
      const d1 = textOf(await call("window_state", { ...D, include_screenshot: false }));
      const go = `${sidOf(d1)}:${rowOf(d1, "AXButton", "继续")}`;
      const sheet2 = FORM({ sheet: true }).map((r) => (r[2] === "要继续吗" ? [r[0], r[1], "第二步：确认导出范围", r[3]] : r));
      await ctl("fake_after_action", { pid: P, window_id: 775, rows: sheet2 });
      const n1 = await call("act", { action: "click", ...D, element_token: go });
      await log();
      const n2 = await call("act", { action: "click", ...D, element_token: go, observe: false });
      lg = await log();
      check(
        "shown change: the receipt reported the dialog's new words, so the old 继续 token is accepted straight away",
        !n1.isError && textOf(n1).includes('AXStaticText "第二步：确认导出范围" (was "要继续吗")') && !n2.isError && lg.actions.length === 1 && lg.actions[0].target.label === "继续",
        `${textOf(n1)} | ${textOf(n2)}`
      );

      // A find walk inside the batch that sees an unreported change puts later old tokens on hold.
      const B = await win(776, FORM());
      const b1 = textOf(await call("window_state", { ...B, include_screenshot: false }));
      await ctl("fake_after_action", { pid: P, window_id: 776, rows: FORM({ name: "第一步写入" }) });
      await log();
      const bb = await call("act_batch", { ...B, steps: [{ action: "click", find: { label: "保存" } }, { action: "click", find: { label: "导出" } }, { action: "click", element_token: `${sidOf(b1)}:${rowOf(b1, "AXButton", "确 定")}` }], observe: false });
      lg = await log();
      check(
        "batch: step 3's old token is held because step 2's find saw a change nobody reported; steps 1-2 ran, the reply says so",
        bb.isError && textOf(bb).startsWith("[act_batch] FAILED at step 3 of 3: 2 earlier step(s) DID take effect") && textOf(bb).includes('value "" → "第一步写入"') && clicks(lg).length === 2,
        textOf(bb)
      );

      // Round-5 U1: a batch mixing tokens and find. Step 1's change makes step 3's old token wait; the retry of step 3 alone must go through at once.
      const SW = (a, b, c) => [[0, "AXWindow", "设置", {}], [1, "AXGroup", "开关区", {}], [2, "AXCheckBox", "开关甲", { v: a, press: true }], [2, "AXCheckBox", "开关乙", { v: b, press: true }], [2, "AXCheckBox", "开关丙", { v: c, press: true }]];
      const S = await win(781, SW("0", "0", "0"));
      const sv = textOf(await call("window_state", { ...S, include_screenshot: false }));
      const st = (label) => `${sidOf(sv)}:${rowOf(sv, "AXCheckBox", label)}`;
      await ctl("fake_after_action", { pid: P, window_id: 781, rows: SW("1", "0", "0") });
      await ctl("fake_after_action", { pid: P, window_id: 781, rows: SW("1", "1", "0") });
      await log();
      const mix = await call("act_batch", { ...S, steps: [{ action: "click", element_token: st("开关甲") }, { action: "click", find: { label: "开关乙" } }, { action: "click", element_token: st("开关丙") }] });
      lg = await log();
      check(
        "U1 batch [token, find, token]: steps 1-2 run, step 3 waits with the change list, and the report continues from that list",
        mix.isError && clicks(lg).length === 2 && textOf(mix).includes("step 3 click: FAILED (not executed) — the window changed after the view your token comes from") && textOf(mix).includes("only this step and any after it") && /vs your last view\n~ \[\d+\] AXCheckBox "开关乙" = "1": value "0" → "1"$/.test(textOf(mix)),
        textOf(mix)
      );
      const again = await call("act", { action: "click", ...S, element_token: st("开关丙"), observe: false });
      lg = await log();
      check("U1 …step 3 alone, sent again unchanged: accepted on the first retry", !again.isError && clicks(lg).length === 1 && lg.actions[0].target.label === "开关丙", textOf(again));

      // Round-5 F1: the driver restarts; the walk after an action notices. The tokens that reply prints must work.
      const Rs = await win(782, FORM());
      for (let k = 0; k < 12; k++) await call("window_state", { ...Rs, query: "保存", include_screenshot: false });
      await ctl("fake_restart", {});
      await ctl("fake_set_window", { pid: P, window_id: 782, rows: FORM({ top: "新按钮" }) });
      const afterRestart = textOf(await call("act", { action: "key", key: "tab", ...Rs }));
      const freshTok = `${sidOf(afterRestart)}:${rowOf(afterRestart, "AXButton", "新按钮")}`;
      await log();
      const useFresh = await call("act", { action: "click", ...Rs, element_token: freshTok, observe: false });
      lg = await log();
      check("F1 driver restart noticed by the look after an action: that reply is a first look, and its tokens are accepted", afterRestart.includes("full tree") && !useFresh.isError && lg.actions[0]?.target.label === "新按钮", `${afterRestart.slice(0, 200)} | ${textOf(useFresh)}`);

      // Round-5 small ones: exact label beats substring; strict observe keys; list_windows pid; oversized query.
      const Pw = await win(783, [[0, "AXWindow", "注册", {}], [1, "AXTextField", "密码", { v: "", press: true }], [1, "AXTextField", "确认密码", { v: "", press: true }]]);
      await log();
      const exact = await call("act", { action: "click", ...Pw, find: { label: "密码" }, observe: false });
      lg = await log();
      check('U10 find {label:"密码"} with "确认密码" also on the page: the exact label wins', !exact.isError && lg.actions[0]?.target.label === "密码", textOf(exact));
      const typo = await call("act", { action: "click", ...Pw, find: { label: "密码" }, observe: { querry: "密码" } });
      const lwNull = await call("list_windows", { pid: null });
      const lwBad = await call("list_windows", { pid: "abc" });
      const bigQ = await call("window_state", { ...Pw, query: "q".repeat(5000), include_screenshot: false });
      const badNear = await call("act", { action: "click", ...Pw, find: { near: "密码" }, observe: false });
      lg = await log();
      check("F7 an unknown key in the observe object is an error before anything runs", typo.isError && textOf(typo).includes('not "querry"') && lg.actions.length === 0, textOf(typo));
      check("F4 list_windows: pid null = not given; a non-integer pid is a readable error", !lwNull.isError && !textOf(lwNull).includes("of pid null") && lwBad.isError && textOf(lwBad).includes("pid must be an integer"), `${textOf(lwNull).slice(0, 80)} | ${textOf(lwBad)}`);
      check("F2 an oversized query is refused, not echoed back", bigQ.isError && textOf(bigQ).length < 300, textOf(bigQ).slice(0, 120));
      const qObj = await call("window_state", { ...Pw, query: { a: 1 }, include_screenshot: false });
      const laEmpty = await call("launch_app", {});
      const vEmpty = await call("verify", {});
      check("a query that is not text, launch_app with no target, verify with no window: readable errors, nothing sent upstream", qObj.isError && textOf(qObj).includes("query must be text") && laEmpty.isError && textOf(laEmpty).includes("launch_app needs bundle_id") && vEmpty.isError && textOf(vEmpty).includes("verify requires integer pid"), `${textOf(qObj)} | ${textOf(laEmpty)} | ${textOf(vEmpty)}`);
      check("find.near alone (no role/label/value) is a validation error", badNear.isError && textOf(badNear).includes("find.near narrows a role/label/value match"), textOf(badNear));

      // Unusual spellings are refused by the hub, not left for upstream to interpret.
      const V = await win(777, FORM());
      await log();
      const odd = [
        [{ action: "hotkey", keys: ["cmd+q", "x"] }, "hotkey.keys must be an array of modifiers"],
        [{ action: "hotkey", keys: ["cmd-q", "x"] }, "hotkey.keys must be an array of modifiers"],
        [{ action: "hotkey", keys: ["⌘", "q"] }, "hotkey.keys must be an array of modifiers"],
        [{ action: "hotkey", keys: ["cmd", "ｑ"] }, "hotkey.keys must be an array of modifiers"],
        [{ action: "hotkey", keys: ["cmnd", "q"] }, "hotkey.keys must be an array of modifiers"],
        [{ action: "hotkey", keys: ["q", "cmd"] }, "hotkey.keys must be an array of modifiers"],
        [{ action: "key", key: "q", modifiers: [["cmd"]] }, "modifiers must be an array of"],
        [{ action: "key", key: "q", modifiers: { 0: "cmd" } }, "modifiers must be an array of"],
        [{ action: "key", key: "numpad_enter" }, "key must be one key name"],
        [{ action: "key", key: "\n" }, "key must be one key name"],
        [{ action: "key", key: " return" }, "key must be one key name"],
        [{ action: "click", x: 5, y: 5, delivery_mode: " foreground" }, 'delivery_mode must be exactly "background" or "foreground"'],
        [{ action: "click", x: 5, y: 5, delivery_mode: ["foreground"] }, 'delivery_mode must be exactly "background" or "foreground"'],
        [{ action: "click", x: 5, y: 5, scope: "desktop " }, 'scope must be exactly "window" or "desktop"'],
        [{ action: "click", x: 5, y: 5, scope: ["desktop"] }, 'scope must be exactly "window" or "desktop"'],
        [{ action: "click", x: "5", y: 5 }, "needs a target"],
        [{ action: "type", text: ["echo hi", "\n"] }, "type.text must be a string"],
        [{ action: "set_value", element_token: "s1:1", value: 3 }, "set_value.value must be a string"],
        [{ action: "menu", path: ["文件", ""] }, "menu.path must be an array"],
      ];
      for (const [step, msg] of odd) {
        const r = await call("act", { ...V, ...step, observe: false });
        check(`act refuses ${J(step).slice(0, 70)}`, r.isError && textOf(r).startsWith("act invalid (nothing executed): ") && textOf(r).includes(msg), textOf(r).slice(0, 160));
      }
      const fine = await call("act_batch", { ...V, steps: [{ action: "hotkey", keys: ["Cmd", "Shift", "A"] }, { action: "key", key: "Return", modifiers: ["option"] }, { action: "key", key: "/" }, { action: "key", key: "f5" }], observe: false });
      lg = await log();
      check("…while ordinary spellings (any case, punctuation keys, f-keys) go through unchanged", !fine.isError && J(lg.calls.map((c) => c.args.keys ?? [c.args.key, ...(c.args.modifiers ?? [])])) === J([["Cmd", "Shift", "A"], ["Return", "option"], ["/"], ["f5"]]), `${textOf(fine)} ${J(lg.calls.map((c) => c.args))}`);
      check("…and none of the odd ones reached upstream", lg.calls.length === 4, J(lg.calls.map((c) => c.tool)));
    });
    // 7.6i review round 6: find.near on sparse pages, held finds, incomplete change lists, in-page menus ---------
    await section("7.6i round 6", async () => {
      const clicks = (lg) => lg.calls.filter((c) => c.tool === "click");
      const St = (d, t, o = {}) => [d, "AXStaticText", t, { a: [], ...o }];
      const B = (d, t, o = {}) => [d, "AXButton", t, { press: true, ...o }];
      const page = (title, rows) => [[0, "AXWindow", title, { a: ["AXRaise"] }], ...rows];
      const orow = (id, name, st, btn) => [[2, "AXRow", null, {}], [3, "AXCell", null, {}], St(4, id), [3, "AXCell", null, {}], St(4, name), [3, "AXCell", null, {}], St(4, st), ...(btn ? [[3, "AXCell", null, {}], B(4, btn)] : [])];
      const press = (W, find, extra = {}) => call("act", { action: "click", ...W, find, observe: false, ...extra });

      // F1 / U6-1: only one row has the button; another row's text must not select it.
      const sparse = page("订单", [[1, "AXTable", null, {}], ...orow("DD1001", "王建国", "已发货", null), ...orow("DD1003", "孙丽", "待处理", "取消订单"), ...orow("DD1005", "周强", "已发货", null)]);
      let W = await win(791, sparse);
      const wrongRow = await press(W, { label: "取消订单", near: "DD1005" });
      const rightRow = await press(W, { label: "取消订单", near: "DD1003" });
      let lg = await log();
      check(
        "F1 a lone button is not near another row's text: refused, nothing sent, its real row is named",
        wrongRow.isError && textOf(wrongRow).includes('"DD1005" cannot be shown to be next to any of them') && /AXButton "取消订单" near "DD1003 · 孙丽 · 待处理"/.test(textOf(wrongRow)) && clicks(lg).length === 1,
        textOf(wrongRow)
      );
      check("F1 …and its own row's text selects it, the reply saying where it landed", !rightRow.isError && /^click: ok \(find → s[0-9a-f]+:\d+ AXButton "取消订单" near "DD1003 · 孙丽 · 待处理"\)$/.test(textOf(rightRow)) && J(lg.actions[0]?.target.siblings) === J([]), textOf(rightRow));

      // F3: part of a longer id or number is not a match.
      W = await win(792, page("订单", [[1, "AXTable", null, {}], ...orow("DD98", "甲", "¥35", "删除"), ...orow("DD99", "乙", "¥1200", "删除"), ...orow("DD1001", "丙", "¥80", "删除")]));
      const sub1 = await press(W, { label: "删除", near: "DD100" });
      const sub2 = await press(W, { label: "删除", near: "12" });
      const whole = await press(W, { label: "删除", near: "¥1200" });
      lg = await log();
      check("F3 near matches whole words: DD100 is not DD1001 and 12 is not ¥1200 — refused, nothing sent", sub1.isError && sub2.isError && !whole.isError && clicks(lg).length === 1, `${textOf(sub1).slice(0, 160)} | ${textOf(sub2).slice(0, 80)}`);

      // W2: two sections; the first has one button, on its second row.
      const sect = (name, rows) => [[1, "AXGroup", name, {}], ...rows.flatMap(([id, st, b]) => [[2, "AXRow", null, {}], St(3, id), St(3, st), ...(b ? [B(3, "取消")] : [])])];
      W = await win(793, page("订单", [...sect("待发货", [["DD1001", "已打包", false], ["DD1002", "未打包", true]]), ...sect("待付款", [["DD2001", "张伟", true], ["DD2002", "李娜", true]])]));
      const w2 = await press(W, { label: "取消", near: "DD1001" });
      lg = await log();
      check("W2 a section's only button is not near another row of that section", w2.isError && clicks(lg).length === 0 && textOf(w2).includes('near "DD1002 · 未打包"'), textOf(w2));

      // F4: flat page, a text of another column on the same visual line.
      const FR = (k, x) => ({ f: [x, 100 + 40 * k, 80, 24] });
      W = await win(794, page("列表", [...[0, 1, 2].flatMap((k) => [St(1, `DD100${k + 1}`, FR(k, 20)), B(1, "删除", FR(k, 400))]), St(1, "DD1005 已发货", FR(1, 700))]));
      const flat = await press(W, { label: "删除", near: "DD1005" });
      const flatOk = await press(W, { label: "删除", near: "DD1002" });
      lg = await log();
      check("F4 flat page: a text beyond the next look-alike is not on this row — refused; the row's own text works", flat.isError && !flatOk.isError && clicks(lg).length === 1 && /find → s[0-9a-f]+:4 AXButton "删除" near "DD1002"\)$/.test(textOf(flatOk)), `${textOf(flat).slice(0, 200)} | ${textOf(flatOk)}`);

      // Nested cards: the text names a card that holds two of them → listed, nth picks among those.
      let line = 0;
      const fr = (x, w) => ({ f: [x, 100 + 40 * line, w, 24] });
      const card = (id, cust, items) => {
        const out = [[1, "AXGroup", null, {}]];
        out.push(St(2, `订单 ${id}`, fr(20, 160)));
        line++;
        out.push(St(2, cust, fr(20, 160)));
        line++;
        out.push([2, "AXList", null, {}]);
        for (const it of items) {
          out.push([3, "AXGroup", null, {}], St(4, it, fr(20, 160)), B(4, "退款", fr(400, 60)));
          line++;
        }
        return out;
      };
      W = await win(795, page("售后", [...card("DD1001", "王建国", ["空气炸锅 ×1", "数据线 ×2"]), ...card("DD1002", "李秀英", ["空气炸锅 ×1", "保温杯 ×1"])]));
      const shared = await press(W, { label: "退款", near: "DD1002" });
      const twins = await press(W, { label: "退款", near: "空气炸锅" });
      const nthIn = await press(W, { label: "退款", near: "DD1002", nth: 1 });
      lg = await log();
      check("a text naming a card that holds two look-alikes: those two are listed as tokens, nothing sent", shared.isError && textOf(shared).includes('2 controls matching {"label":"退款"} sit in the card/section that says "DD1002"') && textOf(shared).includes('near "保温杯 ×1"') && !textOf(shared).includes("数据线"), textOf(shared));
      check("candidates that read the same say which card they are in", twins.isError && textOf(twins).includes('near "空气炸锅 ×1" (in "订单 DD1001 · 王建国")') && textOf(twins).includes('near "空气炸锅 ×1" (in "订单 DD1002 · 李秀英")'), textOf(twins));
      check("R8-5 …and nth does not reach into that list: near that matches no control is refused whatever nth says", nthIn.isError && textOf(nthIn).includes("sit in the card/section") && clicks(lg).length === 0, textOf(nthIn));
      const byToken = await call("act", { action: "click", ...W, element_token: /(s[0-9a-f]+:\d+) AXButton "退款" near "保温杯 ×1"/.exec(textOf(nthIn))?.[1], observe: false });
      lg = await log();
      check("…the listed token does it", !byToken.isError && clicks(lg).length === 1 && J(lg.actions[0]?.target.siblings) === J(["保温杯 ×1"]), textOf(byToken));

      // F11: exact label first, also with near.
      W = await win(796, page("用户", [[1, "AXTable", null, {}], ...["甲", "乙"].flatMap((id) => [[2, "AXRow", null, {}], St(3, id), B(3, "删除"), B(3, "删除并拉黑")])]));
      const exactNear = await press(W, { label: "删除", near: "乙" });
      lg = await log();
      check('F11 find {label:"删除", near:"乙"} with [删除并拉黑] beside it: the exact label wins', !exactNear.isError && lg.actions[0]?.target.label === "删除" && lg.actions[0]?.target.siblings.includes("乙"), textOf(exactNear));

      // U6-10: if_present with a near that matches nothing skips.
      const skip = await call("act_batch", { ...W, steps: [{ action: "click", find: { label: "删除", near: "丙" }, if_present: true }, { action: "click", find: { label: "删除", near: "甲" } }], observe: false });
      check("U6-10 if_present skips a find whose near matches no row", !skip.isError && textOf(skip).includes("step 1 click: skipped (if_present") && textOf(skip).includes("step 2 click: ok"), textOf(skip));

      // F2: a find that only names a control. Text that changed on its own between the model's look and the call is
      // not detected (neither is it for a token of the newest snapshot) — but the reply then says where the press landed.
      const dlg = (q) => page("草稿", [[1, "AXGroup", "列表", {}], St(2, "周报"), St(2, "月报"), [1, "AXGroup", "确认", {}], St(2, q), B(2, "取消"), B(2, "确定")]);
      W = await win(797, dlg("删除草稿「周报」？"));
      await call("window_state", { ...W, include_screenshot: false });
      await ctl("fake_set_window", { pid: P, window_id: 797, rows: dlg("清空全部草稿？此操作不可恢复") });
      await log();
      const drift = await press(W, { label: "确定" });
      lg = await log();
      check("F2 the page changed on its own before a find: pressed (by design), and the reply names what the control now follows", !drift.isError && clicks(lg).length === 1 && textOf(drift).includes('AXButton "确定" (after "确认 · 清空全部草稿？此操作不可恢复" in reading order)'), textOf(drift));
      // A native sheet that opened on its own since the last look: held once, with its words.
      const withSheet = (on) => page("文稿", [B(1, "确定"), St(1, "正文"), ...(on ? [[1, "AXSheet", "提示", {}], St(2, "登录已过期，放弃未保存的修改并退出？"), B(2, "确定")] : [])]);
      W = await win(798, withSheet(false));
      await call("window_state", { ...W, include_screenshot: false });
      await ctl("fake_set_window", { pid: P, window_id: 798, rows: withSheet(true) });
      await log();
      const sheetHeld = await press(W, { label: "确定", nth: 1 });
      const sheetLog = await log();
      const sheetAgain = await press(W, { label: "确定", nth: 1 });
      lg = await log();
      check(
        "H4 a sheet opened on its own, then find {label:确定}: held once with the sheet's words, nothing sent; the same step again goes through",
        sheetHeld.isError && textOf(sheetHeld).includes("a dialog/sheet is up in this window that you have not been shown: AXSheet (提示 / 登录已过期，放弃未保存的修改并退出？ / 确定)") && sheetLog.actions.length === 0 && !sheetAgain.isError && clicks(lg).length === 1,
        `${textOf(sheetHeld)} | ${textOf(sheetAgain)}`
      );
      // R8-6: a find that matched nothing walked the window but showed the model nothing — the sheet is still news.
      W = await win(818, withSheet(false));
      await call("window_state", { ...W, include_screenshot: false });
      await ctl("fake_set_window", { pid: P, window_id: 818, rows: withSheet(true) });
      const miss = await press(W, { label: "保存成功" });
      await log();
      const afterMiss = await press(W, { label: "确定", nth: 1 });
      lg = await log();
      check("R8-6 a failed find in between (nothing matches) does not use up the sheet's hold", miss.isError && afterMiss.isError && textOf(afterMiss).includes("that you have not been shown") && lg.actions.length === 0, `${textOf(miss).slice(0, 80)} | ${textOf(afterMiss)}`);
      const sheetB = (words) => page("导出", [St(1, "正文"), [1, "AXSheet", null, {}], St(2, words), B(2, "好")]);
      W = await win(819, sheetB("正在导出…"));
      await call("window_state", { ...W, include_screenshot: false });
      await ctl("fake_set_window", { pid: P, window_id: 819, rows: sheetB("导出失败。删除已导出的 3 个文件并放弃修改？") });
      await log();
      const replaced = await press(W, { label: "好" });
      lg = await log();
      check("R8-6 a sheet replaced by another one (same count, other words) is a sheet the model has not been shown", replaced.isError && textOf(replaced).includes("导出失败") && lg.actions.length === 0, textOf(replaced));
      const prog = (pct) => page("导出", [St(1, "正文"), [1, "AXSheet", null, {}], St(2, `正在导出 ${pct}%`), [2, "AXProgressIndicator", null, { v: String(pct / 100) }], B(2, "取消")]);
      W = await win(820, prog(12));
      await call("window_state", { ...W, include_screenshot: false });
      await ctl("fake_set_window", { pid: P, window_id: 820, rows: prog(57) });
      await log();
      const ticking = await press(W, { label: "取消" });
      check("…a progress count ticking in a sheet the model has seen is not a new sheet", !ticking.isError, textOf(ticking));
      // …but not when it follows the model's own unobserved action of a moment ago (click 删除, then find 确认).
      W = await win(810, withSheet(false));
      await call("window_state", { ...W, include_screenshot: false });
      await ctl("fake_after_action", { pid: P, window_id: 810, rows: withSheet(true) });
      const ownFirst = await call("act", { action: "click", ...W, find: { label: "确定" }, observe: false });
      await log();
      const own = await press(W, { label: "确定", nth: 1 });
      lg = await log();
      check("H4 …no hold when the sheet follows the model's own action of a moment ago (observe:false)", !ownFirst.isError && !own.isError && clicks(lg).length === 1, `${textOf(ownFirst)} | ${textOf(own)}`);
      // H6: a query look that could not list the news leaves the model behind — a find is then held once, a later query does not clear it.
      const big = (v) => page("大表", [B(1, "提交"), ...Array.from({ length: 40 }, (_, k) => St(1, `行${k} ${v} 一段足够长的文字用来撑开变化清单`))]);
      W = await win(811, big("旧"));
      await call("window_state", { ...W, include_screenshot: false });
      await ctl("fake_set_window", { pid: P, window_id: 811, rows: big("新") });
      const qNews = textOf(await call("window_state", { ...W, query: "行3 ", include_screenshot: false }));
      await call("window_state", { ...W, query: "行5 ", include_screenshot: false });
      await log();
      const behind = await press(W, { label: "提交" });
      const behindLog = await log();
      const behind2 = await press(W, { label: "提交" });
      lg = await log();
      check("H6 after a query look with more news than fits, a find that only names a control is held once (a second query does not clear it)", /changed since what you had been shown|most of the window differs/.test(qNews) && behind.isError && textOf(behind).includes("has changed by more than you were shown") && behindLog.actions.length === 0 && !behind2.isError && clicks(lg).length === 1, `${qNews.slice(-160)} | ${textOf(behind)}`);

      // F5: a long value changes in two places; the list shows the first and must not count as complete.
      const memo = (time, who) => page("转账", [B(1, "刷新"), [1, "AXTextArea", "转账摘要", { v: `时间 ${time}。${"条款".repeat(280)}。收款人：${who}，金额 ¥100.00` }], B(1, "确认付款")]);
      W = await win(799, memo("15:02:11", "张三"));
      const m1 = textOf(await call("window_state", { ...W, include_screenshot: false }));
      await ctl("fake_after_action", { pid: P, window_id: 799, rows: memo("15:02:45", "李四") });
      const refresh = textOf(await call("act", { action: "click", ...W, element_token: `${sidOf(m1)}:${rowOf(m1, "AXButton", "刷新")}` }));
      await log();
      const pay = await call("act", { action: "click", ...W, element_token: `${sidOf(m1)}:${rowOf(m1, "AXButton", "确认付款")}`, observe: false });
      lg = await log();
      check("F5 a second difference beyond what the change line prints: the list says it is incomplete", !refresh.includes("李四") && refresh.includes("not every change is listed above"), refresh.slice(-220));
      check("F5 …and the old token of the unique button is refused, nothing sent", pay.isError && textOf(pay).includes("by more than fits here") && lg.calls.length === 0, textOf(pay));

      // F7: a menu bar inside web content is page content.
      const web = page("后台", [[1, "AXMenuBar", null, {}], [2, "AXMenuBarItem", "文件", { press: true }], [3, "AXMenuItem", "打印…", { press: true }], [1, "AXToolbar", null, {}], [1, "AXWebArea", "后台", { web: true }], [2, "AXMenuBar", null, {}], [3, "AXMenuItem", "订单管理", { press: true }], [3, "AXMenuItem", "打印…", { press: true }], St(2, "欢迎")]);
      W = await win(800, web);
      const wv = textOf(await call("window_state", { ...W, include_screenshot: false }));
      const inPage = await press(W, { label: "订单管理" });
      lg = await log();
      check("F7 a role=menubar inside the page is shown and found like any row; the app's own menu bar stays hidden", wv.includes('AXMenuItem "订单管理"') && /menu bar hidden: 3 rows/.test(wv) && !inPage.isError && clicks(lg).length === 1 && lg.actions[0].target.label === "订单管理", `${wv}\n${textOf(inPage)}`);

      // F8: only the application menu changed (Undo became "Undo Refresh") — a repeated control's token keeps its place.
      const menuRows = (undo) => [[1, "AXMenuBar", null, {}], [2, "AXMenuBarItem", "编辑", { press: true }], [3, "AXMenuItem", undo, { press: true }]];
      const three = (undo) => page("任务", [...menuRows(undo), [1, "AXTable", null, {}], ...["甲", "乙", "丙"].flatMap((n) => [[2, "AXRow", null, {}], St(3, n), B(3, "删除")]), B(1, "刷新")]);
      W = await win(801, three("撤销"));
      const t8 = textOf(await call("window_state", { ...W, include_screenshot: false }));
      const dels = [...t8.matchAll(/\[(\d+)\] AXButton "删除"/g)].map((m) => Number(m[1]));
      await ctl("fake_after_action", { pid: P, window_id: 801, rows: three("撤销 刷新") });
      await call("act", { action: "click", ...W, element_token: `${sidOf(t8)}:${rowOf(t8, "AXButton", "刷新")}` });
      await log();
      const second = await call("act", { action: "click", ...W, element_token: `${sidOf(t8)}:${dels[1]}`, observe: false });
      lg = await log();
      check("F8 only the menu bar changed: the old token of a repeated control is carried by position", !second.isError && clicks(lg).length === 1 && J(lg.actions[0].target.siblings) === J(["乙"]), textOf(second));

      // F9 / U6-6: every token a reply prints is usable.
      W = await win(802, page("列表", [St(1, "第 1 页"), B(1, "下一页")]));
      const viaFind = textOf(await press(W, { label: "下一页" }));
      const printed = /find → (s[0-9a-f]+:\d+) AXButton/.exec(viaFind)?.[1];
      const reuse = await call("act", { action: "click", ...W, element_token: printed, observe: false });
      const carried = /token \S+ → (s[0-9a-f]+:\d+) AXButton/.exec(textOf(reuse))?.[1] ?? printed;
      const reuse2 = await call("act", { action: "click", ...W, element_token: carried, observe: false });
      check("F9 the token printed after find →, and the one printed after token … →, are accepted when sent back", !!printed && !reuse.isError && !reuse2.isError, `${viaFind} | ${textOf(reuse)} | ${textOf(reuse2)}`);

      // U6-7: a token names its window — the reply reports on it even without window_id.
      W = await win(803, FORM());
      const t7 = textOf(await call("window_state", { ...W, include_screenshot: false }));
      await ctl("fake_after_action", { pid: P, window_id: 803, rows: FORM({ name: "已填" }) });
      const noWin = textOf(await call("act", { action: "click", pid: P, element_token: `${sidOf(t7)}:${rowOf(t7, "AXButton", "保存")}` }));
      check("U6-7 act with a token and no window_id still reports what changed in that window", noWin.includes('value "" → "已填"'), noWin);

      // U6-2: a file name in a native dialog is not a page address.
      const exp = (name) => page("导出", [St(1, "文件名"), [1, "AXTextField", "文件名", { v: name, press: true }], B(1, "导出")]);
      W = await win(804, exp("report.xlsx"));
      const t2 = textOf(await call("window_state", { ...W, include_screenshot: false }));
      await ctl("fake_after_action", { pid: P, window_id: 804, rows: exp("report-2026.xlsx") });
      await call("act", { action: "set_value", ...W, element_token: `${sidOf(t2)}:${rowOf(t2, "AXTextField", "文件名")}`, value: "report-2026.xlsx" });
      await log();
      const go = await call("act", { action: "click", ...W, element_token: `${sidOf(t2)}:${rowOf(t2, "AXButton", "导出")}`, observe: false });
      lg = await log();
      check("U6-2 editing a file-name field does not void the window's tokens", !go.isError && clicks(lg).length === 1 && lg.actions[0].target.label === "导出", textOf(go));

      // U6-4: the re-press gate is about the same control and the same request.
      const tools = page("画板", [[1, "AXToolbar", null, {}], B(2, null, { help: "加粗" }), B(2, null, { help: "斜体" })]);
      W = await win(805, tools);
      const tv = textOf(await call("window_state", { ...W, include_screenshot: false }));
      const icon = (h) => `${sidOf(tv)}:${new RegExp(`\\[(\\d+)\\] AXButton help="${h}"`).exec(tv)[1]}`;
      const b1 = await call("act", { action: "click", ...W, element_token: icon("加粗") });
      const b2 = await call("act", { action: "click", ...W, element_token: icon("斜体") });
      const b3 = await call("act", { action: "click", ...W, element_token: icon("斜体") });
      check("U6-4 pressing a different unlabeled icon after a press that changed nothing is not 'the same control'; pressing the same one again is", !b1.isError && !b2.isError && b3.isError && textOf(b3).includes("you pressed this same control"), `${textOf(b2).split("\n")[0]} | ${textOf(b3).slice(0, 90)}`);

      // B8: a step-level null does not blank a batch-level value.
      W = await win(806, FORM());
      await log();
      const nul = await call("act_batch", { ...W, observe: false, steps: [{ action: "key", key: "tab", window_id: null, delivery_mode: null }] });
      lg = await log();
      check("B8 a null in a step leaves the batch's window_id in force (same merge order as the guard)", !nul.isError && lg.calls.length === 1 && lg.calls[0].args.window_id === 806, J(lg.calls.map((c) => c.args)));

      // U6-13: null = not given, everywhere.
      const qn = textOf(await call("window_state", { ...W, query: null, include_screenshot: false }));
      const on = await call("act", { action: "key", key: "tab", ...W, observe: null });
      check("U6-13 query:null and observe:null mean 'not given'", qn.includes("· 10 rows") && !qn.includes('match "null"') && !on.isError, `${qn.split("\n")[0]} | ${textOf(on).split("\n")[0]}`);

      // desk_call with an element token: an unknown snapshot and a menu-bar row are not sent.
      const mw = await win(807, three("撤销"));
      const mt = textOf(await call("window_state", { ...mw, menus: true, include_screenshot: false }));
      await log();
      const dcMenu = await call("desk_call", { server: "cua", tool: "click", args: { pid: P, window_id: 807, element_token: `${sidOf(mt)}:${rowOf(mt, "AXMenuItem", "撤销")}` } });
      const dcUnknown = await call("desk_call", { server: "cua", tool: "click", args: { pid: P, window_id: 807, element_token: "s0000beef:3" } });
      lg = await log();
      check("desk_call click with a token of a menu-bar item, or of a snapshot this hub never saw: refused, nothing sent", dcMenu.isError && textOf(dcMenu).includes("menu-bar item") && dcUnknown.isError && textOf(dcUnknown).includes("was not minted through this hub") && lg.calls.length === 0, `${textOf(dcMenu)} | ${textOf(dcUnknown)}`);

      // Two cua 0.28 limits met in the head-to-head run: say what they are instead of letting the model try five other routes.
      const amt = page("订单", [[1, "AXWebArea", "订单", { web: true }], St(2, "金额"), [2, "AXTextField", "金额", { v: "128.00", press: true }], B(2, "保存")]);
      W = await win(809, amt);
      await ctl("fake_next_reply", { error: "Background input refused (same_pid_keyboard_ambiguity): pid 4242 owns 1 other eligible top-level window(s); process-scoped key events cannot be proven to reach window 809" });
      const keyRef = await call("act", { action: "type", ...W, find: { label: "金额", role: "AXTextField" }, text: "888", observe: false });
      check("a keystroke refused because the app has a second window: the reply says why, what still works, and to stop", keyRef.isError && textOf(keyRef).includes("FAILED (not executed)") && textOf(keyRef).includes("cua cannot aim background keystrokes") && textOf(keyRef).includes("needs the user"), textOf(keyRef));
      const numSet = await call("act", { action: "set_value", ...W, find: { label: "金额", role: "AXTextField" }, value: "888", observe: false });
      const txtSet = await call("act", { action: "set_value", ...W, find: { label: "金额", role: "AXTextField" }, value: "888 元", observe: false });
      check("set_value of a purely numeric text into a web field carries a warning; other text does not", !numSet.isError && textOf(numSet).includes("usually leaves a web input EMPTY") && !txtSet.isError && !textOf(txtSet).includes("EMPTY"), `${textOf(numSet)} | ${textOf(txtSet)}`);

      // U6-11 / R7-11: the snapshots kept for a window are bounded by rows as well as by count — but the view the
      // model took its tokens from is the last to go.
      const bigRows = page("大表", Array.from({ length: 6000 }, (_, k) => St(1, `行${k}`)).concat([B(1, "刷新"), B(1, "导出")]));
      W = await win(808, bigRows);
      const first = textOf(await call("window_state", { ...W, query: "刷新|导出", include_screenshot: false }));
      const walk2 = textOf(await call("window_state", { ...W, query: "刷新", include_screenshot: false }));
      for (let k = 0; k < 9; k++) await call("window_state", { ...W, query: "刷新", include_screenshot: false });
      const midTok = await call("act", { action: "click", ...W, element_token: `${sidOf(walk2)}:${rowOf(walk2, "AXButton", "刷新")}`, observe: false });
      const mainTok = await call("act", { action: "click", ...W, element_token: `${sidOf(first)}:${rowOf(first, "AXButton", "导出")}`, observe: false });
      check("U6-11 eleven walks of a 6,000-row window: in-between snapshots are dropped (their tokens say 'too old') instead of piling up", midTok.isError && textOf(midTok).includes("is not one this hub showed you") && textOf(midTok).includes("fewer on a very large one"), textOf(midTok).slice(0, 200));
      check("R7-11 …while the view with the most rows shown — the one the model works from — keeps its tokens", !mainTok.isError, textOf(mainTok).slice(0, 200));

      W = await win(821, bigRows);
      await call("window_state", { ...W, max_elements: 50, include_screenshot: false });
      const qv = textOf(await call("window_state", { ...W, query: "导出", include_screenshot: false }));
      let lastUse = null;
      for (let k = 0; k < 8; k++) lastUse = await call("act", { action: "click", ...W, element_token: `${sidOf(qv)}:${rowOf(qv, "AXButton", "导出")}`, again: true });
      check("R7-11 a query view whose token is used again and again on a 6,000-row window stays valid (in use = kept)", !lastUse.isError, textOf(lastUse).slice(0, 160));

      // R8-8: after a wholesale change on a large page (the report is an outline), a find for a control whose surroundings are as the model last saw them is not held.
      const tabs = (cur) => page("后台", [[1, "AXGroup", "标签", {}], ...["订单", "商品", "用户"].map((t) => B(2, t)), [1, "AXGroup", "内容", {}], ...Array.from({ length: 220 }, (_, k) => St(2, `${cur} 第 ${k} 行，一段足够长的说明文字`)), B(2, `新建${cur}`)]);
      W = await win(822, tabs("订单"));
      await call("window_state", { ...W, include_screenshot: false });
      await ctl("fake_after_action", { pid: P, window_id: 822, rows: tabs("商品") });
      const tab1 = await call("act", { action: "click", ...W, find: { label: "商品" } });
      await ctl("fake_after_action", { pid: P, window_id: 822, rows: tabs("用户") });
      await log();
      const tab2 = await call("act", { action: "click", ...W, find: { label: "用户" } });
      const fresh = await call("act", { action: "click", ...W, find: { label: "新建用户" }, observe: false });
      lg = await log();
      check("R8-8 tab bar on a large page: the next tab is pressed without a hold although the last report was an outline", !tab1.isError && textOf(tab1).includes("more than half of the window changed") && !tab2.isError, `${textOf(tab1).slice(0, 200)} | ${textOf(tab2).slice(0, 160)}`);
      check("…while a control that was not there in the model's last full view is held once, with where it sits", fresh.isError && textOf(fresh).includes("not as you last saw it") && clicks(lg).length === 1, textOf(fresh));

      // R7-12: nulls inside find are 'not given'; a window's title is not a control of that name.
      W = await win(812, page("设置", [B(1, "高级设置"), B(1, "网络设置"), B(1, "刷新")]));
      await log();
      const fnull = await press(W, { label: "刷新", near: null, nth: null, role: null, value: null });
      const ftitle = await press(W, { label: "设置", nth: 0 });
      lg = await log();
      check("R7-12 find {label, near:null, nth:null, role:null}: nulls are dropped; {label:设置, nth:0} is the first BUTTON so named, not the window titled 设置", !fnull.isError && !ftitle.isError && J(lg.actions.map((a) => a.target.label)) === J(["刷新", "高级设置"]), `${textOf(fnull)} | ${textOf(ftitle)}`);

      // R7-8: a walk made through desk_call mints tokens the hub then checks against THAT walk — a menu-bar row stays refused.
      const mw2 = await win(813, three("撤销"));
      const raw = await call("desk_call", { server: "cua", tool: "get_window_state", args: { pid: P, window_id: 813 } });
      const rawSc = raw.structuredContent ?? JSON.parse(textOf(raw));
      const undo = rawSc.elements.find((e) => e.role === "AXMenuItem");
      const plainBtn = rawSc.elements.find((e) => e.role === "AXButton" && e.label === "刷新");
      await log();
      const viaDesk = await call("desk_call", { server: "cua", tool: "click", args: { pid: P, window_id: 813, element_token: `${rawSc.snapshot_id}:${undo.element_index}` } });
      const viaDeskOk = await call("desk_call", { server: "cua", tool: "click", args: { pid: P, window_id: 813, element_token: `${rawSc.snapshot_id}:${plainBtn.element_index}`, snapshot_id: null } });
      lg = await log();
      check("R7-8 desk_call walk + desk_call click on a menu-bar row of that walk: refused; an ordinary row of it goes through (a null snapshot_id beside the token is 'not given')", viaDesk.isError && textOf(viaDesk).includes("menu-bar item") && !viaDeskOk.isError && lg.actions.length === 1 && lg.actions[0].target.label === "刷新", `${textOf(viaDesk)} | ${textOf(viaDeskOk).slice(0, 120)}`);

      const dcStr = await call("desk_call", { server: "cua", tool: "click", args: { pid: P, window_id: 813, snapshot_id: rawSc.snapshot_id, element_index: String(undo.element_index) } });
      const dcMix = await call("desk_call", { server: "cua", tool: "click", args: { pid: P, window_id: 813, element_token: `${rawSc.snapshot_id}:${plainBtn.element_index}`, element_index: undo.element_index } });
      lg = await log();
      check("desk_call: element_index as a string, or a token beside a different element_index: refused, nothing sent", dcStr.isError && textOf(dcStr).includes("must be an integer") && dcMix.isError && textOf(dcMix).includes("name different elements") && lg.actions.length === 0, `${textOf(dcStr)} | ${textOf(dcMix)}`);

      // R7-9: an unlabeled row whose tooltip AND long value change; a long text that arrives as a new row.
      const memo2 = (tip, who, wrap) => page("转账", [B(1, "刷新"), ...(wrap ? [[1, "AXGroup", null, {}]] : []), [wrap ? 2 : 1, "AXTextArea", null, { help: tip, v: `${"条款".repeat(290)}。收款人：${who}` }], B(1, "确认付款")]);
      for (const [name, after] of [["tooltip + value tail", memo2("15:03 更新", "李四", false)], ["re-rendered inside a new container", memo2("15:02 更新", "李四", true)]]) {
        W = await win(name.startsWith("tooltip") ? 814 : 815, memo2("15:02 更新", "张三", false));
        const m0 = textOf(await call("window_state", { ...W, include_screenshot: false }));
        await ctl("fake_after_action", { pid: P, window_id: W.window_id, rows: after });
        const rpt = textOf(await call("act", { action: "click", ...W, element_token: `${sidOf(m0)}:${rowOf(m0, "AXButton", "刷新")}` }));
        await log();
        const pay2 = await call("act", { action: "click", ...W, element_token: `${sidOf(m0)}:${rowOf(m0, "AXButton", "确认付款")}`, observe: false });
        lg = await log();
        check(`R7-9 ${name}: the list does not show the new payee, says it is incomplete, and the old token is refused`, !rpt.includes("李四") && rpt.includes("not every change is listed above") && pay2.isError && lg.calls.length === 0, `${rpt.slice(-200)} | ${textOf(pay2).slice(0, 120)}`);
      }

      // R4-6: foreground input goes to the real screen — the window must be the pid's own and a point must lie inside it.
      if (!existsSync("/var/db/desktop-hub")) {
        W = await win(816, FORM());
        await ctl("fake_windows", { windows: [{ window_id: 816, pid: P, app_name: "样例应用", title: "样例窗", bounds: { x: 100, y: 100, width: 800, height: 600 }, is_on_screen: true, layer: 0, z_index: 9 }, { window_id: 817, pid: 5151, app_name: "别的应用", title: "别的窗", bounds: { x: 0, y: 0, width: 800, height: 600 }, is_on_screen: true, layer: 0, z_index: 8 }] });
        await log();
        const fgBlind = await call("act", { action: "click", ...W, x: 300, y: 200, delivery_mode: "foreground", observe: false });
        await call("window_state", { ...W, tree: false });
        const fgOther = await call("act", { action: "click", pid: P, window_id: 817, x: 50, y: 50, delivery_mode: "foreground", observe: false });
        const fgOut = await call("act", { action: "click", ...W, x: 1700, y: 90, delivery_mode: "foreground", observe: false });
        const fgDragOut = await call("act", { action: "drag", ...W, x: 10, y: 10, to_x: 10, to_y: 5000, delivery_mode: "foreground", observe: false });
        const fgZoom = await call("act", { action: "click", ...W, x: 19999, y: 19999, from_zoom: true, delivery_mode: "foreground", observe: false });
        const fgKeyNoWin = await call("act", { action: "key", pid: P, key: "tab", delivery_mode: "foreground", observe: false });
        const dcOther = await call("desk_call", { server: "cua", tool: "click", args: { pid: P, window_id: 817, x: 50, y: 50, delivery_mode: "foreground" } });
        const dcOut = await call("desk_call", { server: "cua", tool: "click", args: { ...W, x: 99999, y: 99999, delivery_mode: "foreground" } });
        const dcType = await call("desk_call", { server: "cua", tool: "type_text", args: { pid: P, window_id: 817, text: "x", delivery_mode: "foreground" } });
        lg = await log();
        check(
          "R4-6 / R5-1 / R8-9 foreground through act: no screenshot yet, another process's window, a point outside, a drag ending outside, from_zoom, no window_id — all refused, nothing sent",
          fgBlind.isError && textOf(fgBlind).includes("has not seen a screenshot") && fgOther.isError && textOf(fgOther).includes("belongs to pid 5151") && fgOut.isError && textOf(fgOut).includes("lies outside window 816") && fgDragOut.isError && fgZoom.isError && textOf(fgZoom).includes("from_zoom") && fgKeyNoWin.isError && lg.actions.length === 0,
          `${textOf(fgBlind)} | ${textOf(fgOther)} | ${textOf(fgOut)} | ${textOf(fgDragOut)} | ${textOf(fgZoom)} | ${textOf(fgKeyNoWin)}`
        );
        check("R5-2 / R8-9 the same through desk_call (click on another process's window, a point outside, typing into another process's window): refused, nothing sent", dcOther.isError && textOf(dcOther).includes("belongs to pid 5151") && dcOut.isError && textOf(dcOut).includes("lies outside window 816") && dcType.isError && lg.actions.length === 0, `${textOf(dcOther)} | ${textOf(dcOut)} | ${textOf(dcType)}`);
        const fgIn = await call("act", { action: "click", ...W, x: 300, y: 200, delivery_mode: "foreground", observe: false });
        const dcIn = await call("desk_call", { server: "cua", tool: "click", args: { ...W, x: 300, y: 200, delivery_mode: "foreground" } });
        lg = await log();
        check("…a point inside the pid's own window goes through, by act and by desk_call", !fgIn.isError && !dcIn.isError && lg.actions.length === 2 && lg.actions.every((a) => a.args.x === 300), `${textOf(fgIn)} | ${textOf(dcIn).slice(0, 100)}`);
      } else console.log("skip foreground checks (a foreground switch directory exists on this machine)");
    });

    // 7.6j review round 9: what a find may settle by itself, what counts as "shown", holds that end ---------------
    await section("7.6j round 9", async () => {
      const St = (d, t, o = {}) => [d, "AXStaticText", t, { a: [], ...o }];
      const B = (d, t, o = {}) => [d, "AXButton", t, { press: true, ...o }];
      const Bd = (d, t, o = {}) => [d, "AXButton", t, { a: [], en: false, ...o }];
      const Lk = (d, t, o = {}) => [d, "AXLink", t, { press: true, ...o }];
      const F = (x, y, w = 80, h = 24) => ({ f: [x, y, w, h] });
      const page = (title, rows) => [[0, "AXWindow", title, { a: ["AXRaise"] }], ...rows];
      const web = (rows) => [[1, "AXWebArea", "页", { web: true }], ...rows];
      const press = (W, find, extra = {}) => call("act", { action: "click", ...W, find, observe: false, ...extra });
      const hits = (lg) => lg.actions.map((a) => `${a.tool} ${a.target?.role} ${a.target?.label}`);
      const reset = (W, rows) => ctl("fake_set_window", { pid: P, window_id: W.window_id, rows });

      // R9-1: a label that matches a text and a button of another name does not let the press choose.
      const rows1 = ["DD1003", "DD1005"].flatMap((id, k) => [St(2, `订单 ${id}`, F(20, 100 + 30 * k, 120)), St(2, "张伟", F(200, 100 + 30 * k)), B(2, `删除 ${id}`, F(600, 100 + 30 * k, 24))]);
      let W = await win(831, page("订单", web(rows1)));
      const r1 = await press(W, { label: "DD1005" });
      let lg = await log();
      check('R9-1 find {label:"DD1005"} matches the text 订单 DD1005 and the button 删除 DD1005 — two things: refused with both listed, nothing pressed', r1.isError && textOf(r1).includes("2 controls match") && textOf(r1).includes('AXStaticText "订单 DD1005"') && textOf(r1).includes('AXButton "删除 DD1005"') && lg.actions.length === 0, textOf(r1));

      // R9-2: a value goes into the field, a click to the button, when both carry the name.
      W = await win(832, page("订单", web([[2, "AXTextField", "搜索", { v: "", a: ["AXConfirm"], ...F(20, 60, 200) }], B(2, "搜索", F(240, 60)), St(2, "订单 DD1005", F(20, 100))])));
      const r2 = await call("act", { action: "set_value", ...W, find: { label: "搜索" }, value: "DD1005", observe: false });
      const r2b = await press(W, { label: "搜索" });
      lg = await log();
      check("R9-2 a field and a button both named 搜索: set_value goes to the field, click to the button", !r2.isError && !r2b.isError && J(hits(lg)) === J(["set_value AXTextField 搜索", "click AXButton 搜索"]), `${textOf(r2)} | ${textOf(r2b)} | ${J(hits(lg))}`);

      // R9-3: a row that is one big link, with a 删除 button inside.
      const rows3 = ["DD1003", "DD1005"].flatMap((id, k) => [Lk(2, `${id} 空气炸锅 删除`, F(20, 100 + 30 * k, 700)), St(3, id, F(20, 100 + 30 * k)), St(3, "空气炸锅", F(200, 100 + 30 * k)), B(3, "删除", F(600, 100 + 30 * k))]);
      W = await win(833, page("订单", web(rows3)));
      const r3 = await press(W, { label: "删除", near: "DD1005" });
      lg = await log();
      check("R9-3 the 删除 button inside a row that is itself a link (labelled 'DD1005 空气炸锅 删除') is found and pressed, in the right row", !r3.isError && J(hits(lg)) === J(["click AXButton 删除"]) && lg.actions[0].target.siblings.includes("DD1005"), `${textOf(r3)} | ${J(lg.actions.map((a) => a.target))}`);

      // R9-4: two look-alikes on one line, uneven text between them.
      W = await win(834, page("资料", web([St(2, "昵称", F(20, 100)), B(2, "编辑", F(120, 100)), St(2, "待审核", F(220, 100)), St(2, "签名", F(520, 100)), B(2, "编辑", F(620, 100))])));
      const r4 = await press(W, { label: "编辑", near: "待审核" });
      const r4b = await press(W, { label: "编辑", near: "昵称" });
      lg = await log();
      check("R9-4 '昵称 [编辑] 待审核 签名 [编辑]': near 待审核 is refused with both listed and where each comes in reading order; near 昵称 (before the first) presses the first", r4.isError && textOf(r4).includes("2 controls match") && textOf(r4).includes('(after "昵称" in reading order)') && !r4b.isError && lg.actions.length === 1 && lg.actions[0].target.idx === 3, `${textOf(r4)} | ${textOf(r4b)}`);

      // R9-5: a same-named row the action cannot use is still a look-alike.
      W = await win(835, page("成员", web([St(2, "张伟", F(20, 100)), Bd(2, "移除", F(120, 100)), St(2, "李四", F(420, 100)), B(2, "移除", F(520, 100)), St(2, "王五", F(20, 140)), B(2, "移除", F(120, 140))])));
      const r5 = await press(W, { label: "移除", near: "张伟" });
      const r5b = await press(W, { label: "移除", near: "李四" });
      const r5c = await press(W, { label: "移除", near: "王五" });
      lg = await log();
      check(
        "R9-5 '张伟 [移除 disabled] 李四 [移除]': near 张伟 is refused and the reply says it is next to the one that cannot be pressed; near 李四 (between the two) is refused as well; a row of its own still works",
        r5.isError && textOf(r5).includes("It IS next to") && textOf(r5).includes("(not pressable)") && r5b.isError && textOf(r5b).includes("does not say which") && !r5c.isError && lg.actions.length === 1 && lg.actions[0].target.siblings.includes("王五"),
        `${textOf(r5)} | ${textOf(r5b)} | ${textOf(r5c)}`
      );
      W = await win(836, page("表单", web([St(2, "收货人", F(20, 100)), St(2, "姓名", F(120, 100)), [2, "AXTextField", "姓名", { v: "", a: ["AXConfirm"], ...F(220, 100, 200) }], St(2, "发票", F(20, 140)), St(2, "姓名", F(120, 140)), [2, "AXTextField", "姓名", { v: "", a: ["AXConfirm"], ...F(220, 140, 200) }]])));
      const r5d = await call("act", { action: "set_value", ...W, find: { label: "姓名", near: "发票" }, value: "王建国", observe: false });
      lg = await log();
      check("…while the static 姓名 right beside its field 姓名 is no rival: set_value {label:姓名, near:发票} fills that row's field", !r5d.isError && lg.actions.length === 1 && lg.actions[0].target.role === "AXTextField" && lg.actions[0].target.idx === 7, `${textOf(r5d)} | ${J(lg.actions.map((a) => a.target))}`);

      // R9-7: what a picture, and a sheet's bare line, do and do not vouch for.
      const editor = [[1, "AXTextArea", "正文", { v: "草稿" }], B(1, "保存"), B(1, "关闭")];
      const sheet = (q, btns = ["取消", "确定"]) => [[1, "AXSheet", null, {}], St(2, q), ...btns.map((b) => B(2, b))];
      const EXPIRED = "登录已过期，放弃未保存的修改并退出？";
      W = await win(837, page("编辑器", editor));
      await call("window_state", { ...W, include_screenshot: false });
      await call("window_state", { ...W, tree: false });
      await reset(W, page("编辑器", [...editor, ...sheet(EXPIRED)]));
      await log();
      const s1 = await press(W, { label: "确定" });
      lg = await log();
      const s1again = await press(W, { label: "确定" });
      const lg2 = await log();
      check("R9-7 a screenshot-only look, then a sheet opens by itself: find 确定 is held with the sheet's words (a picture does not vouch for what came after it); the same step again goes through", s1.isError && textOf(s1).includes("have not been shown") && textOf(s1).includes("登录已过期") && lg.actions.length === 0 && !s1again.isError && lg2.actions.length === 1, `${textOf(s1)} | ${textOf(s1again)}`);
      W = await win(838, page("编辑器", editor));
      await call("window_state", { ...W, include_screenshot: false });
      await reset(W, page("编辑器", [...editor, ...sheet(EXPIRED)]));
      const shallow = textOf(await call("window_state", { ...W, include_screenshot: false, max_depth: 1 }));
      await log();
      const s4 = await press(W, { label: "确定" });
      lg = await log();
      check("R9-7 window_state max_depth:1 prints the AXSheet line and nothing inside it: that is not having been shown the sheet — find 确定 is held", shallow.includes("AXSheet") && !shallow.includes("登录已过期") && s4.isError && textOf(s4).includes("登录已过期") && lg.actions.length === 0, `${shallow.slice(0, 300)} | ${textOf(s4)}`);
      W = await win(839, page("编辑器", editor));
      await call("window_state", { ...W, include_screenshot: false });
      await reset(W, page("编辑器", [...editor, ...sheet(EXPIRED)]));
      await call("window_state", { ...W, include_screenshot: false, max_depth: 1 }); // the hub's walk has the sheet
      await call("window_state", { ...W, tree: false }); // …and then the model is sent a picture
      await log();
      const s5 = await press(W, { label: "确定" });
      lg = await log();
      check("…while a sheet the hub's last walk already had when the picture was taken counts as seen", !s5.isError && lg.actions.length === 1, textOf(s5));

      // A sheet is "shown" when a reply printed what it says — not when a query happened to match one of its buttons.
      W = await win(851, page("编辑器", [...editor, ...sheet(EXPIRED)]));
      const qBtn = textOf(await call("window_state", { ...W, include_screenshot: false, query: "确定" }));
      await log();
      const t1 = await press(W, { label: "确定" });
      lg = await log();
      check("a query that matched only the sheet's 确定 button did not show what the sheet asks: find 确定 is held with its words", !qBtn.includes("登录已过期") && t1.isError && textOf(t1).includes("登录已过期") && lg.actions.length === 0, `${qBtn} | ${textOf(t1)}`);
      W = await win(852, page("编辑器", [...editor, ...sheet(EXPIRED)]));
      const qMsg = textOf(await call("window_state", { ...W, include_screenshot: false, query: "登录已过期|确定" }));
      await log();
      const t2 = await press(W, { label: "确定" });
      lg = await log();
      check("…a query that printed its text as well did: not held", qMsg.includes("登录已过期") && !t2.isError && lg.actions.length === 1, `${qMsg} | ${textOf(t2)}`);

      // The free pass of a held step ends with the next look or action on the window.
      W = await win(853, page("编辑器", editor));
      await call("window_state", { ...W, include_screenshot: false });
      await reset(W, page("编辑器", [...editor, ...sheet("要保存对「报价单」的修改吗？")]));
      const h1 = await press(W, { label: "确定" }); // held: names the first sheet
      await call("window_state", { ...W, include_screenshot: false, query: "保存" }); // the model looks
      await reset(W, page("编辑器", [...editor, ...sheet("确定删除全部 1,204 位客户？")]));
      await log();
      const h2 = await press(W, { label: "确定" });
      lg = await log();
      check("held once for a sheet, the model looks, another sheet replaces it: the same find is held again (the pass did not outlive the look)", h1.isError && h2.isError && textOf(h2).includes("1,204") && lg.actions.length === 0, `${textOf(h1).slice(0, 160)} | ${textOf(h2)}`);

      // R9-8: a sheet is the sheet it says it is — every word of it; only progress counts are folded.
      const pay = (acct, amt) => sheet(`确认向尾号 ${acct} 的账户转账 ¥${amt}？`, ["取消", "确认转账"]);
      W = await win(840, page("编辑器", [...editor, ...pay("1234", "100.00")]));
      await call("window_state", { ...W, include_screenshot: false });
      await reset(W, page("编辑器", [...editor, ...pay("9876", "90000.00")]));
      await log();
      const g1 = await press(W, { label: "确认转账" });
      lg = await log();
      check("R9-8 the sheet shown said 尾号 1234 ¥100.00; the one up now says 尾号 9876 ¥90000.00: another sheet, held", g1.isError && textOf(g1).includes("9876") && lg.actions.length === 0, textOf(g1));
      const long = "您即将执行一项不可恢复的操作，系统会在确认后立即执行并且无法撤回，请确认是否继续";
      W = await win(841, page("编辑器", [...editor, ...sheet(`${long}：清空回收站`, ["取消", "删除"])]));
      await call("window_state", { ...W, include_screenshot: false });
      await reset(W, page("编辑器", [...editor, ...sheet(`${long}：删除全部客户`, ["取消", "删除"])]));
      await log();
      const g3 = await press(W, { label: "删除" });
      lg = await log();
      check("R9-8 two sheets whose first forty characters are the same and whose ends differ: held", g3.isError && textOf(g3).includes("have not been shown") && lg.actions.length === 0, textOf(g3));
      const prog = (t, bar) => [[1, "AXSheet", null, {}], St(2, t), ...(bar === undefined ? [] : [[2, "AXProgressIndicator", null, { v: String(bar) }]]), B(2, "停止"), B(2, "后台运行")];
      W = await win(842, page("拷贝", [...editor, ...prog("正在拷贝 1/8 · 12% · 剩余 00:45 · 约 45 秒", 0.12)]));
      await call("window_state", { ...W, include_screenshot: false });
      await reset(W, page("拷贝", [...editor, ...prog("正在拷贝 2/8 · 25% · 剩余 00:31 · 约 31 秒", 0.25)]));
      await log();
      const g4 = await press(W, { label: "后台运行" });
      lg = await log();
      check("…while in a sheet with a progress bar, counts that tick on (1/8 → 2/8, 12% → 25%, 00:45 → 00:31, 45 秒 → 31 秒, the bar's own value) are the same sheet: not held", !g4.isError && lg.actions.length === 1, textOf(g4));
      // H10-5: without a progress bar those are dates, times and percentages — what the sheet asks about.
      const ask = (t) => sheet(t, ["取消", "确定"]);
      const folded = [];
      for (const [a, b] of [["把会议改到 11/21 15:00？", "把会议改到 12/30 08:00？"], ["应用 5% 折扣？", "应用 95% 折扣？"], ["禁言 10 分钟？", "禁言 43200 分钟？"], ["删除已选的 3/20 个文件？", "删除已选的 20/20 个文件？"]]) {
        W = await win(854, page("编辑器", [...editor, ...ask(a)]));
        await call("window_state", { ...W, include_screenshot: false });
        await reset(W, page("编辑器", [...editor, ...ask(b)]));
        await log();
        const r = await press(W, { label: "确定" });
        folded.push(r.isError && textOf(r).includes(b) && (await log()).actions.length === 0);
      }
      check("H10-5 a confirm sheet without a progress bar: another date, time, percentage, duration or count is another sheet — held with the new text", folded.every(Boolean), J(folded));

      // R9-9: a hold ends. The sheet's words differ on every walk; the step is held once.
      W = await win(843, page("拷贝", editor));
      await call("window_state", { ...W, include_screenshot: false });
      await log();
      let held = 0;
      let last = null;
      for (const f of ["合同.docx", "报价.xlsx", "封面.psd", "附件.zip"]) {
        await reset(W, page("拷贝", [...editor, ...prog(`正在拷贝 ${f}`)]));
        last = await press(W, { label: "后台运行" });
        if (!last.isError) break;
        held++;
      }
      lg = await log();
      check("R9-9 a sheet that names another file on every walk: find 后台运行 is held once, the same step again goes through and its reply names the sheet up now", held === 1 && !last.isError && textOf(last).includes("dialog/sheet up now") && textOf(last).includes("报价.xlsx") && lg.actions.length === 1, `${held} | ${textOf(last)}`);

      // R9-10: on a large page the model looks by query only; what a query view or an action report printed is "seen".
      const tabs = ["订单", "客户", "商品"];
      const big = (tab, N = 300) => page("后台", [[1, "AXWebArea", "后台", { web: true }], ...tabs.map((t, i) => B(2, t, F(20 + 90 * i, 20))), B(2, `导出${tab}`, F(600, 20)), ...Array.from({ length: N }, (_, i) => St(2, `${tab} 第 ${i} 行的内容，长一点长一点长一点`, F(20, 60 + 24 * i, 400))), St(2, `${tab} 共 ${N} 条`, F(20, 9000, 200)), B(2, `归档${tab}`, F(400, 9000))]);
      W = await win(844, big("订单"));
      await call("window_state", { ...W, include_screenshot: false, query: "导出" });
      let extra = 0;
      const go = async (find) => {
        let r = await call("act", { action: "click", ...W, find });
        if (r.isError) {
          extra++;
          r = await call("act", { action: "click", ...W, find });
        }
        return r;
      };
      const seenOk = [];
      for (const t of ["客户", "商品", "订单"]) {
        await ctl("fake_after_action", { pid: P, window_id: 844, rows: big(t) });
        seenOk.push(!(await go({ label: t })).isError);
        await call("window_state", { ...W, include_screenshot: false, query: `导出${t}` });
        seenOk.push(!(await go({ label: `导出${t}` })).isError);
      }
      lg = await log();
      check("R9-10 query-only on a 300-row page: flip a tab (the report is an outline that prints the tab bar), query the page's own button, press it — three rounds, six presses, none held", extra === 0 && seenOk.every(Boolean) && lg.actions.length === 6, `${extra} held | ${J(seenOk)} | ${lg.actions.length}`);
      await ctl("fake_after_action", { pid: P, window_id: 844, rows: big("客户") });
      await go({ label: "客户" });
      await log();
      const unseen = await call("act", { action: "click", ...W, find: { label: "归档客户" }, observe: false });
      const listed = await call("act", { action: "click", ...W, find: { label: "导出客户" }, observe: false });
      lg = await log();
      check("…while a button at the page's end, which the outline listed bare (without the text beside it), is still held once with where it sits; one the outline showed with everything on its line is not", unseen.isError && textOf(unseen).includes("not as you last saw it") && textOf(unseen).includes('near "客户 共 300 条"') && !listed.isError && lg.actions.length === 1, `${textOf(unseen)} | ${textOf(listed)}`);

      // R9-11: the text beside the control was swapped for one that stood elsewhere in the old view.
      const queue = (ids, gen) => page("审核", [[1, "AXWebArea", "审核", { web: true }], B(2, "刷新", F(20, 20)), ...Array.from({ length: 100 }, (_, i) => St(2, `流水 ${i}：${i % 2 === 0 ? gen : "不变"} 的一条比较长的记录，用来占字数`, F(20, 60 + 24 * i, 500))), St(2, "待审核队列", F(20, 2500)), B(2, "通过", F(20, 2530)), ...ids.map((id, k) => St(2, id, F(120, 2530 + 30 * k)))]);
      W = await win(845, queue(["DD1003", "DD1005", "DD1007"], "甲"));
      await call("window_state", { ...W, include_screenshot: false });
      await ctl("fake_after_action", { pid: P, window_id: 845, rows: queue(["DD1005", "DD1007"], "乙") });
      const rpt = textOf(await call("act", { action: "click", ...W, find: { label: "刷新" } }));
      await log();
      const q1 = await press(W, { label: "通过" });
      lg = await log();
      check("R9-11 '[通过] DD1003' became '[通过] DD1005' behind a change list that was cut (DD1005 stood one line lower in the old view): find 通过 is held, and says DD1005", !/DD1005/.test(rpt) && q1.isError && textOf(q1).includes('near "DD1005"') && lg.actions.length === 0, `${rpt.slice(-160)} | ${textOf(q1)}`);

      // R9-12: three query views of a 6,000-row window, their tokens used in turn.
      const bigTable = [[0, "AXWindow", "大表", { a: ["AXRaise"] }], B(1, "刷新"), B(1, "导出"), B(1, "筛选"), B(1, "排序"), ...Array.from({ length: 6000 }, (_, i) => St(1 + (i % 2), `单元 ${i}`))];
      W = await win(846, bigTable);
      await call("window_state", { ...W, include_screenshot: false });
      const toks = [];
      for (const n of ["导出", "筛选", "排序"]) {
        const q = textOf(await call("window_state", { ...W, include_screenshot: false, query: n }));
        toks.push(`${sidOf(q)}:${rowOf(q, "AXButton", n)}`);
      }
      let died = "";
      for (let k = 0; k < 4 && !died; k++) {
        for (const tk of toks) {
          const r = await call("act", { action: "click", ...W, element_token: tk, wait_ms: 0, again: true });
          if (r.isError) {
            died = textOf(r).slice(0, 200);
            break;
          }
        }
      }
      await log();
      check("R9-12 three query views of a 6,000-row window: twelve presses by their tokens in turn, none refused as too old", died === "", died);

      // "As last seen" is the NEWEST view that showed the control: an older look that happens to match is no evidence.
      const qrow = (id, gen = "甲") => page("审核", [[1, "AXWebArea", "审核", { web: true }], B(2, "刷新", F(20, 20)), ...Array.from({ length: 100 }, (_, i) => St(2, `流水 ${i}：${i % 2 === 0 ? gen : "不变"} 的一条比较长的记录，用来占字数`, F(20, 60 + 24 * i, 500))), St(2, "待审核队列", F(20, 2500)), St(2, id, F(20, 2530)), B(2, "通过", F(120, 2530))]);
      W = await win(848, qrow("DD1003"));
      await call("window_state", { ...W, include_screenshot: false, query: "通过" }); // look 1: [通过] beside DD1003
      await reset(W, qrow("DD1005"));
      const look2 = textOf(await call("window_state", { ...W, include_screenshot: false, query: "通过" })); // look 2: beside DD1005
      await ctl("fake_after_action", { pid: P, window_id: 848, rows: qrow("DD1003", "乙") }); // …then 刷新: a hundred rows change (the report is cut) and the head is DD1003 again
      const cutRpt = textOf(await call("act", { action: "click", ...W, find: { label: "刷新" } }));
      await log();
      const back = await press(W, { label: "通过" });
      lg = await log();
      const backAgain = await press(W, { label: "通过" });
      const lgAgain = await log();
      check(
        "the model's newest look showed [通过] beside DD1005; behind a cut report the head is DD1003 again, as an OLDER look had it: held, saying what stands beside it now; the same step again goes through",
        look2.includes("DD1005") && cutRpt.includes("not every change is listed") && back.isError && textOf(back).includes('near "DD1003"') && textOf(back).includes('beside it now: "DD1003" (it was "DD1005")') && lg.actions.length === 0 && !backAgain.isError && lgAgain.actions.length === 1,
        `${cutRpt.slice(-120)} | ${textOf(back)} | ${textOf(backAgain)}`
      );
      // …while what the page does by itself after the model's latest look is not something the hub could have told it: a countdown beside the button.
      const timed = (sec, gen) => page("考试", [[1, "AXWebArea", "考试", { web: true }], B(2, "刷新", F(20, 20)), ...Array.from({ length: 100 }, (_, i) => St(2, `题目 ${i}：${i % 2 === 0 ? gen : "不变"} 的一条比较长的记录，用来占字数`, F(20, 60 + 24 * i, 500))), St(2, `剩余 00:${sec}`, F(20, 2530)), B(2, "提交", F(120, 2530))]);
      W = await win(855, timed(59, "甲"));
      await call("window_state", { ...W, include_screenshot: false });
      await ctl("fake_after_action", { pid: P, window_id: 855, rows: timed(57, "乙") });
      const cutT = textOf(await call("act", { action: "click", ...W, find: { label: "刷新" } })); // cut report: the model is behind from here on
      await log();
      const rounds = [cutT.includes("not every change is listed")];
      for (const sec of [55, 53, 51]) {
        await reset(W, timed(sec, "乙"));
        const q = textOf(await call("window_state", { ...W, include_screenshot: false, query: "提交" })); // prints the button and the countdown on its line
        await reset(W, timed(sec - 1, "乙")); // …which ticks on before the call
        const r = await call("act", { action: "click", ...W, find: { label: "提交" }, observe: false });
        rounds.push(q.includes(`剩余 00:${sec}`) && !r.isError);
      }
      lg = await log();
      check("R10-C1 a countdown beside the button, the model behind on the page: look (query prints the button and its line), press — three rounds, none held although the countdown ticked in between", rounds.every(Boolean) && lg.actions.length === 3, J(rounds));
      await reset(W, timed(40, "乙"));
      const blindPress = await call("act", { action: "click", ...W, find: { label: "提交" }, observe: false, again: true });
      await reset(W, timed(39, "乙"));
      const blindAgain = await call("act", { action: "click", ...W, find: { label: "提交" }, observe: false, again: true });
      lg = await log();
      check("…pressed again without a look after its own unobserved press, with another text beside it by now: held once, saying what stands there now; the same step again goes through although the countdown has ticked on", blindPress.isError && textOf(blindPress).includes('"剩余 00:40" (it was "剩余 00:50")') && !blindAgain.isError && lg.actions.length === 1, `${textOf(blindPress)} | ${textOf(blindAgain)}`);

      // A picture vouches for the sheets of a walk made moments before it — the test of the "moments" is in 7.6k.
      // A click on a link's inert text is a click on the link.
      W = await win(849, page("订单", web(rows3)));
      const r3b = await press(W, { label: "DD1005" });
      lg = await log();
      check("R9-3 find {label:DD1005} on rows that are links 'DD1005 空气炸锅 删除' holding the text DD1005: the link is pressed, not the inert text inside it", !r3b.isError && J(hits(lg)) === J(["click AXLink DD1005 空气炸锅 删除"]), `${textOf(r3b)} | ${J(hits(lg))}`);

      // A whole-window look cut at the size cap vouches only for the rows it printed.
      const cutPage = (tab) => page("后台", [[1, "AXWebArea", "后台", { web: true }], ...["订单", "客户"].map((t, i) => B(2, t, F(20 + 90 * i, 20))), ...Array.from({ length: 600 }, (_, i) => St(2, `${tab} 第 ${i} 行的内容，长一点长一点长一点`, F(20, 60 + 24 * i, 400))), St(2, tab === "订单" ? "选中：订单 DD1003" : "选中：客户 张伟（全部订单）", F(20, 15000, 300)), B(2, "删除", F(400, 15000))]);
      W = await win(850, cutPage("订单"));
      const cut1 = textOf(await call("window_state", { ...W, include_screenshot: false }));
      await ctl("fake_after_action", { pid: P, window_id: 850, rows: cutPage("客户") });
      await call("act", { action: "click", ...W, find: { label: "客户" } });
      const cut2 = textOf(await call("window_state", { ...W, include_screenshot: false }));
      await log();
      const past = await press(W, { label: "删除" });
      const tabSeen = await press(W, { label: "订单" });
      lg = await log();
      check("a whole-window look cut at the size cap, the page flipped, a second look cut again — [删除] at the page's end was never printed: held, with the text beside it; a tab both looks printed is pressed", !cut1.includes("选中：") && !cut2.includes("选中：") && past.isError && textOf(past).includes("张伟（全部订单）") && !tabSeen.isError && lg.actions.length === 1, `${textOf(past)} | ${textOf(tabSeen)}`);

      // Notes of round 9: an empty label names nothing; desk_call's delivery_mode is exact.
      W = await win(847, FORM());
      const empty = await call("act", { action: "click", ...W, find: { label: "", nth: 2 }, observe: false });
      const dcCase = await call("desk_call", { server: "cua", tool: "click", args: { ...W, x: 10, y: 10, delivery_mode: "Foreground" } });
      lg = await log();
      check('round 9 notes: find {label:"", nth:2} is invalid (it would be "the third row"); desk_call delivery_mode:"Foreground" is refused, nothing sent', empty.isError && textOf(empty).includes("find.label is empty") && dcCase.isError && textOf(dcCase).includes('exactly "background" or "foreground"') && lg.actions.length === 0, `${textOf(empty)} | ${textOf(dcCase)}`);
    });

    // 7.6l review round 10 -------------------------------------------------------------------------------------
    await section("7.6l round 10", async () => {
      const St = (d, t, o = {}) => [d, "AXStaticText", t, { a: [], ...o }];
      const B = (d, t, o = {}) => [d, "AXButton", t, { press: true, ...o }];
      const Lk = (d, t, o = {}) => [d, "AXLink", t, { press: true, ...o }];
      const F = (x, y, w = 80, h = 24) => ({ f: [x, y, w, h] });
      const page = (title, rows) => [[0, "AXWindow", title, { a: ["AXRaise"] }], ...rows];
      const web = (rows) => [[1, "AXWebArea", "页", { web: true }], ...rows];
      const press = (W, find, extra = {}) => call("act", { action: "click", ...W, find, observe: false, ...extra });
      const hits = (lg) => lg.actions.map((a) => `${a.tool} ${a.target?.role} ${a.target?.label}`);
      const reset = (W, rows) => ctl("fake_set_window", { pid: P, window_id: W.window_id, rows });
      const after = (W, rows) => ctl("fake_after_action", { pid: P, window_id: W.window_id, rows });
      const look = async (W, extra = {}) => textOf(await call("window_state", { ...W, include_screenshot: false, ...extra }));
      let lg;

      // R10-F1: antd writes 确定 as "确 定".
      let W = await win(901, page("表单", web([Lk(2, "确定并继续添加", F(20, 60, 160)), St(2, "确定删除吗？", F(20, 100, 160)), B(2, "取 消", F(20, 140)), B(2, "确 定", F(120, 140)), B(2, "取消订单", F(20, 180))])));
      const f1 = await press(W, { label: "确定" });
      const f1b = await press(W, { label: "取消" });
      lg = await log();
      check("R10-F1 find 确定 presses the button '确 定', not the link 确定并继续添加 or the text 确定删除吗？; find 取消 presses '取 消', not 取消订单", !f1.isError && !f1b.isError && J(hits(lg)) === J(["click AXButton 确 定", "click AXButton 取 消"]), `${textOf(f1)} | ${textOf(f1b)}`);

      // R10-F2: the name itself is a row the action cannot use, and a differently named row is one it can.
      W = await win(902, page("设置", web([St(2, "设置", F(20, 60)), St(2, "在这里调整偏好", F(20, 100, 200)), B(2, "打开设置", F(20, 140)), St(2, "姓名", F(20, 200)), [2, "AXTextField", "请输入姓名", { v: "", a: ["AXConfirm"], ...F(120, 200, 200) }]])));
      const f2 = await press(W, { label: "设置" });
      const f2b = await call("act", { action: "set_value", ...W, find: { label: "姓名" }, value: "张伟", observe: false });
      lg = await log();
      check("R10-F2 click 设置 (a heading 设置 + a button 打开设置) and set_value 姓名 (a text 姓名 + a field 请输入姓名): both refused with the two rows listed, nothing sent to the inert text", f2.isError && textOf(f2).includes('AXButton "打开设置"') && f2b.isError && textOf(f2b).includes('AXTextField "请输入姓名"') && lg.actions.length === 0, `${textOf(f2)} | ${textOf(f2b)}`);

      // R10-F3: the next card's two-line title.
      W = await win(903, page("笔记", web([St(2, "买菜清单", F(20, 100, 280)), B(2, "删除", F(20, 132, 60)), St(2, "周五前把 DD1005 的发票寄给李四，别忘了附回执", F(340, 100, 280, 48)), B(2, "删除", F(340, 156, 60))])));
      const f3 = await press(W, { label: "删除", near: "DD1005" });
      lg = await log();
      check("R10-F3 two cards side by side, the right one's title wrapped onto two lines: near DD1005 is refused (the left 删除 is not on that title's line), both listed", f3.isError && textOf(f3).includes("cannot be shown to be next to") && lg.actions.length === 0, textOf(f3));

      // R10-F5: text in an unnamed clickable wrapper, inside a row that is one link.
      const rowLink = (y, id) => [Lk(2, `${id} 空气炸锅 删除`, F(20, y, 600, 30)), St(3, id, F(30, y + 4)), St(3, "空气炸锅", F(130, y + 4)), [3, "AXGroup", null, { press: true, ...F(520, y + 4, 60, 22) }], St(4, "删除", F(524, y + 4, 40, 20))];
      W = await win(904, page("订单", web([...rowLink(100, "DD1003"), ...rowLink(140, "DD1005")])));
      const f5 = await press(W, { label: "删除", near: "DD1005" });
      lg = await log();
      check("R10-F5 find 删除 near DD1005 where 删除 is a text in an unnamed clickable wrapper: the wrapper of that row is pressed (not the row link, not the inert text), and the reply says so", !f5.isError && textOf(f5).includes("inside clickable") && lg.actions.length === 1 && lg.actions[0].target.role === "AXGroup" && lg.actions[0].target.idx === 10, `${textOf(f5)} | ${J(lg.actions.map((a) => a.target))}`);

      // R10-F8 / F9 / F11.
      const setting = (y, name, note) => [St(2, name, F(20, y)), St(2, note, F(120, y, 200)), [2, "AXCheckBox", name, { press: true, v: "0", ...F(340, y, 40) }], St(2, "全天", F(400, y))];
      W = await win(905, page("偏好", web([...setting(100, "通知", "有新订单时发短信"), ...setting(140, "通知", "有退款时发邮件")])));
      const f8 = await press(W, { label: "通知", near: "有新订单时发短信" });
      lg = await log();
      check("R10-F8 a switch and the row title of the same name on one line (通知 · 有新订单时发短信 · [通知] · 全天): the title is no rival, the switch of that line is pressed", !f8.isError && J(hits(lg)) === J(["click AXCheckBox 通知"]) && lg.actions[0].target.idx === 4, textOf(f8));
      W = await win(906, page("表单", web([St(2, "数量", F(20, 60)), [2, "AXIncrementor", "数量", { v: "1", a: [], ...F(120, 60) }], St(2, "保存", F(20, 100)), B(2, "保存", { en: false, ...F(120, 100) })])));
      const f9 = await call("act", { action: "set_value", ...W, find: { label: "数量" }, value: "3", observe: false });
      const f11 = await press(W, { label: "保存" });
      lg = await log();
      check("R10-F9 set_value 数量 goes to the AXIncrementor of that name (not an ambiguity with its label text); R10-F11 a text 保存 + a DISABLED button 保存: nothing a click can use — refused, the list says [disabled]", !f9.isError && f11.isError && textOf(f11).includes("[disabled]") && J(hits(lg)) === J(["set_value AXIncrementor 数量"]), `${textOf(f9)} | ${textOf(f11)}`);

      // H10-1: a sheet the model keeps being told about is not "not shown".
      const editor = [[1, "AXTextArea", "正文", { v: "草稿" }], B(1, "保存"), B(1, "关闭")];
      const wizard = (k) => page("安装", [...editor, [1, "AXDialog", "安装向导", {}], St(2, `第 ${k} 步`), St(2, ["请阅读许可", "请选择组件", "请选择位置", "准备安装"][k - 1]), B(2, "上一步"), B(2, "下一步")]);
      W = await win(907, wizard(1));
      await look(W);
      let held = 0;
      for (const k of [2, 3, 4]) {
        await after(W, wizard(k));
        const r = await call("act", { action: "click", ...W, find: { label: "下一步" } });
        if (r.isError) held++;
      }
      lg = await log();
      check("H10-1 a wizard dialog: every 下一步 reports the two texts that changed, in full — the next find is not held ('not shown' was false, and cost a call per step)", held === 0 && lg.actions.length === 3, `${held} held`);

      // A press inside a sheet does not make later steps of the same call, or the next call after a report, strangers to it.
      const login = (u = "", p2 = "") => page("登录", [...editor, [1, "AXSheet", null, {}], St(2, "请登录后继续"), [2, "AXTextField", "用户名", { v: u, a: ["AXConfirm"] }], [2, "AXSecureTextField", "密码", { v: p2, a: ["AXConfirm"] }], [2, "AXCheckBox", "记住我", { press: true, v: "0" }], B(2, "取消"), B(2, "登录")]);
      W = await win(931, login());
      await look(W);
      await log();
      const lb = await call("act_batch", { ...W, steps: [{ action: "set_value", find: { label: "用户名" }, value: "kevin" }, { action: "set_value", find: { label: "密码" }, value: "hunter2x" }, { action: "click", find: { label: "记住我" } }, { action: "click", find: { label: "登录" } }], observe: false });
      lg = await log();
      check("a login sheet the model was shown: one batch fills 用户名 and 密码, ticks 记住我 and presses 登录 — four steps inside the sheet, none held", !lb.isError && lg.actions.length === 4, textOf(lb));
      W = await win(932, login());
      await look(W);
      await log();
      const tick1 = await call("act", { action: "click", ...W, find: { label: "记住我" } }); // default report: nothing changed (the fake does not flip it)
      const tick2 = await call("act", { action: "click", ...W, find: { label: "登录" }, observe: false });
      lg = await log();
      check("…and a press in the sheet whose report shows the sheet still up (no change) leaves it known: the next find in it is not held", !tick1.isError && !tick2.isError && lg.actions.length === 2, `${textOf(tick1).slice(0, 200)} | ${textOf(tick2)}`);

      // H10-3 / H10-8 / H10-9: what a hold says, and what its pass covers.
      const confirm = (who) => [[1, "AXSheet", null, {}], St(2, "删除确认"), St(2, "此操作不可撤销"), St(2, "相关数据会一并清除"), St(2, "请核对以下对象"), St(2, "对象类型：客户"), St(2, `客户：${who}`), B(2, "取消"), B(2, "删除")];
      W = await win(908, page("编辑器", [...editor, ...confirm("张伟（试用）")]));
      await look(W);
      await reset(W, page("编辑器", [...editor, ...confirm("全部 1,204 位客户")]));
      await log();
      const h3 = await press(W, { label: "删除" });
      lg = await log();
      check("H10-3 two sheets alike in their first five texts: the hold prints every text of the sheet, the sixth included", h3.isError && textOf(h3).includes("客户：全部 1,204 位客户") && lg.actions.length === 0, textOf(h3));
      const long = `${"这是一段很长的许可说明。".repeat(20)}最后一句：同意后将清空全部数据`;
      W = await win(909, page("编辑器", editor));
      await look(W);
      await reset(W, page("编辑器", [...editor, [1, "AXSheet", null, {}], St(2, long), B(2, "不同意"), B(2, "同意")]));
      await log();
      const h3a = await press(W, { label: "同意" });
      const h3b = await press(W, { label: "不同意" });
      lg = await log();
      check("H10-3 a sheet whose text does not fit a reply is not 'shown' by the hold that names it: another find in it is held as well", h3a.isError && !textOf(h3a).includes("清空全部数据") && h3b.isError && textOf(h3b).includes("have not been shown") && lg.actions.length === 0, `${textOf(h3a).slice(-260)} | ${textOf(h3b).slice(0, 200)}`);
      W = await win(910, page("客户", [St(1, "客户列表"), B(1, "删除"), [1, "AXSheet", null, {}], St(2, "同步完成"), B(2, "好")]));
      await ctl("fake_set_window", { pid: P, window_id: 910, rows: page("客户", [St(1, "客户列表"), B(1, "删除")]) });
      await look(W);
      await reset(W, page("客户", [St(1, "客户列表"), B(1, "删除"), [1, "AXSheet", null, {}], St(2, "同步完成"), B(2, "好")]));
      const h8 = await press(W, { label: "删除" }); // held for the unrelated sheet; located on the page
      await reset(W, page("客户", [St(1, "客户列表"), [1, "AXSheet", null, {}], St(2, "确认删除全部 1,204 位客户？此操作不可恢复"), B(2, "取消"), B(2, "删除")]));
      await log();
      const h8b = await press(W, { label: "删除" });
      lg = await log();
      check("H10-8 held for the page's [删除]; on resend the only 删除 is inside another sheet: the pass does not follow the name into it — held again with that sheet's words", h8.isError && h8b.isError && textOf(h8b).includes("1,204") && lg.actions.length === 0, `${textOf(h8).slice(0, 160)} | ${textOf(h8b)}`);

      // H10-6 / R10-M1 / H10-7: what a batch may not skip.
      const queue = (ids, gen) => page("审核", [[1, "AXWebArea", "审核", { web: true }], B(2, "刷新", F(20, 20)), ...Array.from({ length: 100 }, (_, i) => St(2, `流水 ${i}：${i % 2 === 0 ? gen : "不变"} 的一条比较长的记录，用来占字数`, F(20, 60 + 24 * i, 500))), St(2, "待审核队列", F(20, 2500)), ...ids.flatMap((id, k) => [B(2, "通过", F(20, 2530 + 30 * k)), St(2, id, F(120, 2530 + 30 * k))])]);
      const behind = async (wid, ids1, ids2) => {
        const X = await win(wid, queue(ids1, "甲"));
        await look(X);
        await ctl("fake_after_action", { pid: P, window_id: wid, rows: queue(ids2, "乙") });
        const rpt = textOf(await call("act", { action: "click", ...X, find: { label: "刷新" } }));
        await log();
        return { X, cut: rpt.includes("not every change is listed") };
      };
      const Wn = await win(911, page("备注", [B(1, "关闭")]));
      await look(Wn);
      let q = await behind(912, ["DD1003", "DD1005", "DD1007"], ["DD1005", "DD1007"]);
      const m1 = await call("act_batch", { ...Wn, steps: [{ action: "click", window_id: 912, find: { label: "通过", nth: 0 } }], observe: false });
      lg = await log();
      check("R10-M1 / R10-A1 the model is behind on window 912; a batch addressed to another window with a step for 912, find {通过, nth:0} after the queue's head moved up: held — nth no longer counts to the row it counted to", q.cut && m1.isError && textOf(m1).includes("nth=0 does not count to the control it counted to") && textOf(m1).includes('near "DD1005"') && lg.actions.length === 0, textOf(m1));
      q = await behind(913, ["DD1003", "DD1005"], ["DD1003", "DD1005", "DD1009"]);
      const a1b = await press(q.X, { label: "通过", nth: 0 });
      lg = await log();
      check("…while a queue that only grew at its tail leaves nth:0 where it was: not held", q.cut && !a1b.isError && lg.actions.length === 1, textOf(a1b));
      W = await win(914, page("编辑器", [St(1, "订单 DD1005", F(20, 20, 120)), [1, "AXTextField", "备注", { v: "", a: ["AXConfirm"], ...F(160, 20, 200) }], B(1, "提交", F(400, 20))]));
      await look(W);
      await reset(W, page("编辑器", [St(1, "订单 DD1005", F(20, 20, 120)), [1, "AXTextField", "备注", { v: "", a: ["AXConfirm"], ...F(160, 20, 200) }], B(1, "提交", F(400, 20)), [1, "AXSheet", null, {}], St(2, "登录已过期，放弃未保存的修改并退出？"), B(2, "取消"), B(2, "确定")]));
      await log();
      const h7 = await call("act_batch", { ...W, steps: [{ action: "set_value", find: { label: "备注", near: "DD1005" }, value: "加急" }, { action: "click", find: { label: "确定" } }], observe: false });
      lg = await log();
      check("H10-7 a sheet that was up when this call first walked the window, before any of its steps ran, is not 'opened by an earlier step': step 2 find 确定 is held", h7.isError && textOf(h7).includes("FAILED at step 2") && textOf(h7).includes("登录已过期") && J(hits(lg)) === J(["set_value AXTextField 备注"]), textOf(h7));

      // H10-9: one hold for both reasons.
      const big = (id, sheet) => page("订单", [St(1, `订单 DD${id}`), ...Array.from({ length: 300 }, (_, i) => St(1, `明细行 ${i} · 批次 ${id}-${i}`)), [1, "AXGroup", "操作", {}], St(2, `对订单 DD${id} 的操作`), B(2, "删除订单"), B(2, "导出"), ...(sheet ? [[1, "AXSheet", null, {}], St(2, "导出完成"), B(2, "好")] : [])]);
      W = await win(915, big(1005, false));
      await look(W);
      await after(W, big(1006, false));
      await call("act", { action: "click", ...W, find: { label: "导出" } });
      await reset(W, big(1006, true));
      await log();
      const h9 = await press(W, { label: "删除订单" });
      const h9b = await press(W, { label: "删除订单" });
      lg = await log();
      check("H10-9 a sheet nobody showed AND a page changed behind an outline: one hold names both; the same step again goes through", h9.isError && textOf(h9).includes("导出完成") && textOf(h9).includes("; and this window has changed by more than you were shown") && !h9b.isError && lg.actions.length === 1, `${textOf(h9)} | ${textOf(h9b)}`);

      // H10-10: the address is "shown" when a reply printed it.
      const shop = (id, n = 200) => page("商城", [[1, "AXTextField", "地址和搜索栏", { v: `https://shop.example.com/orders/${id}`, a: ["AXConfirm"] }], [1, "AXWebArea", `订单 ${id}`, { web: true }], ...Array.from({ length: n }, (_, i) => St(2, `订单 ${id} 的明细行 ${i}，长一点长一点长一点`, F(20, 60 + 24 * i, 400))), St(2, "操作", F(20, 9000)), B(2, "删除订单", F(120, 9000)), B(2, "导出", F(220, 9000))]);
      W = await win(916, shop(1005));
      await look(W, { query: "删除订单" });
      await reset(W, shop(1006));
      const q2 = await look(W, { query: "导出" });
      await log();
      const h10 = await press(W, { label: "删除订单" });
      lg = await log();
      check("H10-10 query-only: the page went from orders/1005 to orders/1006; a query for another word does not print the address row — the reply adds a line saying the address changed, and the find after it is not held for that", q2.includes('page address now "https://shop.example.com/orders/1006"') && q2.includes("orders/1005") && !h10.isError && lg.actions.length === 1, `${q2.slice(-260)} | ${textOf(h10)}`);
      W = await win(917, shop(1005, 3));
      await look(W);
      await reset(W, shop(1006, 3));
      await log();
      const h10b = await press(W, { label: "删除订单" });
      lg = await log();
      check("…and without any reply in between, the changed address still holds the find", h10b.isError && textOf(h10b).includes("the page address changed") && lg.actions.length === 0, textOf(h10b));

      // H10-12 / H10-13.
      const expired = [[1, "AXSheet", null, {}], St(2, "登录已过期，放弃未保存的修改并退出？"), B(2, "取消"), B(2, "确定")];
      W = await win(918, page("编辑器", editor));
      const v0 = await look(W);
      await reset(W, page("编辑器", [...editor, ...expired]));
      await press(W, { label: "打印" }); // matches nothing: the hub has walked the window and shown the model nothing
      const stale = await call("act", { action: "click", ...W, element_token: `${sidOf(v0)}:${rowOf(v0, "AXButton", "保存")}`, observe: false });
      await log();
      const h12 = await press(W, { label: "取消" });
      lg = await log();
      check("H10-12 an old token is refused with the new sheet's words and buttons: that reply has shown the sheet — the find that follows is not held again", stale.isError && textOf(stale).includes("登录已过期") && !h12.isError && lg.actions.length === 1, `${textOf(stale).slice(0, 200)} | ${textOf(h12)}`);
      W = await win(919, page("编辑器", [...editor, [1, "AXSheet", null, {}], [2, "AXTextArea", null, { v: "将从服务器永久删除 1,204 位客户的全部资料，此操作不可恢复。" }], B(2, "取消"), B(2, "确定")]));
      const qb = await look(W, { query: "确定" });
      await log();
      const h13 = await press(W, { label: "确定" });
      lg = await log();
      check("H10-13 a sheet whose words are in a text area: a query that printed only its 确定 button has not shown it — held with the words", !qb.includes("1,204") && h13.isError && textOf(h13).includes("1,204") && lg.actions.length === 0, `${qb.slice(0, 200)} | ${textOf(h13)}`);

      // R10-D1: the hold said where it sat; the model's own unobserved action changed that.
      const admin = (gen, sel) => page("后台", [[1, "AXWebArea", "后台", { web: true }], B(2, "订单", F(20, 20)), B(2, "客户", F(110, 20)), ...Array.from({ length: 100 }, (_, i) => St(2, `第 ${i} 行：${i % 2 === 0 ? gen : "不变"} 的内容，长一点长一点长一点`, F(20, 60 + 24 * i, 400))), St(2, sel, F(20, 3000, 300)), B(2, "删除", F(400, 3000))]);
      W = await win(920, admin("甲", "选中：订单 DD1001"));
      await look(W);
      await after(W, admin("乙", "选中：订单 DD1003"));
      await call("act", { action: "click", ...W, find: { label: "订单" } }); // cut report
      await log();
      const d1 = await press(W, { label: "删除" });
      await after(W, admin("乙", "选中：客户 张伟（含全部订单）"));
      const tab = await press(W, { label: "客户" }); // the model's own unobserved action
      const d1b = await press(W, { label: "删除" });
      lg = await log();
      const d1c = await press(W, { label: "删除" });
      const lg3 = await log();
      check(
        "R10-D1 held for 删除 beside 订单 DD1003; then the model's own unobserved click puts 客户 张伟 there: the same step is held AGAIN and says what stands beside it now (it was …); sent once more it goes through",
        d1.isError && textOf(d1).includes('"选中：订单 DD1003" (it was "选中：订单 DD1001")') && !tab.isError && d1b.isError && textOf(d1b).includes('"选中：客户 张伟（含全部订单）" (it was "选中：订单 DD1003")') && J(hits(lg)) === J(["click AXButton 客户"]) && !d1c.isError && lg3.actions.length === 1,
        `${textOf(d1)} | ${textOf(tab)} | ${textOf(d1b)} | ${textOf(d1c)}`
      );

      // R10-J1: controls an earlier step of the same call brought out.
      const tickets = (form) => page("工单", [[1, "AXWebArea", "工单", { web: true }], B(2, "刷新", F(20, 20)), B(2, "新建", F(110, 20)), ...Array.from({ length: 100 }, (_, i) => St(2, `工单 ${i}：${i % 2 ? "不变" : form === "甲" ? "甲" : "乙"} 的一条比较长的记录，用来占字数`, F(20, 60 + 24 * i, 500))), ...(form === true ? [[2, "AXGroup", "新建工单", {}], [3, "AXTextField", "标题", { v: "", a: ["AXConfirm"] }], [3, "AXTextField", "电话", { v: "", a: ["AXConfirm"] }], B(3, "保存草稿")] : [])]);
      W = await win(921, tickets("甲"));
      await look(W);
      await after(W, tickets("乙"));
      const cutJ = textOf(await call("act", { action: "click", ...W, find: { label: "刷新" } }));
      await after(W, tickets(true));
      await log();
      const j1 = await call("act_batch", { ...W, steps: [{ action: "click", find: { label: "新建" } }, { action: "set_value", find: { label: "标题" }, value: "打印机坏了" }, { action: "set_value", find: { label: "电话" }, value: "13800000000" }, { action: "click", find: { label: "保存草稿" } }], observe: false });
      lg = await log();
      check("R10-J1 the model is behind on the page; one batch opens a form and fills it — the form's controls came out of step 1 of this very call and are not held one by one", cutJ.includes("not every change is listed") && !j1.isError && lg.actions.length === 4, textOf(j1));

      // R10-H1: the views in use fit whatever the window's size.
      const bigTable = [[0, "AXWindow", "大表", { a: ["AXRaise"] }], B(1, "刷新"), B(1, "导出"), B(1, "筛选"), B(1, "排序"), ...Array.from({ length: 9000 }, (_, i) => St(1 + (i % 2), `单元 ${i}`))];
      W = await win(922, bigTable);
      await look(W);
      const toks = [];
      for (const n of ["导出", "筛选", "排序"]) {
        const v = await look(W, { query: n });
        toks.push(`${sidOf(v)}:${rowOf(v, "AXButton", n)}`);
      }
      let died = "";
      for (let k = 0; k < 3 && !died; k++) {
        for (const tk of toks) {
          await call("act", { action: "click", ...W, find: { label: "刷新" }, wait_ms: 0, again: true });
          const r = await call("act", { action: "click", ...W, element_token: tk, wait_ms: 0, again: true });
          if (r.isError) {
            died = textOf(r).slice(0, 200);
            break;
          }
        }
      }
      await log();
      check("R10-H1 three query views of a 9,000-row window, their tokens used in turn with a find action in between each: none refused as too old", died === "", died);

      // R10-E1: a window the hub dropped to bound memory is one the model is behind on, not one it never saw.
      W = await win(930, FORM());
      await look(W);
      for (let i = 0; i < 17; i++) {
        const X = await win(940 + i, page(`小窗 ${i}`, [B(1, "好")]));
        await look(X);
      }
      await log();
      const e1 = await press(W, { label: "保存" });
      const e1b = await press(W, { label: "保存" });
      const e1c = await press(W, { label: "导出" }); // another control: the notice was given once
      lg = await log();
      check("R10-E1 the model looked at a window, then at seventeen others (the hub keeps sixteen): a find back in the first is held once, saying the hub no longer holds that view; the same step again goes through, and so does the next find there (one notice, round 11)", e1.isError && textOf(e1).includes("no longer holds what you last saw") && !e1b.isError && !e1c.isError && lg.actions.length === 2, `${textOf(e1)} | ${textOf(e1b)} | ${textOf(e1c)}`);
    });

    // 7.6n review round 11 -------------------------------------------------------------------------------------
    await section("7.6n round 11", async () => {
      const St = (d, t, o = {}) => [d, "AXStaticText", t, { a: [], ...o }];
      const B = (d, t, o = {}) => [d, "AXButton", t, { press: true, ...o }];
      const Lk = (d, t, o = {}) => [d, "AXLink", t, { press: true, ...o }];
      const TF = (d, t, v = "", o = {}) => [d, "AXTextField", t, { v, a: ["AXConfirm"], ...o }];
      const F = (x, y, w = 80, h = 24) => ({ f: [x, y, w, h] });
      const page = (title, rows) => [[0, "AXWindow", title, { a: ["AXRaise"] }], ...rows];
      const web = (rows) => [[1, "AXWebArea", "页", { web: true }], ...rows];
      const press = (W, find, extra = {}) => call("act", { action: "click", ...W, find, observe: false, ...extra });
      const hits = (lg) => lg.actions.map((a) => `${a.tool} ${a.target?.role} ${a.target?.label}`);
      const reset = (W, rows) => ctl("fake_set_window", { pid: P, window_id: W.window_id, rows });
      const after = (W, rows) => ctl("fake_after_action", { pid: P, window_id: W.window_id, rows });
      const look = async (W, extra = {}) => textOf(await call("window_state", { ...W, include_screenshot: false, ...extra }));
      const filler = (gen, n = 100) => Array.from({ length: n }, (_, i) => St(2, `流水 ${i}：${i % 2 === 0 ? gen : "不变"} 的一条比较长的记录，用来占字数`, F(20, 60 + 24 * i, 500)));
      let lg;

      // R11-1 (a regression of round 10): behind on the page, default reports, the same button again and again.
      const queue = (ids, gen) => page("审核", [[1, "AXWebArea", "审核", { web: true }], B(2, "刷新", F(20, 20)), ...filler(gen), St(2, "待审核队列", F(20, 2500)), ...ids.flatMap((id, k) => [B(2, "通过", F(20, 2530 + 30 * k)), St(2, id, F(120, 2530 + 30 * k))])]);
      const ids = ["DD1003", "DD1005", "DD1007", "DD1009", "DD1011", "DD1013"];
      let W = await win(1001, queue(ids, "甲"));
      await look(W);
      await after(W, queue(ids, "乙"));
      const cut = textOf(await call("act", { action: "click", ...W, find: { label: "刷新" } })); // cut report: the model is behind from here on
      await log();
      let heldN = 0;
      let landed = 0;
      for (let k = 0; k < 4; k++) {
        await after(W, queue(ids.slice(k + 1), "乙"));
        const r = await call("act", { action: "click", ...W, find: { label: "通过", nth: 0 } });
        if (r.isError) heldN++;
        else if (textOf(r).includes(`now lands on`) && textOf(r).includes(`near "${ids[k + 1]}"`)) landed++;
      }
      lg = await log();
      check("R11-1 behind on the page, approving the queue's head four times with default reports: none held — each report says where the same find lands now (the next order), and that line is a view like any other", cut.includes("not every change is listed") && heldN === 0 && landed === 4 && lg.actions.length === 4 && J(lg.actions.map((a) => a.target.siblings.find((t) => /^DD/.test(t)))) === J(ids.slice(0, 4)), `${heldN} held, ${landed} landed | ${J(lg.actions.map((a) => a.target.siblings.find((t) => /^DD/.test(t))))}`);
      await reset(W, queue(ids.slice(5), "乙")); // …then the head moves by itself, with nothing sent or looked at
      await call("act", { action: "click", ...W, find: { label: "刷新" }, observe: false });
      await log();
      const selfMoved = await press(W, { label: "通过", nth: 0 });
      lg = await log();
      check("…and after an unobserved action of the model's own, with another order at the head by then, the find is held and says which", selfMoved.isError && textOf(selfMoved).includes('near "DD1013"') && lg.actions.length === 0, textOf(selfMoved));

      // Names (round 11): a row named exactly so that nothing can be done with does not keep the real control out.
      W = await win(1002, page("确认", web([St(2, "删除", F(20, 60)), St(2, "删除后不可恢复，是否继续？", F(20, 100, 300)), B(2, "取 消", F(20, 140)), B(2, "删 除", F(120, 140))])));
      const n1 = await press(W, { label: "删除" });
      const lgN1 = await log();
      W = await win(1003, page("列表", web([Lk(2, "删除 (3)", F(20, 20, 100)), St(3, "删除"), St(3, "(3)"), St(2, "确定删除选中的 3 项？", F(20, 100, 300)), B(2, "取 消", F(20, 140)), B(2, "删 除", F(120, 140))])));
      const n2 = await press(W, { label: "删除" });
      lg = await log();
      check("round 11 names: a heading 删除 over the buttons '取 消' '删 除' → the button; the word 删除 inside the link '删除 (3)' → still the button '删 除' (it IS the name; the link only contains it)", !n1.isError && !n2.isError && J([...hits(lgN1), ...hits(lg)]) === J(["click AXButton 删 除", "click AXButton 删 除"]), `${textOf(n1)} | ${textOf(n2)}`);
      // …and what a click can use although it has no AXPress (a regression of round 10's "exact wins only if usable").
      W = await win(1004, page("邮件", [B(1, "移到收件箱"), [1, "AXOutline", null, {}], [2, "AXRow", null, {}], [3, "AXCell", null, {}], St(4, "收件箱"), [2, "AXRow", null, {}], [3, "AXCell", null, {}], St(4, "草稿"), TF(1, "搜索"), B(1, "高级搜索")]));
      const n3 = await press(W, { label: "收件箱" });
      const n4 = await press(W, { label: "搜索" });
      lg = await log();
      check("round 11: a native sidebar row's text 收件箱 beside a toolbar button 移到收件箱, and a text field 搜索 beside a button 高级搜索 — a click on the exactly named one goes there (it selects the row / focuses the field), as before round 10", !n3.isError && !n4.isError && J(hits(lg)) === J(["click AXStaticText 收件箱", "click AXTextField 搜索"]), `${textOf(n3)} | ${textOf(n4)}`);
      W = await win(1005, page("搜索", web([B(2, "搜索", F(20, 20)), TF(2, "搜索", "", { en: false, ...F(120, 20, 200) })])));
      const n5 = await call("act", { action: "set_value", ...W, find: { label: "搜索" }, value: "空气炸锅", observe: false });
      lg = await log();
      check("round 11: set_value 搜索 where the field of that name is disabled and a button has the name too — refused with both listed ([disabled]), the value does not go into the button", n5.isError && textOf(n5).includes("[disabled]") && lg.actions.length === 0, textOf(n5));
      // A disabled look-alike on a line with words at both ends still divides the line.
      W = await win(1006, page("成员", web([St(2, "张伟", F(20, 100)), B(2, "移除", F(120, 100)), St(2, "李四", F(220, 100)), B(2, "移除", { en: false, ...F(320, 100) }), St(2, "王五", F(420, 100))])));
      const n6 = await press(W, { label: "移除", near: "李四" });
      lg = await log();
      check("round 11: '张伟 [移除] 李四 [移除 disabled] 王五', near 李四 — refused (the text stands between a usable and an unusable 移除), not pressed on 张伟's", n6.isError && textOf(n6).includes("cannot use") && lg.actions.length === 0, textOf(n6));

      // Sheets: what a sheet is, and what a hold says of it.
      const editor = [[1, "AXTextArea", "正文", { v: "草稿" }], B(1, "保存"), B(1, "关闭")];
      const pay = (who, amt) => [[1, "AXSheet", null, {}], St(2, "请确认转账信息"), TF(2, "收款人", who, { en: false }), TF(2, "金额", amt, { en: false }), St(2, "到账方式：实时到账"), B(2, "取消"), B(2, "确认转账")];
      W = await win(1007, page("网银", [...editor, ...pay("张三（尾号 1234）", "100.00")]));
      await look(W);
      await reset(W, page("网银", [...editor, ...pay("李四（尾号 9876）", "90000.00")]));
      await log();
      const s1 = await press(W, { label: "确认转账" });
      lg = await log();
      check("round 11: payee and amount in DISABLED fields of the sheet are content — another payee is another sheet, and the hold prints them (收款人 = 李四…, 金额 = 90000.00)", s1.isError && textOf(s1).includes("收款人 = 李四（尾号 9876）") && textOf(s1).includes("金额 = 90000.00") && lg.actions.length === 0, textOf(s1));
      const del = (names) => [[1, "AXSheet", null, {}], St(2, "将永久删除以下客户："), [2, "AXTable", null, {}], ...names.flatMap((n) => [[3, "AXRow", null, {}], St(4, n)]), B(2, "取消"), B(2, "删除")];
      W = await win(1008, page("客户", [...editor, ...del(["张伟"])]));
      await look(W);
      await reset(W, page("客户", [...editor, ...del(["全部客户（1,204 位）"])]));
      await log();
      const s2 = await press(W, { label: "删除" });
      lg = await log();
      check("round 11: the rows of a short list in a sheet (the customers to delete) are what it asks about — the hold prints them", s2.isError && textOf(s2).includes("AXSheet (将永久删除以下客户： / 全部客户（1,204 位）") && lg.actions.length === 0, textOf(s2));
      const longTitle = "您即将执行一项不可恢复的操作，系统会在确认后立即执行并且无法撤回，请确认是否继续：";
      W = await win(1009, page("编辑器", [...editor, [1, "AXDialog", `${longTitle}清空回收站`, {}], B(2, "取消"), B(2, "继续")]));
      await look(W);
      await reset(W, page("编辑器", [...editor, [1, "AXDialog", `${longTitle}删除全部客户`, {}], B(2, "取消"), B(2, "继续")]));
      await log();
      const s3 = await press(W, { label: "继续" });
      lg = await log();
      check("round 11: a dialog whose words are all in its title — the hold prints the title whole (its end is what differs)", s3.isError && textOf(s3).includes("删除全部客户") && lg.actions.length === 0, textOf(s3));
      // Sheets that change by themselves.
      const copying = (file, pct) => page("访达", [B(1, "新建文件夹"), B(1, "显示简介"), B(1, "排序"), [1, "AXSheet", null, {}], St(2, `正在拷贝“${file}”`), St(2, `已完成 ${pct}%`), [2, "AXProgressIndicator", null, { v: String(pct / 100) }], B(2, "停止")]);
      W = await win(1010, copying("f0.txt", 10));
      await look(W);
      heldN = 0;
      for (const [k, name] of ["新建文件夹", "显示简介", "排序"].entries()) {
        await reset(W, copying(`f${k + 1}.txt`, 30 + 20 * k));
        await after(W, copying(`f${k + 1}b.txt`, 35 + 20 * k));
        if ((await call("act", { action: "click", ...W, find: { label: name } })).isError) heldN++;
      }
      lg = await log();
      check("round 11: a copy sheet with a progress bar names another file at every walk — it is the same operation running: three different buttons outside it are pressed without a hold", heldN === 0 && lg.actions.length === 3, `${heldN} held`);
      const sms = (sec) => page("登录", [...editor, [1, "AXSheet", null, {}], St(2, "短信验证码登录"), TF(2, "手机号"), TF(2, "验证码"), B(2, `重新发送(${sec}s)`, { en: false }), B(2, "取消"), B(2, "登录")]);
      W = await win(1011, sms(59));
      await look(W);
      heldN = 0;
      for (const [k, step] of [{ action: "set_value", find: { label: "手机号" }, value: "13800000000x" }, { action: "set_value", find: { label: "验证码" }, value: "12a4" }, { action: "click", find: { label: "登录" } }].entries()) {
        await reset(W, sms(55 - 5 * k));
        if ((await call("act", { ...step, ...W })).isError) heldN++;
      }
      lg = await log();
      check("round 11: a countdown in a disabled button's name ('重新发送(55s)') does not make another sheet of it at every step", heldN === 0 && lg.actions.length === 3, `${heldN} held`);
      // A sheet the call itself dismissed and brought back.
      const savePanel = [...editor, [1, "AXSheet", null, {}], St(2, "存储为："), TF(2, "名称", "未命名"), B(2, "取消"), B(2, "存储")];
      W = await win(1012, page("文稿", savePanel));
      await look(W);
      await after(W, page("文稿", editor)); // 取消 → the sheet goes
      await after(W, page("文稿", editor)); // 正文 edited
      await after(W, page("文稿", savePanel)); // 保存 → it is back
      await log();
      const m2 = await call("act_batch", { ...W, steps: [{ action: "click", find: { label: "取消" } }, { action: "set_value", find: { label: "正文" }, value: "第二稿" }, { action: "click", find: { label: "保存" } }, { action: "click", find: { label: "存储" } }], observe: false });
      lg = await log();
      check("round 11: one batch dismisses a sheet, edits, and brings a sheet of the same words back — the last step's find in it is this call's own doing, not held", !m2.isError && lg.actions.length === 4, textOf(m2));
      // An address that keeps moving under one path.
      const live = (t) => page("直播", [TF(1, "地址和搜索栏", `https://shop.example.com/live?t=${t}`), [1, "AXWebArea", "直播间", { web: true }], St(2, "直播间", F(20, 60)), B(2, "点赞", F(20, 100)), B(2, "关注", F(120, 100)), B(2, "分享", F(220, 100))]);
      W = await win(1013, live(1700000000));
      await look(W);
      heldN = 0;
      const moves = [];
      for (const [k, name] of ["点赞", "关注", "分享"].entries()) {
        await reset(W, live(1700000001 + k));
        let r = await press(W, { label: name });
        if (r.isError) {
          heldN++;
          r = await press(W, { label: name });
        }
        moves.push(!r.isError && (k === 0 || textOf(r).includes(`page address now "https://shop.example.com/live?t=${1700000001 + k}"`)));
      }
      lg = await log();
      check("round 11: an address whose time parameter differs at every walk — held once; after that the reply says the new address instead of holding every step", heldN === 1 && moves.every(Boolean) && lg.actions.length === 3, `${heldN} held | ${J(moves)}`);
      const shop = (id) => page("商城", [TF(1, "地址和搜索栏", `https://shop.example.com/orders/${id}`), [1, "AXWebArea", `订单 ${id}`, { web: true }], St(2, `订单 DD${id}`, F(20, 60)), B(2, "删除订单", F(20, 100)), B(2, "导出", F(120, 100))]);
      W = await win(1014, shop(1005));
      await look(W);
      await reset(W, shop(1006));
      const a1 = await press(W, { label: "删除订单" }); // held: another path
      await reset(W, shop(1007));
      await log();
      const a2 = await press(W, { label: "导出" });
      lg = await log();
      check("…while another PATH is another page each time: orders/1005 → 1006 held, and → 1007 moments later held again", a1.isError && a2.isError && textOf(a2).includes("orders/1007") && lg.actions.length === 0, `${textOf(a1).slice(0, 200)} | ${textOf(a2)}`);

      // What decides "as last seen".
      const admin = (gen, sel, n = 100) => page("后台", [[1, "AXWebArea", "后台", { web: true }], B(2, "订单", F(20, 20)), B(2, "客户", F(110, 20)), B(2, "刷新", F(200, 20)), ...filler(gen, n), St(2, sel, F(20, 3000, 300)), B(2, "删除", F(400, 3000))]);
      W = await win(1015, admin("甲", "选中：订单 DD1003"));
      await look(W);
      await after(W, admin("乙", "选中：客户 张伟（含全部订单）"));
      await call("act", { action: "click", ...W, find: { label: "客户" } }); // cut report
      const qText = await look(W, { query: "选中|订单|客户|刷新" }); // prints the line beside [删除], not the button
      await after(W, admin("丙", "选中：订单 DD1003"));
      await call("act", { action: "click", ...W, find: { label: "刷新" } }); // cut again; the page is back at DD1003
      await log();
      const b4 = await press(W, { label: "删除" });
      lg = await log();
      check("round 11: the model's newest look printed '选中：客户 张伟' (the text beside 删除, not the button); behind a cut report it is DD1003 again as the old full view had it — held: its newest knowledge of that spot is 张伟", qText.includes("张伟") && !/AXButton "删除"/.test(qText) && b4.isError && textOf(b4).includes('"选中：订单 DD1003" (it was "选中：客户 张伟（含全部订单）")') && lg.actions.length === 0, `${qText.slice(0, 160)} | ${textOf(b4)}`);
      W = await win(1016, admin("甲", "选中：订单 DD1003"));
      await look(W);
      await after(W, admin("乙", "选中：订单 DD1005"));
      await call("act", { action: "click", ...W, find: { label: "刷新" } }); // cut report
      const b2a = await press(W, { label: "删除" }); // held: says DD1005
      await after(W, admin("乙", "选中：客户 张伟（含全部订单）"));
      const keyOnly = await call("act", { action: "key", pid: P, key: "down", observe: false }); // no window_id: nothing can be observed
      await log();
      const b2b = await press(W, { label: "删除" });
      lg = await log();
      check("round 11: held for 删除 beside DD1005; then a key sent with a pid only (no window to report on) moves the selection — it counts as an action on that window: the resend is held again and says 张伟", b2a.isError && !keyOnly.isError && b2b.isError && textOf(b2b).includes("张伟") && lg.actions.length === 0, `${textOf(keyOnly)} | ${textOf(b2b)}`);
      // "Brought out by this call" needs a walk of this call that lacks the control.
      const detail = (gen, withDel) => page("详情", [[1, "AXWebArea", "详情", { web: true }], B(2, "刷新", F(20, 20)), ...filler(gen), ...(withDel ? [St(2, "详情：客户 张伟（含全部订单）", F(20, 3000, 300)), B(2, "删除", F(400, 3000))] : [])]);
      for (const [wid, first] of [[1017, { action: "click", find: { label: "刷新" } }], [1018, { action: "key", key: "down" }]]) {
        W = await win(wid, detail("甲", false));
        await look(W);
        await after(W, detail("乙", false));
        await call("act", { action: "click", ...W, find: { label: "刷新" } }); // cut report: behind
        await reset(W, detail("乙", true)); // [删除] appears by itself, before the next call
        await log();
        const b5 = await call("act_batch", { ...W, steps: [first, { action: "click", find: { label: "删除" } }], observe: false });
        lg = await log();
        check(`round 11: a control that appeared by itself before the call is not "brought out" by its first step (${first.action === "key" ? "a key, which needs no walk — the hub walks first" : "a find that changes nothing"}): step 2 is held`, b5.isError && textOf(b5).includes("FAILED at step 2") && textOf(b5).includes("张伟") && lg.actions.length === 1, textOf(b5));
      }
      // A window whose record was dropped: one notice, then the hub starts afresh on it.
      W = await win(1019, FORM());
      await look(W);
      await ctl("fake_restart");
      await ctl("fake_set_window", { pid: P, window_id: 1019, rows: FORM({ sheet: true }) });
      await log();
      const x1 = await press(W, { label: "继续" });
      lg = await log();
      check("round 11: the driver restarted (every snapshot is gone) and a sheet came up meanwhile: the window is not treated as never looked at — find 继续 is held with the sheet's words", x1.isError && textOf(x1).includes("要继续吗") && lg.actions.length === 0, textOf(x1));
    });

    // 7.6o review round 12: what round 11 broke or left half done ---------------------------------------------------
    await section("7.6o round 12", async () => {
      const St = (d, t, o = {}) => [d, "AXStaticText", t, { a: [], ...o }];
      const B = (d, t, o = {}) => [d, "AXButton", t, { press: true, ...o }];
      const Lk = (d, t, o = {}) => [d, "AXLink", t, { press: true, ...o }];
      const TF = (d, t, v = "", o = {}) => [d, "AXTextField", t, { v, a: ["AXConfirm"], ...o }];
      const F = (x, y, w = 80, h = 24) => ({ f: [x, y, w, h] });
      const page = (title, rows) => [[0, "AXWindow", title, { a: ["AXRaise"] }], ...rows];
      const web = (rows) => [[1, "AXWebArea", "页", { web: true }], ...rows];
      const press = (W, find, extra = {}) => call("act", { action: "click", ...W, find, observe: false, ...extra });
      const hits = (lg) => lg.actions.map((a) => `${a.tool} ${a.target?.role} ${a.target?.label}`);
      const reset = (W, rows) => ctl("fake_set_window", { pid: P, window_id: W.window_id, rows });
      const after = (W, rows) => ctl("fake_after_action", { pid: P, window_id: W.window_id, rows });
      const look = async (W, extra = {}) => textOf(await call("window_state", { ...W, include_screenshot: false, ...extra }));
      const filler = (gen, n = 100) => Array.from({ length: n }, (_, i) => St(2, `流水 ${i}：${i % 2 === 0 ? gen : "不变"} 的一条比较长的记录，用来占字数`, F(20, 60 + 24 * i, 500)));
      const editor = [[1, "AXTextArea", "正文", { v: "草稿" }], B(1, "保存"), B(1, "关闭")];
      let lg;

      // S12-1: only a progress BAR makes a sheet "an operation running"; and its own buttons still answer what it says now.
      const keychain = (name) => page("钥匙串", [...editor, [1, "AXSheet", null, {}], St(2, `请为钥匙串“${name}”输入新密码`), [2, "AXSecureTextField", "新密码", { v: "", a: ["AXConfirm"] }], [2, "AXLevelIndicator", "密码强度", { v: "3" }], B(2, "取消"), B(2, "好")]);
      let W = await win(1101, keychain("login"));
      await look(W);
      await reset(W, keychain("系统"));
      await log();
      const lv = await press(W, { label: "好" });
      lg = await log();
      check("S12-1 a confirm sheet with a LEVEL indicator (a password-strength meter) is told apart by its texts like any other: another keychain is another sheet — held", lv.isError && textOf(lv).includes("系统") && lg.actions.length === 0, textOf(lv));
      const copying = (file, pct) => page("访达", [B(1, "新建文件夹"), [1, "AXSheet", null, {}], St(2, `正在拷贝“${file}”`), [2, "AXProgressIndicator", null, { v: String(pct / 100) }], B(2, "停止")]);
      W = await win(1102, copying("合同.docx", 10));
      await look(W);
      await reset(W, copying("全部客户资料.zip", 40));
      await log();
      const stop1 = await press(W, { label: "停止" });
      const stop2 = await press(W, { label: "停止" });
      await reset(W, copying("发票.pdf", 70));
      const outside = await press(W, { label: "新建文件夹" });
      lg = await log();
      check("S12-1 a copy sheet with a progress bar, another file by now: its own 停止 is held once with what it says now (the press answers that), then goes; with yet another file, a button OUTSIDE it is pressed without a hold", stop1.isError && textOf(stop1).includes("全部客户资料.zip") && !stop2.isError && !outside.isError && J(hits(lg)) === J(["click AXButton 停止", "click AXButton 新建文件夹"]), `${textOf(stop1)} | ${textOf(stop2)} | ${textOf(outside)}`);

      // S12-2: a list in a sheet is short by its ROWS; one that is left out is said to be.
      const table = (rows) => [[1, "AXSheet", null, {}], St(2, "将永久删除以下客户："), [2, "AXTable", null, {}], ...rows.flatMap((cells) => [[3, "AXRow", null, {}], ...cells.map((c) => St(4, c))]), B(2, "取消"), B(2, "删除")];
      const three = (p) => [1, 2, 3].map((k) => [`${p}${k}`, `${p}${k} 的电话`, `${p}${k} 的地址`]);
      W = await win(1103, page("客户", [...editor, ...table(three("甲"))]));
      await look(W);
      await reset(W, page("客户", [...editor, ...table(three("乙"))]));
      await log();
      const t33 = await press(W, { label: "删除" });
      W = await win(1104, page("客户", [...editor, ...table(Array.from({ length: 9 }, (_, k) => [`甲${k}`]))]));
      await look(W);
      await reset(W, page("客户", [...editor, ...table(Array.from({ length: 9 }, (_, k) => [`乙${k}`]))]));
      const t9 = await press(W, { label: "删除" });
      lg = await log();
      check("S12-2 three customers × three columns in a sheet's table: the hold prints all nine cells; a list of nine ROWS is left out and the reply says so", t33.isError && ["乙1", "乙2 的电话", "乙3 的地址"].every((x) => textOf(t33).includes(x)) && t9.isError && textOf(t9).includes("(+ a list of 9 rows not printed here)") && lg.actions.length === 0, `${textOf(t33)} | ${textOf(t9)}`);

      // S12-3: the state of a tick box the model cannot change is content.
      const forced = (v) => page("客户", [...editor, [1, "AXSheet", null, {}], St(2, "确认删除所选客户？"), [2, "AXCheckBox", "同时删除服务器上的全部历史订单", { press: true, en: false, v }], B(2, "取消"), B(2, "删除")]);
      W = await win(1105, forced("0"));
      await look(W);
      await reset(W, forced("1"));
      await log();
      const dis = await press(W, { label: "删除" });
      lg = await log();
      check("S12-3 a DISABLED tick box in a confirm sheet flips from 0 to 1: another sheet — held, and the reply prints its state", dis.isError && textOf(dis).includes("同时删除服务器上的全部历史订单 = 1") && lg.actions.length === 0, textOf(dis));

      // R12-S3: "an address that keeps moving under one path" is about the path the model was last shown.
      const shop = (id) => page("商城", [TF(1, "地址和搜索栏", `https://shop.example.com/orders/${id}`), [1, "AXWebArea", `订单 ${id}`, { web: true }], St(2, `订单 DD${id}`, F(20, 60)), B(2, "删除订单", F(20, 100)), B(2, "导出", F(120, 100))]);
      W = await win(1106, shop(1005));
      await look(W);
      await reset(W, shop(1006));
      const p1 = await press(W, { label: "导出" }); // held: 1005 → 1006
      const p2 = await press(W, { label: "导出" }); // the resend goes
      await reset(W, shop(1007));
      const shown = await look(W); // the model is shown 1007
      await reset(W, shop(1006)); // …and the page bounces back
      await log();
      const p3 = await press(W, { label: "删除订单" });
      lg = await log();
      check("R12-S3 held at orders/1006, then shown orders/1007, then the page is back at 1006 within the minute: another path than the one last shown — held, not just noted", p1.isError && !p2.isError && shown.includes("orders/1007") && p3.isError && textOf(p3).includes("the page address changed") && lg.actions.length === 0, `${textOf(p1).slice(0, 120)} | ${textOf(p3)}`);

      // H2-1: two observed steps between presses — the report before last shows the previous text, which is no news.
      const admin = (gen, sel) => page("后台", [[1, "AXWebArea", "后台", { web: true }], B(2, "订单", F(20, 20)), B(2, "刷新", F(200, 20)), ...filler(gen), St(2, sel, F(20, 3000, 300)), B(2, "删除", F(400, 3000))]);
      const selOf = (k) => `选中：订单 DD${1003 + 2 * k}`;
      W = await win(1107, admin("甲", selOf(0)));
      await look(W);
      await after(W, admin("乙", selOf(0)));
      const cutA = textOf(await call("act", { action: "click", ...W, find: { label: "刷新" } })); // cut: behind from here on
      const heldBy = [];
      let n = 0;
      for (let c = 0; c < 3; c++) {
        let h = 0;
        await after(W, admin("乙", selOf(n + 1))); // deleting moves the selection on
        for (let tries = 0; tries < 3; tries++) {
          const r = await call("act", { action: "click", ...W, find: { label: "删除" } });
          if (!r.isError) break;
          h++;
        }
        n++;
        for (let k = 0; k < 2; k++) {
          await after(W, admin("乙", selOf(n + 1)));
          await call("act", { action: "key", ...W, key: "down" }); // default report: prints the changed 选中 line
          n++;
        }
        heldBy.push(h);
      }
      lg = await log();
      check("H2-1 behind on the page: press 删除 (the selection moves on), two observed key steps that move it again, press again — three rounds, the page changing only by the model's own actions: no press is held (the report before last shows the previous selection, the last one the current)", cutA.includes("not every change is listed") && J(heldBy) === J([0, 0, 0]) && lg.actions.filter((a) => a.target?.label === "删除").length === 3, J(heldBy));

      // H2-3 and input sent past the facade: an action that names no window, or goes through desk_call, is still an action.
      for (const [wid, how, send] of [
        [1108, "an act with scope:desktop", () => call("act", { action: "click", scope: "desktop", x: 300, y: 300, observe: false })],
        [1109, "a desk_call press_key", () => call("desk_call", { server: "cua", tool: "press_key", args: { pid: P, window_id: 1109, key: "down" } })],
      ]) {
        W = await win(wid, admin("甲", "选中：订单 DD1001"));
        await look(W);
        await after(W, admin("乙", "选中：订单 DD1005"));
        await call("act", { action: "click", ...W, find: { label: "刷新" } }); // cut
        await after(W, admin("乙", "选中：订单 DD1005"));
        const first = await call("act", { action: "click", ...W, find: { label: "删除" } });
        const first2 = first.isError ? (await after(W, admin("乙", "选中：订单 DD1005")), await call("act", { action: "click", ...W, find: { label: "删除" } })) : first;
        const sent = await send();
        await reset(W, admin("乙", "选中：客户 张伟（含全部订单）")); // what that input did
        await log();
        const again = await press(W, { label: "删除" });
        lg = await log();
        check(`H2-3 after ${how} (nothing was observed after it) the record beside 删除 is another: the same find is held and says which`, !first2.isError && textOf(first2).includes("now lands on") && !sent.isError && again.isError && textOf(again).includes("张伟") && lg.actions.length === 0, `${textOf(sent).slice(0, 80)} | ${textOf(again)}`);
      }

      // The report's "now lands on" line is a view only of the control that was just pressed.
      const queue = (hasBtn) => page("审核", [[1, "AXWebArea", "审核", { web: true }], B(2, "刷新", F(20, 20)), Lk(2, "通过记录", F(110, 20)), ...filler("乙"), ...(hasBtn ? [B(2, "通过", F(20, 2530)), St(2, "DD1003", F(120, 2530))] : [])]);
      W = await win(1110, page("审核", [[1, "AXWebArea", "审核", { web: true }], B(2, "刷新", F(20, 20)), Lk(2, "通过记录", F(110, 20)), ...filler("甲"), B(2, "通过", F(20, 2530)), St(2, "DD1003", F(120, 2530))]));
      await look(W);
      await after(W, queue(true));
      await call("act", { action: "click", ...W, find: { label: "刷新" } }); // cut
      await after(W, queue(false)); // the last order: its 通过 goes with it
      const last = textOf(await call("act", { action: "click", ...W, find: { label: "通过", nth: 0 } }));
      await log();
      const other = await press(W, { label: "通过", nth: 0 });
      lg = await log();
      check("round 12: the last 通过 is used up and the same find would now land on the link 通过记录 — the report says so, but that is no view of the control just pressed: the same find again is held", last.includes('now lands on') && last.includes('AXLink "通过记录"') && other.isError && lg.actions.length === 0, `${last.slice(-200)} | ${textOf(other)}`);

      // set_value: a disabled field of that name and a longer-named button are two things to list, not a field to write into.
      W = await win(1111, page("搜索", web([TF(2, "搜索", "", { en: false, ...F(20, 20, 200) }), B(2, "搜索历史", F(240, 20))])));
      const sv = await call("act", { action: "set_value", ...W, find: { label: "搜索" }, value: "空气炸锅", observe: false });
      lg = await log();
      check("round 12: set_value 搜索 with a DISABLED field 搜索 and a button 搜索历史 — refused with both listed (as in round 10), not sent to the disabled field", sv.isError && textOf(sv).includes("2 controls match") && textOf(sv).includes("[disabled]") && lg.actions.length === 0, textOf(sv));
    });

    // 7.6p review round 13: what round 12 broke or left half done (a review of that round's diff only) -----------------
    await section("7.6p round 13", async () => {
      const St = (d, t, o = {}) => [d, "AXStaticText", t, { a: [], ...o }];
      const B = (d, t, o = {}) => [d, "AXButton", t, { press: true, ...o }];
      const F = (x, y, w = 80, h = 24) => ({ f: [x, y, w, h] });
      const page = (title, rows) => [[0, "AXWindow", title, { a: ["AXRaise"] }], ...rows];
      const web = (rows) => [[1, "AXWebArea", "页", { web: true }], ...rows];
      const press = (W, find, extra = {}) => call("act", { action: "click", ...W, find, observe: false, ...extra });
      const reset = (W, rows) => ctl("fake_set_window", { pid: P, window_id: W.window_id, rows });
      const after = (W, rows) => ctl("fake_after_action", { pid: P, window_id: W.window_id, rows });
      const look = async (W, extra = {}) => textOf(await call("window_state", { ...W, include_screenshot: false, ...extra }));
      const filler = (gen, n = 100, y0 = 60) => Array.from({ length: n }, (_, i) => St(2, `流水 ${i}：${i % 2 === 0 ? gen : "不变"} 的一条比较长的记录，用来占字数`, F(20, y0 + 24 * i, 500)));
      const cut = async (W) => textOf(await call("act", { action: "click", ...W, find: { label: "刷新" } })).includes("not every change is listed");
      let lg;

      // S13-1 (find): a line is a line for every look-alike on it, or for none.
      const pairs = (n, low) => Array.from({ length: n }, (_, i) => [St(2, `name${i}`, F(20 + i * 160, 100, 70)), B(2, "移除", F(100 + i * 160, i === low ? 108 : 100, 50))]).flat();
      const total = (n) => St(2, `合计 ${n} 人`, F(20 + n * 160, 90, 80)); // level with the standard buttons, not with one that sits 8 px lower
      let W = await win(1201, page("成员", web([...pairs(100, 50), total(100)])));
      await look(W);
      await log();
      const low = await press(W, { label: "移除", near: "name51" });
      const chip = pairs(100, -1);
      chip.splice(101, 1, [2, "AXGroup", "已选", { press: true, f: [98 + 50 * 160, 100, 56, 24] }], [3, "AXButton", "移除", { press: true, ...F(100 + 50 * 160, 100, 50) }]);
      W = await win(1202, page("成员", web(chip)));
      await look(W);
      const wrapped = await press(W, { label: "移除", near: "name51" });
      lg = await log();
      check("S13-1 a 201-item line where ONE 移除 sees a shorter line than its neighbours (8 px lower; inside a pressable chip): it is not the only one left with line evidence — near name51 presses nothing", low.isError && wrapped.isError && lg.actions.length === 0, `${textOf(low).slice(0, 200)} | ${textOf(wrapped).slice(0, 200)}`);

      // S13-2 (find): past the line limit the nearest part of the line is still what stands beside the control.
      const longline = (sel, n) => [
        ...Array.from({ length: n }, (_, i) => St(2, `标签${i}`, F(20 + i * 90, 44))),
        St(2, sel, F(20 + n * 90, 44)), St(2, "金额 ¥120", F(20 + (n + 1) * 90, 44)), St(2, "状态 待审", F(20 + (n + 2) * 90, 44)), B(2, "删除", F(20 + (n + 3) * 90, 44)),
        ...Array.from({ length: n }, (_, i) => St(2, `备注${i}`, F(20 + (n + 5 + i) * 90, 44))),
      ];
      const wide = (gen, sel) => page("后台", [[1, "AXWebArea", "后台", { web: true }], B(2, "刷新", F(20, 10)), ...longline(sel, 120), ...filler(gen, 100, 80)]);
      W = await win(1203, wide("甲", "选中：订单 DD1003"));
      await look(W);
      await after(W, wide("乙", "选中：订单 DD1003"));
      const cutW = await cut(W);
      await reset(W, wide("乙", "选中：订单 DD1005")); // by itself
      await log();
      const far = await press(W, { label: "删除" });
      const far2 = await press(W, { label: "删除" });
      lg = await log();
      check("S13-2 behind on a page whose 删除 stands on a 244-item line, the record text three cells before it changes by itself: held with the new text (a line too long for near is still what stands beside the control), and the resend goes", cutW && far.isError && textOf(far).includes("DD1005") && !far2.isError && lg.actions.length === 1, `${textOf(far).slice(0, 300)} | ${textOf(far2).slice(0, 120)}`);

      // S13-3 (find) = S13-2 (second): a text beside the control that did not change is in no report, and need not be.
      const admin = (gen, sel) => page("后台", [[1, "AXWebArea", "后台", { web: true }], B(2, "订单", F(20, 20)), B(2, "刷新", F(200, 20)), ...filler(gen), St(2, sel, F(20, 3000, 300)), St(2, "状态：待处理", F(330, 3000, 60)), B(2, "删除", F(400, 3000))]);
      const selOf = (k) => `选中：订单 DD${1003 + 2 * k}`;
      W = await win(1204, admin("甲", selOf(0)));
      await look(W);
      await after(W, admin("乙", selOf(0)));
      const cutA = await cut(W);
      const heldBy = [];
      let n = 0;
      await log();
      for (let c = 0; c < 3; c++) {
        let h = 0;
        await after(W, admin("乙", selOf(n + 1)));
        for (let tries = 0; tries < 3; tries++) {
          const r = await call("act", { action: "click", ...W, find: { label: "删除" } });
          if (!r.isError) break;
          h++;
        }
        n++;
        for (let k = 0; k < 2; k++) {
          await after(W, admin("乙", selOf(n + 1)));
          await call("act", { action: "key", ...W, key: "down" });
          n++;
        }
        heldBy.push(h);
      }
      await reset(W, admin("乙", selOf(n)).map((r) => (r[2] === "状态：待处理" ? [r[0], r[1], "状态：已发货，不可删除", r[3]] : r))); // by itself, printed by nobody
      const locked = await press(W, { label: "删除" });
      lg = await log();
      check("S13-3 the round-12 flow (press 删除, two observed key steps, press again — three rounds) with a second text beside 删除 that never changes: no press is held; and when THAT text then changes by itself, the next press is", cutA && J(heldBy) === J([0, 0, 0]) && locked.isError && textOf(locked).includes("已发货") && lg.actions.filter((a) => a.target?.label === "删除").length === 3, `${J(heldBy)} | ${textOf(locked).slice(0, 300)}`);

      // S13-1 (second): the walk before a batch's first step is skipped only for a token step BEFORE its first find.
      const cust = (gen, pane) => page("客户", [[1, "AXWebArea", "客户", { web: true }], B(2, "刷新", F(20, 20)), B(2, "详情", F(120, 20)), ...filler(gen), ...(pane ? [[2, "AXGroup", "详情栏", {}], St(3, `详情：${pane}`, F(20, 3000, 300)), B(3, "删除", F(400, 3000))] : [])]);
      W = await win(1205, cust("甲", null));
      await look(W);
      await after(W, cust("乙", null));
      const cutB = await cut(W);
      const q = await look(W, { query: "刷新" });
      await reset(W, cust("乙", "客户 张伟（含全部订单）")); // the pane opens by itself
      await log();
      const batch = await call("act_batch", { ...W, steps: [{ action: "key", key: "down" }, { action: "click", find: { label: "删除" } }, { action: "click", element_token: `${sidOf(q)}:${rowOf(q, "AXButton", "刷新")}` }], observe: false });
      lg = await log();
      check("S13-1 behind on a window, a pane with 删除 opened by itself; batch [key, find 删除, token 刷新]: the token step comes after the find, so the window is walked before the key — 删除 is held as not shown, only the key went out", cutB && batch.isError && textOf(batch).includes("FAILED at step 2") && textOf(batch).includes("changed by more than you were shown") && J(lg.actions.map((a) => a.tool)) === J(["press_key"]), textOf(batch).slice(0, 500));

      // S13-5 (second): the "now lands on" line counts for a find that names part of the label.
      const ids = ["DD1001", "DD1003", "DD1005", "DD1007", "DD1009"];
      const queue = (gen, rest) => page("审批", [[1, "AXWebArea", "审批", { web: true }], B(2, "刷新", F(20, 20)), ...filler(gen), ...rest.flatMap((id, i) => [[2, "AXGroup", null, {}], St(3, `订单 ${id} 待审批`, F(20, 3000 + 30 * i, 300)), B(3, `通过 ${id}`, F(400, 3000 + 30 * i)), B(3, `驳回 ${id}`, F(500, 3000 + 30 * i))])]);
      W = await win(1206, queue("甲", ids));
      await look(W);
      await after(W, queue("乙", ids));
      const cutQ = await cut(W);
      let calls = 0;
      await log();
      for (let k = 0; k < 4; k++) {
        await after(W, queue("乙", ids.slice(k + 1)));
        for (let tries = 0; tries < 3; tries++) {
          calls++;
          if (!(await call("act", { action: "click", ...W, find: { label: "通过", nth: 0 } })).isError) break;
        }
      }
      lg = await log();
      check("S13-5 a queue whose buttons carry the order in their name (通过 DD1001 …), approved by find {label:\"通过\", nth:0}: four orders, four calls — the report's \"now lands on 通过 DD1003\" is a view of the next one", cutQ && calls === 4 && J(lg.actions.map((a) => a.target?.label)) === J(ids.slice(0, 4).map((id) => `通过 ${id}`)), `${calls} calls | ${J(lg.actions.map((a) => a.target?.label))}`);

      // Round 13, second pass (the part of round 12 nobody had reviewed, and the first pass's own fixes).
      const editor = [[1, "AXTextArea", "正文", { v: "草稿" }], B(1, "保存"), B(1, "关闭")];
      const tick = (name, en, v, role = "AXCheckBox") => [2, role, name, { press: true, en, v: String(v) }];
      // SH-2: in a sheet with a progress bar the stage ticks move by themselves, like its texts.
      const stages = ["下载", "校验", "安装", "清理"];
      const inst = (stage, pct) => page("安装器", [B(1, "新建文件夹"), B(1, "显示简介"), [1, "AXSheet", null, {}], St(2, "正在安装更新"), ...stages.map((t, k) => tick(t, false, k < stage ? 1 : 0)), [2, "AXProgressIndicator", null, { v: String(pct) }], B(2, "停止")]);
      W = await win(1207, inst(1, 0.2));
      await look(W);
      await log();
      const outside = [];
      for (const st of [2, 3]) {
        await reset(W, inst(st, st / 5));
        outside.push(await call("act", { action: "click", ...W, find: { label: st % 2 ? "显示简介" : "新建文件夹" } }));
      }
      await reset(W, inst(4, 0.8));
      const stopA = await press(W, { label: "停止" });
      const stopB = await press(W, { label: "停止" });
      lg = await log();
      check("SH-2 an installer sheet with a progress bar whose stages are disabled tick boxes, shown whole; the stages advance by themselves: steps OUTSIDE it are not held (round 12 made every stage another sheet); its own 停止 is held once with the ticks as they stand, then goes", outside.every((r) => !r.isError) && stopA.isError && textOf(stopA).includes("清理 = 1") && !stopB.isError && J(lg.actions.map((a) => a.target?.label)) === J(["新建文件夹", "显示简介", "停止"]), `${outside.map((r) => textOf(r).slice(0, 160)).join(" | ")} | ${textOf(stopA).slice(0, 300)} | ${textOf(stopB).slice(0, 80)}`);

      // SH-1, as it stands since round 16: a forced tick box that becomes changeable makes the sheet another one,
      // whatever it reads — one held call, the reply prints the sheet, the same step again goes. (Rounds 13 to 15
      // told "released as it was" from "released and changed", and three times a changed state got through.)
      const steps = ["", "网络", "账号", "同步", "隐私"];
      const wiz = (k, en) => page("客户", [...editor, [1, "AXSheet", null, {}], St(2, `设置${steps[k]}`), tick("使用推荐设置", en, 1), B(2, "上一步"), B(2, "下一步")]);
      W = await win(1208, wiz(1, true));
      await look(W);
      await log();
      let wizCalls = 0;
      for (let k = 1; k <= 3; k++) {
        await after(W, wiz(k + 1, false)); // the next page, its box forced while it loads
        for (let tries = 0; tries < 3; tries++) {
          wizCalls++;
          if (!(await call("act", { action: "click", ...W, find: { label: "下一步" } })).isError) break;
        }
        await reset(W, wiz(k + 1, true)); // loaded: the box is the model's to set again, still ticked
      }
      const wizLog = await log();
      const del = (en, v) => page("客户", [...editor, [1, "AXSheet", null, {}], St(2, "确认删除客户张三？"), tick("同时删除全部历史订单", en, v), B(2, "取消"), B(2, "删除")]);
      W = await win(1209, del(false, 0));
      await look(W);
      await reset(W, del(true, 1)); // released AND ticked, by itself
      const other = await press(W, { label: "删除" });
      lg = await log();
      check("SH-1 a wizard whose pages hold a tick box that is disabled while the page loads and enabled a moment later, same state: each release costs one held call and no more — 下一步 ×3 takes five calls, three presses sent; a forced box shown as 0 that is released reading 1 is held the same way", wizCalls === 5 && wizLog.actions.length === 3 && other.isError && textOf(other).includes("have not been shown") && lg.actions.length === 0, `${wizCalls} calls | ${textOf(other).slice(0, 300)}`);

      // Round 14 (a review of the second pass's own diff).
      // R14-1: a state is compared control by control, not as a bag of "name=state" lines.
      const range = (en, a, b) => page("报表", [...editor, [1, "AXSheet", null, {}], St(2, "导出范围"), tick("最近 7 天", en, a, "AXRadioButton"), tick("最近 30 天", en, b, "AXRadioButton"), B(2, "取消"), B(2, "导出")]);
      W = await win(1210, range(false, 1, 0));
      await look(W);
      await reset(W, range(true, 0, 1)); // released, and the selection moved with it
      await log();
      const moved = await press(W, { label: "导出" });
      const movedLog = await log(); // (win() clears the log)
      const same = (v1, v2, en1) => page("清理", [...editor, [1, "AXSheet", null, {}], St(2, "将清理以下内容"), tick("包含附件", en1, v1), tick("包含附件", true, v2), B(2, "取消"), B(2, "清理")]);
      W = await win(1211, same(0, 0, false));
      await look(W);
      await reset(W, same(1, 0, true)); // the first box of that name released AND ticked; the second still reads 0
      const twin = await press(W, { label: "清理" });
      lg = await log();
      check("R14-1 a forced radio pair (最近 7 天 = 1, 最近 30 天 = 0) released with the selection moved, and of two tick boxes of one name the forced one released and ticked: neither is the sheet that was shown — held (the names fold to the same line; states are compared place by place)", moved.isError && textOf(moved).includes("have not been shown") && movedLog.actions.length === 0 && twin.isError && lg.actions.length === 0, `${textOf(moved).slice(0, 260)} | ${textOf(twin).slice(0, 200)}`);

      // R14-3, as it stands since round 16: in a sheet with a progress bar the state lives in its words — a
      // released box changes them, and the sheet's own button is held once, whatever the box reads.
      const pay = (en, v, amount = "¥100.00") => page("转账", [...editor, [1, "AXSheet", null, {}], St(2, `向 李四 转账 ${amount}`), tick("短信通知收款人", en, v), [2, "AXProgressIndicator", "步骤", { v: "0.66" }], B(2, "取消"), B(2, "确认转账")]);
      W = await win(1212, pay(false, 1));
      await look(W);
      await reset(W, pay(true, 1)); // released, same state
      await log();
      const freed = await press(W, { label: "确认转账" });
      const freedAgain = await press(W, { label: "确认转账" });
      const freedLog = await log();
      W = await win(1213, pay(false, 0));
      await look(W);
      await reset(W, pay(true, 1)); // released AND ticked
      const flipped = await press(W, { label: "确认转账" });
      lg = await log();
      check("R14-3 a confirm sheet with a step bar whose forced tick box is released: its own 确认转账 is held once (the reply prints the box as it reads now), then goes; released reading another state: held too", freed.isError && textOf(freed).includes("短信通知收款人") && !freedAgain.isError && freedLog.actions.length === 1 && flipped.isError && lg.actions.length === 0, `${textOf(freed).slice(0, 200)} | ${textOf(freedAgain).slice(0, 120)} | ${textOf(flipped).slice(0, 200)}`);

      // A progress sheet's own button is held when its texts are not the ones shown — whichever step of a call
      // presses it, and whatever change list came in between.
      const copying = (file, pct) => page("访达", [B(1, "新建文件夹"), B(1, "刷新"), [1, "AXSheet", null, {}], St(2, `正在拷贝“${file}”`), [2, "AXProgressIndicator", null, { v: String(pct) }], B(2, "停止")]);
      W = await win(1214, copying("合同.docx", 0.1));
      await look(W);
      await reset(W, copying("全部客户资料.zip", 0.4)); // by itself
      await log();
      const both = await call("act_batch", { ...W, steps: [{ action: "click", find: { label: "新建文件夹" } }, { action: "click", find: { label: "停止" } }], observe: false });
      const bothLog = await log();
      W = await win(1215, copying("合同.docx", 0.1));
      await look(W);
      await reset(W, copying("全部客户资料.zip", 0.4)); // by itself
      await press(W, { label: "新建文件夹" }); // a walk nobody is shown
      await after(W, copying("全部客户资料.zip", 0.5));
      const listed = textOf(await call("act", { action: "click", ...W, find: { label: "刷新" } })); // its report lists the bar moving, against that walk
      await log();
      const stale = await press(W, { label: "停止" });
      const staleLog = await log();
      W = await win(1216, copying("合同.docx", 0.1));
      await look(W);
      await after(W, copying("全部客户资料.zip", 0.4));
      const seen = textOf(await call("act", { action: "click", ...W, find: { label: "刷新" } })); // against the model's own view: the report prints the new file
      await log();
      const fresh = await press(W, { label: "停止" });
      lg = await log();
      check("round 14: a copy sheet moved on to another file by itself. A batch [新建文件夹, 停止] is held at 停止 (the first step went); after a walk nobody was shown, a report that lists only the bar moving does not make the new file shown — 停止 is held; a report made against the model's own view prints the new file, and 停止 goes", both.isError && textOf(both).includes("FAILED at step 2") && J(bothLog.actions.map((a) => a.target?.label)) === J(["新建文件夹"]) && listed.includes("AXProgressIndicator") && !listed.includes("全部客户资料") && stale.isError && staleLog.actions.length === 0 && seen.includes("全部客户资料.zip") && !fresh.isError && lg.actions.length === 1, `${textOf(both).slice(0, 200)} | ${listed.slice(0, 200)} | ${textOf(stale).slice(0, 160)} | ${textOf(fresh).slice(0, 120)}`);
      const wizBar = (k) => page("向导", [B(1, "帮助"), [1, "AXSheet", null, {}], St(2, `第 ${k} 步：${steps[k]}`), [2, "AXProgressIndicator", "步骤", { v: String(k / 4) }], B(2, "下一步")]);
      W = await win(1217, wizBar(1));
      await look(W);
      await after(W, wizBar(2));
      await log();
      const twice = await call("act_batch", { ...W, steps: [{ action: "click", find: { label: "下一步" } }, { action: "click", find: { label: "下一步" } }], observe: false });
      lg = await log();
      check("…and a wizard with a step bar, shown whole: [下一步, 下一步] in one batch goes — what the first step changed in the sheet is the call's own doing", !twice.isError && lg.actions.length === 2, textOf(twice).slice(0, 300));

      // Round 15 (a review of round 14's diff).
      // H15-1 (and what H15-3 asked for, given up in round 16): a released box is another sheet, with or without
      // a nameless button coming or going beside it.
      const icon = [2, "AXButton", null, { press: true }]; // a nameless button: it says nothing
      const purge = (rows) => page("清理", [...editor, [1, "AXSheet", null, {}], St(2, "确认清理历史订单？"), ...rows, B(2, "取消"), B(2, "确认清理")]);
      W = await win(1218, purge([icon, tick("删除 2023 年订单", false, 1), tick("删除 2024 年订单", true, 1)]));
      await look(W);
      await reset(W, purge([tick("删除 2023 年订单", true, 0), tick("删除 2024 年订单", true, 1)])); // the icon button gone; 2023 released reading 0
      await log();
      const shifted = await press(W, { label: "确认清理" });
      const shiftedLog = await log();
      W = await win(1219, purge([icon, tick("同时清理附件", false, 1)]));
      await look(W);
      await reset(W, purge([tick("同时清理附件", true, 1)])); // the (loading) icon button gone; the box released as it was
      const steady = await press(W, { label: "确认清理" });
      lg = await log();
      check("H15-1 a nameless button before two look-alike boxes goes away as the forced one (shown 1) is released reading 0: the other box (1) does not stand in for it — held; the same button going away as a box is released with the state it had: held as well (no hand-on any more)", shifted.isError && shiftedLog.actions.length === 0 && steady.isError && lg.actions.length === 0, `${textOf(shifted).slice(0, 200)} | ${textOf(steady).slice(0, 200)}`);

      // W15-1 / W15-4 / H15-2: a complete list from the model's own view is credited, whatever was printed since.
      const phases = ["下载", "校验", "解压", "写入"];
      const setup = (k, pct) => page("安装器", [B(1, "帮助"), [1, "AXSheet", null, {}], St(2, "正在安装 办公套件"), St(2, `当前阶段：${phases[k]}`), [2, "AXProgressIndicator", null, { v: String(pct) }], B(2, "暂停"), B(2, "后台运行")]);
      W = await win(1220, setup(0, 0.05));
      await look(W);
      await reset(W, setup(1, 0.2)); // by itself
      await log();
      const pause1 = await press(W, { label: "暂停" }); // held: the reply prints the sheet whole, with 校验
      await reset(W, setup(2, 0.4)); // by itself again
      const d2 = await look(W, { diff: true }); // from the model's own view: lists 解压
      const pause2 = await press(W, { label: "暂停" });
      const pauseLog = await log();
      const wizB = (k, en) => page("向导", [B(1, "帮助"), [1, "AXSheet", null, {}], St(2, `第 ${k} 步：${steps[k]}`), tick("使用推荐设置", en, 0), [2, "AXProgressIndicator", "步骤", { v: String(k / 4) }], B(2, "下一步")]);
      W = await win(1221, wizB(1, true));
      await look(W);
      let barCalls = 0;
      for (let k = 1; k <= 3; k++) {
        await after(W, wizB(k + 1, false)); // the next page, its box forced while it loads
        for (let tries = 0; tries < 3; tries++) {
          barCalls++;
          if (!(await call("act", { action: "click", ...W, find: { label: "下一步" } })).isError) break;
        }
        await reset(W, wizB(k + 1, true)); // loaded: released, same state
      }
      lg = await log();
      check("W15-1 an installer's stage moves by itself, its own 暂停 is held (the reply prints the sheet), the stage moves again and a diff:true look lists it: 暂停 goes — the list starts from the model's own view; a wizard with a step bar whose box is released by itself on each page: 下一步 is held once per release (five calls for three pages), not more", pause1.isError && textOf(pause1).includes("校验") && d2.includes("解压") && !pause2.isError && pauseLog.actions.length === 1 && barCalls === 5 && lg.actions.length === 3, `${textOf(pause1).slice(0, 160)} | ${d2.slice(0, 200)} | ${textOf(pause2).slice(0, 160)} | ${barCalls} calls`);

      // W15-3: with another button in it the sheet has another signature — its texts are not shown by that either.
      const copy2 = (file, pct, second) => page("访达", [B(1, "新建文件夹"), B(1, "刷新"), [1, "AXSheet", null, {}], St(2, `正在拷贝“${file}”`), [2, "AXProgressIndicator", null, { v: String(pct) }], B(2, "停止"), B(2, second)]);
      W = await win(1222, copy2("合同.docx", 0.1, "暂停"));
      await look(W);
      await reset(W, copy2("全部客户资料.zip", 0.4, "暂停")); // by itself
      await press(W, { label: "新建文件夹" }); // a walk nobody is shown
      await after(W, copy2("全部客户资料.zip", 0.5, "继续"));
      const swapRep = textOf(await call("act", { action: "click", ...W, find: { label: "刷新" } })); // lists the button and the bar
      await log();
      const swapStop = await press(W, { label: "停止" });
      lg = await log();
      check("W15-3 a copy sheet moved on to another file by itself; after a walk nobody was shown, a report lists that its button 暂停 now reads 继续 (another signature) and the bar — not the file: 停止 is held", swapRep.includes("继续") && !swapRep.includes("全部客户资料") && swapStop.isError && textOf(swapStop).includes("全部客户资料.zip") && lg.actions.length === 0, `${swapRep.slice(0, 260)} | ${textOf(swapStop).slice(0, 200)}`);

      // Round 16 (a review of round 15's diff).
      // L16-1: the bar turning indeterminate (or going away) is another signature too.
      const copy3 = (file, bar) => page("访达", [B(1, "新建文件夹"), B(1, "刷新"), [1, "AXSheet", null, {}], St(2, `正在拷贝“${file}”`), [2, "AXProgressIndicator", null, bar === null ? {} : { v: String(bar) }], B(2, "停止")]);
      W = await win(1223, copy3("合同.docx", 0.1));
      await look(W);
      await reset(W, copy3("全部客户资料.zip", 0.4)); // by itself
      await press(W, { label: "新建文件夹" }); // a walk nobody is shown
      await after(W, copy3("全部客户资料.zip", null)); // the bar turns indeterminate
      const spinRep = textOf(await call("act", { action: "click", ...W, find: { label: "刷新" } }));
      await log();
      const spinStop = await press(W, { label: "停止" });
      lg = await log();
      check("L16-1 the same with the bar turning indeterminate at that report (a sheet without a numeric bar is another signature): the report does not print the file, 停止 is held and the hold does", !spinRep.includes("全部客户资料") && spinStop.isError && textOf(spinStop).includes("全部客户资料.zip") && lg.actions.length === 0, `${spinRep.slice(0, 220)} | ${textOf(spinStop).slice(0, 200)}`);

      // L16-2: a whole look cut by the size cap AFTER the sheet's rows vouches for the sheet like an uncut one.
      const bigSetup = (k, pct) => page("安装器", [B(1, "帮助"), [1, "AXSheet", null, {}], St(2, "正在安装 办公套件"), St(2, `当前阶段：${phases[k]}`), [2, "AXProgressIndicator", null, { v: String(pct) }], B(2, "暂停"), B(2, "后台运行"), [1, "AXGroup", "列表", {}], ...filler("甲", 400)]);
      W = await win(1224, bigSetup(0, 0.05));
      const bigLook = await look(W);
      await reset(W, bigSetup(1, 0.2)); // by itself
      await log();
      const bigP1 = await press(W, { label: "暂停" }); // held: prints the sheet whole
      await reset(W, bigSetup(2, 0.4));
      const bigD = await look(W, { diff: true });
      const bigP2 = await press(W, { label: "暂停" });
      lg = await log();
      check("L16-2 the W15-1 flow in a window larger than the size cap (the whole look was cut, after the sheet's rows): the complete list from that view is credited all the same — the second 暂停 goes", bigLook.includes("当前阶段：下载") && !bigLook.includes("流水 399") && bigP1.isError && bigD.includes("解压") && !bigP2.isError && lg.actions.length === 1, `look ${bigLook.length} chars | ${textOf(bigP1).slice(0, 120)} | ${bigD.slice(0, 160)} | ${textOf(bigP2).slice(0, 160)}`);
    });
  } finally {
    await H.c.close().catch(() => {});
  }
}

// 7.6k the "acted without looking" window, made short (round 9, R9-7): a picture
// taken after the model's own action does not end it — time does.
{
  const H = await fakeHub("smoke-fake-blind", { DESKTOP_HUB_TEST_BLIND_MS: "1500" });
  const { call, ctl, log, win } = H;
  try {
    await section("7.6k blind window", async () => {
      const B = (d, t) => [d, "AXButton", t, { press: true }];
      const editor = [[0, "AXWindow", "编辑器", { a: ["AXRaise"] }], [1, "AXTextArea", "正文", { v: "草稿" }], B(1, "保存"), B(1, "关闭")];
      const withSheet = [...editor, [1, "AXSheet", null, {}], [2, "AXStaticText", "登录已过期，放弃未保存的修改并退出？", { a: [] }], B(2, "取消"), B(2, "确定")];
      let W = await win(861, editor);
      let v = textOf(await call("window_state", { ...W, include_screenshot: false }));
      await ctl("fake_after_action", { pid: P, window_id: 861, rows: withSheet });
      await call("act", { action: "click", ...W, element_token: `${sidOf(v)}:${rowOf(v, "AXButton", "保存")}`, observe: { tree: false } });
      await log();
      const soon = await call("act", { action: "click", ...W, find: { label: "确定" }, observe: false });
      let lg = await log();
      check("R9-7 click 保存 with a screenshot-only report, a sheet is up right after: find 确定 a moment later goes through (it follows the model's own action)", !soon.isError && lg.actions.length === 1, textOf(soon));
      W = await win(862, editor);
      v = textOf(await call("window_state", { ...W, include_screenshot: false }));
      await call("act", { action: "click", ...W, element_token: `${sidOf(v)}:${rowOf(v, "AXButton", "保存")}`, observe: { tree: false } });
      await new Promise((r) => setTimeout(r, 1900));
      await ctl("fake_set_window", { pid: P, window_id: 862, rows: withSheet });
      await log();
      const late = await call("act", { action: "click", ...W, find: { label: "确定" }, observe: false });
      lg = await log();
      check("R9-7 …but once that moment has passed, a sheet that opened by itself is held, although a picture was taken in between", late.isError && textOf(late).includes("have not been shown") && lg.actions.length === 0, textOf(late));
      // H10-11: the model pressed a sheet away without a walk after it; one of the same words that is up later is not known to be that one.
      W = await win(863, withSheet);
      v = textOf(await call("window_state", { ...W, include_screenshot: false }));
      await ctl("fake_after_action", { pid: P, window_id: 863, rows: editor });
      await call("act", { action: "click", ...W, element_token: `${sidOf(v)}:${rowOf(v, "AXButton", "取消")}`, observe: { tree: false } });
      await new Promise((r) => setTimeout(r, 1900));
      await ctl("fake_set_window", { pid: P, window_id: 863, rows: withSheet });
      await log();
      const again = await call("act", { action: "click", ...W, find: { label: "确定" }, observe: false });
      lg = await log();
      check("H10-11 a sheet the model dismissed (no walk after) is up again with the same words, long after: find 确定 is held — the earlier one is not this one", again.isError && textOf(again).includes("登录已过期") && lg.actions.length === 0, textOf(again));
      // Round 11: what can dismiss a sheet, and what cannot.
      const TFd = (d, t, v = "") => [d, "AXTextField", t, { v, a: ["AXConfirm"] }];
      const saveSheet = [...editor, [1, "AXSheet", null, {}], [2, "AXStaticText", "存储为：", { a: [] }], TFd(2, "名称", "未命名"), [2, "AXCheckBox", "隐藏扩展名", { press: true, v: "0" }], B(2, "取消"), B(2, "存储")];
      W = await win(864, saveSheet);
      v = textOf(await call("window_state", { ...W, include_screenshot: false }));
      await call("act", { action: "set_value", ...W, find: { label: "名称" }, value: "报价单", observe: false });
      await call("act", { action: "click", ...W, find: { label: "隐藏扩展名" }, observe: false });
      await new Promise((r) => setTimeout(r, 1900));
      await log();
      const typed = await call("act", { action: "click", ...W, find: { label: "存储" }, observe: false });
      lg = await log();
      check("round 11: typing a name into a save sheet and ticking its box (observe:false), then a model turn later 存储: not held — a value or a tick does not dismiss a sheet, so it is still the one the model was shown", !typed.isError && lg.actions.length === 1, textOf(typed));
      for (const [wid, how, step] of [[865, "the escape key", { action: "key", key: "escape" }], [866, "a pixel click", { action: "click", x: 40, y: 40 }]]) {
        W = await win(wid, withSheet);
        await call("window_state", { ...W }); // with a screenshot: pixel clicks need the scale
        await ctl("fake_after_action", { pid: P, window_id: wid, rows: editor });
        const gone = await call("act", { ...step, ...W, observe: false });
        await new Promise((r) => setTimeout(r, 1900));
        await ctl("fake_set_window", { pid: P, window_id: wid, rows: withSheet });
        await log();
        const back = await call("act", { action: "click", ...W, find: { label: "确定" }, observe: false });
        lg = await log();
        check(`round 11: a sheet dismissed by ${how} (no walk after) and up again with the same words long after: find 确定 is held`, !gone.isError && back.isError && textOf(back).includes("登录已过期") && lg.actions.length === 0, `${textOf(gone)} | ${textOf(back)}`);
      }
      // Round 12: the doubt about a possibly dismissed sheet is settled by a walk moments after THAT action only.
      W = await win(867, withSheet);
      v = textOf(await call("window_state", { ...W, include_screenshot: false }));
      await ctl("fake_after_action", { pid: P, window_id: 867, rows: editor });
      await call("act", { action: "click", ...W, element_token: `${sidOf(v)}:${rowOf(v, "AXButton", "取消")}`, observe: { tree: false } });
      await new Promise((r) => setTimeout(r, 1900));
      await ctl("fake_set_window", { pid: P, window_id: 867, rows: withSheet });
      const typedX = await call("act", { action: "type", ...W, text: "x" }); // default report: a walk, long after the click
      await new Promise((r) => setTimeout(r, 1900));
      await log();
      const afterType = await call("act", { action: "click", ...W, find: { label: "确定" }, observe: false });
      lg = await log();
      check("R12-S1 a sheet dismissed by its button, back long after; the model first types (its report walks the window, moments after the typing — not after the click): find 确定 is still held", !typedX.isError && afterType.isError && textOf(afterType).includes("登录已过期") && lg.actions.length === 0, `${textOf(typedX).slice(0, 120)} | ${textOf(afterType)}`);
      const pwSheet = [...editor, [1, "AXSheet", null, {}], [2, "AXStaticText", "登录已过期，放弃未保存的修改并退出？", { a: [] }], TFd(2, "口令"), B(2, "取消"), B(2, "确定")];
      for (const [wid, how, step] of [[868, "return sent to a field of the sheet", { action: "key", key: "return", find: { label: "口令" } }], [869, "a key with a modifier (cmd+.)", { action: "key", key: ".", modifiers: ["cmd"] }]]) {
        W = await win(wid, pwSheet);
        await call("window_state", { ...W, include_screenshot: false });
        await ctl("fake_after_action", { pid: P, window_id: wid, rows: editor });
        const gone = await call("act", { ...step, ...W, observe: false });
        await new Promise((r) => setTimeout(r, 1900));
        await ctl("fake_set_window", { pid: P, window_id: wid, rows: pwSheet });
        await log();
        const back = await call("act", { action: "click", ...W, find: { label: "确定" }, observe: false });
        lg = await log();
        check(`R12-S2 a sheet dismissed by ${how} (no walk after) and up again long after: find 确定 is held`, !gone.isError && back.isError && textOf(back).includes("登录已过期") && lg.actions.length === 0, `${textOf(gone)} | ${textOf(back)}`);
      }
      // Round 13: input sent through desk_call is judged as act's is — by what it can do, whatever the reply.
      const login = [...editor, [1, "AXSheet", null, {}], [2, "AXStaticText", "请登录以继续", { a: [] }], TFd(2, "用户名"), TFd(2, "密码"), B(2, "取消"), B(2, "登录")];
      W = await win(870, login);
      await call("window_state", { ...W, include_screenshot: false });
      const typedIn = await call("desk_call", { server: "cua", tool: "type_text", args: { pid: P, window_id: 870, text: "kevin" } });
      await new Promise((r) => setTimeout(r, 1900));
      await log();
      const signIn = await call("act", { action: "click", ...W, find: { label: "登录" }, observe: false });
      lg = await log();
      check("S13-3 text typed through desk_call into a login sheet the model was shown, a model turn later 登录: not held — typed text does not dismiss a sheet, whichever tool sent it", !typedIn.isError && !signIn.isError && lg.actions.length === 1, `${textOf(typedIn).slice(0, 80)} | ${textOf(signIn)}`);
      W = await win(871, withSheet);
      v = textOf(await call("window_state", { ...W, include_screenshot: false }));
      await ctl("fake_next_reply", { error: "upstream timed out after 30 s" });
      const lost = await call("desk_call", { server: "cua", tool: "click", args: { pid: P, window_id: 871, element_token: `${sidOf(v)}:${rowOf(v, "AXButton", "取消")}` } });
      await ctl("fake_set_window", { pid: P, window_id: 871, rows: editor }); // it did run
      await new Promise((r) => setTimeout(r, 1900));
      await ctl("fake_set_window", { pid: P, window_id: 871, rows: withSheet });
      await log();
      const unsure = await call("act", { action: "click", ...W, find: { label: "确定" }, observe: false });
      lg = await log();
      check("S13-4 a desk_call click on the sheet's 取消 comes back as an error that is no refusal (a timeout: it may have run); the same words are up long after: find 确定 is held, as after an act with an unknown outcome", lost.isError && unsure.isError && textOf(unsure).includes("登录已过期") && lg.actions.length === 0, `${textOf(lost).slice(0, 80)} | ${textOf(unsure)}`);
      // …and a report that lists some other change does not settle the doubt about a sheet that stood before it too.
      W = await win(872, withSheet);
      v = textOf(await call("window_state", { ...W, include_screenshot: false }));
      await ctl("fake_after_action", { pid: P, window_id: 872, rows: editor });
      await call("act", { action: "click", ...W, element_token: `${sidOf(v)}:${rowOf(v, "AXButton", "取消")}`, observe: { tree: false } });
      await new Promise((r) => setTimeout(r, 1900));
      await ctl("fake_set_window", { pid: P, window_id: 872, rows: withSheet });
      await ctl("fake_after_action", { pid: P, window_id: 872, rows: withSheet.map((r) => (r[2] === "正文" ? [r[0], r[1], r[2], { ...r[3], v: "草稿x" }] : r)) });
      const typedY = await call("act", { action: "type", ...W, text: "x" }); // its report lists the editor's new value, and no word of the sheet
      await new Promise((r) => setTimeout(r, 1900));
      await log();
      const afterY = await call("act", { action: "click", ...W, find: { label: "确定" }, observe: false });
      lg = await log();
      check("S13-4 a sheet dismissed by its button, back long after; the model types and the report lists the one value that changed behind the sheet: that list says nothing about the sheet — find 确定 is still held", !typedY.isError && textOf(typedY).includes("草稿x") && afterY.isError && textOf(afterY).includes("登录已过期") && lg.actions.length === 0, `${textOf(typedY).slice(0, 200)} | ${textOf(afterY)}`);
      // Round 13, second pass.
      W = await win(873, login);
      await call("window_state", { ...W, include_screenshot: false });
      await log();
      const selAll = await call("act", { action: "key", ...W, key: "a", modifiers: ["cmd"], find: { label: "用户名" }, observe: false });
      await new Promise((r) => setTimeout(r, 1900));
      const paste = await call("act", { action: "key", ...W, key: "v", modifiers: ["cmd"], find: { label: "用户名" }, observe: false });
      await new Promise((r) => setTimeout(r, 1900));
      const pasted = await call("act", { action: "click", ...W, find: { label: "登录" }, observe: false });
      lg = await log();
      check("SH-3 cmd+a and cmd+v sent to a field of a login sheet the model was shown (observe:false, a model turn apart), then 登录: none of the three is held — select-all and paste in a text field do not dismiss a sheet", !selAll.isError && !paste.isError && !pasted.isError && lg.actions.length === 3, `${textOf(paste).slice(0, 200)} | ${textOf(pasted).slice(0, 200)}`);
      const notes = Array.from({ length: 14 }, (_, k) => [2, "AXStaticText", `更新说明 ${k + 1}：修复了第 ${k + 1} 类问题`, { a: [] }]);
      const updating = [[0, "AXWindow", "文稿管理", { a: ["AXRaise"] }], B(1, "新建文件夹"), B(1, "刷新"), B(1, "排序"), [1, "AXSheet", null, {}], [2, "AXStaticText", "正在下载更新 2.4.1", { a: [] }], ...notes, [2, "AXProgressIndicator", null, { v: "0.3" }], B(2, "后台下载"), B(2, "取消更新")];
      W = await win(874, updating);
      await call("window_state", { ...W, include_screenshot: false });
      await call("act", { action: "key", ...W, key: "return", observe: false }); // confirms a rename behind the sheet; the sheet stays
      await new Promise((r) => setTimeout(r, 1900));
      await log();
      const heldAt = [];
      for (const label of ["新建文件夹", "刷新", "排序"]) {
        let h = 0;
        for (let tries = 0; tries < 3; tries++) {
          if (!(await call("act", { action: "click", ...W, find: { label } })).isError) break;
          h++;
        }
        heldAt.push(h);
      }
      lg = await log();
      check("SV-1 a progress sheet too long to print whole (15 texts), shown by a full look; an unobserved return, then three finds outside it a model turn later: the first is held (the sheet may be another), and that reply settles the doubt — not every find from then on", J(heldAt) === J([1, 0, 0]) && lg.actions.length === 3, J(heldAt));
      for (const [wid, how, args] of [[875, "a literal space as the key", { key: " " }], [876, "modifiers given as a string", { key: "w", modifiers: "cmd" }]]) {
        W = await win(wid, withSheet);
        await call("window_state", { ...W, include_screenshot: false });
        await ctl("fake_after_action", { pid: P, window_id: wid, rows: editor });
        const odd = await call("desk_call", { server: "cua", tool: "press_key", args: { pid: P, window_id: wid, ...args } });
        await new Promise((r) => setTimeout(r, 1900));
        await ctl("fake_set_window", { pid: P, window_id: wid, rows: withSheet });
        await log();
        const back = await call("act", { action: "click", ...W, find: { label: "确定" }, observe: false });
        lg = await log();
        check(`SV-3 a desk_call press_key with ${how} (act would refuse it; desk_call passes it on) dismissed the sheet, and the same words are up long after: find 确定 is held — a key the hub cannot read counts as able to dismiss`, !odd.isError && back.isError && textOf(back).includes("登录已过期") && lg.actions.length === 0, `${textOf(odd).slice(0, 80)} | ${textOf(back)}`);
      }
      // Round 14.
      const cleaning = (tag, extra = []) => [[0, "AXWindow", "文稿管理", { a: ["AXRaise"] }], B(1, "新建文件夹"), B(1, "刷新"), ...extra, [1, "AXSheet", null, {}], [2, "AXStaticText", "正在准备清理", { a: [] }], ...Array.from({ length: 14 }, (_, k) => [2, "AXStaticText", `· ${k === 13 ? tag : "批次"}第 ${k + 1} 项：将永久删除 ${k === 13 && tag !== "批次" ? "全部历史订单" : "临时文件"}`, { a: [] }]), [2, "AXProgressIndicator", null, { v: "0.10" }], B(2, "后台运行"), B(2, "立即清理")];
      const bare = [[0, "AXWindow", "文稿管理", { a: ["AXRaise"] }], B(1, "新建文件夹"), B(1, "刷新")];
      const comeBack = async (wid) => {
        const Wn = await win(wid, cleaning("批次"));
        await call("window_state", { ...Wn, include_screenshot: false });
        await ctl("fake_after_action", { pid: P, window_id: wid, rows: bare });
        await call("act", { action: "click", ...Wn, find: { label: "后台运行" }, observe: false }); // really dismisses it
        await new Promise((r) => setTimeout(r, 1900));
        await ctl("fake_set_window", { pid: P, window_id: wid, rows: cleaning("另一个") }); // back by itself; its 14th text is another (past the 12 a hold prints)
        return Wn;
      };
      W = await comeBack(877);
      const two = [{ action: "click", find: { label: "新建文件夹" } }, { action: "click", find: { label: "立即清理" } }];
      const firstB = await call("act_batch", { ...W, steps: two });
      await log();
      const secondB = await call("act_batch", { ...W, steps: two });
      const batchLog = await log();
      W = await comeBack(878);
      const heldOut = await call("act", { action: "click", ...W, find: { label: "新建文件夹" } });
      await ctl("fake_after_action", { pid: P, window_id: 878, rows: cleaning("另一个", [[1, "AXStaticText", "未命名文件夹", { a: [] }]]) });
      const withReport = await call("act", { action: "click", ...W, find: { label: "刷新" } }); // its report lists the new row, no word of the sheet
      await log();
      const inAfter = await call("act", { action: "click", ...W, find: { label: "立即清理" }, observe: false });
      lg = await log();
      check("R14 (doubt) a long progress sheet dismissed and back with one text changed past what a hold prints. The hold on a step outside it names the sheet and ends the doubt for the window — not for its own button: the resent batch [新建文件夹, 立即清理] stops at 立即清理, and after a report that lists only a new row 立即清理 is held too", firstB.isError && secondB.isError && textOf(secondB).includes("FAILED at step 2") && J(batchLog.actions.map((a) => a.target?.label)) === J(["新建文件夹"]) && heldOut.isError && !withReport.isError && textOf(withReport).includes("未命名文件夹") && inAfter.isError && lg.actions.length === 0, `${textOf(secondB).slice(0, 200)} | ${textOf(withReport).slice(0, 160)} | ${textOf(inAfter).slice(0, 160)}`);
      const server = [...editor, [1, "AXSheet", null, {}], [2, "AXStaticText", "连接服务器", { a: [] }], [2, "AXComboBox", "服务器地址", { v: "smb://old", a: ["AXConfirm"] }], B(2, "取消"), B(2, "连接")];
      W = await win(879, server);
      await call("window_state", { ...W, include_screenshot: false });
      await log();
      const comboA = await call("act", { action: "key", ...W, key: "a", modifiers: ["cmd"], find: { label: "服务器地址" }, observe: false });
      await new Promise((r) => setTimeout(r, 1900));
      const comboV = await call("act", { action: "key", ...W, key: "v", modifiers: ["cmd"], find: { label: "服务器地址" }, observe: false });
      await new Promise((r) => setTimeout(r, 1900));
      const connect = await call("act", { action: "click", ...W, find: { label: "连接" }, observe: false });
      lg = await log();
      check("R14-3 (doubt) cmd+a and cmd+v sent to a COMBO BOX of a sheet the model was shown, then 连接: none of the three is held — a combo box is a text field for this too", !comboA.isError && !comboV.isError && !connect.isError && lg.actions.length === 3, `${textOf(comboV).slice(0, 200)} | ${textOf(connect).slice(0, 200)}`);
    });
  } finally {
    await H.c.close().catch(() => {});
  }
}

// 7.6m memory under a long run of actions (round 10, R10-G1): every report diffs the new walk against the one
// before; the alignment cache used to chain them all, and a hub with a 256 MB heap died at the 68th action.
{
  const H = await fakeHub("smoke-fake-mem", { NODE_OPTIONS: "--max-old-space-size=256" });
  const { call, ctl, log, win } = H;
  try {
    await section("7.6m long run", async () => {
      const rows = (k) => [[0, "AXWindow", "大表", { a: ["AXRaise"] }], [1, "AXButton", "刷新", { press: true }], ...Array.from({ length: 3000 }, (_, i) => [1, "AXStaticText", `单元 ${i}${i % 600 === 0 ? ` · 第 ${k} 次` : ""}`, { a: [] }])];
      const W = await win(871, rows(0));
      await call("window_state", { ...W, include_screenshot: false });
      let okN = 0;
      let last = "";
      for (let k = 1; k <= 110; k++) {
        await ctl("fake_after_action", { pid: P, window_id: 871, rows: rows(k) });
        const r = await call("act", { action: "click", ...W, find: { label: "刷新" }, wait_ms: 0, again: true });
        last = textOf(r);
        if (!r.isError) okN++;
      }
      const lg = await log();
      check("R10-G1 110 actions with reports on a 3,000-row window in a hub with a 256 MB heap: all of them run (the walks are freed as the model moves on)", okN === 110 && lg.actions.length === 110 && last.includes("第 110 次"), `${okN} ok | ${last.slice(0, 200)}`);
    });
  } finally {
    await H.c.close().catch(() => {});
  }
}

// 7.6f knobs that need their own hub: cua ≥0.34 compact replies (10), a
// locked screen (9), a small tree cap (3, 16), the batch budget (7).
{
  const H = await fakeHub("smoke-fake-knobs", { DESKTOP_HUB_TEST_LOCKED: "1", DESKTOP_HUB_MAX_TREE_CHARS: "600", DESKTOP_HUB_BATCH_BUDGET_MS: "1500" });
  const { call, ctl, log, win } = H;
  try {
    // First walk of this hub: it must discover the 0.34 shape itself.
    await section("7.6f compact 0.34", async () => {
      await ctl("fake_mode", { compact034: true });
      const W = await win(761, FORM());
      const base = { pid: P, window_id: 761, include_screenshot: false };
      const r = textOf(await call("window_state", { ...W, include_screenshot: false }));
      let lg = await log();
      check("cua ≥0.34: a markdown-only reply → one re-walk with full_output:true", J(walks(lg).map((c) => c.args)) === J([base, { ...base, full_output: true }]), J(lg.calls));
      check("…the tree shown is the structured one ([n]/(n) known)", r.includes('\n  - [4] AXButton "保存"') && r.includes('\n  - (8) AXImage "徽标"') && !r.includes("pressability unknown"), r);
      await call("window_state", { ...W, include_screenshot: false });
      await call("act", { action: "click", ...W, find: { label: "保存" }, observe: false });
      lg = await log();
      check("…every later walk (find included) asks for full_output from the start", walks(lg).length === 2 && walks(lg).every((c) => c.args.full_output === true) && lg.actions.length === 1, J(walks(lg)));
      await ctl("fake_mode", { compact034: false });
    });
    await section("7.6f locked", async () => {
      const W = await win(762, FORM());
      await ctl("fake_degrade", { count: 1 });
      const r = textOf(await call("window_state", { ...W, include_screenshot: false }));
      const LOCKED = "[desktop-hub] The screen is LOCKED: no window's accessibility tree can be read and every background action will be refused. Do not try other routes (foreground, scripts, other backends) — stop and ask the user to unlock.";
      check("locked screen + degraded tree: the LOCKED sentence instead of the generic one", r === LOCKED, r);
      const ok = textOf(await call("window_state", { ...W, include_screenshot: false }));
      check("…a readable tree is shown normally (the lock is checked only on degraded trees)", ok.startsWith("win 762 ") && !ok.includes("LOCKED"), ok.slice(0, 80));
      await ctl("fake_degrade", { count: 1 });
      await log();
      const f = await call("act", { action: "click", ...W, find: { label: "保存" }, observe: false });
      const lg = await log();
      check("find on a degraded walk while locked: refused with that sentence, nothing executed", f.isError && textOf(f) === `click: FAILED (not executed) — find: ${LOCKED}` && lg.actions.length === 0, textOf(f));
    });
    await section("7.6f tree cap", async () => {
      const BIG = [[0, "AXWindow", "大窗", { a: ["AXRaise"] }], ...Array.from({ length: 40 }, (_, i) => [1, "AXButton", `按钮${String(i).padStart(2, "0")}`, { press: true }])];
      const W = await win(763, BIG);
      const r = textOf(await call("window_state", { ...W, include_screenshot: false }));
      check(
        "DESKTOP_HUB_MAX_TREE_CHARS: output cut, with a count and a hint",
        /· \d+ of 41 rows\n/.test(r) && /\n…\[\d+ more rows not shown — narrow with query:"a\|b" \(substring, any term\)\]$/.test(r) && r.length < 800 && !r.includes("按钮39"),
        `len=${r.length}`
      );
      await log();
      const hidden = await call("act", { action: "click", ...W, element_token: `${sidOf(r)}:40`, observe: false });
      const lg = await log();
      check("a row cut from the output is not a valid token", hidden.isError && textOf(hidden).startsWith(`act invalid (nothing executed): row 40 was never shown to you under snapshot ${sidOf(r)}`) && lg.calls.length === 0, textOf(hidden));
      const d = textOf(await call("window_state", { ...W, diff: true }));
      check("…a whole-window look cut by the size cap is still the baseline for diff:true (the window is not re-sent)", d.endsWith("· no change vs your last view (41 rows)"), d.slice(0, 120));
      await win(765, BIG);
      await call("window_state", { pid: P, window_id: 765, max_elements: 5, include_screenshot: false });
      const d765 = textOf(await call("window_state", { pid: P, window_id: 765, diff: true }));
      check("…a view the caller narrowed (max_elements) is not a baseline", d765.startsWith("[no earlier full view of this window"), d765.slice(0, 80));
      const S = await win(764, FORM());
      await call("window_state", { ...S, include_screenshot: false });
      const d2 = textOf(await call("window_state", { ...S, diff: true }));
      check("…an uncut tree under the same cap does", d2.endsWith("· no change vs your last view (10 rows)"), d2);
    });
    await section("7.6f budget", async () => {
      const W = await win(765, FORM());
      // Node timers may fire ~1 ms early, leaving step 2 a sliver of budget;
      // retry the (cheap) scenario rather than accept a different message.
      let got = null;
      let took = 0;
      for (let tries = 0; tries < 3 && !got; tries++) {
        const t0 = Date.now();
        const r = await call("act_batch", { ...W, steps: [{ action: "key", key: "a", wait_ms: 5000 }, { action: "key", key: "b" }], observe: false });
        took = Date.now() - t0;
        const lg = await log();
        if (textOf(r).startsWith("[act_batch] 1.5s budget exhausted before step 2")) got = { r, lg };
      }
      check(
        "a wait that uses up the batch budget: 'budget exhausted before step 2', step 2 never sent",
        got?.r.isError && textOf(got.r) === "[act_batch] 1.5s budget exhausted before step 2: 1 step(s) ran and took effect, 1 not run.\nstep 1 key: ok" && J(got.lg.actions.map((a) => a.args.key)) === J(["a"]) && took < 3000,
        got ? textOf(got.r) : "never produced the message"
      );
      const fine = await call("act_batch", { ...W, steps: [{ action: "key", key: "a", wait_ms: 200 }, { action: "key", key: "b" }], observe: false });
      const lg = await log();
      check("…a batch inside the budget runs to the end", !fine.isError && textOf(fine).startsWith("[act_batch] all 2 steps done — 2 ok, 0 skipped.") && lg.actions.length === 2, textOf(fine));
    });
  } finally {
    await H.c.close().catch(() => {});
  }
}

// 7.6g a cua 0.55 driver (fake_mode v055): compact replies, walks the driver
// cuts short (by its clock, at its node cap), the 0.55 row grammar, structured
// refusals, an action that ran and is reported as an error, ended sessions.
{
  const H = await fakeHub("smoke-fake-055");
  const { call, ctl, log, win } = H;
  const ROWS055 = [
    [0, "AXWindow", "新版窗", { a: ["AXRaise"] }],
    [1, "AXGroup", null, { ix: false, help: "向左滑动归档" }],
    [1, "AXButton", "保存", { press: true, en: false }],
    [1, "AXButton", "通过", { press: true, id: "ok", help: "批准", ca: ["置顶"] }],
    [1, "AXCheckBox", "记住", { en: false, a: [] }],
    [1, "AXButton", null, { press: true, help: "无标签图标" }],
    [1, "AXStaticText", "尾巴", { a: [] }],
    [1, "AXButton", "删除", { press: true }],
  ];
  const gws = (lg) => walks(lg).map((c) => `${c.args.full_output === true ? "full" : "plain"}${c.args.timeout_ms !== undefined ? `+${c.args.timeout_ms}` : ""}`).join(" ");
  try {
    await ctl("fake_mode", { v055: true });
    await section("7.6g 0.55 walk", async () => {
      const W = await win(771, ROWS055);
      const r = textOf(await call("window_state", { ...W, include_screenshot: false }));
      let lg = await log();
      check("cua 0.55: a markdown-only reply → one re-walk with full_output (and no parameter the driver was not seen to need)", gws(lg) === "plain full", J(lg.calls));
      check(
        "…rows in the 0.55 bracket grammar read right (enabled=false, a help-only row, custom_actions, no bracket at all)",
        bare(r) ===
          'win 771 "新版窗" pid 4242 · snapshot s00000102 · 8 rows\n- (0) AXWindow "新版窗"\n - AXGroup help="向左滑动归档"\n - [1] AXButton "保存" [disabled]\n - [2] AXButton "通过"\n - (3) AXCheckBox "记住" [disabled]\n - [4] AXButton help="无标签图标"\n - (5) AXStaticText "尾巴"\n - [6] AXButton "删除"',
        r
      );
      const a1 = textOf(await call("act", { action: "click", ...W, find: { label: "删除" } }));
      lg = await log();
      check("…later walks ask for full_output from the start, and the press goes to the row found", gws(lg) === "full full" && lg.actions.length === 1 && lg.actions[0].target?.label === "删除", J(lg.calls) + a1);
    });
    await section("7.6g 0.55 walk cut by the clock", async () => {
      const W = await win(772, ROWS055);
      await ctl("fake_walk_cost", { ms: 5000 }); // five times the driver's default limit, a quarter of the hub's
      const first = textOf(await call("window_state", { ...W, include_screenshot: false }));
      let lg = await log();
      check("a walk the driver cut at its default 1 s: the hub asks again with its own limit, once, and shows the whole window", gws(lg) === "full full+20000" && first.includes(" · 8 rows") && first.includes('AXButton "删除"') && !first.includes("⚠"), J(lg.calls) + first);
      await ctl("fake_walk_cost", { ms: 40000 }); // twice the hub's limit: the driver gets through half of the 8 rows
      const r = textOf(await call("window_state", { ...W, include_screenshot: false }));
      lg = await log();
      check("…from then on every walk carries the limit; one the driver still cannot finish is shown as far as it got, and says so in the hub's words", gws(lg) === "full+20000" && r.includes(" · 4 rows") && r.includes('AXButton "通过"') && !r.includes('"删除"') && r.endsWith("\n⚠ walk cut short: the driver's 20000 ms time limit ran out after 4 node(s), at least 1 more not visited") && !r.includes("PARTIAL TREE"), J(lg.calls) + r);
      const d = textOf(await call("window_state", { ...W, diff: true }));
      check("…a diff made on such a walk says that a row it lists as gone may still be there", /a row listed as gone may still be there$/.test(d), d);
      const q = textOf(await call("window_state", { ...W, query: "删除" }));
      check("…a query that finds nothing in it does not call what it shows the whole window", /0 of 4 rows match/.test(q) && q.includes("what this walk reached (NOT the whole window):") && q.includes("rows it did not reach were not searched") && !q.includes("\nthe whole window:"), q);
      const q2 = textOf(await call("window_state", { ...W, query: "通过" }));
      check("…and one that does find something says the rest was not searched", /1 match/.test(q2) && q2.includes("rows it did not reach were not searched"), q2);
      await log();
      const f = await call("act", { action: "click", ...W, find: { label: "删除" } });
      lg = await log();
      check("…find on it is refused, nothing sent: neither 'the only one' nor 'absent' can be shown", f.isError === true && /did not get through this window/.test(textOf(f)) && /Nothing was sent/.test(textOf(f)) && lg.actions.length === 0, textOf(f));
      const g = await call("act", { action: "click", ...W, find: { label: "删除" }, if_present: true });
      lg = await log();
      check("…and if_present does not turn that into 'skipped, absent'", g.isError === true && !/skipped/.test(textOf(g)) && lg.actions.length === 0, textOf(g));
      const tok = `${sidOf(r)}:${rowOf(r, "AXButton", "通过")}`;
      const t = await call("act", { action: "click", ...W, element_token: tok });
      lg = await log();
      check("…a row the model was shown can still be pressed by its token; the report says its walk was cut short too", !t.isError && lg.actions.length === 1 && lg.actions[0].target?.label === "通过" && textOf(t).includes("cut short"), textOf(t));
      const seen = textOf(await call("window_state", { ...W, include_screenshot: false }));
      const tok2 = `${sidOf(seen)}:${rowOf(seen, "AXButton", "通过")}`;
      await ctl("fake_walk_cost", { ms: 80000 }); // the next walk gets through a quarter: the row is not in it
      await call("act", { action: "click", ...W, element_token: tok2 }); // its report is that shorter walk
      await log();
      const c = await call("act", { action: "click", ...W, element_token: tok2, again: true });
      lg = await log();
      check("…a token whose row the latest (shorter) walk did not reach: refused as 'not reached', not as 'gone'; nothing sent", c.isError === true && /or it was not reached: the last walk of this window was cut short/.test(textOf(c)) && lg.actions.length === 0, textOf(c));
      await ctl("fake_walk_cost", { ms: 40000 });
      await call("window_state", { ...W, include_screenshot: false });
      await ctl("fake_walk_cost", { ms: 0 });
      const d2 = textOf(await call("window_state", { ...W, diff: true }));
      check("…the first complete walk after it: rows listed as new carry the 'may have been there already' note", d2.includes('AXButton "删除"') && d2.includes("may have been there already"), d2);
      const ok = await call("act", { action: "click", ...W, find: { label: "删除" } });
      lg = await log();
      check("…and find works again", !ok.isError && lg.actions.length === 1 && lg.actions[0].target?.label === "删除", textOf(ok));
    });
    await section("7.6g 0.55 walk cut at the node cap", async () => {
      const W = await win(775, ROWS055);
      await ctl("fake_node_cap", { n: 4 });
      const r = textOf(await call("window_state", { ...W, include_screenshot: false }));
      check("a walk stopped at the driver's node cap (its markdown ends with a PARTIAL TREE line as well): shown as far as it got, in the hub's words", r.includes(" · 4 rows") && r.endsWith("\n⚠ walk cut short: the driver's node cap was reached after 4 node(s), at least 1 more not visited") && !r.includes("PARTIAL TREE"), r);
      await log();
      const f = await call("act", { action: "click", ...W, find: { label: "通过" } });
      let lg = await log();
      check("…find still works on it, as on a 0.28 tree cut at its cap (the cut falls on the same row every time)", !f.isError && lg.actions.length === 1 && lg.actions[0].target?.label === "通过" && !/may still be there|may have been there/.test(textOf(f)), textOf(f));
      const m = await call("act", { action: "click", ...W, find: { label: "删除" } });
      lg = await log();
      check("…and a name past the cap is the ordinary 'nothing matches'", m.isError === true && /nothing matches/.test(textOf(m)) && lg.actions.length === 0, textOf(m));
      await ctl("fake_node_cap", { n: 0 });
    });
    await section("7.6g 0.55 refusals", async () => {
      const W = await win(773, [[0, "AXWindow", "输入窗", { a: ["AXRaise"] }], [1, "AXTextField", "备注", { v: "", press: true }], [1, "AXButton", "提交", { press: true }]]);
      const v = textOf(await call("window_state", { ...W, include_screenshot: false }));
      await log();
      await ctl("fake_next_reply", { refusal: { code: "window_not_key", form: "background", message: "the addressed window is not the app's key window" } });
      const k = await call("act", { action: "key", ...W, key: "return" });
      let lg = await log();
      check("window_not_key (0.55's answer where 0.28 said same_pid_keyboard_ambiguity), in the driver's own envelope: the hub says what still works, nothing was sent", k.isError === true && /Background input refused \(window_not_key\)/.test(textOf(k)) && /could not make this window the app's key window/.test(textOf(k)) && /not executed/.test(textOf(k)) && lg.actions.length === 0 && lg.calls.some((c) => c.refused === "window_not_key"), textOf(k));
      await ctl("fake_next_reply", { refusal: { code: "window_not_key", form: "background", message: "invoke_menu: requested window 773 is not the confirmed document menu context (focused=Some(9001), main=Some(9001)); no menu action was dispatched" } });
      const mn = await call("act", { action: "menu", ...W, path: ["文件", "新建"] });
      lg = await log();
      check("a menu sent through a window that is not the app's main one (0.55 refuses it, measured): the hub names the window to send it through, nothing was sent", mn.isError === true && /not executed/.test(textOf(mn)) && /window 9001 is\)/.test(textOf(mn)) && /send the menu with window_id 9001/.test(textOf(mn)) && !/no key was sent/.test(textOf(mn)) && lg.actions.length === 0, textOf(mn));
      const menuNote = async (focused, main) => {
        await ctl("fake_next_reply", { refusal: { code: "window_not_key", form: "background", message: `invoke_menu: requested window ${W.window_id} is not the confirmed document menu context (focused=${focused}, main=${main}); no menu action was dispatched` } });
        const r = await call("act", { action: "menu", ...W, path: ["文件", "新建"] });
        await log();
        return r;
      };
      let mr = await menuNote("Some(9001)", `Some(${W.window_id})`);
      check("a menu refused although this IS the main window (the focus is in a panel of the app): the hub does not tell it to resend through the same window", mr.isError === true && /this one is the main window, but the app's focus is in window 9001/.test(textOf(mr)) && !/send the menu with window_id/.test(textOf(mr)), textOf(mr));
      mr = await menuNote("Some(9001)", "Some(9002)");
      check("a menu refused where focus and main window differ: the hub does not point at the main window, which would be refused too", mr.isError === true && /main: window 9002; focus: window 9001/.test(textOf(mr)) && !/send the menu with window_id/.test(textOf(mr)), textOf(mr));
      mr = await menuNote("None", "None");
      check("a menu refused where the driver could not read either window: no window is named", mr.isError === true && /could not read which window/.test(textOf(mr)) && !/window_id \d/.test(textOf(mr)), textOf(mr));
      await ctl("fake_next_reply", { structured: { effect: "confirmed", route: "accessibility", hint: "The click was sent. Read what changed before clicking again.", summary: 'Performed AXPress. Action opened new window(s): 802 "设置". Action caused a different app to become frontmost.' } });
      const nw = await call("act", { action: "click", ...W, find: { label: "提交" } });
      await call("window_state", { ...W, include_screenshot: false }); // clears the hub's "pressed this 0s ago" gate for the checks below
      await log();
      check("a routine click whose driver summary says it opened a window and changed the frontmost app: those two sentences reach the model, the routine hint does not", !nw.isError && /driver: Action opened new window\(s\): 802 "设置"\./.test(textOf(nw)) && /driver: Action caused a different app to become frontmost\./.test(textOf(nw)) && !/Read what changed before clicking again/.test(textOf(nw)) && (textOf(nw).match(/opened new window/g) ?? []).length === 1, textOf(nw));
      await ctl("fake_next_reply", { refusal: { code: "point_outside_window", form: "effect", message: "" } });
      const e = await call("act_batch", { ...W, steps: [{ action: "click", find: { label: "提交" } }, { action: "click", find: { label: "提交" }, again: true }] });
      lg = await log();
      check("a structured refusal with no text at all ({effect:\"refused\", error:{code}}): its code is shown, the step counts as not sent, the batch stops", e.isError === true && /point_outside_window/.test(textOf(e)) && lg.actions.length === 0 && !/outcome unknown|may have/i.test(textOf(e)), textOf(e));
      await ctl("fake_next_reply", { error: "internal action outcome mismatch for click: invalid public projection: missing field `route`; the tool may have executed. Verify state before retrying.", structured: { code: "action_outcome_mismatch", execution_state: "unknown" } });
      const o = await call("act", { action: "click", ...W, find: { label: "提交" } });
      lg = await log();
      check("an action that RAN and is reported as an error (0.55: action_outcome_mismatch, 'the tool may have executed'): outcome UNKNOWN, never 'not executed', and the hub looks again", o.isError === true && /outcome UNKNOWN/.test(textOf(o)) && !/not executed/.test(textOf(o)) && lg.actions.length === 1 && walks(lg).length >= 2, J(lg.calls.map((c) => c.tool)) + textOf(o));
      const field = `${sidOf(v)}:${rowOf(v, "AXTextField", "备注")}`;
      const seen = textOf(await call("window_state", { ...W, include_screenshot: false }));
      const tokF = `${sidOf(seen)}:${rowOf(seen, "AXTextField", "备注")}`;
      await log();
      await ctl("fake_next_reply", { refusal: { code: "same_pid_keyboard_ambiguity", form: "background", message: "another window of this app could take the keys" } });
      const ty = await call("act", { action: "type", ...W, element_token: tokF, text: "你好" });
      lg = await log();
      check("typing into an element refused by the keyboard rules: the driver tried the accessibility write first, so 'the text may be in the field', not 'not executed'", ty.isError === true && /the text may be in the field/.test(textOf(ty)) && /outcome UNKNOWN/.test(textOf(ty)) && !/not executed/.test(textOf(ty)), textOf(ty) + field);
      await ctl("fake_next_reply", { refusal: { code: "same_pid_keyboard_ambiguity", form: "background", message: "another window of this app could take the keys" } });
      const ky = await call("act", { action: "key", ...W, key: "tab" });
      lg = await log();
      check("…the same refusal of a key press is 'not executed', with the hub's note on what still works", ky.isError === true && /not executed/.test(textOf(ky)) && /another top-level window/.test(textOf(ky)) && lg.actions.length === 0, textOf(ky));
    });
    await section("7.6g 0.55 ended sessions", async () => {
      const W = await win(774, FORM());
      await call("window_state", { ...W, include_screenshot: false });
      await log();
      await ctl("fake_session_end", {});
      const r = await call("window_state", { ...W, include_screenshot: false });
      let lg = await log();
      check(
        "the connection's own unnamed session has been ended: one start_session without a label, then the same call again",
        !r.isError && textOf(r).includes('AXButton "保存"') && J(lg.calls.map((c) => [c.tool, c.refused ?? null, c.args.session ?? null])) === J([["get_window_state", "session_ended", null], ["start_session", null, null], ["get_window_state", null, null]]),
        J(lg.calls) + textOf(r)
      );
      const s1 = textOf(await call("window_state", { ...W, include_screenshot: false, session: "备用" }));
      const tok = `${sidOf(s1)}:${rowOf(s1, "AXButton", "保存")}`;
      await log();
      await ctl("fake_session_end", { session: "备用" });
      const a = await call("act", { action: "click", ...W, element_token: tok, session: "备用", observe: false });
      lg = await log();
      check(
        "a named session that has been ended (0.55 sentence, code session_ended) takes its snapshots with it: revived with its label, the stale token re-identified on a fresh walk, the press sent once and to the same control",
        !a.isError && lg.actions.length === 1 && lg.actions[0].target?.label === "保存" && J(lg.calls.map((c) => c.tool + (c.refused ? `(${c.refused})` : c.stale ? "(stale)" : ""))) === J(["click(session_ended)", "start_session", "click(stale)", "get_window_state", "click"]) && /re-identified after its session had ended and was revived/.test(textOf(a)),
        J(lg.calls.map((c) => c.tool + (c.refused ? `(${c.refused})` : c.stale ? "(stale)" : ""))) + textOf(a)
      );
      const QUOTE = "session 'x' has ended; call start_session with session 'x' to start it again, or use a new session label";
      await ctl("fake_next_reply", { error: `replay stopped at step 3: ${QUOTE}` });
      const q = await call("act", { action: "click", ...W, find: { label: "保存" }, again: true, observe: false });
      lg = await log();
      check("a failure that only QUOTES the sentence is not that refusal: no revive, no second run", q.isError === true && lg.actions.length === 1 && !lg.calls.some((c) => c.tool === "start_session"), J(lg.calls) + textOf(q));
      await ctl("fake_next_reply", { refusal: { code: "window_not_key", message: QUOTE } });
      const o = await call("act", { action: "key", ...W, key: "return" });
      lg = await log();
      check("…nor is another refusal whose message quotes it", o.isError === true && lg.actions.length === 0 && !lg.calls.some((c) => c.tool === "start_session"), J(lg.calls) + textOf(o));
    });
  } finally {
    await H.c.close().catch(() => {});
  }
}

// 7.6h the driver is replaced under a running hub (an upgrade, then a rollback):
// what the hub learnt about the old one must not be used on the new one.
{
  const H = await fakeHub("smoke-fake-swap");
  const { call, ctl, log, win } = H;
  const settle = () => new Promise((r) => setTimeout(r, 400)); // the hub notices the exit on its own
  const gws = (lg) => walks(lg).map((c) => `${c.args.full_output === true ? "full" : "plain"}${c.args.timeout_ms !== undefined ? `+${c.args.timeout_ms}` : ""}`).join(" ");
  try {
    await section("7.6h driver replaced", async () => {
      await ctl("fake_mode", { compact034: true });
      let W = await win(781, FORM());
      await call("window_state", { ...W, include_screenshot: false });
      await call("window_state", { ...W, include_screenshot: false });
      let lg = await log();
      check("a compact driver that never reports a walk cut by its clock: full_output, and never timeout_ms (it would refuse a parameter it does not know)", gws(lg) === "plain full full", J(lg.calls));
      await ctl("fake_exit", { next: { v055: true } });
      await settle();
      W = await win(781, FORM());
      await ctl("fake_walk_cost", { ms: 5000 });
      const up = await call("window_state", { ...W, include_screenshot: false });
      const up2 = await call("window_state", { ...W, include_screenshot: false });
      lg = await log();
      check("upgraded to 0.55 under the hub, on a slow window: it learns both again from the new driver's replies, then asks for both from the start", !up.isError && !up2.isError && textOf(up).includes('AXButton "保存"') && !textOf(up).includes("⚠") && gws(lg) === "plain full full+20000 full+20000", J(lg.calls) + textOf(up));
      await ctl("fake_exit", {});
      await settle();
      W = await win(781, FORM());
      const down = await call("window_state", { ...W, include_screenshot: false });
      lg = await log();
      check("rolled back to 0.28 under the hub: neither full_output nor timeout_ms is sent to it", !down.isError && textOf(down).includes('AXButton "保存"') && gws(lg) === "plain", J(lg.calls) + textOf(down));
    });
  } finally {
    await H.c.close().catch(() => {});
  }
}

// 7.7 cancellation / batch budget must NOT kill a healthy backend. The SDK
// wraps every abort into RequestTimeout (-32001); the hub used to treat that
// as "backend hung" and SIGTERM cua — every element_token, diff baseline and
// named session died with it. `whoami` returns the fixture pid: same pid
// before and after = the backend survived. A genuinely hung backend must
// still be evicted (liveness probe after a hub-side deadline).
{
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "slow-backend.mjs");
  const t6 = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: { ...process.env, DESKTOP_HUB_CUA_BIN: FIXTURE, DESKTOP_HUB_BATCH_BUDGET_MS: "1200", DESKTOP_HUB_PROBE_MS: "800" },
  });
  const c6 = new Client({ name: "smoke-abort", version: "0" });
  try {
    await c6.connect(t6);
    const who = async () => textOf(await c6.callTool({ name: "desk_call", arguments: { server: "cua", tool: "whoami", args: {} } })).trim();
    const pid0 = await who();
    check("slow fixture reachable", /^\d+$/.test(pid0), pid0);

    const ac = new AbortController();
    setTimeout(() => ac.abort("user pressed Esc"), 300);
    let cancelled = false;
    try {
      await c6.callTool({ name: "desk_call", arguments: { server: "cua", tool: "sleep", args: { ms: 2500 } } }, undefined, { signal: ac.signal });
    } catch { cancelled = true; }
    check("host-side cancel rejects the pending call", cancelled);
    await new Promise((r) => setTimeout(r, 300));
    const pid1 = await who();
    check("host cancel does NOT evict the backend (same pid)", pid1 === pid0, `${pid0} → ${pid1}`);

    const b = await c6.callTool({ name: "act_batch", arguments: { pid: 1, steps: [{ action: "key", key: "f20" }, { action: "key", key: "a" }] } });
    const bt = textOf(b);
    check("batch budget cuts the slow step", b.isError && /budget exhausted/.test(bt), bt.slice(0, 240));
    await new Promise((r) => setTimeout(r, 1500)); // let the liveness probe finish
    const pid2 = await who();
    check("batch budget does NOT evict a slow-but-alive backend", pid2 === pid0, `${pid0} → ${pid2}`);

    const ac2 = new AbortController();
    setTimeout(() => ac2.abort("stop waiting"), 300);
    try {
      await c6.callTool({ name: "desk_call", arguments: { server: "cua", tool: "hang", args: {} } }, undefined, { signal: ac2.signal });
    } catch { /* expected */ }
    // The fixture is now hung. A batch step hits the 1.2s budget, the probe
    // times out (0.8s) and evicts; the next call must land on a fresh process.
    await c6.callTool({ name: "act_batch", arguments: { pid: 1, steps: [{ action: "key", key: "a" }] } });
    await new Promise((r) => setTimeout(r, 1500));
    const pid3 = await who();
    check("hung backend is still evicted after a deadline (liveness probe)", /^\d+$/.test(pid3) && pid3 !== pid0, `${pid0} → ${pid3}`);
  } catch (e) {
    check("abort fixture block ran without protocol errors", false, String(e).slice(0, 200));
  } finally {
    await c6.close().catch(() => {});
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
// Backend pids must be captured BEFORE close: once the server dies its
// children are re-parented to launchd, so a post-mortem `pgrep -P serverPid`
// is always empty and the old check could never fail.
let backendPids = [];
if (serverPid) {
  try {
    backendPids = execFileSync("pgrep", ["-P", String(serverPid)], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number);
  } catch { /* no children */ }
}
check("server had a live backend child before close", backendPids.length >= 1, `children=${backendPids.join(",")}`);
await client.close();
await new Promise((r) => setTimeout(r, 2500));
if (serverPid) {
  let serverAlive = true;
  try { process.kill(serverPid, 0); } catch { serverAlive = false; }
  check("server exits on host close", !serverAlive, `pid ${serverPid} still alive`);
  const survivors = backendPids.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
  check("no orphaned backends", survivors.length === 0, `still alive: ${survivors.join(",")}`);
} else {
  check("server exits on host close", false, "could not determine server pid");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall green");
process.exit(failures ? 1 : 0);
