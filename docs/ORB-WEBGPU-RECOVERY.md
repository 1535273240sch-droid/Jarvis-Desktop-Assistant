# 悬浮球 WebGPU 断连修复说明与待办

> 更新日期：2026-09-28
> 提交状态：本轮改动**尚未提交**，提交号待补（上一轮已提交的提交号为 `15a85a0`，在 `main` 分支）
> 发布状态：上一轮发布为 `v1.4.25`；本轮改动的 CI 构建结果请见仓库 Actions 页面（本文档写于推送之前，不预先断言结果）

本文档记录**已修复的内容**、**验证到了什么程度**，以及**尚未完成/需要在真机上继续确认的事项**。

---

## 一、问题现象

悬浮球在运行一段时间后**永久黑屏**（窗口还在，但完全透明/空白），
只有**重启整个应用**才能恢复。日志中反复出现：

```
[ERROR] [IPC] 球体渲染器报错：WebGPU device lost: A valid external Instance reference no longer exists.
[INFO]  [FSM] idle -> error  (渲染错误：WebGPU device lost: ...)
```

设置面板的「WebGPU 状态」显示为 `不可用: 设备已丢失`。

## 二、根因

发现两个独立缺陷，叠加导致「一旦断连就永久黑屏」：

### 缺陷 1：渲染器没有重建路径（主因）

`vendor/orb/src/orb-renderer.ts` 中，设备丢失的处理是**终态**的：

```ts
// 修复前
device.lost.then((info) => {
  fail(new Error(`WebGPU 设备已断开：${info.message || info.reason}`));
});
```

`fail()` 会把 `failed` 永久置位、销毁设备并取消渲染循环，
**没有任何重新申请设备的分支**。所以设备一旦丢失，球体这一页就永久失效。

此外，`start()` 中 `const adapter = await navigator.gpu.requestAdapter()` 是**局部变量**，
函数返回后没有引用持有它。Dawn 的 instance 可能因此被 GC 回收——
报错信息 `A valid external Instance reference no longer exists` 正是这一情形的典型表现。

### 缺陷 2：宿主不触发恢复（兜底缺失）

`src/main/ipc.ts` 的 `ORB_ON_ERROR` 处理器只做了三件事：
记日志、把状态机切到 `error`、给面板发一条系统通知。**从不尝试恢复**。

而宿主侧其实**已经有** `orbController.reloadWithTheme()` 这个重载球体页面的能力
（切换主题时就在用它），只是没有在故障路径上调用。

## 三、已做的修复

### 3.1 第一轮修复（已提交，提交 `15a85a0`）

| 文件 | 改动 |
|---|---|
| `vendor/orb/src/orb-renderer.ts` | 设备丢失/渲染异常改为**有限次指数退避重建**（5 次，0.5s 起、上限 8s）；每次重建**重新 `requestAdapter`**，避免复用失效引用；渲染恢复正常后重置退避计数；重试耗尽才上报宿主。`uncapturederror` 改为只记录、不上报。 |
| `vendor/orb/src/code-export.ts` | 同步上述全部改动。**这一步是必须的**：`src/renderer/orb.html` 由该文件生成，只改产物会被下次构建覆盖。 |
| `src/renderer/orb.html` | 同步上述全部改动（该文件是构建产物，已与生成器保持一致）。 |
| `src/main/ipc.ts` | 新增宿主侧兜底 `scheduleOrbRecovery()`：渲染器自身重试失败后，宿主重载球体页面（间隔 10s、最多 6 次）。就绪后清零计数。 |
| `scripts/generate-orb.mjs` | **顺带修复一处历史遗漏**：球体命中半径按窗口尺寸推导的逻辑（`ORB_RADIUS_RATIO` / `updateOrbRadius`）此前只存在于生成产物 `orb.html` 中，未回填生成器，下次构建会被静默覆盖回写死的 `110`。 |

#### 设计上的分层

- **渲染器层**：只做约 15 秒的快速重试，覆盖瞬时抖动。
- **宿主层**：渲染器放弃后重载整个球体页面。GPU 进程被驱动复位/系统回收后，
  Chromium 重启它需要时间（本机实测约 60 秒），期间页面内怎么重建都拿不到 adapter，
  必须重载页面。宿主间隔 10s、最多 6 次，覆盖约 60 秒窗口。

### 3.2 本轮追加修复（2026-09-28，尚未提交，均**未真机验证**）

> 本节 4 项只有源码改动，提交号待补。**只有第 4 项的回归脚本实际运行过**，前 3 项没有任何真机运行。

**（1）P1 · `checkWebGPU()` 自检不再运行在球体自己的渲染进程**

- 新建 `src/main/gpu-probe.ts`（单例 `gpuProbe`）与探针页 `src/renderer/gpu-probe.html`（极简静态页，无脚本、无 UI）。
- `src/main/orb-control.ts` 的 `checkWebGPU()` 改为委托 `gpuProbe.check()`，**签名与返回结构保持不变**。
- 探测改在**一次性隐藏窗口**（`show:false`、1×1、`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、无 preload）里加载 `app://panel/gpu-probe.html` 执行，拿到结果**立即销毁、永不复用**；带成功结果 60 秒缓存、并发去重、10 秒整体超时。
- 旧实现是在球体渲染进程里对同一 `GPUAdapter` 再 `requestDevice()` 并立即 `destroy()`。

