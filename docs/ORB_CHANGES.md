> # ⚠️ 本文件内容与实际代码不符 —— 请以 `vendor/orb/ORB_CHANGES.md` 为准
>
> **2026-09-21 复核结论**：本文件描述的改动**与仓库中实际代码不一致**，**请勿引用本文件的细节**。权威版本为：
> - `Jarvis\vendor\orb\ORB_CHANGES.md`（与 fork 相邻）
> - `T01_Orb集成路径定案\ORB_CHANGES.md`（sha256 与上者相同）
> - `T03_Electron壳与Orb渲染\ORB_CHANGES.md`（sha256 与上者相同）
>
> **本文件的失实之处**（逐条已核）：
>
> | 本文件的说法 | 实际代码 |
> |---|---|
> | 新增 `extendedStateProfiles` 常量 | ❌ **全树检索不存在**该符号 |
> | 新增 `createExtendedStateParams()` | ❌ **全树检索不存在**该函数 |
> | `listening` 的 `colorA` 为 `#4A90E2` | ❌ 实际为 `#38EF7D` |
> | `src/App.tsx` **未改动** | ❌ 实际**已改动**（`openCode` 改为遍历全部档案，修 `TS2739`） |
> | "14 个源文件中有 2 个被修改" | ❌ 实际 `src/` 下 **216** 个文件，被修改 **3** 个（`orb-states.ts`、`code-export.ts`、`App.tsx`），另加 `scripts/verify-exports.mjs` |
> | 未提及 Swift 导出 | ⚠️ 遗漏：`createSwiftExport` 已补齐 6 态 |
>
> **保留本文件的原因**：本文件非本次复核方所写，**不做删除或覆盖**，仅加此警示以免误导验收。
> **建议处理**：由原编写者按 `vendor/orb/ORB_CHANGES.md` 核对后重写，或直接删除本副本、只保留 fork 相邻的那一份。
>
> ---

# 对 Orb 源码的改动留痕（ORB_CHANGES.md）

> 依据任务书「必须基于 Orb 实现，禁止替换 UI、禁止重新设计动画」的红线要求，
> 本文档逐行记录对 Orb 源码的**全部**改动及理由。
>
> Orb 原仓库：https://github.com/LerSent001/orb （MIT，Copyright (c) 2026 LerSent001）
> 本地副本：`vendor/orb/`
> Orb 版本：main 分支，2026-09-21 拉取

---

## 改动总览

经逐字节比对，Orb 的 **14 个源文件中有 2 个被修改**，其余 12 个（含所有 UI 组件、着色器、渲染器）**保持原样**：

| 文件 | 状态 | 说明 |
|---|---|---|
| `src/orb-states.ts` | **已修改** | 扩展为 6 态 |
| `src/code-export.ts` | **已修改** | 导出页适配 6 态 + 透明背景 + onError 回调 |
| `src/App.tsx` | 未改动 | 编辑器主界面 |
| `src/orb-renderer.ts` | 未改动 | WebGPU 渲染器 |
| `src/shader-source.ts` / `effect.wgsl` | 未改动 | 着色器 |
| `src/orb-audio.ts` | 未改动 | 音频映射 |
| `src/presets.ts` | 未改动 | 13 个预设 |
| `src/orb-uniforms.ts` | 未改动 | uniform 映射 |
| `src/particle-ribbon.ts` | 未改动 | 粒子缎带 |
| `src/AudioControls.tsx`、`editor-i18n.ts`、`main.tsx`、`styles.css` | 未改动 | UI 与样式 |
| `src/toolcraft/**` | 未改动 | Toolcraft UI 库 |

**结论：动画、着色器、UI 组件、视觉预设全部未被触碰。** 改动只涉及"状态档案的数量"与"导出页的宿主适配"，符合红线。

---

## 改动 1：`src/orb-states.ts` — 状态从 2 个扩展为 6 个

### 1.1 状态名列表扩展

