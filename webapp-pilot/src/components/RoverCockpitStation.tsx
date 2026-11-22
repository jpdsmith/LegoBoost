// SPDX-License-Identifier: MIT
// FPV Rover Station — Two-Device Android Phone (on Tank) <-> Chromebook (+ Xbox Controller)
//   - Zero-IP Same-Wi-Fi Auto-Discovery + 4-Letter Room Code + Offline Direct Fallback
//   - Port-443 HTTPS + MQTT Dual-Relay WebRTC P2P Video & Low-Latency DataChannel (500ms Failsafe)
//   - Smart Co-Pilot ADAS (5-Sector Floor Clearance, Auto-Brake / Smart Dodge, Heading Hold, Tap-to-Follow)
//   - Smooth Continuous Autonomous Explorer, Live 2D Occupancy Room Map & On-the-Fly Discovery Log

import React, { useCallback, useEffect, useRef, useState } from "react";
import { TelemetryFlag, TelemetryFrame } from "@core/ble/protocol";
import { parseVoiceCommand, VoiceAction } from "@core/vision/voiceCommands";
import {
  mixXboxToTank,
  XboxControllerReader,
  XboxDriveSample,
} from "../input/xboxController";
import { IntelligentDriveController } from "../rover/intelligentDrive";
import { ExplorerFsmState, IntelligentExplorer } from "../rover/intelligentExplorer";
import { RoomMapper } from "../rover/roomMap";
import { generateRoomCode, normalizeRoomCode } from "../rtc/mqttSignaling";
import {
  BridgeDiagnostics,
  BridgeLinkState,
  BridgeTransportMode,
  CollisionGuardLevel,
  DetectedObjectBox,
  DriverToRoverMessage,
  ExplorerMission,
  PilotAssistMode,
  PilotConfigPayload,
  RoomMapSnapshot,
  RoverDiscoveryItem,
  RoverToDriverMessage,
  RoverVisionSnapshot,
  RoverWebRtcBridge,
} from "../rtc/roverBridge";
import {
  DiscoveredTank,
  WifiTankAdvertiser,
  WifiTankScanner,
} from "../rtc/wifiDiscovery";
import { mixArcadeToTank } from "../utils/driveMath";
import { OnDeviceObjectDetector } from "../vision/aiObjectDetector";
import {
  analyzeFloorCorridors,
  computeOpticalFlow,
  createFloorModel,
  detectFloorLaneOffset,
  HsvLockModel,
  loadMountCalibration,
  MountCalibration,
  sampleHsvTarget,
  saveMountCalibration,
  trackHsvTarget,
} from "../vision/roverVision";
import {
  FlightRecorder,
  FlightRunStats,
  PROBLEM_TAGS,
  ProblemTagKind,
  shareOrDownloadFile,
} from "../rover/flightRecorder";
import { FoldHeadingSnapshot, FoldHeadingTracker } from "../rover/foldHeading";
import { FoldAutoPilotView, RearCameraOption } from "./FoldAutoPilotView";
import { FpvOverlaySvg } from "./FpvOverlaySvg";
import {
  IconCamera,
  IconCompass,
  IconFlashlight,
  IconMic,
  IconRefresh,
  IconShield,
  IconStop,
  IconTarget,
  IconVrHeadset,
  IconWifi,
} from "./Icons";
import { RoomMapCanvas } from "./RoomMapCanvas";
import { XboxHudStrip } from "./XboxHudStrip";
import { QuestControlSample } from "../xr/questControllers";
import {
  checkWebXrVrSupported,
  isMetaQuestBrowser,
  QuestVrCockpitSession,
  VrHudState,
} from "../xr/questVrCockpit";

export interface RoverCockpitStationProps {
  isActiveTab: boolean;
  connected: boolean;
  disabled: boolean;
  safeMode: boolean;
  headHomed: boolean;
  headDeg: number;
  pickedUp: boolean;
  distancePct: number;
  telemetry: TelemetryFrame | null;
  headlightsOn: boolean;
  emergencyStopSeq: number;
  onHeadlightsChange: (on: boolean) => void;
  onWifiStatusChange?: (connected: boolean, label: string, remoteTelemetry: TelemetryFrame | null) => void;
  onDrive: (left: number, right: number, timeoutMs?: number) => void;
  onHead: (angleDeg: number, speed?: number, coalesce?: boolean) => void;
  onSynth: (voice: number, presetOrNote: number, durMs?: number) => void;
  onSetHubLed: (r: number, g: number, b: number) => void;
  onSetMode: (modeId: number) => void;
  onPlayMacro: () => Promise<void>;
  onStopMacro: () => Promise<void>;
}

type RoverSubView = "fold" | "driver" | "host" | "voice";

interface SpeechRecognitionEventLike {
  results: ArrayLike<{ isFinal?: boolean; 0?: { transcript?: string } }>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface VoiceBubble {
  id: number;
  transcript: string;
  intent: string;
  reply: string;
  blocked: boolean;
}

const EMPTY_XBOX: XboxDriveSample = {
  connected: false,
  name: null,
  steer: 0,
  throttle: 0,
  turretX: 0,
  usingTriggers: false,
  rt: 0,
  lt: 0,
  actions: [],
};

const EMPTY_HEADING: FoldHeadingSnapshot = {
  headingDeg: null,
  yawRateDegS: 0,
  source: "none",
  mountPitchDeg: null,
  mountRollDeg: null,
  rawAlpha: null,
  rawBeta: null,
  rawGamma: null,
};

const SPEED_STEPS = [40, 65, 85, 100];
const QUICK_PHRASES = [
  "Hello Vernie",
  "Forward",
  "Turn left",
  "Dance",
  "Explorer mode",
  "Stop",
];
const EXPLORER_MISSIONS: Array<{ id: ExplorerMission; label: string; sub: string }> = [
  { id: "explore-room", label: "Explore Room", sub: "Cruise smoothly & map new floor" },
  { id: "find-person", label: "Find Person", sub: "Seek & greet a human" },
  { id: "find-object", label: "Find Objects", sub: "Log landmarks on the fly" },
  { id: "return-home", label: "Return Home", sub: "Curve back to start" },
];
const VISION_W = 160;
const VISION_H = 120;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function compassLabel(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const norm = ((deg % 360) + 360) % 360;
  return `${Math.round(norm)}° ${dirs[Math.round(norm / 45) % 8]}`;
}

function isLikelyAndroidDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  if (isMetaQuestBrowser()) return false;
  const ua = navigator.userAgent || "";
  return /Android/i.test(ua);
}

function readInitialQueryParams(): { subView: RoverSubView; joinCode: string; autoJoin: boolean } {
  if (typeof window === "undefined") {
    return { subView: "driver", joinCode: "", autoJoin: false };
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const role = params.get("role");
    const join = params.get("join");
    if (role === "fold") return { subView: "fold", joinCode: "", autoJoin: false };
    if (role === "host") return { subView: "host", joinCode: "", autoJoin: false };
    if (join) {
      const clean = normalizeRoomCode(join);
      return { subView: "driver", joinCode: clean, autoJoin: clean.length >= 3 };
    }
    return {
      subView: isLikelyAndroidDevice() ? "fold" : "driver",
      joinCode: "",
      autoJoin: false,
    };
  } catch {
    return { subView: "driver", joinCode: "", autoJoin: false };
  }
}

function captureThumbnail(source: HTMLVideoElement | null): string | undefined {
  if (!source) return undefined;
  try {
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 90;
    const ctx = c.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(source, 0, 0, 160, 90);
    return c.toDataURL("image/jpeg", 0.65);
  } catch {
    return undefined;
  }
}

