import * as React from "react";
import { CodeIcon, CopySimpleIcon, GithubLogoIcon } from "@phosphor-icons/react";

import { Button, buttonVariants } from "@/toolcraft/ui/components/primitives/button";
import { Input } from "@/toolcraft/ui/components/primitives/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/toolcraft/ui/components/primitives/tooltip";
import { ControlFieldLabel } from "@/toolcraft/ui/components/control-layout";
import { SwitchControl as Switch } from "@/toolcraft/ui/components/controls/boolean/boolean-controls";
import { SegmentedControl } from "@/toolcraft/ui/components/controls/segmented/segmented-control";
import { SliderControl as Slider } from "@/toolcraft/ui/components/controls/slider/slider-control";
import { Panel } from "@/toolcraft/ui/components/panel/panel";
import { PanelSection } from "@/toolcraft/ui/components/panel/panel-section";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/toolcraft/ui/components/composites/sheet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/toolcraft/ui/components/composites/tabs";

import posterUrl from "../poster.png";
import auroraPreviewUrl from "./assets/presets/aurora.png";
import blueDropPreviewUrl from "./assets/presets/blueDrop.png";
import chromePreviewUrl from "./assets/presets/chrome.png";
import chromaticMetalPreviewUrl from "./assets/presets/chromaticMetal.png";
import frostPreviewUrl from "./assets/presets/frost.png";
import opalPreviewUrl from "./assets/presets/opal.png";
import particleRibbonPreviewUrl from "./assets/presets/particleRibbon.png";
import plasmaPreviewUrl from "./assets/presets/plasma.png";
import refractiveBlobPreviewUrl from "./assets/presets/refractiveBlob.png";
import siriPreviewUrl from "./assets/presets/siri.png";
import spectrumPreviewUrl from "./assets/presets/spectrum.png";
import violetEmberPreviewUrl from "./assets/presets/violetEmber.png";
import voiceWavePreviewUrl from "./assets/presets/voiceWave.png";
import { createSwiftExport, createWebExport } from "./code-export";
import {
  colorLabels,
  localeOptions,
  numericLabels,
  styleLabels,
  uiCopy,
  type ColorKey,
  type Locale,
  type NumericKey,
} from "./editor-i18n";
import { createOrbRenderer } from "./orb-renderer";
import { OrbAudioInput } from "./orb-audio";
import { AudioControls } from "./AudioControls";
import {
  createOrbStateConfiguration,
  createPresetOrbStateConfiguration,
  defaultOrbActivationDuration,
  defaultOrbState,
  defaultOrbTransitionDuration,
  isOrbStateProfileKey,
  orbStateNames,
  orbStateProfileKeys,
  resolveOrbStateParams,
  updateOrbStateParam,
  type OrbStateConfiguration,
  type OrbStateName,
  type OrbStateProfile,
} from "./orb-states";
import {
  effectDefaults,
  orbRadiusRange,
  type OrbParams,
  styleNames,
  stylePresets,
  type StyleName,
} from "./presets";

const Color = React.lazy(async () => {
  const module = await import("@/toolcraft/ui/components/controls/color/color-control");
  return { default: module.ColorControl };
});

const stylePreviewUrls: Record<StyleName, string> = {
  siri: siriPreviewUrl,
  voiceWave: voiceWavePreviewUrl,
  spectrum: spectrumPreviewUrl,
  aurora: auroraPreviewUrl,
  frost: frostPreviewUrl,
  plasma: plasmaPreviewUrl,
  chrome: chromePreviewUrl,
  opal: opalPreviewUrl,
  blueDrop: blueDropPreviewUrl,
  violetEmber: violetEmberPreviewUrl,
  refractiveBlob: refractiveBlobPreviewUrl,
  particleRibbon: particleRibbonPreviewUrl,
  chromaticMetal: chromaticMetalPreviewUrl,
};
const compactPreviewStyles = new Set<StyleName>([
  "particleRibbon",
  "blueDrop",
  "violetEmber",
  "refractiveBlob",
  "chromaticMetal",
]);

type PreviewMode = "orb" | "scene";

const defaultSceneText = "Thinking...";
const maxSceneTextLength = 20;
const hashSyncDelayMs = 500;
const localeStorageKey = "liquid-orb-editor-locale";
const activationDurationRange = { min: 0.05, max: 0.8, step: 0.01 } as const;
const transitionDurationRange = { min: 0.1, max: 2, step: 0.05 } as const;

type OrbEditorState = {
  configuration: OrbStateConfiguration;
  activeState: OrbStateName;
};

type NumericSpec = {
  key: NumericKey;
  min: number;
  max: number;
  step: number;
  enabledStyles?: readonly StyleName[];
};

