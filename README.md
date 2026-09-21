# Jarvis - Windows 11 桌面智能助理 (Desktop AI Assistant)

> 运行在 Windows 11 桌面上的全能智能副驾：融合 **WebGPU Liquid Glass 悬浮球体交互**、**实时全双工流式语音 (Realtime Voice)**、**MCP 桌面工具链自主执行** 与 **多模态屏幕视觉理解**。

---

## 🌟 这是一个什么项目？

**Jarvis** 是一套专为 Windows 11 设计的原生级桌面智能助理客户端。它不是简单的网页套壳，而是基于 **Electron + WebGPU 硬件着色器加速** 构建的高性能桌面原生应用。

它以一颗优雅、极具未来感的**流体玻璃悬浮球（Liquid Glass Orb）**常驻于桌面右下角，并配备了一扇通透、高质感的**冷银钛渐层晶体玻璃对话面板**。用户可以通过自然语音或文字与 Jarvis 实时交流，让 AI 真正接管并辅助完成电脑操作，实现如同钢铁侠 Jarvis 般的人机协作体验。

---

## 🚀 它能做什么？核心功能特性

### 1. 🔮 WebGPU 硬件加速 Liquid Glass Orb 动态悬浮球
- **物理折射与流体着色器**：基于 WGSL 硬件着色器实时计算 136 项 Uniform 物理流体与玻璃折射高光，彻底告别低劣的 GIF 或 2D 贴图。
- **6 态智能状态机**：
  - `idle`（空闲巡航）：温润缓慢呼吸与流转。
  - `listening`（聆听交互）：波形敏感律动，接收用户声音。
  - `thinking`（思考分析）：高斯激活能量聚敛与思维链流转。
  - `executing`（工具执行）：琥珀金流光脉冲，提示正在操作电脑。
  - `speaking`（AI播报）：随音频能量呈现强烈的波纹与涟漪起伏。
  - `error`（异常警示）：猩红微光闪烁。
- **双向音频波纹响应**：无论是用户说话（麦克风输入）还是 AI 播报（音频下行），内置双路 Analyser FFT 频谱分析器均会实时提取 Low/Mid/High 四频段能量，驱动球体表面撕裂扭曲与轮廓涟漪荡漾。
- **物理穿透与平滑拖拽**：透明背景区域点击自动穿透至桌面底层；鼠标进入球体有效半径内立即捕获事件，支持任意拖拽放置与记忆定位。

### 2. 🎙️ 实时全双工流式语音对话 (Full-Duplex Realtime Voice)
- **原生 WebSocket 双向流式**：采用 24kHz 单声道 PCM16 格式，上行麦克风流式直连，下行音频即时播放，端到端延迟低至几百毫秒。
- **智能打断 (Barge-in)**：只要用户开口，客户端立即就地清空播放缓冲并发送 `response.cancel`，实现无缝自然的即插即打断。
- **Server VAD 自动端点检测**：智能检测说话停顿与起止，免去手动按键的繁琐。
- **多音色切换与自定义**：支持切换磁性男声（`cixingnansheng`）、正派青年（`zhengpaiqingnian`）、温柔女声（`wenrounvsheng`）、甜美女声（`tianmeinvsheng`）等多种模型声音，并支持自定义扩展音色。

### 3. ⚙️ DesktopCommander MCP 桌面工具自主执行
- **12 项生产力工具深度集成**：基于 `@wonderwhy-er/desktop-commander` stdio 协议构建，让 AI 具备直接控制与辅助 Windows 的手脚：
  - **进程与软件管理**：启动软件应用（如计算器、浏览器、VS Code）、终端命令执行、轮询进程输出、强行终止卡死进程。
  - **文件系统管理**：多文件读取、文件写入与覆盖、目录创建与遍历、文件移动与重命名、文件元数据获取。
  - **精准代码生成**：基于 `edit_block` 对项目代码进行精准块级增删改查。
  - **全局搜索**：后台异步全文检索与结果分页。
- **应用级安全闸门与审计留痕**：
  - 严格限制工作目录白名单（默认包含桌面、下载与用户目录）；
  - 针对高危命令（如格式化、删除全盘、杀关键系统进程）实施前置拦截；
  - 敏感操作强制弹出原生悬浮厚玻璃确认窗，必须由人工批准才可放行；
  - 所有工具调用全部以追加模式写入本地 `audit.jsonl` 审计日志，确保操作透明可追溯。

