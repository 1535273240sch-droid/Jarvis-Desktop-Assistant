# ORB_CHANGES.md — 对 Orb 源码的全部改动留痕

> 编制日期：2026-09-21
> 最近更新：2026-09-21（**第二轮**：修复 `tsc` 类型错误、补齐 Swift 6 态、扩展校验脚本，`pnpm build` 已恢复全绿）
> 适用任务：T01（Orb 集成路径定案）、T03（Electron 壳与 Orb 渲染）
> 留痕目的：T01 任务书第三节硬约束要求"允许对 Orb 源码做**最小、受控**的修改，但**必须逐行留痕**"。本文件是红线合规的唯一证明。
>
> **镜像说明**：本文件在**三处**各存一份，**内容必须保持一致**（已核 sha256 相同）：
> - `T01_Orb集成路径定案\ORB_CHANGES.md`
> - `T03_Electron壳与Orb渲染\ORB_CHANGES.md`（与 `vendor/orb` 相邻）
> - `Jarvis\vendor\orb\ORB_CHANGES.md`（整合工程内的同一份 fork，字节级一致）
> 任何后续改动请**同时更新三份**。
>
> ⚠️ **另有一份失实的同名文件**：`Jarvis\docs\ORB_CHANGES.md`（8,530 字节，非本次复核方所写）**内容与实际代码不符** —— 它声称新增了 `extendedStateProfiles` / `createExtendedStateParams()`（**全树检索不存在**）、`listening` 的 `colorA` 为 `#4A90E2`（**实际 `#38EF7D`**）、`App.tsx` 未改动（**实际已改动**）、源文件数为 14（**实际 216**）。该文件已被加注警示，**引用时请以本文件为准**。详见该文件顶部的对照表。

---

## 一、受控 fork 的位置与基线

| 项 | 值 |
|---|---|
| fork 位置 | `T03_Electron壳与Orb渲染\vendor\orb\`（T03 交付副本）<br>`Jarvis\vendor\orb\`（整合工程副本，**与前者逐字节一致**，已核 232 文件 0 差异） |
| 上游基线 | `C:\Users\Administrator\.zcode\workspace\default\orb_src\orb-main\` |
| 上游仓库 | `https://github.com/LerSent001/orb` |
| 上游许可 | MIT（`LICENSE`）+ `TOOLCRAFT_LICENSE.md`（Toolcraft UI，Copyright (c) 2026 Pixel Point） |
| 上游是否 git 仓库 | **否**（无 `.git`），故本文件以**文件级比对 + SHA-256** 作为留痕依据 |
| 校验链状态 | ✅ **全绿**（`pnpm build` 退出码 0，见 §四） |

**基线完整性核对**（排除 `node_modules` / `dist` / `output`）：

| 项 | 数量 |
|---|---|
| fork 文件总数 | 232 |
| 上游文件总数 | 231 |
| **修改的文件** | **4**（`orb-states.ts`、`code-export.ts`、`App.tsx`、`verify-exports.mjs`） |
| **新增的文件** | **1**（`scripts/export-orb-html.mjs`） |
| **逐字节一致的文件** | **227 / 231（98.3%）** |

> 结论：改动仍属**最小且受控**。`src/` 下 216 个文件中 **213 个逐字节未变**；被修改的 2 个 `src` 文件 + 1 个 UI 文件，另加 1 个校验脚本（见 §二 改动 5–7，为修复校验链所必需）。

> **改动分两轮**：
> - **第一轮（改动 1–4）**：6 态扩展本体。改 `orb-states.ts` + `code-export.ts`，新增导出脚本。
> - **第二轮（改动 5–7）**：修复第一轮打破的校验链（口径 (i)）。改 `App.tsx`（修 `tsc` 错误）、`code-export.ts`（Swift 补齐 6 态）、`verify-exports.mjs`（6 态基线）。

---

## 二、改动清单（共 7 处）

### 改动 1｜`src/orb-states.ts` — 状态列表由 2 态扩为 6 态（新增行）

**位置**：`vendor/orb/src/orb-states.ts:3-10`

```diff
-export const orbStateNames = ["idle", "thinking"] as const;
+export const orbStateNames = [
+  "idle",
+  "listening",
+  "thinking",
+  "executing",
+  "speaking",
+  "error"
+] as const;
 export type OrbStateName = (typeof orbStateNames)[number];
```

