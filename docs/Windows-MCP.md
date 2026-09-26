# Windows-MCP 接入说明（v1.2.0）

> 本文档说明 v1.2.0 版本**改动了什么、新增了什么**，以及如何启用和使用 Windows 桌面控制能力。

## 一、这次改动的内容

| 项 | 说明 |
|---|---|
| 改动文件 | `src/main/mcp-presets.ts`（新增预设）、`README.md`（新增章节）、`package.json`（版本 1.1.0 → 1.2.0）、本文档 |
| 新增能力 | 外部 MCP 预设「Windows 桌面控制（Windows-MCP）」 |
| 接入的项目 | [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP)（7k+ stars，MIT 协议，Python 实现） |
| 兼容性 | 不改动任何既有功能；Windows-MCP 以**外部 stdio MCP 服务器**方式挂载，未启用时 Jarvis 行为与之前完全一致 |

### 为什么要接入它

Jarvis 内置的 MCP（DesktopCommander）强在**终端与文件编辑**，桌面操作走的是「截图 + 视觉模型猜坐标」路线。Windows-MCP 补齐的是另一条路线——**UIA 无障碍树**：

- 直接读取控件树结构，不依赖视觉模型猜坐标，点击更准；
- 文本形式的 UI 快照比截图省大量 token；
- 带来一批 Jarvis 原本没有的系统级能力（注册表、剪贴板、通知、窗口管理等）。

### 新增的 19 个工具（启用后以 `windows_mcp__` 前缀暴露给模型）

| 类别 | 工具 |
|---|---|
| 桌面感知 | `Snapshot`（UIA 控件树快照）、`DisplayInventory`（显示器枚举） |
| 鼠标键盘 | `Click`、`Type`、`Scroll`、`Move`（拖拽）、`Shortcut`（组合键）、`Wait`、`WaitFor` |
| 窗口管理 | `App`（启动/缩放/移动/切换窗口） |
| 系统设施 | `Clipboard`、`Notification`（系统通知）、`Registry`（注册表读写）、`Process`（进程列出/查杀）、`PowerShell` |
| 文件与网页 | `FileSystem`、`Scrape`（网页抓取）、`MultiSelect`、`MultiEdit` |

**默认排除了 `Screenshot` 工具**：Jarvis 自带视觉通道已能截图送模型分析，且 MCP 图片类工具结果 Jarvis 的编排器暂不做多模态渲染，排除后避免模型选到无效工具。如需开启，去掉配置里的 `--exclude-tools Screenshot` 参数即可。

## 二、如何启用

### 前置条件：安装 Windows-MCP

需要 Python ≥ 3.14（推荐用 [uv](https://docs.astral.sh/uv/) 管理，不污染系统环境）：

```powershell
# 1. 安装 uv（已安装可跳过）
powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 | iex"

# 2. 安装 windows-mcp（uv 会自动下载对应版本的 Python，无需手动装）
uv tool install windows-mcp

# 3. 验证
windows-mcp serve --help
```

### 在 Jarvis 中启用

面板 → MCP 设置 → 从预设中选择「**Windows 桌面控制（Windows-MCP）**」→ 启用。等价的手写配置：

```json
{
  "name": "windows-mcp",
  "command": "windows-mcp",
  "args": ["serve", "--transport", "stdio", "--exclude-tools", "Screenshot"],
  "enabled": true
}
```

外部 MCP 在**会话首次建立时后台启动**（不阻塞对话），日志中看到 `[ExtMCP] 「windows-mcp」发现 19 个工具` 即为挂载成功。所有调用走 Jarvis 既有安全闸门（高危确认、审计日志）。

## 三、踩坑记录（重要）

1. **不要依赖 `uvx` 临时拉起**：`uvx windows-mcp` 每次启动都可能联网解析包元数据。若机器上有失效的代理配置（如残留的 `127.0.0.1:7897`），uv 会重试 3 次后失败，导致外部 MCP 初始化超时。**用 `uv tool install` 装成独立 exe 再让 Jarvis 直接拉起，零联网依赖**，这也是预设默认采用 `command: "windows-mcp"` 的原因。
2. **首次启动慢属正常**：`uv tool install` 首次要下载托管版 Python 3.14 与约 90 个依赖包；装完后 Jarvis 侧冷启动约 2 秒。
3. **`--transport stdio` 必须显式指定**：`windows-mcp` 的 CLI 不带子命令会直接报错退出（`Missing command`），Jarvis 预设已带全参数。

## 四、安全说明

- Windows-MCP 侧自带 `--auth-key`、IP 白名单等远程访问防护（本预设使用本地 stdio，不暴露网络端口，不涉及）；
- 所有工具调用经 Jarvis 的 `safety.js` 闸门与 `audit.jsonl` 审计，急停快捷键仍然有效；
- 注册表/进程查杀属高危操作，触发确认窗，需人工批准。
