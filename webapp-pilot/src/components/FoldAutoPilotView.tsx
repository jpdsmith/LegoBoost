// SPDX-License-Identifier: MIT
// Pixel Fold (2023) 90° Folded Tabletop Single-Device Autonomous Explorer Cockpit.
//
// Designed for running 100% locally on a single half-folded Android device (zero Wi-Fi/WebRTC):
//   - TOP HALF (vertical upright visor facing user behind robot):
//       Live rear camera with asymmetric left-offset chassis bumper rails, real horizonYs
//       corridors, floor-sample patch preview, AI boxes, and side-by-side Live 2D Room Map.
//   - HINGE SAFE BAND (horizontal fold crease):
//       Zero buttons on the bend line; live status & hardware indicator bar.
//   - BOTTOM HALF (flat horizontal control deck resting on tank):
//       Giant Start/Stop Explore & Emergency STOP paddles, Mission & Speed controls,
//       1-tap Black-Box Flight Recorder & Problem Tagger ("Clipped Right", "False Wall",
//       "Hit Obstacle", "Stuck/Spin"), 1-tap Android Share (.zip / Contact Sheet PNG / .md),
//       and persistent Pixel Fold Left-Offset & Mount Calibration drawer.

import React, { useState } from "react";
import { TelemetryFlag, TelemetryFrame } from "@core/ble/protocol";
import {
  ExplorerMission,
  PilotAssistMode,
  RoomMapSnapshot,
  RoverDiscoveryItem,
  RoverVisionSnapshot,
} from "../rtc/roverBridge";
import { MountCalibration, PIXEL_FOLD_DEFAULT_CALIBRATION } from "../vision/roverVision";
import {
  FlightRunStats,
  PROBLEM_TAGS,
  ProblemTagKind,
} from "../rover/flightRecorder";
import { FoldHeadingSnapshot } from "../rover/foldHeading";
import { FpvOverlaySvg } from "./FpvOverlaySvg";
import {
  IconCamera,
  IconCompass,
  IconDownload,
  IconFlashlight,
  IconPlay,
  IconRefresh,
  IconStop,
  IconWrench,
} from "./Icons";
import { RoomMapCanvas } from "./RoomMapCanvas";

export interface RearCameraOption {
  deviceId: string;
  label: string;
}

export interface FoldAutoPilotViewProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  bleConnected: boolean;
  bleDisabled: boolean;
  cameraActive: boolean;
  cameraError: string | null;
  wakeLocked: boolean;
  torchSupported: boolean;
  headlightsOn: boolean;
  autoHeadlights: boolean;
  telemetry: TelemetryFrame | null;
  heading: FoldHeadingSnapshot;
  vision: RoverVisionSnapshot | null;
  visionMs: number;
  map: RoomMapSnapshot | null;
  discoveries: RoverDiscoveryItem[];
  assistMode: PilotAssistMode;
  mission: ExplorerMission;
  explorerState: string;
  assistNote: string;
  speedCap: number;
  aiEnabled: boolean;
  aiStatusNote: string | null;
  showCorridors: boolean;
  recoveries: number;
  motorCmd: { left: number; right: number; steer: number };
  calibration: MountCalibration;
  rearCameras: RearCameraOption[];
  runStats: FlightRunStats;
  autoRecord: boolean;
  lastTagFeedback: string | null;
  exportBusy: boolean;
  exportNotice: string | null;
  onStartCamera: (deviceId?: string) => void;
  onStopCamera: () => void;
  onToggleExplore: () => void;
  onEmergencyStop: () => void;
  onMissionChange: (m: ExplorerMission) => void;
  onSpeedCapChange: (cap: number) => void;
  onToggleAi: () => void;
  onToggleCorridors: () => void;
  onToggleHeadlights: () => void;
  onToggleAutoHeadlights: () => void;
  onCalibrationChange: (next: MountCalibration) => void;
  onRelearnFloor: () => void;
  onResetMap: () => void;
  onToggleRecording: () => void;
  onToggleAutoRecord: () => void;
  onMarkProblem: (tag: ProblemTagKind) => void;
  onExportZip: (preferShare: boolean) => void;
  onExportContactSheet: () => void;
  onCopySummary: () => void;
  onClearRun: () => void;
}