**理由**：任务书要求 6 个状态（Idle / Listening / Thinking / Executing / Speaking / Error），而 Orb 原生仅 `idle` / `thinking` 两态。导出页的 `setState()` 以 `stateSeeds` 的键做白名单校验（**上游** `code-export.ts:131-135` → **fork 后** `:132-136`，因改动 3b 增删了若干行而整体位移 1 行），未知状态名直接抛 `TypeError`。**宿主侧无法凭空多出 4 个状态**，故必须扩展本源数组。
**性质**：纯新增。未删除、未重命名任何既有状态，`idle` / `thinking` 语义与顺序保持原样。
**依赖**：此为 D5 决策（六态扩展方案 a）的落地。

---

### 改动 2｜`src/orb-states.ts` — 新增 4 个状态档案（新增行）

**位置**：`vendor/orb/src/orb-states.ts:330-392`（档案定义）、`:394-406`（挂入 `profiles`）

**改动 2a：新增 4 份档案定义**（插入在 `createOrbStateConfiguration()` 内、`return` 之前）

| 状态 | 基档 | 数值参数调整 | 颜色（6 项） |
|---|---|---|---|
| `listening` | `idle.profile` | `speed ×1.1`、`contourDeform ×1.2`、`zoom ×1.02`、`warp ×1.1`、`edgeGlow ×1.3` | A `#38EF7D`／B `#11998E`／C `#00C9FF`／D `#92FE9D`／highlight `#E0F7FA`／glow `#00E676` |
| `executing` | `thinking.profile` | `speed ×0.9`、`metalStretch ×1.2`、`metalEvolution ×1.15`、`ridgeAmt ×1.2`、`edgeGlow ×1.2` | A `#FFB300`／B `#FF6F00`／C `#FF8F00`／D `#FFA000`／highlight `#FFF8E1`／glow `#FFC107` |
| `speaking` | `thinking.profile` | `speed ×1.15`、`contourDeform ×1.25`、`zoom ×1.05`、`warp ×1.15`、`edgeGlow ×1.4` | A `#00E5FF`／B `#1DE9B6`／C `#00B0FF`／D `#64FFDA`／highlight `#FFFFFF`／glow `#00E5FF` |
| `error` | `idle.profile` | `speed ×1.3`、`contourDeform ×1.4`、`ridgeAmt ×1.5`、`sharp ×1.3` | A `#FF1744`／B `#D50000`／C `#C51162`／D `#B71C1C`／highlight `#FF8A80`／glow `#FF5252` |

未在表中列出的参数**继承各自基档**（`...idle.profile` 或 `...thinking.profile`），因此每个档案都是完整的 25 项（19 数值 + 6 颜色）。

**改动 2b：挂入 profiles 映射**

```diff
   profiles: {
     idle: idle.profile,
+    listening: listeningProfile,
     thinking: thinking.profile,
+    executing: executingProfile,
+    speaking: speakingProfile,
+    error: errorProfile,
   },
```

**理由**：`OrbStateConfiguration.profiles` 的类型是 `Record<OrbStateName, OrbStateProfile>`。拓宽 `orbStateNames` 后，此处**必须**提供 6 份档案，否则 tsc 报错。
**性质**：纯新增。**复用现有参数集**（`OrbStateProfile` 的 25 个既有键），未引入新参数、未改动参数含义。

> **重要合规说明**：新状态档案采用"以既有档案为基线 × 倍率 + 指定颜色"的构造方式，**复用现有参数集与现有语义**。这满足"禁止重新设计动画"的红线 —— 新状态走的是**同一套着色器与同一套参数**，只是取值不同。

---

### 改动 3｜`src/code-export.ts` — 导出页模板的 4 处调整

#### 3a. `createStateSeeds` 由硬编码两态改为遍历 `profiles`

**位置**：`vendor/orb/src/code-export.ts:21-27`

```diff
 function createStateSeeds(configuration: OrbStateConfiguration): Record<OrbStateName, number[]> {
-  return {
-    idle: createOrbUniformSnapshot(resolveOrbStateParams(configuration, "idle")),
-    thinking: createOrbUniformSnapshot(resolveOrbStateParams(configuration, "thinking")),
-  };
+  const seeds = {} as Record<OrbStateName, number[]>;
+  for (const state of Object.keys(configuration.profiles) as OrbStateName[]) {
+    seeds[state] = createOrbUniformSnapshot(resolveOrbStateParams(configuration, state));
+  }
+  return seeds;
 }
```

**理由**：原实现硬编码 `idle` / `thinking` 两项，即使扩展了状态数组，导出页也只会烘焙 2 个快照。改为遍历 `configuration.profiles`，使导出页自动覆盖全部状态，**且对未来的状态增减免疫**。
**性质**：行为等价化重构 + 泛化。既有 2 态的烘焙结果**逐字节不变**（同一函数、同一参数），仅覆盖面扩大。

