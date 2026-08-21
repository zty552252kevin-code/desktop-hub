#!/usr/bin/env node
// Regression smoke test for desktop-hub. Run: npm test
// Covers: tool surface + token budget, facade validation fast-fails, cua
// backend round-trip, run_script, verify clamp, clean shutdown (no orphans).
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
check("10 facade tools", tools.length === 10, `got ${tools.length}`);
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

// 5. optional oss backend
if (process.env.DESKTOP_HUB_TEST_OSS === "1") {
  const dc = await client.callTool({ name: "desk_call", arguments: { server: "oss", tool: "list_running_apps", args: {} } }, undefined, { timeout: 180_000 });
  check("desk_call oss list_running_apps", !dc.isError, textOf(dc).slice(0, 120));
} else {
  console.log("skip oss backend (set DESKTOP_HUB_TEST_OSS=1 to include)");
}

// 6. clean shutdown: closing our side must reap OUR server AND its backends.
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