const ridgeStyles: readonly StyleName[] = [
  "siri",
  "voiceWave",
  "spectrum",
  "aurora",
  "frost",
  "plasma",
  "blueDrop",
  "violetEmber",
  "refractiveBlob",
];
const sharpStyles: readonly StyleName[] = [
  "frost",
  "plasma",
  "chrome",
  "blueDrop",
  "violetEmber",
  "refractiveBlob",
];
const standardShapeStyles = styleNames.filter(
  (style) => style !== "chromaticMetal" && style !== "particleRibbon",
);
const chromaticMetalStyles: readonly StyleName[] = ["chromaticMetal"];
const particleRibbonStyles: readonly StyleName[] = ["particleRibbon"];

const numericSpecs: readonly NumericSpec[] = [
  { key: "speed", min: 0, max: 3, step: 0.01 },
  { key: "radius", ...orbRadiusRange, step: 0.01 },
  {
    key: "contourDeform",
    min: 0,
    max: 1,
    step: 0.01,
    enabledStyles: standardShapeStyles,
  },
  {
    key: "zoom",
    min: 0.05,
    max: 1,
    step: 0.01,
    enabledStyles: standardShapeStyles,
  },
  {
    key: "warp",
    min: 0,
    max: 6,
    step: 0.05,
    enabledStyles: standardShapeStyles,
  },
  { key: "ridgeAmt", min: 0, max: 1, step: 0.01, enabledStyles: ridgeStyles },
  { key: "sharp", min: 0.5, max: 6, step: 0.05, enabledStyles: sharpStyles },
  {
    key: "bandDensity",
    min: 1,
    max: 6,
    step: 0.1,
    enabledStyles: chromaticMetalStyles,
  },
  {
    key: "metalDepth",
    min: 0,
    max: 1,
    step: 0.01,
    enabledStyles: chromaticMetalStyles,
  },
  {
    key: "metalRoughness",
    min: 0,
    max: 1,
    step: 0.01,
    enabledStyles: chromaticMetalStyles,
  },
  {
    key: "chromaticShift",
    min: 0,
    max: 1,
    step: 0.01,
    enabledStyles: chromaticMetalStyles,
  },
  {
    key: "metalScale",
    min: 0.2,
    max: 2,
    step: 0.01,
    enabledStyles: chromaticMetalStyles,
  },
  {
    key: "metalStretch",
    min: 0,
    max: 1,
    step: 0.01,
    enabledStyles: chromaticMetalStyles,
  },
  {
    key: "metalAngle",
    min: -180,
    max: 180,
    step: 1,
    enabledStyles: chromaticMetalStyles,
  },
  {
    key: "metalOffset",
    min: -1,
    max: 1,
    step: 0.01,
    enabledStyles: chromaticMetalStyles,
  },
  {
    key: "metalPhase",
    min: 0,
    max: 1,
    step: 0.01,
    enabledStyles: chromaticMetalStyles,
  },
  {
    key: "metalEvolution",
    min: 0,
    max: 2,
    step: 0.02,
    enabledStyles: chromaticMetalStyles,
  },
  {
    key: "particleDensity",
    min: 0.2,
    max: 1,
    step: 0.01,
    enabledStyles: particleRibbonStyles,
  },
  {
    key: "ribbonCount",
    min: 2,
    max: 6,
    step: 1,
    enabledStyles: particleRibbonStyles,
  },
  {
    key: "ribbonWidth",
    min: 0.1,
    max: 0.8,
    step: 0.01,
    enabledStyles: particleRibbonStyles,
  },
  {
    key: "ribbonTwist",
    min: 0.1,
    max: 3,
    step: 0.01,
    enabledStyles: particleRibbonStyles,
  },
  {
    key: "ribbonFold",
    min: 0,
    max: 1.2,
    step: 0.01,
    enabledStyles: particleRibbonStyles,
  },
  {
    key: "ribbonBreath",
    min: 0,
    max: 0.8,
    step: 0.01,
    enabledStyles: particleRibbonStyles,
  },
  {
    key: "particleSize",
    min: 0.6,
    max: 2.5,
    step: 0.01,
    enabledStyles: particleRibbonStyles,
  },
  {
    key: "particleBloom",
    min: 0,
    max: 2,
    step: 0.01,
    enabledStyles: particleRibbonStyles,
  },
  { key: "shade", min: 0, max: 1.5, step: 0.01 },
  { key: "exposure", min: 0.2, max: 3, step: 0.02 },
  { key: "sheen", min: 0, max: 2, step: 0.02 },
  { key: "gloss", min: 0, max: 2, step: 0.02 },
  { key: "glassOpacity", min: 0, max: 1, step: 0.01 },
  { key: "shellMidAlpha", min: 0, max: 1, step: 0.01 },
  { key: "shellEdgeAlpha", min: 0, max: 1, step: 0.01 },
  { key: "edgeSoftness", min: 0.005, max: 0.15, step: 0.005 },
  { key: "edgeGlow", min: 0, max: 1, step: 0.01 },
];