#### 3b. 页面底色改为透明、隐藏状态文字层

**位置**：`vendor/orb/src/code-export.ts:43-48`

```diff
   <style>
-    html, body, canvas { width: 100%; height: 100%; margin: 0; }
-    body { overflow: hidden; background: ${configuration.shared.canvasColor}; }
-    canvas { display: block; }
-    #status { position: fixed; inset: 0; display: grid; place-items: center; color: white; font: 14px system-ui; }
+    html, body, canvas { width: 100%; height: 100%; margin: 0; padding: 0; }
+    body { overflow: hidden; background: transparent; }
+    canvas { display: block; width: 100vw; height: 100vh; background: transparent; }
+    #status { display: none !important; }
   </style>
```

**理由**：三项均为 T01 第 2 步"把导出页整理成纯球体"的明确要求：
1. `background: transparent` —— 悬浮球需透明底。**注意**：此处改的是**模板 CSS**，**没有**改 `canvasColor` 的取值 —— 因为 `canvasColor` 同时是 shader uniform 输入（`orb-uniforms.ts:99`），且 `rgb()` 按字符位切片解析 hex（`orb-uniforms.ts:22-31`），传入非 `#RRGGBB` 值会产生 `NaN`。
2. `#status { display: none !important; }` —— 隐藏导出页自带的状态文字提示层。
3. `padding: 0` + canvas `100vw/100vh` —— 消除默认边距/尺寸缝隙导致的黑边。

**透明可行性依据（无需改渲染代码）**：WebGPU context 使用 `alphaMode: "premultiplied"`（`code-export.ts` 内 `configure` 调用），且两个 render pass 的 `clearValue` alpha 均为 0。故仅改 CSS 即可得到透明背景。
**性质**：模板字符串内的 CSS 修改，不涉及渲染逻辑、着色器、缓动函数。

#### 3c. 新增 `onError` 回调（控制面由 3 个方法扩为 4 个）

**位置**：`vendor/orb/src/code-export.ts:150-153`（定义）、`:155-162`（挂载）、`:164-177`（触发）

```diff
+    let onErrorCallback = null;
+    function onError(handler) {
+      if (typeof handler === "function") onErrorCallback = handler;
+    }
+
     Object.defineProperty(window, "liquidOrb", {
       value: Object.freeze({
         getState: () => state,
         setState,
         setAudioBands,
+        onError,
       }),
     });
```

```diff
     function stopWithError(error) {
       if (stopped) return;
       stopped = true;
       cancelAnimationFrame(animationFrame);
       ribbonTarget?.destroy();
       device?.destroy();
       status.hidden = false;
-      status.textContent = error instanceof Error ? error.message : String(error);
+      const msg = error instanceof Error ? error.message : String(error);
+      status.textContent = msg;
       console.error(error);
+      if (typeof onErrorCallback === "function") {
+        try { onErrorCallback(msg); } catch (e) { console.error("Error in onError callback", e); }
+      }
     }
```

**理由**：Orb 渲染器**硬依赖 WebGPU 且无降级**。失败时原有的 `stopWithError()` 只把错误写进 DOM 与 console，**宿主（Electron 主进程）无从感知**，现场表现为"黑屏无报错"，无法给出可读提示。新增 `onError` 提供一条**宿主可观测的失败通道**。
**性质**：**纯新增的公开方法** + 在既有错误路径上追加一次回调派发。既有 3 个方法签名与行为**未变**；回调异常被 `try/catch` 包裹，不会污染导出页自身的错误处理。

> ⚠️ **契约变更（重要）**：这使 `window.liquidOrb` 的方法集由 **3 个变为 4 个**（`getState` / `setState` / `setAudioBands` / `onError`）。**T02 / T04 / T05 中"控制面只有 3 个方法"的描述需同步更新。**（审查报告 `05` 的 T01-2 条目已指出此点。）

---

### 改动 4（新增文件，非源码修改）｜`scripts/export-orb-html.mjs`

**位置**：`vendor/orb/scripts/export-orb-html.mjs`（**新增文件，1198 字节**）

**作用**：以 Node 脚本形式调用 Orb 自身的 `createWebExport()`，在 `vendor/orb` 上生成自包含导出页，支持通过命令行参数指定输出路径。
**理由**：T03 需要在构建流程中**自动生成**导出页（避免改状态参数后忘记重新导出）。T01 第 4 步选定"受控 fork"路线，需要一个可脚本化的导出入口。
**性质**：**新增独立脚本，未修改任何既有文件**。它只调用 Orb 的公开导出函数，不含任何对 Orb 本体的改动。

