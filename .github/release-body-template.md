# 🚀 Jarvis v__VERSION__

> **Windows 11 桌面 AI 助理** — WebGPU 流体悬浮球 · 实时全双工语音 · MCP 桌面工具自主执行 · 多模态屏幕视觉

---

## ✨ 核心功能

| 功能 | 说明 |
| --- | --- |
| 🔮 **流体玻璃悬浮球** | WebGPU（WGSL）· 6 态状态机 · 音频 FFT 响应 · 尺寸 80~400 px 可调 |
| 🛡 **悬浮球稳定性** | 设备丢失三层自愈：渲染器退避 → 宿主重载 → 面板提示与手动重试 |
| 🎨 **多主题** | 内置 siri + 5 套导入主题（frost / opal / blueDrop / refractiveBlob / particleRibbon） |
| 🎙️ **实时语音对话** | 全双工流式 · 24kHz PCM16 · 智能打断 · 多音色 |
| 🎵 **AI 唱歌** | 文本生成带人声歌曲；接口地址 / 模型 ID / 专属 Key 可配 |
| ⚙️ **工具自主执行** | 内置 21 项 + MCP 12 项 · 按名称可靠启动软件 · 安全闸门 + 审计日志 |
| 🧩 **外部 MCP 扩展** | 可接入任意 MCP 服务器；含 Windows-MCP 预设，工具加前缀隔离 |
| 🖥 **桌面任务** | 浏览器调研 / 编码 Agent 指挥 / 微信草稿（仅草稿 + 人工发送） |
| 👁️ **屏幕视觉** | 截屏识别 · 坐标估算 · 鼠标键盘操作；屏幕录制默认开启 |
| 📰 **信息简报** | 一句话取数整理并**播报给你听**，面板留带链接完整版，「打开第二个」直接跳转 |
| ⏱ **长任务不中断** | 执行看门狗可配（默认 10 分钟）+ 心跳续期 + 执行中不误打断 |

---

## 📥 下载安装

- 安装包：`Jarvis-Setup-__VERSION__-x64.exe`
- 系统要求：**Windows 11 x64**（需支持 WebGPU 的显卡驱动）
- 提示：安装包未签名，SmartScreen 若提示「未知发布者」，点「更多信息 → 仍要运行」即可

---

## 🔄 关于自动更新（重要）

本版本的**自动更新默认关闭**。

原因：仓库 CI 会按构建流水号递增补丁版本号；一旦自动更新，会用上游构建覆盖你本地的源码改动，
且更新过程会清空安装目录，表现为「装好的应用突然打不开」。

需要自动更新时，在设置面板显式打开 `autoUpdate`，或手动下载新安装包覆盖安装。

---

## 🆕 更新日志

### v1.5.37 — 非安全项优化修复 + 代码质量提升

本次是**非安全项优化修复 + 代码质量提升**版本：修复可靠性、正确性与资源管理上的既有缺陷，
并清理死代码、收严 CI/打包。**安全设计（授权模型、默认配置姿态、确认门等）按作者意图保持不变，不在本次变更范围内。**

#### 🛠 可靠性

- **工具执行看门狗不再永久挂起**：心跳从「只要在执行就无条件续期」改为「**有实际进展才续期** + 最多续期 **20 次**的硬上限」。彻底卡死的工具最终会被状态机正常超时回收，不再无限续命。
- **渲染进程异常退出自动恢复**：接入 `render-process-gone`。悬浮球复用既有恢复链路（上限 6 次）；面板做有限次自动重载（上限 3 次）。
- **GPU 兼容开关可配置**：`enable-unsafe-webgpu` / `ignore-gpu-blocklist` / `enable-gpu-rasterization` 改为受新增配置项 `gpuCompatFlags`（默认 `true`）控制。在黑名单驱动上反复崩溃时，可在 `config.json` 关闭；崩溃时面板会给出提示。
- **急停热键注册失败不再静默**：全局急停热键注册失败时，面板可见告警，并说明替代的中断入口。
- **实时语音重连逻辑清理**：移除恒真条件与死变量；重连上限与退避行为**保持不变**。

#### 🎯 正确性

