// SPDX-License-Identifier: MIT
// FPV Rover Station — Full 3-Phase Tank/Rover Experience:
//   Phase 1: Two-Device Android Phone (Host) <-> Chromebook (FPV + Xbox Driver) WebRTC Bridge
//   Phase 2: Real-Time 5-Sector Floor Vision, Optical Flow, Tap-to-Follow (AI + HSV), Smart Co-Pilot
//   Phase 3: Autonomous Vision Explorer, Live 2D Occupancy Room Map & Photo Discovery Log

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
  BridgeLinkState,
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
import { renderVirtualRoverCamera } from "../sim/virtualRoverCamera";
import { mixArcadeToTank } from "../utils/driveMath";
import { OnDeviceObjectDetector } from "../vision/aiObjectDetector";
import {
  analyzeFloorCorridors,
  computeOpticalFlow,
  detectFloorLaneOffset,
  HsvLockModel,
  sampleHsvTarget,
  trackHsvTarget,
} from "../vision/roverVision";
import { FpvOverlaySvg } from "./FpvOverlaySvg";
import {
  IconCamera,
  IconCompass,
  IconFlashlight,
  IconMic,
  IconShield,
  IconStop,
  IconTarget,
  IconWifi,
} from "./Icons";
import { RoomMapCanvas } from "./RoomMapCanvas";
import { XboxHudStrip } from "./XboxHudStrip";

export interface RoverCockpitStationProps {
  connected: boolean;
  demoMode: boolean;
  disabled: boolean;
  safeMode: boolean;
  headHomed: boolean;
  headDeg: number;
  pickedUp: boolean;
  distancePct: number;
  telemetry: TelemetryFrame | null;
  floorX: number;
  floorY: number;
  headingDeg: number;
  headlightsOn: boolean;
  onHeadlightsChange: (on: boolean) => void;
  onSimulatedDistance?: (pct: number) => void;
  onLaunchDemo: () => void;
  onDrive: (left: number, right: number, timeoutMs?: number) => void;
  onHead: (angleDeg: number, speed?: number, coalesce?: boolean) => void;
  onSynth: (voice: number, presetOrNote: number, durMs?: number) => void;
  onSetHubLed: (r: number, g: number, b: number) => void;
  onSetMode: (modeId: number) => void;
  onPlayMacro: () => Promise<void>;
  onStopMacro: () => Promise<void>;
}

type RoverSubView = "driver" | "host" | "voice";

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
  { id: "explore-room", label: "Explore Room", sub: "Map new floor areas" },
  { id: "find-person", label: "Find Person", sub: "Seek & greet a human" },
  { id: "find-object", label: "Find Objects", sub: "Photograph landmarks" },
  { id: "return-home", label: "Return Home", sub: "Steer back to start" },
];
const VISION_W = 80;
const VISION_H = 60;

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

function readInitialQueryParams(): { subView: RoverSubView; joinCode: string } {
  if (typeof window === "undefined") return { subView: "driver", joinCode: "" };
  try {
    const params = new URLSearchParams(window.location.search);
    const role = params.get("role");
    const join = params.get("join");
    return {
      subView: role === "host" ? "host" : "driver",
      joinCode: join ? normalizeRoomCode(join) : "",
    };
  } catch {
    return { subView: "driver", joinCode: "" };
  }
}

