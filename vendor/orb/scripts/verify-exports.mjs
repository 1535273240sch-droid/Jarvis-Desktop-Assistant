import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const server = await createServer({
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true, ws: false },
});

try {
  const [{ createSwiftExport, createWebExport }, presets, uniforms, shaderModule, orbStates] =
    await Promise.all([
      server.ssrLoadModule("/src/code-export.ts"),
      server.ssrLoadModule("/src/presets.ts"),
      server.ssrLoadModule("/src/orb-uniforms.ts"),
      server.ssrLoadModule("/src/shader-source.ts"),
      server.ssrLoadModule("/src/orb-states.ts"),
    ]);
  const [wgsl, metal, particlePreview, rendererSource, appSource] = await Promise.all([
    readFile(new URL("../effect.wgsl", import.meta.url), "utf8"),
    readFile(new URL("../effect.metal", import.meta.url), "utf8"),
    readFile(new URL("../src/assets/presets/particleRibbon.png", import.meta.url)),
    readFile(new URL("../src/orb-renderer.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  ]);
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  const sceneScaleMatch = styles.match(
    /\.orb-stage\[data-preview-mode="scene"\] \.orb-canvas,[\s\S]*?transform:\s*scale\(([\d.]+)\);/,
  );
  assert.ok(sceneScaleMatch, "场景画布缩放配置缺失");
  const sceneScale = Number(sceneScaleMatch[1]);
  assert.ok(
    presets.orbRadiusRange.max * sceneScale <= 1,
    "场景画布会裁掉最大半径球体的边缘参数",
  );

  function extractOpticalWeights(source, patterns, backend) {
    return Object.fromEntries(
      Object.entries(patterns).map(([name, pattern]) => {
        const match = source.match(pattern);
        assert.ok(match, `${backend}: ${name} 光学权重缺失`);
        return [name, match.slice(1).map(Number)];
      }),
    );
  }

  const wgslOpticalWeights = extractOpticalWeights(
    wgsl,
    {
      inner: /opticalRim \* u\.glassOpacity \* ([\d.]+)/,
      dispersion: /\* \(([\d.]+) \+ ([\d.]+) \* u\.shellEdgeAlpha\)/,
      key: /clamp\(u\.sheen, 0\.0, 2\.0\) \* ([\d.]+);/,
      fill: /clamp\(u\.sheen, 0\.0, 2\.0\) \* ([\d.]+);\n\s*col = glsOver\(col, u\.sheenColor/,
    },
    "WGSL",
  );
  const metalOpticalWeights = extractOpticalWeights(
    metal,
    {
      inner: /opticalRim \* u\.glassOpacity \* ([\d.]+)/,
      dispersion: /\* \(([\d.]+) \+ ([\d.]+) \* u\.shellEdgeAlpha\)/,
      key: /metal::clamp\(u\.sheen, 0\.0, 2\.0\) \* ([\d.]+);/,
      fill: /metal::clamp\(u\.sheen, 0\.0, 2\.0\) \* ([\d.]+);\n\s*col = glsOver\(col, u\.sheenColor/,
    },
    "Metal",
  );
  assert.deepEqual(metalOpticalWeights, wgslOpticalWeights, "WebGPU 与 Metal 光学权重不一致");
  assert.ok(wgslOpticalWeights.inner[0] >= 0.1, "玻璃底色权重过低，颜色控件不可见");
  assert.ok(wgslOpticalWeights.dispersion[0] >= 0.1, "色散底色权重过低，颜色控件不可见");
  assert.ok(wgslOpticalWeights.key[0] >= 1, "主高光权重过低，颜色控件不可见");
  assert.ok(wgslOpticalWeights.fill[0] >= 0.8, "辅高光权重过低，颜色控件不可见");
  assert.match(
    wgsl,
    /emissionOnly = u\.glassEnabled <= 0\.5 && \(s == 9 \|\| s == 14 \|\| s == 24\)/,
    "WGSL 无玻璃发光层分发缺失",
  );
  assert.match(
    metal,
    /emissionOnly = u\.glassEnabled <= 0\.5 && \(s == 9 \|\| s == 14 \|\| s == 24\)/,
    "Metal 无玻璃发光层分发缺失",
  );
  assert.match(wgsl, /fn glsFinishEmissionFluid\(/, "WGSL 发光层收尾函数缺失");
  assert.match(metal, /metal::float3 glsFinishEmissionFluid\(/, "Metal 发光层收尾函数缺失");
  assert.match(wgsl, /emissionCoverage = smoothstep\(0\.025, 0\.16, signal\)/);
  assert.match(metal, /emissionCoverage = metal::smoothstep\(0\.025, 0\.16, signal\)/);
  assert.match(wgsl, /emissionMask = mix\(smoothstep\(0\.08, 0\.25, energy \+ whiteCore \* 0\.12\)/);
  assert.match(metal, /emissionMask = metal::mix\(/);
  assert.match(
    shaderModule.orbShaderSource,
    /return vec4<f32>\(c\.rgb \* fit, c\.a \* fit\)/,
    "WebGPU 外层包装器必须保留球体着色器输出的 Alpha",
  );
  assert.doesNotMatch(
    shaderModule.orbShaderSource,
    /let alpha = select\(ballA/,
    "WebGPU 外层包装器不能重建不透明球体 Alpha",
  );
  assert.match(
    metal,
    /metal::float4\(_e2\.xyz \* fit, _e2\.w \* fit\)/,
    "Metal 外层包装器必须保留球体着色器输出的 Alpha",
  );
  assert.match(wgsl, /fn glsRefractiveBlobFluid\(/, "WGSL 折射软体流场缺失");
  assert.match(metal, /metal::float3 glsRefractiveBlobFluid\(/, "Metal 折射软体流场缺失");
  assert.match(
    wgsl,
    /fn glsRefractionNormal\([\s\S]*?if \(style != 23\)/,
    "WGSL 折射软体动态法线缺失",
  );
  assert.match(
    metal,
    /metal::float2 glsRefractionNormal\([\s\S]*?if \(style != 23\)/,
    "Metal 折射软体动态法线缺失",
  );

  assert.ok(presets.styleNames.length > 0, "至少需要一个预设");
  assert.equal(
    particlePreview.subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
    "量子丝带预览图必须是真实 PNG 文件",
  );
  assert.equal(particlePreview.readUInt32BE(16), 440, "量子丝带预览图宽度必须为 440");
  assert.equal(particlePreview.readUInt32BE(20), 330, "量子丝带预览图高度必须为 330");
  assert.match(
    appSource,
    /compactPreviewStyles = new Set<StyleName>\(\[[\s\S]*?"particleRibbon"/,
    "量子丝带预览图未使用统一的小球留白",
  );
  assert.equal(
    uniforms.orbUniformFloatCount,
    uniforms.orbColorOffset + 24 * 4,
    "uniform 缓冲区长度必须与标量参数和 24 组颜色精确匹配",
  );
  assert.equal(
    new Set(presets.styleNames).size,
    presets.styleNames.length,
    "预设名称不能重复",
  );

  function parseSwiftSeed(code, state) {
    // 状态名 → Swift 标识符（idle → Idle，listening → Listening，…）。
    // 不要写死 idle/thinking 两态：状态集已扩为 6 态。
    const name = state.charAt(0).toUpperCase() + state.slice(1);
    const match = code.match(
      new RegExp(`private let orb${name}UniformSeed: \\[Float\\] = \\[([\\s\\S]*?)\\]`),
    );
    assert.ok(match, `Swift ${state} uniform seed 缺失`);
    return match[1]
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map(Number);
  }

  for (const style of presets.styleNames) {
    const configuration = orbStates.createPresetOrbStateConfiguration(style);
    const thinkingParams = orbStates.resolveOrbStateParams(configuration, "thinking");
    const idleParams = orbStates.resolveOrbStateParams(configuration, "idle");
    // 覆盖 orbStateNames 的全部状态（当前 6 态），不写死两态。
    const expectedSeeds = Object.fromEntries(
      orbStates.orbStateNames.map((state) => [
        state,
        uniforms.createOrbUniformSnapshot(
          orbStates.resolveOrbStateParams(configuration, state),
        ),
      ]),
    );
    const webCode = createWebExport(configuration, "thinking");
    const swiftCode = createSwiftExport(configuration, "thinking");

    const webSeedsMatch = webCode.match(/const stateSeeds = (\{[^;]+\});/);
    assert.ok(webSeedsMatch, `${style}: Web 全状态 uniform seed 缺失`);
    const webSeeds = JSON.parse(webSeedsMatch[1]);
    const swiftSeeds = Object.fromEntries(
      orbStates.orbStateNames.map((state) => [state, parseSwiftSeed(swiftCode, state)]),
    );

    assert.deepEqual(
      thinkingParams,
      { style, ...presets.stylePresets[style] },
      `${style}: 思考态改变了原预设`,
    );
    const differingStateKeys = orbStates.orbStateProfileKeys.filter(
      (key) => idleParams[key] !== thinkingParams[key],
    );
    assert.ok(differingStateKeys.length > 0, `${style}: 空闲态与思考态没有视觉差异`);
    assert.ok(
      thinkingParams.speed >= idleParams.speed * 3,
      `${style}: 思考态速度没有形成明显差异`,
    );
    assert.ok(
      thinkingParams.exposure > idleParams.exposure,
      `${style}: 思考态亮度没有提高`,
    );
    const differingMotionKeys = orbStates.orbStateNumericKeys.filter(
      (key) => key !== "speed" && key !== "exposure" && idleParams[key] !== thinkingParams[key],
    );
    assert.ok(differingMotionKeys.length >= 3, `${style}: 思考态运动层次不足`);
    const differingColorKeys = orbStates.orbStateColorKeys.filter(
      (key) => idleParams[key] !== thinkingParams[key],
    );
    assert.equal(differingColorKeys.length, orbStates.orbStateColorKeys.length,
      `${style}: 思考态颜色变化不完整`);
    assert.equal(idleParams.edgeGlow, 0, `${style}: 空闲态默认外发光必须为 0`);
    assert.equal(thinkingParams.edgeGlow, 0, `${style}: 思考态默认外发光必须为 0`);

    for (const state of orbStates.orbStateNames) {
      assert.deepEqual(
        webSeeds[state],
        expectedSeeds[state],
        `${style}/${state}: Web 参数与编辑器不一致`,
      );
      assert.deepEqual(
        swiftSeeds[state],
        expectedSeeds[state],
        `${style}/${state}: Swift 参数与编辑器不一致`,
      );
      assert.equal(
        webSeeds[state].length,
        uniforms.orbUniformFloatCount,
        `${style}/${state}: uniform 长度错误`,
      );
      assert.equal(
        webSeeds[state][15],
        presets.styleFlowIndexes[style],
        `${style}/${state}: Web 分发索引错误`,
      );
      assert.equal(
        swiftSeeds[state][15],
        presets.styleFlowIndexes[style],
        `${style}/${state}: Swift 分发索引错误`,
      );
      assert.equal(webSeeds[state][19], 1, `${style}/${state}: Web 默认玻璃罩未开启`);
      assert.equal(swiftSeeds[state][19], 1, `${style}/${state}: Swift 默认玻璃罩未开启`);
    }

    const target = (state) => ({
      state,
      params: state === "thinking" ? thinkingParams : idleParams,
      activationDuration: configuration.activationDuration,
      transitionDuration: configuration.transitionDuration,
    });
    const cycle = orbStates.createOrbTransitionController(target("idle"));
    const activationStartedAt = 100;
    const activationStart = cycle.sample(target("thinking"), activationStartedAt);
    assert.deepEqual(activationStart, idleParams, `${style}: 进入思考态时没有从当前空闲画面开始`);
    const activationHalfwayAt = activationStartedAt + configuration.activationDuration * 500;
    const activationHalfway = cycle.sample(target("thinking"), activationHalfwayAt);
    assert.ok(
      activationHalfway.speed > idleParams.speed
        && activationHalfway.speed < thinkingParams.speed,
      `${style}: 空闲进入思考态的中间过程缺失`,
    );
    const activatedAt = activationStartedAt + configuration.activationDuration * 1000 + 1;
    const activated = cycle.sample(target("thinking"), activatedAt);
    assert.deepEqual(activated, thinkingParams, `${style}: 进入思考态后没有精确到达目标`);

    const settleStartedAt = activatedAt + 100;
    const settleStart = cycle.sample(target("idle"), settleStartedAt);
    assert.deepEqual(settleStart, thinkingParams, `${style}: 回到空闲态时产生数值跳变`);
    const settleHalfwayAt = settleStartedAt + configuration.transitionDuration * 500;
    const settleHalfway = cycle.sample(target("idle"), settleHalfwayAt);
    assert.ok(
      settleHalfway.speed > idleParams.speed && settleHalfway.speed < thinkingParams.speed,
      `${style}: 思考回落空闲态的中间过程缺失`,
    );
    const settledAt = settleStartedAt + configuration.transitionDuration * 1000 + 1;
    const settled = cycle.sample(target("idle"), settledAt);
    assert.deepEqual(settled, idleParams, `${style}: 回落结束后没有精确进入空闲态`);

    const reactivationStart = cycle.sample(target("thinking"), settledAt + 100);
    assert.deepEqual(reactivationStart, idleParams, `${style}: 第二次进入思考态没有从空闲画面开始`);
    const reactivated = cycle.sample(
      target("thinking"),
      settledAt + 101 + configuration.activationDuration * 1000,
    );
    assert.deepEqual(reactivated, thinkingParams, `${style}: 第二次进入思考态失败`);

    const interrupted = orbStates.createOrbTransitionController(target("thinking"));
    interrupted.sample(target("idle"), 100);
    const interruptedAt = 100 + configuration.transitionDuration * 500;
    const interruptedFrame = interrupted.sample(target("idle"), interruptedAt);
    const resumedFrame = interrupted.sample(target("thinking"), interruptedAt);
    assert.deepEqual(resumedFrame, interruptedFrame, `${style}: 中断回落时画面发生跳变`);
    const resumedThinking = interrupted.sample(
      target("thinking"),
      interruptedAt + configuration.activationDuration * 1000 + 1,
    );
    assert.deepEqual(resumedThinking, thinkingParams, `${style}: 回落中重新进入思考态失败`);

    assert.match(
      webCode,
      /fromUniforms = new Float32Array\(displayedUniforms\)[\s\S]*?transitionTargetState = nextState[\s\S]*?activeTransitionDuration = nextState === "thinking"[\s\S]*?\? activationDurationMs[\s\S]*?: settleDurationMs/,
      `${style}: Web 导出缺少双向状态过渡`,
    );
    assert.match(
      swiftCode,
      /fromUniforms = sampleTransition\(at: now\)[\s\S]*?transitionTargetState = state[\s\S]*?activeTransitionDuration = state == \.thinking[\s\S]*?\? orbActivationDuration[\s\S]*?: orbSettleDuration/,
      `${style}: Swift 导出缺少双向状态过渡`,
    );
    assert.match(
      webCode,
      /motionPhase \+= frameDelta \* Math\.max\(values\[3\], 0\)[\s\S]*?values\[2\] = motionPhase \/ Math\.max\(values\[3\], 0\.001\)/,
      `${style}: Web 导出未保持运动相位连续`,
    );
    assert.match(
      swiftCode,
      /motionPhase \+= frameDelta \* CFTimeInterval\(max\(uniforms\[3\], 0\)\)[\s\S]*?uniforms\[2\] = Float\(motionPhase \/ CFTimeInterval\(max\(uniforms\[3\], 0\.001\)\)\)/,
      `${style}: Swift 导出未保持运动相位连续`,
    );

    const webSeed = webSeeds.thinking;
    const swiftSeed = swiftSeeds.thinking;

    if (style === "refractiveBlob") {
      assert.ok(webSeed[20] >= 0.7, "折射软体默认折射强度不足");
      assert.ok(webSeed[12] >= 0.3, "折射软体默认折射带过窄");
      assert.ok(webSeed[11] >= 0.4, "折射软体默认色散不足");
    }

    if (style === "chromaticMetal") {
      const metalUniforms = [
        [22, "bandDensity", "重复次数"],
        [23, "chromaticShift", "RGB 分离"],
        [24, "metalScale", "图案缩放"],
        [25, "metalStretch", "纵横拉伸"],
        [26, "metalAngle", "流带角度"],
        [27, "metalOffset", "图案偏移"],
        [28, "metalPhase", "循环相位"],
        [29, "metalEvolution", "演化幅度"],
        [30, "metalRoughness", "表面粗糙度"],
        [31, "metalDepth", "金属深度"],
      ];
      for (const [index, key, label] of metalUniforms) {
        assert.ok(
          Math.abs(webSeed[index] - thinkingParams[key]) < 0.000001,
          `色差金属：${label}未写入 uniform`,
        );
        assert.match(wgsl, new RegExp(`\\b${key}:\\s+f32`), `WGSL 缺少 ${label} 参数`);
        assert.match(metal, new RegExp(`float ${key};`), `Metal 缺少 ${label} 参数`);
      }
      assert.match(wgsl, /let cycle = t \* 0\.46 \+ u\.metalPhase/, "WGSL 动画未使用循环相位");
      assert.match(metal, /float cycle = t \* 0\.46 \+ u\.metalPhase/, "Metal 动画未使用循环相位");
      assert.match(wgsl, /\+ cycle\n\s+\+ u\.metalOffset/, "WGSL 主流场缺少单向相位推进");
      assert.match(metal, /\+ cycle\n\s+\+ u\.metalOffset/, "Metal 主流场缺少单向相位推进");
      const loopDuration = (Math.PI * 2) / (0.46 * thinkingParams.speed);
      assert.ok(loopDuration >= 11.5 && loopDuration <= 13, "色差金属默认循环时长偏离参考视频");
    }

    if (style === "particleRibbon") {
      const ribbonUniforms = [
        [32, "particleDensity", "粒子密度"],
        [33, "ribbonCount", "丝带层数"],
        [34, "ribbonWidth", "丝带宽度"],
        [35, "ribbonTwist", "扭转强度"],
        [36, "ribbonFold", "折叠幅度"],
        [37, "ribbonBreath", "呼吸幅度"],
        [38, "particleSize", "粒子尺寸"],
        [39, "particleBloom", "粒子辉光"],
      ];
      for (const [index, key, label] of ribbonUniforms) {
        assert.ok(
          Math.abs(webSeed[index] - thinkingParams[key]) < 0.000001,
          `量子丝带：${label}未写入 uniform`,
        );
        assert.match(wgsl, new RegExp(`\\b${key}:\\s+f32`), `WGSL 缺少 ${label} 参数`);
        assert.match(metal, new RegExp(`float ${key};`), `Metal 缺少 ${label} 参数`);
      }
      assert.match(shaderModule.orbShaderSource, /fn ribbon_vs_main\(/, "WGSL 粒子顶点入口缺失");
      assert.match(shaderModule.orbShaderSource, /fn ribbon_fs_main\(/, "WGSL 粒子片元入口缺失");
      assert.match(
        shaderModule.orbShaderSource,
        /canvasParticleScale = clamp\(minSize \/ 640\.0, 0\.22, 1\.0\)/,
        "WGSL 粒子尺寸未适配小画布",
      );
      assert.match(
        shaderModule.orbShaderSource,
        /@group\(0\) @binding\(1\) var ribbonTexture: texture_2d<f32>/,
        "WGSL 粒子离屏纹理绑定缺失",
      );
      assert.match(
        shaderModule.orbShaderSource,
        /fn ribbon_composite_fs_main\([\s\S]*?refractedP = p - normal \* refractionAmount/,
        "WGSL 玻璃复合入口未使用法线折射",
      );
      assert.match(
        shaderModule.orbShaderSource,
        /textureSampleLevel[\s\S]*?redSample[\s\S]*?greenSample[\s\S]*?blueSample/,
        "WGSL 玻璃复合未执行 RGB 色散采样",
      );
      assert.match(wgsl, /particleGlassOverlay = s == 24/, "WGSL 粒子玻璃覆盖层缺失");
      assert.match(metal, /vertex ribbon_vs_mainOutput ribbon_vs_main\(/, "Metal 粒子顶点入口缺失");
      assert.match(metal, /fragment ribbon_fs_mainOutput ribbon_fs_main\(/, "Metal 粒子片元入口缺失");
      assert.match(
        metal,
        /canvasParticleScale = metal::clamp\(minSize \/ 640\.0, 0\.22, 1\.0\)/,
        "Metal 粒子尺寸未适配小画布",
      );
      assert.match(
        metal,
        /metal::texture2d<float> ribbonTexture \[\[texture\(0\)\]\]/,
        "Metal 粒子离屏纹理绑定缺失",
      );
      assert.match(
        metal,
        /fragment ribbon_composite_fs_mainOutput ribbon_composite_fs_main\([\s\S]*?refractedP = p - normal \* refractionAmount/,
        "Metal 玻璃复合入口未使用法线折射",
      );
      assert.match(
        metal,
        /redSample = ribbonTexture\.sample[\s\S]*?greenSample = ribbonTexture\.sample[\s\S]*?blueSample = ribbonTexture\.sample/,
        "Metal 玻璃复合未执行 RGB 色散采样",
      );
      assert.match(metal, /particleGlassOverlay = s == 24/, "Metal 粒子玻璃覆盖层缺失");
      assert.ok(
        idleParams.ribbonBreath < thinkingParams.ribbonBreath,
        "量子丝带空闲态呼吸幅度应低于思考态",
      );
      assert.ok(
        idleParams.ribbonFold < thinkingParams.ribbonFold,
        "量子丝带空闲态折叠幅度应低于思考态",
      );
      assert.match(
        webCode,
        /usage: GPUTextureUsage\.RENDER_ATTACHMENT \| GPUTextureUsage\.TEXTURE_BINDING/,
        "Web 导出未创建可采样的粒子离屏纹理",
      );
      assert.match(
        webCode,
        /particlePass\.draw\(6, ribbonInstanceCount\)[\s\S]*?pass\.setPipeline\(ribbonCompositePipeline\)/,
        "Web 导出未先渲染粒子纹理再执行玻璃复合",
      );
      assert.match(
        swiftCode,
        /descriptor\.usage = \[\.renderTarget, \.shaderRead\]/,
        "Swift 导出未创建可采样的粒子离屏纹理",
      );
      assert.match(
        swiftCode,
        /vertexCount: 6,[\s\S]*?instanceCount: orbRibbonInstanceCount[\s\S]*?encoder\.setRenderPipelineState\(isParticleRibbon \? ribbonCompositePipeline : pipeline\)[\s\S]*?encoder\.setFragmentTexture\(ribbonTexture, index: 0\)/,
        "Swift 导出未先渲染粒子纹理再执行玻璃复合",
      );
      assert.doesNotMatch(shaderModule.orbShaderSource, /lensParticle/, "WGSL 仍残留粒子副像伪折射");
      assert.doesNotMatch(metal, /lensParticle/, "Metal 仍残留粒子副像伪折射");
    }

    const webShaderMatch = webCode.match(/^    const shaderSource = (.+);$/m);
    assert.ok(webShaderMatch, `${style}: Web shader 源码缺失`);
    assert.equal(JSON.parse(webShaderMatch[1]), shaderModule.orbShaderSource);
    const webScriptMatch = webCode.match(/<script type="module">([\s\S]*?)<\/script>/);
    assert.ok(webScriptMatch, `${style}: Web 运行脚本缺失`);
    assert.doesNotThrow(() => new Function(webScriptMatch[1]), `${style}: Web 运行脚本语法错误`);

    const swiftMetalMatch = swiftCode.match(
      /private let orbMetalSource = #"""\n([\s\S]*?)\n"""#/,
    );
    assert.ok(swiftMetalMatch, `${style}: Swift Metal 源码缺失`);
    assert.equal(swiftMetalMatch[1], metal, `${style}: Swift Metal 源码失真`);
    assert.match(swiftCode, /view\.isOpaque = false/, `${style}: Swift iOS 透明视图配置缺失`);
    assert.match(swiftCode, /view\.layer\?\.isOpaque = false/, `${style}: Swift macOS 透明图层配置缺失`);
    assert.match(swiftCode, /alpha: 0/, `${style}: Swift 透明清屏配置缺失`);
    assert.match(
      swiftCode,
      /sourceRGBBlendFactor = \.one/,
      `${style}: Swift 未使用预乘 Alpha 混合`,
    );

    const flowIndex = presets.styleFlowIndexes[style];
    assert.match(wgsl, new RegExp(`style == ${flowIndex}\\b`), `${style}: WGSL 分支缺失`);
    assert.match(metal, new RegExp(`style == ${flowIndex}\\b`), `${style}: Metal 分支缺失`);
    assert.match(webCode, /device\.lost\.then/, `${style}: Web 设备丢失处理缺失`);
    assert.match(webCode, /uncapturederror/, `${style}: Web GPU 错误处理缺失`);
    assert.match(webCode, /setState\(nextState\)/, `${style}: Web 状态 API 缺失`);
    assert.match(webCode, /hasOwnProperty\.call\(stateSeeds, nextState\)/, `${style}: Web 状态 API 边界校验缺失`);
    assert.match(swiftCode, /public enum LiquidOrbState/, `${style}: Swift 状态类型缺失`);
    assert.match(swiftCode, /public init\(state: LiquidOrbState = \.thinking\)/, `${style}: Swift 初始状态不一致`);
  }

  assert.match(
    rendererSource,
    /motionPhase \+= frameDelta \* Math\.max\(values\[3\], 0\)[\s\S]*?values\[2\] = motionPhase \/ Math\.max\(values\[3\], 0\.001\)/,
    "编辑器状态切换没有保持运动相位连续",
  );

  const adjustedMetal = {
    style: "chromaticMetal",
    ...presets.stylePresets.chromaticMetal,
    speed: 1.17,
    bandDensity: 4.3,
    chromaticShift: 0.68,
    metalScale: 1.31,
    metalStretch: 0.74,
    metalAngle: -38,
    metalOffset: -0.27,
    metalPhase: 0.63,
    metalEvolution: 1.46,
    metalRoughness: 0.57,
    metalDepth: 0.81,
    colorA: "#DDE8E4",
  };
  let adjustedConfiguration = orbStates.createOrbStateConfiguration(adjustedMetal, 1.15);
  adjustedConfiguration = orbStates.updateOrbStateParam(
    adjustedConfiguration,
    "idle",
    "speed",
    0.31,
  );
  adjustedConfiguration = orbStates.updateOrbStateParam(
    adjustedConfiguration,
    "idle",
    "colorA",
    "#8296A0",
  );
  adjustedConfiguration = orbStates.updateOrbStateParam(
    adjustedConfiguration,
    "idle",
    "radius",
    0.81,
  );
  const adjustedExpected = Object.fromEntries(
    orbStates.orbStateNames.map((state) => [
      state,
      uniforms.createOrbUniformSnapshot(
        orbStates.resolveOrbStateParams(adjustedConfiguration, state),
      ),
    ]),
  );
  const adjustedWeb = createWebExport(adjustedConfiguration, "idle");
  const adjustedSwift = createSwiftExport(adjustedConfiguration, "idle");
  const adjustedWebMatch = adjustedWeb.match(/const stateSeeds = (\{[^;]+\});/);
  assert.ok(adjustedWebMatch, "调参后的 Web 全状态 uniform seed 缺失");
  const adjustedWebSeeds = JSON.parse(adjustedWebMatch[1]);
  for (const state of orbStates.orbStateNames) {
    assert.deepEqual(
      adjustedWebSeeds[state],
      adjustedExpected[state],
      `调参后的 Web ${state} 导出与编辑器不一致`,
    );
    assert.deepEqual(
      parseSwiftSeed(adjustedSwift, state),
      adjustedExpected[state],
      `调参后的 Swift ${state} 导出与编辑器不一致`,
    );
    assert.ok(
      Math.abs(adjustedExpected[state][4] - 0.81) < 0.000001,
      `共享半径没有同步到 ${state}`,
    );
  }
  assert.match(adjustedWeb, /let state = "idle";/, "Web 初始状态未匹配编辑器");
  assert.match(adjustedSwift, /public init\(state: LiquidOrbState = \.idle\)/, "Swift 初始状态未匹配编辑器");

  console.log(
    `Verified ${presets.styleNames.length} presets across ${orbStates.orbStateNames.length} states (${orbStates.orbStateNames.join("/")}): editor, WebGPU, and SwiftUI parameters are identical.`,
  );
} finally {
  await server.close();
}
