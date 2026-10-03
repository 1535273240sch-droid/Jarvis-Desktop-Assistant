# 悬浮球 WebGPU 稳定性

悬浮球是 WebGPU（WGSL）流体玻璃球。本文汇总它在 v1.5.x（补丁号由 CI 构建流水号生成；当前发布版本见仓库 Releases）下的状态、多主题与音频动态、设备丢失自愈、WebGPU 自检隔离、构建三层同步与回归测试。

> 本文合并自 `docs/TODO-ORB-WEBGPU.md`、`docs/ORB-WEBGPU-RECOVERY.md`、`docs/ORB_CHANGES.md` 三份旧文档；**那三份已删除**，旧链接请一律改指本文。

## 一、状态与渲染

- 六态：`idle / listening / thinking / executing / speaking / error`。Orb 原生仅 `idle`、`thinking` 两态，已在 `vendor/orb/src/orb-states.ts` 扩展为六态；导出页 `setState()` 有白名单校验，未登记状态会抛 `TypeError`，宿主无法绕过。
- 导出页 `vendor/orb/src/code-export.ts` 做三处宿主适配：`createStateSeeds` 改为遍历生成六态种子；背景改透明（否则球体带方形底板）；新增 `onError` 回调（Orb 渲染错误内部捕获后走回调，没有该通道时宿主侧表现为「黑屏且无报错」）。
- 透明窗口：球体区域捕获鼠标，透明区域点击穿透；可拖拽放置并记忆位置。
- 命中半径按窗口尺寸推导（比例 `ORB_RADIUS_RATIO`=0.42，260px 窗口约 110px）。尺寸 80~400px 滑块调节、保持球心并持久化；可开「随状态自适应」（播报 ×1.12 / 聆听 ×1.06，只在手动基准上乘倍率）。尺寸细节另见 `docs/AI唱歌与悬浮球尺寸.md`。
- Orb 源码改动留痕以 **`vendor/orb/ORB_CHANGES.md` 为权威**。

## 二、多主题与音频动态

| 项 | 事实 |
|---|---|
| 内置默认主题 | **siri** |
| 导入主题（5 套） | frost（霜白）、opal（蛋白石）、blueDrop（深海蓝）、refractiveBlob（紫晶）、particleRibbon（粒子丝带） |
| 注入时机 | 构建期注入产物 `src/renderer/orb.html` |
| 运行时选择 | `app://orb/orb.html?theme=<id>`；无参数回落 siri；面板切换主题会热重载球体页面 |
| 音频律动强度 | 按「流场风格索引」登记（siri=9、frost=15、opal=13、blueDrop=20、refractiveBlob=23、particleRibbon=24） |
| 状态颜色 | **全部 6 个状态都用该主题的配色**（亮度对齐到各状态原设计，见下） |

### 状态颜色：主题配色 + 该状态的亮度（曾经的 bug）

vendor 的 `orb-states.ts` 给 `listening / executing / speaking / error` 四个状态**硬编码了固定语义色**（speaking = `#00E5FF` 青、listening = 绿、executing = 琥珀、error = 红），只有 `idle / thinking` 用主题色。后果：**换上任何主题，一进入说话状态球体就变回青色**，主题身份丢失（用户反馈「主题是什么颜色，它现在是什么颜色」）。

生成器在构建期把这四个状态的颜色改成**主题的配色**（vendored 运行时不改）：

- 每个颜色键取主题自己的颜色（保留其色相与色彩关系），**亮度对齐到该状态原本设计好的亮度**。
- 只改颜色；各状态的运动特征（`speed` / `warp` / `contourDeform` / `edgeGlow` …）保持原样。
- 默认主题 siri 一视同仁 —— 否则会出现「默认主题随状态变色、其它主题反而不变」的新不一致。

