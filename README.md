# desktop-hub

**A compact facade MCP server for macOS desktop automation.** It exposes just 11 hand-written tools (~2.8k tokens of definitions) and lazily proxies to two full-featured computer-use MCP servers — [cua-driver](https://github.com/trycua/cua) (56 tools, ~37k tokens) and [computer-use-mcp](https://github.com/zavora-ai/computer-use-mcp) (64 tools, ~21k tokens) — plus native `osascript`. You keep the entire 120-tool surface, but your context window pays ~2k tokens instead of ~58k.

[中文说明在下方](#中文说明) · [Gitee mirror 国内镜像](https://gitee.com/zty552252kevin/desktop-hub) · Works with Claude Code and any MCP client.

## Why

Registering both upstream servers directly costs ~58k context tokens per session just for tool definitions, while the high-frequency surface is small. This facade keeps the hot path cheap and the long tail reachable:

```
MCP client ──stdio──> desktop-hub (this server, 11 compact tools)
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
| `window_state` | AX-tree walk + grounding screenshot; elements carry `element_token` (→ cua). `diff:true` returns only changes vs your previous call on the same window — a busy tree drops from kBs to a few lines in observation loops |
| `act` | Ten actions in one: click / double_click / right_click / type / key / hotkey / scroll / drag / set_value / menu (→ mapped to cua tools) |
| `act_batch` | Up to 8 act steps in ONE round-trip; a step's `find:{role,label,value,nth}` re-walks the AX tree right before it and injects a fresh `element_token` — collapses "click, type, press return" into one call |
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
npm test                        # 68 checks; spawns the real driver and runs osascript on your desktop
DESKTOP_HUB_TEST_OSS=1 npm test # +1 check: also exercises the oss backend (slow first npx spawn, needs network)
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
- Backend outputSchema validation is deliberately disarmed. cua-driver 0.20.0 returns envelopes that violate its own declared outputSchema, and the SDK client arms validation lazily — only after `listTools()`. With a real validator every cua tool works until the first `desk_describe`, then every call throws `-32602` **after the upstream action already executed** (success misreported as failure). The injected validator returns `undefined` rather than an always-pass function: the SDK's sibling check ("has an output schema but did not return structured content", `-32600`) fires on any *truthy* cached validator, before the validator is even invoked. The hub passes results through verbatim; the host's own client still validates the hub's tools.
- Host exit (stdin EOF / SIGTERM / SIGINT) cascades shutdown to both backends, **bounded at 5s** — a mid-handshake npx cold start can't keep a host-less hub alive for the 180s handshake window; still-connecting children get force-killed.
- Host-side cancellation (e.g. Esc in Claude Code) genuinely aborts: the abort signal is threaded into upstream `callTool` and kills the `osascript` child, so a queued click/script never lands on the real desktop after you cancel.
- `act`: `double_click`/`right_click`/`set_value`/`menu` require `pid` (upstream hard requirement — `element_token` alone is not enough); desktop-scope double-click = `action:"click"` + `extra:{count:2}`. `scope:"desktop"` must not carry `pid`/`window_id` — the facade strips them automatically. Pixel-path drag/scroll on multi-window apps needs `window_id` or upstream refuses as ambiguous. Target-less scroll (pid only) sends arrow/PageDown keys to the focused control — pass `element_token` or `x,y` to wheel-scroll a specific spot.
- Coordinate spaces differ across backends: `desktop_screenshot` returns **true screen pixels** (2x on Retina) — correct for cua `scope:"desktop"`; oss pointer tools via `desk_call` use **logical points** (1x). Divide by the returned scale factor, or take coordinates from `desk_call oss screenshot`.
- `run_script`: language is case-insensitive with unknown values rejected loudly; output past 1MB/stream is drained (the script runs to completion, side effects intact) while the returned body is clipped to 8KB with a dropped-bytes note; multibyte CJK never splits across pipe chunks.
- SwiftUI apps (e.g. Calculator) may embed invisible characters (U+200E) in display values — `verify`'s `value_equals` then returns `unknown`; use `label_contains` or read the `window_state` markdown instead.
- iPad-ported apps ("Designed for iPad", e.g. rednote/小红书) are a blind spot for synthetic input: background-posted scroll/drag and synthetic long-press gestures are ignored entirely (transport reports success, nothing happens). The only working fallback is `desk_call` into the oss backend's pointer tools (HID-level — but they move the real cursor); `run_script` can't produce these gestures either (iPad ports expose no AppleScript dictionary, and System Events has no scroll/drag/long-press primitives).
- `window_state`'s grounding screenshot can lag the live frame. For verification that must be current, take a fresh `desktop_screenshot` (or use native `screencapture`) instead of trusting the bundled image.
- Expired cua lifecycle sessions are auto-revived: cua rejects every call on an idle-expired session (the action is **not** executed), which used to cost the model a 2-3 call recovery dance. The hub revives (`start_session`, idempotent) and retries once, appending a note that pre-expiry `element_token`s may be stale. Guardrails, each earned in adversarial review: the rejection must name the exact tool just called (an error that merely *quotes* an inner rejection — e.g. a replay tool reporting a failed step — must not trigger a blind re-run of an outer call that already had side effects); if the retry itself dies mid-flight, the hub reports **outcome UNKNOWN** instead of echoing the original "not executed" text (the retry went to a live session and may have landed). One case genuinely can't be revived — a **named** session minted by a previous hub/backend process ("session is not available to this transport"); upstream's error still suggests reviving, so the hub appends the actionable correction: use a new session label.
- `window_state` on huge web/Electron trees can return 100KB+ — bound it with `query` and/or `max_elements`/`max_depth` (upstream defaults: 2 000 elements, depth 25).
- `window_state` `diff:true` keeps a server-side baseline per (pid, window_id, query, caps; last 8 windows) — the first call returns the full tree; degraded trees and >50% churn fall back to full automatically. If the previous tree has been compacted out of your context, call once without `diff` to re-ground (the server can't know what you still remember). Static text and text-area values live only in `tree_markdown`, so the diff appends an `md+` line hint for them.
- **Latency is mostly outside the hub — design for round trips, not milliseconds.** Measured over 712 real hub steps under Claude Code: hub+cua itself takes 1-650 ms per call, but a step costs the host a permission round trip (~3.5 s per Bash/MCP call in auto mode unless the tool is allow-listed) plus a full model turn (~12 s text-only, ~30 s when the result carries an image). The image penalty is about *presence*, not bytes: a 10 KB `zoom` JPEG costs the same extra vision turn as a 400 KB PNG, and the model then reasons ~13x longer. Hence the guidance baked into the tool descriptions and server instructions: text-first observation (`window_state` with `diff:true` / `include_screenshot:false`), screenshots as checkpoints only, 3-6 deterministic steps per `act_batch` with `observe:true`, never re-observe without an intervening action. Downscaling/transcoding screenshots was evaluated and deliberately NOT done (cua already caps window shots at 1568 px; bytes are not the cost).
- `act_batch` step lines print cua's action envelope (`effect=… route=…`, plus `escalation=…` when background delivery fell back to synthetic events) and flag anything other than `confirmed`/`unverifiable` with ⚠ — a bare "ok" used to hide a suspected no-op click while the batch kept typing into whatever had focus.
- `act_batch` semantics, each choice deliberate: every step is validated before ANY executes (a batch dying on step 4's typo after steps 1-3 clicked is the worst outcome); execution stops at the first failure and the summary says so — steps before it DID run, so re-observe before re-issuing. `find` matching is exact role + case-insensitive **substring** on label/value — never regex (model-supplied patterns on a single-threaded server are a ReDoS vector). An ambiguous find without `nth` is a hard error listing candidates (guessing clicks the wrong control). A find-miss on an incomplete tree deserves special care: live probing shows cua reports `elements_complete:false` on essentially every real window (Terminal and Edge both stay `false` even at `max_elements:10000` — chronic, not cap-related), so `if_present` skips with an explicit absence-unproven caveat instead of erroring, while a required find still fails with wording that doesn't pretend a bigger cap would fix it.
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

macOS 桌面自动化的**精简聚合 MCP 服务器**：用 ~2.8k token 的 11 个工具定义，替代 cua-driver（56 工具 ~37k token）+ computer-use-mcp（64 工具 ~21k token）合计 ~58k token 的上下文占用，120 个底层工具一个不少（长尾经 `desk_call` 直达、schema 用 `desk_describe` 按需取）。

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

验证：`npm test`（68 项检查，会真实驱动桌面；`DESKTOP_HUB_TEST_OSS=1` 再加 1 项 oss 后端检查）。环境变量见上方英文表格。

## 坑（血泪换来的）

- 后端崩溃自动清理、下次调用重生（依赖 `client.onclose`，`transport.onclose` 会被 SDK 覆写）；假死后端该次调用报 RequestTimeout 并杀掉重生，`desk_describe` 的 listTools 超时同样驱逐。所有驱逐带**代际守卫**：旧进程迟到的 onclose 不会误删刚重生的新 client（否则孤儿化新后端 + element_token 全部失效）。
- 对后端的 outputSchema 校验刻意解除。cua-driver 0.20.0 的返回信封违反它自己声明的 outputSchema，而 SDK 客户端的校验是懒生效的——`listTools()` 之后才缓存校验器。真校验时的表现是：cua 工具一切正常，直到第一次 `desk_describe`，之后每次调用都抛 `-32602`——而且**上游动作其实已经执行了**（成功被误报成失败，自动化最坏的失败模式）。注入的校验器返回 `undefined` 而非"永远通过"的函数：SDK 还有个姊妹检查（声明了 outputSchema 却没返回 structuredContent 即抛 `-32600`），只要缓存的校验器为 truthy 就会触发，且发生在校验函数被调用之前。hub 原样透传结果；宿主自己的客户端仍会校验 hub 的工具。
- 宿主退出级联关停两个后端、**限时 5s** 强退，握手中的子进程也会被补刀（否则 npx 冷启动握手期能把无宿主 hub 拖 180s）。
- 宿主取消（Esc）真正中止：信号贯通到上游 callTool 和 osascript 子进程，取消后排队的点击/脚本不会再落到真桌面。
- `act`：double_click/right_click/set_value/menu 必须带 `pid`（上游硬性要求）；`scope:"desktop"` 禁止携带 pid/window_id（facade 自动剔除）；多窗口应用的像素 drag/scroll 必须带 `window_id`；无目标 scroll 走键击路径（发给焦点控件），要滚指定区域必须给 element_token 或 x,y。
- 坐标系不同：`desktop_screenshot` 是 Retina 真像素（2x），cua desktop-scope 用它；oss 指针工具用逻辑坐标（1x），要除以 scale factor 或从 `desk_call oss screenshot` 取坐标。
- `run_script`：language 大小写不敏感、未知值明确报错；输出超 1MB 不杀脚本（继续排水跑完、副作用完整），回传剪裁到 8KB 并标注丢弃量；中文跨管道块不出乱码。
- SwiftUI 应用显示值可能带 U+200E 隐形字符，`verify` 的 `value_equals` 会 unknown，改用 `label_contains`。
- iPad 移植应用（"专为 iPad 设计"，如小红书）是合成输入的盲区：后台投递的 scroll/drag 和一切合成长按拖拽手势完全免疫（transport 报成功、实际没反应）。唯一有效的兜底是 `desk_call` 调 oss 后端的指针工具（HID 层——但会动真实光标）；`run_script` 也救不了（iPad 移植应用没有 AppleScript 字典，System Events 也没有滚动/拖拽/长按原语）。
- `window_state` 附带的截图可能是陈旧帧。要求"此刻"准确的核验请另拍 `desktop_screenshot`（或原生 `screencapture`），别只信附带的图。
- cua 生命周期 session 空闲过期后自动复活：过期 session 上的任何调用都会被 cua 拒绝（动作**未**执行），过去要靠模型跳 2-3 个调用的复活舞步；hub 自动 `start_session`（幂等）+ 重试一次，并附注过期前的 `element_token` 可能已失效。两道护栏（都是对抗评审换来的）：错误必须点名**本次调用的工具**才触发（只是*引用*了内层拒绝的错误——如回放类工具报告某步失败——绝不能盲目重跑已有副作用的外层调用）；重试自身半路挂掉时，hub 报告**结果未知**而不是回显原始的"未执行"文本（重试发到的是活 session，可能已经落地）。唯一救不回的场景：**具名** session 跨 hub/后端进程复活必失败（"session is not available to this transport"），而上游错误文本仍在误导性地建议 revive——hub 会在原错误后追加可行动的更正：换一个新 session 标签。
- `window_state` 在大型网页/Electron 树上可能返回 100KB+——用 `query` 和/或 `max_elements`/`max_depth` 兜住（上游默认 2000 元素、25 层）。
- `window_state` 的 `diff:true` 在服务端按 (pid, window_id, query, 上限参数) 存基线（最近 8 个窗口）——首次调用返回全树；degraded 树和 >50% 大改自动回退全树。若上一棵树已被压缩出你的上下文，先不带 `diff` 调一次重新对齐（服务端不知道你还记得什么）。静态文本/文本区内容只存在于 `tree_markdown`，diff 会附 `md+` 行提示。
- **慢在 hub 外面，设计要省往返而不是省毫秒。** 712 步真实调用实测：hub+cua 本身每次 1–650ms，但宿主每步要付一次权限审查往返（auto 模式下每次 Bash/MCP 约 3.5s，除非工具在 allow 名单）加一整轮模型（纯文本约 12s，结果带图约 30s）。图片的代价在"有没有"而不在"多大"：10KB 的 `zoom` JPEG 和 400KB PNG 一样多付一轮视觉处理，之后模型推理量还涨 13 倍。所以工具描述和服务器 instructions 里写死了：观察文本优先（`window_state` 用 `diff:true` / `include_screenshot:false`），截图只当检查点，一次 `act_batch` 放 3–6 个确定的步骤再 `observe:true` 看一次，没有新动作就不要重复观察。截图降采样/转码评估后**刻意不做**（cua 已把窗口截图钉在 1568px；字节数不是成本）。
- `act_batch` 每步会打印 cua 的动作信封（`effect=… route=…`，后台投递失败回退到合成事件时附 `escalation=…`），非 `confirmed`/`unverifiable` 的结果加 ⚠——以前光写 "ok" 会把疑似空点击藏起来，批次继续往焦点里打字。
- `act_batch` 的每条语义都是刻意的：所有步骤先全部校验、任何一步不合法则**一个都不执行**（第 4 步笔误、前 3 步已点完是最坏结局）；执行中首个失败即停，且摘要明说"失败前的步骤已经执行了，重新观察再重发"。`find` 匹配 = role 精确 + label/value 大小写不敏感**子串**——绝不用正则（模型供给的 pattern 在单线程服务器上就是 ReDoS 攻击面）。无 `nth` 的多匹配是硬错误并列出候选（瞎猜会点错控件）。不完整树上的 find 落空要特别小心：真机探测发现 cua 在几乎所有真实窗口上都报 `elements_complete:false`（Terminal 和 Edge 把 `max_elements` 提到 10000 依然 false——慢性状态，与截断上限无关），所以 `if_present` 改为带"absence unproven"警示的跳过而非报错；必选 find 落空仍报错，但措辞不再假装调大上限能解决。
- 经两轮多 agent 对抗评审（21+20 个审查员）累计修复 28 项确认缺陷（第二轮抓出第一轮两个修复自身引入的回归）。