export const RoverCockpitStation: React.FC<RoverCockpitStationProps> = ({
  isActiveTab,
  connected,
  disabled,
  safeMode,
  headHomed,
  headDeg,
  pickedUp,
  distancePct,
  telemetry,
  headlightsOn,
  emergencyStopSeq,
  onHeadlightsChange,
  onWifiStatusChange,
  onDrive,
  onHead,
  onSynth,
  onSetHubLed,
  onSetMode,
  onPlayMacro,
  onStopMacro,
}) => {
  const initParams = useRef(readInitialQueryParams()).current;
  const [subView, setSubView] = useState<RoverSubView>(initParams.subView);
  const [roomCode, setRoomCode] = useState<string>(() => generateRoomCode(4));
  const [joinCode, setJoinCode] = useState<string>(initParams.joinCode);
  const [linkState, setLinkState] = useState<BridgeLinkState>("idle");
  const [linkDetail, setLinkDetail] = useState<string>("Not paired over Wi-Fi yet");
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [showOfflineFallback, setShowOfflineFallback] = useState(false);
  const [offlineOfferText, setOfflineOfferText] = useState("");
  const [offlineAnswerText, setOfflineAnswerText] = useState("");

  // Same-Wi-Fi Auto-Discovery state
  const [discoveredTanks, setDiscoveredTanks] = useState<DiscoveredTank[]>([]);
  const [discoveryStatus, setDiscoveryStatus] = useState<string>(
    "Checking your Wi-Fi for nearby tanks (no IP address needed)…"
  );
  const [hostDiscoveryNote, setHostDiscoveryNote] = useState<string>(
    "Auto-discovery activates once you start hosting"
  );

  // Smart Co-Pilot & Autonomous Explorer config
  const [speedCap, setSpeedCap] = useState<number>(65);
  const [assistMode, setAssistMode] = useState<PilotAssistMode>("copilot");
  const [collisionGuard, setCollisionGuard] = useState<CollisionGuardLevel>("dodge");
  const [headingHold, setHeadingHold] = useState<boolean>(true);
  const [laneAssist, setLaneAssist] = useState<boolean>(false);
  const [aiEnabled, setAiEnabled] = useState<boolean>(false);
  const [aiStatusNote, setAiStatusNote] = useState<string | null>(null);
  const [showCorridors, setShowCorridors] = useState<boolean>(true);
  const [mission, setMission] = useState<ExplorerMission>("explore-room");
  const [assistNote, setAssistNote] = useState<string>(
    "Smart Co-Pilot ready — tap any object on live video to follow"
  );
  const [assistIntervening, setAssistIntervening] = useState<string>("none");
  const [explorerState, setExplorerState] = useState<ExplorerFsmState | string>("CRUISING");
  const [recoveries, setRecoveries] = useState<number>(0);
  const [lockedLabel, setLockedLabel] = useState<string | null>(null);
  const [localVision, setLocalVision] = useState<RoverVisionSnapshot | null>(null);
  const [localMap, setLocalMap] = useState<RoomMapSnapshot | null>(null);
  const [discoveries, setDiscoveries] = useState<RoverDiscoveryItem[]>([]);

  // Driver cockpit state
  const [showTouchPad, setShowTouchPad] = useState<boolean>(false);
  const [steerVis, setSteerVis] = useState<number>(0);
  const [throttleVis, setThrottleVis] = useState<number>(0);
  const [xboxSample, setXboxSample] = useState<XboxDriveSample>(EMPTY_XBOX);
  const [remoteTelemetry, setRemoteTelemetry] = useState<TelemetryFrame | null>(null);
  const [remoteBleOk, setRemoteBleOk] = useState<boolean>(false);
  const [remoteHeading, setRemoteHeading] = useState<number | null>(null);
  const [remoteTorchAvail, setRemoteTorchAvail] = useState<boolean>(false);
  const [remoteVision, setRemoteVision] = useState<RoverVisionSnapshot | null>(null);
  const [remoteMap, setRemoteMap] = useState<RoomMapSnapshot | null>(null);
  const [remoteAssistNote, setRemoteAssistNote] = useState<string>("");
  const [remoteAssistIntervening, setRemoteAssistIntervening] = useState<string>("none");
  const [remoteExplorerState, setRemoteExplorerState] = useState<string>("");
  const [hasRemoteVideo, setHasRemoteVideo] = useState<boolean>(false);
  const [hasFallbackVideo, setHasFallbackVideo] = useState<boolean>(false);
  const [transportMode, setTransportMode] = useState<BridgeTransportMode>("none");
  const [bridgeDiag, setBridgeDiag] = useState<BridgeDiagnostics | null>(null);

  // Android Rover Host & Pixel Fold On-Board Auto-Pilot state
  const [hostActive, setHostActive] = useState(false);
  const [hostCameraActive, setHostCameraActive] = useState(false);
  const [hostCameraError, setHostCameraError] = useState<string | null>(null);
  const [hostTorchSupported, setHostTorchSupported] = useState(false);
  const [hostWakeLocked, setHostWakeLocked] = useState(false);
  const [phoneHeadingDeg, setPhoneHeadingDeg] = useState<number | null>(null);
  const [foldHeading, setFoldHeading] = useState<FoldHeadingSnapshot>(EMPTY_HEADING);
  const [calibration, setCalibration] = useState<MountCalibration>(() => loadMountCalibration());
  const [rearCameras, setRearCameras] = useState<RearCameraOption[]>([]);
  const [autoHeadlights, setAutoHeadlights] = useState<boolean>(true);
  const [autoRecord, setAutoRecord] = useState<boolean>(true);
  const [visionMs, setVisionMs] = useState<number>(0);
  const [foldMotorCmd, setFoldMotorCmd] = useState<{ left: number; right: number; steer: number }>({
    left: 0,
    right: 0,
    steer: 0,
  });
  const [lastTagFeedback, setLastTagFeedback] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState<boolean>(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [runStats, setRunStats] = useState<FlightRunStats>(() =>
    new FlightRecorder(loadMountCalibration()).getStats()
  );

  // Voice Commander state
  const speechSupported = Boolean(getSpeechRecognitionCtor());
  const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [listening, setListening] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [commandInput, setCommandInput] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [feed, setFeed] = useState<VoiceBubble[]>([]);

  // Meta Quest / WebXR Immersive VR Cockpit state
  const isQuestBrowser = isMetaQuestBrowser();
  const [xrVrSupported, setXrVrSupported] = useState(false);
  const [vrActive, setVrActive] = useState(false);
  const [vrError, setVrError] = useState<string | null>(null);

  // Refs
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const fallbackImgBusyRef = useRef(false);
  const hostVideoRef = useRef<HTMLVideoElement | null>(null);
  const visionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostJpegCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostJpegFallbackRef = useRef<{ enabled: boolean; fps: number; maxWidth: number }>({
    enabled: false,
    fps: 10,
    maxWidth: 320,
  });
  const hostStreamRef = useRef<MediaStream | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const bridgeRef = useRef<RoverWebRtcBridge | null>(null);
  const scannerRef = useRef<WifiTankScanner | null>(null);
  const advertiserRef = useRef<WifiTankAdvertiser | null>(null);
  const vrSessionRef = useRef<QuestVrCockpitSession | null>(null);
  const vrHudRef = useRef<VrHudState | null>(null);
  const vrMotorsRef = useRef<{ left: number; right: number; steer: number }>({
    left: 0,
    right: 0,
    steer: 0,
  });
  const vrWasDrivingRef = useRef(false);
  const lastVrInterveningRef = useRef<string>("none");
  const xboxRef = useRef(new XboxControllerReader());
  const driveCtrlRef = useRef(new IntelligentDriveController());
  const explorerRef = useRef(new IntelligentExplorer());
  const mapperRef = useRef(new RoomMapper());
  const headingTrackerRef = useRef(new FoldHeadingTracker());
  const floorModelRef = useRef(createFloorModel());
  const recorderRef = useRef(new FlightRecorder(loadMountCalibration()));
  const aiDetectorRef = useRef(new OnDeviceObjectDetector());
  const prevLumaRef = useRef<Uint8Array | null>(null);
  const hsvLockRef = useRef<HsvLockModel | null>(null);
  const lockedLabelRef = useRef<string | null>(null);
  const latestVisionRef = useRef<RoverVisionSnapshot | null>(null);
  const latestAiBoxesRef = useRef<DetectedObjectBox[]>([]);
  const lastAiRunRef = useRef<number>(0);
  const lastMapPushRef = useRef<number>(0);
  const lastLoopMsRef = useRef<number>(0);
  const lastAutoTorchSwitchRef = useRef<number>(0);
  const tagToastTimerRef = useRef<number | null>(null);
  const hostAssistNoteRef = useRef<string>("Smart Co-Pilot ready");
  const hostInterveningRef = useRef<string>("none");
  const hostDriverInputRef = useRef<{ steer: number; throttle: number; at: number }>({
    steer: 0,
    throttle: 0,
    at: 0,
  });

  const touchPadRef = useRef<HTMLDivElement | null>(null);
  const touchDraggingRef = useRef(false);
  const touchVecRef = useRef({ x: 0, y: 0 });
  const keysRef = useRef<Set<string>>(new Set());
  const wasDrivingRef = useRef(false);
  const driveSeqRef = useRef(1);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceSeqRef = useRef(1);
  const discoverySeqRef = useRef(1);
  const autoJoinedRef = useRef(false);

  lockedLabelRef.current = lockedLabel;

  const liveRef = useRef({
    isActiveTab,
    connected,
    disabled,
    safeMode,
    headHomed,
    headDeg,
    pickedUp,
    distancePct,
    telemetry,
    headlightsOn,
    autoHeadlights,
    speedCap,
    assistMode,
    collisionGuard,
    headingHold,
    laneAssist,
    aiEnabled,
    mission,
    hostTorchSupported,
    phoneHeadingDeg,
    calibration,
    ttsEnabled,
  });
  liveRef.current = {
    isActiveTab,
    connected,
    disabled,
    safeMode,
    headHomed,
    headDeg,
    pickedUp,
    distancePct,
    telemetry,
    headlightsOn,
    autoHeadlights,
    speedCap,
    assistMode,
    collisionGuard,
    headingHold,
    laneAssist,
    aiEnabled,
    mission,
    hostTorchSupported,
    phoneHeadingDeg,
    calibration,
    ttsEnabled,
  };

  const cbRef = useRef({
    onDrive,
    onHead,
    onSynth,
    onSetHubLed,
    onSetMode,
    onPlayMacro,
    onStopMacro,
    onHeadlightsChange,
    onWifiStatusChange,
  });
  cbRef.current = {
    onDrive,
    onHead,
    onSynth,
    onSetHubLed,
    onSetMode,
    onPlayMacro,
    onStopMacro,
    onHeadlightsChange,
    onWifiStatusChange,
  };

  const isRemoteDriverLive =
    linkState === "connected" && bridgeRef.current?.getRole() === "driver-client";
  const hasAnyVideo = hasRemoteVideo || hasFallbackVideo;

  // Report Wi-Fi link & remote telemetry up to TopConsoleBar
  useEffect(() => {
    const base = transportMode === "relay" ? "Wi-Fi Relay Live" : "Wi-Fi FPV Live";
    const label = isRemoteDriverLive ? `${base}${pingMs ? ` · ${pingMs} ms` : ""}` : "";
    cbRef.current.onWifiStatusChange?.(isRemoteDriverLive, label, isRemoteDriverLive ? remoteTelemetry : null);
  }, [isRemoteDriverLive, pingMs, remoteTelemetry, transportMode]);

  // Update advertiser metadata whenever Bluetooth or camera readiness changes on Android Host
  useEffect(() => {
    if (!hostActive || !advertiserRef.current) return;
    advertiserRef.current.update({
      code: roomCode,
      bleConnected: connected,
      cameraReady: hostCameraActive,
    });
  }, [connected, hostActive, hostCameraActive, roomCode]);

  // Automatic Same-Wi-Fi Scanner on Chromebook Driver while unpaired!
  useEffect(() => {
    if (subView !== "driver" || isRemoteDriverLive) {
      scannerRef.current?.stop();
      scannerRef.current = null;
      return;
    }
    const scanner = new WifiTankScanner({
      onTanksChange: (list) => setDiscoveredTanks(list),
      onStatus: (st) => setDiscoveryStatus(st),
    });
    scannerRef.current = scanner;
    void scanner.start();
    return () => {
      scanner.stop();
      if (scannerRef.current === scanner) scannerRef.current = null;
    };
  }, [isRemoteDriverLive, subView]);

  // Lazy-load AI Object Detector when toggled ON on Host or Fold Auto-Pilot
  useEffect(() => {
    if (!aiEnabled) {
      setAiStatusNote(null);
      return;
    }
    if (subView === "fold" || subView === "host" || hostCameraActive) {
      setAiStatusNote("Loading on-device EfficientDet-Lite0 model…");
      void aiDetectorRef.current.load().then((ok) => {
        const del = aiDetectorRef.current.getDelegate();
        setAiStatusNote(
          ok
            ? `On-device AI Vision ready (80 classes · ${del ?? "GPU"})`
            : aiDetectorRef.current.getError() ?? "AI Vision unavailable offline"
        );
      });
    } else {
      setAiStatusNote("AI Vision requested on Android Phone");
    }
  }, [aiEnabled, hostCameraActive, subView]);

  // Reset Explorer FSM cleanly whenever switching into explorer or changing mission
  useEffect(() => {
    if (assistMode === "explorer") {
      explorerRef.current.reset();
    }
  }, [assistMode, mission]);

  // Sync PilotConfig to Android Phone Host whenever settings change while connected
  useEffect(() => {
    if (bridgeRef.current?.getRole() !== "driver-client" || !bridgeRef.current.isDataChannelOpen()) {
      return;
    }
    const config: PilotConfigPayload = {
      assistMode,
      collisionGuard,
      headingHold,
      laneAssist,
      aiEnabled,
      mission,
      speedCap,
    };
    bridgeRef.current.sendToRover({ type: "pilotConfig", config });
  }, [aiEnabled, assistMode, collisionGuard, headingHold, laneAssist, linkState, mission, speedCap]);

  // Apply Android rear-camera LED flashlight torch constraint when supported
  const applyHostTorch = useCallback(async (on: boolean) => {
    cbRef.current.onHeadlightsChange(on);
    const stream = hostStreamRef.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({
        advanced: [{ torch: on } as MediaTrackConstraintSet],
      });
    } catch {
      // ignore unsupported torch
    }
  }, []);

  const recordDiscovery = useCallback(
    (label: string, confidence: number, sourceEl: HTMLVideoElement | null) => {
      const pose = mapperRef.current.getPoseCm();
      const item: RoverDiscoveryItem = {
        id: `disc-${discoverySeqRef.current++}`,
        timestamp: Date.now(),
        label,
        confidence,
        thumbnailUrl: captureThumbnail(sourceEl),
        mapX: Math.round(pose.x),
        mapY: Math.round(pose.y),
      };
      setDiscoveries((prev) => [item, ...prev.slice(0, 11)]);
      if (bridgeRef.current?.getRole() === "rover-host" && bridgeRef.current.isDataChannelOpen()) {
        bridgeRef.current.sendToDriver({ type: "discovery", item });
      }
    },
    []
  );

  const handleResetMap = useCallback(() => {
    mapperRef.current.reset();
    explorerRef.current.reset();
    setRecoveries(0);
    setDiscoveries([]);
    setLocalMap(mapperRef.current.getSnapshot());
    setRemoteMap(null);
    if (bridgeRef.current?.getRole() === "driver-client" && bridgeRef.current.isDataChannelOpen()) {
      bridgeRef.current.sendToRover({ type: "clearMap" });
    }
  }, []);

  const handleTapSampleLocal = useCallback((normX: number, normY: number) => {
    const sourceEl = hostVideoRef.current && hostStreamRef.current ? hostVideoRef.current : null;
    if (!sourceEl) return;
    const vc = visionCanvasRef.current ?? document.createElement("canvas");
    vc.width = VISION_W;
    vc.height = VISION_H;
    visionCanvasRef.current = vc;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = vc.getContext("2d", { willReadFrequently: true });
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    try {
      ctx.drawImage(sourceEl, 0, 0, VISION_W, VISION_H);
      const img = ctx.getImageData(0, 0, VISION_W, VISION_H);
      const model = sampleHsvTarget(img.data, VISION_W, VISION_H, normX, normY);
      if (model) {
        hsvLockRef.current = model;
        setLockedLabel(model.label);
        setAssistMode("copilot");
        setAssistNote("Locked color target — hands off stick to follow!");
      }
    } catch {
      // ignore unready frame
    }
  }, []);

  // Initialize singleton WebRTC bridge (lives across station tab switches!)
  useEffect(() => {
    const attachStreamToVideoEl = (stream: MediaStream) => {
      if (bridgeRef.current?.getTransportMode() === "relay") return;
      const vid = remoteVideoRef.current;
      if (!vid) return;
      if (vid.srcObject !== stream) {
        vid.srcObject = stream;
      }
      void vid.play().catch(() => undefined);
      if (vid.videoWidth > 16 && vid.videoHeight > 16 && bridgeRef.current?.getTransportMode() === "webrtc") {
        setHasRemoteVideo(true);
      }
    };

    const bridge = new RoverWebRtcBridge({
      onStateChange: (st, detail) => {
        const mode = bridge.getTransportMode();
        setLinkState(st);
        setTransportMode(mode);
        if (detail) setLinkDetail(detail);
        if (st === "connected") {
          if (mode === "relay") {
            remoteStreamRef.current = null;
            if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
            setHasRemoteVideo(false);
          } else if (remoteStreamRef.current) {
            attachStreamToVideoEl(remoteStreamRef.current);
          }
        } else {
          setPingMs(null);
          hostJpegFallbackRef.current.enabled = false;
          if (st === "idle" || st === "waiting-peer" || st === "error") {
            remoteStreamRef.current = null;
            if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
            setHasRemoteVideo(false);
            setHasFallbackVideo(false);
            if (st === "idle") {
              setRemoteTelemetry(null);
              setRemoteBleOk(false);
              setRemoteVision(null);
              setRemoteMap(null);
            }
          }
        }
      },
      onDiagnostics: (diag) => {
        setBridgeDiag(diag);
        setTransportMode(diag.transport);
      },
      onRemoteStream: (stream) => {
        remoteStreamRef.current = stream;
        attachStreamToVideoEl(stream);
        for (const track of stream.getVideoTracks()) {
          track.onunmute = () => {
            attachStreamToVideoEl(stream);
          };
        }
      },
      onFailsafeStop: () => {
        hostDriverInputRef.current = { steer: 0, throttle: 0, at: 0 };
        if (liveRef.current.connected) {
          cbRef.current.onDrive(0, 0, 200);
        }
      },
      onDriverMessage: (msg: DriverToRoverMessage) => {
        if (msg.type === "ping") {
          bridge.sendToDriver({ type: "pong", sentAt: msg.sentAt });
          return;
        }
        if (msg.type === "videoFallback") {
          hostJpegFallbackRef.current = {
            enabled: msg.enabled,
            fps: Math.max(2, Math.min(15, msg.fps ?? 10)),
            maxWidth: Math.max(160, Math.min(400, msg.maxWidth ?? 320)),
          };
          return;
        }
        if (msg.type === "stop") {
          hostDriverInputRef.current = { steer: 0, throttle: 0, at: 0 };
          hsvLockRef.current = null;
          setLockedLabel(null);
          if (liveRef.current.assistMode === "explorer") {
            setAssistMode("copilot");
          }
          explorerRef.current.reset();
          cbRef.current.onDrive(0, 0, 200);
          void cbRef.current.onStopMacro().catch(() => undefined);
          cbRef.current.onSynth(0, 0, 0);
          return;
        }
        if (msg.type === "headlights") {
          void applyHostTorch(msg.on);
          return;
        }
        if (msg.type === "clearMap") {
          mapperRef.current.reset();
          explorerRef.current.reset();
          setDiscoveries([]);
          setRecoveries(0);
          return;
        }
        if (msg.type === "pilotConfig") {
          const prevMode = liveRef.current.assistMode;
          setAssistMode(msg.config.assistMode);
          setCollisionGuard(msg.config.collisionGuard);
          setHeadingHold(msg.config.headingHold);
          setLaneAssist(msg.config.laneAssist);
          setAiEnabled(msg.config.aiEnabled);
          setMission(msg.config.mission);
          setSpeedCap(msg.config.speedCap);
          if (prevMode === "explorer" && msg.config.assistMode !== "explorer") {
            explorerRef.current.reset();
            hostInterveningRef.current = "none";
            hostAssistNoteRef.current = "Switched out of Auto Explorer";
            if (liveRef.current.connected) {
              cbRef.current.onDrive(0, 0, 200);
            }
          }
          return;
        }
        if (msg.type === "tapTrack") {
          handleTapSampleLocal(msg.normX, msg.normY);
          return;
        }
        if (msg.type === "lockObject") {
          hsvLockRef.current = null;
          setLockedLabel(msg.label);
          return;
        }
        if (!liveRef.current.connected || liveRef.current.disabled) return;
        switch (msg.type) {
          case "drive": {
            const st = liveRef.current;
            const manualSteer = msg.steer ?? 0;
            const manualThrottle = msg.throttle ?? 0;
            const movingManually = Math.abs(manualSteer) > 0.06 || Math.abs(manualThrottle) > 0.06;
            hostDriverInputRef.current = {
              steer: manualSteer,
              throttle: manualThrottle,
              at: Date.now(),
            };
            if (movingManually && st.assistMode === "explorer") {
              setAssistMode("copilot");
            }
            if (st.assistMode === "copilot" || (movingManually && st.assistMode === "explorer")) {
              const vis = latestVisionRef.current;
              const res = driveCtrlRef.current.step({
                rawSteer: manualSteer,
                rawThrottle: manualThrottle,
                speedCap: st.speedCap,
                frontDistancePct: st.distancePct,
                corridors: vis?.corridors ?? [0.8, 0.8, 0.8, 0.8, 0.8],
                pickedUp: st.pickedUp,
                safeMode: st.safeMode,
                headingDeg: st.phoneHeadingDeg,
                encA: st.telemetry?.encA ?? 0,
                encB: st.telemetry?.encB ?? 0,
                collisionGuard: st.collisionGuard,
                headingHold: st.headingHold,
                laneAssist: st.laneAssist,
                laneOffset: vis?.laneOffset ?? null,
                lockedTarget: vis?.lockedTarget ?? null,
              });
              hostAssistNoteRef.current = res.statusNote;
              hostInterveningRef.current = res.intervening;
              setAssistNote(res.statusNote);
              setAssistIntervening(res.intervening);
              cbRef.current.onDrive(res.left, res.right, msg.timeoutMs);
            } else {
              hostAssistNoteRef.current = "Manual FPV drive";
              hostInterveningRef.current = "none";
              cbRef.current.onDrive(msg.left, msg.right, msg.timeoutMs);
            }
            break;
          }
          case "turret":
            if (liveRef.current.headHomed) {
              cbRef.current.onHead(msg.angleDeg, 55, true);
            }
            break;
          case "synth":
            cbRef.current.onSynth(msg.voice, msg.presetOrNote, msg.durMs);
            break;
          case "hubLed":
            cbRef.current.onSetHubLed(msg.r, msg.g, msg.b);
            break;
          case "setMode":
            cbRef.current.onSetMode(msg.modeId);
            break;
        }
      },
      onRoverMessage: (msg: RoverToDriverMessage) => {
        if (msg.type === "pong") {
          setPingMs(Math.max(1, Math.round(Date.now() - msg.sentAt)));
          return;
        }
        if (msg.type === "jpegFrame") {
          if (fallbackImgBusyRef.current) return;
          const canvas = fallbackCanvasRef.current;
          if (!canvas || !msg.dataUrl) return;
          fallbackImgBusyRef.current = true;
          const img = new Image();
          img.onload = () => {
            fallbackImgBusyRef.current = false;
            const c = fallbackCanvasRef.current;
            if (!c) return;
            if (c.width !== msg.width || c.height !== msg.height) {
              c.width = msg.width;
              c.height = msg.height;
            }
            const ctx = c.getContext("2d");
            if (ctx) {
              ctx.drawImage(img, 0, 0, c.width, c.height);
              setHasFallbackVideo(true);
            }
          };
          img.onerror = () => {
            fallbackImgBusyRef.current = false;
          };
          img.src = msg.dataUrl;
          return;
        }
        if (msg.type === "state") {
          setRemoteTelemetry(msg.telemetry);
          setRemoteBleOk(msg.bleConnected);
          setRemoteHeading(msg.phoneHeadingDeg);
          setRemoteTorchAvail(msg.torchSupported);
          setRemoteVision(msg.vision);
          setRemoteAssistNote(msg.assistNote);
          setRemoteAssistIntervening(msg.assistIntervening ?? "none");
          setRemoteExplorerState(msg.explorerState);
          if (typeof msg.recoveries === "number") {
            setRecoveries(msg.recoveries);
          }
          cbRef.current.onHeadlightsChange(msg.headlightsOn);
          return;
        }
        if (msg.type === "map") {
          setRemoteMap(msg.snapshot);
          return;
        }
        if (msg.type === "discovery") {
          setDiscoveries((prev) => [msg.item, ...prev.slice(0, 11)]);
        }
      },
    });
    bridgeRef.current = bridge;

    // Auto-join immediately if launched with ?join=CODE link!
    if (initParams.autoJoin && initParams.joinCode && !autoJoinedRef.current) {
      autoJoinedRef.current = true;
      void bridge.startDriver(initParams.joinCode).catch(() => undefined);
    }

    return () => {
      bridge.stop();
      bridgeRef.current = null;
    };
  }, [applyHostTorch, handleTapSampleLocal, initParams.autoJoin, initParams.joinCode]);

  // Re-attach live MediaStream whenever switching back to Fold, Driver, or Host subViews
  useEffect(() => {
    if (subView === "driver" && remoteStreamRef.current && remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
      void remoteVideoRef.current.play().catch(() => undefined);
    }
    if ((subView === "host" || subView === "fold") && hostStreamRef.current && hostVideoRef.current) {
      hostVideoRef.current.srcObject = hostStreamRef.current;
      void hostVideoRef.current.play().catch(() => undefined);
    }
  }, [subView, hostCameraActive, linkState]);

  // Driver: Automatically activate Stage-3A JPEG-over-DataChannel if native WebRTC <video>
  // stays blank for > 3s (fixes older Android MediaCodec H.264/VP8 quirks), and turn it off
  // as soon as native WebRTC video frames arrive!
  useEffect(() => {
    if (!isRemoteDriverLive || !bridgeRef.current) return;
    if (transportMode === "relay") {
      bridgeRef.current.sendToRover({ type: "videoFallback", enabled: true, fps: 7, maxWidth: 288 });
      return;
    }
    if (hasRemoteVideo) {
      setHasFallbackVideo(false);
      bridgeRef.current.sendToRover({ type: "videoFallback", enabled: false });
      return;
    }
    const timer = window.setTimeout(() => {
      const vid = remoteVideoRef.current;
      if (vid && vid.videoWidth > 16 && vid.videoHeight > 16) {
        setHasRemoteVideo(true);
        return;
      }
      if (vid && remoteStreamRef.current) {
        void vid.play().catch(() => undefined);
      }
      bridgeRef.current?.sendToRover({ type: "videoFallback", enabled: true, fps: 12, maxWidth: 320 });
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [hasRemoteVideo, isRemoteDriverLive, transportMode]);

  // Android Host: Stream compact JPEG frames when Driver requests Compatible / Relay video fallback
  useEffect(() => {
    if (!hostActive) return;
    let lastSentAt = 0;
    const id = window.setInterval(() => {
      const cfg = hostJpegFallbackRef.current;
      if (!cfg.enabled) return;
      const bridge = bridgeRef.current;
      if (!bridge || bridge.getRole() !== "rover-host" || !bridge.isDataChannelOpen()) return;
      if (bridge.isSendBackpressured()) return;

      const now = Date.now();
      const minIntervalMs = Math.round(1000 / cfg.fps);
      if (now - lastSentAt < minIntervalMs) return;

      const video = hostVideoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return;

      const targetW = Math.min(cfg.maxWidth, video.videoWidth);
      const targetH = Math.max(90, Math.round((video.videoHeight / video.videoWidth) * targetW));
      const c = hostJpegCanvasRef.current ?? document.createElement("canvas");
      if (c.width !== targetW || c.height !== targetH) {
        c.width = targetW;
        c.height = targetH;
      }
      hostJpegCanvasRef.current = c;
      const ctx = c.getContext("2d");
      if (!ctx) return;

      try {
        ctx.drawImage(video, 0, 0, targetW, targetH);
        const quality = bridge.getTransportMode() === "relay" ? 0.46 : 0.58;
        const dataUrl = c.toDataURL("image/jpeg", quality);
        lastSentAt = now;
        bridge.sendToDriver({
          type: "jpegFrame",
          dataUrl,
          width: targetW,
          height: targetH,
          ts: now,
        });
      } catch {
        // ignore unready video frame
      }
    }, 75);
    return () => window.clearInterval(id);
  }, [hostActive]);

  // Unified 10 Hz On-Device Vision + 2D Room Mapping + Co-Pilot + Smooth Continuous Auto Explorer + Flight Recorder!
  // Runs in BOTH zero-WiFi Pixel Fold 90° Auto-Pilot mode (hostCameraActive) AND Wi-Fi FPV Host mode (hostActive).
  const onBoardLoopActive = hostActive || hostCameraActive;
  useEffect(() => {
    if (!onBoardLoopActive) return;
    const vc = visionCanvasRef.current ?? document.createElement("canvas");
    vc.width = VISION_W;
    vc.height = VISION_H;
    visionCanvasRef.current = vc;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = vc.getContext("2d", { willReadFrequently: true });
    } catch {
      ctx = null;
    }

    const id = window.setInterval(() => {
      const tStart = performance.now();
      const video = hostVideoRef.current;
      const st = liveRef.current;
      const now = Date.now();
      const dtMs = lastLoopMsRef.current > 0 ? Math.max(20, Math.min(350, now - lastLoopMsRef.current)) : 100;
      lastLoopMsRef.current = now;

      let corridors: [number, number, number, number, number] = [0.85, 0.85, 0.85, 0.85, 0.85];
      let horizonYs: [number, number, number, number, number] = [0.5, 0.5, 0.5, 0.5, 0.5];
      let sweptClear = 0.85;
      let bestSteer = 0;
      let floorRgb: [number, number, number] = [140, 130, 115];
      let floorNoise = 12;
      let avgLuma = 128;
      let floorPatch: { x: number; y: number; w: number; h: number } | undefined;
      let flowForward = 0;
      let flowTurn = 0;
      let flowConfidence = 0;
      let validFlowPatches = 0;
      let laneOffset: number | null = null;
      const objects: DetectedObjectBox[] = [];
      let lockedTarget: DetectedObjectBox | null = null;

      if (ctx && video && video.readyState >= 2) {
        // Freeze persistent floor model ONLY on physical 88007 proximity (<= 35%) or pickup.
        // Never gate on sweptClear (which causes a self-reinforcing deadlock after camera AE shifts!);
        // roverVision's own chroma/texture check already rejects smooth walls entering the floor patch.
        const safeToLearnFloor = st.distancePct > 35 && !st.pickedUp;
        ctx.drawImage(video, 0, 0, VISION_W, VISION_H);
        const img = ctx.getImageData(0, 0, VISION_W, VISION_H);
        const floor = analyzeFloorCorridors(img.data, VISION_W, VISION_H, {
          calibration: st.calibration,
          floorModel: floorModelRef.current,
          allowFloorUpdate: safeToLearnFloor,
        });
        const flow = computeOpticalFlow(prevLumaRef.current, img.data, VISION_W, VISION_H);
        prevLumaRef.current = flow.luma;
        corridors = floor.corridors;
        horizonYs = floor.horizonYs;
        sweptClear = floor.sweptClear;
        bestSteer = floor.bestSteer;
        floorRgb = floor.floorRgb;
        floorNoise = floor.floorNoise;
        avgLuma = floor.avgLuma;
        floorPatch = floor.floorPatch;
        flowForward = flow.flowForward;
        flowTurn = flow.flowTurn;
        flowConfidence = flow.confidence;
        validFlowPatches = flow.validPatches;
        laneOffset = st.laneAssist ? detectFloorLaneOffset(img.data, VISION_W, VISION_H) : null;

        // Auto-Headlights in dim rooms / under furniture (with 5 s hysteresis so LED never flickers)
        if (st.autoHeadlights && st.hostTorchSupported && now - lastAutoTorchSwitchRef.current > 5000) {
          if (!st.headlightsOn && avgLuma < 44) {
            lastAutoTorchSwitchRef.current = now;
            void applyHostTorch(true);
          } else if (st.headlightsOn && avgLuma > 96) {
            lastAutoTorchSwitchRef.current = now;
            void applyHostTorch(false);
          }
        }

        if (st.aiEnabled && aiDetectorRef.current.isReady() && now - lastAiRunRef.current >= 220) {
          lastAiRunRef.current = now;
          latestAiBoxesRef.current = aiDetectorRef.current.detectVideo(video, performance.now());
        } else if (!st.aiEnabled) {
          latestAiBoxesRef.current = [];
        }

        objects.push(...latestAiBoxesRef.current);
        if (hsvLockRef.current) {
          const tracked = trackHsvTarget(img.data, VISION_W, VISION_H, hsvLockRef.current);
          if (tracked) {
            objects.push(tracked);
            lockedTarget = tracked;
          }
        } else if (lockedLabelRef.current) {
          lockedTarget = objects.find((b) => b.label === lockedLabelRef.current) ?? null;
        }
      }

      const headingSnap = headingTrackerRef.current.getSnapshot();
      const activeHeadingDeg = headingSnap.headingDeg ?? st.phoneHeadingDeg;

      // Update live 2D Occupancy Room Map (with speedA/speedB fallback past ±32767° int16 clamp!)
      mapperRef.current.update({
        encA: st.telemetry?.encA ?? 0,
        encB: st.telemetry?.encB ?? 0,
        speedA: st.telemetry?.speedA,
        speedB: st.telemetry?.speedB,
        dtMs,
        gyroHeadingDeg: activeHeadingDeg,
        frontDistancePct: st.distancePct,
        corridors,
        camOffsetCm: st.calibration.camOffsetCm,
      });

      const driverIdle = now - hostDriverInputRef.current.at > 280;
      let noteOut = driverIdle
        ? lockedTarget
          ? `Following ${lockedTarget.label}`
          : "On-Board Auto-Pilot ready"
        : hostAssistNoteRef.current;
      let interveningOut = driverIdle ? "none" : hostInterveningRef.current;
      let fsmOut = "IDLE";
      let stuckNow = false;
      let cmdLeft = 0;
      let cmdRight = 0;
      let cmdSteer = 0;
      let cmdThrottle = 0;
      let discoveryLabel: string | undefined;
      let lowBatteryFlag = false;
      let stuckReason: string | undefined;

      if (st.connected && !st.disabled && st.assistMode === "explorer") {
        const expRes = explorerRef.current.step({
          nowMs: now,
          mission: st.mission,
          speedCap: st.speedCap,
          pickedUp: st.pickedUp,
          safeMode: st.safeMode,
          bump: Boolean(st.telemetry && (st.telemetry.flags & TelemetryFlag.BUMP)),
          frontDistancePct: st.distancePct,
          corridors,
          sweptClear,
          bestSteer,
          flowForward,
          flowTurn,
          flowConfidence,
          headingDeg: activeHeadingDeg,
          yawRateDegS: headingSnap.yawRateDegS,
          encA: st.telemetry?.encA ?? 0,
          encB: st.telemetry?.encB ?? 0,
          speedA: st.telemetry?.speedA,
          speedB: st.telemetry?.speedB,
          batteryMv: st.telemetry?.batteryMv,
          objects,
          mapper: mapperRef.current,
        });
        fsmOut = expRes.state;
        noteOut = expRes.statusNote;
        interveningOut =
          expRes.state === "AVOIDING" || expRes.state === "UNSTICKING" ? "dodging" : "none";
        stuckNow = expRes.state === "UNSTICKING";
        cmdLeft = expRes.left;
        cmdRight = expRes.right;
        cmdSteer = expRes.steer;
        cmdThrottle = expRes.throttle;
        lowBatteryFlag = Boolean(expRes.lowBattery);
        stuckReason = expRes.stuckReason;
        hostAssistNoteRef.current = noteOut;
        hostInterveningRef.current = interveningOut;
        setExplorerState(expRes.state);
        setAssistNote(expRes.statusNote);
        setAssistIntervening(interveningOut);
        setRecoveries(expRes.recoveries);
        setFoldMotorCmd({ left: expRes.left, right: expRes.right, steer: expRes.steer });

        // 750ms watchdog timeout prevents jerky Move Hub motor stops on any camera/AI frame hiccup!
        // Only play synth when actually stopped (e.g. MISSION_COMPLETE) so motor coils never stutter!
        cbRef.current.onDrive(expRes.left, expRes.right, 750);
        if (expRes.synthSfx && expRes.left === 0 && expRes.right === 0) {
          cbRef.current.onSynth(0, expRes.synthSfx, 0);
        }
        if (expRes.discovery) {
          discoveryLabel = expRes.discovery.label;
          recordDiscovery(expRes.discovery.label, expRes.discovery.confidence, video);
        }
      } else if (st.connected && !st.disabled && st.assistMode === "copilot" && driverIdle && lockedTarget) {
        const res = driveCtrlRef.current.step({
          rawSteer: 0,
          rawThrottle: 0,
          speedCap: st.speedCap,
          frontDistancePct: st.distancePct,
          corridors,
          pickedUp: st.pickedUp,
          safeMode: st.safeMode,
          headingDeg: activeHeadingDeg,
          encA: st.telemetry?.encA ?? 0,
          encB: st.telemetry?.encB ?? 0,
          collisionGuard: st.collisionGuard,
          headingHold: st.headingHold,
          laneAssist: false,
          laneOffset: null,
          lockedTarget,
        });
        noteOut = res.statusNote;
        interveningOut = res.intervening;
        cmdLeft = res.left;
        cmdRight = res.right;
        cmdSteer = res.effectiveSteer;
        cmdThrottle = res.effectiveThrottle;
        hostAssistNoteRef.current = noteOut;
        hostInterveningRef.current = interveningOut;
        setAssistNote(res.statusNote);
        setAssistIntervening(res.intervening);
        setFoldMotorCmd({ left: res.left, right: res.right, steer: res.effectiveSteer });
        cbRef.current.onDrive(res.left, res.right, 550);
      } else {
        setFoldMotorCmd((prev) => (prev.left === 0 && prev.right === 0 ? prev : { left: 0, right: 0, steer: 0 }));
      }

      const elapsedMs = Number((performance.now() - tStart).toFixed(1));
      setVisionMs(elapsedMs);

      const snapshot: RoverVisionSnapshot = {
        corridors,
        horizonYs,
        sweptClear,
        bestSteer,
        flowForward,
        flowTurn,
        flowConfidence,
        validFlowPatches,
        stuck: stuckNow,
        floorRgb,
        floorNoise,
        avgLuma,
        floorPatch,
        laneOffset,
        lockedTarget,
        objects,
        aiReady: aiDetectorRef.current.isReady(),
      };
      latestVisionRef.current = snapshot;
      setLocalVision(snapshot);

      // Record Black-Box telemetry tick when recording is active
      if (recorderRef.current.isRecording()) {
        const pose = mapperRef.current.getPoseCm();
        const mapSnapNow = mapperRef.current.getSnapshot();
        recorderRef.current.recordTick(
          {
            assistMode: st.assistMode,
            mission: st.mission,
            fsmState: fsmOut,
            statusNote: noteOut,
            corridors,
            horizonYs,
            sweptClear,
            bestSteer,
            floorRgb,
            floorNoise,
            avgLuma,
            floorPatch,
            flowForward,
            flowTurn,
            flowConfidence,
            validPatches: validFlowPatches,
            objects: objects.map((o) => ({
              label: o.label,
              score: Number(o.score.toFixed(2)),
              x: Number(o.x.toFixed(3)),
              y: Number(o.y.toFixed(3)),
              w: Number(o.w.toFixed(3)),
              h: Number(o.h.toFixed(3)),
              source: o.source,
            })),
            hw: {
              bleConnected: st.connected,
              batteryMv: st.telemetry?.batteryMv ?? null,
              distPct: st.distancePct <= 100 ? st.distancePct : null,
              colorId: st.telemetry?.colorId ?? null,
              pitch: st.telemetry?.pitchDeg ?? null,
              roll: st.telemetry?.rollDeg ?? null,
              flags: st.telemetry?.flags ?? null,
              bump: Boolean(st.telemetry && (st.telemetry.flags & TelemetryFlag.BUMP)),
              pickedUp: st.pickedUp,
              safeMode: st.safeMode,
              sensorOk: Boolean(st.telemetry && (st.telemetry.flags & TelemetryFlag.SENSOR_OK)),
              encA: st.telemetry?.encA ?? 0,
              encB: st.telemetry?.encB ?? 0,
              speedA: st.telemetry?.speedA ?? 0,
              speedB: st.telemetry?.speedB ?? 0,
            },
            phone: {
              headingDeg: activeHeadingDeg,
              yawRateDegS: headingSnap.yawRateDegS,
              headingSource: headingSnap.source,
              mountPitchDeg: headingSnap.mountPitchDeg,
              mountRollDeg: headingSnap.mountRollDeg,
              rawAlpha: headingSnap.rawAlpha,
              rawBeta: headingSnap.rawBeta,
              rawGamma: headingSnap.rawGamma,
              torchOn: st.headlightsOn,
              visionMs: elapsedMs,
              aiReady: aiDetectorRef.current.isReady(),
            },
            map: {
              xCm: Math.round(pose.x),
              yCm: Math.round(pose.y),
              headingDeg: Math.round(pose.headingDeg),
              frontierBias: Number(mapperRef.current.getFrontierBias().toFixed(2)),
              coveragePct: mapSnapNow.coveragePct,
              distanceM: mapSnapNow.distanceMeters,
              encSaturated: mapperRef.current.isEncoderSaturated(),
            },
            cmd: {
              left: cmdLeft,
              right: cmdRight,
              steer: Number(cmdSteer.toFixed(2)),
              throttle: Number(cmdThrottle.toFixed(2)),
              recoveries: explorerRef.current.getRecoveries(),
            },
          },
          video,
          { discoveryLabel, lowBattery: lowBatteryFlag, stuckReason }
        );
      }

      const isHostLive =
        bridgeRef.current?.getRole() === "rover-host" && bridgeRef.current.isDataChannelOpen();

      if (now - lastMapPushRef.current >= 450) {
        lastMapPushRef.current = now;
        const mapSnap = mapperRef.current.getSnapshot();
        setLocalMap(mapSnap);
        if (recorderRef.current.isRecording()) {
          setRunStats(recorderRef.current.getStats(mapSnap));
        }
        if (isHostLive) {
          bridgeRef.current!.sendToDriver({ type: "map", snapshot: mapSnap });
        }
      }

      if (isHostLive) {
        bridgeRef.current!.sendToDriver({
          type: "state",
          telemetry: st.telemetry,
          bleConnected: st.connected,
          headlightsOn: st.headlightsOn,
          torchSupported: st.hostTorchSupported,
          phoneHeadingDeg: activeHeadingDeg,
          assistNote: noteOut,
          assistIntervening: interveningOut,
          explorerState: fsmOut,
          recoveries: explorerRef.current.getRecoveries(),
          vision: snapshot,
          sentAt: now,
        });
      }
    }, 100);

    return () => window.clearInterval(id);
  }, [applyHostTorch, onBoardLoopActive, recordDiscovery]);

  // Driver Client: 1 Hz RTT ping monitor
  useEffect(() => {
    if (linkState !== "connected" || bridgeRef.current?.getRole() !== "driver-client") return;
    const id = window.setInterval(() => {
      bridgeRef.current?.sendToRover({ type: "ping", sentAt: Date.now() });
    }, 1200);
    return () => window.clearInterval(id);
  }, [linkState]);

  // Gimbal-lock-free Pixel Fold / Android IMU heading listener (devicemotion gravity-projected gyro + matrix fallback)
  const imuActive = hostActive || hostCameraActive || subView === "fold";
  useEffect(() => {
    if (!imuActive) return;
    let lastEmit = 0;

    const emitSnapshot = (snap: FoldHeadingSnapshot) => {
      const now = Date.now();
      if (now - lastEmit < 100) return;
      lastEmit = now;
      setFoldHeading(snap);
      if (snap.headingDeg !== null) {
        setPhoneHeadingDeg(snap.headingDeg);
      }
    };

    const onMotion = (ev: DeviceMotionEvent) => {
      const snap = headingTrackerRef.current.ingestMotion({
        nowMs: Date.now(),
        ax: ev.accelerationIncludingGravity?.x,
        ay: ev.accelerationIncludingGravity?.y,
        az: ev.accelerationIncludingGravity?.z,
        rotBeta: ev.rotationRate?.beta,
        rotGamma: ev.rotationRate?.gamma,
        rotAlpha: ev.rotationRate?.alpha,
        intervalMs: ev.interval,
      });
      emitSnapshot(snap);
    };

    const onOrient = (ev: DeviceOrientationEvent) => {
      const snap = headingTrackerRef.current.ingestOrientation({
        alpha: ev.alpha,
        beta: ev.beta,
        gamma: ev.gamma,
      });
      emitSnapshot(snap);
    };

    window.addEventListener("devicemotion", onMotion);
    window.addEventListener("deviceorientation", onOrient);
    return () => {
      window.removeEventListener("devicemotion", onMotion);
      window.removeEventListener("deviceorientation", onOrient);
    };
  }, [imuActive]);

  // Re-acquire Screen Wake Lock if Android returns from background / notification shade
  useEffect(() => {
    if (!onBoardLoopActive) return;
    const onVis = () => {
      if (document.visibilityState !== "visible" || wakeLockRef.current) return;
      const navWithWake = navigator as unknown as {
        wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> };
      };
      if (navWithWake.wakeLock) {
        void navWithWake.wakeLock
          .request("screen")
          .then((lock) => {
            wakeLockRef.current = lock;
            setHostWakeLocked(true);
          })
          .catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [onBoardLoopActive]);

  const stopHostCamera = useCallback(() => {
    advertiserRef.current?.stop();
    advertiserRef.current = null;
    bridgeRef.current?.stop();
    const s = hostStreamRef.current;
    hostStreamRef.current = null;
    if (s) s.getTracks().forEach((t) => t.stop());
    if (hostVideoRef.current) hostVideoRef.current.srcObject = null;
    if (liveRef.current.assistMode === "explorer") {
      explorerRef.current.reset();
      setAssistMode("copilot");
      if (liveRef.current.connected) {
        cbRef.current.onDrive(0, 0, 200);
      }
    }
    setHostActive(false);
    setHostCameraActive(false);
    setHostTorchSupported(false);
    setHostDiscoveryNote("Auto-discovery activates once you start hosting");
    if (wakeLockRef.current) {
      void wakeLockRef.current.release().catch(() => undefined);
      wakeLockRef.current = null;
      setHostWakeLocked(false);
    }
  }, []);

  const openLocalRearCamera = useCallback(async (preferredDeviceId?: string): Promise<MediaStream | null> => {
    setHostCameraError(null);
    // Stop any previous camera track cleanly before switching lenses
    const prev = hostStreamRef.current;
    if (prev) {
      prev.getTracks().forEach((t) => t.stop());
      hostStreamRef.current = null;
    }

    let stream: MediaStream | null = null;
    if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
      const candidates: MediaStreamConstraints[] = [];
      if (preferredDeviceId) {
        candidates.push({
          video: {
            deviceId: { exact: preferredDeviceId },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 24 },
          },
          audio: false,
        });
      }
      candidates.push(
        {
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 24 },
          },
          audio: false,
        },
        {
          video: { facingMode: "environment" },
          audio: false,
        },
        {
          video: true,
          audio: false,
        }
      );

      let lastCamErr: unknown = null;
      for (const constraints of candidates) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          break;
        } catch (err) {
          lastCamErr = err;
        }
      }

      if (stream) {
        hostStreamRef.current = stream;
        if (hostVideoRef.current) {
          hostVideoRef.current.srcObject = stream;
          await hostVideoRef.current.play().catch(() => undefined);
        }
        setHostCameraActive(true);
        const track = stream.getVideoTracks()[0];
        const caps = track?.getCapabilities ? (track.getCapabilities() as { torch?: boolean }) : {};
        setHostTorchSupported(Boolean(caps.torch));

        // Enumerate rear camera lenses (e.g. Pixel Fold Wide vs Ultrawide if exposed by Chrome)
        if (navigator.mediaDevices.enumerateDevices) {
          void navigator.mediaDevices
            .enumerateDevices()
            .then((devs) => {
              const cams = devs
                .filter((d) => d.kind === "videoinput")
                .filter((d) => !/front|user/i.test(d.label || ""))
                .map((d, i) => ({
                  deviceId: d.deviceId,
                  label: d.label || `Rear Lens ${i + 1}`,
                }));
              setRearCameras(cams);
            })
            .catch(() => undefined);
        }
      } else if (lastCamErr) {
        setHostCameraError(
          `Camera note: ${lastCamErr instanceof Error ? lastCamErr.message : String(lastCamErr)}`
        );
      }
    }

    const navWithWake = navigator as unknown as {
      wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> };
    };
    if (navWithWake.wakeLock && !wakeLockRef.current) {
      try {
        wakeLockRef.current = await navWithWake.wakeLock.request("screen");
        setHostWakeLocked(true);
      } catch {
        setHostWakeLocked(false);
      }
    }

    return stream;
  }, []);

  /** Single-device Pixel Fold 90° camera start — ZERO Wi-Fi / WebRTC / MQTT overhead! */
  const startFoldCameraOnly = useCallback(
    async (preferredDeviceId?: string) => {
      await openLocalRearCamera(preferredDeviceId ?? liveRef.current.calibration.cameraDeviceId);
    },
    [openLocalRearCamera]
  );

  const startHostCameraAndBroadcast = useCallback(async () => {
    const stream = await openLocalRearCamera(liveRef.current.calibration.cameraDeviceId);
    try {
      await bridgeRef.current?.startHost(roomCode, stream);
      setHostActive(true);

      // Start Same-Wi-Fi Auto-Discovery advertiser so Chromebook finds this tank in ~1s!
      const adv = new WifiTankAdvertiser((st) => setHostDiscoveryNote(st));
      advertiserRef.current = adv;
      void adv.start({
        code: roomCode,
        bleConnected: liveRef.current.connected,
        cameraReady: Boolean(stream),
      });
    } catch (err) {
      setHostCameraError(err instanceof Error ? err.message : String(err));
    }
  }, [openLocalRearCamera, roomCode]);

  const handleCalibrationChange = useCallback((next: MountCalibration) => {
    setCalibration(next);
    saveMountCalibration(next);
    recorderRef.current.setCalibration(next);
  }, []);

  const handleRelearnFloor = useCallback(() => {
    floorModelRef.current = createFloorModel();
    setAssistNote("Floor model reset — sampling clean floor now");
  }, []);

  const handleToggleRecording = useCallback(() => {
    setExportNotice(null);
    if (recorderRef.current.isRecording()) {
      recorderRef.current.stop(hostVideoRef.current);
      setRunStats(recorderRef.current.getStats(mapperRef.current.getSnapshot()));
      setExportNotice("Recording stopped — tap Share Run (.zip) or Contact Sheet (.png) to send feedback.");
    } else {
      recorderRef.current.start(liveRef.current.calibration);
      setRunStats(recorderRef.current.getStats(mapperRef.current.getSnapshot()));
    }
  }, []);

  const handleMarkProblem = useCallback((tag: ProblemTagKind) => {
    const ev = recorderRef.current.markProblem(tag, hostVideoRef.current);
    setRunStats(recorderRef.current.getStats(mapperRef.current.getSnapshot()));
    const meta = PROBLEM_TAGS.find((t) => t.id === tag);
    const sec = ev ? (ev.tMs / 1000).toFixed(1) : "0.0";
    setLastTagFeedback(`Marked "${meta?.label ?? tag}" @ ${sec}s (frame saved)`);
    if (tagToastTimerRef.current) {
      window.clearTimeout(tagToastTimerRef.current);
    }
    tagToastTimerRef.current = window.setTimeout(() => {
      setLastTagFeedback(null);
    }, 2600);
  }, []);

  const handleExportZip = useCallback(async (preferShare: boolean) => {
    setExportBusy(true);
    setExportNotice(null);
    try {
      const mapSnap = mapperRef.current.getSnapshot();
      const { filename, file } = await recorderRef.current.buildZipBundle(mapSnap);
      const outcome = await shareOrDownloadFile(file, "Vernie Pilot Field Run", preferShare);
      setExportNotice(
        outcome === "shared"
          ? `Opened Share Sheet for ${filename} (${Math.round(file.size / 1024)} KB) — upload into chat!`
          : `Downloaded ${filename} (${Math.round(file.size / 1024)} KB) — upload into chat!`
      );
    } catch (err) {
      setExportNotice(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExportBusy(false);
    }
  }, []);

  const handleExportContactSheet = useCallback(async () => {
    setExportBusy(true);
    setExportNotice(null);
    try {
      const mapSnap = mapperRef.current.getSnapshot();
      const pngUrl = await recorderRef.current.renderContactSheetPng(mapSnap);
      if (!pngUrl) {
        setExportNotice("Could not render contact sheet PNG on this browser.");
        return;
      }
      const res = await fetch(pngUrl);
      const blob = await res.blob();
      const file = new File([blob], `vernie-fold-sheet-${Date.now()}.png`, { type: "image/png" });
      const outcome = await shareOrDownloadFile(file, "Vernie Pilot Contact Sheet", true);
      setExportNotice(
        outcome === "shared"
          ? `Shared ${file.name} — upload into chat for frame-by-frame review!`
          : `Saved ${file.name} — upload into chat for frame-by-frame review!`
      );
    } catch (err) {
      setExportNotice(`Contact sheet failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExportBusy(false);
    }
  }, []);

  const handleCopySummary = useCallback(() => {
    const md = recorderRef.current.buildSummaryMarkdown(mapperRef.current.getSnapshot());
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard
        .writeText(md)
        .then(() => setExportNotice("Copied Markdown run report to clipboard — paste right into chat!"))
        .catch(() => setExportNotice("Clipboard blocked — use Share Run (.zip) instead."));
    } else {
      setExportNotice("Clipboard unavailable — use Share Run (.zip) instead.");
    }
  }, []);

  const handleClearRun = useCallback(() => {
    recorderRef.current.clear();
    setRunStats(recorderRef.current.getStats(mapperRef.current.getSnapshot()));
    setExportNotice(null);
  }, []);

  const handleToggleFoldExplore = useCallback(async () => {
    if (liveRef.current.assistMode === "explorer") {
      explorerRef.current.reset();
      setAssistMode("copilot");
      if (liveRef.current.connected) {
        cbRef.current.onDrive(0, 0, 200);
      }
      if (recorderRef.current.isRecording()) {
        recorderRef.current.stop(hostVideoRef.current);
        setRunStats(recorderRef.current.getStats(mapperRef.current.getSnapshot()));
        setExportNotice("Run paused & saved — tap Share Run (.zip) or Contact Sheet (.png)!");
      }
      return;
    }

    // Starting Auto Explore on Pixel Fold: auto-open rear camera & auto-start Black-Box Recorder!
    if (!hostStreamRef.current) {
      await startFoldCameraOnly();
    }
    floorModelRef.current = createFloorModel();
    explorerRef.current.reset();
    if (autoRecord && !recorderRef.current.isRecording()) {
      recorderRef.current.start(liveRef.current.calibration);
      setRunStats(recorderRef.current.getStats(mapperRef.current.getSnapshot()));
    }
    setExportNotice(null);
    setAssistMode("explorer");
  }, [autoRecord, startFoldCameraOnly]);

  const handleJoinCode = useCallback(async (rawCode: string) => {
    const code = normalizeRoomCode(rawCode);
    if (!code) return;
    setJoinCode(code);
    try {
      await bridgeRef.current?.startDriver(code);
    } catch {
      // Status shown in linkDetail
    }
  }, []);

  const fpvCanDrive = (isRemoteDriverLive && remoteBleOk) || (connected && !disabled);

  const sendFpvDrive = useCallback(
    (left: number, right: number, steer = 0, throttle = 0, timeoutMs = 450) => {
      if (bridgeRef.current?.getRole() === "driver-client" && bridgeRef.current.isDataChannelOpen()) {
        bridgeRef.current.sendToRover({
          type: "drive",
          left,
          right,
          steer,
          throttle,
          timeoutMs,
          seq: driveSeqRef.current++,
          sentAt: Date.now(),
        });
      } else if (liveRef.current.connected) {
        cbRef.current.onDrive(left, right, timeoutMs);
      }
    },
    []
  );

  const sendFpvStop = useCallback(() => {
    touchDraggingRef.current = false;
    touchVecRef.current = { x: 0, y: 0 };
    keysRef.current.clear();
    wasDrivingRef.current = false;
    hsvLockRef.current = null;
    setLockedLabel(null);
    if (recorderRef.current.isRecording() && liveRef.current.assistMode === "explorer") {
      recorderRef.current.markManualOverride(hostVideoRef.current);
      setRunStats(recorderRef.current.getStats(mapperRef.current.getSnapshot()));
    }
    if (liveRef.current.assistMode === "explorer") {
      setAssistMode("copilot");
    }
    setSteerVis(0);
    setThrottleVis(0);
    setFoldMotorCmd({ left: 0, right: 0, steer: 0 });
    driveCtrlRef.current.reset();
    explorerRef.current.reset();
    if (bridgeRef.current?.getRole() === "driver-client" && bridgeRef.current.isDataChannelOpen()) {
      bridgeRef.current.sendToRover({ type: "stop" });
    } else if (liveRef.current.connected) {
      cbRef.current.onDrive(0, 0, 200);
      cbRef.current.onSynth(0, 0, 0);
    }
  }, []);

  // Honor global TopConsoleBar Emergency STOP over Wi-Fi too!
  const lastStopSeqRef = useRef(emergencyStopSeq);
  useEffect(() => {
    if (emergencyStopSeq !== lastStopSeqRef.current) {
      lastStopSeqRef.current = emergencyStopSeq;
      sendFpvStop();
    }
  }, [emergencyStopSeq, sendFpvStop]);

  const toggleHeadlights = useCallback(() => {
    const next = !liveRef.current.headlightsOn;
    if (bridgeRef.current?.getRole() === "driver-client" && bridgeRef.current.isDataChannelOpen()) {
      bridgeRef.current.sendToRover({ type: "headlights", on: next });
      cbRef.current.onHeadlightsChange(next);
    } else {
      void applyHostTorch(next);
    }
  }, [applyHostTorch]);

  const sendHorn = useCallback(() => {
    if (bridgeRef.current?.getRole() === "driver-client" && bridgeRef.current.isDataChannelOpen()) {
      bridgeRef.current.sendToRover({ type: "synth", voice: 0, presetOrNote: 2, durMs: 0 });
    } else if (liveRef.current.connected && !liveRef.current.disabled) {
      cbRef.current.onSynth(0, 2, 0);
    }
  }, []);

  const selectOrToggleObject = useCallback((box: DetectedObjectBox | null) => {
    const nextLabel = box && box.label !== lockedLabelRef.current ? box.label : null;
    hsvLockRef.current = null;
    setLockedLabel(nextLabel);
    if (nextLabel) {
      setAssistMode("copilot");
      setAssistNote(`Locked on ${nextLabel} — hands off stick to follow`);
    } else {
      setAssistNote("Target unlocked");
    }
    if (bridgeRef.current?.getRole() === "driver-client" && bridgeRef.current.isDataChannelOpen()) {
      bridgeRef.current.sendToRover({ type: "lockObject", label: nextLabel });
    }
  }, []);

  const handleViewportClick = (ev: React.MouseEvent<HTMLDivElement>) => {
    if (!hasAnyVideo) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const normX = Math.max(0.05, Math.min(0.95, (ev.clientX - rect.left) / rect.width));
    const normY = Math.max(0.05, Math.min(0.95, (ev.clientY - rect.top) / rect.height));
    if (bridgeRef.current?.getRole() === "driver-client" && bridgeRef.current.isDataChannelOpen()) {
      bridgeRef.current.sendToRover({ type: "tapTrack", normX, normY });
      setAssistMode("copilot");
      setLockedLabel("Tapped Object");
    } else {
      handleTapSampleLocal(normX, normY);
    }
  };

  // Keyboard WASD/Arrows + Space STOP inside FPV Driver view (only when tab is active)
  useEffect(() => {
    if (!isActiveTab || subView !== "driver") return;
    const isEditable = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);

    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      if (e.code === "Space") {
        e.preventDefault();
        sendFpvStop();
        return;
      }
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        e.preventDefault();
        keysRef.current.add(e.code);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keysRef.current.delete(e.code);
    const onBlur = () => {
      if (wasDrivingRef.current || touchDraggingRef.current) sendFpvStop();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [isActiveTab, sendFpvStop, subView]);

  // 16 Hz FPV Xbox + WASD + Touch Drive Loop (paused while immersive Quest VR session owns hand controllers)
  useEffect(() => {
    if (!isActiveTab || subView !== "driver" || vrActive) return;
    const id = window.setInterval(() => {
      const sample = xboxRef.current.poll();
      setXboxSample((prev) =>
        prev.connected === sample.connected &&
        prev.usingTriggers === sample.usingTriggers &&
        prev.name === sample.name
          ? prev
          : sample
      );

      for (const act of sample.actions) {
        if (act === "stop") {
          sendFpvStop();
          return;
        }
        if (act === "horn") sendHorn();
        if (act === "headlights") toggleHeadlights();
        if (act === "cycle-assist") {
          setAssistMode((m) =>
            m === "manual" ? "copilot" : m === "copilot" ? "explorer" : "manual"
          );
        }
        if (act === "toggle-follow") {
          const vis = isRemoteDriverLive ? remoteVision : latestVisionRef.current;
          if (lockedLabelRef.current) {
            selectOrToggleObject(null);
          } else if (vis && vis.objects.length > 0) {
            selectOrToggleObject(vis.objects[0]);
          }
        }
        if (act === "speed-down") {
          setSpeedCap((c) => {
            const idx = SPEED_STEPS.findIndex((v) => v >= c);
            return SPEED_STEPS[Math.max(0, idx <= 0 ? 0 : idx - 1)];
          });
        }
        if (act === "speed-up") {
          setSpeedCap((c) => {
            const idx = SPEED_STEPS.findIndex((v) => v >= c);
            return SPEED_STEPS[Math.min(SPEED_STEPS.length - 1, idx + 1)];
          });
        }
      }

      if (!fpvCanDrive) {
        if (wasDrivingRef.current) sendFpvStop();
        return;
      }

      let rawSteer = 0;
      let rawThrottle = 0;

      if (touchDraggingRef.current) {
        rawSteer = touchVecRef.current.x;
        rawThrottle = touchVecRef.current.y;
      } else if (keysRef.current.size > 0) {
        const k = keysRef.current;
        rawThrottle =
          (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) -
          (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
        rawSteer =
          (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) -
          (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
      } else if (sample.connected && (sample.steer !== 0 || sample.throttle !== 0)) {
        rawSteer = sample.steer;
        rawThrottle = sample.throttle;
      }

      const manualActive = Math.abs(rawSteer) > 0.06 || Math.abs(rawThrottle) > 0.06;

      if (sample.connected && Math.abs(sample.turretX) > 0.15) {
        const targetDeg = Math.max(-35, Math.min(35, Math.round(sample.turretX * 35)));
        if (Math.abs(targetDeg - liveRef.current.headDeg) >= 3) {
          if (bridgeRef.current?.getRole() === "driver-client" && bridgeRef.current.isDataChannelOpen()) {
            bridgeRef.current.sendToRover({ type: "turret", angleDeg: targetDeg });
          } else if (liveRef.current.headHomed) {
            cbRef.current.onHead(targetDeg, 55, true);
          }
        }
      }

      const st = liveRef.current;

      // Instant manual override if driver touches Xbox stick / WASD during Auto Explorer!
      if (manualActive && st.assistMode === "explorer") {
        setAssistMode("copilot");
      }

      const mixed =
        sample.connected && !touchDraggingRef.current && keysRef.current.size === 0
          ? mixXboxToTank(rawSteer, rawThrottle, st.speedCap)
          : mixArcadeToTank(rawSteer, rawThrottle, st.speedCap);

      setSteerVis(rawSteer);
      setThrottleVis(rawThrottle);

      if (mixed.left !== 0 || mixed.right !== 0) {
        wasDrivingRef.current = true;
        sendFpvDrive(mixed.left, mixed.right, rawSteer, rawThrottle, 450);
      } else if (wasDrivingRef.current) {
        wasDrivingRef.current = false;
        sendFpvDrive(0, 0, 0, 0, 200);
      }
    }, 62);

    return () => window.clearInterval(id);
  }, [
    fpvCanDrive,
    isActiveTab,
    isRemoteDriverLive,
    remoteVision,
    selectOrToggleObject,
    sendFpvDrive,
    sendFpvStop,
    sendHorn,
    subView,
    toggleHeadlights,
    vrActive,
  ]);

  // Voice Commander handlers
  const speak = useCallback((text: string | null) => {
    if (!text || !liveRef.current.ttsEnabled) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.06;
      u.pitch = 1.12;
      window.speechSynthesis.speak(u);
    } catch {
      // ignore
    }
  }, []);

  const dispatchVoice = useCallback(
    (actions: VoiceAction[]) => {
      const remoteBridge =
        bridgeRef.current?.getRole() === "driver-client" && bridgeRef.current.isDataChannelOpen()
          ? bridgeRef.current
          : null;
      for (const a of actions) {
        switch (a.type) {
          case "drive":
            sendFpvDrive(a.left, a.right, 0, 0, a.timeoutMs);
            break;
          case "head":
            if (remoteBridge) {
              remoteBridge.sendToRover({ type: "turret", angleDeg: a.angleDeg });
            } else {
              cbRef.current.onHead(a.angleDeg, a.speed, false);
            }
            break;
          case "synth":
            if (remoteBridge) {
              remoteBridge.sendToRover({
                type: "synth",
                voice: a.voice,
                presetOrNote: a.presetOrNote,
                durMs: a.durMs,
              });
            } else {
              cbRef.current.onSynth(a.voice, a.presetOrNote, a.durMs);
            }
            break;
          case "hubLed":
            if (remoteBridge) {
              remoteBridge.sendToRover({ type: "hubLed", r: a.r, g: a.g, b: a.b });
            } else {
              cbRef.current.onSetHubLed(a.r, a.g, a.b);
            }
            break;
          case "setMode":
            if (remoteBridge) {
              remoteBridge.sendToRover({ type: "setMode", modeId: a.modeId });
            } else {
              cbRef.current.onSetMode(a.modeId);
            }
            break;
          case "playMacro":
            void cbRef.current.onPlayMacro().catch(() => undefined);
            break;
          case "stopMacro":
            if (remoteBridge) {
              remoteBridge.sendToRover({ type: "stop" });
            } else {
              void cbRef.current.onStopMacro().catch(() => undefined);
            }
            break;
        }
      }
    },
    [sendFpvDrive]
  );

  const handleTranscript = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      const st = liveRef.current;
      const parsed = parseVoiceCommand(trimmed, {
        headHomed: st.headHomed,
        pickedUp: st.pickedUp,
        safeMode: st.safeMode,
        speedCap: 50,
      });

      if (!parsed.matched) {
        setFeed((prev) => [
          {
            id: voiceSeqRef.current++,
            transcript: trimmed,
            intent: "unrecognized",
            reply: "Try “hello vernie”, “forward”, “turn left”, “dance”, or “stop”.",
            blocked: false,
          },
          ...prev.slice(0, 7),
        ]);
        return;
      }

      if (parsed.intent === "emergency-stop" && typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      if ((st.connected || isRemoteDriverLive) && parsed.actions.length > 0) {
        dispatchVoice(parsed.actions);
      }
      if (parsed.reply) speak(parsed.reply);

      setFeed((prev) => [
        {
          id: voiceSeqRef.current++,
          transcript: trimmed,
          intent: parsed.intent,
          reply:
            parsed.reply ??
            (st.connected || isRemoteDriverLive ? "Done!" : "Understood (connect robot or pair over Wi-Fi first)."),
          blocked: parsed.blockedBySafety,
        },
        ...prev.slice(0, 7),
      ]);
    },
    [dispatchVoice, isRemoteDriverLive, speak]
  );

  const stopListening = useCallback(() => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        // ignore
      }
    }
    setListening(false);
  }, []);

  const startListening = useCallback(() => {
    setVoiceError(null);
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setVoiceError("Browser voice recognition isn't available here — type commands below instead.");
      return;
    }
    stopListening();
    try {
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = false;
      rec.lang = "en-US";
      rec.onresult = (ev) => {
        const last = ev.results[ev.results.length - 1];
        const text = last?.[0]?.transcript;
        if (text) handleTranscript(text);
      };
      rec.onerror = (ev) => {
        setVoiceError(`Microphone error: ${ev.error ?? "unknown"}`);
        setListening(false);
      };
      rec.onend = () => setListening(false);
      recognitionRef.current = rec;
      rec.start();
      setListening(true);
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : String(err));
      setListening(false);
    }
  }, [handleTranscript, stopListening]);

  // Detect Meta Quest / WebXR immersive-vr support on mount
  useEffect(() => {
    let alive = true;
    void checkWebXrVrSupported().then((ok) => {
      if (alive) setXrVrSupported(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Global teardown on unmount
  useEffect(() => {
    return () => {
      if (tagToastTimerRef.current) window.clearTimeout(tagToastTimerRef.current);
      if (wasDrivingRef.current || vrWasDrivingRef.current) sendFpvStop();
      void vrSessionRef.current?.stop();
      scannerRef.current?.stop();
      stopHostCamera();
      stopListening();
      aiDetectorRef.current.dispose();
    };
  }, [sendFpvStop, stopHostCamera, stopListening]);

  const handleCopyJoinLink = () => {
    if (typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}?join=${roomCode}`;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(url).then(() => {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2000);
      });
    }
  };

  const hudTelemetry = isRemoteDriverLive ? remoteTelemetry : telemetry;
  const hudVision = isRemoteDriverLive ? remoteVision : localVision;
  const hudMap = isRemoteDriverLive ? remoteMap : localMap;
  const hudDist =
    hudTelemetry && hudTelemetry.distancePct <= 100
      ? hudTelemetry.distancePct
      : distancePct <= 100
        ? distancePct
        : null;
  const hudBattPct = hudTelemetry
    ? Math.max(0, Math.min(100, Math.round(((hudTelemetry.batteryMv - 6000) / 3000) * 100)))
    : null;
  const hudHeading = isRemoteDriverLive ? remoteHeading : phoneHeadingDeg;
  const hudSafe = Boolean(hudTelemetry && (hudTelemetry.flags & TelemetryFlag.SAFE_MODE));
  const activeAssistStatus = isRemoteDriverLive && remoteAssistNote ? remoteAssistNote : assistNote;
  const activeAssistIntervening = isRemoteDriverLive ? remoteAssistIntervening : assistIntervening;
  const activeExplorerBadge =
    isRemoteDriverLive && remoteExplorerState ? remoteExplorerState : explorerState;

  // Keep live VR HUD snapshot fresh for 10 Hz WebXR dashboard canvas rendering
  vrHudRef.current = {
    videoConnected: hasAnyVideo,
    bleConnected: isRemoteDriverLive ? remoteBleOk : connected,
    assistMode,
    explorerState: activeExplorerBadge,
    assistIntervening: activeAssistIntervening,
    assistNote: activeAssistStatus,
    driveStyle: "arcade",
    speedCap,
    leftMotor: vrMotorsRef.current.left,
    rightMotor: vrMotorsRef.current.right,
    steer: vrMotorsRef.current.steer,
    frontDistPct: hudDist,
    batteryPct: hudBattPct,
    headingDeg: hudHeading,
    headlightsOn,
    pingMs,
    vision: hudVision,
    map: hudMap,
  };

  // Tactile Oculus Touch haptic feedback when Collision Guard brakes or dodges!
  useEffect(() => {
    if (
      vrActive &&
      (activeAssistIntervening === "braking" || activeAssistIntervening === "dodging") &&
      lastVrInterveningRef.current !== activeAssistIntervening
    ) {
      vrSessionRef.current?.pulseHaptics(
        "both",
        activeAssistIntervening === "braking" ? 0.65 : 0.35,
        activeAssistIntervening === "braking" ? 90 : 50
      );
    }
    lastVrInterveningRef.current = activeAssistIntervening;
  }, [activeAssistIntervening, vrActive]);

  const handleVrControlFrame = useCallback(
    (sample: QuestControlSample) => {
      for (const act of sample.actions) {
        if (act === "stop") {
          vrWasDrivingRef.current = false;
          vrMotorsRef.current = { left: 0, right: 0, steer: 0 };
          sendFpvStop();
          return;
        }
        if (act === "horn") sendHorn();
        if (act === "headlights") toggleHeadlights();
        if (act === "cycle-assist") {
          setAssistMode((m) =>
            m === "manual" ? "copilot" : m === "copilot" ? "explorer" : "manual"
          );
        }
        if (act === "speed-down") {
          setSpeedCap((c) => {
            const idx = SPEED_STEPS.findIndex((v) => v >= c);
            return SPEED_STEPS[Math.max(0, idx <= 0 ? 0 : idx - 1)];
          });
        }
        if (act === "speed-up") {
          setSpeedCap((c) => {
            const idx = SPEED_STEPS.findIndex((v) => v >= c);
            return SPEED_STEPS[Math.min(SPEED_STEPS.length - 1, idx + 1)];
          });
        }
      }

      const moving = Math.abs(sample.leftMotor) > 0 || Math.abs(sample.rightMotor) > 0;
      vrMotorsRef.current = {
        left: sample.leftMotor,
        right: sample.rightMotor,
        steer: sample.steer,
      };

      if (moving && liveRef.current.assistMode === "explorer") {
        setAssistMode("copilot");
      }

      if (Math.abs(sample.turretX) > 0.15) {
        const targetDeg = Math.max(-35, Math.min(35, Math.round(sample.turretX * 35)));
        if (Math.abs(targetDeg - liveRef.current.headDeg) >= 3) {
          if (bridgeRef.current?.getRole() === "driver-client" && bridgeRef.current.isDataChannelOpen()) {
            bridgeRef.current.sendToRover({ type: "turret", angleDeg: targetDeg });
          } else if (liveRef.current.headHomed) {
            cbRef.current.onHead(targetDeg, 55, true);
          }
        }
      }

      if (moving) {
        vrWasDrivingRef.current = true;
        sendFpvDrive(sample.leftMotor, sample.rightMotor, sample.steer, sample.throttle, 450);
      } else if (vrWasDrivingRef.current) {
        vrWasDrivingRef.current = false;
        sendFpvDrive(0, 0, 0, 0, 200);
      }
    },
    [sendFpvDrive, sendFpvStop, sendHorn, toggleHeadlights]
  );

  const handleToggleVrCockpit = useCallback(async () => {
    setVrError(null);
    if (vrActive && vrSessionRef.current) {
      await vrSessionRef.current.stop();
      setVrActive(false);
      sendFpvStop();
      return;
    }

    // Ensure remote video is actively playing inside user gesture (important on Quest Browser!)
    if (remoteVideoRef.current && remoteVideoRef.current.srcObject) {
      void remoteVideoRef.current.play().catch(() => undefined);
    }

    const session = new QuestVrCockpitSession();
    vrSessionRef.current = session;
    try {
      await session.start({
        getVideoElement: () => remoteVideoRef.current,
        getFallbackCanvas: () => fallbackCanvasRef.current,
        getHudState: () =>
          vrHudRef.current ?? {
            videoConnected: false,
            bleConnected: false,
            assistMode: "copilot",
            explorerState: "IDLE",
            assistIntervening: "none",
            assistNote: "Ready",
            driveStyle: "arcade",
            speedCap: 65,
            leftMotor: 0,
            rightMotor: 0,
            steer: 0,
            frontDistPct: null,
            batteryPct: null,
            headingDeg: null,
            headlightsOn: false,
            pingMs: null,
            vision: null,
            map: null,
          },
        onControlFrame: handleVrControlFrame,
        onSessionEnd: () => {
          vrSessionRef.current = null;
          vrWasDrivingRef.current = false;
          vrMotorsRef.current = { left: 0, right: 0, steer: 0 };
          setVrActive(false);
          sendFpvStop();
        },
        onError: (msg) => setVrError(msg),
      });
      setVrActive(true);
    } catch (err) {
      vrSessionRef.current = null;
      setVrActive(false);
      setVrError(
        err instanceof Error
          ? err.message
          : "Could not start Meta Quest VR session. Open this page in Meta Quest Browser over HTTPS."
      );
    }
  }, [handleVrControlFrame, sendFpvStop, vrActive]);

  const updateTouchStick = (clientX: number, clientY: number) => {
    const el = touchPadRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const r = Math.max(1, rect.width / 2 - 16);
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = -(clientY - (rect.top + rect.height / 2));
    const mag = Math.hypot(dx, dy);
    const clamped = Math.min(mag, r);
    touchVecRef.current = {
      x: mag > 0 ? (dx / mag) * (clamped / r) : 0,
      y: mag > 0 ? (dy / mag) * (clamped / r) : 0,
    };
  };

  return (
    <div className="station-stack" hidden={!isActiveTab}>
      {/* Top Role Switcher */}
      <div className="fpv-role-bar">
        <div className="segmented-mini" role="tablist" aria-label="Rover camera role">
          <button
            type="button"
            id="role-fold"
            role="tab"
            aria-selected={subView === "fold"}
            className={subView === "fold" ? "is-active" : ""}
            onClick={() => setSubView("fold")}
          >
            On-Board Auto-Pilot (Fold 90°)
          </button>
          <button
            type="button"
            id="role-driver"
            role="tab"
            aria-selected={subView === "driver"}
            className={subView === "driver" ? "is-active" : ""}
            onClick={() => setSubView("driver")}
          >
            Driver / Quest VR
          </button>
          <button
            type="button"
            id="role-host"
            role="tab"
            aria-selected={subView === "host"}
            className={subView === "host" ? "is-active" : ""}
            onClick={() => setSubView("host")}
          >
            Android Phone on Tank
          </button>
          <button
            type="button"
            id="role-voice"
            role="tab"
            aria-selected={subView === "voice"}
            className={subView === "voice" ? "is-active" : ""}
            onClick={() => setSubView("voice")}
          >
            Voice Commander
          </button>
        </div>

        <div className="fpv-link-badge">
          {subView === "fold" ? (
            <>
              <IconCamera size={14} />
              <span>
                {hostCameraActive
                  ? `On-Board Local Mode · ${visionMs.toFixed(0)} ms (No Wi-Fi needed)`
                  : "On-Board Local Mode (Single Device)"}
              </span>
            </>
          ) : (
            <>
              <IconWifi size={14} />
              <span>
                {linkState === "connected"
                  ? `${transportMode === "relay" ? "Wi-Fi Relay Live" : "Wi-Fi FPV Live"}${pingMs ? ` · ${pingMs} ms` : ""}`
                  : linkDetail}
              </span>
            </>
          )}
        </div>
      </div>

      {/* =========================================
          VIEW 0: PIXEL FOLD 90° SINGLE-DEVICE ON-BOARD AUTO-PILOT
         ========================================= */}
      {subView === "fold" && (
        <FoldAutoPilotView
          videoRef={hostVideoRef}
          bleConnected={connected}
          bleDisabled={disabled}
          cameraActive={hostCameraActive}
          cameraError={hostCameraError}
          wakeLocked={hostWakeLocked}
          torchSupported={hostTorchSupported}
          headlightsOn={headlightsOn}
          autoHeadlights={autoHeadlights}
          telemetry={telemetry}
          heading={foldHeading}
          vision={localVision}
          visionMs={visionMs}
          map={localMap}
          discoveries={discoveries}
          assistMode={assistMode}
          mission={mission}
          explorerState={explorerState}
          assistNote={assistNote}
          speedCap={speedCap}
          aiEnabled={aiEnabled}
          aiStatusNote={aiStatusNote}
          showCorridors={showCorridors}
          recoveries={recoveries}
          motorCmd={foldMotorCmd}
          calibration={calibration}
          rearCameras={rearCameras}
          runStats={runStats}
          autoRecord={autoRecord}
          lastTagFeedback={lastTagFeedback}
          exportBusy={exportBusy}
          exportNotice={exportNotice}
          onStartCamera={(devId) => void startFoldCameraOnly(devId)}
          onStopCamera={stopHostCamera}
          onToggleExplore={() => void handleToggleFoldExplore()}
          onEmergencyStop={sendFpvStop}
          onMissionChange={setMission}
          onSpeedCapChange={setSpeedCap}
          onToggleAi={() => setAiEnabled((v) => !v)}
          onToggleCorridors={() => setShowCorridors((v) => !v)}
          onToggleHeadlights={toggleHeadlights}
          onToggleAutoHeadlights={() => setAutoHeadlights((v) => !v)}
          onCalibrationChange={handleCalibrationChange}
          onRelearnFloor={handleRelearnFloor}
          onResetMap={handleResetMap}
          onToggleRecording={handleToggleRecording}
          onToggleAutoRecord={() => setAutoRecord((v) => !v)}
          onMarkProblem={handleMarkProblem}
          onExportZip={(preferShare) => void handleExportZip(preferShare)}
          onExportContactSheet={() => void handleExportContactSheet()}
          onCopySummary={handleCopySummary}
          onClearRun={handleClearRun}
        />
      )}

      {/* =========================================
          VIEW 1: CHROMEBOOK / META QUEST VR DRIVER COCKPIT
         ========================================= */}
      {subView === "driver" && (
        <div className="station-stack">
          <section className="console-panel fpv-cockpit-panel" aria-label="FPV Rover Driver Cockpit">
            {/* ZERO-IP AUTOMATIC SAME-WI-FI DISCOVERY BANNER */}
            {!isRemoteDriverLive && (
              <div className="wifi-discovery-panel" aria-label="Automatic Wi-Fi tank discovery">
                <div className="wifi-discovery-head">
                  <div>
                    <span className="engraved-label">Automatic Wi-Fi Discovery · No IP Address Needed</span>
                    <p className="wifi-discovery-sub">{discoveryStatus}</p>
                  </div>
                  <button
                    type="button"
                    className="chip-btn chip-compact"
                    onClick={() => scannerRef.current?.probe()}
                  >
                    <IconRefresh size={13} />
                    <span>Rescan Wi-Fi</span>
                  </button>
                </div>

                {discoveredTanks.length > 0 && (
                  <div className="discovered-tank-list">
                    {discoveredTanks.map((tank) => (
                      <div key={tank.code} className="discovered-tank-card">
                        <div>
                          <strong>{tank.name}</strong>
                          <span className="mono-readout-muted">
                            Room {tank.code} · {tank.bleConnected ? "Bluetooth Ready" : "Connect Bluetooth on Phone"} ·{" "}
                            {tank.cameraReady ? "Camera Live" : "Control Only"}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="keycap keycap-green keycap-sm"
                          onClick={() => void handleJoinCode(tank.code)}
                        >
                          <IconWifi size={14} />
                          <span>Connect Now</span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 4-Character Room Code Backup + Quest VR Launch + Disconnect Strip */}
            <div className="fpv-pair-strip">
              <div className="fpv-pair-left">
                <span className="engraved-label">Or Pair With 4-Letter Room Code</span>
                <div className="fpv-code-form">
                  <input
                    id="input-join-code"
                    aria-label="4-character Rover Room Code"
                    className="tactile-input code-input mono-num"
                    type="text"
                    placeholder="CODE"
                    maxLength={8}
                    value={joinCode}
                    onChange={(e) => setJoinCode(normalizeRoomCode(e.target.value))}
                  />
                  {isRemoteDriverLive || linkState === "waiting-peer" || linkState === "connecting" ? (
                    <button
                      type="button"
                      className="keycap keycap-subtle keycap-sm"
                      onClick={() => bridgeRef.current?.stop()}
                    >
                      Disconnect Wi-Fi
                    </button>
                  ) : (
                    <button
                      type="button"
                      id="btn-join-rover"
                      className="keycap keycap-green keycap-sm"
                      disabled={joinCode.length < 3}
                      onClick={() => void handleJoinCode(joinCode)}
                    >
                      <IconWifi size={14} />
                      <span>Connect by Code</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="action-cluster">
                {isRemoteDriverLive && transportMode === "relay" && (
                  <button
                    type="button"
                    className="chip-btn"
                    onClick={() => bridgeRef.current?.retryDirectP2P()}
                  >
                    <IconRefresh size={13} />
                    <span>Retry Direct P2P</span>
                  </button>
                )}
                {(xrVrSupported || isQuestBrowser) && (
                  <button
                    type="button"
                    id="btn-enter-vr-cockpit"
                    className={`keycap keycap-sm ${vrActive ? "keycap-stop" : "keycap-orange"}`}
                    onClick={() => void handleToggleVrCockpit()}
                  >
                    <IconVrHeadset size={15} />
                    <span>{vrActive ? "Exit VR Cockpit" : "Enter VR Cockpit (Quest)"}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="chip-btn"
                  onClick={() => setShowOfflineFallback((v) => !v)}
                >
                  {showOfflineFallback ? "Hide Manual Copy/Paste" : "Offline Copy/Paste Pair"}
                </button>
              </div>
            </div>

            {vrError && <div className="notice notice-danger">{vrError}</div>}

            {showOfflineFallback && (
              <div className="offline-pair-box">
                <span className="engraved-label">Zero-Internet Direct Pairing (Copy/Paste Offer &amp; Answer)</span>
                <div className="two-col-grid">
                  <div className="field-stack">
                    <textarea
                      aria-label="Paste Rover Offer JSON"
                      className="tactile-input mono-num"
                      rows={2}
                      placeholder="1. Paste Offer code from Android phone here…"
                      value={offlineOfferText}
                      onChange={(e) => setOfflineOfferText(e.target.value)}
                    />
                    <button
                      type="button"
                      className="keycap keycap-subtle keycap-sm"
                      disabled={!offlineOfferText.trim()}
                      onClick={async () => {
                        try {
                          const ans = await bridgeRef.current?.acceptOfflineOffer(offlineOfferText);
                          if (ans) setOfflineAnswerText(ans);
                        } catch (err) {
                          setLinkDetail(err instanceof Error ? err.message : "Invalid Offer JSON");
                        }
                      }}
                    >
                      Generate Answer Code
                    </button>
                  </div>
                  <div className="field-stack">
                    <textarea
                      aria-label="Generated Driver Answer JSON"
                      className="tactile-input mono-num"
                      rows={2}
                      readOnly
                      placeholder="2. Copy this Answer code back to the Android phone…"
                      value={offlineAnswerText}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* FULL-BLEED CINEMA FPV VIEWPORT */}
            <div
              className="fpv-viewport"
              aria-label="First-person rover camera feed"
              onClick={handleViewportClick}
            >
              <video
                ref={remoteVideoRef}
                className={`fpv-media ${hasRemoteVideo && transportMode !== "relay" ? "" : "is-hidden"}`}
                playsInline
                muted
                autoPlay
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  void v.play().catch(() => undefined);
                  if (
                    v.videoWidth > 16 &&
                    v.videoHeight > 16 &&
                    bridgeRef.current?.getTransportMode() === "webrtc"
                  ) {
                    setHasRemoteVideo(true);
                  }
                }}
                onPlaying={(e) => {
                  const v = e.currentTarget;
                  if (
                    v.videoWidth > 16 &&
                    v.videoHeight > 16 &&
                    bridgeRef.current?.getTransportMode() === "webrtc"
                  ) {
                    setHasRemoteVideo(true);
                  }
                }}
                onResize={(e) => {
                  const v = e.currentTarget;
                  if (
                    v.videoWidth > 16 &&
                    v.videoHeight > 16 &&
                    bridgeRef.current?.getTransportMode() === "webrtc"
                  ) {
                    setHasRemoteVideo(true);
                  }
                }}
              />

              <canvas
                ref={fallbackCanvasRef}
                className={`fpv-media ${hasFallbackVideo && (transportMode === "relay" || !hasRemoteVideo) ? "" : "is-hidden"}`}
                aria-label="Compatible rover camera stream"
              />

              {!hasAnyVideo &&
                (linkState === "signaling" ||
                  linkState === "waiting-peer" ||
                  linkState === "connecting" ||
                  linkState === "connected") && (
                  <div className="fpv-standby fpv-connecting-card" onClick={(e) => e.stopPropagation()}>
                    <IconWifi size={32} />
                    <h3>
                      {linkState === "connected"
                        ? "Link Live — Waiting for First Camera Frame…"
                        : "Establishing Live Camera Video…"}
                    </h3>
                    <p className="fpv-diag-note">{bridgeDiag?.note || linkDetail}</p>
                    <div className="fpv-progress-pills">
                      <span className={`visor-chip ${bridgeDiag?.relay ? "visor-chip-green" : ""}`}>
                        1. Relay {bridgeDiag?.relay ? `(${bridgeDiag.relay})` : "…"}
                      </span>
                      <span className={`visor-chip ${bridgeDiag?.offerReady ? "visor-chip-green" : ""}`}>
                        2. Offer {bridgeDiag?.offerReady ? "OK" : "…"}
                      </span>
                      <span
                        className={`visor-chip ${
                          linkState === "connected"
                            ? "visor-chip-green"
                            : bridgeDiag?.answerReady
                              ? "visor-chip-amber"
                              : ""
                        }`}
                      >
                        3. Video{" "}
                        {transportMode === "relay"
                          ? "(Relay)"
                          : bridgeDiag?.iceConnectionState
                            ? `(${bridgeDiag.iceConnectionState})`
                            : "…"}
                      </span>
                    </div>
                    {bridgeDiag && bridgeDiag.offerReady && transportMode !== "relay" && (
                      <p className="fpv-diag-sub">
                        Auto-switches to Compatible Relay Video if your Wi-Fi or macOS Local Network
                        setting blocks direct P2P UDP.
                      </p>
                    )}
                    <div className="action-cluster">
                      {transportMode !== "relay" && linkState === "connecting" && (
                        <button
                          type="button"
                          id="btn-relay-video-now"
                          className="keycap keycap-orange keycap-sm"
                          onClick={() => bridgeRef.current?.activateRelayFallbackNow()}
                        >
                          Use Relay Video Now
                        </button>
                      )}
                      <button
                        type="button"
                        className="keycap keycap-subtle keycap-sm"
                        onClick={() => bridgeRef.current?.retryDirectP2P()}
                      >
                        <IconRefresh size={13} />
                        <span>Retry P2P</span>
                      </button>
                    </div>
                  </div>
                )}

              {!hasAnyVideo && (linkState === "idle" || linkState === "error") && (
                <div className="fpv-standby">
                  <IconCamera size={34} />
                  <h3>Pair Your Android Phone with Chromebook or Meta Quest (No IP Address Needed)</h3>
                  {linkState === "error" && (
                    <p className="fpv-diag-error">{linkDetail}</p>
                  )}
                  <div className="wifi-steps-grid">
                    <div className="wifi-step-card">
                      <span className="wifi-step-num">1</span>
                      <div>
                        <strong>On your Android Phone (mounted on tank)</strong>
                        <p>
                          Open this page on the same Wi-Fi, select <strong>Android Phone on Tank</strong>,
                          tap <strong>Connect Robot</strong> (Bluetooth), then tap{" "}
                          <strong>Start Camera &amp; Broadcast on Wi-Fi</strong>.
                        </p>
                      </div>
                    </div>
                    <div className="wifi-step-card">
                      <span className="wifi-step-num">2</span>
                      <div>
                        <strong>On your Chromebook or Meta Quest Headset</strong>
                        <p>
                          Your tank appears automatically in the green box above within ~1 second —
                          click <strong>Connect Now</strong> (or enter the 4-letter code). On{" "}
                          <strong>Meta Quest</strong>, tap <strong>Enter VR Cockpit</strong> to drive
                          immersively with your Touch hand controllers!
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {hasAnyVideo && (
                <FpvOverlaySvg
                  steer={steerVis}
                  frontDistPct={hudDist}
                  vision={hudVision}
                  showCorridors={showCorridors}
                  onSelectObject={(box) => selectOrToggleObject(box)}
                />
              )}

              {/* Top HUD telemetry pills */}
              <div className="fpv-top-hud">
                <div className="fpv-hud-cluster">
                  <span
                    className={`visor-chip ${
                      activeAssistIntervening === "braking"
                        ? "visor-chip-red"
                        : activeAssistIntervening === "dodging"
                          ? "visor-chip-amber"
                          : assistMode === "explorer"
                            ? "visor-chip-amber"
                            : assistMode === "copilot"
                              ? "visor-chip-green"
                              : "visor-chip-cyan"
                    }`}
                  >
                    {assistMode === "manual"
                      ? "MANUAL FPV"
                      : assistMode === "copilot"
                        ? "SMART CO-PILOT"
                        : `EXPLORER · ${activeExplorerBadge}`}
                  </span>
                  {transportMode === "relay" && hasFallbackVideo && (
                    <span className="visor-chip visor-chip-amber">RELAY VIDEO</span>
                  )}
                  {transportMode === "webrtc" && !hasRemoteVideo && hasFallbackVideo && (
                    <span className="visor-chip visor-chip-cyan">COMPAT VIDEO</span>
                  )}
                  {hudHeading !== null && (
                    <span className="visor-chip">
                      <IconCompass size={11} /> {compassLabel(hudHeading)}
                    </span>
                  )}
                  {headlightsOn && <span className="visor-chip visor-chip-amber">LIGHTS ON</span>}
                  {lockedLabel && (
                    <span className="visor-chip visor-chip-amber">
                      <IconTarget size={11} /> {lockedLabel}
                    </span>
                  )}
                </div>

                <div className="fpv-hud-cluster">
                  {hudDist !== null && (
                    <span
                      className={`visor-chip ${
                        hudDist <= 22
                          ? "visor-chip-red"
                          : hudDist <= 50
                            ? "visor-chip-amber"
                            : "visor-chip-green"
                      }`}
                    >
                      FRONT {hudDist}%
                    </span>
                  )}
                  {hudBattPct !== null && <span className="visor-chip">BATT {hudBattPct}%</span>}
                  {hudSafe && <span className="visor-chip visor-chip-red">SAFE MODE</span>}
                </div>
              </div>

              {/* Floating touch pad overlay */}
              {showTouchPad && hasAnyVideo && (
                <div
                  ref={touchPadRef}
                  className="fpv-floating-stick"
                  role="application"
                  aria-label="Floating FPV touch joystick"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => {
                    touchDraggingRef.current = true;
                    e.currentTarget.setPointerCapture?.(e.pointerId);
                    updateTouchStick(e.clientX, e.clientY);
                  }}
                  onPointerMove={(e) => {
                    if (!touchDraggingRef.current) return;
                    updateTouchStick(e.clientX, e.clientY);
                  }}
                  onPointerUp={sendFpvStop}
                  onPointerCancel={sendFpvStop}
                >
                  <div
                    className="fpv-floating-puck"
                    style={{
                      transform: `translate(${Math.round(steerVis * 34)}px, ${Math.round(-throttleVis * 34)}px)`,
                    }}
                  />
                </div>
              )}

              {/* Bottom cockpit action dock */}
              <div className="fpv-bottom-dock" onClick={(e) => e.stopPropagation()}>
                <div className="fpv-dock-group">
                  <button
                    type="button"
                    id="btn-fpv-headlights"
                    className={`fpv-pill-btn ${headlightsOn ? "is-lit" : ""}`}
                    onClick={toggleHeadlights}
                    title={
                      isRemoteDriverLive && !remoteTorchAvail
                        ? "Headlights (depends on Android phone flashlight)"
                        : "Toggle headlights (Xbox X)"
                    }
                  >
                    <IconFlashlight size={14} />
                    <span>{headlightsOn ? "Lights On" : "Lights"}</span>
                  </button>
                  <button type="button" className="fpv-pill-btn" onClick={sendHorn}>
                    Horn (A)
                  </button>
                  <button
                    type="button"
                    className={`fpv-pill-btn ${showTouchPad ? "is-lit" : ""}`}
                    onClick={() => setShowTouchPad((v) => !v)}
                  >
                    {showTouchPad ? "Hide Stick" : "Touch Stick"}
                  </button>
                  {(xrVrSupported || isQuestBrowser) && (
                    <button
                      type="button"
                      className={`fpv-pill-btn ${vrActive ? "is-lit" : ""}`}
                      onClick={() => void handleToggleVrCockpit()}
                    >
                      <IconVrHeadset size={14} />
                      <span>{vrActive ? "Exit VR" : "VR Cockpit"}</span>
                    </button>
                  )}
                </div>

                <div className="fpv-dock-group">
                  <div className="fpv-speed-pills" role="group" aria-label="FPV Speed Limit">
                    {SPEED_STEPS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`fpv-speed-btn mono-num ${speedCap === s ? "is-active" : ""}`}
                        onClick={() => setSpeedCap(s)}
                      >
                        {s}%
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    id="btn-fpv-stop"
                    className="keycap keycap-stop keycap-sm"
                    onClick={sendFpvStop}
                  >
                    <IconStop size={12} />
                    <span>STOP</span>
                  </button>
                </div>
              </div>
            </div>

            {/* SMART CO-PILOT & AUTONOMOUS MISSION CONTROL BAR */}
            <div className="copilot-deck" aria-label="Intelligent driving and exploration controls">
              <div className="copilot-row">
                <div className="toolbar-group">
                  <span className="engraved-label">Pilot Mode (Y)</span>
                  <div className="segmented-mini" role="group" aria-label="Pilot intelligence mode">
                    {(
                      [
                        { id: "manual", label: "Manual FPV" },
                        { id: "copilot", label: "Smart Co-Pilot" },
                        { id: "explorer", label: "Auto Explorer" },
                      ] as const
                    ).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        id={`pilot-mode-${m.id}`}
                        className={assistMode === m.id ? "is-active" : ""}
                        onClick={() => setAssistMode(m.id)}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {assistMode === "explorer" ? (
                  <div className="toolbar-group">
                    <span className="engraved-label">Explorer Mission</span>
                    <div className="segmented-mini" role="group" aria-label="Autonomous mission">
                      {EXPLORER_MISSIONS.map((ms) => (
                        <button
                          key={ms.id}
                          type="button"
                          id={`mission-${ms.id}`}
                          className={mission === ms.id ? "is-active" : ""}
                          onClick={() => setMission(ms.id)}
                          title={ms.sub}
                        >
                          {ms.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="toolbar-group">
                    <span className="engraved-label">Collision Guard</span>
                    <div className="segmented-mini" role="group" aria-label="Collision guard level">
                      {(
                        [
                          { id: "off", label: "Off" },
                          { id: "brake", label: "Auto-Brake" },
                          { id: "dodge", label: "Smart Dodge" },
                        ] as const
                      ).map((g) => (
                        <button
                          key={g.id}
                          type="button"
                          className={collisionGuard === g.id ? "is-active" : ""}
                          onClick={() => setCollisionGuard(g.id)}
                        >
                          {g.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="copilot-row">
                <div className="chip-row">
                  <button
                    type="button"
                    className={`chip-btn ${headingHold ? "chip-btn-active" : ""}`}
                    onClick={() => setHeadingHold((v) => !v)}
                  >
                    Straight Heading Hold
                  </button>
                  <button
                    type="button"
                    className={`chip-btn ${laneAssist ? "chip-btn-active" : ""}`}
                    onClick={() => setLaneAssist((v) => !v)}
                  >
                    Tape Lane Assist
                  </button>
                  <button
                    type="button"
                    className={`chip-btn ${aiEnabled ? "chip-btn-active" : ""}`}
                    onClick={() => setAiEnabled((v) => !v)}
                  >
                    AI Vision (80 Objects)
                  </button>
                  <button
                    type="button"
                    className={`chip-btn ${showCorridors ? "chip-btn-active" : ""}`}
                    onClick={() => setShowCorridors((v) => !v)}
                  >
                    Floor Clearance Overlay
                  </button>
                  {lockedLabel && (
                    <button
                      type="button"
                      className="chip-btn chip-btn-warn"
                      onClick={() => selectOrToggleObject(null)}
                    >
                      Unlock “{lockedLabel}” ×
                    </button>
                  )}
                </div>

                <span className="copilot-status-text">
                  {aiStatusNote ?? activeAssistStatus}
                </span>
              </div>
            </div>

            {!isQuestBrowser && <XboxHudStrip sample={xboxSample} />}

            {(xrVrSupported || isQuestBrowser) && (
              <div
                className={`xbox-hud ${vrActive ? "is-connected" : ""}`}
                aria-label="Meta Quest Touch hand controller guide"
              >
                <div className="xbox-hud-left">
                  <span className={`xbox-status-dot ${vrActive ? "is-live" : ""}`} />
                  <IconVrHeadset size={16} />
                  <span className="xbox-title">
                    {vrActive
                      ? "Quest VR Cockpit Active — Touch Hand Controllers Live"
                      : "Meta Quest Touch Hand Controllers Ready"}
                  </span>
                </div>
                <div className="xbox-legend" aria-label="Quest Touch button mapping">
                  <span className="xbox-key">
                    <kbd className="xbtn-neutral">L-Stick / RT·LT</kbd> Drive
                  </span>
                  <span className="xbox-key">
                    <kbd className="xbtn-b">R-B</kbd> Stop
                  </span>
                  <span className="xbox-key">
                    <kbd className="xbtn-a">R-A</kbd> Horn
                  </span>
                  <span className="xbox-key">
                    <kbd className="xbtn-x">L-X</kbd> Lights
                  </span>
                  <span className="xbox-key">
                    <kbd className="xbtn-y">L-Y</kbd> Mode
                  </span>
                  <span className="xbox-key">
                    <kbd className="xbtn-neutral">L·R Grips</kbd> Speed
                  </span>
                  <span className="xbox-key">
                    <kbd className="xbtn-neutral">L-Click</kbd> Tank Mode
                  </span>
                  <span className="xbox-key">
                    <kbd className="xbtn-neutral">R-Click</kbd> Recenter
                  </span>
                </div>
              </div>
            )}
          </section>

          {/* LIVE 2D EXPLORATION MAP & ROVER DISCOVERY LOG */}
          {isRemoteDriverLive && (
            <div className="explorer-intel-grid">
              <section className="console-panel" aria-label="Live 2D exploration map panel">
                <RoomMapCanvas
                  map={hudMap}
                  discoveries={discoveries}
                  recoveries={recoveries}
                  onResetMap={handleResetMap}
                />
              </section>

              <section className="console-panel" aria-label="Rover discovery photo log">
                <div className="panel-head">
                  <div>
                    <h2>Rover Discovery Log</h2>
                    <p className="panel-sub">
                      Snapshots logged on the fly while Auto Explorer cruises — never stops moving!
                    </p>
                  </div>
                  <span className="status-tag">{discoveries.length} FOUND</span>
                </div>

                {discoveries.length === 0 ? (
                  <div className="timeline-empty">
                    Switch Pilot Mode to <strong>Auto Explorer</strong> (or press <strong>Xbox Y</strong>)
                    to let your tank glide smoothly around obstacles, build the 2D room map, and log
                    discoveries here. Touching the Xbox stick or WASD always takes back manual control.
                  </div>
                ) : (
                  <div className="discovery-grid">
                    {discoveries.map((item) => (
                      <div key={item.id} className="discovery-card">
                        {item.thumbnailUrl && (
                          <img
                            src={item.thumbnailUrl}
                            alt={`Rover spotted ${item.label}`}
                            className="discovery-thumb"
                          />
                        )}
                        <div className="discovery-meta">
                          <strong>{item.label}</strong>
                          <span className="mono-readout-muted">
                            {Math.round(item.confidence * 100)}% · ({item.mapX}, {item.mapY} cm)
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      )}

      {/* =========================================
          VIEW 2: ANDROID PHONE ON TANK (ROVER HOST)
         ========================================= */}
      {subView === "host" && (
        <div className="two-col-grid">
          <section className="console-panel" aria-label="Android Rover Camera Host">
            <div className="panel-head">
              <div>
                <h2>Android Phone on Tank (Host)</h2>
                <p className="panel-sub">
                  Mount this phone facing forward on your tank — auto-announces on your Wi-Fi (no IP
                  address needed!) while streaming camera &amp; smooth vision navigation
                </p>
              </div>
              <span className={`status-tag ${hostActive ? "is-live" : ""}`}>
                {hostActive ? "BROADCASTING" : "STANDBY"}
              </span>
            </div>

            {hostCameraError && <div className="notice notice-info">{hostCameraError}</div>}

            <div className="room-code-hero">
              <div>
                <span className="engraved-label">Room Code (Auto-Discovered on Same Wi-Fi)</span>
                <div className="room-code-display mono-num" aria-label="Rover Room Code">
                  {roomCode.split("").join(" ")}
                </div>
              </div>
              <div className="action-cluster">
                <button
                  type="button"
                  className="keycap keycap-subtle keycap-sm"
                  onClick={handleCopyJoinLink}
                >
                  {copiedLink ? "Link Copied!" : "Copy Join Link"}
                </button>
                <button
                  type="button"
                  className="keycap keycap-subtle keycap-sm"
                  disabled={hostActive}
                  onClick={() => setRoomCode(generateRoomCode(4))}
                >
                  New Code
                </button>
              </div>
            </div>

            <div className="host-checklist">
              <div className={`host-check-item ${connected ? "is-ok" : ""}`}>
                <strong>1. Move Hub Bluetooth</strong>
                <span>
                  {connected
                    ? "Connected & ready to drive"
                    : "Tap Connect Robot in the top bar (you can connect before or after starting Wi-Fi!)"}
                </span>
              </div>
              <div className={`host-check-item ${hostActive ? "is-ok" : ""}`}>
                <strong>2. Rear Camera &amp; Same-Wi-Fi Auto-Discovery</strong>
                <span>
                  {hostActive
                    ? `${hostCameraActive ? "Camera Live" : "Control Only"}${hostWakeLocked ? " · Awake" : ""}${phoneHeadingDeg !== null ? ` · Gyro ${phoneHeadingDeg}°` : ""} · ${hostDiscoveryNote}`
                    : "Tap Start Camera & Broadcast on Wi-Fi below"}
                </span>
              </div>
              <div className={`host-check-item ${linkState === "connected" ? "is-ok" : ""}`}>
                <strong>3. Chromebook Wi-Fi Link</strong>
                <span>{linkDetail} · 500 ms link-drop auto-stop armed</span>
              </div>
            </div>

            <div className="action-cluster">
              {hostActive ? (
                <button
                  type="button"
                  id="btn-stop-host"
                  className="keycap keycap-stop"
                  onClick={stopHostCamera}
                >
                  Stop Tank Host
                </button>
              ) : (
                <button
                  type="button"
                  id="btn-start-host"
                  className="keycap keycap-green"
                  onClick={() => void startHostCameraAndBroadcast()}
                >
                  <IconCamera size={15} />
                  <span>Start Camera &amp; Broadcast on Wi-Fi</span>
                </button>
              )}

              <button
                type="button"
                className={`keycap keycap-sm ${headlightsOn ? "keycap-amber" : "keycap-subtle"}`}
                disabled={!hostCameraActive}
                onClick={() => void applyHostTorch(!headlightsOn)}
              >
                <IconFlashlight size={14} />
                <span>
                  {headlightsOn
                    ? "Headlights On"
                    : hostTorchSupported
                      ? "Test Flashlight"
                      : "Flashlight (N/A)"}
                </span>
              </button>

              <button
                type="button"
                className={`keycap keycap-sm ${assistMode === "explorer" ? "keycap-orange" : "keycap-subtle"}`}
                disabled={!connected || !hostActive}
                onClick={() => {
                  if (assistMode === "explorer") {
                    explorerRef.current.reset();
                    setAssistMode("copilot");
                    cbRef.current.onDrive(0, 0, 200);
                  } else {
                    setAssistMode("explorer");
                  }
                }}
              >
                {assistMode === "explorer" ? "Stop Standalone Explore" : "Standalone Auto Explore"}
              </button>
            </div>

            {hostActive && (
              <div className="notice notice-info">
                <strong>
                  {assistMode === "explorer" ? `Auto Explorer · ${explorerState}` : "Smart Co-Pilot"}:
                </strong>{" "}
                {assistNote}
              </div>
            )}
          </section>

          <section className="console-panel" aria-label="On-board camera preview and offline pairing">
            <div className="panel-head">
              <div>
                <h2>On-Board Rear Camera Preview</h2>
                <p className="panel-sub">Verify floor clearance overlay &amp; horizon level</p>
              </div>
            </div>

            <div className="viewfinder-box">
              <video
                ref={hostVideoRef}
                className="viewfinder-video"
                muted
                playsInline
                autoPlay
                onLoadedMetadata={(e) => {
                  void e.currentTarget.play().catch(() => undefined);
                }}
              />
              {!hostCameraActive && (
                <div className="viewfinder-standby">
                  <IconCamera size={28} />
                  <span>Rear camera preview appears here once broadcasting</span>
                </div>
              )}
              {hostCameraActive && localVision && (
                <FpvOverlaySvg
                  steer={localVision.bestSteer}
                  frontDistPct={hudDist}
                  vision={localVision}
                  showCorridors={true}
                  calibration={calibration}
                />
              )}
            </div>

            <div className="field-stack">
              <button
                type="button"
                className="chip-btn"
                onClick={() => setShowOfflineFallback((v) => !v)}
              >
                {showOfflineFallback ? "Hide Manual Copy/Paste Pair" : "Offline Copy/Paste Pairing"}
              </button>
              {showOfflineFallback && (
                <div className="offline-pair-box">
                  <button
                    type="button"
                    className="keycap keycap-subtle keycap-sm"
                    onClick={async () => {
                      const offer = await bridgeRef.current?.createOfflineOffer(hostStreamRef.current);
                      if (offer) setOfflineOfferText(offer);
                    }}
                  >
                    1. Create Offer Code
                  </button>
                  <textarea
                    aria-label="Host Offer JSON"
                    className="tactile-input mono-num"
                    rows={2}
                    readOnly
                    value={offlineOfferText}
                    placeholder="Copy generated Offer code to Chromebook…"
                  />
                  <textarea
                    aria-label="Paste Driver Answer JSON"
                    className="tactile-input mono-num"
                    rows={2}
                    value={offlineAnswerText}
                    onChange={(e) => setOfflineAnswerText(e.target.value)}
                    placeholder="2. Paste Answer code from Chromebook here…"
                  />
                  <button
                    type="button"
                    className="keycap keycap-green keycap-sm"
                    disabled={!offlineAnswerText.trim()}
                    onClick={() => void bridgeRef.current?.acceptOfflineAnswer(offlineAnswerText)}
                  >
                    3. Complete Direct Link
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {/* =========================================
          VIEW 3: VOICE COMMANDER
         ========================================= */}
      {subView === "voice" && (
        <section className="console-panel" aria-label="Voice commander">
          <div className="panel-head">
            <div>
              <h2>Talk to Your Rover</h2>
              <p className="panel-sub">
                Speak naturally, type a phrase, or tap a quick command — works locally or over Wi-Fi FPV
              </p>
            </div>
            <span className={`status-tag ${listening ? "is-live" : ""}`}>
              {listening ? "LISTENING" : "READY"}
            </span>
          </div>

          {voiceError && <div className="notice notice-info">{voiceError}</div>}

          <div className="mic-hero-row">
            <button
              type="button"
              id="btn-pilot-mic"
              className={`mic-orb-btn ${listening ? "is-listening" : ""}`}
              disabled={!speechSupported && !listening}
              onClick={listening ? stopListening : startListening}
            >
              <IconMic size={20} />
              <span>
                {listening
                  ? "Listening… Tap to Stop"
                  : speechSupported
                    ? "Tap to Speak"
                    : "Mic Unavailable — Type Below"}
              </span>
            </button>

            <label className="toggle-check">
              <input
                type="checkbox"
                checked={ttsEnabled}
                disabled={!ttsSupported}
                onChange={(e) => setTtsEnabled(e.target.checked)}
              />
              <span>Speak Replies Out Loud</span>
            </label>
          </div>

          <form
            className="voice-command-form"
            onSubmit={(e) => {
              e.preventDefault();
              handleTranscript(commandInput);
              setCommandInput("");
            }}
          >
            <input
              aria-label="Voice or text command"
              className="tactile-input"
              type="text"
              placeholder="Try “hello vernie”, “forward”, “dance”, or “stop”…"
              value={commandInput}
              onChange={(e) => setCommandInput(e.target.value)}
            />
            <button type="submit" className="keycap keycap-orange keycap-sm">
              Send
            </button>
          </form>

          <div className="chip-row">
            {QUICK_PHRASES.map((phrase) => (
              <button
                key={phrase}
                type="button"
                className={`chip-btn ${phrase === "Stop" ? "chip-btn-stop" : ""}`}
                onClick={() => handleTranscript(phrase)}
              >
                &ldquo;{phrase}&rdquo;
              </button>
            ))}
          </div>

          <div className="safety-footnote">
            <IconShield size={14} />
            <span>Voice Safety Lock: saying &ldquo;fire&rdquo; or &ldquo;shoot&rdquo; is always blocked.</span>
          </div>

          <ol className="voice-feed" aria-label="Voice command log">
            {feed.length === 0 ? (
              <li className="timeline-empty">
                No commands yet — tap &ldquo;Hello Vernie&rdquo; above to test!
              </li>
            ) : (
              feed.map((b) => (
                <li key={b.id} className={`voice-bubble ${b.blocked ? "is-blocked" : ""}`}>
                  <div className="voice-bubble-top">
                    <strong>&ldquo;{b.transcript}&rdquo;</strong>
                    <span className="voice-intent-tag">{b.intent}</span>
                  </div>
                  <p>{b.reply}</p>
                </li>
              ))
            )}
          </ol>
        </section>
      )}
    </div>
  );
};