> 为什么必须做「亮度对齐」而不是直接沿用主题色的绝对亮度：`speaking` 等状态自身会额外加强
> `edgeGlow` / 曝光，而主题导出的是给 `idle/thinking` 用的绝对配色。直接把主题色搬进去，
> 偏亮的调色板（frost `#F7FBFF`、opal `#FFF6E8`）会被顶到纯白 —— 真机实测 frost 说话态
> **100% 像素纯白**，整颗糊成一个白盘。另有两种做法被验证不成立并已放弃：
> ① 用主题色的「色相+饱和度」配该状态的亮度 —— 近白色算 HSL 时 saturation 的分母趋零而
> 失真成 1.0，"接近白色"被读成"饱和的随机色相"；② 按亮度映射整组配色 —— 低彩度主题
> 仍然会白成一片（解不出彩度来）。
>
> 代价：状态不再用颜色区分（以前绿=聆听、琥珀=执行）。回归测试第 6 组守住三条：不得残留
> vendor 语义色、各状态主色色相贴近主题主色（≤40°）、亮度不得接近纯白。

### 音频动态强度：与默认主题同档

需求是「所有主题的声音动态与默认主题一致」。实现上**不给主题单独登记强度**：产物的
`defaultAudioStrength` 取自默认主题的查表值（`audioFlowStrengths[siri]`），未登记的风格在
运行时回退到它，于是自动与默认主题同档。默认主题的强度本身由
`vendor/orb/src/orb-audio-tuning.ts` 提供，不许被改动（回归测试第 5 组守住）。

> 曾实现过一套「按主题分档压制」（逐索引上限 + 高光收敛 + 风格收敛），起因是在浏览器里
> 观察到非默认主题过曝。后来查明那是**观测工具失真**：同一主题、同一强度、同一音量，
> 浏览器里渲染成斑驳状，真机（Electron）里却是光滑干净的。在已安装应用里注入强音频、
> 用应用自身的截图通道统计像素后确认：默认强度下各主题的过曝量与默认主题同级
> （frost 近白像素 5.8% / 饱和度 0.855，siri 7.1% / 0.841），**并不存在过驱问题**。
> 那套压制逻辑已全部移除。

### 怎么复现 / 调参

- 本地起静态服务（`orb.html` 是自包含页面）后浏览器打开 `http://127.0.0.1:8765/orb.html?theme=<id>`，
  控制台执行 `liquidOrb.setState("speaking"); liquidOrb.setAudioBands({low:.9,mid:.7,high:.5,all:.8})`。
  ⚠️ 浏览器的渲染结果与 Electron **不完全一致**（实测同一输入下形变表现不同），
  做「形变/过曝」判断请以应用内实机为准；只判断**颜色**时浏览器可信。
- 调参入口都在 `scripts/generate-orb.mjs`：`scaleColorToLum()`（状态配色与亮度对齐）、
  `PROFILE_COLOR_OFFSET`（颜色键→uniform 下标）。生成器会把每个主题的处理结果打印在构建日志里。

## 三、设备丢失三层自愈

现象：球体运行一段时间后**永久黑屏**（窗口在、内容空），只能重启整个应用恢复。依据：抓取球体窗口内容「非黑像素」为 0%；设置面板「WebGPU 状态」显示 `不可用: 设备已丢失`；日志反复出现：

```
[ERROR] [IPC] 球体渲染器报错：WebGPU device lost: A valid external Instance reference no longer exists.
[INFO]  [FSM] idle -> error  (渲染错误：WebGPU device lost: ...)
```

两个叠加缺陷：① 渲染器 `device.lost` 被当**终态**处理——置 `failed`、销毁设备、取消渲染循环，**没有重建分支**；且 `start()` 里 `requestAdapter()` 的结果是局部变量，函数返回后无引用持有，Dawn 的 instance 可能被 GC 回收（报错正是这一情形的典型表现）。② 宿主 `ORB_ON_ERROR` 只记日志、切状态、发通知，**从不触发恢复**（宿主侧本已有 `reloadWithTheme()` 页面重载能力，只是故障路径没调用）。现在分三层应对。

