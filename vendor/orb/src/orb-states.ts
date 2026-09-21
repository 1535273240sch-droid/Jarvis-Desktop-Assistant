import { type OrbParams, stylePresets, type StyleName } from "./presets";

export const orbStateNames = [
  "idle",
  "listening",
  "thinking",
  "executing",
  "speaking",
  "error"
] as const;
export type OrbStateName = (typeof orbStateNames)[number];

export const orbStateNumericKeys = [
  "speed",
  "contourDeform",
  "bandDensity",
  "chromaticShift",
  "metalStretch",
  "metalEvolution",
  "metalRoughness",
  "metalDepth",
  "ribbonWidth",
  "ribbonTwist",
  "ribbonFold",
  "ribbonBreath",
  "zoom",
  "warp",
  "ridgeAmt",
  "sharp",
  "shade",
  "exposure",
  "edgeGlow",
] as const;

export const orbStateColorKeys = [
  "colorA",
  "colorB",
  "colorC",
  "colorD",
  "highlightColor",
  "glowColor",
] as const;

export const orbStateProfileKeys = [
  ...orbStateNumericKeys,
  ...orbStateColorKeys,
] as const;

export type OrbStateNumericKey = (typeof orbStateNumericKeys)[number];
export type OrbStateColorKey = (typeof orbStateColorKeys)[number];
export type OrbStateProfileKey = (typeof orbStateProfileKeys)[number];
export type OrbStateProfile = Pick<OrbParams, OrbStateProfileKey>;
export type OrbSharedParams = Omit<OrbParams, OrbStateProfileKey>;

export type OrbStateConfiguration = {
  shared: OrbSharedParams;
  profiles: Record<OrbStateName, OrbStateProfile>;
  activationDuration: number;
  transitionDuration: number;
};

export type OrbRenderTarget = {
  state: OrbStateName;
  params: OrbParams;
  activationDuration: number;
  transitionDuration: number;
};

export const defaultOrbState: OrbStateName = "thinking";
export const defaultOrbActivationDuration = 0.22;
export const defaultOrbTransitionDuration = 0.65;

type NumericTransform = {
  scale: number;
  offset?: number;
};

type IdleTransforms = Partial<Record<OrbStateNumericKey, NumericTransform>>;

type IdleStyleProfile = {
  numeric: IdleTransforms;
  colors: Record<OrbStateColorKey, string>;
};