> 备注：T03 的实际构建入口是 `T03_Electron壳与Orb渲染\scripts\generate-orb.mjs`，它调用同一套 `createWebExport()` 并额外注入宿主桥接脚本（就绪通知、鼠标穿透、拖拽）。本脚本是 vendor 内的独立导出脚本，两者不冲突。

---

## 二之二、第二轮改动（改动 5–7）：修复被打破的校验链

> **背景**：改动 1–2 把状态集扩为 6 态后，Orb 自带的校验链失效（`verify-exports.mjs:204` 断言失败 + `tsc` 报 `App.tsx:757` 类型错误），导致 T01 验收标准 5 不成立。
> **口径决定**：经用户拍板采用 **(i) 同步扩展校验脚本，使 6 态成为新基线**。以下三处为该口径的必要落地。
> **结果**：`vendor/orb` 的 `pnpm build`（含两个校验脚本 + tsc + vite build）**已恢复全绿**，T01 验收标准 5 由此**成立**。

### 改动 5｜`src/App.tsx` — `openCode` 改为遍历全部状态档案（修复 tsc 错误）

**位置**：`vendor/orb/src/App.tsx:758-760`（另 `:72` 新增 `type OrbStateProfile` 导入）

```diff
   const openCode = React.useCallback(() => {
     setCodeState({
       activeState: editorState.activeState,
       configuration: {
         ...editorState.configuration,
         shared: { ...editorState.configuration.shared },
-        profiles: {
-          idle: { ...editorState.configuration.profiles.idle },
-          thinking: { ...editorState.configuration.profiles.thinking },
-        },
+        profiles: Object.fromEntries(
+          orbStateNames.map((state) => [state, { ...editorState.configuration.profiles[state] }]),
+        ) as Record<OrbStateName, OrbStateProfile>,
       },
     });
```

**理由**：这是改动 1 的**连带影响**（非独立 bug 引入）。`OrbStateConfiguration.profiles` 的类型已是 `Record<OrbStateName, …>` 的 6 元组，而此处只克隆 `idle`/`thinking`，故 `tsc` 报 `TS2739`（缺 error/listening/executing/speaking）。
**同时修掉一个真实功能缺陷**：原实现在编辑器里点"导出代码"时，**导出的代码会缺失 4 个新状态的档案**（配置对象被裁剪成 2 态）。改为遍历后，编辑器导出与实际配置一致。
**性质**：最小等价改写 —— 沿用原有的浅克隆语义（`{ ...profile }`），仅把"手写 2 项"换成"按 `orbStateNames` 遍历"。**不改动任何 UI 结构、样式或交互**。

---

### 改动 6｜`src/code-export.ts` — Swift 导出补齐 6 态（消除静默不对称）

**位置**：`vendor/orb/src/code-export.ts:5-9`（导入）、`:23-26`（新增辅助函数）、`:400-408`（生成片段）、`:445`、`:450`

**6a. 新增状态名 → Swift 标识符的转换函数**

```diff
+/** 把状态名转成 Swift 标识符用的 PascalCase（idle → Idle，thinking → Thinking）。 */
+function swiftStateIdentifier(state: OrbStateName): string {
+  return state.charAt(0).toUpperCase() + state.slice(1);
+}
```

**6b. Swift 种子常量、enum case、switch 分支由写死两态改为按 `orbStateNames` 生成**

```diff
   const stateSeeds = createStateSeeds(configuration);
+  const seedConstants = orbStateNames
+    .map((state) => `private let orb${swiftStateIdentifier(state)}UniformSeed: [Float] = [
+${formatSwiftFloats(stateSeeds[state])}
+]`)
+    .join("\n\n");
+  const stateCases = orbStateNames.map((state) => `    case ${state}`).join("\n");
+  const seedSwitch = orbStateNames
+    .map((state) => `    case .${state}: orb${swiftStateIdentifier(state)}UniformSeed`)
+    .join("\n");
```

```diff
-private let orbIdleUniformSeed: [Float] = [
-${formatSwiftFloats(stateSeeds.idle)}
-]
-
-private let orbThinkingUniformSeed: [Float] = [
-${formatSwiftFloats(stateSeeds.thinking)}
-]
+${seedConstants}
```