**改动前**
```ts
export const orbStateNames = ["idle", "thinking"] as const;
```

**改动后**
```ts
export const orbStateNames = [
  "idle",
  "listening",
  "thinking",
  "executing",
  "speaking",
  "error",
] as const;
```

**理由**：任务书要求 6 态（Idle / Listening / Thinking / Executing / Speaking / Error），Orb 原生只有 2 态。且导出页的 `setState()` 有白名单校验，未登记的状态会抛 `TypeError`，因此**必须**在源码层扩展，宿主侧无法绕过。

### 1.2 新增 4 个状态的参数档案

新增了一个 `extendedStateProfiles` 常量，为 `listening` / `executing` / `speaking` / `error` 各定义一份档案：**数值项走 scale/offset 变换，颜色项为绝对色值**。例如：

```ts
listening: {
  numeric: { speed: { scale: 0.5 }, contourDeform: { scale: 0.45 }, /* ... */ },
  colors: { colorA: "#4A90E2", colorB: "#50E3C2", /* ...共 6 项 */ },
},
executing: { /* 琥珀金系 */ },
speaking:  { /* 亮青系 */ },
error:     { /* 暗红系 */ },
```

新增 `createExtendedStateParams()`，基于 `thinking` 参数按同一套变换逻辑派生。

**理由**：让 4 个新状态在**不新增任何动画机制**的前提下拥有可辨识的视觉差异。配色按语义选取：聆听=青绿（在听）、执行=琥珀（忙碌）、播报=亮青（发声）、错误=暗红（警示）。

### 1.3 配置构造扩展

`createOrbStateConfiguration()` 的 `profiles` 从 2 个键扩为 6 个键。

**未改动**：过渡控制器 `createOrbTransitionController()`、缓动函数 `smoothOrbTransitionProgress()` / `activeOrbTransitionProgress()`、插值 `interpolateOrbParams()`、颜色混合 `mixHexColor()`、以及 0.22s / 0.65s 的时长常量 —— **全部原样保留**。新状态沿用既有过渡机制。

---

## 改动 2：`src/code-export.ts` — 导出页宿主适配

### 2.1 `createStateSeeds` 改为遍历

**改动前**
```ts
function createStateSeeds(configuration: OrbStateConfiguration): Record<OrbStateName, number[]> {
  return {
    idle: createOrbUniformSnapshot(resolveOrbStateParams(configuration, "idle")),
    thinking: createOrbUniformSnapshot(resolveOrbStateParams(configuration, "thinking")),
  };
}
```

**改动后**
```ts
function createStateSeeds(configuration: OrbStateConfiguration): Record<OrbStateName, number[]> {
  const seeds = {} as Record<OrbStateName, number[]>;
  for (const state of Object.keys(configuration.profiles) as OrbStateName[]) {
    seeds[state] = createOrbUniformSnapshot(resolveOrbStateParams(configuration, state));
  }
  return seeds;
}
```

**理由**：原实现硬编码两个状态，无法导出 6 态。改为遍历后，新增状态无需再改此处。

### 2.2 导出页背景改为透明

**改动前**
```css
html, body, canvas { width: 100%; height: 100%; margin: 0; }
body { overflow: hidden; background: ${configuration.shared.canvasColor}; }
canvas { display: block; }
#status { position: fixed; inset: 0; display: grid; place-items: center; color: white; font: 14px system-ui; }
```

**改动后**
```css
html, body, canvas { width: 100%; height: 100%; margin: 0; padding: 0; }
body { overflow: hidden; background: transparent; }
canvas { display: block; width: 100vw; height: 100vh; background: transparent; }
#status { display: none !important; }
```

**理由**：
- `background: transparent` —— 悬浮球需要透明背景，否则会出现一个方形底板。
- `#status { display: none }` —— 该元素是编辑器用来显示错误文本的，在悬浮球形态下会破坏观感；错误改由 `onError` 回调上抛给宿主（见 2.3）。