> ⚠️ 这**消除了一个已确认的干扰源**，但**不能断言它就是「设备每约 60 秒丢失」的根因**。根因至今仍未定位。

**（2）P2 · 恢复失败时给用户可见反馈 + 手动重试入口**

- `src/main/ipc.ts` 新增状态位 `orbRecoveryExhausted`；达到上限（6 次）时除日志外**首次**向面板发一条可行动的 `systemNotice`。
- 新增两个 IPC 通道 `orb:recovery-status` / `orb:retry-recovery`（`src/common/types.ts` 中为 `IPC.ORB_RECOVERY_STATUS` / `IPC.ORB_RETRY_RECOVERY`），`src/preload/index.ts` 暴露 `orbRecoveryStatus()` / `orbRetryRecovery()`。
- `src/renderer/panel.html` 设置区新增「球体恢复状态」显示与「重试恢复球体」按钮；手动重试清空计数并**立即重载**（不等 10 秒）。定时器路径与手动路径共用同一个重载函数 `performOrbReload()`。
- 原有「间隔 10 秒、最多 6 次」行为未变。

**（3）P2 · 降低生成器的模板耦合**

- 新建 `vendor/orb/src/orb-audio-tuning.ts`，导出 `amplifiedAudioRules` 与 `amplifiedAudioFlowStrengths`。
- `scripts/generate-orb.mjs` 改为经 Vite SSR 导入该模块，并用**正则整段替换数组/对象字面量**（`/const audioRules = \[\[[\s\S]*?\]\];/`、`/const audioFlowStrengths = \{[^}]*\};/`）替代原来的精确字符串匹配；仍保留「定位不到就抛错」的兜底。
- **未实跑生成器做 diff**：期望产物与改动前字节级一致，是**人工逐字符比对**得出的结论。

**（4）P2 · 自动化回归测试（本轮唯一已实测项）**

- 新建 `scripts/verify-orb-recovery.mjs`：零依赖纯 Node ESM，不启动 Electron、不需要 WebGPU，做源码/产物一致性 + 逻辑断言（旧缺陷不回归、退避序列复算、三层标记一致、宿主兜底参数、音频参数三方一致）。
- 接入 `scripts/run.mjs` 的 `verify-orb` 任务、`package.json` 的 `verify:orb`，以及 CI 工作流中 `Verify desktop task suite` 之后的 `Verify orb recovery path` 步骤（失败即阻断发布）。
- ⚠️ 它**不是**运行时恢复测试：文档原先设想的「渲染器测试钩子人为触发 device 丢失、断言 `onReady` 再次调用」**没有落地**（需要可运行的 WebGPU 环境），本轮落地的是等价的静态回归。

## 四、验证到什么程度

**已实测 / 已运行通过：**

- `scripts/verify-orb-recovery.mjs` 静态回归脚本（本轮实际运行通过）。它验证源码/产物不变量，**不覆盖运行时恢复**。
- 第一轮另有三个 JS 通过 `node --check` 语法校验（含生成器重新生成的产物）。

**代码层完成但未真机验证：**

- `checkWebGPU` 探针改造、面板反馈与手动重试、生成器解耦（见第三节 3.2 的 1–3 项）。只改了源码，本机没有安装包与可运行的 Electron/WebGPU 环境。
- 上一轮在已安装的 v1.4.24 上曾确认修复代码生效（设备断开时日志由「永久停止」变为 `WebGPU 设备已断开，正在重建：...`，并确实按退避策略重试），但这只说明「重试逻辑在跑」，**不是**自愈成功的证据。

**⚠️ 未完成 / 完全未做（重要）：**

- **「能否最终自愈」没有在真实故障场景下确认。** 真实故障（设备每约 60 秒丢失一次）在观察时间窗内没有再复现，因此**无法断言**修复后一定能恢复出球体画面。**本轮完全没有真机运行**，也取不到成功关键字 `球体恢复重载成功`。
- **60 秒周期断连的根因仍未定位。** 本轮只是移除了一个可疑干扰源（自检副作用），不等于解决根因。
- **模拟测试不作为依据。** 曾用「杀掉 GPU 进程」复现，但机制与真实故障不一致，结果不能用来证明或否证修复效果。
- **退避参数未真机调优**（数值未变，仍是推断值）。
- **CI 构建结果不做预先断言**：新增的 `Verify orb recovery path` 步骤（连同既有的 `verify-tools` / `verify-tasks`）由 `Build Windows Installer` 工作流在推送后执行；是否通过请以 Actions 页面与 Release 页面的实际结果为准。
- `vendor/orb` 无法在本机重新构建（缺 `node_modules`，PATH 里也没有 node/npm、winget 源已损坏），所以没有跑过官方的 `npm run build` 全流程。写本轮改动时另放了一份免安装的便携版 node，仅用于对内联脚本做语法校验与运行不需要依赖的回归脚本，不参与应用构建。