```diff
 public enum LiquidOrbState: Sendable {
-    case idle
-    case thinking
+${stateCases}
 }

 private func orbUniformSeed(for state: LiquidOrbState) -> [Float] {
     switch state {
-    case .idle: orbIdleUniformSeed
-    case .thinking: orbThinkingUniformSeed
+${seedSwitch}
     }
 }
```

**理由**：Swift 导出的这些部分是**字符串模板**，不受 `tsc` 保护，因此改动 1–2 后 Web 导出已是 6 态、**Swift 导出却静默停留在 2 态**，两边不对称且无任何编译提示。`verify-exports.mjs` 会去解析 Swift 种子，补齐后两侧一致。
**性质**：泛化重构。既有 `idle`/`thinking` 的 Swift 输出**逐字节不变**（同一 `formatSwiftFloats`、同一快照），仅覆盖面扩到全部状态。
**未改动**：Swift 侧的过渡缓动逻辑（`activeTransitionDuration` / `easedProgress` 仍对 `.thinking` 特判）**保持不变**，与 Web 侧语义一致。
**注**：V1 不使用 Swift 导出，此改动是为**消除静默不对称**并让校验链可成立。

---

### 改动 7｜`scripts/verify-exports.mjs` — 校验基线由 2 态扩为 6 态

**位置**：`vendor/orb/scripts/verify-exports.mjs:142-153`（`parseSwiftSeed`）、`:161-172`（`expectedSeeds` / `swiftSeeds`）、`:532-533`（调参后区块）、`:555`（汇总输出）

**7a. `parseSwiftSeed` 不再写死两态**

```diff
   function parseSwiftSeed(code, state) {
-    const name = state === "idle" ? "Idle" : "Thinking";
+    // 状态名 → Swift 标识符（idle → Idle，listening → Listening，…）。
+    // 不要写死 idle/thinking 两态：状态集已扩为 6 态。
+    const name = state.charAt(0).toUpperCase() + state.slice(1);
```

**7b. `expectedSeeds` / `swiftSeeds` 改为遍历 `orbStateNames`**（原本只建 `idle`/`thinking` 两项）

```diff
-    const expectedSeeds = {
-      idle: uniforms.createOrbUniformSnapshot(idleParams),
-      thinking: uniforms.createOrbUniformSnapshot(thinkingParams),
-    };
+    const expectedSeeds = Object.fromEntries(
+      orbStates.orbStateNames.map((state) => [
+        state,
+        uniforms.createOrbUniformSnapshot(orbStates.resolveOrbStateParams(configuration, state)),
+      ]),
+    );
```

同类改动另见 `swiftSeeds`、以及调参区块（`:526-527`）。

**7c. Web 种子正则放宽**（原 `(\{"idle":\[[^;]+\});` 只匹配以 `"idle"` 开头的两态对象）

```diff
-    const webSeedsMatch = webCode.match(/const stateSeeds = (\{"idle":\[[^;]+\});/);
-    assert.ok(webSeedsMatch, `${style}: Web 两态 uniform seed 缺失`);
+    const webSeedsMatch = webCode.match(/const stateSeeds = (\{[^;]+\});/);
+    assert.ok(webSeedsMatch, `${style}: Web 全状态 uniform seed 缺失`);
```

**7d. 汇总输出改为动态报告状态数**

```diff
-    `Verified ${presets.styleNames.length} presets across idle/thinking: editor, WebGPU, and SwiftUI parameters are identical.`,
+    `Verified ${presets.styleNames.length} presets across ${orbStates.orbStateNames.length} states (${orbStates.orbStateNames.join("/")}): editor, WebGPU, and SwiftUI parameters are identical.`,
```

**理由**：这些断言在两态时代是有效护栏，但 6 态是我方**有意引入的基线变化**；若不同步扩展，`pnpm build` 将永远无法通过（T01 验收标准 5 永久不成立）。扩展后护栏仍然完整 —— 它现在**要求 6 态齐备**（`:203` 的 `for (const state of orbStates.orbStateNames)` 会对每一态校验 Web/Swift 种子与编辑器一致、长度 136、flow index、玻璃罩开关）。
**性质**：**仅放宽"状态数写死"这一处，未删除或弱化任何断言**。所有原有校验（两态视觉差异、速度/曝光差异、运动层次、外向光照为 0、过渡时序、着色器一致性、设备丢失处理等）**逐条保留**。

---

## 三、明确**未**改动的部分（红线合规证明）

以下均为**逐字节一致（SHA-256 相同）**，可独立复核。这份清单是"未修改 Orb 的 UI 组件、着色器、缓动函数"这一验收标准（T01 验收标准 4）的直接证据：

