# 悬浮球 WebGPU 修复 · 待办事项与完成情况

> 更新日期：2026-09-28
> 提交状态：本轮改动**尚未提交**，提交号待补（上一轮已提交的提交号为 `15a85a0`，在 `main` 分支）
> 发布状态：上一轮发布为 `v1.4.25`；本轮改动的 CI 构建结果请见仓库 Actions 页面（本文档写于推送之前，不预先断言结果）

本文按「已完成 / 已完成但未验证 / 未完成」三类逐项列出，并说明**每一项的验证依据**，
便于后续接手者知道哪些结论是实测的、哪些只是推断。

> 阅读提醒：本轮（2026-09-28）共做了 4 项改动，**除回归测试脚本实际运行过之外，其余全部只是代码层完成，没有真机验证**。
> 决定修复是否成立的核心项（P0）**仍然未完成**，详见第四节。

---

## 一、上一轮已完成（有明确依据，提交 `15a85a0`）

### 1.1 问题定位

| # | 事项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 现象复现 | 球体运行中永久黑屏，窗口还在但内容为空；只能重启应用恢复 | 抓取球体窗口内容为非黑像素 0%；设置面板显示「WebGPU 状态：不可用: 设备已丢失」 |
| 1.2 | 报错定位 | `WebGPU device lost: A valid external Instance reference no longer exists` | `%APPDATA%\jarvis-desktop-assistant\logs\jarvis-orb.log` |
| 1.3 | 主因 1 定位 | 渲染器 `device.lost` 处理为**终态**：置 `failed`、销毁设备、取消渲染循环，无任何重建分支 | 源码 `vendor/orb/src/orb-renderer.ts` 中的 `fail()` |
| 1.4 | 主因 2 定位 | 宿主 `ORB_ON_ERROR` 只记日志/切状态/发通知，**从不触发恢复** | 源码 `src/main/ipc.ts` |
| 1.5 | 佐证 | 宿主侧**已有** `orbController.reloadWithTheme()` 页面重载能力（切主题在用），但故障路径未调用 | `src/main/orb-control.ts` |

### 1.2 代码修复（全部已提交）

| 文件 | 改动内容 | 状态 |
|---|---|---|
| `vendor/orb/src/orb-renderer.ts` | 设备丢失改为**有限次指数退避重建**（5 次，0.5s 起、上限 8s）；每次重建**重新 `requestAdapter`**；恢复后重置计数；重试耗尽才上报宿主；`uncapturederror` 改为只记录 | ✅ 已提交 |
| `vendor/orb/src/code-export.ts` | 同步上述全部改动（**关键**：`src/renderer/orb.html` 由它生成，只改产物会被构建覆盖） | ✅ 已提交 |
| `src/renderer/orb.html` | 同步上述全部改动（构建产物，已与生成器保持一致） | ✅ 已提交 |
| `src/main/ipc.ts` | 新增宿主侧兜底 `scheduleOrbRecovery()`：渲染器放弃后重载球体页面（间隔 10s、最多 6 次），覆盖 GPU 进程重启窗口；就绪后清零 | ✅ 已提交 |
| `scripts/generate-orb.mjs` | **顺带修复历史遗漏**：命中半径随窗口尺寸推导的逻辑（`ORB_RADIUS_RATIO`）此前只在产物里，生成器缺失，下次构建会被静默覆盖回写死的 `110` | ✅ 已提交 |
| `docs/ORB-WEBGPU-RECOVERY.md` | 修复说明文档 | ✅ 已提交 |

### 1.3 构建与发布（上一轮）

| 事项 | 结果 |
|---|---|
| CI 触发 | 推送 `main` 后自动触发 `Build Windows Installer`（run `36379155272`） |
| 构建结果 | ✅ **success**（含 `npm run build`、`verify-tools`、`verify-tasks`） |
| 自动发布 | ✅ `v1.4.25` 已发布，含 `Jarvis-Setup-1.4.25-x64.exe` + `latest.yml` + `.blockmap` |
| 代码层校验 | 三个 JS（生成器产物、orb.html 两个 script 块）均通过 `node --check` |

