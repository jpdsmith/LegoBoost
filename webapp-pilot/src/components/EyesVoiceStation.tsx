// SPDX-License-Identifier: MIT
// Station 4 — Eyes & Voice: Offline Camera Target/Wave Tracker + Hands-Free Voice Commander.
// Reuses shared @core/vision engines with strict C2 unhomed head guard and permanent voice dart lockout.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  analyzeColorTarget,
  analyzeMotionFrame,
  computeTrackingAction,
  VisionDetector,
  VisionObservation,
  VisionTrackMode,
} from "@core/vision/visionEngine";
import { parseVoiceCommand, VoiceAction } from "@core/vision/voiceCommands";
import { IconCamera, IconMic, IconShield, IconTarget } from "./Icons";

export interface EyesVoiceStationProps {
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

interface VoiceBubble {
  id: number;
  transcript: string;
  intent: string;
  reply: string;
  blocked: boolean;
}

const FRAME_W = 64;
const FRAME_H = 48;

const DETECTOR_CHIPS: Array<{ id: VisionDetector; label: string; dot: string }> = [
  { id: "motion", label: "Motion & Wave", dot: "#0EA5E9" },
  { id: "color-red", label: "Red", dot: "#DC2626" },
  { id: "color-green", label: "Green", dot: "#16A34A" },
  { id: "color-blue", label: "Blue", dot: "#2563EB" },
  { id: "color-yellow", label: "Yellow", dot: "#EAB308" },
];

const REACTION_CARDS: Array<{ id: VisionTrackMode; title: string; desc: string }> = [
  { id: "head-follow", title: "Follow with Head", desc: "Smoothly turns eyes left & right" },
  { id: "body-follow", title: "Follow with Wheels", desc: "Turns & rolls safely with obstacle guard" },
  { id: "wave-react", title: "Wave to Say Hi", desc: "Chirps happily & flashes green on hand wave" },
];

const QUICK_PHRASES = [
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

export const EyesVoiceStation: React.FC<EyesVoiceStationProps> = ({
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
  const [cameraActive, setCameraActive] = useState(false);
  const [trackingEnabled, setTrackingEnabled] = useState(false);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [detector, setDetector] = useState<VisionDetector>("motion");
  const [trackMode, setTrackMode] = useState<VisionTrackMode>("head-follow");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [visionNote, setVisionNote] = useState("Camera standby · Ready to track");
  const [obs, setObs] = useState<VisionObservation>({
    detected: false,
    centroidX: 0,
    centroidY: 0,
    energy: 0,
    waveDetected: false,
  });

  const speechSupported = Boolean(getSpeechRecognitionCtor());
  const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [listening, setListening] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [commandInput, setCommandInput] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [feed, setFeed] = useState<VoiceBubble[]>([]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  const lastWaveReactRef = useRef<number>(0);
  const smoothedHeadRef = useRef<number>(headDeg);
  const wasDrivingRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const seqRef = useRef<number>(1);

  const liveRef = useRef({
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
  liveRef.current = {
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

  const cbRef = useRef({
    onDrive,
    onHead,
    onSynth,
    onSetHubLed,
    onSetMode,
    onPlayMacro,
    onStopMacro,
  });
  cbRef.current = {
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
      // Ignore browser TTS sandbox blocks
    }
  }, []);

  const stopCamera = useCallback(() => {
    const s = streamRef.current;
    streamRef.current = null;
    if (s) s.getTracks().forEach((t) => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    prevFrameRef.current = null;
    setCameraActive(false);
    setTrackingEnabled(false);
    setObs({ detected: false, centroidX: 0, centroidY: 0, energy: 0, waveDetected: false });
    if (wasDrivingRef.current && liveRef.current.connected) {
      wasDrivingRef.current = false;
      cbRef.current.onDrive(0, 0, 200);
    }
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera access is not available in this browser.");
      return;
    }
    stopCamera();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: liveRef.current.facingMode, width: { ideal: 320 }, height: { ideal: 240 } },
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
      setVisionNote("Camera live — flip 'Send to Robot' on when you want Vernie to follow.");
    } catch (err) {
      setCameraError(err instanceof Error ? err.message : String(err));
    }
  }, [stopCamera]);

  const applyObservation = useCallback(
    (nextObs: VisionObservation, forceStream = false) => {
      setObs(nextObs);
      const st = liveRef.current;
      if (!st.connected || st.disabled || (!st.trackingEnabled && !forceStream)) {
        if (wasDrivingRef.current && st.connected) {
          wasDrivingRef.current = false;
          cbRef.current.onDrive(0, 0, 200);
        }
        return;
      }

      const action = computeTrackingAction(st.trackMode, nextObs, {
        headHomed: st.headHomed,
        pickedUp: st.pickedUp,
        distancePct: st.distancePct,
        currentHeadDeg: smoothedHeadRef.current,
        maxSpeedPct: 45,
        nowMs: Date.now(),
        lastWaveReactMs: lastWaveReactRef.current,
      });

      setVisionNote(action.statusNote);

      if (action.drive) {
        const moving = action.drive.left !== 0 || action.drive.right !== 0;
        if (moving || wasDrivingRef.current) {
          wasDrivingRef.current = moving;
          cbRef.current.onDrive(action.drive.left, action.drive.right, action.drive.timeoutMs);
        }
      }
      if (action.headDeg !== null) {
        smoothedHeadRef.current = action.headDeg;
        cbRef.current.onHead(action.headDeg, 50, true);
      }
      if (action.hubLed) {
        cbRef.current.onSetHubLed(action.hubLed[0], action.hubLed[1], action.hubLed[2]);
      }
      if (action.synthSfx !== null) {
        cbRef.current.onSynth(0, action.synthSfx, 0);
      }
      if (action.waveTriggered) {
        lastWaveReactRef.current = Date.now();
        speak("Hi there! Nice wave!");
      }
    },
    [speak]
  );

  useEffect(() => {
    if ((!connected || disabled || !trackingEnabled) && wasDrivingRef.current) {
      wasDrivingRef.current = false;
      if (connected) cbRef.current.onDrive(0, 0, 200);
    }
  }, [connected, disabled, trackingEnabled]);

  // 10 Hz local offline frame analysis loop
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
      const img = ctx2d.getImageData(0, 0, FRAME_W, FRAME_H);
      const mirror = liveRef.current.facingMode === "user";
      const det = liveRef.current.detector;
      const next =
        det === "motion"
          ? analyzeMotionFrame(prevFrameRef.current, img.data, FRAME_W, FRAME_H, mirror)
          : analyzeColorTarget(img.data, FRAME_W, FRAME_H, det, mirror);
      if (det === "motion") {
        prevFrameRef.current = new Uint8ClampedArray(img.data);
      }
      applyObservation(next);
    }, 100);
    return () => window.clearInterval(id);
  }, [applyObservation, cameraActive]);

  const dispatchVoice = useCallback((actions: VoiceAction[]) => {
    for (const a of actions) {
      switch (a.type) {
        case "drive":
          cbRef.current.onDrive(a.left, a.right, a.timeoutMs);
          break;
        case "head":
          cbRef.current.onHead(a.angleDeg, a.speed, false);
          break;
        case "synth":
          cbRef.current.onSynth(a.voice, a.presetOrNote, a.durMs);
          break;
        case "hubLed":
          cbRef.current.onSetHubLed(a.r, a.g, a.b);
          break;
        case "setMode":
          cbRef.current.onSetMode(a.modeId);
          break;
        case "playMacro":
          void cbRef.current.onPlayMacro().catch(() => undefined);
          break;
        case "stopMacro":
          void cbRef.current.onStopMacro().catch(() => undefined);
          break;
      }
    }
  }, []);

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
            id: seqRef.current++,
            transcript: trimmed,
            intent: "unrecognized",
            reply: "I didn't recognize that — try 'hello vernie', 'look left', 'dance', or 'stop'.",
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
        dispatchVoice(parsed.actions);
      }
      if (parsed.reply) speak(parsed.reply);

      setFeed((prev) => [
        {
          id: seqRef.current++,
          transcript: trimmed,
          intent: parsed.intent,
          reply:
            parsed.reply ??
            (st.connected ? "Done!" : "Understood (connect or launch Demo to move Vernie)."),
          blocked: parsed.blockedBySafety,
        },
        ...prev.slice(0, 7),
      ]);
    },
    [dispatchVoice, speak]
  );

  const stopListening = useCallback(() => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        // Ignore already stopped
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopCamera();
      stopListening();
    };
  }, [stopCamera, stopListening]);

  const reticleX = Math.round(((obs.centroidX + 1) / 2) * 100);
  const reticleY = Math.round(((1 - obs.centroidY) / 2) * 100);

  return (
    <div className="two-col-grid">
      {/* CAMERA TRACKER ("ROBOT EYES") */}
      <section className="console-panel" aria-label="Camera tracking eyes">
        <div className="panel-head">
          <div>
            <h2>Robot Eyes (Camera)</h2>
            <p className="panel-sub">
              Runs 100% locally in your browser — tracks waves or colored LEGO bricks
            </p>
          </div>
          <span className={`status-tag ${cameraActive ? "is-live" : ""}`}>
            {cameraActive ? "CAMERA LIVE" : "STANDBY"}
          </span>
        </div>

        {cameraError && <div className="notice notice-danger">{cameraError}</div>}

        <div className="viewfinder-box" aria-label="Camera tracking viewport">
          <video ref={videoRef} className="viewfinder-video" muted playsInline />
          {!cameraActive && (
            <div className="viewfinder-standby">
              <IconCamera size={28} />
              <span>Start your webcam or phone camera — or test with simulated targets below</span>
            </div>
          )}
          {obs.detected && (
            <div
              className={`vf-reticle ${obs.waveDetected ? "is-wave" : ""}`}
              style={{ left: `${reticleX}%`, top: `${reticleY}%` }}
              aria-label="Tracked target reticle"
            />
          )}
          <div className="vf-hud-bar mono-num">
            <span>{visionNote}</span>
            <span>
              X:{obs.centroidX.toFixed(2)} · E:{Math.round(obs.energy * 100)}%
            </span>
          </div>
        </div>

        <div className="vf-controls-row">
          {cameraActive ? (
            <button type="button" className="keycap keycap-stop keycap-sm" onClick={stopCamera}>
              Stop Camera
            </button>
          ) : (
            <button
              type="button"
              id="btn-pilot-start-cam"
              className="keycap keycap-green keycap-sm"
              onClick={() => void startCamera()}
            >
              <IconCamera size={14} />
              <span>Start Camera</span>
            </button>
          )}

          <div className="segmented-mini" role="group" aria-label="Camera lens">
            <button
              type="button"
              className={facingMode === "user" ? "is-active" : ""}
              onClick={() => setFacingMode("user")}
            >
              Front
            </button>
            <button
              type="button"
              className={facingMode === "environment" ? "is-active" : ""}
              onClick={() => setFacingMode("environment")}
            >
              Rear
            </button>
          </div>

          <label className="toggle-check">
            <input
              type="checkbox"
              checked={trackingEnabled}
              disabled={!connected || disabled}
              onChange={(e) => setTrackingEnabled(e.target.checked)}
            />
            <span>Send to Robot</span>
          </label>
        </div>

        <div className="field-stack">
          <span className="engraved-label">What to Look For</span>
          <div className="chip-row">
            {DETECTOR_CHIPS.map((d) => (
              <button
                key={d.id}
                type="button"
                className={`chip-btn ${detector === d.id ? "chip-btn-active" : ""}`}
                onClick={() => {
                  prevFrameRef.current = null;
                  setDetector(d.id);
                }}
              >
                <span className="chip-dot" style={{ background: d.dot }} />
                <span>{d.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="field-stack">
          <span className="engraved-label">How Vernie Reacts</span>
          <div className="reaction-grid">
            {REACTION_CARDS.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`reaction-card ${trackMode === r.id ? "is-active" : ""}`}
                onClick={() => setTrackMode(r.id)}
              >
                <strong>{r.title}</strong>
                <span>{r.desc}</span>
              </button>
            ))}
          </div>
          {trackMode === "head-follow" && !headHomed && connected && (
            <span className="helper-warn">
              Tip: Calibrate Head on the Drive tab first so Head Follow can safely move Vernie&apos;s eyes.
            </span>
          )}
        </div>

        <div className="field-stack">
          <span className="engraved-label">Test Without Camera</span>
          <div className="chip-row">
            <button
              type="button"
              className="chip-btn"
              disabled={!connected || disabled}
              onClick={() =>
                applyObservation(
                  { detected: true, centroidX: -0.75, centroidY: 0.1, energy: 0.08, waveDetected: false },
                  true
                )
              }
            >
              <IconTarget size={13} />
              Target Left
            </button>
            <button
              type="button"
              className="chip-btn"
              disabled={!connected || disabled}
              onClick={() =>
                applyObservation(
                  { detected: true, centroidX: 0.75, centroidY: 0.1, energy: 0.08, waveDetected: false },
                  true
                )
              }
            >
              <IconTarget size={13} />
              Target Right
            </button>
            <button
              type="button"
              className="chip-btn chip-btn-amber"
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
        </div>
      </section>

      {/* VOICE COMMANDER ("TALK TO VERNIE") */}
      <section className="console-panel" aria-label="Voice commander">
        <div className="panel-head">
          <div>
            <h2>Talk to Vernie</h2>
            <p className="panel-sub">
              Speak naturally, type a phrase, or tap a quick command
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
            <IconMic size={22} />
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
            placeholder="Try “hello vernie”, “look left”, “dance”, or “stop”…"
            value={commandInput}
            onChange={(e) => setCommandInput(e.target.value)}
          />
          <button type="submit" className="keycap keycap-orange keycap-sm">
            Send
          </button>
        </form>

        <div className="field-stack">
          <span className="engraved-label">Quick Phrases</span>
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
        </div>

        <div className="safety-footnote">
          <IconShield size={14} />
          <span>Voice Safety Lock: saying &ldquo;fire&rdquo; or &ldquo;shoot&rdquo; is always blocked.</span>
        </div>

        <div className="field-stack">
          <span className="engraved-label">Conversation Log</span>
          <ol className="voice-feed" aria-label="Voice command log">
            {feed.length === 0 ? (
              <li className="timeline-empty">
                No commands yet — tap &ldquo;Hello Vernie&rdquo; above to say hi!
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
        </div>
      </section>
    </div>
  );
};