| 层 | 位置 | 行为 |
|---|---|---|
| 1 渲染器 | `vendor/orb/src/orb-renderer.ts` | 有限次指数退避重建：**5 次，0.5s 起、上限 8s（合计约 15.5s）**；每次重建重新 `requestAdapter()`；渲染恢复后重置计数；重试耗尽才上报宿主；`uncapturederror` 改为只记录 |
| 2 宿主兜底 | `src/main/ipc.ts` `scheduleOrbRecovery()` | 渲染器放弃后重载球体页面：**间隔 10s、最多 6 次（约 60s）**，覆盖 GPU 进程重启窗口；球体就绪后清零 |
| 3 可见反馈 + 手动重试 | `src/renderer/panel.html` + IPC | 达到上限时面板收到一条可行动提示；设置区有「球体恢复状态」显示与「重试恢复球体」按钮（**立即重载，不等 10 秒**） |

- IPC：`orb:recovery-status` / `orb:retry-recovery`（`src/common/types.ts` 中为 `IPC.ORB_RECOVERY_STATUS` / `IPC.ORB_RETRY_RECOVERY`；`src/preload/index.ts` 暴露 `orbRecoveryStatus()` / `orbRetryRecovery()`）。
- 定时器路径与手动路径共用 `performOrbReload()`，避免两份重载逻辑走样；`ORB_ON_READY` 清零计数、上限标记与待执行定时器。

> 分层设计理由：渲染器层只做约 15 秒快速重试，覆盖瞬时抖动；宿主层覆盖 GPU 进程被驱动复位/系统回收后 Chromium 重启它的窗口（本机实测约 60 秒，期间页面内怎么重建都拿不到 adapter，**必须重载页面**），故取 10s × 6 次。

## 四、WebGPU 自检已隔离

`orbController.checkWebGPU()` 现改为在**一次性隐藏探针窗口**里执行，拿到结果立即销毁，永不复用。

- **为什么**：旧实现跑在**球体自己的渲染进程**里，对球体正用于维持活跃设备的同一个 `GPUAdapter` 再 `requestDevice()` 出第二个 device 并立即 `destroy()`，是需要排除的干扰源；Dawn 的 `A valid external Instance reference no longer exists` 属 instance 生命周期类错误。
- **怎么做的**：新建 `src/main/gpu-probe.ts`（单例 `gpuProbe`）与探针页 `src/renderer/gpu-probe.html`（极简静态页，无脚本、无 UI）；`checkWebGPU()` 改为 `return gpuProbe.check();`，**方法签名与返回结构 `{ supported, adapterInfo?, error? }` 不变**。窗口参数：`show:false`、1×1、`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、`backgroundThrottling:false`，不加载 preload；加载 `app://panel/gpu-probe.html` 后用 `executeJavaScript` 注入探测表达式（`requestAdapter` → `requestDevice` → `device.destroy`）。
- **四项保护**：成功结果缓存 60s（失败不缓存，可立即重试）、并发去重（`inflight`，同一时刻只跑一个）、单次整体超时 **30s**、`app` 未就绪时直接返回失败不开窗。
- **入口**：启动时、托盘「WebGPU 自检」、面板「重跑 WebGPU 自检」。
- **启动时的判定口径（真机实测后修正）**：**球体能渲染出画面**才是 WebGPU 可用的最直接证据。全新安装首次启动时 GPU 进程是冷的、着色器缓存为空，探针取 adapter 可能超过 10s（本机实测首启超时、第二次启动预热后同一探针约 0.5s）。因此：
  - 球体已就绪 → 探针只用于记录适配器信息，失败仅告警 + 面板提示，**不弹模态框**（避免「球体正常渲染却报错」的误报）；
  - 球体未就绪 → 才弹模态框明确告知「大概率是 WebGPU/驱动问题」。
  - 超时上限也因此从 10s 放宽到 30s。

> 这**只消除了一个已确认的干扰源**，**不等于**定位了「设备约每 60 秒丢失」的根因。

## 五、三层同步与产物（改渲染逻辑必读）

