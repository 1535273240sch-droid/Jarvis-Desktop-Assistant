# 悬浮球 WebGPU 断连修复说明与待办

本文档对应 2026-09-28 的一次修复提交，记录**已修复的内容**、**验证到了什么程度**、
以及**尚未完成/需要在真机上继续确认的事项**。

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

| 文件 | 改动 |
|---|---|
| `vendor/orb/src/orb-renderer.ts` | 设备丢失/渲染异常改为**有限次指数退避重建**（5 次，0.5s 起、上限 8s）；每次重建**重新 `requestAdapter`**，避免复用失效引用；渲染恢复正常后重置退避计数；重试耗尽才上报宿主。`uncapturederror` 改为只记录、不上报。 |
| `vendor/orb/src/code-export.ts` | 同步上述全部改动。**这一步是必须的**：`src/renderer/orb.html` 由该文件生成，只改产物会被下次构建覆盖。 |
| `src/renderer/orb.html` | 同步上述全部改动（该文件是构建产物，已与生成器保持一致）。 |
| `src/main/ipc.ts` | 新增宿主侧兜底 `scheduleOrbRecovery()`：渲染器自身重试失败后，宿主重载球体页面（间隔 10s、最多 6 次）。就绪后清零计数。 |
| `scripts/generate-orb.mjs` | **顺带修复一处历史遗漏**：球体命中半径按窗口尺寸推导的逻辑（`ORB_RADIUS_RATIO` / `updateOrbRadius`）此前只存在于生成产物 `orb.html` 中，未回填生成器，下次构建会被静默覆盖回写死的 `110`。 |

### 设计上的分层

- **渲染器层**：只做约 15 秒的快速重试，覆盖瞬时抖动。
- **宿主层**：渲染器放弃后重载整个球体页面。GPU 进程被驱动复位/系统回收后，
  Chromium 重启它需要时间（本机实测约 60 秒），期间页面内怎么重建都拿不到 adapter，
  必须重载页面。宿主间隔 10s、最多 6 次，覆盖约 60 秒窗口。

## 四、验证到什么程度

**已验证（在已安装的 v1.4.24 上实测）：**

- 修复代码生效：设备断开时日志由原来的「永久停止」变为
  `WebGPU 设备已断开，正在重建：...`，并确实按退避策略重试。
- 三个文件的 JS 均通过 `node --check` 语法校验（含生成器重新生成的产物）。
- `app.asar` 重新打包后应用可正常启动、球体正常渲染。

**⚠️ 未完全验证（重要）：**

- **「能否最终自愈」没有在真实故障场景下确认。** 真实故障（设备每约 60 秒丢失一次）
  在我观察的时间窗内没有再复现，因此**无法断言**修复后一定能恢复出球体画面，
  只能确认「重试逻辑确实在跑」。
- **模拟测试不作为依据。** 我尝试用「杀掉 GPU 进程」来复现，但该模拟与真实故障的
  机制并不一致（真实故障是 `device.lost` 且 GPU 进程重启，模拟里页面本身的状态不同），
  模拟结果不能用来证明或否证修复效果。
- **`vendor/orb` 无法在本机重新构建**（缺 `node_modules`，且本机无 node/npm、
  winget 源已损坏），所以我**没有跑过官方的 `npm run build` 全流程**。
  CI 上会执行，届时请留意构建与两项回归测试是否通过。

## 五、待办事项

### P0 — 必须确认

- [ ] **在真机上持续观察**：球体再次断连时，是否能在约 60 秒内自动恢复出画面。
      这是本次修复的核心验收点，目前**尚未确认**。
      观察日志关键字：`球体已断开，正在重建` / `球体恢复重载成功`。
- [ ] **跑通 CI 构建**：合入后确认 `npm run build`、
      `verify-tools`、`verify-tasks` 全部通过（本机环境无法验证）。

### P1 — 建议排查（可能导致断连的更深层原因）

- [ ] **排查 GPU 进程为何每约 60 秒被回收/重启。**
      本机观察到 `device lost` 出现的时间点异常规律（多次都在启动后约 60 秒），
      这不像随机崩溃。可能方向：
  - 显卡驱动（本机 RTX 5060 + 驱动 `32.0.16.1052`）对 WebGPU/Dawn 的支持问题；
  - Electron 34 的 GPU 进程在该驱动下的稳定性；
  - 是否有其他组件（如 `checkWebGPU()` 自检会 `requestDevice()` 后立即
    `device.destroy()`）在运行期间干扰了同一渲染进程的 WebGPU 状态。
      若能定位并消除根因，本修复就只是一层保险。
- [ ] 确认 `orbController.checkWebGPU()` 的自检（`requestDevice` + `device.destroy`）
      是否在**与球体同一渲染进程**中执行、是否会对活跃的 WebGPU 设备造成干扰。
      它在启动自检和截图诊断路径上都会被调用。

### P2 — 改进项

- [ ] 渲染器的退避参数（当前 5 次 / 上限 8s）与宿主参数（6 次 / 间隔 10s）
      是**基于推断**设定的，未经过真机调优；确认真实恢复耗时后可再收敛。
- [ ] 考虑在球体恢复失败达到上限后，给用户一个**可见提示 + 手动重试入口**，
      而不是只写日志。
- [ ] `scripts/generate-orb.mjs` 中用字符串替换注入 `audioRules` /
      `audioFlowStrengths` 的方式比较脆弱（匹配不到就抛错）。
      可考虑改为从 `vendor/orb` 直接导出常量，减少模板字符串耦合。

---

## 六、附：本次改动涉及的文件

```
vendor/orb/src/orb-renderer.ts   渲染器：设备丢失后重建
vendor/orb/src/code-export.ts    生成器：同步修复（关键，防被覆盖）
scripts/generate-orb.mjs         生成器：补回命中半径随窗口尺寸推导
src/main/ipc.ts                  宿主：故障后重载球体页面兜底
src/renderer/orb.html            构建产物：同步以上改动
```

> 说明：`src/renderer/orb.html` 是**生成产物**。修改渲染逻辑时，
> 必须同时改 `vendor/orb/src/code-export.ts`（或 `orb-renderer.ts`），
> 否则下次 `npm run build` 会覆盖掉对产物的直接修改。