const idleProfilesByStyle: Record<StyleName, IdleStyleProfile> = {
  siri: {
    numeric: {
      speed: { scale: 0.3 },
      contourDeform: { scale: 0.3 },
      zoom: { scale: 0.94 },
      warp: { scale: 0.52 },
      ridgeAmt: { scale: 0.48 },
      sharp: { scale: 0.9 },
      exposure: { scale: 0.68 },
    },
    colors: {
      colorA: "#B5A674", colorB: "#5E8794", colorC: "#9A648A",
      colorD: "#635B8A", highlightColor: "#B6C4D2", glowColor: "#6C688F",
    },
  },
  voiceWave: {
    numeric: {
      speed: { scale: 0.28 },
      contourDeform: { scale: 0.3 },
      zoom: { scale: 0.92 },
      warp: { scale: 0.46 },
      ridgeAmt: { scale: 0.42 },
      exposure: { scale: 0.62 },
    },
    colors: {
      colorA: "#08050B", colorB: "#6A2F69", colorC: "#8C4652",
      colorD: "#55467F", highlightColor: "#B58AA5", glowColor: "#6C3E72",
    },
  },
  blueDrop: {
    numeric: {
      speed: { scale: 0.3 },
      contourDeform: { scale: 0.35 },
      zoom: { scale: 0.93 },
      warp: { scale: 0.5 },
      ridgeAmt: { scale: 0.46 },
      sharp: { scale: 0.82 },
      exposure: { scale: 0.66 },
    },
    colors: {
      colorA: "#020812", colorB: "#0A2C5A", colorC: "#24678A",
      colorD: "#A4C3CA", highlightColor: "#9FC8D5", glowColor: "#1F5076",
    },
  },
  violetEmber: {
    numeric: {
      speed: { scale: 0.28 },
      contourDeform: { scale: 0.3 },
      zoom: { scale: 0.92 },
      warp: { scale: 0.46 },
      ridgeAmt: { scale: 0.42 },
      sharp: { scale: 0.78 },
      exposure: { scale: 0.64 },
    },
    colors: {
      colorA: "#0B0310", colorB: "#2B1748", colorC: "#593078",
      colorD: "#9B78A8", highlightColor: "#BCA6C2", glowColor: "#593273",
    },
  },
  refractiveBlob: {
    numeric: {
      speed: { scale: 0.3 },
      contourDeform: { scale: 0.32 },
      zoom: { scale: 0.94 },
      warp: { scale: 0.5 },
      ridgeAmt: { scale: 0.44 },
      sharp: { scale: 0.82 },
      exposure: { scale: 0.68 },
    },
    colors: {
      colorA: "#0F0B16", colorB: "#403552", colorC: "#776990",
      colorD: "#AEA4BD", highlightColor: "#C9C4D1", glowColor: "#6E6185",
    },
  },
  particleRibbon: {
    numeric: {
      speed: { scale: 0.28 },
      ribbonWidth: { scale: 0.62 },
      ribbonTwist: { scale: 0.42 },
      ribbonFold: { scale: 0.35 },
      ribbonBreath: { scale: 0.18 },
      exposure: { scale: 0.68 },
    },
    colors: {
      colorA: "#3A6068", colorB: "#375D78", colorC: "#594E83",
      colorD: "#854C7A", highlightColor: "#B9CCD1", glowColor: "#514C78",
    },
  },
  chromaticMetal: {
    numeric: {
      speed: { scale: 0.3 },
      bandDensity: { scale: 0.62 },
      chromaticShift: { scale: 0.35 },
      metalStretch: { scale: 0.48 },
      metalEvolution: { scale: 0.32 },
      metalRoughness: { scale: 1.35 },
      metalDepth: { scale: 0.55 },
      exposure: { scale: 0.72 },
    },
    colors: {
      colorA: "#B8BCBA", colorB: "#666B69", colorC: "#9EA3A1",
      colorD: "#282B2D", highlightColor: "#D1D5D3", glowColor: "#78898F",
    },
  },
  aurora: {
    numeric: {
      speed: { scale: 0.22 },
      contourDeform: { scale: 0.3 },
      zoom: { scale: 0.92 },
      warp: { scale: 0.42 },
      ridgeAmt: { scale: 0.38 },
      sharp: { scale: 0.85 },
      exposure: { scale: 0.62 },
    },
    colors: {
      colorA: "#02050C", colorB: "#1D6659", colorC: "#285D78",
      colorD: "#533E75", highlightColor: "#92B6B3", glowColor: "#286A62",
    },
  },
  frost: {
    numeric: {
      speed: { scale: 0.26 },
      contourDeform: { scale: 0.28 },
      zoom: { scale: 0.94 },
      warp: { scale: 0.5 },
      ridgeAmt: { scale: 0.46 },
      sharp: { scale: 0.78 },
      exposure: { scale: 0.72 },
    },
    colors: {
      colorA: "#C3CDD5", colorB: "#9AABB8", colorC: "#768D9E",
      colorD: "#536985", highlightColor: "#D6DEE5", glowColor: "#697D91",
    },
  },
  chrome: {
    numeric: {
      speed: { scale: 0.28 },
      contourDeform: { scale: 0.35 },
      zoom: { scale: 0.92 },
      warp: { scale: 0.48 },
      sharp: { scale: 0.74 },
      exposure: { scale: 0.72 },
    },
    colors: {
      colorA: "#A7AAA9", colorB: "#6E7273", colorC: "#363A3D",
      colorD: "#101213", highlightColor: "#CBCFCE", glowColor: "#747A7B",
    },
  },
  opal: {
    numeric: {
      speed: { scale: 0.3 },
      contourDeform: { scale: 0.32 },
      zoom: { scale: 0.94 },
      warp: { scale: 0.52 },
      ridgeAmt: { scale: 0.48 },
      exposure: { scale: 0.68 },
    },
    colors: {
      colorA: "#C9C3BC", colorB: "#6E9E91", colorC: "#A17496",
      colorD: "#68608E", highlightColor: "#E1DCD5", glowColor: "#82799B",
    },
  },
  spectrum: {
    numeric: {
      speed: { scale: 0.27 },
      contourDeform: { scale: 0.3 },
      zoom: { scale: 0.92 },
      warp: { scale: 0.44 },
      ridgeAmt: { scale: 0.38 },
      exposure: { scale: 0.62 },
    },
    colors: {
      colorA: "#B4BBC2", colorB: "#285D8F", colorC: "#91506F",
      colorD: "#3F8873", highlightColor: "#D8DDE1", glowColor: "#386789",
    },
  },
  plasma: {
    numeric: {
      speed: { scale: 0.26 },
      contourDeform: { scale: 0.28 },
      zoom: { scale: 0.9 },
      warp: { scale: 0.42 },
      ridgeAmt: { scale: 0.36 },
      sharp: { scale: 0.68 },
      exposure: { scale: 0.6 },
    },
    colors: {
      colorA: "#04020A", colorB: "#084772", colorC: "#1C5790",
      colorD: "#174B84", highlightColor: "#A5BBD0", glowColor: "#14577F",
    },
  },
};

