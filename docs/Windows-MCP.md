# Windows-MCP 接入说明

> 说明 Jarvis 如何接入外部 MCP「Windows 桌面控制」，以及它与内置方案的分工、启用与排障。

## 一、它是什么

接入社区项目 [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP)（MIT 协议，Python 实现），以**外部 stdio MCP 服务器**方式挂载，未启用时 Jarvis 行为不变。

与内置方案的**分工**：

| 方案 | 路线 | 特点 |
|---|---|---|
| Jarvis 内置（DesktopCommander） | 终端与文件编辑 + 「截图 + 视觉模型猜坐标」 | 通用 |
| Windows-MCP | **UIA 无障碍树**直读控件结构 | 不猜坐标、点击更准；文本快照比截图省 token；补齐注册表、剪贴板、通知、窗口管理等系统级能力 |

工具名自动加 `windows_mcp__` 前缀，调用同样经过安全闸门（高危确认 + `audit.jsonl` 审计），急停快捷键有效。注册表读写、进程查杀等属高危操作，会触发确认窗。

## 二、启用的工具

| 类别 | 工具 |
|---|---|
| 桌面感知 | `Snapshot`（UIA 控件树快照）、`DisplayInventory` |
| 鼠标键盘 | `Click`、`Type`、`Scroll`、`Move`、`Shortcut`、`Wait`、`WaitFor` |
| 窗口管理 | `App`（启动 / 缩放 / 移动 / 切换窗口） |
| 系统设施 | `Clipboard`、`Notification`、`Registry`、`Process`、`PowerShell` |
| 文件与网页 | `FileSystem`、`Scrape`（网页抓取）、`MultiSelect`、`MultiEdit` |

**默认排除 `Screenshot`**：Jarvis 自带视觉通道已能截图送模型，且 MCP 图片类结果暂不做多模态渲染。需要时去掉 `--exclude-tools Screenshot` 即可。

## 三、安装与启用

### 面板一键安装（推荐）

面板 → MCP 设置 → 「一键安装 Windows 桌面控制」。Jarvis 自动完成：检测是否已装 → 缺 uv 时下载便携版 uv（官方源，失败切国内镜像）→ `uv tool install windows-mcp`（PyPI 失败自动重试 TUNA 备用源）→ 把 `windows-mcp.exe` **绝对路径**写入外部 MCP 配置并**立即重连**，将新工具下发给模型。进度以系统提示显示在聊天区。

### 手动安装

需要 Python ≥ 3.14（推荐用 [uv](https://docs.astral.sh/uv/) 管理，不污染系统环境）：

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 | iex"
uv tool install windows-mcp
windows-mcp serve --help   # 验证
```

随后在 面板 → MCP 设置 → 选择预设「Windows 桌面控制（Windows-MCP）」→ 启用。等价手写配置：

```json
{
  "name": "windows-mcp",
  "command": "windows-mcp",
  "args": ["serve", "--transport", "stdio", "--exclude-tools", "Screenshot"],
  "enabled": true
}
```

外部 MCP 在**会话首次建立时后台启动**（不阻塞对话）。日志出现 `[ExtMCP] 「windows-mcp」发现 19 个工具` 即挂载成功。

## 四、排障

| 现象 | 原因与处理 |
|---|---|
| 初始化超时 / 反复失败 | 不要用 `uvx` 临时拉起（每次可能联网解析包元数据，代理失效时会重试失败）；用 `uv tool install` 装成独立 exe 再拉起，零联网依赖 |
| 首次启动慢 | 正常：需下载托管 Python 3.14 与约 90 个依赖；装完后冷启动约 2 秒 |
| 启动即报 `Missing command` | `--transport stdio` 须显式指定，预设已带全参数 |