> 以上 1.1–1.3 是**上一轮**的记录。本轮没有新的构建/发布结果（见第八节）。

---

## 二、本轮已完成（2026-09-28，代码层，未真机验证）

> 本节 4 项**只做了源码改动**，提交号见仓库提交历史。
> 其中**只有第 4 项的回归脚本实际运行过**；前 3 项没有任何真机运行。

| # | 事项 | 实际改动（源码依据） | 验证程度 |
|---|---|---|---|
| 1 | P1 `checkWebGPU()` 自检副作用 | 新建独立探针进程，`checkWebGPU()` 改为委托 | 代码层完成，**未真机验证** |
| 2 | P2 恢复失败可见反馈 + 手动重试入口 | 宿主新增状态位与 IPC，面板新增显示与按钮 | 代码层完成，**未真机验证** |
| 3 | P2 降低生成器模板耦合 | 放大参数抽出为模块常量，注入改正则整段替换 | 代码层完成，**未实跑生成器验证** |
| 4 | P2 自动化回归测试 | 新增静态一致性回归脚本并接入 CI | **已实际运行通过** |

### 2.1 P1 · `checkWebGPU()` 自检副作用 —— 已从球体渲染进程移出

- 新建 `src/main/gpu-probe.ts`（模块级单例 `gpuProbe`）与探针页 `src/renderer/gpu-probe.html`（极简静态页，不加载任何脚本、无 UI）。
- `src/main/orb-control.ts` 的 `checkWebGPU()` 现改为 `return gpuProbe.check();`，**方法签名与返回结构（`{ supported, adapterInfo?, error? }`）保持不变**，调用方无需改动。
- 探测在一个**一次性隐藏窗口**里执行：`show:false`、1×1、`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、`backgroundThrottling:false`，且**不加载 preload**；加载 `app://panel/gpu-probe.html`，用 `executeJavaScript` 注入探测表达式（`requestAdapter` → `requestDevice` → `device.destroy`，字段名与「未知」兜底文案与原实现逐字段等价），拿到结果后**立即 `destroy()`，永不复用**。
- 探针有三项保护：成功结果缓存 60 秒（`CACHE_TTL_MS=60_000`，**仅缓存成功结果**，失败可立即重试）、并发去重（`inflight`，同一时刻只跑一个）、单次整体超时 10 秒（`PROBE_TIMEOUT_MS=10_000`）；`app` 尚未就绪时直接返回失败、不开窗。
- 原来的实现是在**球体自己的渲染进程**里，通过 `evalJs()` 对球体正用于维持活跃设备的同一个 `GPUAdapter` 再 `requestDevice()` 出第二个 device 并立即 `destroy()`。

> ⚠️ 这**消除的只是一个已确认的干扰源**，**不能据此断言它就是「设备每约 60 秒丢失」的根因**。
> 根因至今仍未定位；若周期性断连依旧存在，球体会表现为反复「断开→重建」的一次闪烁。详见第四节 P0。

### 2.2 P2 · 恢复失败时给用户可见反馈 + 手动重试入口 —— 已实现

- `src/main/ipc.ts`：新增状态位 `orbRecoveryExhausted`；自动恢复达到上限（`ORB_RECOVER_MAX=6`）时，除写日志外**首次**向面板发一条可行动的 `systemNotice`，提示点击「设置与状态 → 重试恢复球体」或重启应用（只提示一次，避免刷屏）。
- 新增两个 IPC 通道：`orb:recovery-status` / `orb:retry-recovery`（`src/common/types.ts` 中为 `IPC.ORB_RECOVERY_STATUS` / `IPC.ORB_RETRY_RECOVERY`）。
- `src/preload/index.ts` 暴露 `orbRecoveryStatus()` / `orbRetryRecovery()`。
- `src/renderer/panel.html`：设置区新增「球体恢复状态」显示（`#orbRecoveryStatus`）与「重试恢复球体」按钮（`#btnOrbRecover`）；状态随既有 `loadDiag` 的 6 秒轮询一并刷新。
- 手动重试会清空计数与上限标记、取消待执行定时器，并**立即重载**（不等 10 秒）；定时器路径与手动路径共用同一个重载函数 `performOrbReload()`，避免两份重载逻辑走样。
- 原有「间隔 10 秒、最多 6 次」的定时器行为**未变**；`ORB_ON_READY` 仍会清零计数、上限标记与待执行定时器。