const orbStateProfileKeySet = new Set<keyof OrbParams>(orbStateProfileKeys);

export function isOrbStateProfileKey(key: keyof OrbParams): key is OrbStateProfileKey {
  return orbStateProfileKeySet.has(key);
}

export function splitOrbParams(params: OrbParams): {
  shared: OrbSharedParams;
  profile: OrbStateProfile;
} {
  const profile = Object.fromEntries(
    orbStateProfileKeys.map((key) => [key, params[key]]),
  ) as OrbStateProfile;
  const shared = { ...params } as Partial<OrbParams>;
  for (const key of orbStateProfileKeys) delete shared[key];

  return {
    shared: shared as OrbSharedParams,
    profile,
  };
}

function createIdleParams(thinkingParams: OrbParams): OrbParams {
  const idleParams = { ...thinkingParams };
  const profile = idleProfilesByStyle[thinkingParams.style];

  for (const [key, transform] of Object.entries(profile.numeric) as Array<
    [OrbStateNumericKey, NumericTransform]
  >) {
    idleParams[key] = thinkingParams[key] * transform.scale + (transform.offset ?? 0);
  }
  for (const key of orbStateColorKeys) idleParams[key] = profile.colors[key];

  return idleParams;
}

export function createOrbStateConfiguration(
  thinkingParams: OrbParams,
  transitionDuration = defaultOrbTransitionDuration,
  activationDuration = defaultOrbActivationDuration,
): OrbStateConfiguration {
  if (!Number.isFinite(transitionDuration) || transitionDuration < 0) {
    throw new RangeError(`Invalid orb transition duration: ${transitionDuration}`);
  }
  if (!Number.isFinite(activationDuration) || activationDuration < 0) {
    throw new RangeError(`Invalid orb activation duration: ${activationDuration}`);
  }

  const thinking = splitOrbParams(thinkingParams);
  const idle = splitOrbParams(createIdleParams(thinkingParams));

  // 扩展 4 个状态的 profile，复用现有参数集
  // listening: 活泼波动，浅青绿/海蓝光晕
  const listeningProfile: OrbStateProfile = {
    ...idle.profile,
    speed: thinking.profile.speed * 1.1,
    contourDeform: thinking.profile.contourDeform * 1.2,
    zoom: thinking.profile.zoom * 1.02,
    warp: thinking.profile.warp * 1.1,
    edgeGlow: thinking.profile.edgeGlow * 1.3,
    colorA: "#38EF7D",
    colorB: "#11998E",
    colorC: "#00C9FF",
    colorD: "#92FE9D",
    highlightColor: "#E0F7FA",
    glowColor: "#00E676",
  };

  // executing: 金属质感与环绕流转，琥珀金/日落橙
  const executingProfile: OrbStateProfile = {
    ...thinking.profile,
    speed: thinking.profile.speed * 0.9,
    metalStretch: (thinking.profile.metalStretch ?? 1.0) * 1.2,
    metalEvolution: (thinking.profile.metalEvolution ?? 1.0) * 1.15,
    ridgeAmt: thinking.profile.ridgeAmt * 1.2,
    edgeGlow: thinking.profile.edgeGlow * 1.2,
    colorA: "#FFB300",
    colorB: "#FF6F00",
    colorC: "#FF8F00",
    colorD: "#FFA000",
    highlightColor: "#FFF8E1",
    glowColor: "#FFC107",
  };

  // speaking: 饱满大幅度律动，亮蓝白/翡翠青
  const speakingProfile: OrbStateProfile = {
    ...thinking.profile,
    speed: thinking.profile.speed * 1.15,
    contourDeform: thinking.profile.contourDeform * 1.25,
    zoom: thinking.profile.zoom * 1.05,
    warp: thinking.profile.warp * 1.15,
    edgeGlow: thinking.profile.edgeGlow * 1.4,
    colorA: "#00E5FF",
    colorB: "#1DE9B6",
    colorC: "#00B0FF",
    colorD: "#64FFDA",
    highlightColor: "#FFFFFF",
    glowColor: "#00E5FF",
  };

  // error: 异常抖动，深暗红/警示红
  const errorProfile: OrbStateProfile = {
    ...idle.profile,
    speed: thinking.profile.speed * 1.3,
    contourDeform: thinking.profile.contourDeform * 1.4,
    ridgeAmt: thinking.profile.ridgeAmt * 1.5,
    sharp: thinking.profile.sharp * 1.3,
    colorA: "#FF1744",
    colorB: "#D50000",
    colorC: "#C51162",
    colorD: "#B71C1C",
    highlightColor: "#FF8A80",
    glowColor: "#FF5252",
  };

  return {
    activationDuration,
    shared: thinking.shared,
    profiles: {
      idle: idle.profile,
      listening: listeningProfile,
      thinking: thinking.profile,
      executing: executingProfile,
      speaking: speakingProfile,
      error: errorProfile,
    },
    transitionDuration,
  };
}