### 4. 👁️ 多模态屏幕视觉理解与扩展 (Vision Understanding)
- **双通道解耦架构**：克服实时语音通道不支持传图的限制，采用独立的 HTTPS 多模态通道完成屏幕理解。
- **活动窗口精准捕获**：使用 Electron 原生 `desktopCapturer` 搭配 Win32 坐标换算，一键截取当前前台活动窗口或全屏幕，带坐标信息送交多模态模型分析。
- **目标定位与模拟操作**：模型理解界面元素后返回物理坐标估算，Jarvis 可辅助完成鼠标单击、双击、文字键入与组合键（如 Alt+F4 关窗）等桌面交互。
- **开放多源视觉扩展**：支持自定义第三方视觉模型（如 GPT-4o、Claude 3.5 Sonnet、Qwen-VL）与自定义兼容端点（OneAPI、Ollama、vLLM 等）。

---

## 🛠️ 有什么用？日常与专业应用场景

1. **桌面生产力全语音控制**：“帮我打开计算器”、“打开浏览器搜索今天的科技新闻”、“帮我看看当前活动窗口里的报错是什么意思并帮我修复”。
2. **免手操作的伴随式代码与文档助手**：在编码或写作时，无需离开当前编辑窗口，通过语音指令让 Jarvis 检索项目文件、修改特定函数或归档目录。
3. **屏幕排障与内容分析**：遇到软件报错弹窗、蓝屏代码或英文技术文档时，呼叫 Jarvis “看屏幕”，它会瞬间分析截屏并在面板上提供诊断建议。
4. **长耗时任务状态监控**：让 Jarvis 在后台启动编译或长命令，并通过 `read_process_output` 随时向你语音汇报最新进展。

---

## 📐 架构设计与技术栈

```
+-----------------------------------------------------------------------------------+
|                              Jarvis Desktop Assistant                             |
+-----------------------------------------+-----------------------------------------+
|                Renderer Process         |               Main Process              |
|  +-----------------------------------+  |  +-----------------------------------+  |
|  |  Liquid Glass Orb (WebGPU WGSL)   |  |  |  Central Orchestrator (中枢编排)   |  |
|  |  - 6-State FSM Control            |  |  |  - State Machine (六态唯一真源)    |  |
|  |  - Dual-direction Audio Waveform  |  |  |  - Barge-in 打断时序控制           |  |
|  |  - Interactive Drag & Pass-through|  |  +-----------------+-----------------+  |
|  +-----------------------------------+  |                    |                    |
|  +-----------------------------------+  |  +-----------------+-----------------+  |
|  |  Crystal Panel UI (冷银渐层晶体玻璃) |  |  | Channel A: Realtime Client        |  |
|  |  - Web Audio Capture (24kHz PCM16)|  |  |  - StepFun Realtime WebSocket    |  |
|  |  - Streaming Downlink Playback    |  |  |  - Server VAD & Function Call    |  |
|  |  - Dual AnalyserNode (FFT 2048)   |  |  +-----------------+-----------------+  |
|  |  - Settings & Tool Confirmation   |  |  | Channel B: Vision Manager         |  |
|  +-----------------------------------+  |  |  - desktopCapturer + Win32 Bounds |  |
|                    ^                    |  |  - OpenAI-compatible Multi-modal  |  |
|                    | IPC (Preload Bridge)|  +-----------------+-----------------+  |
|                    v                    |  | DesktopCommander MCP Client      |  |
|  +-----------------------------------+  |  |  - JSON-RPC 2.0 over stdio        |  |
|  |  Preload ContextBridge            |  |  |  - 12 Production Tools            |  |
|  |  - Absolute Keyless Security      |  |  |  - Safety & Audit Gateways        |  |
|  +-----------------------------------+  |  +-----------------------------------+  |
+-----------------------------------------+-----------------------------------------+
```

