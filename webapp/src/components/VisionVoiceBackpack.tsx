// SPDX-License-Identifier: MIT
// Phase 5 Optional Vision & Voice Backpack Tab:
// Offline-capable Chromebook / Phone Webcam Target & Wave Tracker + Web Speech Voice Assistant.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  analyzeColorTarget,
  analyzeMotionFrame,
  computeTrackingAction,
  VisionDetector,
  VisionObservation,
  VisionTrackMode,
} from "../vision/visionEngine";
import { parseVoiceCommand, VoiceAction } from "../vision/voiceCommands";

export interface VisionVoiceBackpackProps {
  connected: boolean;
  disabled: boolean;
  safeMode: boolean;
  headHomed: boolean;
  headDeg: number;
  pickedUp: boolean;
  distancePct: number;
  onDrive: (left: number, right: number, timeoutMs?: number) => void;
  onHead: (angleDeg: number, speed?: number, coalesce?: boolean) => void;
  onSynth: (voice: number, presetOrNote: number, durMs?: number) => void;
  onSetHubLed: (r: number, g: number, b: number) => void;
  onSetMode: (modeId: number) => void;
  onPlayMacro: () => Promise<void>;
  onStopMacro: () => Promise<void>;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<{
    isFinal?: boolean;
    0?: { transcript?: string };
  }>;
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

interface VoiceLogEntry {
  id: number;
  transcript: string;
  intent: string;
  reply: string;
  blocked: boolean;
}

const FRAME_W = 64;
const FRAME_H = 48;

const QUICK_COMMANDS: string[] = [
  "Hello Vernie",
  "Look left",
  "Look center",
  "Dance",
  "Explorer mode",
  "Stop",
];

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const VisionVoiceBackpack: React.FC<VisionVoiceBackpackProps> = ({
  connected,
  disabled,
  safeMode,
  headHomed,
  headDeg,
  pickedUp,
  distancePct,
  onDrive,
  onHead,
  onSynth,
  onSetHubLed,
  onSetMode,
  onPlayMacro,
  onStopMacro,
}) => {
  // Vision state
  const [cameraActive, setCameraActive] = useState(false);
  const [trackingEnabled, setTrackingEnabled] = useState(false);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [detector, setDetector] = useState<VisionDetector>("motion");
  const [trackMode, setTrackMode] = useState<VisionTrackMode>("head-follow");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [visionStatus, setVisionStatus] = useState("Camera stopped — enable camera or run a simulated target test.");
  const [observation, setObservation] = useState<VisionObservation>({
    detected: false,
    centroidX: 0,
    centroidY: 0,
    energy: 0,
    waveDetected: false,
  });

  // Voice state
  const speechSupported = Boolean(getSpeechRecognitionCtor());
  const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [listening, setListening] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [manualText, setManualText] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceLog, setVoiceLog] = useState<VoiceLogEntry[]>([]);

  // Refs for clean async/unmount teardown
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  const lastWaveReactRef = useRef<number>(0);
  const smoothedHeadRef = useRef<number>(headDeg);
  const wasDrivingRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const logSeqRef = useRef<number>(1);

  const liveStateRef = useRef({
    connected,
    disabled,
    safeMode,
    headHomed,
    pickedUp,
    distancePct,
    detector,
    trackMode,
    facingMode,
    trackingEnabled,
    ttsEnabled,
  });
  liveStateRef.current = {
    connected,
    disabled,
    safeMode,
    headHomed,
    pickedUp,
    distancePct,
    detector,
    trackMode,
    facingMode,
    trackingEnabled,
    ttsEnabled,
  };

  const callbacksRef = useRef({
    onDrive,
    onHead,
    onSynth,
    onSetHubLed,
    onSetMode,
    onPlayMacro,
    onStopMacro,
  });
  callbacksRef.current = {
    onDrive,
    onHead,
    onSynth,
    onSetHubLed,
    onSetMode,
    onPlayMacro,
    onStopMacro,
  };

  useEffect(() => {
    smoothedHeadRef.current = headDeg;
  }, [headDeg]);

