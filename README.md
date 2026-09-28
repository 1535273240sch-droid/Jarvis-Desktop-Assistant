# Jarvis - Windows 11 桌面智能助理 (Desktop AI Assistant)

> Windows 11 桌面 AI 助理：**WebGPU 流体玻璃悬浮球**、**实时全双工语音 (Realtime Voice)**、**MCP 桌面工具执行**、**多模态屏幕理解** 与 **AI 唱歌**。

| 项目 | 信息 |
|---|---|
| 运行时 | Electron 34 + TypeScript 5.7（Node.js 22） |
| 图形 | WebGPU API + WGSL 着色器 |
| 平台 | Windows 10 / 11（64 位），显卡需支持 WebGPU |
| 安装包 | NSIS（electron-builder），不内置任何密钥 |
| 协议 | WebSocket（实时语音）/ JSON-RPC 2.0（MCP over stdio）/ HTTPS（视觉、音乐） |
| 版本 | v1.4.29 |

## 一、这是什么

常驻桌面右下角的一颗 **流体玻璃悬浮球 (Liquid Glass Orb)**，配一扇晶体玻璃对话面板：用语音或文字交流，让它看屏幕、操作电脑、执行长任务。

## 二、能做什么

| 能力 | 说明 |
|---|---|
| 🔮 悬浮球 | WebGPU（WGSL）流体玻璃球，136 项 uniform；6 态状态机 `idle / listening / thinking / executing / speaking / error`；透明区域点击穿透、球体可拖拽并记忆位置；尺寸 80~400px 可调（可开「随状态自适应」） |
| 🎙️ 实时语音 | 原生 WebSocket 双向流式，24kHz 单声道 PCM16，端到端几百毫秒；用户开口即打断（清空播放缓冲 + `response.cancel`）；Server VAD 自动断句；实测被服务端接受的音色为 `cixingnansheng` / `zhengpaiqingnian` / `wenrounvsheng`，保留自定义入口 |
| ⚙️ 桌面工具 | 内置 17 个工具；内置 MCP `@wonderwhy-er/desktop-commander` 裁剪为 12 个工具；外部预设 Windows-MCP（工具加 `windows_mcp__` 前缀）可一键安装，同过安全闸门并写审计 |
| 👁️ 屏幕理解 | `desktopCapturer` + Win32 坐标换算，截活动窗口或全屏，带坐标送多模态模型，返回物理坐标用于单击/双击/输入/组合键；支持自定义视觉模型与兼容端点（OneAPI / Ollama / vLLM 等） |
| 🛰 桌面任务 | 三种长任务：浏览器搜索整理、指挥你指定的编码 Agent、微信草稿（仅草稿 + 人工发送）；进度独立展示，报告分页读取 |
| 🎵 AI 唱歌 | 说「唱首歌」即调音乐模型现场生成带人声歌曲并自动播放；异步生成、每 5 秒播报进度，失败如实告知 |

### 多主题与悬浮球稳定性

- **多主题**：默认主题 **siri**，另有 5 套用户导入主题 —— frost（霜白）、opal（蛋白石）、blueDrop（深海蓝）、refractiveBlob（紫晶）、particleRibbon（粒子丝带）。主题在构建期注入产物，面板切换即热重载；**所有主题说话/播报时的动态与默认主题一致**。
- **设备丢失自愈（三层）**：渲染器指数退避重建（5 次，合计约 15.5s）→ 宿主重载球体页兜底（10s × 6，约 60s）→ 面板「球体恢复状态」提示 + 「重试恢复球体」按钮（立即重载，不等 10 秒）。
- **WebGPU 自检已隔离**：自检改在**一次性隐藏探针窗口**中执行，拿到结果立即销毁，避免对球体正在使用的 adapter 再次 `requestDevice()` 造成干扰。
- 细节见 [docs/悬浮球-WebGPU-稳定性.md](docs/悬浮球-WebGPU-稳定性.md)。

## 三、典型用法

1. **语音控制桌面**：「打开计算器」「打开浏览器搜索今天的科技新闻」。
2. **免手伴随式助手**：不必离开当前编辑窗口，语音让它检索项目文件、修改函数或归档目录。
3. **屏幕排障**：遇到报错弹窗、蓝屏代码或英文文档，说「看屏幕」获取诊断建议。
4. **长任务监控**：后台跑编译或长命令，让它随时语音汇报进展。

## 四、架构与技术栈

