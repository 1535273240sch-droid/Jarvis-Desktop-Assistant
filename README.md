# Jarvis - Windows 11 桌面智能助理 (Desktop AI Assistant)

<div align="center">

![Version](https://img.shields.io/badge/Version-v1.4.29-blue?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011%20(64--bit)-0078D4?style=flat-square&logo=windows11)
![Electron](https://img.shields.io/badge/Electron-34.0-47848F?style=flat-square&logo=electron)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript)
![Graphics](https://img.shields.io/badge/Graphics-WebGPU%20%7C%20WGSL-E10098?style=flat-square)
![Protocol](https://img.shields.io/badge/Protocol-WebSocket%20%2B%20MCP%20JSON--RPC-brightgreen?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-purple?style=flat-square)

<p align="center">
  <b>常驻桌面右下角的下一代流体玻璃悬浮球 (Liquid Glass Orb) 与多模态具身操作系统助理</b><br>
  WebGPU 原生流体着色器 · 24kHz 实时全双工流式对讲 · MCP 自动化桌面工具中枢 · Win32 物理坐标屏幕视觉解析
</p>

</div>

---

## 📋 核心运行规范一览

| 维度指标 | 规范标准 |
|---|---|
| **宿主运行时** | **Electron 34** + **TypeScript 5.7**（Node.js 22 LTS） |
| **图形渲染** | **WebGPU API** + **WGSL 硬件级着色器**（支持流体光影折射） |
| **适配平台** | Windows 10 / Windows 11（64 位），显卡驱动支持 WebGPU |
| **网络协议** | 实时全双工 WebSocket（PCM16 音频）/ JSON-RPC 2.0（MCP over stdio）/ HTTPS |
| **安装打包** | NSIS 单文件/一键安装包（由 electron-builder 构建，无内置密钥） |

---

## 🌟 核心系统功能矩阵

| 功能模块 | 技术实现与体验细节 |
|---|---|
| 🔮 **WebGPU 流体玻璃球** | 采用 WGSL 原生编写的高性能流体玻璃球着色器，涵盖 136 项 uniform 实时参数；6 态核心状态机架构（`idle` 待机 / `listening` 拾音 / `thinking` 思维链 / `executing` 工具执行 / `speaking` 发音 / `error` 告警）；具备透明区域点击物理穿透、球体任意拖拽与坐标记忆，支持 80~400px 无级缩放与状态自适应微变形。 |
| 🎙️ **实时全双工语音** | 基于纯原生 WebSocket 双向流式通信，24kHz 单声道无压缩 PCM16，端到端延迟低至几百毫秒；支持**用户开口即打断**（毫秒级清空本地音频播放缓冲并下发 `response.cancel`）；服务端集成智能 Server VAD 自动端点检测断句。 |
| ⚙️ **MCP 桌面工具执行引擎** | 原生内置 17 项桌面自动化基础工具；深度剪裁集成官方 MCP `@wonderwhy-er/desktop-commander`（保留 12 项精选工具）；支持外部生态 Windows-MCP 预设工具一键无缝接入，全流程经由安全决策闸门并在本地写入脱敏审计。 |
| 👁️ **多模态物理屏幕理解** | `desktopCapturer` 结合高精度 Win32 物理坐标自适应换算，支持活动窗口截屏或多屏拼接截取；坐标向量实时喂入多模态大模型，回传物理级准星坐标用于模拟鼠标单击、双击、拖拽、富文本输入与键盘复合快捷键。 |
| 🛰️ **长任务异步编排中枢** | 支持三大类自动化长程任务：全网浏览器深度搜索汇总、调度外部 Coding Agent 代码编写、即时通讯草稿生成（严格遵循仅存草稿、需人工确认核验安全红线）；具备独立任务进度仪表盘与日志分页回溯。 |
| 🎵 **现场 AI 音乐合成与演唱** | 语音触发“唱首歌”指令，即可异步调用音乐生成模型现场作曲编曲并合成带人声高保真音频，生成过程每隔 5 秒语音温和播报进度，异常透明降级处理。 |

---

## 🎨 多主题设计与硬件级容灾机制

- **多套光影主题热重载**：内置经典 **siri** 流体主题，并附带 5 套高质感定制主题 —— `frost`（霜白冷光）、`opal`（蛋白石霓虹）、`blueDrop`（深海透镜）、`refractiveBlob`（高折射紫晶）、`particleRibbon`（流体粒子丝带），构建期预置，面板点选毫秒级热更。
- **三层设备丢失（Device Lost）自愈架构**：
  $$\text{渲染层指数退避重建 (5次)} \longrightarrow \text{主进程无感重载球体页 (60s兜底)} \longrightarrow \text{面板「一键手动重试恢复」按键}$$
- **隔离式 WebGPU 探针**：硬件特性探测全部放在一次性隐藏后台窗口执行，探测完毕即时销毁释放，杜绝与前台正常渲染的 Adapter 产生上下文抢占。

---

## 🏗️ 进程架构与通信拓扑

```
┌────────────────────────────────────────────────────────┐
│               Jarvis Electron 主进程 (Node.js)          │
│  - 六态唯一真源状态机 (State Machine)                   │
│  - 打断时序与音频调度控制器                            │
│  - 动作语义分级安全网关 (ActionPolicy)                 │
└───────────────▲────────────────────────▲───────────────┘
                │ IPC                    │ stdio JSON-RPC 2.0
┌───────────────▼───────────────┐ ┌──────▼───────────────┐
│       渲染进程 (Renderer)     │ │   外部 MCP 服务节点   │
│  - WebGPU 流体玻璃球 (WGSL)   │ │  - 文件系统工具       │
│  - 晶体面板 UI (Glassmorphism)│ │  - 终端命令执行       │
│  - Web Audio 采集与播放缓冲    │ │  - 窗口与系统操作     │
└───────────────────────────────┘ └──────────────────────┘
```

---

## 🚀 快速上手与运行

### 方式一：下载预编译安装包 (推荐普通用户)
1. 前往本仓库 [Releases 页面](../../releases) 获取最新版 `Jarvis-Setup-x64.exe`；
2. 运行安装程序（支持自定义目录，自动生成桌面图标）；
3. 启动应用，在呼出的面板中填入您的 API 密钥并选择默认音色（**安装包纯净安全，不内置任何硬编码 Key**）；
4. 单击「启动语音会话」或按住热键开始自然语音对讲。

### 方式二：从源码进行编译与二次开发
```bash
# 1. 安装核心依赖
npm install

# 2. 编译 WGSL 着色器模板、TypeScript 与静态资源
npm run build

# 3. 运行自动化端到端测试 (包含悬浮球 6 态着色器截图自动化比对)
npm run selftest

# 4. 启动本地桌面客户端
npm start

# 5. 打包生成 Windows NSIS 单文件安装包
npm run dist
```

---

## 🛡️ 安全合规与防御红线

1. **绝对零硬编码**：安装包与仓库严禁内置任何敏感 Token，本地配置安全存放于用户 `%APPDATA%\jarvis-desktop-assistant\config.json`；
2. **硬件操作独立授权**：屏幕录制、键鼠物理模拟默认提示授权，用户一旦主动撤回，全局永久停用并记录在 `authorization-revoked.json`；
3. **关键操作人工干预**：对外发送邮件/消息及任何支付行为强制每次阻断并弹窗等待人工二次确认，自动化模式绝不豁免；
4. **全局一键物理熔断**：任何时刻按下 `Ctrl + Alt + X` 立刻强杀所有正在执行的后台脚本与异步任务；
5. **审计全脱敏**：本地 `audit.jsonl` 自动剔除所有对话正文、短信验证码、登录密码与 API 密钥。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 协议开源。
