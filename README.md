# desktop-hub

**A compact facade MCP server for macOS desktop automation.** It exposes just 10 hand-written tools (~2.3k tokens of definitions) and lazily proxies to two full-featured computer-use MCP servers — [cua-driver](https://github.com/trycua/cua) (56 tools, ~37k tokens) and [computer-use-mcp](https://github.com/zavora-ai/computer-use-mcp) (64 tools, ~21k tokens) — plus native `osascript`. You keep the entire 120-tool surface, but your context window pays ~2k tokens instead of ~58k.

[中文说明在下方](#中文说明) · [Gitee mirror 国内镜像](https://gitee.com/zty552252kevin/desktop-hub) · Works with Claude Code and any MCP client.

## Why

Registering both upstream servers directly costs ~58k context tokens per session just for tool definitions, while the high-frequency surface is small. This facade keeps the hot path cheap and the long tail reachable:

```
MCP client ──stdio──> desktop-hub (this server, 10 compact tools)
                        ├─ lazy stdio child ──> cua-driver mcp        (background desktop control, no cursor/focus steal)
                        ├─ lazy stdio child ──> computer-use-mcp      (AX tree, find_element, fill_form, Spaces…; spawned on first use)
                        └─ local osascript                            (AppleScript/JXA, true background scripting)
```

## Tools

| Tool | What it does |
|---|---|
| `desktop_screenshot` | Full-display screenshot, true screen pixels (→ cua `get_desktop_state`) |
| `list_windows` | All top-level windows incl. minimized/off-Space (→ cua) |
| `launch_app` | Launch an app in the background without stealing focus (→ cua) |
| `window_state` | AX-tree walk + grounding screenshot; elements carry `element_token` (→ cua) |
| `act` | Ten actions in one: click / double_click / right_click / type / key / hotkey / scroll / drag / set_value / menu (→ mapped to cua tools) |
| `verify` | Deterministic assertions on window/element state after acting (→ cua `verify_state`) |
| `zoom` | Cropped close-up of a window region for small text (→ cua) |
| `run_script` | AppleScript/JXA via local `osascript` — no backend involved |
| `desk_call` | Escape hatch: call ANY of the 120 underlying tools directly |
| `desk_describe` | On-demand catalog / full JSON schema of underlying tools (tokens spent only when needed) |

## Prerequisites

- **macOS** (Apple Silicon or Intel), **Node.js 18+** (developed on Node 26).
- **cua-driver** — the macOS driver from the [trycua/cua](https://github.com/trycua/cua) project (`libs/cua-driver`). Install with their official one-liner, which places `CuaDriver.app` in `/Applications` and symlinks `~/.local/bin/cua-driver` (exactly this hub's default path — no config needed):

  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"
  ```

  Docs: <https://cua.ai/docs/how-to-guides/driver/install>. Tested against cua-driver **0.20.0** (`cua-driver --version`); if `act`/`verify` return unknown-tool errors after a driver upgrade, run `desk_describe server:cua` first to diff the tool surface.
- **computer-use-mcp needs no manual install** — `npx` fetches `@zavora-ai/computer-use-mcp@7.0.0` automatically on first `desk_call server:"oss"` (one-time network access; a few seconds of spawn latency thereafter — the handshake timeout is already widened to 180s). Users in mainland China may want an npm registry mirror configured.

### macOS permissions

- Grant **Accessibility** and **Screen Recording** (System Settings → Privacy & Security) to **CuaDriver.app** — run `cua-driver permissions grant` so the dialogs attribute to the app identity (grants then survive upgrades). Without them every screenshot/AX call fails with opaque errors.
- Grant the same two to **your terminal / MCP host app** — the oss backend runs as a plain node child of the host and inherits its TCC identity.
- `run_script` triggers macOS's one-time **Automation** (Apple Events) prompt per target app on first use.

## Install & register

```bash
git clone https://github.com/zty552252kevin-code/desktop-hub.git
cd desktop-hub
npm ci        # not `npm install` — the code relies on SDK 1.30.0 internals pinned in the lockfile
claude mcp add desktop-hub -s user -- node "$(pwd)/server.mjs"   # path must be absolute
```

Mainland China mirror (kept in sync): `git clone https://gitee.com/zty552252kevin/desktop-hub.git`

Only if you previously registered `cua-driver` or `computer-use-mcp` as standalone MCP servers: disable those entries (e.g. `disabledMcpServers` in `~/.claude.json`) so this hub takes over. Fresh installs skip this step.

### Verify

```bash
npm test                        # 20 checks; spawns the real driver and runs osascript on your desktop
DESKTOP_HUB_TEST_OSS=1 npm test # also exercises the oss backend (slow first npx spawn, needs network)
```

The suite requires cua-driver installed with permissions granted — failures without them are setup issues, not hub bugs.

### Environment variables

| Var | Meaning | Default |
|---|---|---|
| `DESKTOP_HUB_CUA_BIN` | Path to the cua-driver binary | `~/.local/bin/cua-driver` |
| `DESKTOP_HUB_OSS_SPEC` | npx spec for the oss backend (pinned deliberately; bump consciously) | `@zavora-ai/computer-use-mcp@7.0.0` |
| `DESKTOP_HUB_TEST_OSS` | `1` = include the oss leg in `npm test` | off |

## Design notes & pitfalls (hard-won)

- Crashed backends are auto-evicted and respawned on next call (via `client.onclose` — `transport.onclose` gets overwritten by the SDK). Hung backends: the call fails with RequestTimeout and the backend is killed + respawned; `desk_describe`'s listTools path evicts too. All evictions are **generation-guarded** so a late `onclose` from an old process can never delete a freshly respawned client (which would orphan it and strand every `element_token`).
- Host exit (stdin EOF / SIGTERM / SIGINT) cascades shutdown to both backends, **bounded at 5s** — a mid-handshake npx cold start can't keep a host-less hub alive for the 180s handshake window; still-connecting children get force-killed.
- Host-side cancellation (e.g. Esc in Claude Code) genuinely aborts: the abort signal is threaded into upstream `callTool` and kills the `osascript` child, so a queued click/script never lands on the real desktop after you cancel.
- `act`: `double_click`/`right_click`/`set_value`/`menu` require `pid` (upstream hard requirement — `element_token` alone is not enough); desktop-scope double-click = `action:"click"` + `extra:{count:2}`. `scope:"desktop"` must not carry `pid`/`window_id` — the facade strips them automatically. Pixel-path drag/scroll on multi-window apps needs `window_id` or upstream refuses as ambiguous. Target-less scroll (pid only) sends arrow/PageDown keys to the focused control — pass `element_token` or `x,y` to wheel-scroll a specific spot.
- Coordinate spaces differ across backends: `desktop_screenshot` returns **true screen pixels** (2x on Retina) — correct for cua `scope:"desktop"`; oss pointer tools via `desk_call` use **logical points** (1x). Divide by the returned scale factor, or take coordinates from `desk_call oss screenshot`.
- `run_script`: language is case-insensitive with unknown values rejected loudly; output past 1MB/stream is drained (the script runs to completion, side effects intact) while the returned body is clipped to 8KB with a dropped-bytes note; multibyte CJK never splits across pipe chunks.
- SwiftUI apps (e.g. Calculator) may embed invisible characters (U+200E) in display values — `verify`'s `value_equals` then returns `unknown`; use `label_contains` or read the `window_state` markdown instead.
- Adversarially reviewed in two multi-agent rounds (21 + 20 reviewers, 28 confirmed defects fixed — round 2 caught two regressions introduced by round-1 fixes). Regression suite in `test/smoke.mjs`.

## Third-party tools

desktop-hub is a facade that **launches two independently developed tools as separate MCP server processes**; they are not included in this repo and are installed separately by you:

- **cua-driver** (`CuaDriver.app`, `com.trycua.driver`) — MIT, © Cua AI, Inc. — <https://github.com/trycua/cua>
- **@zavora-ai/computer-use-mcp** — MIT, © Zavora Technologies Ltd. — <https://github.com/zavora-ai/computer-use-mcp>

"cua", "CuaDriver" and "Zavora" are names/marks of their respective owners, used nominatively to identify the tools; this project is not affiliated with or endorsed by either.

## License

[MIT](LICENSE)

---

# 中文说明

macOS 桌面自动化的**精简聚合 MCP 服务器**：用 ~2.3k token 的 10 个工具定义，替代 cua-driver（56 工具 ~37k token）+ computer-use-mcp（64 工具 ~21k token）合计 ~58k token 的上下文占用，120 个底层工具一个不少（长尾经 `desk_call` 直达、schema 用 `desk_describe` 按需取）。

## 安装

前置：macOS、Node 18+、cua-driver（用 [trycua/cua](https://github.com/trycua/cua) 官方一键脚本装，见上方英文 Prerequisites，装完默认路径即本 hub 默认路径）；oss 后端**无需手装**，首次 `desk_call server:"oss"` 时 npx 自动拉取 `@zavora-ai/computer-use-mcp@7.0.0`（首次需联网，大陆用户建议配 npm 镜像）。

```bash
git clone https://github.com/zty552252kevin-code/desktop-hub.git
cd desktop-hub
npm ci
claude mcp add desktop-hub -s user -- node "$(pwd)/server.mjs"   # 必须绝对路径
```

国内镜像（同步更新，免翻墙）：`git clone https://gitee.com/zty552252kevin/desktop-hub.git`

权限：给 **CuaDriver.app** 授予「辅助功能」+「屏幕录制」（推荐 `cua-driver permissions grant` 让弹窗归属到 App 身份，升级不掉权限）；oss 后端跟随宿主终端的 TCC 身份，终端也要授同样两项；`run_script` 首次对每个目标 App 会弹一次「自动化」授权。

此前如果单独注册过 cua/oss 两个 MCP 服务器，把它们 disable 掉由本 hub 接管；全新安装跳过这步。

验证：`npm test`（20 项检查，会真实驱动桌面；`DESKTOP_HUB_TEST_OSS=1` 含 oss 后端）。环境变量见上方英文表格。

## 坑（血泪换来的）

- 后端崩溃自动清理、下次调用重生（依赖 `client.onclose`，`transport.onclose` 会被 SDK 覆写）；假死后端该次调用报 RequestTimeout 并杀掉重生，`desk_describe` 的 listTools 超时同样驱逐。所有驱逐带**代际守卫**：旧进程迟到的 onclose 不会误删刚重生的新 client（否则孤儿化新后端 + element_token 全部失效）。
- 宿主退出级联关停两个后端、**限时 5s** 强退，握手中的子进程也会被补刀（否则 npx 冷启动握手期能把无宿主 hub 拖 180s）。
- 宿主取消（Esc）真正中止：信号贯通到上游 callTool 和 osascript 子进程，取消后排队的点击/脚本不会再落到真桌面。
- `act`：double_click/right_click/set_value/menu 必须带 `pid`（上游硬性要求）；`scope:"desktop"` 禁止携带 pid/window_id（facade 自动剔除）；多窗口应用的像素 drag/scroll 必须带 `window_id`；无目标 scroll 走键击路径（发给焦点控件），要滚指定区域必须给 element_token 或 x,y。
- 坐标系不同：`desktop_screenshot` 是 Retina 真像素（2x），cua desktop-scope 用它；oss 指针工具用逻辑坐标（1x），要除以 scale factor 或从 `desk_call oss screenshot` 取坐标。
- `run_script`：language 大小写不敏感、未知值明确报错；输出超 1MB 不杀脚本（继续排水跑完、副作用完整），回传剪裁到 8KB 并标注丢弃量；中文跨管道块不出乱码。
- SwiftUI 应用显示值可能带 U+200E 隐形字符，`verify` 的 `value_equals` 会 unknown，改用 `label_contains`。
- 经两轮多 agent 对抗评审（21+20 个审查员）累计修复 28 项确认缺陷（第二轮抓出第一轮两个修复自身引入的回归）。