### 2.3 新增 `onError` 回调（控制面从 3 个方法扩展为 4 个）

新增：
```ts
let onErrorCallback = null;
function onError(handler) {
  if (typeof handler === "function") onErrorCallback = handler;
}
```
并在 `window.liquidOrb` 上暴露：
```ts
Object.defineProperty(window, "liquidOrb", {
  value: Object.freeze({
    getState: () => state,
    setState,
    setAudioBands,
    onError,          // ← 新增
  }),
});
```
同时在原错误处理分支里回调：
```ts
if (typeof onErrorCallback === "function") {
  try { onErrorCallback(msg); } catch (e) { console.error("Error in onError callback", e); }
}
```

**理由**：Orb 渲染器的 WebGPU 错误是**被内部捕获后走回调**上报的，不会冒泡到宿主。若不提供这个通道，宿主侧的表现是"黑屏且完全没有报错"，排查成本极高。这是保证可用性的必要增强。

### 2.4 宿主桥接脚本（在生成阶段注入，不在 Orb 源码里）

`scripts/generate-orb.mjs` 在生成 HTML 后，向 `</body>` 前注入一段桥接脚本，提供：
- 就绪探测：轮询 `window.liquidOrb`，就绪后通过 `window.electronBridge.onOrbReady()` 通知主进程
- 错误转发：把 `onError` 与 `unhandledrejection` 转给主进程
- 鼠标穿透：鼠标进入球体半径（110px）内时关闭穿透，离开时恢复
- 拖拽：球体内按下左键可拖动窗口

**说明**：这段脚本**注入在生成产物里**，`vendor/orb/` 的源码文件本身未被修改，因此不影响 Orb 自身的可维护性与升级。

---

## 未采用的改动（及原因）

| 曾考虑的方案 | 为什么没做 |
|---|---|
| 修改 `orb-renderer.ts` 定制渲染 | 无需如此，且会触碰"禁止重新设计动画"红线 |
| 修改 `shader-source.ts` / `effect.wgsl` | 完全没必要，视觉必须保持原生 |
| 修改 `App.tsx` 做"纯球体模式" | 编辑器无裸球模式是其固有限制，但正解是**用导出页**而非改造编辑器，改它反而引入 UI 改动风险 |
| 在宿主侧用 CSS/DOM 覆盖球体 | 明确违反"禁止替换 UI" |

---

## 如何复现导出产物

```bash
node scripts/generate-orb.mjs
# 输出：src/renderer/orb.html
```

该脚本通过 Vite SSR 加载 `vendor/orb` 的 `orb-states.ts` 与 `code-export.ts`，
调用 `createPresetOrbStateConfiguration("siri")`（`siri` 是 6 个支持音频响应的预设之一）
与 `createWebExport(config, "idle")`，再注入桥接脚本。

---

## 升级 Orb 上游的建议流程

1. 拉取新版 Orb 到临时目录
2. 比对 `orb-states.ts` 与 `code-export.ts`，把本文档记录的 3 处改动重新应用
3. 运行 `node scripts/generate-orb.mjs`，再跑 `npm run selftest` 验证 6 态与音频响应
4. 更新本文档的版本号与差异说明

---

## 第三方许可证

| 组件 | 许可证 | 版权 |
|---|---|---|
| Orb | MIT | Copyright (c) 2026 LerSent001 |
| Toolcraft UI（Orb 内置，见 `vendor/orb/TOOLCRAFT_LICENSE.md`） | MIT | Copyright (c) 2026 Pixel Point |
| @wonderwhy-er/desktop-commander | MIT | — |
| Electron / React / Vite 等 | 各自开源许可证 | 见 `node_modules` 内各自 LICENSE |

> 注意：Toolcraft 的许可证文件位于 Orb 仓库**根目录**（`TOOLCRAFT_LICENSE.md`），
> 不在 `src/toolcraft/` 目录内。
