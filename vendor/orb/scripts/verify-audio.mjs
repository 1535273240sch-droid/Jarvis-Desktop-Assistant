import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const server = await createServer({ appType: "custom", logLevel: "error", server: { middlewareMode: true, ws: false } });
try {
  const [audio, presets, uniforms, states, exports] = await Promise.all([
    "orb-audio", "presets", "orb-uniforms", "orb-states", "code-export",
  ].map(name => server.ssrLoadModule(`/src/${name}.ts`)));
  await mkdir("output/audio-qa", { recursive: true });
  const nativeChecks = [];
  let nativeHelper = "";
  for (const style of presets.styleNames) {
    const config = states.createPresetOrbStateConfiguration(style);
    const web = exports.createWebExport(config, "thinking");
    const swift = exports.createSwiftExport(config, "thinking");
    const snippet = web.slice(web.indexOf("const audioRules ="), web.indexOf("function srgbToLinear"));
    const webApply = new Function(`${snippet}; return applyAudioUniforms;`)();
    nativeHelper = swift.slice(swift.indexOf("public struct LiquidOrbAudio"), swift.indexOf("public enum LiquidOrbState"));
    for (const state of ["idle", "thinking"]) {
      const seed = uniforms.createOrbUniformSnapshot(states.resolveOrbStateParams(config, state));
      for (const bands of [audio.silentBands(), { low: 1, mid: 0, high: 0, all: 0 }, { low: 0, mid: 1, high: 0, all: 0 }, { low: 0, mid: 0, high: 1, all: 0 }, { low: 1, mid: 0.7, high: 0.4, all: 0.8 }, { low: NaN, mid: Infinity, high: -1, all: 4 }]) {
        const actual = new Float32Array(seed), exported = new Float32Array(seed);
        audio.applyAudioUniforms(actual, bands);
        webApply(exported, bands);
        assert.deepEqual(actual, exported, `${style}/${state}: Web mismatch`);
        assert.ok([...actual].every(Number.isFinite));
        if (!audio.audioStyleStrengths[style] || Object.values(bands).every(v => v === 0)) {
          assert.deepEqual([...actual], seed, `${style}/${state}: unsupported or silence changed`);
        } else {
          assert.notDeepEqual([...actual], seed, `${style}/${state}: audio did not change uniforms`);
        }
        assert.deepEqual([...actual.slice(22)], seed.slice(22), "Audio changed palette/material settings");
        if (Object.values(bands).every(Number.isFinite)) {
          nativeChecks.push(`do { var values: [Float] = ${JSON.stringify(seed)}; applyOrbAudio(&values, LiquidOrbAudio(low: ${bands.low}, mid: ${bands.mid}, high: ${bands.high}, all: ${bands.all})); let expected: [Float] = ${JSON.stringify([...actual])}; for i in 0..<values.count { precondition(abs(values[i] - expected[i]) < 0.00001, "${style}/${state} Swift mismatch") } }`);
        }
      }
    }
    if (style === "siri") {
      await writeFile("output/audio-qa/export.html", web);
      await writeFile("output/audio-qa/LiquidOrb.swift", swift);
    }
  }
  await writeFile("output/audio-qa/native-check.swift", nativeHelper + nativeChecks.join("\n") + '\nprint("Swift audio parity passed")\n');
  console.log("Audio: all 13 presets × both states verified; six supported, seven unchanged; Web parity and invalid input checks passed.");
} finally { await server.close(); }