### 2.3 P2 · 降低生成器的模板耦合 —— 已实现

- 新建 `vendor/orb/src/orb-audio-tuning.ts`，导出 `amplifiedAudioRules`（6 个五元组的数组）与 `amplifiedAudioFlowStrengths`（6 个键的对象）。
- `scripts/generate-orb.mjs` 改为从该模块经 Vite SSR 导入（`server.ssrLoadModule("/src/orb-audio-tuning.ts")`），**不再硬编码字面量**。
- 注入方式由原来的「精确字符串匹配」改为**正则整段替换数组/对象字面量**：`/const audioRules = \[\[[\s\S]*?\]\];/`、`/const audioFlowStrengths = \{[^}]*\};/`；仍保留「定位不到就抛错」的兜底，不会静默产出错误产物；上游一改数值也不再导致构建失败。
- **验证程度：代码层完成，未实跑生成器做 diff。** 期望生成结果与改动前字节级一致，这一点是**人工逐字符比对**得出的，**没有实际运行生成器再对比产物**。

### 2.4 P2 · 自动化回归测试 —— 已实现并已实际运行通过

- 新建 `scripts/verify-orb-recovery.mjs`：零依赖纯 Node ESM，**不启动 Electron、不需要 WebGPU**。做的是源码/产物一致性 + 逻辑断言，共 5 组：
  1. 旧缺陷不回归：渲染器保留重建标记（`maxRestartAttempts` / `restartBaseDelayMs` / `restartMaxDelayMs` / `scheduleRestart` / `navigator.gpu.requestAdapter`）、存在 `onReady()`、绑定 `.lost.then`，且不再出现终态 `fail(`；
  2. 退避序列复算：按源码公式与参数复算 5 次延迟 = 500/1000/2000/4000/8000ms，合计 15.5s；
  3. 三层一致性：`scheduleRestart` / `device.lost` / `uncapturederror` / `requestAdapter` 四个关键标记必须同时存在于模块源 `orb-renderer.ts`、模板源 `code-export.ts`、构建产物 `orb.html`（专治「只改产物被构建覆盖」的历史坑），三层也都不得再有终态 `fail(`；
  4. 宿主兜底参数：`ORB_RECOVER_MAX=6`、`ORB_RECOVER_DELAY_MS=10000`，且 `ORB_ON_ERROR` 调到 `scheduleOrbRecovery`、`ORB_ON_READY` 清零计数，6×10000=60000ms 覆盖窗口；
  5. 音频注入参数三方一致：产物里的 `audioRules` / `audioFlowStrengths` 与期望放大值（优先取 `orb-audio-tuning.ts` 常量，回退内联期望值）深比较相等。
- 接入方式：`scripts/run.mjs` 新增 `verify-orb` 任务；`package.json` 新增 `verify:orb`；`.github/workflows/build-windows.yml` 在 `Verify desktop task suite` 之后新增步骤 `Verify orb recovery path`（`node scripts/run.mjs verify-orb`），失败即阻断发布。
- **验证程度：这是本轮唯一实际运行过的改动**——脚本已实际运行通过。
- ⚠️ 说明：本轮**没有**落地文档原先设想的「在渲染器里暴露测试钩子、人为触发一次 device 丢失、断言 `onReady` 被再次调用」——那需要可运行的 WebGPU 环境。本轮落地的是**等价的静态回归**：它验证「源码/产物里的不变量没有漂移」，**不验证运行时能否真正自愈**。