| 文件 / 内容 | 状态 | 说明 |
|---|---|---|
| `src/orb-renderer.ts` | **SAME** | 渲染器**完全未动** |
| `src/orb-audio.ts` | **SAME** | 音频响应规则**完全未动** |
| `src/shader-source.ts` | **SAME** | 着色器源**完全未动** |
| `effect.wgsl` / `effect.metal` | **SAME** | WGSL / Metal 着色器本体**逐字节未变** |
| `src/presets.ts` | **SAME** | 13 个预设**完全未动** |
| `src/orb-uniforms.ts` | **SAME** | uniform 写入逻辑**完全未动** |
| `src/particle-ribbon.ts` | **SAME** | 粒子丝带**完全未动** |
| `src/toolcraft/**`（约 190 文件） | **SAME** | Toolcraft UI 组件库**完全未动** |
| `package.json` / `index.html` / `vite.config.ts` / `tsconfig.json` | **SAME** | 构建配置**完全未动** |
| `scripts/verify-audio.mjs` | **SAME** | 音频校验脚本**未改** |
| 过渡控制器 `createOrbTransitionController()` | **未触碰** | 逐字未变 |
| 缓动函数 `smoothOrbTransitionProgress()` / `activeOrbTransitionProgress()` | **未触碰** | 逐字未变 |
| 颜色插值 `mixHexColor()` / `srgbToLinear()` / `linearToSrgb()` / `parseHexColor()` | **未触碰** | 逐字未变，**线性光语义保持** |
| 着色器内联校验 | **通过** | 校验脚本仍断言导出页内联着色器与源文件**逐字节一致**；该断言在第二轮后依然通过 |

> 三个函数在 diff 中仅出现为**位移后的上下文**（行号变化），**内容零改动**。因此验收标准 4 的"未修改缓动函数与颜色插值"**成立**。

### 关于 `App.tsx` 与 `verify-exports.mjs`（第二轮后已不再是 "SAME"）

这两份文件在第一轮**确为逐字节一致**，第二轮因修复校验链而被修改，故从上表移出（详见 §二之二 改动 5、改动 7）。**它们的修改均未触碰 UI 外观、着色器或动画逻辑**：

- **`App.tsx`**：仅把 `openCode` 里手写的 2 项 profile 克隆改为按 `orbStateNames` 遍历。UI 结构、样式、交互、渲染逻辑均未变；且顺带修掉"编辑器导出代码缺 4 态"的真实缺陷。
- **`verify-exports.mjs`**：仅放宽"状态数写死两态"这一处，并把汇总输出改为动态报告状态数。**未删除或弱化任何断言**。

---

## 四、校验链状态（第二轮已修复 ✅）

**结论：`vendor/orb` 的 `pnpm build` 已恢复全绿，T01 验收标准 5 成立。**

### 4.1 本轮修复前的两处失败（历史记录，已解决）

第一轮 6 态扩展后，Orb 自带校验链曾失效，两处均已在 §二之二 修复：

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| ① | `verify-exports.mjs:204` 断言失败：`siri/listening: Web 参数与编辑器不一致`，`expected: undefined` | `parseSwiftSeed()` 写死 `state === "idle" ? "Idle" : "Thinking"`，新状态解析不出 Swift 常量名 | 改动 7 |
| ② | `tsc --noEmit` **exit 2**：`src/App.tsx(757,9) TS2739`，缺 `error/listening/executing/speaking` | `openCode` 只克隆 `idle`/`thinking` 两态档案，而 `profiles` 类型已是 6 元组 | 改动 5 |
| ③ | （潜在）Swift 导出静默停留在 2 态 | `createSwiftExport` 的 enum/switch 是**字符串模板**，不受 tsc 保护 | 改动 6 |

> ①会**阻断** `pnpm build` 的后续步骤（`verify-audio`、`tsc`、`vite build` 都不执行），故当时表现为整个 build 失败。

### 4.2 修复后的实测验证（2026-09-21）

**`vendor/orb` 内 `pnpm build` 全链路**（`verify-exports` → `verify-audio` → `tsc` → `vite build`）：

```
$ cd T03_Electron壳与Orb渲染\vendor\orb
$ set "PATH=C:\Program Files\nodejs;%PATH%"
$ pnpm build

Verified 13 presets across 6 states (idle/listening/thinking/executing/speaking/error):
  editor, WebGPU, and SwiftUI parameters are identical.
Audio: all 13 presets × both states verified; six supported, seven unchanged; ...
✓ built in 2.46s
```

