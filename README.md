# desktop-hub

macOS 桌面自动化的**精简聚合 MCP 服务器**：用 ~2k token 的 10 个工具定义，替代 cua-driver（56 工具 ~37k token）+ computer-use-oss（64 工具 ~21k token）合计 ~58k token 的上下文占用，功能一个不少。

## 架构

```
Claude Code ──MCP──> desktop-hub (本服务器, 10 个精简工具)
                        ├─ 懒加载 stdio 子进程 ──> cua-driver mcp      (免抢鼠标桌面控制)
                        ├─ 懒加载 stdio 子进程 ──> computer-use-mcp    (AX 树/探路/审计, 首次调用才 spawn)
                        └─ 本地 osascript                              (AppleScript/JXA 真后台脚本)
```

## 工具

| 工具 | 说明 |
|---|---|
| `desktop_screenshot` | 全屏截图（→ cua get_desktop_state） |
| `list_windows` | 列窗口，含最小化/其他 Space（→ cua） |
| `launch_app` | 后台启动 App，不抢焦点（→ cua） |
| `window_state` | AX 树 + 截图，元素带 element_token（→ cua get_window_state） |
| `act` | 十种动作合一：click/double_click/right_click/type/key/hotkey/scroll/drag/set_value/menu（→ cua 对应工具，参数按表映射） |
| `verify` | 确定性断言窗口/元素状态（→ cua verify_state） |
| `zoom` | 窗口局部放大截图（→ cua） |
| `run_script` | 本地 osascript 跑 AppleScript/JXA，不经任何后端 |
| `desk_call` | 逃生舱：直调两家底层 120 个工具中任意一个 |
| `desk_describe` | 按需取底层工具目录/完整 schema（token 用时才花） |

## 注册

```bash
claude mcp add desktop-hub -s user -- node /Users/kevin/desktop-hub/server.mjs
```

同时在 `~/.claude.json` 各项目条目里把 `cua-computer-use`、`computer-use-oss` 加进 `disabledMcpServers`（本服务器接管）。

## 依赖与坑

- 依赖 `~/.local/bin/cua-driver`（可用 `DESKTOP_HUB_CUA_BIN` 覆盖）与 npx 缓存里的 `@zavora-ai/computer-use-mcp`。
- oss 首次调用要 spawn npx，慢几秒，属正常（握手超时已放宽到 180s，失败会附带 stderr 尾巴）。
- 计算器等 SwiftUI 应用的显示值可能带不可见字符（如 U+200E），`verify` 的 `value_equals` 精确匹配会 unknown，改用 `label_contains` 或读 window_state markdown。
- 后端进程崩溃会被自动清理并在下次调用时重新拉起（依赖 `client.onclose`，不是 `transport.onclose`——后者会被 SDK 覆写）；后端假死时该次调用报 RequestTimeout 并自动杀掉重生（`desk_describe` 的 listTools 超时同样驱逐）。所有驱逐都带**代际守卫**：旧进程迟到的 onclose 不会误删刚重生的新 client（否则会孤儿化新后端 + element_token 全部失效）。
- 宿主退出（stdin EOF/SIGTERM/SIGINT）会级联关停两个后端子进程，不留孤儿；整个关停**限时 5s** 强退，握手中的子进程也会被补刀（否则冷启动 npx 握手期能把无宿主 hub 拖 180s）。
- 宿主取消（如 Esc）会真正中止：`extra.signal` 贯通到上游 callTool 与 osascript 子进程，取消后排队中的点击/脚本不会再落到真桌面。
- `act` 的 double_click/right_click/set_value/menu 必须带 `pid`（上游硬性要求，element_token 不能替代）；桌面范围双击用 `action:"click"` + `extra:{count:2}`。`scope:"desktop"` 上游禁止携带 pid/window_id，facade 会自动剔除。像素路径的 drag/scroll 在多窗口应用上必须带 `window_id`，否则上游拒绝 ambiguous_window_target。无目标的 scroll（只给 pid）走键击路径（方向键/PageDown 发给当前焦点控件），要滚动指定区域必须给 element_token 或 x,y。
- `desk_call` 打 oss 的指针类工具用的是**逻辑坐标**（1x 点），不是 `desktop_screenshot` 的 Retina 真像素（2x）——坐标要从 `desk_call oss screenshot` 取，或除以 scale factor。
- `run_script` 的 language 大小写不敏感、未知值明确报错（不再静默当 AppleScript 跑）；输出超 1MB **不杀脚本**（继续排水让脚本跑完、副作用完整），回传给模型的正文剪裁到 8KB 并标注丢弃量；多字节中文跨管道块不出乱码。
- 2026-08-20 经两轮评审工作流对抗验证（21+20 agents），累计修复 28 项确认缺陷（第二轮抓出第一轮两个修复自身引入的回归；见 git log 294bacc 与后续提交）。