- **程序启动匹配收紧**：只有匹配度 ≥80 才直接启动，40–79 分交回澄清确认；系统目录下的通用工具降权，避免「同名即匹配」启动错误程序。
- **开始菜单注册表解析修正**：无引号形态的 command 不再把整行当作可执行文件路径。
- **文字输入不再破坏剪贴板**：注入前保存、注入后恢复，并加串行队列避免并发任务交叉污染。
- **MCP 预设必填项校验**：必填项缺失时拒绝并给出明确提示，不再把 `REPLACE_WITH_*` 占位符原样传给 npx。
- **IPC 入参校验**：拖拽坐标、音频分片、球体错误消息统一做形状 / 数值 / 长度校验。
- **orb 着色器**：消除对可能为负的 `sin()` 取 `pow(..., 2.0)` 的未定义行为。
- **渲染层**：`img.src` 增加 `data:image/png;base64,` 前缀白名单；任务列表的属性插值统一转义。

#### 🧹 资源与代码质量

- **日志**：限流表加上限（500 条）与 LRU 淘汰、限流 key 归一化；`errors.jsonl` 纳入按大小轮转与留存清理；诊断读取加缓存，避免面板轮询阻塞主进程。
- **配置下发改为「默认拒绝」式脱敏**：新增敏感字段不会再默认泄露。
- **任务产物**：新增保留期清理，删除任务时连带清理。
- **`app://` 协议目录穿越检查**：由前缀匹配改为 `path.relative` 判定。
- **MCP 目录白名单下发失败时失败关闭**：不再让工具在无白名单约束下暴露。
- **授权状态返回的 `scope` 语义统一**为「当前生效能力」。
- **删除全部死代码**：未使用的导入 / 变量 / 参数 / 导出函数；`tsc --noUnusedLocals --noUnusedParameters` 零告警。
- **自测脚本诚实性**：移除恒真断言、修正复刻生产算法的假覆盖、CI 下不再把逻辑断言静默降级为 SKIP；`verify-app-e2e` 去掉硬编码本机路径并接入运行器；`verify-mcp` 补临时目录清理；`probe-*` 标注为非 CI 检查。

#### 📦 CI 与打包

- 新增 `pull_request` 触发（PR 下跳过发布与签名）。
- GitHub Actions 固定到 commit SHA、权限最小化、artifact 设置保留期。
- `asarUnpack` 由全量 `node_modules` 收窄为仅原生模块，显著减小体积。

---

## 🔧 兼容性

- **无破坏性变更**：旧配置无需改动即可升级。
- 新增配置项 `gpuCompatFlags`（默认 `true`，保持与旧版一致的 GPU 兼容开关姿态）；仅在被 GPU 驱动黑名单反复崩溃时才需要显式关闭。
- 配置文件、目录结构与 IPC 接口保持兼容。

---

## ✅ 验证方式

```bash
npm ci                       # 安装依赖
npm run build                # 生成球体页 → tsc → 拷资源 → 校验产物
npm run verify:orb           # 悬浮球恢复链路静态回归
npm run verify:briefing      # 信息简报回归（离线）
npm run verify:execution     # 长任务执行中断专项回归
node scripts/run.mjs verify-tools    # 工具执行闭环
node scripts/run.mjs verify-tasks    # 动作语义 / 脱敏 / 注入防护 / 任务持久化
node scripts/run.mjs typecheck       # 类型检查，期望 0 错误
```

- CI（`.github/workflows/build-windows.yml`）在 `push main` / `pull_request` 上依次执行 `verify-tools` → `verify-tasks` → `verify-orb` → `verify-briefing` → `verify-execution`，任一失败即阻断发布。

> **安全模型未变更声明**：本次不涉及授权模型、默认配置姿态与确认门等安全设计的变更；对外发送 / 账号支付仍逐次独立确认，桌面三类能力默认开启、用户撤回不自动恢复等既有行为保持不变。

---

## 🛠 从源码构建

```bash
npm ci
cd vendor/orb && pnpm install && cd ../..   # 悬浮球页面的独立依赖（必需）
npm run build          # 生成悬浮球页面 + 编译 TS + 校验产物
npm run selftest       # 应用自测（含截图取证，供人工核验）
node scripts/run.mjs verify-orb         # 悬浮球回归
node scripts/run.mjs verify-briefing    # 简报回归（-- --live 追加联网检查）
node scripts/run.mjs verify-execution   # 长任务执行回归
node scripts/run.mjs verify-tools
node scripts/run.mjs verify-tasks
npm start              # 启动
npm run dist           # 打包 NSIS 安装包
```

> 若本机 Node 不在 PATH，可用仓库内的免 PATH 运行器 `node scripts/run.mjs <子命令>`
> （如 `node scripts/run.mjs build | start | selftest | dist`）。