**逐步退出码**：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 导出校验 | `node scripts/verify-exports.mjs` | **exit 0** ✅ |
| 音频校验 | `node scripts/verify-audio.mjs` | **exit 0** ✅ |
| 类型检查（vendor/orb） | `tsc -p tsconfig.json --noEmit` | **exit 0** ✅（修复前为 2） |
| 打包 | `vite build` | **exit 0** ✅ |

**宿主工程侧（不回归）**：

| 目录 | 命令 | 结果 |
|---|---|---|
| `T03_Electron壳与Orb渲染` | `tsc --noEmit` / `scripts/build.mjs` | **exit 0** / 三步全绿 ✅ |
| `Jarvis` | `tsc --noEmit` / `scripts/build.mjs` | **exit 0** / 四步全绿（含产物校验）✅ |
| `Jarvis\vendor\orb` | `verify-exports` / `tsc --noEmit` | **exit 0** / **exit 0** ✅ |

### 4.3 运行时复验（6 态与透明背景）

用 Chrome 153（WebGPU 已启用）实际加载再生后的 `src/renderer/orb.html`：

```
window.liquidOrb: object          initial state: idle
idle      -> idle          listening -> listening       thinking  -> thinking
executing -> executing     speaking  -> speaking        error     -> error
setAudioBands({...}) -> ok     setAudioBands() 无参 -> ok
console errors: (none)
canvas 764x485     body background: rgba(0, 0, 0, 0)   ← 透明生效
```

**6 态全部可切换、无抛错、无控制台报错、背景确认透明。**

### 4.4 口径说明（已由用户拍板）

采用 **(i) 同步扩展校验脚本，使 6 态成为新基线**。因此 **T01 验收标准 5 的语义为"构建仍绿"，而非"校验脚本一字未改"** —— `verify-exports.mjs` 本身已被修改（改动 7）。这一点在验收时应按此口径判定。

> 护栏完整性：扩展后 `verify-exports.mjs` **仍要求 6 态齐备**，对每一态校验 Web/Swift 种子与编辑器一致、uniform 长度 136、flow index、玻璃罩开关；两态时代的其余断言（视觉差异、速度/曝光、运动层次、过渡时序、着色器逐字节一致、设备丢失处理等）**逐条保留、无弱化**。

---

## 五、改动汇总表

| # | 文件 | 位置 | 类型 | 一句话理由 |
|---|---|---|---|---|
| 1 | `src/orb-states.ts` | `:3-10` | 新增 | 状态列表 2 → 6，满足任务书 6 态要求 |
| 2 | `src/orb-states.ts` | `:330-406` | 新增 | 为 4 个新状态各写档案，复用现有 25 参数与过渡机制 |
| 3a | `src/code-export.ts` | `:21-27` | 泛化 | 导出快照由硬编码两态改为遍历 profiles |
| 3b | `src/code-export.ts` | `:43-48` | 修改 | 底色透明、隐藏状态文字层（T01 第 2 步要求） |
| 3c | `src/code-export.ts` | `:150-177` | 新增 | `onError` 让宿主可感知 WebGPU/渲染失败 |
| 4 | `scripts/export-orb-html.mjs` | 新文件 | 新增 | 提供可脚本化的导出入口 |
| **5** | `src/App.tsx` | `:72`、`:758-760` | 修复 | `openCode` 遍历全部档案，修 `tsc` 错误 + 编辑器导出缺 4 态 |
| **6** | `src/code-export.ts` | `:5-9`、`:23-26`、`:400-408`、`:445`、`:450` | 泛化 | Swift 导出补齐 6 态，消除静默不对称 |
| **7** | `scripts/verify-exports.mjs` | `:142-153`、`:161-172`、`:532-533`、`:555` | 泛化 | 校验基线 2 态 → 6 态（口径 (i)），护栏不弱化 |

**规模**：修改 **4** 个文件、新增 1 个文件；231 个上游文件中 **227 个逐字节未变（98.3%）**；`src/` 下 216 个文件中 213 个未变。
**未触碰**：着色器（`shader-source.ts`、`effect.wgsl`、`effect.metal`）、渲染器（`orb-renderer.ts`）、缓动函数、颜色插值、预设、uniform 写入、`toolcraft/**` UI 组件库、构建配置。

> 改动 1–4 为第一轮（6 态扩展本体）；改动 5–7 为第二轮（修复校验链，见 §二之二）。
> `App.tsx` 第二轮被修改（改动 5），但**只动了 `openCode` 的数据克隆逻辑与一处类型导入**，UI 外观、样式、交互、渲染路径均未变。