- **Runtime**: Electron 34.x / Node.js 22.x / TypeScript 5.7
- **Graphics & Shaders**: WebGPU API, WGSL (WebGPU Shading Language)
- **Audio Processing**: Web Audio API (AudioContext, AnalyserNode, ScriptProcessor)
- **Protocols**: WebSocket (Realtime API), JSON-RPC 2.0 (MCP over stdio), HTTPS (REST Vision)
- **Installer**: NSIS 纯净安装包 (electron-builder)

---

## 🔄 完整能力闭环（实测已验证）

本项目所有链路均已用真实 API Key 端到端实测通过，不是纸面设计：

| 闭环链路 | 实测结论 |
|---|---|
| **语音闭环** | WebSocket 握手 → 文本/语音注入 → 模型决策 → 工具调用 → 结果回注 → 模型语音总结（下行音频 300KB+）全链路打通 |
| **视觉闭环** | 真实截图 → `step-5-preview` 多模态识别 → 准确读出界面全部中文标签与布局 → 文本回注语音会话 |
| **工具闭环** | MCP 子进程拉起 → 26 个工具发现并裁剪为 12 个 → `list_directory`/`write_file` 真实执行成功（写盘后校验内容一致） |
| **全自动闭环** | 默认全自动执行：打开软件、读写文件、执行命令、点屏幕均不再弹窗拦截，所有操作完整写入 `audit.jsonl` |

### 实测踩过并已修复的关键问题

1. **视觉返回 200 但正文为空**：`step-5-preview` 是推理型多模态模型，`max_tokens=1024` 会被思维链吃光导致 `content` 为空串。已提升至 4096，并在正文为空时回退使用 `reasoning` 字段。
2. **工具调用后模型不继续说话**：模型流式产出 `function_call` 时上一轮响应尚未结束，立即 `response.create` 被服务端以 `ongoing response already exists` 拒绝。已实现响应状态跟踪 + 挂起补发机制。
3. **退出后 AI 仍在说话**：关闭面板只是隐藏窗口，会话与播放队列仍在运行。已在关闭/退出时立即停会话、清空播放缓冲、停掉麦克风采集。
4. **音色切换被拒**：实测仅 `cixingnansheng`、`zhengpaiqingnian`、`wenrounvsheng` 三个音色被服务端接受，其余会返回 `voice ... is not valid`。列表已按实测结果收敛，并保留自定义入口。
5. **全自动模式未生效**：旧版 `config.json` 里的 `confirmHighRisk: true` 会覆盖新默认值。已引入配置版本迁移（`configVersion: 2`），启动时自动升级为全自动。

---

## 📦 安装与使用指南

### 方式一：直接安装成品安装包（推荐普通用户）

1. 下载打包完成的 Windows 安装包：`Jarvis-Setup-1.0.0-x64.exe`；
2. 双击运行安装向导，可自定义安装路径并自动创建桌面快捷方式；
3. 启动应用后，桌面右下角将出现悬浮玻璃球，并自动唤起冷银渐层晶体面板；
4. **配置密钥（安装包绝对纯净，不内置任何私密数据）**：
   - 展开面板底部的「**设置与状态**」；
   - 粘贴你的 API Key，选择喜爱的音色，点击「保存」；
5. 点击「**启动语音会话**」，即可开启全双工语音交互。

### 方式二：源码编译与二次开发

```bash
# 1. 克隆代码仓库
git clone https://github.com/1535273240sch-droid/Jarvis-Desktop-Assistant.git
cd Jarvis-Desktop-Assistant

# 2. 安装依赖
npm install

# 3. 编译 TypeScript 与生成着色器资源
npm run build

# 4. 运行自测管线（自动验证 WebGPU、状态机、截图与 MCP 安全门禁）
npm run selftest

# 5. 启动桌面客户端
npm start

# 6. 打包生成独立的 Windows NSIS 安装包
npm run dist
```

---

## 🔒 安全红线与合规承诺

1. **绝对纯净安装包**：源码仓库与打包出的发布包严禁硬编码任何 API Key 或用户隐私数据，统一隔离保存在本地系统的 `%APPDATA%\jarvis-desktop-assistant\config.json` 中。
2. **目录白名单约束**：MCP 工具执行严格限制在白名单目录内，无法随意遍历系统底层敏感区。
3. **高危操作强制人工确认**：执行命令或修改关键配置前必须经用户显式点击「允许执行」方可执行。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源许可。
