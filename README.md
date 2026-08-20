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
- 后端进程崩溃会被自动清理并在下次调用时重新拉起（依赖 `client.onclose`，不是 `transport.onclose`——后者会被 SDK 覆写）；后端假死时该次调用报 RequestTimeout 并自动杀掉重生。
- 宿主退出（stdin EOF/SIGTERM/SIGINT）会级联关停两个后端子进程，不留孤儿。
- `act` 的 double_click/right_click/set_value/menu 必须带 `pid`（上游硬性要求，element_token 不能替代）；桌面范围双击用 `action:"click"` + `extra:{count:2}`。
- `run_script` 输出每流上限 1MB（超限杀进程并标注截断）；多字节中文跨管道块不再出乱码。
- 2026-08-20 经 21-agent 评审工作流对抗验证，修复 15 项确认缺陷（见 git log 294bacc）。