  const speakReply = useCallback((text: string | null) => {
    if (!text || !liveStateRef.current.ttsEnabled) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.08;
      utter.pitch = 1.15;
      window.speechSynthesis.speak(utter);
    } catch {
      // Ignore TTS sandbox restrictions
    }
  }, []);

  const stopCamera = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    prevFrameRef.current = null;
    setCameraActive(false);
    setTrackingEnabled(false);
    setObservation({ detected: false, centroidX: 0, centroidY: 0, energy: 0, waveDetected: false });
    if (wasDrivingRef.current && liveStateRef.current.connected) {
      wasDrivingRef.current = false;
      callbacksRef.current.onDrive(0, 0, 200);
    }
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera API (navigator.mediaDevices.getUserMedia) is unavailable in this browser.");
      return;
    }
    stopCamera();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: liveStateRef.current.facingMode, width: { ideal: 320 }, height: { ideal: 240 } },
        audio: false,
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setCameraActive(true);
      setVisionStatus("Camera live — enable 'Stream to Vernie' to send BLE commands.");
    } catch (err) {
      setCameraError(err instanceof Error ? err.message : String(err));
    }
  }, [stopCamera]);

  const applyObservation = useCallback(
    (obs: VisionObservation, forceStream = false) => {
      setObservation(obs);
      const st = liveStateRef.current;
      if (!st.connected || st.disabled || (!st.trackingEnabled && !forceStream)) {
        if (wasDrivingRef.current && st.connected) {
          wasDrivingRef.current = false;
          callbacksRef.current.onDrive(0, 0, 200);
        }
        return;
      }

      const action = computeTrackingAction(st.trackMode, obs, {
        headHomed: st.headHomed,
        pickedUp: st.pickedUp,
        distancePct: st.distancePct,
        currentHeadDeg: smoothedHeadRef.current,
        maxSpeedPct: 45,
        nowMs: Date.now(),
        lastWaveReactMs: lastWaveReactRef.current,
      });

      setVisionStatus(action.statusNote);

      if (action.drive) {
        const moving = action.drive.left !== 0 || action.drive.right !== 0;
        if (moving || wasDrivingRef.current) {
          wasDrivingRef.current = moving;
          callbacksRef.current.onDrive(action.drive.left, action.drive.right, action.drive.timeoutMs);
        }
      }
      if (action.headDeg !== null) {
        smoothedHeadRef.current = action.headDeg;
        callbacksRef.current.onHead(action.headDeg, 50, true);
      }
      if (action.hubLed) {
        callbacksRef.current.onSetHubLed(action.hubLed[0], action.hubLed[1], action.hubLed[2]);
      }
      if (action.synthSfx !== null) {
        callbacksRef.current.onSynth(0, action.synthSfx, 0);
      }
      if (action.waveTriggered) {
        lastWaveReactRef.current = Date.now();
        speakReply("Hi there! Nice wave!");
      }
    },
    [speakReply]
  );

  // Stop BLE drive immediately if tracking is disabled, disconnected, or Safe Mode triggers
  useEffect(() => {
    if ((!connected || disabled || !trackingEnabled) && wasDrivingRef.current) {
      wasDrivingRef.current = false;
      if (connected) {
        callbacksRef.current.onDrive(0, 0, 200);
      }
    }
  }, [connected, disabled, trackingEnabled]);

  // 10 Hz offscreen canvas vision loop
  useEffect(() => {
    if (!cameraActive) return;

    const canvas = canvasRef.current ?? document.createElement("canvas");
    canvas.width = FRAME_W;
    canvas.height = FRAME_H;
    canvasRef.current = canvas;
    const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx2d) return;

    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      ctx2d.drawImage(video, 0, 0, FRAME_W, FRAME_H);
      const imageData = ctx2d.getImageData(0, 0, FRAME_W, FRAME_H);
      const mirrorX = liveStateRef.current.facingMode === "user";
      const det = liveStateRef.current.detector;

      let obs: VisionObservation;
      if (det === "motion") {
        obs = analyzeMotionFrame(prevFrameRef.current, imageData.data, FRAME_W, FRAME_H, mirrorX);
        prevFrameRef.current = new Uint8ClampedArray(imageData.data);
      } else {
        obs = analyzeColorTarget(imageData.data, FRAME_W, FRAME_H, det, mirrorX);
      }

      applyObservation(obs);
    }, 100);

    return () => window.clearInterval(id);
  }, [applyObservation, cameraActive]);

  // Voice execution dispatcher
  const dispatchVoiceActions = useCallback((actions: VoiceAction[]) => {
    for (const act of actions) {
      switch (act.type) {
        case "drive":
          callbacksRef.current.onDrive(act.left, act.right, act.timeoutMs);
          break;
        case "head":
          callbacksRef.current.onHead(act.angleDeg, act.speed, false);
          break;
        case "synth":
          callbacksRef.current.onSynth(act.voice, act.presetOrNote, act.durMs);
          break;
        case "hubLed":
          callbacksRef.current.onSetHubLed(act.r, act.g, act.b);
          break;
        case "setMode":
          callbacksRef.current.onSetMode(act.modeId);
          break;
        case "playMacro":
          void callbacksRef.current.onPlayMacro().catch(() => undefined);
          break;
        case "stopMacro":
          void callbacksRef.current.onStopMacro().catch(() => undefined);
          break;
      }
    }
  }, []);

  const handleTranscript = useCallback(
    (transcript: string) => {
      const trimmed = transcript.trim();
      if (!trimmed) return;
      const st = liveStateRef.current;
      const parsed = parseVoiceCommand(trimmed, {
        headHomed: st.headHomed,
        pickedUp: st.pickedUp,
        safeMode: st.safeMode,
        speedCap: 50,
      });

      if (!parsed.matched) {
        setVoiceLog((prev) => [
          {
            id: logSeqRef.current++,
            transcript: trimmed,
            intent: "unrecognized",
            reply: "No matching command (try 'hello vernie', 'look left', 'dance', or 'stop').",
            blocked: false,
          },
          ...prev.slice(0, 7),
        ]);
        return;
      }

      if (parsed.intent === "emergency-stop" && typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }

      if (st.connected && parsed.actions.length > 0) {
        dispatchVoiceActions(parsed.actions);
      }
      if (parsed.reply) {
        speakReply(parsed.reply);
      }

      setVoiceLog((prev) => [
        {
          id: logSeqRef.current++,
          transcript: trimmed,
          intent: parsed.intent,
          reply:
            parsed.reply ??
            (st.connected ? "Executed." : "Parsed (connect to VernieOS to send BLE commands)."),
          blocked: parsed.blockedBySafety,
        },
        ...prev.slice(0, 7),
      ]);
    },
    [dispatchVoiceActions, speakReply]
  );

  const stopListening = useCallback(() => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        // Ignore already-stopped recognition
      }
    }
    setListening(false);
  }, []);

  const startListening = useCallback(() => {
    setVoiceError(null);
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setVoiceError("Web Speech Recognition is not supported in this browser; use the text command bar below.");
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
        if (text) {
          handleTranscript(text);
        }
      };
      rec.onerror = (ev) => {
        setVoiceError(`Speech recognition error: ${ev.error ?? "unknown"}`);
        setListening(false);
      };
      rec.onend = () => {
        setListening(false);
      };
      recognitionRef.current = rec;
      rec.start();
      setListening(true);
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : String(err));
      setListening(false);
    }
  }, [handleTranscript, stopListening]);

  // Global unmount teardown (tab switch / page exit)
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopCamera();
      stopListening();
    };
  }, [stopCamera, stopListening]);

  const reticleLeftPct = Math.round(((observation.centroidX + 1) / 2) * 100);
  const reticleTopPct = Math.round(((1 - observation.centroidY) / 2) * 100);

  return (
    <div className="grid">
      <section className="card">
        <div className="card-header">
          <div>
            <h2>Vision Backpack (Webcam / Phone)</h2>
            <p className="subtitle">
              100% local offline frame tracker · Zero CDN/WASM · Auto-stops on disconnect, pickup, or tab switch
            </p>
          </div>
          <span className={`pill ${cameraActive ? "pill-active" : ""}`}>
            {cameraActive ? "CAMERA LIVE" : "CAMERA OFF"}
          </span>
        </div>

        {cameraError && <div className="alert alert-error">{cameraError}</div>}

        <div className="vision-stage" aria-label="Vision tracking viewport">
          <video ref={videoRef} className="vision-video" muted playsInline />
          {!cameraActive && (
            <div className="vision-placeholder">
              <span>Camera preview inactive — click Start Camera or use Simulated Target below.</span>
            </div>
          )}
          {observation.detected && (
            <div
              className={`vision-reticle ${observation.waveDetected ? "vision-reticle-wave" : ""}`}
              style={{ left: `${reticleLeftPct}%`, top: `${reticleTopPct}%` }}
              aria-label="Tracked target reticle"
            />
          )}
        </div>

        <div className="swatch-row">
          {cameraActive ? (
            <button id="btn-stop-camera" className="btn btn-sm btn-danger" onClick={stopCamera}>
              Stop Camera
            </button>
          ) : (
            <button id="btn-start-camera" className="btn btn-sm btn-primary" onClick={() => void startCamera()}>
              Start Camera
            </button>
          )}
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={trackingEnabled}
              disabled={!connected || disabled}
              onChange={(e) => setTrackingEnabled(e.target.checked)}
            />
            <span>Stream BLE commands to Vernie</span>
          </label>
        </div>

        <div className="composer-form">
          <label className="mini-field">
            <span className="meta">Camera Facing</span>
            <select
              aria-label="Camera facing mode"
              className="input-ctrl"
              value={facingMode}
              onChange={(e) => setFacingMode(e.target.value as "user" | "environment")}
            >
              <option value="user">Front (Chromebook)</option>
              <option value="environment">Rear (Phone Backpack)</option>
            </select>
          </label>

          <label className="mini-field">
            <span className="meta">Detector</span>
            <select
              aria-label="Vision detector"
              className="input-ctrl"
              value={detector}
              onChange={(e) => {
                prevFrameRef.current = null;
                setDetector(e.target.value as VisionDetector);
              }}
            >
              <option value="motion">Motion &amp; Wave</option>
              <option value="color-red">Red Brick / Ball</option>
              <option value="color-green">Green Brick / Ball</option>
              <option value="color-blue">Blue Brick / Ball</option>
              <option value="color-yellow">Yellow Brick / Ball</option>
            </select>
          </label>

          <label className="mini-field">
            <span className="meta">Behavior</span>
            <select
              aria-label="Vision tracking behavior"
              className="input-ctrl"
              value={trackMode}
              onChange={(e) => setTrackMode(e.target.value as VisionTrackMode)}
            >
              <option value="head-follow">Head Follow (Needs Homed)</option>
              <option value="body-follow">Body Follow (88007 Guard)</option>
              <option value="wave-react">Wave React (Chirp + LED)</option>
            </select>
          </label>
        </div>

        <div className="diag-row">
          <span className="label">Simulated Target Test (No Camera Required)</span>
          <div className="swatch-row">
            <button
              className="btn btn-sm btn-ghost"
              disabled={!connected || disabled}
              onClick={() =>
                applyObservation(
                  { detected: true, centroidX: -0.75, centroidY: 0.1, energy: 0.08, waveDetected: false },
                  true
                )
              }
            >
              Target Left
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={!connected || disabled}
              onClick={() =>
                applyObservation(
                  { detected: true, centroidX: 0.75, centroidY: 0.1, energy: 0.08, waveDetected: false },
                  true
                )
              }
            >
              Target Right
            </button>
            <button
              className="btn btn-sm btn-secondary"
              disabled={!connected || disabled}
              onClick={() =>
                applyObservation(
                  { detected: true, centroidX: 0, centroidY: 0.45, energy: 0.22, waveDetected: true },
                  true
                )
              }
            >
              Simulate Wave
            </button>
          </div>
          <span className="meta mono-num">
            {visionStatus} · X:{observation.centroidX.toFixed(2)} Y:{observation.centroidY.toFixed(2)} E:
            {Math.round(observation.energy * 100)}%
          </span>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <div>
            <h2>Voice Assistant &amp; Spoken Reactions</h2>
            <p className="subtitle">
              Web Speech API + offline command bar · Dart firing is permanently blocked over voice
            </p>
          </div>
          <span className={`pill ${listening ? "pill-active" : ""}`}>
            {listening ? "LISTENING" : "IDLE"}
          </span>
        </div>

        {voiceError && <div className="alert alert-warn">{voiceError}</div>}

        <div className="swatch-row">
          {listening ? (
            <button id="btn-stop-voice" className="btn btn-sm btn-danger" onClick={stopListening}>
              Stop Listening
            </button>
          ) : (
            <button
              id="btn-start-voice"
              className="btn btn-sm btn-primary"
              disabled={!speechSupported}
              onClick={startListening}
              title={speechSupported ? "Start browser microphone speech recognition" : "SpeechRecognition unsupported in this browser"}
            >
              {speechSupported ? "Start Microphone" : "Mic STT Unavailable"}
            </button>
          )}
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={ttsEnabled}
              disabled={!ttsSupported}
              onChange={(e) => setTtsEnabled(e.target.checked)}
            />
            <span>Speak replies (TTS)</span>
          </label>
        </div>

        <form
          className="voice-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleTranscript(manualText);
            setManualText("");
          }}
        >
          <input
            aria-label="Voice or text command"
            className="input-ctrl voice-input"
            type="text"
            placeholder="Type a command (e.g., 'hello vernie', 'look left', 'dance', 'stop')…"
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-secondary">
            Run Command
          </button>
        </form>

        <div className="diag-row">
          <span className="label">Quick Voice Prompts</span>
          <div className="swatch-row">
            {QUICK_COMMANDS.map((cmd) => (
              <button
                key={cmd}
                className={`btn btn-sm ${cmd === "Stop" ? "btn-danger" : "btn-ghost"}`}
                onClick={() => handleTranscript(cmd)}
              >
                &ldquo;{cmd}&rdquo;
              </button>
            ))}
          </div>
        </div>

        <div className="diag-row">
          <span className="label">Command &amp; Safety Log</span>
          <ol className="macro-list" aria-label="Voice command log">
            {voiceLog.length === 0 ? (
              <li className="meta">
                No commands yet — try clicking a prompt or speaking &ldquo;Hello Vernie&rdquo;.
              </li>
            ) : (
              voiceLog.map((entry) => (
                <li key={entry.id} className="macro-item">
                  <div>
                    <strong className="mono-readout">&ldquo;{entry.transcript}&rdquo;</strong>
                    <div className={entry.blocked ? "meta text-warn" : "meta"}>{entry.reply}</div>
                  </div>
                  <span className={`pill ${entry.blocked ? "pill-danger" : "pill-active"}`}>
                    {entry.intent}
                  </span>
                </li>
              ))
            )}
          </ol>
        </div>
      </section>
    </div>
  );
};
