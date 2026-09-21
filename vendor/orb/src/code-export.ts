import orbMetalSource from "../effect.metal?raw";
import { createOrbUniformSnapshot, orbColorOffset } from "./orb-uniforms";
import { particleRibbonInstanceCount } from "./particle-ribbon";
import { styleFlowIndexes } from "./presets";
import {
  orbStateNames,
  resolveOrbStateParams,
  type OrbStateConfiguration,
  type OrbStateName,
} from "./orb-states";
import { orbShaderSource } from "./shader-source";
import { audioRules, audioFlowStrengths } from "./orb-audio";

function formatSwiftFloats(values: number[]): string {
  const rows: string[] = [];
  for (let index = 0; index < values.length; index += 8) {
    rows.push(`    ${values.slice(index, index + 8).join(", ")},`);
  }
  return rows.join("\n");
}

/** 把状态名转成 Swift 标识符用的 PascalCase（idle → Idle，thinking → Thinking）。 */
function swiftStateIdentifier(state: OrbStateName): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function createStateSeeds(configuration: OrbStateConfiguration): Record<OrbStateName, number[]> {
  const seeds = {} as Record<OrbStateName, number[]>;
  for (const state of Object.keys(configuration.profiles) as OrbStateName[]) {
    seeds[state] = createOrbUniformSnapshot(resolveOrbStateParams(configuration, state));
  }
  return seeds;
}