const EXPLORER_MISSIONS: Array<{ id: ExplorerMission; label: string }> = [
  { id: "explore-room", label: "Explore Room" },
  { id: "find-person", label: "Find Person" },
  { id: "find-object", label: "Find Objects" },
  { id: "return-home", label: "Return Home" },
];

const FOLD_SPEED_STEPS = [40, 65, 85];

function compassShort(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const norm = ((deg % 360) + 360) % 360;
  return `${Math.round(norm)}° ${dirs[Math.round(norm / 45) % 8]}`;
}

export const FoldAutoPilotView: React.FC<FoldAutoPilotViewProps> = ({
  videoRef,
  bleConnected,
  bleDisabled,
  cameraActive,
  cameraError,
  wakeLocked,
  torchSupported,
  headlightsOn,
  autoHeadlights,
  telemetry,
  heading,
  vision,
  visionMs,
  map,
  discoveries,
  assistMode,
  mission,
  explorerState,
  assistNote,
  speedCap,
  aiEnabled,
  aiStatusNote,
  showCorridors,
  recoveries,
  motorCmd,
  calibration,
  rearCameras,
  runStats,
  autoRecord,
  lastTagFeedback,
  exportBusy,
  exportNotice,
  onStartCamera,
  onStopCamera,
  onToggleExplore,
  onEmergencyStop,
  onMissionChange,
  onSpeedCapChange,
  onToggleAi,
  onToggleCorridors,
  onToggleHeadlights,
  onToggleAutoHeadlights,
  onCalibrationChange,
  onRelearnFloor,
  onResetMap,
  onToggleRecording,
  onToggleAutoRecord,
  onMarkProblem,
  onExportZip,
  onExportContactSheet,
  onCopySummary,
  onClearRun,
}) => {
  const [fullFoldScreen, setFullFoldScreen] = useState(false);
  const [showCalibration, setShowCalibration] = useState(false);
  const [showFloorPatch, setShowFloorPatch] = useState(true);

  const isExploring = assistMode === "explorer";
  const frontDist =
    telemetry && telemetry.distancePct <= 100 ? telemetry.distancePct : null;
  const battV = telemetry ? (telemetry.batteryMv / 1000).toFixed(2) : null;
  const isPickedUp = Boolean(telemetry && (telemetry.flags & TelemetryFlag.PICKED_UP));
  const isSafeMode = Boolean(telemetry && (telemetry.flags & TelemetryFlag.SAFE_MODE));
  const sweptPct = vision?.sweptClear !== undefined ? Math.round(vision.sweptClear * 100) : null;
  const hasRunData = runStats.tickCount > 0 || runStats.eventCount > 0;

  const toggleFullFold = () => {
    setFullFoldScreen((prev) => {
      const next = !prev;
      try {
        if (next && document.documentElement.requestFullscreen && !document.fullscreenElement) {
          void document.documentElement.requestFullscreen().catch(() => undefined);
        } else if (!next && document.fullscreenElement && document.exitFullscreen) {
          void document.exitFullscreen().catch(() => undefined);
        }
      } catch {
        // ignore fullscreen errors on browsers that restrict it
      }
      return next;
    });
  };

  const updateCal = (patch: Partial<MountCalibration>) => {
    onCalibrationChange({ ...calibration, ...patch });
  };

  return (
    <div
      className={`fold-cockpit ${fullFoldScreen ? "is-fullscreen-fold" : ""}`}
      style={{ ["--fold-top-pct" as string]: `${calibration.foldTopPct}%` }}
      aria-label="Pixel Fold 90-degree tabletop autonomous explorer cockpit"
    >
      {/* =========================================================
          TOP HALF: VERTICAL UPRIGHT VISOR (ABOVE 90° HINGE CREASE)
         ========================================================= */}
      <section className="fold-top-visor" aria-label="Upper vertical camera and radar visor">
        <div className="fold-camera-stage">
          <video
            ref={videoRef}
            className={`fold-video ${cameraActive ? "" : "is-hidden"}`}
            muted
            playsInline
            autoPlay
            onLoadedMetadata={(e) => {
              void e.currentTarget.play().catch(() => undefined);
            }}
          />

          {!cameraActive && (
            <div className="fold-camera-standby">
              <IconCamera size={34} />
              <h3>Pixel Fold 90° On-Board Auto-Pilot</h3>
              <p>
                Runs 100% locally on this Pixel Fold (zero Wi-Fi/WebRTC). Rear camera points forward
                with left-offset chassis protection ({calibration.camOffsetCm} cm) and unobstructed
                88007 front sensor fusion.
              </p>
              <button
                type="button"
                id="btn-fold-start-cam"
                className="keycap keycap-green"
                onClick={() => onStartCamera(calibration.cameraDeviceId)}
              >
                <IconCamera size={16} />
                <span>Start On-Board Rear Camera</span>
              </button>
              {cameraError && <p className="fpv-diag-error">{cameraError}</p>}
            </div>
          )}

          {cameraActive && (
            <FpvOverlaySvg
              steer={isExploring ? motorCmd.steer : (vision?.bestSteer ?? 0)}
              frontDistPct={frontDist}
              vision={vision}
              showCorridors={showCorridors}
              calibration={calibration}
              showFloorPatch={showFloorPatch}
            />
          )}

          {/* Top Visor HUD Badges */}
          <div className="fpv-top-hud">
            <div className="fpv-hud-cluster">
              <span
                className={`visor-chip ${
                  isSafeMode
                    ? "visor-chip-red"
                    : isExploring
                      ? explorerState === "UNSTICKING" || explorerState === "AVOIDING"
                        ? "visor-chip-amber"
                        : "visor-chip-green"
                      : "visor-chip-cyan"
                }`}
              >
                {isExploring ? `AUTO · ${explorerState}` : "STANDBY"}
              </span>
              {runStats.recording && (
                <span className="visor-chip visor-chip-red mono-num">
                  ● REC {runStats.durationSec.toFixed(0)}s
                </span>
              )}
              {heading.headingDeg !== null && (
                <span className="visor-chip mono-num">
                  <IconCompass size={11} /> {compassShort(heading.headingDeg)}
                </span>
              )}
              {sweptPct !== null && (
                <span
                  className={`visor-chip mono-num ${
                    sweptPct < 25
                      ? "visor-chip-red"
                      : sweptPct < 50
                        ? "visor-chip-amber"
                        : "visor-chip-green"
                  }`}
                >
                  PATH {sweptPct}%
                </span>
              )}
            </div>

            <div className="fpv-hud-cluster">
              {frontDist !== null && (
                <span
                  className={`visor-chip mono-num ${
                    frontDist <= 22
                      ? "visor-chip-red"
                      : frontDist <= 55
                        ? "visor-chip-amber"
                        : "visor-chip-green"
                  }`}
                >
                  88007 {frontDist}%
                </span>
              )}
              {battV && (
                <span className="visor-chip mono-num">
                  {battV}V
                </span>
              )}
              {cameraActive && (
                <span className="visor-chip mono-num">
                  {visionMs.toFixed(0)}ms
                </span>
              )}
              {isPickedUp && <span className="visor-chip visor-chip-red">PICKED UP</span>}
              {headlightsOn && <span className="visor-chip visor-chip-amber">TORCH</span>}
            </div>
          </div>

          {lastTagFeedback && (
            <div className="fold-tag-toast" role="status">
              {lastTagFeedback}
            </div>
          )}
        </div>

        {/* Right Side of Upper Visor: Compact Live 2D Room Map + Live Vector Readout */}
        <div className="fold-visor-side">
          <RoomMapCanvas
            map={map}
            discoveries={discoveries}
            recoveries={recoveries}
            onResetMap={onResetMap}
          />
          <div className="fold-mini-telemetry mono-num">
            <span>
              <strong>L/R</strong> {motorCmd.left}/{motorCmd.right}
            </span>
            <span>
              <strong>FLOW</strong> {(vision?.flowForward ?? 0).toFixed(2)}
            </span>
            <span>
              <strong>OFF</strong> {calibration.camOffsetCm >= 0 ? "+" : ""}
              {calibration.camOffsetCm.toFixed(1)}cm
            </span>
            <span>
              <strong>GYRO</strong> {heading.source === "gyro-gravity" ? "3D" : heading.source === "orient-matrix" ? "MAT" : "OFF"}
            </span>
          </div>
        </div>
      </section>

      {/* =========================================================
          HINGE SAFE ZONE (90° PIXEL FOLD CREASE — ZERO BUTTONS!)
         ========================================================= */}
      <div className="fold-hinge-bar" aria-live="polite">
        <div className="fold-hinge-indicators">
          <span className={`fold-dot ${bleConnected ? "is-on" : ""}`}>
            BLE {bleConnected ? "OK" : "OFF"}
          </span>
          <span className={`fold-dot ${cameraActive ? "is-on" : ""}`}>
            CAM {cameraActive ? "LIVE" : "OFF"}
          </span>
          {wakeLocked && <span className="fold-dot is-on">AWAKE</span>}
        </div>
        <span className="fold-hinge-note">
          {aiStatusNote ?? assistNote}
        </span>
      </div>

      {/* =========================================================
          BOTTOM HALF: FLAT HORIZONTAL TOUCH DECK (RESTING ON TANK)
         ========================================================= */}
      <section className="fold-bottom-deck" aria-label="Lower flat touch control and flight recorder deck">
        {/* Row 1: Primary Big Thumb Paddles */}
        <div className="fold-primary-paddles">
          <button
            type="button"
            id="btn-fold-toggle-explore"
            className={`keycap fold-paddle-main ${isExploring ? "keycap-orange" : "keycap-green"}`}
            disabled={!bleConnected || bleDisabled}
            onClick={onToggleExplore}
          >
            {isExploring ? <IconStop size={16} /> : <IconPlay size={16} />}
            <span>
              {!bleConnected
                ? "Connect Robot (Top Bar)"
                : isExploring
                  ? "Pause Auto Explore"
                  : "Start Auto Explore"}
            </span>
          </button>

          <button
            type="button"
            id="btn-fold-estop"
            className="keycap keycap-stop fold-paddle-stop"
            onClick={onEmergencyStop}
          >
            <IconStop size={16} />
            <span>STOP</span>
          </button>

          {cameraActive ? (
            <button
              type="button"
              className="keycap keycap-subtle keycap-sm"
              onClick={onStopCamera}
            >
              Stop Cam
            </button>
          ) : (
            <button
              type="button"
              className="keycap keycap-subtle keycap-sm"
              onClick={() => onStartCamera(calibration.cameraDeviceId)}
            >
              <IconCamera size={14} />
              <span>Start Cam</span>
            </button>
          )}

          <button
            type="button"
            id="btn-fold-fullscreen"
            className={`keycap keycap-sm ${fullFoldScreen ? "keycap-orange" : "keycap-subtle"}`}
            onClick={toggleFullFold}
          >
            {fullFoldScreen ? "Exit 90° Split" : "90° Full Fold"}
          </button>
        </div>

        {/* Row 2: Mission, Speed Cap, AI, Lights & Mount Calibration Toggle */}
        <div className="fold-control-strip">
          <div className="segmented-mini" role="group" aria-label="Fold explorer mission">
            {EXPLORER_MISSIONS.map((m) => (
              <button
                key={m.id}
                type="button"
                id={`fold-mission-${m.id}`}
                className={mission === m.id ? "is-active" : ""}
                onClick={() => onMissionChange(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="fold-chip-cluster">
            <div className="segmented-mini" role="group" aria-label="Fold speed limit">
              {FOLD_SPEED_STEPS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={speedCap === s ? "is-active" : ""}
                  onClick={() => onSpeedCapChange(s)}
                >
                  {s}%
                </button>
              ))}
            </div>

            <button
              type="button"
              className={`chip-btn ${aiEnabled ? "chip-btn-active" : ""}`}
              onClick={onToggleAi}
            >
              AI Objects
            </button>
            <button
              type="button"
              className={`chip-btn ${autoHeadlights ? "chip-btn-active" : ""}`}
              onClick={onToggleAutoHeadlights}
              title="Automatically turn on Pixel Fold rear LED in dark hallways or under furniture"
            >
              Auto Torch
            </button>
            <button
              type="button"
              className={`chip-btn ${headlightsOn ? "chip-btn-active" : ""}`}
              disabled={!cameraActive}
              onClick={onToggleHeadlights}
              title={torchSupported ? "Toggle Pixel Fold rear flashlight" : "Flashlight availability depends on lens"}
            >
              <IconFlashlight size={13} />
              <span>{headlightsOn ? "On" : "Torch"}</span>
            </button>
            <button
              type="button"
              className={`chip-btn ${showCorridors ? "chip-btn-active" : ""}`}
              onClick={onToggleCorridors}
            >
              Corridors
            </button>
            <button
              type="button"
              id="btn-fold-calibration-toggle"
              className={`chip-btn ${showCalibration ? "chip-btn-active" : ""}`}
              onClick={() => setShowCalibration((v) => !v)}
            >
              <IconWrench size={13} />
              <span>Mount ({calibration.camOffsetCm}cm)</span>
            </button>
          </div>
        </div>

        {/* Row 3: Black-Box Flight Recorder + 1-Tap Real-Life Problem Tagger */}
        <div className="fold-recorder-card" aria-label="Black-box flight recorder and problem tagger">
          <div className="fold-recorder-head">
            <div className="fold-recorder-title">
              <button
                type="button"
                id="btn-fold-record"
                className={`keycap keycap-sm ${runStats.recording ? "keycap-stop" : "keycap-subtle"}`}
                onClick={onToggleRecording}
              >
                <span>{runStats.recording ? "● Stop Rec" : "● Record Run"}</span>
              </button>
              <label className="fold-inline-check">
                <input
                  type="checkbox"
                  checked={autoRecord}
                  onChange={onToggleAutoRecord}
                />
                <span>Auto-Rec</span>
              </label>
              <span className="mono-readout-muted">
                {runStats.durationSec.toFixed(0)}s · {runStats.tickCount} ticks · {runStats.eventCount} events ({runStats.keyframeCount} frames)
              </span>
            </div>

            <div className="fold-export-actions">
              <button
                type="button"
                id="btn-fold-share-zip"
                className="keycap keycap-green keycap-sm"
                disabled={!hasRunData || exportBusy}
                onClick={() => onExportZip(true)}
                title="Share or download complete .zip run bundle (telemetry.jsonl + raw & annotated frames + contact-sheet.png + summary.md)"
              >
                <IconDownload size={13} />
                <span>{exportBusy ? "Packing…" : "Share Run (.zip)"}</span>
              </button>
              <button
                type="button"
                id="btn-fold-save-sheet"
                className="chip-btn"
                disabled={!hasRunData || exportBusy}
                onClick={onExportContactSheet}
                title="Download single visual diagnostic storyboard PNG"
              >
                Contact Sheet (.png)
              </button>
              <button
                type="button"
                id="btn-fold-copy-report"
                className="chip-btn"
                disabled={!hasRunData}
                onClick={onCopySummary}
              >
                Copy Report (.md)
              </button>
              {hasRunData && (
                <button
                  type="button"
                  className="chip-btn"
                  onClick={onClearRun}
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Instant 1-Tap Problem Tags while testing on your living-room floor */}
          <div className="fold-problem-tags" role="group" aria-label="Mark test run event">
            <span className="engraved-label">1-Tap Mark:</span>
            {PROBLEM_TAGS.map((tag) => (
              <button
                key={tag.id}
                type="button"
                id={`btn-tag-${tag.id}`}
                className={`fold-tag-btn tone-${tag.tone}`}
                onClick={() => onMarkProblem(tag.id)}
              >
                {tag.label}
              </button>
            ))}
          </div>

          {exportNotice && <div className="fold-export-notice">{exportNotice}</div>}
        </div>

        {/* Collapsible Mount, Left-Camera Offset & Fold Crease Calibration Drawer */}
        {showCalibration && (
          <div className="fold-calibration-drawer" aria-label="Pixel Fold mount and left-offset calibration">
            <div className="fold-cal-grid">
              <label className="fold-slider-field">
                <span>
                  Camera Left/Right Offset:{" "}
                  <strong className="mono-num">
                    {calibration.camOffsetCm > 0 ? `+${calibration.camOffsetCm.toFixed(1)}` : calibration.camOffsetCm.toFixed(1)} cm{" "}
                    ({calibration.camOffsetCm < 0 ? "Left" : calibration.camOffsetCm > 0 ? "Right" : "Center"})
                  </strong>
                </span>
                <input
                  id="slider-cam-offset"
                  type="range"
                  min={-10}
                  max={10}
                  step={0.5}
                  value={calibration.camOffsetCm}
                  onChange={(e) => updateCal({ camOffsetCm: Number(e.target.value) })}
                />
              </label>

              <label className="fold-slider-field">
                <span>
                  Robot Tread Width: <strong className="mono-num">{calibration.robotWidthCm.toFixed(1)} cm</strong>
                </span>
                <input
                  type="range"
                  min={12}
                  max={24}
                  step={0.5}
                  value={calibration.robotWidthCm}
                  onChange={(e) => updateCal({ robotWidthCm: Number(e.target.value) })}
                />
              </label>

              <label className="fold-slider-field">
                <span>
                  Horizon Cutoff Y: <strong className="mono-num">{Math.round(calibration.horizonY * 100)}%</strong>
                </span>
                <input
                  type="range"
                  min={22}
                  max={60}
                  step={1}
                  value={Math.round(calibration.horizonY * 100)}
                  onChange={(e) => updateCal({ horizonY: Number(e.target.value) / 100 })}
                />
              </label>

              <label className="fold-slider-field">
                <span>
                  Bumper Mask Y: <strong className="mono-num">{Math.round(calibration.bumperMaskY * 100)}%</strong>
                </span>
                <input
                  type="range"
                  min={72}
                  max={96}
                  step={1}
                  value={Math.round(calibration.bumperMaskY * 100)}
                  onChange={(e) => updateCal({ bumperMaskY: Number(e.target.value) / 100 })}
                />
              </label>

              <label className="fold-slider-field">
                <span>
                  Camera FOV: <strong className="mono-num">{Math.round(calibration.fovDeg)}°</strong>
                </span>
                <input
                  type="range"
                  min={55}
                  max={125}
                  step={2}
                  value={Math.round(calibration.fovDeg)}
                  onChange={(e) => updateCal({ fovDeg: Number(e.target.value) })}
                />
              </label>

              <label className="fold-slider-field">
                <span>
                  90° Fold Crease Split: <strong className="mono-num">{calibration.foldTopPct}%</strong>
                </span>
                <input
                  type="range"
                  min={40}
                  max={56}
                  step={1}
                  value={calibration.foldTopPct}
                  onChange={(e) => updateCal({ foldTopPct: Number(e.target.value) })}
                />
              </label>
            </div>

            <div className="fold-cal-actions">
              {rearCameras.length > 1 && (
                <label className="fold-lens-picker">
                  <span className="engraved-label">Rear Lens</span>
                  <select
                    className="tactile-select"
                    value={calibration.cameraDeviceId ?? ""}
                    onChange={(e) => {
                      const deviceId = e.target.value || undefined;
                      updateCal({ cameraDeviceId: deviceId });
                      if (cameraActive) {
                        onStartCamera(deviceId);
                      }
                    }}
                  >
                    <option value="">Auto Rear Camera</option>
                    {rearCameras.map((cam, idx) => (
                      <option key={cam.deviceId} value={cam.deviceId}>
                        {cam.label || `Rear Camera ${idx + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <button
                type="button"
                className={`chip-btn ${showFloorPatch ? "chip-btn-active" : ""}`}
                onClick={() => setShowFloorPatch((v) => !v)}
              >
                Floor Sample Box
              </button>
              <button
                type="button"
                className="chip-btn"
                onClick={onRelearnFloor}
              >
                <IconRefresh size={13} />
                <span>Re-learn Floor</span>
              </button>
              <button
                type="button"
                className="chip-btn"
                onClick={() => onCalibrationChange({ ...PIXEL_FOLD_DEFAULT_CALIBRATION })}
              >
                Reset Pixel Fold Defaults
              </button>
            </div>
          </div>
        )}

        {/* Compact Discovery Photo Strip */}
        {discoveries.length > 0 && (
          <div className="fold-discovery-strip" aria-label="On-the-fly explorer discoveries">
            {discoveries.slice(0, 6).map((item) => (
              <div key={item.id} className="fold-disc-pill">
                {item.thumbnailUrl && (
                  <img src={item.thumbnailUrl} alt={item.label} className="fold-disc-thumb" />
                )}
                <span>
                  <strong>{item.label}</strong> {Math.round(item.confidence * 100)}%
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
