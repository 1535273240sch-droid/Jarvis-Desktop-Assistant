import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const vendorOrbRoot = resolve(projectRoot, "vendor/orb");
const outputPath = resolve(projectRoot, "src/renderer/orb.html");

const vitePath = resolve(vendorOrbRoot, "node_modules/vite/dist/node/index.js");
const { createServer } = await import(pathToFileURL(vitePath).href);

console.log("[Generate Orb] Initializing Vite SSR context from vendor/orb...");

const server = await createServer({
  root: vendorOrbRoot,
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true, ws: false },
});

try {
  const [orbStates, orbUniforms, codeExport, audioTuning, orbPresets] = await Promise.all([
    server.ssrLoadModule("/src/orb-states.ts"),
    server.ssrLoadModule("/src/orb-uniforms.ts"),
    server.ssrLoadModule("/src/code-export.ts"),
    server.ssrLoadModule("/src/orb-audio-tuning.ts"),
    server.ssrLoadModule("/src/presets.ts"),
  ]);
  const styleFlowIndexes = orbPresets.styleFlowIndexes;

  // 选择支持音频响应的 siri 预设
  const config = orbStates.createPresetOrbStateConfiguration("siri");
  // 生成以 idle 为初始态的 6 态导出页
  let html = codeExport.createWebExport(config, "idle");

  // 强化音频波纹动感与涟漪算法。
  //
  // 实测反馈：说话与播报时球体的动态「不够明显、观感不好」。原因是原参数
  // 对频段能量的放大倍数偏保守，正常说话音量下形变很小。这里整体加大
  // 加法项(additive)与比例项(proportional)，并同步抬高 ceiling，
  // 让同样一段语音产生明显得多的表面撕裂、外轮廓涟漪与流场流动。
  //
  // 放大值集中声明在 vendor/orb/src/orb-audio-tuning.ts（宿主侧构建期参数），
  // 本脚本不再硬编码字面量：导出模板会把 audioRules / audioFlowStrengths
  // 序列化成 `const audioRules = [...];` / `const audioFlowStrengths = {...};`
  // 形式的文本，用正则整段定位并替换即可（结构化替换，不依赖上游具体数值），
  // 因此上游改模板数值也不会让构建失败。
  //
  // 各索引含义见 vendor/orb/src/orb-audio.ts 的 audioRules 注释：
  //   [uniformIndex, 频段, 加法量, 比例量, 上限]
  //   3  = 全局形变强度     6  = 中频表面撕裂    7  = 低频轮廓涟漪
  //   21 = 低频流场扭曲     10 = 高频细节抖动    14 = 全局流场强度
  const audioRulesPattern = /const audioRules = \[\[[\s\S]*?\]\];/;
  if (!audioRulesPattern.test(html)) {
    throw new Error(
      "未能在导出模板中定位 audioRules 数组字面量，请核对 vendor/orb 的 code-export/orb-audio 输出"
    );
  }
  // 幂等：无论产物是上游原值还是已放大值，正则都能匹配并写入放大值。
  html = html.replace(
    audioRulesPattern,
    `const audioRules = ${JSON.stringify(audioTuning.amplifiedAudioRules)};`
  );

  // audioFlowStrengths（音频强度表）在下面「多主题」之后注入：它需要按每个主题的
  // 基准值做归一化，而主题表要到那一步才构建完成。

  // —— 多主题注入 ——
  //
  // 用户提供的 5 套主题快照（scripts/orb-themes.json，来自 orb 编辑器导出，
  // 只含 idle/thinking 两态、136 floats/态）。其余 4 个状态沿用 vendor 的
  // 状态推导规则补齐（listening/executing/speaking/error 的颜色是全局固定
  // 语义色——绿/琥珀/青/红，主题个性由 idle/thinking 承载），数值以用户
  // 导出为准覆盖。
  //
  // 运行时通过 app://orb/orb.html?theme=<styleId> 选择主题；无参数回落 siri。
  const USER_THEMES = JSON.parse(await readFile(resolve(projectRoot, "scripts/orb-themes.json"), "utf-8"));

  // profile 数值键 -> uniform 数组下标（布局见 vendor/orb/src/orb-uniforms.ts writeOrbUniforms）
  const PROFILE_NUMERIC_INDEX = {
    speed: 3, zoom: 5, warp: 6, ridgeAmt: 7, sharp: 8, shade: 9, exposure: 14,
    edgeGlow: 17, contourDeform: 21, bandDensity: 22, chromaticShift: 23,
    metalStretch: 25, metalEvolution: 29, metalRoughness: 30, metalDepth: 31,
    ribbonWidth: 34, ribbonTwist: 35, ribbonFold: 36, ribbonBreath: 37,
  };
  // 颜色键 -> uniform 数组起始下标（每色 4 floats: r,g,b,a）
  const PROFILE_COLOR_OFFSET = {
    colorA: 40, colorB: 44, colorC: 48, colorD: 52, highlightColor: 56, glowColor: 84,
  };
  const floatsToHex = (arr, off) => {
    const h = (v) => Math.max(0, Math.min(255, Math.round(Number(v) * 255))).toString(16).padStart(2, "0");
    return `#${h(arr[off])}${h(arr[off + 1])}${h(arr[off + 2])}`.toUpperCase();
  };

  const seedMatch = html.match(/^([ \t]*)const stateSeeds = (\{.*\});[ \t]*$/m);
  if (!seedMatch) throw new Error("未能定位 stateSeeds 行——上游 orb 导出模板可能已变更");

  const themeTable = { siri: JSON.parse(seedMatch[2]) };
  for (const t of USER_THEMES) {
    const baseCfg = orbStates.createPresetOrbStateConfiguration(t.style);
    const thinkingParams = orbStates.resolveOrbStateParams(baseCfg, "thinking");
    // 用用户导出的 thinking 快照覆盖 profile（保证与导出观感完全一致）
    const overrides = {};
    for (const [key, idx] of Object.entries(PROFILE_NUMERIC_INDEX)) overrides[key] = t.thinking[idx];
    for (const [key, off] of Object.entries(PROFILE_COLOR_OFFSET)) overrides[key] = floatsToHex(t.thinking, off);
    const cfg = orbStates.createOrbStateConfiguration({ ...thinkingParams, ...overrides });
    // idle 同样以用户导出为准（idle 原本由 thinking 推导，这里保用户的数值）
    const idleOverrides = {};
    for (const [key, idx] of Object.entries(PROFILE_NUMERIC_INDEX)) idleOverrides[key] = t.idle[idx];
    for (const [key, off] of Object.entries(PROFILE_COLOR_OFFSET)) idleOverrides[key] = floatsToHex(t.idle, off);
    cfg.profiles.idle = { ...cfg.profiles.idle, ...idleOverrides };

    // 让主题的调色板贯穿「全部」状态。
    //
    // 背景：vendor 的 listening / executing / speaking / error 四个 profile 里**硬编码了
    // 固定语义色**（speaking = #00E5FF 青、listening = 绿、executing = 琥珀、error = 红），
    // 于是换上任何主题，一进入说话状态球体就变回青色，主题身份丢失
    //（用户反馈：「主题是什么颜色，它现在是什么颜色」不一致）。
    // 这里在构建期把这四个状态的颜色也覆盖成主题自己的调色板 —— **只覆盖颜色**，
    // 各状态的运动特征（speed / warp / contourDeform / edgeGlow …）保持原样，
    // 状态之间的区分改由「动感强弱 + 亮度」承载。vendored 运行时不改，
    // 覆盖只发生在宿主构建期（与音频放大参数的注入方式一致）。
    const themeColorPatch = {};
    for (const [key, off] of Object.entries(PROFILE_COLOR_OFFSET)) {
      themeColorPatch[key] = floatsToHex(t.thinking, off);
    }
    for (const n of orbStates.orbStateNames) {
      if (n === "idle" || n === "thinking") continue;
      cfg.profiles[n] = { ...cfg.profiles[n], ...themeColorPatch };
    }
    themeTable[t.style] = Object.fromEntries(
      orbStates.orbStateNames.map((n) => [n, orbUniforms.createOrbUniformSnapshot(orbStates.resolveOrbStateParams(cfg, n))])
    );
    console.log(`[Generate Orb] theme injected: ${t.style} (${t.name})`);
  }

  // 默认主题（siri）同样处理：它在导出模板里自带 6 态种子，其中那 4 个状态同样是固定
  // 语义色。若只改导入主题，就会出现「默认主题会随状态变色、其它主题反而不变」的新不一致。
  // 这里用 siri 自己的 thinking 调色板覆盖那 4 个状态的颜色，规则与导入主题完全一致。
  const siriStates = themeTable.siri;
  if (siriStates && siriStates.thinking) {
    for (const n of Object.keys(siriStates)) {
      if (n === "idle" || n === "thinking") continue;
      for (const off of Object.values(PROFILE_COLOR_OFFSET)) {
        for (let k = 0; k < 4; k++) siriStates[n][off + k] = siriStates.thinking[off + k];
      }
    }
    console.log("[Generate Orb] 默认主题 siri 的 4 个状态颜色也已对齐到自身调色板");
  }

  html = html.replace(
    seedMatch[0],
    `${seedMatch[1]}const __ORB_THEMES = ${JSON.stringify(themeTable)};\n` +
      `${seedMatch[1]}const stateSeeds = (() => { try { const t = new URLSearchParams(location.search).get("theme"); ` +
      `if (t && Object.prototype.hasOwnProperty.call(__ORB_THEMES, t)) return __ORB_THEMES[t]; } catch {} ` +
      `return __ORB_THEMES.siri; })();`
  );
  console.log(`[Generate Orb] themes embedded: ${Object.keys(themeTable).join(", ")}`);

  // —— 音频强度表：逐索引约束，保证「不超过默认主题」——
  //
  // 真机实测发现的问题：放大规则（比例项 2.6）把形变放大约 6.4 倍。各主题的放大倍数
  // 相近，但**基准值差别很大**，于是绝对值天差地别：
  //   siri  speaking 的 v3（全局形变强度）基准 0.94 → 施加后 6.8（观感正常）
  //   frost speaking 的 v3 基准 2.55 → 施加后顶到上限 14 → 表面撕裂成斑块（观感崩坏）
  // 更隐蔽的是：只按某一个索引（如 v3）对齐还不够 —— 那会把 v3 基准小的主题
  // （refractiveBlob / particleRibbon）强度**调高**，导致曝光(v14)、涟漪(v7)等其它
  // 索引反而超过默认主题，出现整片过曝（实测确实发生）。
  //
  // 因此规则取「逐索引上限的最小值」：对每条音频规则 i，解出使本主题响应恰好等于
  // 默认主题响应的强度，再取所有索引中的最小值：
  //   v_base*(1 + p*level) + a*level = target_i（默认主题在同频段下的响应）
  //   level = (target_i - v_base) / (p*v_base + a)，strength_i = level / REF_BAND
  //   strength = min_i(strength_i)
  // 效果：每个受控索引的响应都**不超过**默认主题，即「至少不会比默认主题更夸张」。
  // 结果与默认主题的强度一起写进 audioFlowStrengths（按流场索引），运行时查表即可。
  // 参考频段能量：说话/播报时的典型峰值（按各规则自己的频段取值）
  const REF_BANDS = { all: 0.8, mid: 0.7, low: 0.9, high: 0.5 };
  const siriFlowIndex = styleFlowIndexes.siri;
  const siriStrength = Number(audioTuning.amplifiedAudioFlowStrengths[String(siriFlowIndex)]);
  const responseOf = (base, rule, strength) => {
    const [, band, additive, proportional] = rule;
    const level = (REF_BANDS[band] ?? 0.8) * strength;
    return base * (1 + proportional * level) + additive * level;
  };
  const siriSeed = themeTable.siri.speaking;
  /** 逐索引算出「该主题响应恰好等于默认主题」的强度；取最小值即为不超默认的上限 */
  const strengthCapsFor = (seed) =>
    audioTuning.amplifiedAudioRules.map((rule) => {
      const [idx, band, additive, proportional] = rule;
      const base = Number(seed[idx]);
      const target = responseOf(Number(siriSeed[idx]), rule, siriStrength);
      const denom = proportional * base + additive;
      if (denom <= 0) return siriStrength;
      const level = (target - base) / denom;
      if (level <= 0) return 0; // 基准已不低于默认主题的响应，没有余量
      return level / (REF_BANDS[band] ?? 0.8);
    });
  // 个别风格还要再收敛：particleRibbon（粒子丝带）靠海量叠加的半透明粒子/丝带绘制，
  // 本身就已经「半透明白」（实测基线近白像素 12.8%、饱和度仅 0.49）。形变会把它直接
  // 推向纯白：同样是 2.6 的强度，默认主题音频只增加 7.1% 近白像素，它却增加 37.9%。
  // 这类风格对形变的容忍度低得多，故额外乘以一个收敛系数。
  const STYLE_EXTRA_ATTENUATION = { particleRibbon: 0.2 };
  const themeStrengths = {};
  // 高光/玻璃类参数：gloss=11、shellMidAlpha=12、glassOpacity=20（布局见
  // vendor/orb/src/orb-uniforms.ts 的 writeOrbUniforms）。这三项越高，形变产生的陡梯度
  // 越容易把高光推到纯白。实测（同音量下统计球体像素）：
  //   siri          0.24/0.18/0.44 → 白像素 7%
  //   blueDrop      0.42/0.32/0.66 → 白像素 39%（各索引都已不超过默认主题，仍然过曝）
  //   refractiveBlob 0.52/0.42/0.82 → 白像素 45%，饱和度从 0.96 掉到 0.25
  // 所以再按这三项相对默认主题的几何平均收敛一次（1.5 次幂），且只降不升（上限 1）。
  const GLOW_KEYS = [11, 12, 20];
  const glowFactor = (seed) => {
    const ratios = GLOW_KEYS.map((i) => {
      const themeVal = Number(seed[i]);
      const siriVal = Number(siriSeed[i]);
      return themeVal > 0.001 ? siriVal / themeVal : 1;
    });
    const geo = Math.exp(ratios.reduce((sum, r) => sum + Math.log(r), 0) / ratios.length);
    return Math.min(1, Math.pow(geo, 1.5));
  };
  console.log(
    `[Generate Orb] 音频强度约束：默认主题强度 ${siriStrength}；先按「所有受控索引不超过默认主题」取上限，再按高光参数收敛`
  );

  for (const t of USER_THEMES) {
    const caps = strengthCapsFor(themeTable[t.style].speaking);
    const cap = Math.min(...caps);
    const factor = glowFactor(themeTable[t.style].speaking);
    const styleFactor = STYLE_EXTRA_ATTENUATION[t.style] ?? 1;
    // 夹到合理区间：既不能为 0（那等于没有动态），也不能超过默认主题的上限
    const strength = Number(Math.max(0.25, Math.min(3, cap * factor * styleFactor)).toFixed(3));
    themeStrengths[styleFlowIndexes[t.style]] = strength;
    console.log(
      `[Generate Orb] 音频强度 ${t.style}: ${strength}` +
        `（索引上限 ${cap.toFixed(2)} × 高光收敛 ${factor.toFixed(2)} × 风格收敛 ${styleFactor}）`
    );
  }

  const audioFlowPattern = /const audioFlowStrengths = \{[^}]*\};/;
  if (!audioFlowPattern.test(html)) {
    throw new Error(
      "未能在导出模板中定位 audioFlowStrengths 对象字面量，请核对 vendor/orb 的 code-export/orb-audio 输出"
    );
  }
  const audioFlowMap = { ...audioTuning.amplifiedAudioFlowStrengths, ...themeStrengths };
  html = html.replace(audioFlowPattern, `const audioFlowStrengths = ${JSON.stringify(audioFlowMap)};`);
  console.log(`[Generate Orb] audioFlowStrengths: ${JSON.stringify(audioFlowMap)}`);


  // 注入宿主桥接脚本（就绪通知、onError 回调捕获、鼠标穿透交互与拖拽支持）
  const bridgeScript = `
  <script>
    // 宿主通信与交互扩展
    (function() {
      let isReadyReported = false;
      let isInsideOrb = false;
      // 命中半径按窗口尺寸推导（比例 0.42，260px 窗口时约 110px）。
      // 写死 110 会导致窗口放大后点击/拖动区域与球体视觉错位，故随尺寸同步。
      const ORB_RADIUS_RATIO = 0.42;
      let orbRadius = 110;

      function updateOrbRadius() {
        orbRadius = Math.min(window.innerWidth, window.innerHeight) * ORB_RADIUS_RATIO;
      }
      updateOrbRadius();
      window.addEventListener("resize", updateOrbRadius);
      // 主进程改窗口尺寸后会广播新尺寸；即使 resize 事件未触发也能及时刷新
      if (window.electronBridge && typeof window.electronBridge.onOrbSizeChanged === "function") {
        window.electronBridge.onOrbSizeChanged(updateOrbRadius);
      }

      function probeReady() {
        if (window.liquidOrb && typeof window.liquidOrb.getState === "function") {
          if (!isReadyReported) {
            isReadyReported = true;
            console.log("[Orb Bridge] window.liquidOrb is ready. Initial state:", window.liquidOrb.getState());
            if (window.electronBridge) {
              window.electronBridge.onOrbReady(window.liquidOrb.getState());
            }
            if (typeof window.liquidOrb.onError === "function") {
              window.liquidOrb.onError((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                console.error("[Orb Bridge Error Caught]", msg);
                if (window.electronBridge) {
                  window.electronBridge.onOrbError(msg);
                }
              });
            }
          }
        } else {
          setTimeout(probeReady, 30);
        }
      }
      probeReady();

      // 监听全局 WebGPU 异常
      window.addEventListener("unhandledrejection", (e) => {
        console.error("[Unhandled Rejection]", e.reason);
        if (window.electronBridge) {
          window.electronBridge.onOrbError(String(e.reason?.message || e.reason));
        }
      });

      // 鼠标区域检测（实现透明区域点击穿透，球体区域捕获鼠标）
      window.addEventListener("mousemove", (e) => {
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        const dist = Math.hypot(e.clientX - centerX, e.clientY - centerY);
        const inside = dist <= orbRadius;

        if (inside !== isInsideOrb) {
          isInsideOrb = inside;
          if (window.electronBridge) {
            window.electronBridge.setIgnoreMouseEvents(!inside);
          }
        }
      });

      window.addEventListener("mouseleave", () => {
        if (isInsideOrb) {
          isInsideOrb = false;
          if (window.electronBridge) {
            window.electronBridge.setIgnoreMouseEvents(true);
          }
        }
      });

      // 拖拽支持：在球体区域按住鼠标可拖动窗口
      let isDragging = false;
      let dragStartX = 0;
      let dragStartY = 0;

      window.addEventListener("mousedown", (e) => {
        if (e.button === 0 && isInsideOrb) {
          isDragging = true;
          dragStartX = e.screenX;
          dragStartY = e.screenY;
          if (window.electronBridge) {
            window.electronBridge.startDrag(e.screenX, e.screenY);
          }
        }
      });

      window.addEventListener("mouseup", () => {
        if (isDragging) {
          isDragging = false;
          if (window.electronBridge) {
            window.electronBridge.stopDrag();
          }
        }
      });
    })();
  </script>
`;

  // 在 </body> 标签前插入桥接脚本
  html = html.replace("</body>", `${bridgeScript}\n</body>`);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf-8");

  console.log(`[Generate Orb] Successfully exported Orb HTML to: ${outputPath}`);
} finally {
  await server.close();
}