## 五、待办事项

### P0 — 必须确认

- [ ] **在真机上持续观察**：球体再次断连时，是否能在约 60 秒内自动恢复出画面。
      这是本次修复的核心验收点，目前**尚未确认**（本轮完全没有真机运行）。
      观察日志关键字：`WebGPU 设备已断开，正在重建` / `球体恢复重载成功`。
- [ ] **排查 GPU 进程为何每约 60 秒被回收/重启（根因未定位）。**
      观察到 `device lost` 的时间点异常规律（多次都在启动后约 60 秒），这不像随机崩溃。
      本轮移除了 P1 怀疑的自检副作用，但**没有定位根因**；若周期性断连仍在，
      球体会表现为反复「断开→重建」的一次闪烁。可能方向：
  - 显卡驱动（本机 RTX 5060 + 驱动 `32.0.16.1052`）对 WebGPU/Dawn 的支持问题；
  - Electron 34 的 GPU 进程在该驱动下的稳定性；
  - 是否有其他组件在 60 秒周期上触碰 GPU（面板定时器 8s/6s/15s 均不碰 WebGPU，尚未找到触发源）。
- [ ] **跑通 CI 构建**：确认 `npm run build`、`verify-tools`、`verify-tasks`、
      `verify-orb` 全部通过（本机环境无法验证）。**当前状态：以 Actions 页面为准（本文档不预先断言）。**

### P1 — 建议排查（可能导致断连的更深层原因）

- [x] **`checkWebGPU()` 自检（`requestDevice` + `device.destroy`）已从球体渲染进程移出。**
      旧实现运行在与球体同一渲染进程中，会在活跃 adapter 上再开一个 device 并立即销毁；
      现已改到一次性隐藏探针窗口执行（见第三节 3.2 第 1 项）。
      ⚠️ 这只是**消除一个已确认的干扰源**，**不等于定位了 60 秒周期断连的根因**。
- [ ] 确认移除自检副作用后，周期性断连是否仍复现（需真机长时间观察，尚未做）。

### P2 — 改进项

- [x] 球体恢复失败达到上限后，已提供**可见提示 + 手动重试入口**（见第三节 3.2 第 2 项）。
      代码层完成，**未真机验证**。
- [x] `scripts/generate-orb.mjs` 的音频放大值注入已改为**从 `vendor/orb` 导入常量 + 正则整段替换**
      （见第三节 3.2 第 3 项）。代码层完成，**未实跑生成器验证**。
- [x] 已新增恢复链路**静态回归测试**（`scripts/verify-orb-recovery.mjs`，接入 CI），
      并**已实际运行通过**（见第三节 3.2 第 4 项）。它是静态一致性回归，不是运行时恢复测试。
- [ ] 渲染器的退避参数（当前 5 次 / 上限 8s）与宿主参数（6 次 / 间隔 10s）
      仍是**基于推断**设定，未经过真机调优；确认真实恢复耗时后可再收敛。

---

## 六、附：本次改动涉及的文件

```
—— 第一轮（已提交 15a85a0）——
vendor/orb/src/orb-renderer.ts   渲染器：设备丢失后重建
vendor/orb/src/code-export.ts    生成器：同步修复（关键，防被覆盖）
scripts/generate-orb.mjs         生成器：补回命中半径随窗口尺寸推导
src/main/ipc.ts                  宿主：故障后重载球体页面兜底
src/renderer/orb.html            构建产物：同步以上改动

—— 本轮（尚未提交，提交号待补）——
新建：
src/main/gpu-probe.ts            WebGPU 自检独立探针（一次性隐藏窗口）
src/renderer/gpu-probe.html      探针页
vendor/orb/src/orb-audio-tuning.ts  音频放大量常量（构建期参数）
scripts/verify-orb-recovery.mjs     恢复链路静态回归脚本
修改：
src/main/orb-control.ts          checkWebGPU() 委托 gpuProbe.check()（签名/返回不变）
src/main/ipc.ts                  恢复上限状态 + 面板提示 + 两个 IPC + 共用重载函数
src/common/types.ts              IPC.ORB_RECOVERY_STATUS / IPC.ORB_RETRY_RECOVERY
src/preload/index.ts             orbRecoveryStatus() / orbRetryRecovery()
src/renderer/panel.html          恢复状态显示 + 手动重试按钮 + 6s 轮询刷新
scripts/generate-orb.mjs         改从 orb-audio-tuning.ts 导入 + 正则整段替换
scripts/run.mjs                  新增 verify-orb 任务
package.json                     新增 verify:orb 脚本
.github/workflows/build-windows.yml  新增 Verify orb recovery path 步骤
```

> 说明：`src/renderer/orb.html` 是**生成产物**。修改渲染逻辑时，
> 必须同时改 `vendor/orb/src/code-export.ts`（或 `orb-renderer.ts`），
> 否则下次 `npm run build` 会覆盖掉对产物的直接修改。
> 音频放大参数现集中在 `vendor/orb/src/orb-audio-tuning.ts`，由生成器经正则整段注入。