const numericSpecByKey = new Map(numericSpecs.map((spec) => [spec.key, spec]));
const colorKeys: readonly ColorKey[] = [
  "colorA",
  "colorB",
  "colorC",
  "colorD",
  "highlightColor",
  "shellInner",
  "shellMid",
  "shellEdge",
  "sheenColor",
  "specColor",
  "canvasColor",
  "glowColor",
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeColor(value: string): string | null {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : null;
}

function limitSceneText(value: string): string {
  return Array.from(value).slice(0, maxSceneTextLength).join("");
}

function readInitialLocale(): Locale {
  try {
    const storedLocale = window.localStorage.getItem(localeStorageKey);
    if (storedLocale === "zh" || storedLocale === "en") return storedLocale;
  } catch (error) {
    console.warn("Unable to read the saved interface language.", error);
  }

  return navigator.language.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
}

function readPreviewModeFromHash(): PreviewMode {
  return new URLSearchParams(window.location.hash.slice(1)).get("preview") === "scene"
    ? "scene"
    : "orb";
}

function readSceneTextFromHash(): string {
  const text = new URLSearchParams(window.location.hash.slice(1)).get("text");
  return text === null ? defaultSceneText : limitSceneText(text);
}

function stateHashKey(state: OrbStateName, key: string): string {
  if (state === "thinking") return key;
  return `idle${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

function readEditorStateFromHash(): OrbEditorState {
  const search = new URLSearchParams(window.location.hash.slice(1));
  const style = search.get("style");
  const selectedStyle = style && styleNames.includes(style as StyleName)
    ? style as StyleName
    : effectDefaults.style;
  const params: OrbParams = {
    style: selectedStyle,
    ...stylePresets[selectedStyle],
  };

  const glass = search.get("glass");
  if (glass === "1") params.glassEnabled = true;
  if (glass === "0") params.glassEnabled = false;

  for (const spec of numericSpecs) {
    const raw = search.get(spec.key);
    if (raw === null) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) {
      params[spec.key] = clamp(value, spec.min, spec.max);
    }
  }

  for (const key of colorKeys) {
    const raw = search.get(key);
    if (raw === null) continue;
    const value = normalizeColor(raw);
    if (value) params[key] = value;
  }

  const transitionRaw = search.get("transition");
  const transitionValue = transitionRaw === null ? null : Number(transitionRaw);
  const transitionDuration = transitionValue !== null && Number.isFinite(transitionValue)
    ? clamp(
      transitionValue,
      transitionDurationRange.min,
      transitionDurationRange.max,
    )
    : defaultOrbTransitionDuration;
  const activationRaw = search.get("activation");
  const activationValue = activationRaw === null ? null : Number(activationRaw);
  const activationDuration = activationValue !== null && Number.isFinite(activationValue)
    ? clamp(
      activationValue,
      activationDurationRange.min,
      activationDurationRange.max,
    )
    : defaultOrbActivationDuration;
  let configuration = createOrbStateConfiguration(
    params,
    transitionDuration,
    activationDuration,
  );

  for (const key of orbStateProfileKeys) {
    const raw = search.get(stateHashKey("idle", key));
    if (raw === null) continue;

    if (typeof configuration.profiles.idle[key] === "number") {
      const spec = numericSpecByKey.get(key as NumericKey);
      const value = Number(raw);
      if (spec && Number.isFinite(value)) {
        configuration = updateOrbStateParam(
          configuration,
          "idle",
          key,
          clamp(value, spec.min, spec.max),
        );
      }
    } else {
      const color = normalizeColor(raw);
      if (color) configuration = updateOrbStateParam(configuration, "idle", key, color);
    }
  }

  const state = search.get("state");
  const activeState = state && orbStateNames.includes(state as OrbStateName)
    ? state as OrbStateName
    : defaultOrbState;

  return { configuration, activeState };
}

function writeHash(
  editorState: OrbEditorState,
  previewMode: PreviewMode,
  sceneText: string,
): void {
  const { configuration, activeState } = editorState;
  const params = resolveOrbStateParams(configuration, "thinking");
  const search = new URLSearchParams();
  search.set("effect", "orb-glass-liquid");
  search.set("style", params.style);
  search.set("glass", params.glassEnabled ? "1" : "0");
  search.set("state", activeState);
  search.set("activation", String(configuration.activationDuration));
  search.set("transition", String(configuration.transitionDuration));
  search.set("preview", previewMode);
  search.set("text", sceneText);
  for (const spec of numericSpecs) {
    search.set(spec.key, String(params[spec.key]));
    if (isOrbStateProfileKey(spec.key)) {
      search.set(
        stateHashKey("idle", spec.key),
        String(configuration.profiles.idle[spec.key]),
      );
    }
  }
  for (const key of colorKeys) {
    search.set(key, params[key]);
    if (isOrbStateProfileKey(key)) {
      search.set(stateHashKey("idle", key), configuration.profiles.idle[key]);
    }
  }
  window.history.replaceState(null, "", `#${search.toString()}`);
}

function useSectionState() {
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({
    state: false,
    motion: false,
    colors: true,
    shape: true,
    glass: false,
    edge: false,
    scene: false,
  });

  return {
    isCollapsed: (key: string) => collapsed[key] ?? false,
    onCollapsedChange: (key: string) => (value: boolean) => {
      setCollapsed((current) => ({ ...current, [key]: value }));
    },
  };
}

function useStackedLayout(): boolean {
  const [stacked, setStacked] = React.useState(() =>
    window.matchMedia("(max-width: 900px)").matches,
  );

  React.useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setStacked(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return stacked;
}

export function App(): React.JSX.Element {
  const [audioInput] = React.useState(() => new OrbAudioInput());
  const [audioResetKey, setAudioResetKey] = React.useState(0);
  const [locale, setLocale] = React.useState<Locale>(readInitialLocale);
  const [editorState, setEditorState] = React.useState<OrbEditorState>(readEditorStateFromHash);
  const [renderState, setRenderState] = React.useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = React.useState("");
  const [presetCollapsed, setPresetCollapsed] = React.useState(false);
  const [propertiesCollapsed, setPropertiesCollapsed] = React.useState(false);
  const [previewScale, setPreviewScale] = React.useState(1);
  const [previewMode, setPreviewMode] = React.useState<PreviewMode>(readPreviewModeFromHash);
  const [sceneText, setSceneText] = React.useState(readSceneTextFromHash);
  const [codeOpen, setCodeOpen] = React.useState(false);
  const [codePlatform, setCodePlatform] = React.useState<"web" | "swift">("web");
  const [copiedPlatform, setCopiedPlatform] = React.useState<"web" | "swift" | "error" | null>(null);
  const [codeState, setCodeState] = React.useState<OrbEditorState | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const stageRef = React.useRef<HTMLElement | null>(null);
  const copyBufferRef = React.useRef<HTMLTextAreaElement | null>(null);
  const params = resolveOrbStateParams(
    editorState.configuration,
    editorState.activeState,
  );
  const presetStateParams = React.useMemo(
    () => resolveOrbStateParams(
      createPresetOrbStateConfiguration(params.style),
      editorState.activeState,
    ),
    [editorState.activeState, params.style],
  );
  const renderTargetRef = React.useRef({
    state: editorState.activeState,
    params,
    activationDuration: editorState.configuration.activationDuration,
    transitionDuration: editorState.configuration.transitionDuration,
  });
  const sectionState = useSectionState();
  const stackedLayout = useStackedLayout();
  const copy = uiCopy[locale];
  const previewModeOptions = React.useMemo(
    () => [
      { label: copy.orbMode, value: "orb" },
      { label: copy.sceneMode, value: "scene" },
    ],
    [copy.orbMode, copy.sceneMode],
  );
  const orbStateOptions = React.useMemo(
    () => [
      { label: copy.idleState, value: "idle" },
      { label: copy.thinkingState, value: "thinking" },
    ],
    [copy.idleState, copy.thinkingState],
  );

  const webCode = React.useMemo(
    () => (codeState
      ? createWebExport(codeState.configuration, codeState.activeState)
      : ""),
    [codeState],
  );
  const swiftCode = React.useMemo(
    () => (codeState
      ? createSwiftExport(codeState.configuration, codeState.activeState)
      : ""),
    [codeState],
  );

  renderTargetRef.current = {
    state: editorState.activeState,
    params,
    activationDuration: editorState.configuration.activationDuration,
    transitionDuration: editorState.configuration.transitionDuration,
  };

  React.useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    document.title = uiCopy[locale].documentTitle;
    try {
      window.localStorage.setItem(localeStorageKey, locale);
    } catch (error) {
      console.warn("Unable to save the interface language.", error);
    }
  }, [locale]);

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      writeHash(editorState, previewMode, sceneText);
    }, hashSyncDelayMs);

    return () => window.clearTimeout(timeout);
  }, [editorState, previewMode, sceneText]);

  React.useEffect(() => {
    const syncFromHash = () => {
      setEditorState(readEditorStateFromHash());
      setPreviewMode(readPreviewModeFromHash());
      setSceneText(readSceneTextFromHash());
      setPreviewScale(1);
    };

    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  React.useEffect(() => {
    document.documentElement.style.setProperty("--orb-canvas-color", params.canvasColor);
  }, [params.canvasColor]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    return createOrbRenderer({
      canvas,
      getTarget: () => renderTargetRef.current,
      getAudioBands: (dt) => audioInput.read(dt),
      onError: (error) => {
        setErrorMessage(error.message);
        setRenderState("error");
      },
      onReady: () => setRenderState((current) => (current === "ready" ? current : "ready")),
    });
  }, []);

  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;

    const handleWheel = (event: WheelEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-stage-controls]")
      ) {
        return;
      }

      event.preventDefault();
      const modeScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? stage.clientHeight
          : 1;
      const delta = clamp(-event.deltaY * modeScale * 0.001, -0.1, 0.1);
      setPreviewScale((current) =>
        Math.round(clamp(current + delta, 0.6, 1.6) * 100) / 100,
      );
    };

    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, []);

  const setParam = React.useCallback(
    <Key extends keyof OrbParams>(key: Key, value: OrbParams[Key]) => {
      setEditorState((current) => ({
        ...current,
        configuration: updateOrbStateParam(
          current.configuration,
          current.activeState,
          key,
          value,
        ),
      }));
    },
    [],
  );

  const applyStyle = React.useCallback((style: StyleName) => {
    setEditorState((current) => ({
      activeState: current.activeState,
      configuration: {
        ...createPresetOrbStateConfiguration(style),
        activationDuration: current.configuration.activationDuration,
        transitionDuration: current.configuration.transitionDuration,
      },
    }));
  }, []);

  const resetAll = React.useCallback(() => {
    setAudioResetKey((value) => value + 1);
    setEditorState({
      activeState: defaultOrbState,
      configuration: createPresetOrbStateConfiguration(effectDefaults.style),
    });
    setSceneText(defaultSceneText);
    setPreviewScale(1);
  }, []);

  const updatePreviewMode = React.useCallback((value: string) => {
    if (value !== "orb" && value !== "scene") return;
    setPreviewMode(value);
    setPreviewScale(1);
  }, []);

  const updateOrbState = React.useCallback((value: string) => {
    if (!orbStateNames.includes(value as OrbStateName)) return;
    setEditorState((current) => ({
      ...current,
      activeState: value as OrbStateName,
    }));
  }, []);

  const updateTransitionDuration = React.useCallback((value: number) => {
    setEditorState((current) => ({
      ...current,
      configuration: {
        ...current.configuration,
        transitionDuration: value,
      },
    }));
  }, []);

  const updateActivationDuration = React.useCallback((value: number) => {
    setEditorState((current) => ({
      ...current,
      configuration: {
        ...current.configuration,
        activationDuration: value,
      },
    }));
  }, []);

  const openCode = React.useCallback(() => {
    setCodeState({
      activeState: editorState.activeState,
      configuration: {
        ...editorState.configuration,
        shared: { ...editorState.configuration.shared },
        profiles: Object.fromEntries(
          orbStateNames.map((state) => [state, { ...editorState.configuration.profiles[state] }]),
        ) as Record<OrbStateName, OrbStateProfile>,
      },
    });
    setCopiedPlatform(null);
    setCodeOpen(true);
  }, [editorState]);

  const copyCode = React.useCallback(async () => {
    const code = codePlatform === "web" ? webCode : swiftCode;
    try {
      await navigator.clipboard.writeText(code);
      setCopiedPlatform(codePlatform);
    } catch {
      const copyBuffer = copyBufferRef.current;
      const previousFocus = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

      if (!copyBuffer) {
        setCopiedPlatform("error");
        return;
      }

      copyBuffer.value = code;
      copyBuffer.focus();
      copyBuffer.select();
      const copied = document.execCommand("copy");
      previousFocus?.focus();
      setCopiedPlatform(copied ? codePlatform : "error");
    }
  }, [codePlatform, swiftCode, webCode]);

  function renderSlider(key: NumericKey): React.JSX.Element | null {
    const spec = numericSpecByKey.get(key);
    if (!spec) throw new Error(`Missing slider configuration: ${key}`);
    if (spec.enabledStyles && !spec.enabledStyles.includes(params.style)) return null;

    return (
      <Slider
        baseValue={presetStateParams[key]}
        editValueLabel={copy.editValue(numericLabels[locale][key])}
        key={key}
        max={spec.max}
        min={spec.min}
        name={numericLabels[locale][key]}
        onValueChange={(value) => setParam(key, value)}
        showFill
        step={spec.step}
        value={params[key]}
      />
    );
  }

  function colorInput(key: ColorKey) {
    const name = colorLabels[locale][key];

    return {
      ariaLabels: {
        colorChannel: copy.colorChannel,
        colorSurface: copy.colorSurface,
        cssColorValue: copy.cssColorValue,
        hexColor: copy.hexColor,
        hexValue: copy.hexValue(name),
        hue: copy.hue,
        selectColor: copy.selectColor(name),
      },
      hex: params[key],
      name,
      onValueChange: ({ hex }: { hex: string }) => setParam(key, hex),
      showLabel: true,
    };
  }

  function colorControl(element: React.ReactNode): React.JSX.Element {
    return (
      <React.Suspense fallback={<div className="color-control-loading" aria-hidden="true" />}>
        {element}
      </React.Suspense>
    );
  }

  return (
    <TooltipProvider>
      <main
        className="orb-editor"
        data-preset-collapsed={String(!stackedLayout && presetCollapsed)}
        data-properties-collapsed={String(!stackedLayout && propertiesCollapsed)}
      >
        <aside className="preset-dock" aria-label={copy.presets}>
          <Panel
            className="preset-panel h-full max-h-none w-full rounded-lg"
            collapsed={presetCollapsed}
            collapseDirection="left"
            collapseLabel={copy.collapsePresets}
            collapsible={!stackedLayout}
            expandLabel={copy.expandPresets}
            onCollapsedChange={setPresetCollapsed}
            title={copy.presets}
          >
            <PanelSection>
              <div className="preset-control">
                <div className="preset-grid" role="group" aria-label={copy.animatedPresets}>
                  {styleNames.map((style) => (
                    <Button
                      aria-pressed={params.style === style}
                      className="preset-button"
                      key={style}
                      onClick={() => applyStyle(style)}
                      type="button"
                      variant="outline"
                    >
                      <img
                        alt=""
                        aria-hidden="true"
                        className={`preset-preview${
                          compactPreviewStyles.has(style) ? " preset-preview--compact" : ""
                        }`}
                        src={stylePreviewUrls[style]}
                      />
                      <span title={styleLabels[locale][style]}>{styleLabels[locale][style]}</span>
                    </Button>
                  ))}
                </div>
              </div>
            </PanelSection>
          </Panel>
        </aside>

        <section
          className="orb-stage"
          aria-label={previewMode === "scene" ? copy.scenePreview : copy.orbPreview}
          data-preview-mode={previewMode}
          ref={stageRef}
          style={{ "--preview-scale": previewScale } as React.CSSProperties}
        >
          <div className="language-control" data-stage-controls>
            <SegmentedControl
              ariaLabel={copy.switchLanguage}
              name={copy.switchLanguage}
              onValueChange={(value) => {
                if (value === "zh" || value === "en") setLocale(value);
              }}
              options={localeOptions}
              value={locale}
            />
          </div>
          <div className="stage-mode-control" data-stage-controls>
            <SegmentedControl
              ariaLabel={copy.switchPreviewMode}
              name={copy.previewMode}
              onValueChange={updatePreviewMode}
              options={previewModeOptions}
              value={previewMode}
            />
          </div>
          <div className="preview-surface">
            <div className="orb-visual">
              {renderState === "error" ? (
                <img className="orb-poster" src={posterUrl} alt={copy.staticOrbPreview} />
              ) : null}
              <canvas
                aria-label={copy.animatedOrbPreview}
                className="orb-canvas"
                data-ready={renderState === "ready" ? "true" : undefined}
                ref={canvasRef}
              />
              {renderState === "loading" ? (
                <div className="orb-status" role="status" aria-live="polite">
                  <span className="orb-spinner" aria-hidden="true" />
                  <span className="sr-only">{copy.loadingOrb}</span>
                </div>
              ) : null}
              {renderState === "error" ? (
                <p
                  className="orb-error"
                  title={locale === "zh" ? errorMessage : copy.renderErrorTitle}
                >
                  {copy.renderFallback}
                </p>
              ) : null}
            </div>
            {previewMode === "scene" ? (
              <div className="scene-copy" aria-label={copy.sceneText(sceneText)}>
                <span className="scene-copy-text">{sceneText || "\u00a0"}</span>
              </div>
            ) : null}
          </div>
          <div className="stage-toolbar" data-stage-controls>
            <Button
              className="code-trigger"
              onClick={openCode}
              size="lg"
              type="button"
              variant="outline"
            >
              <CodeIcon data-icon="inline-start" />
              {copy.copyCode}
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <a
                    aria-label={copy.viewSource}
                    className={`${buttonVariants({ size: "icon-lg", variant: "outline" })} github-link`}
                    href="https://github.com/LerSent001/orb"
                    rel="noopener noreferrer"
                    target="_blank"
                  />
                }
              >
                <GithubLogoIcon aria-hidden="true" weight="fill" />
              </TooltipTrigger>
              <TooltipContent side="top">{copy.viewSource}</TooltipContent>
            </Tooltip>
          </div>
        </section>

        <aside className="panel-dock" aria-label={copy.orbControls}>
          <Panel
            className="orb-editor-panel h-full max-h-none w-full rounded-lg"
            collapsed={propertiesCollapsed}
            collapseDirection="right"
            collapseLabel={copy.collapseControls}
            collapsible={!stackedLayout}
            expandLabel={copy.expandControls}
            onCollapsedChange={setPropertiesCollapsed}
            onResetControls={resetAll}
            resetLabel={copy.resetControls}
            title={copy.orbControls}
          >
            <AudioControls key={audioResetKey} input={audioInput} style={params.style} locale={locale} />
            {previewMode === "scene" ? (
              <PanelSection
                collapsed={sectionState.isCollapsed("scene")}
                collapseLabel={copy.collapseSection(copy.sceneSection)}
                collapsible
                expandLabel={copy.expandSection(copy.sceneSection)}
                onCollapsedChange={sectionState.onCollapsedChange("scene")}
                title={copy.sceneSection}
              >
                <div className="scene-text-field">
                  <div className="scene-text-label-row">
                    <ControlFieldLabel htmlFor="scene-text-input">{copy.displayText}</ControlFieldLabel>
                    <span aria-live="polite" className="scene-text-count">
                      {Array.from(sceneText).length}/{maxSceneTextLength}
                    </span>
                  </div>
                  <Input
                    aria-describedby="scene-text-limit"
                    id="scene-text-input"
                    onChange={(event) => setSceneText(limitSceneText(event.target.value))}
                    value={sceneText}
                  />
                  <span className="sr-only" id="scene-text-limit">{copy.sceneTextLimit}</span>
                </div>
              </PanelSection>
            ) : null}
            <PanelSection
              collapsed={sectionState.isCollapsed("state")}
              collapseLabel={copy.collapseSection(copy.stateSection)}
              collapsible
              expandLabel={copy.expandSection(copy.stateSection)}
              onCollapsedChange={sectionState.onCollapsedChange("state")}
              title={copy.stateSection}
            >
              <div className="orb-state-control">
                <SegmentedControl
                  ariaLabel={copy.switchOrbState}
                  name={copy.orbState}
                  onValueChange={updateOrbState}
                  options={orbStateOptions}
                  value={editorState.activeState}
                />
              </div>
              <Slider
                baseValue={defaultOrbActivationDuration}
                editValueLabel={copy.editValue(copy.activationDuration)}
                max={activationDurationRange.max}
                min={activationDurationRange.min}
                name={copy.activationDuration}
                onValueChange={updateActivationDuration}
                showFill
                step={activationDurationRange.step}
                unit="s"
                value={editorState.configuration.activationDuration}
              />
              <Slider
                baseValue={defaultOrbTransitionDuration}
                editValueLabel={copy.editValue(copy.transitionDuration)}
                max={transitionDurationRange.max}
                min={transitionDurationRange.min}
                name={copy.transitionDuration}
                onValueChange={updateTransitionDuration}
                showFill
                step={transitionDurationRange.step}
                unit="s"
                value={editorState.configuration.transitionDuration}
              />
            </PanelSection>
            <PanelSection
              collapsed={sectionState.isCollapsed("motion")}
              collapseLabel={copy.collapseSection(copy.motionSection)}
              collapsible
              expandLabel={copy.expandSection(copy.motionSection)}
              onCollapsedChange={sectionState.onCollapsedChange("motion")}
              title={copy.motionSection}
            >
              {renderSlider("speed")}
            </PanelSection>

            <PanelSection
              collapsed={sectionState.isCollapsed("colors")}
              collapseLabel={copy.collapseSection(copy.colorsSection)}
              collapsible
              expandLabel={copy.expandSection(copy.colorsSection)}
              onCollapsedChange={sectionState.onCollapsedChange("colors")}
              title={copy.colorsSection}
            >
              {colorControl(<Color inputs={[colorInput("colorA"), colorInput("colorB")]} />)}
              {colorControl(<Color inputs={[colorInput("colorC"), colorInput("colorD")]} />)}
              {colorControl(<Color inputs={[colorInput("highlightColor"), colorInput("canvasColor")]} />)}
              {renderSlider("shade")}
              {renderSlider("exposure")}
            </PanelSection>

            <PanelSection
              collapsed={sectionState.isCollapsed("shape")}
              collapseLabel={copy.collapseSection(copy.shapeSection)}
              collapsible
              expandLabel={copy.expandSection(copy.shapeSection)}
              onCollapsedChange={sectionState.onCollapsedChange("shape")}
              title={copy.shapeSection}
            >
              {renderSlider("radius")}
              {renderSlider("contourDeform")}
              {renderSlider("zoom")}
              {renderSlider("warp")}
              {renderSlider("ridgeAmt")}
              {renderSlider("sharp")}
              {renderSlider("metalDepth")}
              {renderSlider("metalRoughness")}
              {renderSlider("chromaticShift")}
              {renderSlider("metalScale")}
              {renderSlider("metalStretch")}
              {renderSlider("metalAngle")}
              {renderSlider("bandDensity")}
              {renderSlider("metalOffset")}
              {renderSlider("metalPhase")}
              {renderSlider("metalEvolution")}
              {renderSlider("particleDensity")}
              {renderSlider("ribbonCount")}
              {renderSlider("ribbonWidth")}
              {renderSlider("ribbonTwist")}
              {renderSlider("ribbonFold")}
              {renderSlider("ribbonBreath")}
              {renderSlider("particleSize")}
              {renderSlider("particleBloom")}
            </PanelSection>

            <PanelSection
              collapsed={sectionState.isCollapsed("glass")}
              collapseLabel={copy.collapseSection(copy.glassSection)}
              collapsible
              expandLabel={copy.expandSection(copy.glassSection)}
              onCollapsedChange={sectionState.onCollapsedChange("glass")}
              title={copy.glassSection}
            >
              <div className="glass-switch">
                <Switch
                  checked={params.glassEnabled}
                  name={copy.enableGlass}
                  onCheckedChange={(checked) => setParam("glassEnabled", checked)}
                />
              </div>
              {params.glassEnabled ? (
                <>
                  {renderSlider("glassOpacity")}
                  {renderSlider("sheen")}
                  {renderSlider("gloss")}
                  {renderSlider("shellMidAlpha")}
                  {renderSlider("shellEdgeAlpha")}
                  {colorControl(<Color inputs={[colorInput("shellInner"), colorInput("shellMid")]} />)}
                  {colorControl(<Color inputs={[colorInput("shellEdge"), colorInput("sheenColor")]} />)}
                  {colorControl(<Color {...colorInput("specColor")} />)}
                </>
              ) : null}
            </PanelSection>

            <PanelSection
              collapsed={sectionState.isCollapsed("edge")}
              collapseLabel={copy.collapseSection(copy.edgeSection)}
              collapsible
              expandLabel={copy.expandSection(copy.edgeSection)}
              onCollapsedChange={sectionState.onCollapsedChange("edge")}
              title={copy.edgeSection}
            >
              {renderSlider("edgeSoftness")}
              {renderSlider("edgeGlow")}
              {colorControl(<Color {...colorInput("glowColor")} />)}
            </PanelSection>

          </Panel>
        </aside>
      </main>

      <Sheet
        onOpenChange={(open) => {
          setCodeOpen(open);
          if (!open) setCopiedPlatform(null);
        }}
        open={codeOpen}
      >
        <SheetContent
          className="code-sheet"
          closeLabel={copy.close}
          side="bottom"
        >
          <textarea
            aria-hidden="true"
            className="code-copy-buffer"
            ref={copyBufferRef}
            tabIndex={-1}
          />
          <SheetHeader className="code-sheet-header">
            <SheetTitle>{copy.copyCode}</SheetTitle>
          </SheetHeader>
          <Tabs
            className="code-tabs"
            onValueChange={(value) => {
              if (value === "web" || value === "swift") {
                setCodePlatform(value);
                setCopiedPlatform(null);
              }
            }}
            value={codePlatform}
          >
            <div className="code-sheet-toolbar">
              <TabsList variant="control">
                <TabsTrigger value="web">Web</TabsTrigger>
                <TabsTrigger value="swift">SwiftUI</TabsTrigger>
              </TabsList>
              <Button onClick={copyCode} type="button" variant="outline">
                <CopySimpleIcon data-icon="inline-start" />
                {copiedPlatform === "error"
                  ? copy.copyFailed
                  : copiedPlatform === codePlatform
                    ? copy.copied
                    : copy.copyCode}
              </Button>
            </div>
            <TabsContent className="code-tab-content" value="web">
              <pre className="code-preview" aria-label={copy.webCode}><code>{webCode}</code></pre>
            </TabsContent>
            <TabsContent className="code-tab-content" value="swift">
              <pre className="code-preview" aria-label={copy.swiftCode}><code>{swiftCode}</code></pre>
            </TabsContent>
          </Tabs>
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
}