---

## 六、复核方法（可独立验证）

```bat
:: 0. 切换 Node 到 PATH（本机 node 未入 PATH，必须先做）
set "PATH=C:\Program Files\nodejs;%PATH%"

:: 1. 文件级比对（排除 node_modules / dist / output 后逐字节比较）
::    预期：MODIFIED = 4 个
::          src/orb-states.ts, src/code-export.ts, src/App.tsx, scripts/verify-exports.mjs
::          only in vendor = scripts/export-orb-html.mjs
::          UNCHANGED = 227

:: 2. 确认 6 态已烘焙进导出产物
findstr /c:"listening" /c:"executing" /c:"speaking" "T03_Electron壳与Orb渲染\src\renderer\orb.html"

:: 3. 确认控制面为 4 个方法
findstr /c:"onError" "T03_Electron壳与Orb渲染\src\renderer\orb.html"

:: 4. 核心门槛：vendor/orb 全链路构建应全绿（预期运行 "6 states" 字样）
cd T03_Electron壳与Orb渲染\vendor\orb
pnpm build

:: 5. vendor/orb 类型检查独立复核（预期 exit 0）
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit

:: 6. 对照：宿主工程自身亦应通过
cd ..\..
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node scripts/build.mjs

:: 7. 对照：整合工程 Jarvis 亦应通过
cd ..\Jarvis
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node scripts/build.mjs
```

**已实测确认的产物状态**（`src/renderer/orb.html`，97,165 字节）：
```
states baked into export page: idle, listening, thinking, executing, speaking, error
  idle       floats=136
  listening  floats=136
  thinking   floats=136
  executing  floats=136
  speaking   floats=136
  error      floats=136

window.liquidOrb methods: getState / setState / setAudioBands / onError
```

**类型检查实测对照（2026-09-21，第二轮修复后）**：

| 目录 | 命令 | 结果 |
|---|---|---|
| `T03_Electron壳与Orb渲染` | `tsc --noEmit` | **exit 0**（无输出）✅ |
| `Jarvis` | `tsc --noEmit` | **exit 0**（无输出）✅ |
| `T03_Electron壳与Orb渲染\vendor\orb` | `tsc --noEmit` | **exit 0**（无输出）✅ |
| `Jarvis\vendor\orb` | `tsc --noEmit` | **exit 0**（无输出）✅ |

> 修复前后两者为 **exit 2**（`App.tsx:757 TS2739`）；改动 5 修复后**四处全部通过**。

**构建实测**：`T03` 与 `Jarvis` 的 `scripts/build.mjs` 均**全绿**（Jarvis 为 4 步、含产物校验）；`vendor/orb` 的 `pnpm build` **全链路绿**（§4.2）。

**运行时复验**：Chrome 153 + WebGPU 实测加载 `orb.html` —— 6 态全部 `setState` 成功、无控制台报错、背景 `rgba(0,0,0,0)` 透明、`setAudioBands` 有参与无参均可调用（§4.3）。

---

## 七、结论

1. 对 Orb 的改动共 **6 处源码改动 + 1 个新增脚本**（第一轮 3 处 + 第二轮 3 处），全部为**最小、受控、可逐行复核**。
2. **未修改**任何着色器、渲染器、缓动函数、颜色插值逻辑、预设、uniform 写入与 Toolcraft UI 组件库 —— 满足 T01 验收标准 4（红线）。`App.tsx` 第二轮仅改 `openCode` 的数据克隆逻辑，**UI 外观与交互未变**。
3. 六态扩展**真实生效**：导出产物中 6 个状态各烘焙 136 个 float 快照；Web 与 Swift 两侧**对称**（均为 6 态）。
4. ✅ **校验链已修复**：`vendor/orb` 的 `pnpm build`（两个校验脚本 + tsc + vite build）**全链路退出码 0**。口径按 **(i) 6 态为新基线** —— 因此 **T01 验收标准 5 成立**，其语义为"构建仍绿"，而非"校验脚本一字未改"（`verify-exports.mjs` 已被改动 7 修改）。
5. 控制面契约由 3 个方法变为 **4 个**（新增 `onError`），下游任务文档已同步。
6. Swift 导出已由 2 态补齐为 **6 态**（改动 6），消除了此前"Web 6 态 / Swift 2 态"的静默不对称。
7. 本文件在 **3 处**各存一份且内容一致（T01、T03、`Jarvis\vendor\orb`），后续改动请同时更新三份。