export function createWebExport(
  configuration: OrbStateConfiguration,
  initialState: OrbStateName,
): string {
  const stateSeeds = createStateSeeds(configuration);
  const shaderLiteral = JSON.stringify(orbShaderSource);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:," />
  <title>Liquid Orb</title>
  <style>
    html, body, canvas { width: 100%; height: 100%; margin: 0; padding: 0; }
    body { overflow: hidden; background: transparent; }
    canvas { display: block; width: 100vw; height: 100vh; background: transparent; }
    #status { display: none !important; }
  </style>
</head>
<body>
  <canvas id="orb" aria-label="Animated liquid glass orb"></canvas>
  <div id="status" hidden></div>
  <script type="module">
    const shaderSource = ${shaderLiteral};
    const stateSeeds = ${JSON.stringify(stateSeeds)};
    const ribbonStyleIndex = ${styleFlowIndexes.particleRibbon};
    const ribbonInstanceCount = ${particleRibbonInstanceCount};
    const activationDurationMs = ${configuration.activationDuration * 1000};
    const settleDurationMs = ${configuration.transitionDuration * 1000};
    const canvas = document.querySelector("#orb");
    const status = document.querySelector("#status");
    let animationFrame = 0;
    let device = null;
    let ribbonTarget = null;
    let stopped = false;
    let state = ${JSON.stringify(initialState)};
    let transitionTargetState = state;
    let fromUniforms = new Float32Array(stateSeeds[state]);
    let targetUniforms = new Float32Array(stateSeeds[state]);
    const displayedUniforms = new Float32Array(stateSeeds[state]);
    let transitionStartedAt = 0;
    let activeTransitionDuration = 0;
    let lastFrameAt = null;
    let motionPhase = 0;
    const audioRules = ${JSON.stringify(audioRules)};
    const audioFlowStrengths = ${JSON.stringify(audioFlowStrengths)};
    function applyAudioUniforms(values, bands) {
      const strength = audioFlowStrengths[Math.round(values[15])] ?? 0;
      if (!strength) return;
      for (const [index, band, additive, proportional, ceiling] of audioRules) {
        const input = bands[band];
        const level = (Number.isFinite(input) ? Math.max(0, Math.min(1, input)) : 0) * strength;
        if (!level) continue;
        values[index] = Math.min(Math.max(ceiling, values[index]), values[index] * (1 + proportional * level) + additive * level);
      }
    }
    let audioBands = { low: 0, mid: 0, high: 0, all: 0 };
    // Feed normalized 0...1 bands from your audio analyser; zero them on stop.
    function setAudioBands(bands = {}) {
      audioBands = Object.fromEntries(["low", "mid", "high", "all"].map(key => [key,
        Number.isFinite(bands[key]) ? Math.max(0, Math.min(1, bands[key])) : 0]));
    }

    function srgbToLinear(value) {
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    }

    function linearToSrgb(value) {
      return value <= 0.0031308
        ? value * 12.92
        : 1.055 * value ** (1 / 2.4) - 0.055;
    }

    function mixSrgb(from, to, progress) {
      return linearToSrgb(
        srgbToLinear(from) + (srgbToLinear(to) - srgbToLinear(from)) * progress,
      );
    }

    function transitionProgress(now) {
      if (activeTransitionDuration === 0) return 1;
      const raw = Math.min(1, Math.max(0, (now - transitionStartedAt) / activeTransitionDuration));
      return transitionTargetState === "thinking"
        ? 1 - (1 - raw) ** 3
        : raw * raw * (3 - 2 * raw);
    }

    function sampleTransition(now) {
      const progress = transitionProgress(now);
      for (let index = 3; index < displayedUniforms.length; index += 1) {
        const colorComponent = index >= ${orbColorOffset}
          && (index - ${orbColorOffset}) % 4 < 3;
        displayedUniforms[index] = colorComponent
          ? mixSrgb(fromUniforms[index], targetUniforms[index], progress)
          : fromUniforms[index] + (targetUniforms[index] - fromUniforms[index]) * progress;
      }
      return displayedUniforms;
    }

    function setState(nextState) {
      if (!Object.prototype.hasOwnProperty.call(stateSeeds, nextState)) {
        throw new TypeError(\`Unknown liquid orb state: \${nextState}\`);
      }
      if (nextState === state) return;

      const now = performance.now();
      sampleTransition(now);
      fromUniforms = new Float32Array(displayedUniforms);
      targetUniforms = new Float32Array(stateSeeds[nextState]);
      transitionTargetState = nextState;
      transitionStartedAt = now;
      activeTransitionDuration = nextState === "thinking"
        ? activationDurationMs
        : settleDurationMs;
      state = nextState;
    }

    let onErrorCallback = null;
    function onError(handler) {
      if (typeof handler === "function") onErrorCallback = handler;
    }

    Object.defineProperty(window, "liquidOrb", {
      value: Object.freeze({
        getState: () => state,
        setState,
        setAudioBands,
        onError,
      }),
    });

    function stopWithError(error) {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(animationFrame);
      ribbonTarget?.destroy();
      device?.destroy();
      status.hidden = false;
      const msg = error instanceof Error ? error.message : String(error);
      status.textContent = msg;
      console.error(error);
      if (typeof onErrorCallback === "function") {
        try { onErrorCallback(msg); } catch (e) { console.error("Error in onError callback", e); }
      }
    }

    async function start() {
      if (!navigator.gpu) throw new Error("WebGPU is not supported in this environment.");
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error("No compatible WebGPU adapter was found.");
      device = await adapter.requestDevice();
      const context = canvas.getContext("webgpu");
      if (!context) throw new Error("Unable to create a WebGPU canvas context.");

      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: "premultiplied" });
      const shader = device.createShaderModule({ code: shaderSource });
      const compilation = await shader.getCompilationInfo();
      const errors = compilation.messages.filter((message) => message.type === "error");
      if (errors.length) {
        throw new Error(errors.map((message) => \`${"${message.lineNum}:${message.linePos} ${message.message}"}\`).join("\\n"));
      }

      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shader, entryPoint: "vs_main" },
        fragment: {
          module: shader,
          entryPoint: "fs_main",
          targets: [{
            format,
            blend: {
              color: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          }],
        },
        primitive: { topology: "triangle-list" },
      });
      const ribbonPipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shader, entryPoint: "ribbon_vs_main" },
        fragment: {
          module: shader,
          entryPoint: "ribbon_fs_main",
          targets: [{
            format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one", operation: "add" },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          }],
        },
        primitive: { topology: "triangle-list" },
      });
      const ribbonCompositePipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shader, entryPoint: "vs_main" },
        fragment: {
          module: shader,
          entryPoint: "ribbon_composite_fs_main",
          targets: [{
            format,
            blend: {
              color: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          }],
        },
        primitive: { topology: "triangle-list" },
      });
      const values = new Float32Array(displayedUniforms);
      const uniformBuffer = device.createBuffer({
        size: values.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
      });
      const ribbonBindGroup = device.createBindGroup({
        layout: ribbonPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
      });
      const ribbonSampler = device.createSampler({
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
      });
      let ribbonCompositeBindGroup = null;
      device.lost.then((info) => {
        stopWithError(new Error(\`WebGPU device lost: \${info.message || info.reason}\`));
      });
      device.addEventListener("uncapturederror", (event) => {
        event.preventDefault();
        stopWithError(new Error(\`WebGPU rendering error: \${event.error.message}\`));
      });

      function frame(now) {
        if (stopped) return;
        try {
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
          const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
            ribbonTarget?.destroy();
            ribbonTarget = null;
            ribbonCompositeBindGroup = null;
          }
          values.set(sampleTransition(now));
          const frameDelta = lastFrameAt === null
            ? 0
            : Math.min(0.1, Math.max(0, (now - lastFrameAt) / 1000));
          lastFrameAt = now;
          applyAudioUniforms(values, audioBands);
          motionPhase += frameDelta * Math.max(values[3], 0);
          values[0] = width;
          values[1] = height;
          values[2] = motionPhase / Math.max(values[3], 0.001);
          device.queue.writeBuffer(uniformBuffer, 0, values);

          const isParticleRibbon = Math.round(values[15]) === ribbonStyleIndex;
          const encoder = device.createCommandEncoder();
          if (isParticleRibbon) {
            if (!ribbonTarget || !ribbonCompositeBindGroup) {
              ribbonTarget = device.createTexture({
                size: { width, height },
                format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
              });
              ribbonCompositeBindGroup = device.createBindGroup({
                layout: ribbonCompositePipeline.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: { buffer: uniformBuffer } },
                  { binding: 1, resource: ribbonTarget.createView() },
                  { binding: 2, resource: ribbonSampler },
                ],
              });
            }
            const particlePass = encoder.beginRenderPass({
              colorAttachments: [{
                view: ribbonTarget.createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: "clear",
                storeOp: "store",
              }],
            });
            particlePass.setPipeline(ribbonPipeline);
            particlePass.setBindGroup(0, ribbonBindGroup);
            particlePass.draw(6, ribbonInstanceCount);
            particlePass.end();
          }
          const pass = encoder.beginRenderPass({
            colorAttachments: [{
              view: context.getCurrentTexture().createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            }],
          });
          if (isParticleRibbon) {
            pass.setPipeline(ribbonCompositePipeline);
            pass.setBindGroup(0, ribbonCompositeBindGroup);
          } else {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
          }
          pass.draw(3);
          pass.end();
          device.queue.submit([encoder.finish()]);
          animationFrame = requestAnimationFrame(frame);
        } catch (error) {
          stopWithError(error);
        }
      }

      animationFrame = requestAnimationFrame(frame);
    }

    window.addEventListener("pagehide", () => {
      stopped = true;
      cancelAnimationFrame(animationFrame);
      ribbonTarget?.destroy();
      device?.destroy();
    }, { once: true });
    start().catch((error) => {
      stopWithError(error);
    });
  </script>
</body>
</html>`;
}

export function createSwiftExport(
  configuration: OrbStateConfiguration,
  initialState: OrbStateName,
): string {
  const stateSeeds = createStateSeeds(configuration);
  const seedConstants = orbStateNames
    .map((state) => `private let orb${swiftStateIdentifier(state)}UniformSeed: [Float] = [
${formatSwiftFloats(stateSeeds[state])}
]`)
    .join("\n\n");
  const stateCases = orbStateNames.map((state) => `    case ${state}`).join("\n");
  const seedSwitch = orbStateNames
    .map((state) => `    case .${state}: orb${swiftStateIdentifier(state)}UniformSeed`)
    .join("\n");

  return `import Foundation
import MetalKit
import QuartzCore
import SwiftUI

private let orbMetalSource = #"""
${orbMetalSource}
"""#

${seedConstants}

private let orbActivationDuration: CFTimeInterval = ${configuration.activationDuration}
private let orbSettleDuration: CFTimeInterval = ${configuration.transitionDuration}
private let orbRibbonStyleIndex: Float = ${styleFlowIndexes.particleRibbon}
private let orbRibbonInstanceCount = ${particleRibbonInstanceCount}

// Supply normalized, smoothed frequency bands from your app's audio analyser.
public struct LiquidOrbAudio: Sendable {
    public var low: Float
    public var mid: Float
    public var high: Float
    public var all: Float
    public init(low: Float = 0, mid: Float = 0, high: Float = 0, all: Float = 0) {
        self.low = low; self.mid = mid; self.high = high; self.all = all
    }
}

private func applyOrbAudio(_ values: inout [Float], _ bands: LiquidOrbAudio) {
    let strengths: [Int: Float] = [${Object.entries(audioFlowStrengths).map(([key, value]) => `${key}: ${value}`).join(", ")}]
    guard let strength = strengths[Int(values[15].rounded())] else { return }
    func level(_ value: Float) -> Float { value.isFinite ? max(0, min(1, value)) * strength : 0 }
${audioRules.map(([index, band, additive, proportional, ceiling]) => `    if level(bands.${band}) > 0 { values[${index}] = min(max(${ceiling}, values[${index}]), values[${index}] * (1 + ${proportional} * level(bands.${band})) + ${additive} * level(bands.${band})) }`).join("\n")}
}

public enum LiquidOrbState: Sendable {
${stateCases}
}

private func orbUniformSeed(for state: LiquidOrbState) -> [Float] {
    switch state {
${seedSwitch}
    }
}

private func orbSrgbToLinear(_ value: Float) -> Float {
    value <= 0.04045
        ? value / 12.92
        : Float(pow(Double((value + 0.055) / 1.055), 2.4))
}

private func orbLinearToSrgb(_ value: Float) -> Float {
    value <= 0.0031308
        ? value * 12.92
        : 1.055 * Float(pow(Double(value), 1.0 / 2.4)) - 0.055
}

private func orbMixSrgb(_ from: Float, _ to: Float, _ progress: Float) -> Float {
    orbLinearToSrgb(
        orbSrgbToLinear(from) + (orbSrgbToLinear(to) - orbSrgbToLinear(from)) * progress
    )
}

private enum LiquidOrbError: Error {
    case metalUnavailable
    case shaderFunctionMissing(String)
    case commandQueueUnavailable
}

private final class LiquidOrbRenderer: NSObject, MTKViewDelegate {
    private let commandQueue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private let ribbonPipeline: MTLRenderPipelineState
    private let ribbonCompositePipeline: MTLRenderPipelineState
    private var ribbonTexture: MTLTexture?
    private var lastFrameAt = CACurrentMediaTime()
    private var motionPhase: CFTimeInterval = 0
    private var audio = LiquidOrbAudio()

    func setAudio(_ audio: LiquidOrbAudio) {
        stateLock.lock()
        self.audio = audio
        stateLock.unlock()
    }
    private let stateLock = NSLock()
    private var currentState: LiquidOrbState
    private var transitionTargetState: LiquidOrbState
    private var fromUniforms: [Float]
    private var targetUniforms: [Float]
    private var displayedUniforms: [Float]
    private var transitionStartedAt = CACurrentMediaTime()
    private var activeTransitionDuration: CFTimeInterval = 0

    init(view: MTKView, state: LiquidOrbState) throws {
        let initialUniforms = orbUniformSeed(for: state)
        currentState = state
        transitionTargetState = state
        fromUniforms = initialUniforms
        targetUniforms = initialUniforms
        displayedUniforms = initialUniforms

        guard let device = MTLCreateSystemDefaultDevice() else {
            throw LiquidOrbError.metalUnavailable
        }
        view.device = device
        view.colorPixelFormat = .bgra8Unorm
        view.framebufferOnly = true
        view.preferredFramesPerSecond = 60
        view.enableSetNeedsDisplay = false
        view.isPaused = false
        #if os(iOS)
        view.isOpaque = false
        #elseif os(macOS)
        view.layer?.isOpaque = false
        #endif
        view.clearColor = MTLClearColor(
            red: 0,
            green: 0,
            blue: 0,
            alpha: 0
        )

        let library = try device.makeLibrary(source: orbMetalSource, options: nil)
        guard let vertex = library.makeFunction(name: "vs_main") else {
            throw LiquidOrbError.shaderFunctionMissing("vs_main")
        }
        guard let fragment = library.makeFunction(name: "fs_main") else {
            throw LiquidOrbError.shaderFunctionMissing("fs_main")
        }
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = vertex
        descriptor.fragmentFunction = fragment
        descriptor.colorAttachments[0].pixelFormat = view.colorPixelFormat
        descriptor.colorAttachments[0].isBlendingEnabled = true
        descriptor.colorAttachments[0].sourceRGBBlendFactor = .one
        descriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
        descriptor.colorAttachments[0].sourceAlphaBlendFactor = .one
        descriptor.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
        pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        guard let ribbonVertex = library.makeFunction(name: "ribbon_vs_main") else {
            throw LiquidOrbError.shaderFunctionMissing("ribbon_vs_main")
        }
        guard let ribbonFragment = library.makeFunction(name: "ribbon_fs_main") else {
            throw LiquidOrbError.shaderFunctionMissing("ribbon_fs_main")
        }
        let ribbonDescriptor = MTLRenderPipelineDescriptor()
        ribbonDescriptor.vertexFunction = ribbonVertex
        ribbonDescriptor.fragmentFunction = ribbonFragment
        ribbonDescriptor.colorAttachments[0].pixelFormat = view.colorPixelFormat
        ribbonDescriptor.colorAttachments[0].isBlendingEnabled = true
        ribbonDescriptor.colorAttachments[0].sourceRGBBlendFactor = .one
        ribbonDescriptor.colorAttachments[0].destinationRGBBlendFactor = .one
        ribbonDescriptor.colorAttachments[0].sourceAlphaBlendFactor = .one
        ribbonDescriptor.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
        ribbonPipeline = try device.makeRenderPipelineState(descriptor: ribbonDescriptor)
        guard let ribbonCompositeFragment = library.makeFunction(
            name: "ribbon_composite_fs_main"
        ) else {
            throw LiquidOrbError.shaderFunctionMissing("ribbon_composite_fs_main")
        }
        let ribbonCompositeDescriptor = MTLRenderPipelineDescriptor()
        ribbonCompositeDescriptor.vertexFunction = vertex
        ribbonCompositeDescriptor.fragmentFunction = ribbonCompositeFragment
        ribbonCompositeDescriptor.colorAttachments[0].pixelFormat = view.colorPixelFormat
        ribbonCompositeDescriptor.colorAttachments[0].isBlendingEnabled = true
        ribbonCompositeDescriptor.colorAttachments[0].sourceRGBBlendFactor = .one
        ribbonCompositeDescriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
        ribbonCompositeDescriptor.colorAttachments[0].sourceAlphaBlendFactor = .one
        ribbonCompositeDescriptor.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
        ribbonCompositePipeline = try device.makeRenderPipelineState(
            descriptor: ribbonCompositeDescriptor
        )
        guard let queue = device.makeCommandQueue() else {
            throw LiquidOrbError.commandQueueUnavailable
        }
        commandQueue = queue
        super.init()
    }

    func setState(_ state: LiquidOrbState) {
        let now = CACurrentMediaTime()
        stateLock.lock()
        defer { stateLock.unlock() }
        guard state != currentState else { return }

        let nextUniforms = orbUniformSeed(for: state)
        fromUniforms = sampleTransition(at: now)
        targetUniforms = nextUniforms
        transitionTargetState = state
        transitionStartedAt = now
        activeTransitionDuration = state == .thinking
            ? orbActivationDuration
            : orbSettleDuration
        currentState = state
    }

    private func sampleTransition(at now: CFTimeInterval) -> [Float] {
        let rawProgress = activeTransitionDuration == 0
            ? 1
            : min(1, max(0, (now - transitionStartedAt) / activeTransitionDuration))
        let easedProgress = transitionTargetState == .thinking
            ? 1 - pow(1 - rawProgress, 3)
            : rawProgress * rawProgress * (3 - 2 * rawProgress)
        let progress = Float(easedProgress)

        for index in 3..<displayedUniforms.count {
            let isColorComponent = index >= ${orbColorOffset}
                && (index - ${orbColorOffset}) % 4 < 3
            displayedUniforms[index] = isColorComponent
                ? orbMixSrgb(fromUniforms[index], targetUniforms[index], progress)
                : fromUniforms[index] + (targetUniforms[index] - fromUniforms[index]) * progress
        }
        return displayedUniforms
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        ribbonTexture = nil
    }

    private func ensureRibbonTexture(for view: MTKView) -> MTLTexture? {
        let width = max(1, Int(view.drawableSize.width))
        let height = max(1, Int(view.drawableSize.height))
        if let ribbonTexture,
           ribbonTexture.width == width,
           ribbonTexture.height == height {
            return ribbonTexture
        }
        guard let device = view.device else { return nil }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: view.colorPixelFormat,
            width: width,
            height: height,
            mipmapped: false
        )
        descriptor.usage = [.renderTarget, .shaderRead]
        descriptor.storageMode = .private
        ribbonTexture = device.makeTexture(descriptor: descriptor)
        return ribbonTexture
    }

    func draw(in view: MTKView) {
        guard
            view.drawableSize.width > 0,
            view.drawableSize.height > 0,
            let descriptor = view.currentRenderPassDescriptor,
            let drawable = view.currentDrawable,
            let commandBuffer = commandQueue.makeCommandBuffer()
        else { return }

        let now = CACurrentMediaTime()
        stateLock.lock()
        var uniforms = sampleTransition(at: now)
        applyOrbAudio(&uniforms, audio)
        stateLock.unlock()
        let frameDelta = min(0.1, max(0, now - lastFrameAt))
        lastFrameAt = now
        motionPhase += frameDelta * CFTimeInterval(max(uniforms[3], 0))
        uniforms[0] = Float(view.drawableSize.width)
        uniforms[1] = Float(view.drawableSize.height)
        uniforms[2] = Float(motionPhase / CFTimeInterval(max(uniforms[3], 0.001)))
        let isParticleRibbon = round(uniforms[15]) == orbRibbonStyleIndex
        if isParticleRibbon {
            guard let ribbonTexture = ensureRibbonTexture(for: view) else { return }
            let ribbonPass = MTLRenderPassDescriptor()
            ribbonPass.colorAttachments[0].texture = ribbonTexture
            ribbonPass.colorAttachments[0].loadAction = .clear
            ribbonPass.colorAttachments[0].storeAction = .store
            ribbonPass.colorAttachments[0].clearColor = MTLClearColor(
                red: 0, green: 0, blue: 0, alpha: 0
            )
            guard let ribbonEncoder = commandBuffer.makeRenderCommandEncoder(
                descriptor: ribbonPass
            ) else { return }
            ribbonEncoder.setRenderPipelineState(ribbonPipeline)
            uniforms.withUnsafeBytes { bytes in
                ribbonEncoder.setVertexBytes(bytes.baseAddress!, length: bytes.count, index: 0)
                ribbonEncoder.setFragmentBytes(bytes.baseAddress!, length: bytes.count, index: 0)
            }
            ribbonEncoder.drawPrimitives(
                type: .triangle,
                vertexStart: 0,
                vertexCount: 6,
                instanceCount: orbRibbonInstanceCount
            )
            ribbonEncoder.endEncoding()
        }
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor) else {
            return
        }
        encoder.setRenderPipelineState(isParticleRibbon ? ribbonCompositePipeline : pipeline)
        uniforms.withUnsafeBytes { bytes in
            encoder.setFragmentBytes(bytes.baseAddress!, length: bytes.count, index: 0)
        }
        if isParticleRibbon {
            encoder.setFragmentTexture(ribbonTexture, index: 0)
        }
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }
}

private final class LiquidOrbCoordinator {
    private var renderer: LiquidOrbRenderer?

    func setAudio(_ audio: LiquidOrbAudio) { renderer?.setAudio(audio) }

    func makeView(state: LiquidOrbState) -> MTKView {
        let view = MTKView(frame: .zero, device: nil)
        do {
            let renderer = try LiquidOrbRenderer(view: view, state: state)
            self.renderer = renderer
            view.delegate = renderer
            return view
        } catch {
            preconditionFailure("Liquid Orb Metal initialization failed: \\(error)")
        }
    }

    func setState(_ state: LiquidOrbState) {
        renderer?.setState(state)
    }
}

#if os(iOS)
private struct LiquidOrbSurface: UIViewRepresentable {
    let state: LiquidOrbState
    var audio = LiquidOrbAudio()

    func makeCoordinator() -> LiquidOrbCoordinator { LiquidOrbCoordinator() }
    func makeUIView(context: Context) -> MTKView { context.coordinator.makeView(state: state) }
    func updateUIView(_ view: MTKView, context: Context) { context.coordinator.setState(state); context.coordinator.setAudio(audio) }
}
#elseif os(macOS)
private struct LiquidOrbSurface: NSViewRepresentable {
    let state: LiquidOrbState
    var audio = LiquidOrbAudio()

    func makeCoordinator() -> LiquidOrbCoordinator { LiquidOrbCoordinator() }
    func makeNSView(context: Context) -> MTKView { context.coordinator.makeView(state: state) }
    func updateNSView(_ view: MTKView, context: Context) { context.coordinator.setState(state); context.coordinator.setAudio(audio) }
}
#endif

public struct LiquidOrbView: View {
    private let state: LiquidOrbState
    private var audio = LiquidOrbAudio()

    public init(state: LiquidOrbState = .${initialState}) {
        self.state = state
    }

    public init(state: LiquidOrbState = .${initialState}, audio: LiquidOrbAudio) {
        self.state = state
        self.audio = audio
    }

    public var body: some View {
        LiquidOrbSurface(state: state, audio: audio)
    }
}`;
}