function captureThumbnail(source: HTMLVideoElement | HTMLCanvasElement | null): string | undefined {
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
  connected,
  demoMode,
  disabled,
  safeMode,
  headHomed,
  headDeg,
  pickedUp,
  distancePct,
  telemetry,
  floorX,
  floorY,
  headingDeg,
  headlightsOn,
  onHeadlightsChange,
  onSimulatedDistance,
  onLaunchDemo,
  onDrive,
  onHead,
  onSynth,
  onSetHubLed,
  onSetMode,
  onPlayMacro,
  onStopMacro,
}) => {
  const initParams = readInitialQueryParams();
  const [subView, setSubView] = useState<RoverSubView>(initParams.subView);
  const [roomCode, setRoomCode] = useState<string>(() => generateRoomCode(4));
  const [joinCode, setJoinCode] = useState<string>(initParams.joinCode);
  const [linkState, setLinkState] = useState<BridgeLinkState>("idle");
  const [linkDetail, setLinkDetail] = useState<string>("Not paired over Wi-Fi yet");
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [showOfflineFallback, setShowOfflineFallback] = useState(false);
  const [offlineOfferText, setOfflineOfferText] = useState("");
  const [offlineAnswerText, setOfflineAnswerText] = useState("");

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
    "Smart Co-Pilot ready — tap any object to follow"
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

  // Android Rover Host state
  const [hostCameraActive, setHostCameraActive] = useState(false);
  const [hostCameraError, setHostCameraError] = useState<string | null>(null);
  const [hostTorchSupported, setHostTorchSupported] = useState(false);
  const [hostWakeLocked, setHostWakeLocked] = useState(false);
  const [phoneHeadingDeg, setPhoneHeadingDeg] = useState<number | null>(null);

  // Voice Commander state
  const speechSupported = Boolean(getSpeechRecognitionCtor());
  const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [listening, setListening] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [commandInput, setCommandInput] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [feed, setFeed] = useState<VoiceBubble[]>([]);

  // Refs
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const hostVideoRef = useRef<HTMLVideoElement | null>(null);
  const demoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const visionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostStreamRef = useRef<MediaStream | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const bridgeRef = useRef<RoverWebRtcBridge | null>(null);
  const xboxRef = useRef(new XboxControllerReader());
  const driveCtrlRef = useRef(new IntelligentDriveController());
  const explorerRef = useRef(new IntelligentExplorer());
  const mapperRef = useRef(new RoomMapper());
  const aiDetectorRef = useRef(new OnDeviceObjectDetector());
  const prevLumaRef = useRef<Uint8Array | null>(null);
  const hsvLockRef = useRef<HsvLockModel | null>(null);
  const lockedLabelRef = useRef<string | null>(null);
  const latestVisionRef = useRef<RoverVisionSnapshot | null>(null);
  const latestAiBoxesRef = useRef<DetectedObjectBox[]>([]);
  const lastAiRunRef = useRef<number>(0);
  const lastMapPushRef = useRef<number>(0);
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

  lockedLabelRef.current = lockedLabel;

  const liveRef = useRef({
    connected,
    demoMode,
    disabled,
    safeMode,
    headHomed,
    headDeg,
    pickedUp,
    distancePct,
    telemetry,
    floorX,
    floorY,
    headingDeg,
    headlightsOn,
    speedCap,
    assistMode,
    collisionGuard,
    headingHold,
    laneAssist,
    aiEnabled,
    mission,
    hostTorchSupported,
    phoneHeadingDeg,
    ttsEnabled,
  });
  liveRef.current = {
    connected,
    demoMode,
    disabled,
    safeMode,
    headHomed,
    headDeg,
    pickedUp,
    distancePct,
    telemetry,
    floorX,
    floorY,
    headingDeg,
    headlightsOn,
    speedCap,
    assistMode,
    collisionGuard,
    headingHold,
    laneAssist,
    aiEnabled,
    mission,
    hostTorchSupported,
    phoneHeadingDeg,
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
    onSimulatedDistance,
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
    onSimulatedDistance,
  };

  // Lazy-load AI Object Detector when toggled ON
  useEffect(() => {
    if (!aiEnabled) {
      setAiStatusNote(null);
      return;
    }
    if (demoMode) {
      setAiStatusNote("Demo AI Object Recognition active (5 room landmarks)");
      return;
    }
    if (subView === "host" || hostCameraActive) {
      setAiStatusNote("Loading on-device EfficientDet-Lite0 model…");
      void aiDetectorRef.current.load().then((ok) => {
        setAiStatusNote(
          ok
            ? "On-device AI Vision ready (80 object classes)"
            : aiDetectorRef.current.getError() ?? "AI Vision unavailable offline"
        );
      });
    } else {
      setAiStatusNote("AI Vision requested on Android Rover phone");
    }
  }, [aiEnabled, demoMode, hostCameraActive, subView]);

  // Reset Explorer FSM cleanly whenever switching into explorer or changing mission
  useEffect(() => {
    if (assistMode === "explorer") {
      explorerRef.current.reset();
    }
  }, [assistMode, mission]);

  // Sync PilotConfig to Android Rover Host whenever settings change while connected
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
    (label: string, confidence: number, sourceEl: HTMLVideoElement | HTMLCanvasElement | null) => {
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

  // Sample HSV color target from either host video or demo canvas
  const handleTapSampleLocal = useCallback((normX: number, normY: number) => {
    const sourceEl: HTMLVideoElement | HTMLCanvasElement | null =
      hostVideoRef.current && hostStreamRef.current
        ? hostVideoRef.current
        : demoCanvasRef.current;
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

  // Initialize singleton WebRTC bridge
  useEffect(() => {
    const bridge = new RoverWebRtcBridge({
      onStateChange: (st, detail) => {
        setLinkState(st);
        if (detail) setLinkDetail(detail);
        if (st !== "connected") {
          setPingMs(null);
          if (st === "idle") {
            setHasRemoteVideo(false);
            setRemoteTelemetry(null);
            setRemoteBleOk(false);
            setRemoteVision(null);
            setRemoteMap(null);
          }
        }
      },
      onRemoteStream: (stream) => {
        setHasRemoteVideo(true);
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = stream;
          void remoteVideoRef.current.play().catch(() => undefined);
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
        if (msg.type === "stop") {
          hostDriverInputRef.current = { steer: 0, throttle: 0, at: 0 };
          hsvLockRef.current = null;
          setLockedLabel(null);
          if (liveRef.current.assistMode === "explorer") {
            setAssistMode("copilot");
          }
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
            // Manual stick immediately overrides Auto Explorer!
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
    return () => {
      bridge.stop();
      bridgeRef.current = null;
    };
  }, [applyHostTorch, handleTapSampleLocal]);

  // Android Rover Host: 10 Hz Vision + 2D Room Mapping + Co-Pilot Pursuit + Auto Explorer Brain!
  useEffect(() => {
    if (!hostCameraActive) return;
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

    const id = window.setInterval(() => {
      const video = hostVideoRef.current;
      const st = liveRef.current;
      if (!video || video.readyState < 2) return;

      ctx!.drawImage(video, 0, 0, VISION_W, VISION_H);
      const img = ctx!.getImageData(0, 0, VISION_W, VISION_H);
      const floor = analyzeFloorCorridors(img.data, VISION_W, VISION_H);
      const flow = computeOpticalFlow(prevLumaRef.current, img.data, VISION_W, VISION_H);
      prevLumaRef.current = flow.luma;
      const laneOffset = st.laneAssist ? detectFloorLaneOffset(img.data, VISION_W, VISION_H) : null;

      const now = Date.now();
      if (st.aiEnabled && aiDetectorRef.current.isReady() && now - lastAiRunRef.current >= 240) {
        lastAiRunRef.current = now;
        latestAiBoxesRef.current = aiDetectorRef.current.detectVideo(video, performance.now());
      } else if (!st.aiEnabled) {
        latestAiBoxesRef.current = [];
      }

      const objects: DetectedObjectBox[] = [...latestAiBoxesRef.current];
      let lockedTarget: DetectedObjectBox | null = null;

      if (hsvLockRef.current) {
        const tracked = trackHsvTarget(img.data, VISION_W, VISION_H, hsvLockRef.current);
        if (tracked) {
          objects.push(tracked);
          lockedTarget = tracked;
        }
      } else if (lockedLabelRef.current) {
        lockedTarget = objects.find((b) => b.label === lockedLabelRef.current) ?? null;
      }

      // Update live 2D Occupancy Room Map
      mapperRef.current.update({
        encA: st.telemetry?.encA ?? 0,
        encB: st.telemetry?.encB ?? 0,
        gyroHeadingDeg: st.phoneHeadingDeg,
        frontDistancePct: st.distancePct,
        corridors: floor.corridors,
      });

      const driverIdle = now - hostDriverInputRef.current.at > 280;
      let noteOut = driverIdle
        ? lockedTarget
          ? `Following ${lockedTarget.label}`
          : "Smart Co-Pilot ready"
        : hostAssistNoteRef.current;
      let interveningOut = driverIdle ? "none" : hostInterveningRef.current;
      let fsmOut = "IDLE";
      let stuckNow = false;

      if (st.connected && !st.disabled && st.assistMode === "explorer") {
        const expRes = explorerRef.current.step({
          nowMs: now,
          mission: st.mission,
          speedCap: st.speedCap,
          pickedUp: st.pickedUp,
          safeMode: st.safeMode,
          bump: Boolean(st.telemetry && (st.telemetry.flags & TelemetryFlag.BUMP)),
          frontDistancePct: st.distancePct,
          corridors: floor.corridors,
          bestSteer: floor.bestSteer,
          flowForward: flow.flowForward,
          encA: st.telemetry?.encA ?? 0,
          encB: st.telemetry?.encB ?? 0,
          objects,
          mapper: mapperRef.current,
        });
        fsmOut = expRes.state;
        noteOut = expRes.statusNote;
        interveningOut =
          expRes.state === "AVOIDING" || expRes.state === "UNSTICKING" ? "dodging" : "none";
        stuckNow = expRes.state === "UNSTICKING";
        hostAssistNoteRef.current = noteOut;
        hostInterveningRef.current = interveningOut;
        setExplorerState(expRes.state);
        setAssistNote(expRes.statusNote);
        setAssistIntervening(interveningOut);
        setRecoveries(expRes.recoveries);
        cbRef.current.onDrive(expRes.left, expRes.right, 380);
        if (expRes.synthSfx) cbRef.current.onSynth(0, expRes.synthSfx, 0);
        if (expRes.discovery) {
          recordDiscovery(expRes.discovery.label, expRes.discovery.confidence, video);
        }
      } else if (st.connected && !st.disabled && st.assistMode === "copilot" && driverIdle && lockedTarget) {
        const res = driveCtrlRef.current.step({
          rawSteer: 0,
          rawThrottle: 0,
          speedCap: st.speedCap,
          frontDistancePct: st.distancePct,
          corridors: floor.corridors,
          pickedUp: st.pickedUp,
          safeMode: st.safeMode,
          headingDeg: st.phoneHeadingDeg,
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
        hostAssistNoteRef.current = noteOut;
        hostInterveningRef.current = interveningOut;
        setAssistNote(res.statusNote);
        setAssistIntervening(res.intervening);
        cbRef.current.onDrive(res.left, res.right, 350);
      }

      const snapshot: RoverVisionSnapshot = {
        corridors: floor.corridors,
        bestSteer: floor.bestSteer,
        flowForward: flow.flowForward,
        stuck: stuckNow,
        laneOffset,
        lockedTarget,
        objects,
        aiReady: aiDetectorRef.current.isReady(),
      };
      latestVisionRef.current = snapshot;
      setLocalVision(snapshot);

      const isHostLive =
        bridgeRef.current?.getRole() === "rover-host" && bridgeRef.current.isDataChannelOpen();

      if (now - lastMapPushRef.current >= 450) {
        lastMapPushRef.current = now;
        const mapSnap = mapperRef.current.getSnapshot();
        setLocalMap(mapSnap);
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
          phoneHeadingDeg: st.phoneHeadingDeg,
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
  }, [hostCameraActive, recordDiscovery]);

  // Driver Client: 1 Hz RTT ping monitor
  useEffect(() => {
    if (linkState !== "connected" || bridgeRef.current?.getRole() !== "driver-client") return;
    const id = window.setInterval(() => {
      bridgeRef.current?.sendToRover({ type: "ping", sentAt: Date.now() });
    }, 1200);
    return () => window.clearInterval(id);
  }, [linkState]);

  // Android Phone Gyroscope orientation listener while hosting
  useEffect(() => {
    if (!hostCameraActive) return;
    const onOrient = (ev: DeviceOrientationEvent) => {
      if (typeof ev.alpha === "number" && Number.isFinite(ev.alpha)) {
        setPhoneHeadingDeg(Math.round((360 - ev.alpha) % 360));
      }
    };
    window.addEventListener("deviceorientation", onOrient);
    return () => window.removeEventListener("deviceorientation", onOrient);
  }, [hostCameraActive]);

  const stopHostCamera = useCallback(() => {
    bridgeRef.current?.stop();
    const s = hostStreamRef.current;
    hostStreamRef.current = null;
    if (s) s.getTracks().forEach((t) => t.stop());
    if (hostVideoRef.current) hostVideoRef.current.srcObject = null;
    setHostCameraActive(false);
    setHostTorchSupported(false);
    if (wakeLockRef.current) {
      void wakeLockRef.current.release().catch(() => undefined);
      wakeLockRef.current = null;
      setHostWakeLocked(false);
    }
  }, []);

  const startHostCameraAndBroadcast = useCallback(async () => {
    setHostCameraError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setHostCameraError("Camera API unavailable in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24, max: 30 },
        },
        audio: false,
      });
      hostStreamRef.current = stream;
      if (hostVideoRef.current) {
        hostVideoRef.current.srcObject = stream;
        await hostVideoRef.current.play().catch(() => undefined);
      }
      setHostCameraActive(true);

      const track = stream.getVideoTracks()[0];
      const caps = track?.getCapabilities ? (track.getCapabilities() as { torch?: boolean }) : {};
      setHostTorchSupported(Boolean(caps.torch));

      const navWithWake = navigator as unknown as {
        wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> };
      };
      if (navWithWake.wakeLock) {
        try {
          wakeLockRef.current = await navWithWake.wakeLock.request("screen");
          setHostWakeLocked(true);
        } catch {
          setHostWakeLocked(false);
        }
      }

      await bridgeRef.current?.startHost(roomCode, stream);
    } catch (err) {
      setHostCameraError(err instanceof Error ? err.message : String(err));
    }
  }, [roomCode]);

  const handleJoinAsDriver = async () => {
    const code = normalizeRoomCode(joinCode);
    if (!code) return;
    setJoinCode(code);
    try {
      await bridgeRef.current?.startDriver(code);
    } catch {
      // Status shown in linkDetail
    }
  };

  const isRemoteDriverLive =
    linkState === "connected" && bridgeRef.current?.getRole() === "driver-client";
  const fpvCanDrive = (isRemoteDriverLive && remoteBleOk) || (connected && !disabled);

  const sendFpvDrive = useCallback(
    (left: number, right: number, steer = 0, throttle = 0, timeoutMs = 400) => {
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
    if (liveRef.current.assistMode === "explorer") {
      setAssistMode("copilot");
    }
    setSteerVis(0);
    setThrottleVis(0);
    driveCtrlRef.current.reset();
    explorerRef.current.reset();
    if (bridgeRef.current?.getRole() === "driver-client" && bridgeRef.current.isDataChannelOpen()) {
      bridgeRef.current.sendToRover({ type: "stop" });
    } else if (liveRef.current.connected) {
      cbRef.current.onDrive(0, 0, 200);
      cbRef.current.onSynth(0, 0, 0);
    }
  }, []);

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
    if (!hasRemoteVideo && !demoMode) return;
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

  // Keyboard WASD/Arrows + Space STOP inside FPV Driver view
  useEffect(() => {
    if (subView !== "driver") return;
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
  }, [sendFpvStop, subView]);

  // 16 Hz FPV Xbox + WASD + Touch + Smart Co-Pilot + Local Demo Auto-Explorer Drive Loop!
  useEffect(() => {
    if (subView !== "driver") return;
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
          const vis = latestVisionRef.current;
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

      let outLeft = 0;
      let outRight = 0;
      let effSteer = rawSteer;
      let effThrottle = rawThrottle;

      if (!isRemoteDriverLive && st.assistMode === "explorer" && !manualActive) {
        const vis = latestVisionRef.current;
        const expRes = explorerRef.current.step({
          nowMs: Date.now(),
          mission: st.mission,
          speedCap: st.speedCap,
          pickedUp: st.pickedUp,
          safeMode: st.safeMode,
          bump: Boolean(st.telemetry && (st.telemetry.flags & TelemetryFlag.BUMP)),
          frontDistancePct: st.distancePct,
          corridors: vis?.corridors ?? [0.7, 0.7, 0.7, 0.7, 0.7],
          bestSteer: vis?.bestSteer ?? 0,
          flowForward: vis?.flowForward ?? 0.5,
          encA: st.telemetry?.encA ?? 0,
          encB: st.telemetry?.encB ?? 0,
          objects: vis?.objects ?? [],
          mapper: mapperRef.current,
        });
        outLeft = expRes.left;
        outRight = expRes.right;
        effSteer = expRes.steer;
        effThrottle = expRes.throttle;
        setExplorerState(expRes.state);
        setAssistNote(expRes.statusNote);
        setRecoveries(expRes.recoveries);
        setAssistIntervening(
          expRes.state === "AVOIDING" || expRes.state === "UNSTICKING" ? "dodging" : "none"
        );
        if (expRes.synthSfx) cbRef.current.onSynth(0, expRes.synthSfx, 0);
        if (expRes.discovery) {
          recordDiscovery(expRes.discovery.label, expRes.discovery.confidence, demoCanvasRef.current);
        }
      } else if (!isRemoteDriverLive && st.assistMode === "copilot") {
        const vis = latestVisionRef.current;
        const res = driveCtrlRef.current.step({
          rawSteer,
          rawThrottle,
          speedCap: st.speedCap,
          frontDistancePct: st.distancePct,
          corridors: vis?.corridors ?? [0.8, 0.8, 0.8, 0.8, 0.8],
          pickedUp: st.pickedUp,
          safeMode: st.safeMode,
          headingDeg: st.demoMode ? st.headingDeg : st.phoneHeadingDeg,
          encA: st.telemetry?.encA ?? 0,
          encB: st.telemetry?.encB ?? 0,
          collisionGuard: st.collisionGuard,
          headingHold: st.headingHold,
          laneAssist: st.laneAssist,
          laneOffset: vis?.laneOffset ?? null,
          lockedTarget: vis?.lockedTarget ?? null,
        });
        outLeft = res.left;
        outRight = res.right;
        effSteer = res.effectiveSteer;
        effThrottle = res.effectiveThrottle;
        setAssistNote(res.statusNote);
        setAssistIntervening(res.intervening);
      } else {
        const mixed =
          sample.connected && !touchDraggingRef.current && keysRef.current.size === 0
            ? mixXboxToTank(rawSteer, rawThrottle, st.speedCap)
            : mixArcadeToTank(rawSteer, rawThrottle, st.speedCap);
        outLeft = mixed.left;
        outRight = mixed.right;
        setAssistIntervening("none");
      }

      setSteerVis(effSteer);
      setThrottleVis(effThrottle);

      if (outLeft !== 0 || outRight !== 0) {
        wasDrivingRef.current = true;
        sendFpvDrive(outLeft, outRight, rawSteer, rawThrottle, 400);
      } else if (wasDrivingRef.current) {
        wasDrivingRef.current = false;
        sendFpvDrive(0, 0, 0, 0, 200);
      }
    }, 62);

    return () => window.clearInterval(id);
  }, [
    fpvCanDrive,
    isRemoteDriverLive,
    recordDiscovery,
    selectOrToggleObject,
    sendFpvDrive,
    sendFpvStop,
    sendHorn,
    subView,
    toggleHeadlights,
  ]);

  // Procedural 3D-perspective Demo FPV Rover Canvas + Real Pixel Vision + Live 2D Room Map!
  useEffect(() => {
    if (subView !== "driver" || !demoMode || hasRemoteVideo) return;
    const canvas = demoCanvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    const vc = visionCanvasRef.current ?? document.createElement("canvas");
    vc.width = VISION_W;
    vc.height = VISION_H;
    visionCanvasRef.current = vc;
    let vCtx: CanvasRenderingContext2D | null = null;
    try {
      vCtx = vc.getContext("2d", { willReadFrequently: true });
    } catch {
      vCtx = null;
    }

    const id = window.setInterval(() => {
      const st = liveRef.current;
      const res = renderVirtualRoverCamera(
        ctx!,
        canvas.width,
        canvas.height,
        st.floorX,
        st.floorY,
        st.headingDeg,
        st.headlightsOn
      );
      cbRef.current.onSimulatedDistance?.(res.frontDistancePct);

      let corridors = res.trueCorridors;
      let bestSteer = 0;
      let flowForward = 0;
      let laneOffset: number | null = null;
      const objects: DetectedObjectBox[] = [...res.visibleObjects];
      let lockedTarget: DetectedObjectBox | null = null;

      if (vCtx) {
        vCtx.drawImage(canvas, 0, 0, VISION_W, VISION_H);
        const img = vCtx.getImageData(0, 0, VISION_W, VISION_H);
        const floor = analyzeFloorCorridors(img.data, VISION_W, VISION_H);
        corridors = res.trueCorridors.map((g, i) =>
          Number((g * 0.55 + floor.corridors[i] * 0.45).toFixed(2))
        ) as [number, number, number, number, number];
        bestSteer = floor.bestSteer;
        const flow = computeOpticalFlow(prevLumaRef.current, img.data, VISION_W, VISION_H);
        prevLumaRef.current = flow.luma;
        flowForward = flow.flowForward;
        laneOffset = st.laneAssist ? detectFloorLaneOffset(img.data, VISION_W, VISION_H) : null;

        if (hsvLockRef.current) {
          const tracked = trackHsvTarget(img.data, VISION_W, VISION_H, hsvLockRef.current);
          if (tracked) {
            objects.push(tracked);
            lockedTarget = tracked;
          }
        }
      }

      if (!lockedTarget && lockedLabelRef.current) {
        lockedTarget = objects.find((b) => b.label === lockedLabelRef.current) ?? null;
      }

      // Feed Demo Rover pose into live 2D Occupancy Room Mapper!
      mapperRef.current.update({
        encA: st.telemetry?.encA ?? 0,
        encB: st.telemetry?.encB ?? 0,
        gyroHeadingDeg: st.headingDeg,
        frontDistancePct: res.frontDistancePct,
        corridors,
        explicitPoseCm: { x: st.floorX, y: st.floorY, headingDeg: st.headingDeg },
      });

      const now = Date.now();
      if (now - lastMapPushRef.current >= 220) {
        lastMapPushRef.current = now;
        setLocalMap(mapperRef.current.getSnapshot());
      }

      const snap: RoverVisionSnapshot = {
        corridors,
        bestSteer,
        flowForward,
        stuck: false,
        laneOffset,
        lockedTarget,
        objects,
        aiReady: st.aiEnabled,
      };
      latestVisionRef.current = snap;
      setLocalVision(snap);
    }, 80);
    return () => window.clearInterval(id);
  }, [demoMode, hasRemoteVideo, subView]);

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
            (st.connected || isRemoteDriverLive ? "Done!" : "Understood (connect robot or launch Demo)."),
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

  // Global teardown on unmount
  useEffect(() => {
    return () => {
      if (wasDrivingRef.current) sendFpvStop();
      stopHostCamera();
      stopListening();
      aiDetectorRef.current.dispose();
    };
  }, [sendFpvStop, stopHostCamera, stopListening]);

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
  const hudHeading = isRemoteDriverLive
    ? remoteHeading
    : demoMode
      ? Math.round(headingDeg)
      : phoneHeadingDeg;
  const hudSafe = Boolean(hudTelemetry && (hudTelemetry.flags & TelemetryFlag.SAFE_MODE));
  const activeAssistStatus = isRemoteDriverLive && remoteAssistNote ? remoteAssistNote : assistNote;
  const activeAssistIntervening = isRemoteDriverLive ? remoteAssistIntervening : assistIntervening;
  const activeExplorerBadge =
    isRemoteDriverLive && remoteExplorerState ? remoteExplorerState : explorerState;

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
    <div className="station-stack">
      {/* Top Role Switcher */}
      <div className="fpv-role-bar">
        <div className="segmented-mini" role="tablist" aria-label="Rover camera role">
          <button
            type="button"
            id="role-driver"
            role="tab"
            aria-selected={subView === "driver"}
            className={subView === "driver" ? "is-active" : ""}
            onClick={() => setSubView("driver")}
          >
            Chromebook FPV Driver
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
          <IconWifi size={14} />
          <span>
            {linkState === "connected"
              ? `Wi-Fi FPV Live${pingMs ? ` · ${pingMs} ms` : ""}`
              : demoMode
                ? "Simulated 3D Rover Camera"
                : linkDetail}
          </span>
        </div>
      </div>

      {/* =========================================
          VIEW 1: CHROMEBOOK FPV DRIVER COCKPIT
         ========================================= */}
      {subView === "driver" && (
        <div className="station-stack">
          <section className="console-panel fpv-cockpit-panel" aria-label="FPV Rover Driver Cockpit">
            {/* Wi-Fi Room Code Pairing Strip */}
            <div className="fpv-pair-strip">
              <div className="fpv-pair-left">
                <span className="engraved-label">Pair with Android Phone on Tank</span>
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
                      onClick={() => void handleJoinAsDriver()}
                    >
                      <IconWifi size={14} />
                      <span>Connect to Tank</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="action-cluster">
                {!demoMode && !isRemoteDriverLive && (
                  <button
                    type="button"
                    id="btn-fpv-demo"
                    className="keycap keycap-amber keycap-sm"
                    onClick={onLaunchDemo}
                  >
                    Try Demo FPV Rover
                  </button>
                )}
                <button
                  type="button"
                  className="chip-btn"
                  onClick={() => setShowOfflineFallback((v) => !v)}
                >
                  {showOfflineFallback ? "Hide Offline Pairing" : "Offline Direct Pair"}
                </button>
              </div>
            </div>

            {showOfflineFallback && (
              <div className="offline-pair-box">
                <span className="engraved-label">Zero-Server LAN Pairing (Copy/Paste Offer &amp; Answer)</span>
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
                className={`fpv-media ${hasRemoteVideo ? "" : "is-hidden"}`}
                playsInline
                muted
                autoPlay
              />

              {demoMode && !hasRemoteVideo && (
                <canvas
                  ref={demoCanvasRef}
                  width={640}
                  height={360}
                  className="fpv-media"
                  aria-label="Simulated 3D FPV rover camera"
                />
              )}

              {!hasRemoteVideo && !demoMode && (
                <div className="fpv-standby">
                  <IconCamera size={36} />
                  <h3>Ready for First-Person Tank Driving</h3>
                  <p>
                    Open Vernie Pilot on your spare Android phone, switch to{" "}
                    <strong>Android Phone on Tank</strong>, and enter its 4-character Room Code
                    above — or click <strong>Try Demo FPV Rover</strong> to test Xbox driving, Smart
                    Co-Pilot &amp; Autonomous Exploration right now.
                  </p>
                  <button type="button" className="keycap keycap-amber" onClick={onLaunchDemo}>
                    Launch Demo FPV Rover
                  </button>
                </div>
              )}

              {(hasRemoteVideo || demoMode) && (
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
                        hudDist <= 30
                          ? "visor-chip-red"
                          : hudDist <= 55
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
              {showTouchPad && (hasRemoteVideo || demoMode) && (
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

            <XboxHudStrip sample={xboxSample} />
          </section>

          {/* PHASE 3: LIVE 2D EXPLORATION MAP & ROVER DISCOVERY LOG */}
          {(hasRemoteVideo || demoMode) && (
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
                      Snapshots automatically logged when Auto Explorer spots people or interesting objects
                    </p>
                  </div>
                  <span className="status-tag">{discoveries.length} FOUND</span>
                </div>

                {discoveries.length === 0 ? (
                  <div className="timeline-empty">
                    Switch Pilot Mode to <strong>Auto Explorer</strong> (or press <strong>Xbox Y</strong>)
                    to let your tank roam, map the room, and photograph discoveries here. Touching the
                    Xbox stick or WASD always takes back manual control instantly.
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
                  Strap this phone low &amp; centered on your tank — runs real-time vision, 2D room
                  mapping &amp; autonomous exploration locally while streaming FPV over Wi-Fi
                </p>
              </div>
              <span className={`status-tag ${hostCameraActive ? "is-live" : ""}`}>
                {hostCameraActive ? "STREAMING" : "STANDBY"}
              </span>
            </div>

            {hostCameraError && <div className="notice notice-danger">{hostCameraError}</div>}

            <div className="room-code-hero">
              <div>
                <span className="engraved-label">Enter This Code on Chromebook</span>
                <div className="room-code-display mono-num" aria-label="Rover Room Code">
                  {roomCode.split("").join(" ")}
                </div>
              </div>
              <button
                type="button"
                className="keycap keycap-subtle keycap-sm"
                disabled={hostCameraActive}
                onClick={() => setRoomCode(generateRoomCode(4))}
              >
                New Code
              </button>
            </div>

            <div className="host-checklist">
              <div className={`host-check-item ${connected ? "is-ok" : ""}`}>
                <strong>1. Move Hub Bluetooth</strong>
                <span>{connected ? "Connected & ready" : "Tap Connect Robot in top bar first"}</span>
              </div>
              <div className={`host-check-item ${hostCameraActive ? "is-ok" : ""}`}>
                <strong>2. Rear Camera, Vision &amp; Wake Lock</strong>
                <span>
                  {hostCameraActive
                    ? `Active${hostWakeLocked ? " · Awake" : ""}${phoneHeadingDeg !== null ? ` · Gyro ${phoneHeadingDeg}°` : ""}${aiEnabled ? " · AI ON" : ""}`
                    : "Tap Start Rear Camera & Host below"}
                </span>
              </div>
              <div className={`host-check-item ${linkState === "connected" ? "is-ok" : ""}`}>
                <strong>3. Chromebook Wi-Fi Link</strong>
                <span>{linkDetail} · 500 ms link-drop auto-stop armed</span>
              </div>
            </div>

            <div className="action-cluster">
              {hostCameraActive ? (
                <button
                  type="button"
                  id="btn-stop-host"
                  className="keycap keycap-stop"
                  onClick={stopHostCamera}
                >
                  Stop Tank Camera &amp; Host
                </button>
              ) : (
                <button
                  type="button"
                  id="btn-start-host"
                  className="keycap keycap-green"
                  onClick={() => void startHostCameraAndBroadcast()}
                >
                  <IconCamera size={15} />
                  <span>Start Rear Camera &amp; Host</span>
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
                disabled={!connected || !hostCameraActive}
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

            {hostCameraActive && (
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
              <video ref={hostVideoRef} className="viewfinder-video" muted playsInline />
              {!hostCameraActive && (
                <div className="viewfinder-standby">
                  <IconCamera size={28} />
                  <span>Rear camera preview appears here once hosted</span>
                </div>
              )}
              {hostCameraActive && localVision && (
                <FpvOverlaySvg
                  steer={localVision.bestSteer}
                  frontDistPct={hudDist}
                  vision={localVision}
                  showCorridors={true}
                />
              )}
            </div>

            <div className="field-stack">
              <button
                type="button"
                className="chip-btn"
                onClick={() => setShowOfflineFallback((v) => !v)}
              >
                {showOfflineFallback ? "Hide Offline Pairing" : "Offline Zero-Server Pairing"}
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