---

## 三、已完成但未验证（重要，请勿当作已解决）

这些改动（含上一轮与本轮）**代码写好了、语法通过**，但**功能效果没有在真实故障下确认**。本节记录属于上一轮的观察；**本轮完全没有真机运行，没有产生新的现场**。

### 3.1 ⚠️ 核心未验证项：修复后球体能否真正自愈

- **现状**：上一轮观察到的是——打了补丁后，设备断开时日志由原来的「永久停止」变成了 `WebGPU 设备已断开，正在重建：...`，**说明新代码确实在运行、重试逻辑确实被触发**。
- **但**：**没有观察到一次成功的恢复**（球体重新渲染出画面）。真实故障（设备每隔约 60 秒丢失一次）在观察时间窗内没有再复现，因此**无法断言修复有效**。
- **结论**：只能说「重试逻辑在跑」，不能说「问题已修复」。

### 3.2 ⚠️ 模拟测试不可作为依据

上一轮曾尝试用「杀掉 GPU 进程」模拟故障，但：
- 该模拟与真实故障机制**不一致**（真实是 `device.lost`，模拟中页面自身状态不同）；
- 模拟中未观察到恢复，但**这个结果不能用来否证修复**，因为触发条件不同。

→ 该模拟的结论已作废，不应写入任何验收记录。

### 3.3 ⚠️ 本机无法跑完整构建

- 本机 PATH 里**没有 node / npm**（`where node` 失败），`vendor/orb` 也缺 `node_modules`；
  写本轮改动时另放了一份免安装的便携版 node（仅用于对内联脚本做语法校验、以及运行不需要依赖的回归脚本），
  它不参与应用构建；
- `winget` 源已损坏（`0x8a15000f`），装不上 Git/Node；
- 因此**未在本地执行过 `npm run build` 全流程**（本轮同样没有）。新增的 `verify:orb` / `verify-orb` 直接读源码与仓库内已有的 `src/renderer/orb.html` 做一致性断言，**不需要先跑构建**；它的实际运行结论见第二节 2.4。

### 3.4 ⚠️ 本地已安装的 app 未升级

- 本机安装的仍是 **v1.4.24（带 bug 的版本）**；
- 调试期间对本地 `app.asar` 打过的测试补丁，**已还原为原始版本**；
- 未安装 v1.4.25（按用户要求停止下载安装）。

---

## 四、未完成 / 待办

### P0 — 必须做（决定修复是否成立）

- [ ] **真机观察自愈是否成功**（**仍然未完成**）
      - 场景：球体再次断连时，记录是否在约 60 秒内自动恢复出画面。
      - 日志关键字：
        - `球体渲染器报错：WebGPU 设备已断开，正在重建`（渲染器层重试开始）
        - `将在 10000ms 后重载球体页面`（宿主层兜底开始）
        - `球体恢复重载成功`（✅ 成功标志）
        - `球体恢复已达上限（6 次），停止自动重载`（❌ 失败标志）
      - **这是本次修复唯一的验收标准，目前仍未取得。**
      - **本轮完全没有真机运行**：没有安装包、没有可运行的 Electron/WebGPU 环境，所以无法观察一次真实设备丢失后的恢复画面，也**取不到**成功关键字 `球体恢复重载成功`。

- [ ] **排查「为什么设备会周期性丢失」这一根因**（**仍然未完成**）
      - 观察到 `device lost` 的时间点**异常规律**（多次都出现在启动后约 60 秒），不符合随机崩溃的特征——**这一点至今没有解释**。
      - 本轮移除的是 P1 怀疑的自检副作用（属于「消除一个可疑干扰源」），**并没有定位根因**。
      - 若根因不除，本修复只是一层保险，球体会反复「断开→重建」，观感上会周期性闪烁/黑屏一次。
      - 待查方向见 P1。

### P1 — 建议排查（可能有更深层原因）