```
vendor/orb/src/orb-renderer.ts   ┐
vendor/orb/src/code-export.ts    ┴─┐  模板源：整页是一个反引号模板字符串
scripts/generate-orb.mjs         ──┴─► src/renderer/orb.html（构建产物，勿只手改）
```

- **只改 `src/renderer/orb.html` 会被下次 `npm run build` 覆盖**；改渲染逻辑必须同时改 `code-export.ts`（模板）或 `orb-renderer.ts`（模块）。
- **真实踩过的坑**：`code-export.ts` 的模板是反引号字符串，**注释里写未转义的反引号会让模板提前结束、产物被静默截断**——生成器与 `tsc` 都不报错，曾因此让 CI 拦截一次。写注释里的反引号必须转义为 `` \` ``。该问题已由回归测试的「构建产物完整性」检查拦住。
- 生成器经 Vite SSR 加载 `orb-states.ts` / `code-export.ts`，调用 `createPresetOrbStateConfiguration("siri")` 与 `createWebExport(config, "idle")`，再注入宿主桥接脚本（就绪上报、错误转发、鼠标穿透、拖拽），输出 `orb.html`。
- 历史遗漏已补：命中半径随尺寸推导（`ORB_RADIUS_RATIO` / `updateOrbRadius`）此前只存在于产物里，生成器缺失，下次构建会被静默覆盖回写死的 `110`；已回填 `scripts/generate-orb.mjs`。

## 六、音频放大参数的注入

- 参数集中在 `vendor/orb/src/orb-audio-tuning.ts`，导出 `amplifiedAudioRules`（6 个五元组）与 `amplifiedAudioFlowStrengths`（6 键对象）。
- `scripts/generate-orb.mjs` 经 Vite SSR 导入该模块，用**正则整段替换**注入（`/const audioRules = \[\[[\s\S]*?\]\];/`、`/const audioFlowStrengths = \{[^}]*\};/`），替代原先的精确字符串匹配；仍保留「定位不到就抛错」兜底，不会静默产出错误产物，上游改数值也不再导致构建失败。

## 七、仍未完成（如实保留）

- **真机观察自愈是否真正成功**：未取得成功现场（观察关键字 `球体恢复重载成功`）。上一轮仅观察到重试逻辑确实在跑（日志由「永久停止」变为 `WebGPU 设备已断开，正在重建：...`），**不能据此说问题已修复**。
- **设备为何约每 60 秒周期性丢失的根因**：未定位。丢失时间点异常规律（多次都出现在启动后约 60 秒），不符合随机崩溃特征。已排除的自检副作用只是「消除一个可疑干扰源」。若根因不除，球体会反复「断开→重建」，观感上周期性闪烁/黑屏一次。待查方向：显卡驱动（本机 RTX 5060 + 驱动 `32.0.16.1052`）对 WebGPU/Dawn 的支持、Electron 34 的 GPU 进程稳定性、是否有外部组件在 60s 周期触碰 GPU（面板定时器 8s/6s/15s 均不碰 WebGPU，尚未找到触发源）。
- **退避参数真机调优**：现值仍为推断值（渲染器 5 次/上限 8s，宿主 6 次/间隔 10s），确认真实恢复耗时后可收敛。

## 八、给后来者的验证方法

1. 运行含改动的版本，查看日志 `%APPDATA%\jarvis-desktop-assistant\logs\jarvis-orb.log`。
2. 球体黑屏时按关键字判断落在哪一层：

| 日志关键字 | 含义 |
|---|---|
| `WebGPU device lost: ...` 且无后续 | 旧终态行为（v1.4.24 及更早，就是要修的基线） |
| `球体渲染器报错：WebGPU 设备已断开，正在重建` | 第 1 层渲染器退避已介入 |
| `将在 10000ms 后重载球体页面` | 第 2 层宿主兜底已介入 |
| `球体恢复重载成功` | ✅ 成功标志（三层自愈的唯一验收标准，目前仍未取得） |
| `球体恢复已达上限（6 次），停止自动重载` | ❌ 失败标志，需回到根因排查 |

3. 复现某一层：黑屏时先看第 1 层是否按退避重试；等渲染器放弃，看第 2 层是否约 10s 后重载；若设置面板「球体恢复状态」显示「已达上限（6 次），需要手动重试」，点「重试恢复球体」应立即重载（不等 10s）。
4. 曾用「杀掉 GPU 进程」模拟故障，但机制与真实 `device.lost` 不一致，**该模拟结论已作废，不作为依据**。本机环境无法跑完整构建时，回归脚本直接读源码与仓库内已有的 `orb.html` 做断言，**无需先构建**。

## 九、回归测试

`npm run verify:orb`（脚本 `scripts/verify-orb-recovery.mjs`，零依赖纯 Node ESM，不启动 Electron、不需要 WebGPU），共 **41 项静态断言**（以脚本实际输出为准），覆盖：

- 旧终态缺陷防回归（不得再出现终态 `fail(`，须保留重建标记与 `.lost.then` 绑定）；
- 退避序列复算（500/1000/2000/4000/8000ms，合计 15.5s）；
- 渲染逻辑三层一致性（关键标记须同时存在于 `orb-renderer.ts` / `code-export.ts` / `orb.html`，专治「只改产物被构建覆盖」）；
- 构建产物完整性（防模板被未转义反引号截断）；
- 宿主兜底参数（6×10s=60s，`ORB_ON_READY` 清零）；
- 音频注入参数三方一致（产物与 `orb-audio-tuning.ts` 常量深比较）。

它是**静态一致性回归**，验证源码/产物不变量没有漂移，**不验证运行时能否真正自愈**。已接入 `scripts/run.mjs` 的 `verify-orb` 任务与 CI，失败即阻断发布。

## 十、Orb 上游维护

改动只涉及「状态档案数量」与「导出页宿主适配」，动画、着色器、UI 组件、视觉预设均未触碰。以下方案曾考虑但未采用：

| 曾考虑 | 为什么没做 |
|---|---|
| 改 `orb-renderer.ts` 定制渲染 | 无需如此，且触碰「禁止重新设计动画」红线 |
| 改 `shader-source.ts` / `effect.wgsl` | 没必要，视觉须保持原生 |
| 改 `App.tsx` 做「纯球体模式」 | 编辑器无裸球模式是其固有限制，正解是**用导出页**而非改造编辑器 |
| 在宿主侧用 CSS/DOM 覆盖球体 | 明确违反「禁止替换 UI」 |

升级 Orb 上游时的建议流程：① 拉取新版 Orb 到临时目录；② 比对 `orb-states.ts` 与 `code-export.ts`，重新应用上述改动；③ 运行 `node scripts/generate-orb.mjs`，再跑 `npm run selftest` 验证六态与音频响应；④ 更新 `vendor/orb/ORB_CHANGES.md` 的版本号与差异说明。

第三方许可证：Orb（MIT，Copyright (c) 2026 LerSent001）、Toolcraft UI（MIT，Copyright (c) 2026 Pixel Point，许可证文件在 Orb 仓库根目录 `vendor/orb/TOOLCRAFT_LICENSE.md`）、`@wonderwhy-er/desktop-commander`（MIT）、Electron / React / Vite 等见各自 LICENSE。

## 十一、与旧文档的关系

以下三份旧文档**已删除**，内容并入本文；手上还有旧链接的话请改指本文。

| 旧文件（已删除） | 处置 |
|---|---|
| `docs/TODO-ORB-WEBGPU.md` | 已合并进本文 |
| `docs/ORB-WEBGPU-RECOVERY.md` | 已合并进本文 |
| `docs/ORB_CHANGES.md` | 已合并；该文件开头自陈「与实际代码不符」，其失实明细（不存在的符号、错误的色值等）不再保留。Orb 改动留痕以 `vendor/orb/ORB_CHANGES.md` 为权威 |

构建与打包流程见 `docs/构建说明.md`。