export function createPresetOrbStateConfiguration(style: StyleName): OrbStateConfiguration {
  return createOrbStateConfiguration({ style, ...stylePresets[style] });
}

export function resolveOrbStateParams(
  configuration: OrbStateConfiguration,
  state: OrbStateName,
): OrbParams {
  return {
    ...configuration.shared,
    ...configuration.profiles[state],
  };
}

export function updateOrbStateParam<Key extends keyof OrbParams>(
  configuration: OrbStateConfiguration,
  state: OrbStateName,
  key: Key,
  value: OrbParams[Key],
): OrbStateConfiguration {
  if (isOrbStateProfileKey(key)) {
    return {
      ...configuration,
      profiles: {
        ...configuration.profiles,
        [state]: {
          ...configuration.profiles[state],
          [key]: value,
        },
      },
    };
  }

  return {
    ...configuration,
    shared: {
      ...configuration.shared,
      [key]: value,
    },
  };
}

function parseHexColor(hex: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    throw new Error(`Invalid orb color: ${hex}`);
  }

  return [
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

function srgbToLinear(value: number): number {
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308
    ? value * 12.92
    : 1.055 * value ** (1 / 2.4) - 0.055;
}

function mixHexColor(from: string, to: string, progress: number): string {
  if (progress === 0) return from;
  if (progress === 1) return to;

  const fromRgb = parseHexColor(from);
  const toRgb = parseHexColor(to);
  const mixed = fromRgb.map((channel, index) => {
    const linear = srgbToLinear(channel)
      + (srgbToLinear(toRgb[index]) - srgbToLinear(channel)) * progress;
    return Math.min(255, Math.max(0, Math.round(linearToSrgb(linear) * 255)));
  });

  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export function smoothOrbTransitionProgress(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return clamped * clamped * (3 - 2 * clamped);
}

export function activeOrbTransitionProgress(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return 1 - (1 - clamped) ** 3;
}

export function interpolateOrbParams(
  from: OrbParams,
  to: OrbParams,
  progress: number,
): OrbParams {
  const clamped = Math.min(1, Math.max(0, progress));
  if (clamped === 0) return { ...from };
  if (clamped === 1) return { ...to };

  const result = { ...to };
  for (const key of orbStateNumericKeys) {
    result[key] = from[key] + (to[key] - from[key]) * clamped;
  }
  for (const key of orbStateColorKeys) {
    result[key] = mixHexColor(from[key], to[key], clamped);
  }
  return result;
}

export function createOrbTransitionController(initialTarget: OrbRenderTarget): {
  sample: (target: OrbRenderTarget, nowMs: number) => OrbParams;
} {
  let state = initialTarget.state;
  let fromParams = { ...initialTarget.params };
  let targetParams = { ...initialTarget.params };
  let targetState = initialTarget.state;
  let startedAtMs = 0;
  let durationMs = 0;

  function currentParams(nowMs: number): OrbParams {
    if (durationMs === 0) return { ...targetParams };
    const elapsed = Math.max(0, nowMs - startedAtMs);
    const rawProgress = elapsed / durationMs;
    const progress = targetState === "thinking"
      ? activeOrbTransitionProgress(rawProgress)
      : smoothOrbTransitionProgress(rawProgress);
    return interpolateOrbParams(fromParams, targetParams, progress);
  }

  return {
    sample(nextTarget, nowMs) {
      if (nextTarget.state !== state) {
        const current = currentParams(nowMs);
        fromParams = current;
        targetParams = { ...nextTarget.params };
        targetState = nextTarget.state;
        startedAtMs = nowMs;
        durationMs = Math.max(
          0,
          (nextTarget.state === "thinking"
            ? nextTarget.activationDuration
            : nextTarget.transitionDuration) * 1000,
        );
        state = nextTarget.state;
      } else {
        targetParams = { ...nextTarget.params };
      }

      return currentParams(nowMs);
    },
  };
}