- [x] **检查 `orbController.checkWebGPU()` 自检的副作用 —— 已从球体渲染进程移出**（见第二节 2.1）
      - 旧实现会 `requestAdapter()` → `requestDevice()` → **`device.destroy()`**，且运行在**球体自己的渲染进程**里；现已改到一次性隐藏探针窗口执行。
      - ⚠️ 注意：这只**消除了一个已确认的干扰源**，**不等于证明它就是 60 秒周期断连的根因**；根因排查仍需按 P0 继续。

- [ ] **排查显卡驱动 / Electron 版本的兼容性**
      - 本机：RTX 5060（Blackwell），驱动 `32.0.16.1052`（日期 2026-06-04），Electron 34。
      - 怀疑点：Dawn/WebGPU 在新架构 + 该驱动下的稳定性；日志中适配器信息为 `"architecture":"未知","device":"未知"`，识别不完整，本身就是一个可疑信号。
      - 可做：更新到最新 NVIDIA 驱动后长时间观察是否仍周期性断连。

- [ ] **排查是否有外部组件在 60 秒周期上触碰 GPU**
      - 已知定时器：面板 `loadConfig` 8s、`loadDiag` 6s、`refreshTasks` 15s（均不碰 WebGPU）；主进程 `realtime.statusTimer`（WebSocket 状态）。
      - 尚未找到确切的 60 秒触发源，需要重新抓一次带 GPU 日志的完整现场。

### P2 — 改进项（非阻塞）

- [x] **恢复失败时给用户可见反馈 + 手动重试入口 —— 已实现**（见第二节 2.2）
      - 代码层完成，**未真机验证**（没实际点到上限、也没实际点过按钮）。

- [x] **降低生成器的模板耦合 —— 已实现**（见第二节 2.3）
      - 代码层完成，**未实跑生成器验证**（字节级一致是人工比对得出的）。

- [x] **补一个自动化回归测试 —— 已实现并已实际运行通过**（见第二节 2.4）
      - 已接入 `verify:orb` / `verify-orb` 与 CI。注意它是**静态一致性回归**，不是运行时恢复测试。

- [ ] **退避参数未经真机调优**（**仍然未完成**）
      - 渲染器：5 次 / 上限 8s（合计约 15.5s）
      - 宿主：6 次 / 间隔 10s（合计约 60s）
      - 数值**未变**，仍是**基于推断**设定（为覆盖 GPU 进程重启耗时），确认真实恢复耗时后可收敛。

---

## 五、验证到什么程度（三类明确区分）

| 类别 | 内容 | 说明 |
|---|---|---|
| **已实测 / 已运行通过** | `scripts/verify-orb-recovery.mjs` 静态回归脚本（本轮实际运行通过） | 本轮唯一实测项。它验证的是源码/产物不变量，**不覆盖运行时恢复**。上一轮另有三个 JS 通过 `node --check` 语法校验 |
| **代码层完成但未真机验证** | `checkWebGPU` 探针改造（2.1）、面板反馈与手动重试（2.2）、生成器解耦（2.3） | 只改了源码；本机没有安装包与可运行的 Electron/WebGPU 环境，未做任何运行时验证 |
| **完全未做** | 真机自愈观察；60 秒周期断连根因定位；退避参数真机调优；CI 构建 | 见第四节 |

- **CI 构建结果：本文档不预先断言。** 新增的 `Verify orb recovery path` 步骤（连同既有的 `verify-tools` / `verify-tasks`）会在推送后由 `Build Windows Installer` 工作流执行；构建是否通过请以 Actions 页面与 Release 页面的实际结果为准，不要以本文档的表述为准。

---

## 六、如何验证修复（给后续接手者）

1. 安装 / 运行**含本轮改动的新版本**（该版本尚未发布、提交号与版本号待补；上一轮发布为 v1.4.25）。
2. 查看日志：`%APPDATA%\jarvis-desktop-assistant\logs\jarvis-orb.log`
3. 若出现球体黑屏，检查日志中是否出现：
   - `WebGPU 设备已断开，正在重建` → 渲染器层已介入
   - `球体恢复重载成功` → **修复生效**
   - `球体恢复已达上限` → 修复未生效，需回到 P1 排查根因