| 区块 | 组成 |
|---|---|
| 渲染进程 | WebGPU 悬浮球（WGSL 着色器）+ 晶体玻璃面板 UI + Web Audio 采集/播放 |
| 主进程 | 中枢编排（六态唯一真源、打断时序）、实时语音客户端、视觉管理器、MCP 客户端 |
| 通道 A（语音） | 实时 WebSocket，Server VAD 与函数调用 |
| 通道 B（视觉） | 独立 HTTPS 多模态通道（实时语音通道不传图） |
| 安全层 | 动作语义分级、能力授权、目录白名单、敏感操作确认、审计留痕 |

## 五、快速开始

### 方式一：安装成品安装包（普通用户）

1. 下载 `Jarvis-Setup-<版本>-x64.exe`（以 Release 页实际文件名为准），双击安装（可自定义路径，自动创建快捷方式）；
2. 启动后右下角出现悬浮球并打开面板；
3. 展开面板「设置与状态」，填入 API Key、选择音色并保存（**安装包不内置任何密钥**）；
4. 点「启动语音会话」开始语音交互。

详见 [docs/安装说明.md](docs/安装说明.md)。

### 方式二：源码编译与二次开发

```bash
npm install        # 安装依赖
npm run build      # 生成球体页 → 编译 TypeScript → 拷贝资源 → 校验产物
npm run selftest   # 自测（含球体六态截图取证）
npm start          # 启动桌面客户端
npm run dist       # 打包 Windows NSIS 安装包
```

- `npm run build` 会先生成球体页（`src/renderer/orb.html` 是构建产物），再编 TS、拷资源、最后校验产物；**只手改该文件会被下次构建覆盖**。
- 免 PATH 运行器：`node scripts/run.mjs <build|start|selftest|dist|verify-orb|...>`。
- **CI**：`push main` 触发，跑 `npm run build` → `verify-tools` → `verify-tasks` → `verify-orb` → electron-builder 打 NSIS → 发布 GitHub Release。
- **版本号**：由 `github.run_number` 顶替 patch 段并取 `max`，保证单调递增。
- **可选代码签名**：配置 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` 后自动签名。

## 六、安全红线

1. **安装包与仓库不内置任何密钥**，配置统一存放于 `%APPDATA%\jarvis-desktop-assistant\config.json`。
2. **能力授权**：桌面三类能力（屏幕录制 / 鼠标 / 键盘）**默认开启**（否则无法识别屏幕）；用户主动撤回的保持停用；**对外发送永不默认授予**。撤回记录在 `authorization-revoked.json`，持久生效。
3. **对外发送与账号支付逐次独立确认**，全自动模式也不豁免（动作语义分级 ActionPolicy）。
4. **目录白名单**：MCP 工具限制在白名单目录内、高危命令前置拦截；白名单**不约束终端命令**，是减少误操作而非沙箱。
5. **统一急停** `Ctrl+Alt+X`（面板与托盘也有「停止所有桌面任务」）；退出后未完成任务持久化为「已暂停」，重启不自动重放副作用。
6. **审计脱敏**：`audit.jsonl` 不记消息正文 / 密码 / 验证码 / API Key，按 `logRetentionDays`（默认 30 天）裁剪。
7. **微信能力边界**：只做草稿与人工核验，不读本地数据库、不注入客户端、不自动发送（见 [docs/wechat-auto-reply-blocked.md](docs/wechat-auto-reply-blocked.md)）。

## 七、实测踩过并已修复的问题

| 问题 | 修复 |
|---|---|
| 视觉返回 200 但正文为空 | `step-5-preview` 是推理型模型，`max_tokens` 被思维链吃光。已提至 4096，正文为空时回退 `reasoning` 字段 |
| 工具调用后模型不继续说话 | 流式产出 `function_call` 时上一轮未结束。已加响应状态跟踪 + 挂起补发 |
| 退出后 AI 仍在说话 | 关面板只是隐藏窗口。已在关闭/退出时停会话、清播放缓冲、停麦克风 |
| 音色切换被拒 | 仅三个音色被服务端接受，列表已按实测收敛并保留自定义入口 |
| 设置面板下方滑不到 | 给设置内容区加独立滚动（`max-height: 46vh`），实测可滚动 |
| 模板注释里的反引号 | `code-export.ts` 的球体页模板是反引号字符串，注释中写反引号必须转义，否则模板提前结束、**产物被静默截断**（曾被 CI 拦截） |

## 八、仍未完成（如实标注）

- **真机观察自愈是否真正成功**：未取得成功现场（观察关键字 `球体恢复重载成功`）。
- **设备为何约每 60 秒周期性丢失的根因**：未定位。
- **自唱（歌声转换 SVC）与自动发送微信**：均无代码路径。

更多内容见 [项目说明书.md](项目说明书.md) 与 [docs/使用说明.md](docs/使用说明.md)。

## 九、许可证

本项目采用 MIT 许可证（`package.json` 中 `license` 字段为 `MIT`）。