4. 新增了面板入口：若设置面板「球体恢复状态」显示「已达上限（6 次），需要手动重试」，可点「重试恢复球体」**立即重载**（不等 10 秒）。
5. 对比基线：v1.4.24 及更早版本在断连后**只出现** `WebGPU device lost: ...` 且**再无后续**（这就是本次要修的行为）。

---

## 七、本轮变更清单（文件级）

**新建：**

```
src/main/gpu-probe.ts               WebGPU 自检独立探针（一次性隐藏窗口 + 缓存/去重/超时）
src/renderer/gpu-probe.html         探针页（极简静态宿主，无脚本、无 UI）
vendor/orb/src/orb-audio-tuning.ts  音频放大量常量（构建期参数，供生成器导入）
scripts/verify-orb-recovery.mjs     球体恢复链路静态回归脚本（零依赖纯 Node ESM）
```

**修改：**

```
src/main/orb-control.ts             checkWebGPU() 改为委托 gpuProbe.check()（签名/返回不变）
src/main/ipc.ts                     恢复上限状态位 + 上限时面板提示 + orb:recovery-status /
                                    orb:retry-recovery 两个 IPC + 共用重载函数 performOrbReload()
src/common/types.ts                 IPC.ORB_RECOVERY_STATUS / IPC.ORB_RETRY_RECOVERY
src/preload/index.ts                暴露 orbRecoveryStatus() / orbRetryRecovery()
src/renderer/panel.html             新增「球体恢复状态」显示 + 「重试恢复球体」按钮 + 6s 轮询刷新
scripts/generate-orb.mjs            改从 orb-audio-tuning.ts 导入 + 正则整段替换注入（不再精确匹配）
scripts/run.mjs                     新增 verify-orb 任务
package.json                        新增 verify:orb 脚本
.github/workflows/build-windows.yml 在 Verify desktop task suite 之后新增 Verify orb recovery path
```

---

## 八、附：文件与提交清单

```
上一轮提交 15a85a0（main）
  docs/ORB-WEBGPU-RECOVERY.md      +136  修复说明
  docs/TODO-ORB-WEBGPU.md          （本文档）
  scripts/generate-orb.mjs          +14  -1   补回命中半径随尺寸推导
  src/main/ipc.ts                   +41       宿主侧兜底恢复
  src/renderer/orb.html             +89  -10  构建产物同步
  vendor/orb/src/code-export.ts     +89  -10  生成器同步（关键）
  vendor/orb/src/orb-renderer.ts   +318 -225  渲染器重建逻辑

上一轮发布 v1.4.25（CI 自动构建）
  Jarvis-Setup-1.4.25-x64.exe
  latest.yml / *.blockmap

本轮改动：提交号见仓库提交历史；CI 构建结果见 Actions 页面（本文档不预先断言）
  新建 src/main/gpu-probe.ts                  WebGPU 自检独立探针
  新建 src/renderer/gpu-probe.html            探针页
  新建 vendor/orb/src/orb-audio-tuning.ts     音频放大量常量
  新建 scripts/verify-orb-recovery.mjs        静态回归脚本
  修改 见第七节
```

### 修改时必须注意的依赖关系

```
vendor/orb/src/orb-renderer.ts   ┐
                                 ├─► 渲染逻辑的「源头」
vendor/orb/src/code-export.ts    ┘
        │
        │ scripts/generate-orb.mjs（构建时执行）
        ▼
src/renderer/orb.html            是【生成产物】，不要只改它
```

> **只改 `src/renderer/orb.html` 会在下次 `npm run build` 时被覆盖。**
> 修改渲染逻辑必须同时改 `code-export.ts`（模板）或 `orb-renderer.ts`（模块）。
> 音频放大参数现集中在 `vendor/orb/src/orb-audio-tuning.ts`，由生成器经正则整段注入。
