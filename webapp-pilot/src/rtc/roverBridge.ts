// SPDX-License-Identifier: MIT
// Two-Device Peer-to-Peer WebRTC Rover Bridge:
//   - Android Phone ("Rover Host"): streams rear camera video + telemetry/vision/map snapshots,
//     receives low-latency drive/assist/explorer commands, enforces 400ms Wi-Fi link-drop failsafe.
//   - Chromebook ("Driver Client"): displays full-screen FPV video + HUD and streams Xbox/touch commands.
// Supports both 4-character Room Code signaling (over WSS MQTT) AND 100% offline manual Offer/Answer copy-paste!

import { TelemetryFrame } from "@core/ble/protocol";
import { MultiSignalingChannel, normalizeRoomCode } from "./mqttSignaling";

export type BridgeRole = "idle" | "rover-host" | "driver-client";
export type BridgeLinkState = "idle" | "signaling" | "waiting-peer" | "connecting" | "connected" | "error";
export type BridgeTransportMode = "none" | "webrtc" | "relay";

export interface IceCandidateCounts {
  hostIpv4: number;
  mdns: number;
  srflx: number;
  relay: number;
}

export interface BridgeDiagnostics {
  relay: string;
  transport: BridgeTransportMode;
  signalingState: string;
  iceConnectionState: string;
  connectionState: string;
  localCandidates: IceCandidateCounts;
  remoteCandidates: IceCandidateCounts;
  offerReady: boolean;
  answerReady: boolean;
  note: string;
}

export type PilotAssistMode = "manual" | "copilot" | "explorer";
export type CollisionGuardLevel = "off" | "brake" | "dodge";
export type ExplorerMission = "explore-room" | "find-person" | "find-object" | "return-home";

export interface DetectedObjectBox {
  id: string;
  label: string;
  score: number;
  /** Normalized [0..1] top-left x, y, width, height in video frame */
  x: number;
  y: number;
  w: number;
  h: number;
  source: "ai" | "hsv" | "sim";
}

export interface RoverVisionSnapshot {
  /** 5-sector free-floor clearance [farLeft, midLeft, center, midRight, farRight] in [0..1] */
  corridors: [number, number, number, number, number];
  /** Recommended open-space steering [-1..+1] */
  bestSteer: number;
  /** Optical flow forward motion estimate & stuck detection */
  flowForward: number;
  stuck: boolean;
  /** Lane / floor tape center offset [-1..+1] or null */
  laneOffset: number | null;
  /** Active locked target (tap-to-follow or AI) */
  lockedTarget: DetectedObjectBox | null;
  /** All currently detected objects */
  objects: DetectedObjectBox[];
  /** Active AI model readiness */
  aiReady: boolean;
}

export interface RoverDiscoveryItem {
  id: string;
  timestamp: number;
  label: string;
  confidence: number;
  /** Compact JPEG data URL (~4-8 KB) */
  thumbnailUrl?: string;
  mapX: number;
  mapY: number;
}

export interface RoomMapSnapshot {
  gridSize: number;
  cellCm: number;
  /** Robot pose in grid cell coordinates (center = gridSize/2) */
  robotX: number;
  robotY: number;
  headingDeg: number;
  /** Compact list of visited [x, y] cells */
  visited: Array<[number, number]>;
  /** Compact list of obstacle [x, y] cells */
  obstacles: Array<[number, number]>;
  coveragePct: number;
  distanceMeters: number;
}

export interface PilotConfigPayload {
  assistMode: PilotAssistMode;
  collisionGuard: CollisionGuardLevel;
  headingHold: boolean;
  laneAssist: boolean;
  aiEnabled: boolean;
  mission: ExplorerMission;
  speedCap: number;
}

export type DriverToRoverMessage =
  | { type: "drive"; left: number; right: number; steer?: number; throttle?: number; timeoutMs: number; seq: number; sentAt: number }
  | { type: "stop" }
  | { type: "turret"; angleDeg: number }
  | { type: "headlights"; on: boolean }
  | { type: "synth"; voice: number; presetOrNote: number; durMs: number }
  | { type: "hubLed"; r: number; g: number; b: number }
  | { type: "setMode"; modeId: number }
  | { type: "pilotConfig"; config: PilotConfigPayload }
  | { type: "tapTrack"; normX: number; normY: number }
  | { type: "lockObject"; label: string | null }
  | { type: "clearMap" }
  | { type: "videoFallback"; enabled: boolean; fps?: number; maxWidth?: number }
  | { type: "ping"; sentAt: number };

export type RoverToDriverMessage =
  | {
      type: "state";
      telemetry: TelemetryFrame | null;
      bleConnected: boolean;
      headlightsOn: boolean;
      torchSupported: boolean;
      phoneHeadingDeg: number | null;
      assistNote: string;
      assistIntervening?: string;
      explorerState: string;
      recoveries?: number;
      vision: RoverVisionSnapshot | null;
      sentAt: number;
    }
  | { type: "map"; snapshot: RoomMapSnapshot }
  | { type: "discovery"; item: RoverDiscoveryItem }
  | { type: "jpegFrame"; dataUrl: string; width: number; height: number; ts: number }
  | { type: "pong"; sentAt: number };

interface SignalEnvelope {
  from: string;
  sid?: string;
  kind: "hello" | "offer" | "answer" | "ice" | "relay-open" | "relay-msg" | "relay-close";
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  msg?: string;
}

interface QueuedCandidate {
  from: string;
  sid?: string;
  candidate: RTCIceCandidateInit;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ],
};

function emptyCounts(): IceCandidateCounts {
  return { hostIpv4: 0, mdns: 0, srflx: 0, relay: 0 };
}

export function classifyIceCandidate(candidateLine: string): keyof IceCandidateCounts | null {
  if (!candidateLine) return null;
  const typMatch = /\btyp\s+(host|srflx|prflx|relay)\b/i.exec(candidateLine);
  if (!typMatch) return null;
  const typ = typMatch[1].toLowerCase();
  if (typ === "relay") return "relay";
  if (typ === "srflx" || typ === "prflx") return "srflx";
  if (typ === "host") {
    if (candidateLine.includes(".local")) return "mdns";
    return "hostIpv4";
  }
  return null;
}

export function countCandidatesInSdp(sdp: string | undefined): IceCandidateCounts {
  const counts = emptyCounts();
  if (!sdp) return counts;
  const lines = sdp.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("a=candidate:")) continue;
    const kind = classifyIceCandidate(line);
    if (kind) counts[kind] += 1;
  }
  return counts;
}

export function parseBridgeMessage<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class RoverWebRtcBridge {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private sig: MultiSignalingChannel | null = null;
  private readonly peerId = `p_${Math.random().toString(36).slice(2, 9)}`;
  private remotePeerId: string | null = null;
  private activeSid: string | null = null;
  private sdpPublished = false;
  private lastOfferAt = 0;
  private lastAnswerPayload: SignalEnvelope | null = null;
  private lastPeerActivityAt = 0;
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private linkWatchdog: ReturnType<typeof setInterval> | null = null;
  private answerRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private iceFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDriverDriveAt = 0;
  private role: BridgeRole = "idle";
  private transportMode: BridgeTransportMode = "none";
  private pendingCandidates: QueuedCandidate[] = [];
  private localStream: MediaStream | null = null;
  private signalQueue: Promise<void> = Promise.resolve();
  private diagnostics: BridgeDiagnostics = {
    relay: "",
    transport: "none",
    signalingState: "closed",
    iceConnectionState: "new",
    connectionState: "new",
    localCandidates: emptyCounts(),
    remoteCandidates: emptyCounts(),
    offerReady: false,
    answerReady: false,
    note: "",
  };

  constructor(
    private readonly callbacks: {
      onStateChange: (state: BridgeLinkState, detail?: string) => void;
      onDiagnostics?: (diag: BridgeDiagnostics) => void;
      onRemoteStream?: (stream: MediaStream) => void;
      onDriverMessage?: (msg: DriverToRoverMessage) => void;
      onRoverMessage?: (msg: RoverToDriverMessage) => void;
      onFailsafeStop?: () => void;
    }
  ) {}

  getRole(): BridgeRole {
    return this.role;
  }

  getTransportMode(): BridgeTransportMode {
    return this.transportMode;
  }

  getDiagnostics(): BridgeDiagnostics {
    return {
      ...this.diagnostics,
      localCandidates: { ...this.diagnostics.localCandidates },
      remoteCandidates: { ...this.diagnostics.remoteCandidates },
    };
  }

  isDataChannelOpen(): boolean {
    if (this.transportMode === "relay") {
      return Boolean(this.sig && this.sig.supportsHighRateRelay());
    }
    return Boolean(this.dc && this.dc.readyState === "open");
  }

  isSendBackpressured(): boolean {
    if (this.transportMode === "relay") {
      return Boolean(this.sig && this.sig.getBufferedAmount() > 48000);
    }
    return Boolean(this.dc && this.dc.bufferedAmount > 48000);
  }

  private emitDiagnostics(note?: string): void {
    this.diagnostics = {
      ...this.diagnostics,
      relay: this.sig?.getActiveRelays().join(" + ") || this.diagnostics.relay,
      transport: this.transportMode,
      signalingState: this.pc?.signalingState ?? (this.transportMode === "relay" ? "relay" : "closed"),
      iceConnectionState:
        this.pc?.iceConnectionState ?? (this.transportMode === "relay" ? "relay" : "new"),
      connectionState:
        this.pc?.connectionState ?? (this.transportMode === "relay" ? "connected" : "new"),
      note: note ?? this.diagnostics.note,
    };
    this.callbacks.onDiagnostics?.(this.getDiagnostics());
  }

  private clearHandshakeTimers(): void {
    if (this.answerRetryTimer) {
      clearTimeout(this.answerRetryTimer);
      this.answerRetryTimer = null;
    }
    if (this.iceFallbackTimer) {
      clearTimeout(this.iceFallbackTimer);
      this.iceFallbackTimer = null;
    }
  }

  private closePeerOnly(): void {
    if (this.dc) {
      this.dc.onopen = null;
      this.dc.onclose = null;
      this.dc.onmessage = null;
      try {
        this.dc.close();
      } catch {
        // ignore
      }
      this.dc = null;
    }
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.ondatachannel = null;
      try {
        this.pc.close();
      } catch {
        // ignore
      }
      this.pc = null;
    }
  }

  /**
   * Start as the Android phone mounted on the Tank/Car.
   * Streams the given camera MediaStream and waits for the Driver on roomCode.
   */
  async startHost(roomCode: string, cameraStream: MediaStream | null): Promise<void> {
    this.stop();
    const code = normalizeRoomCode(roomCode);
    if (!code) throw new Error("Enter a valid Room Code");
    this.role = "rover-host";
    this.localStream = cameraStream;
    this.callbacks.onStateChange("signaling", `Opening Wi-Fi room ${code}…`);

    const topic = `room-${code}`;
    this.sig = new MultiSignalingChannel(
      topic,
      (payload) => this.enqueueSignal(payload),
      { allowNtfyFallback: true }
    );

    try {
      await this.sig.connect();
      const relays = this.sig.getActiveRelays().join(" + ") || "Relay";
      this.diagnostics.relay = relays;
      this.emitDiagnostics(`Waiting for Driver on code ${code} via ${relays}`);
      this.callbacks.onStateChange("waiting-peer", `Ready on code ${code} (${relays})`);
      this.publishSignal({ from: this.peerId, kind: "hello" });

      this.helloTimer = setInterval(() => {
        const negotiating =
          this.pc !== null &&
          (this.pc.signalingState === "have-local-offer" ||
            this.pc.iceConnectionState === "checking" ||
            this.pc.connectionState === "connecting") &&
          Date.now() - this.lastOfferAt < 13000;
        const busy = this.isDataChannelOpen() || negotiating;
        if (!busy) {
          this.publishSignal({ from: this.peerId, kind: "hello" });
        }
      }, 3000);

      // Dead-man failsafe (500 ms) + Relay peer-drop timeout (6.5 s without ping/drive)
      this.linkWatchdog = setInterval(() => {
        const now = Date.now();
        if (this.lastDriverDriveAt > 0 && now - this.lastDriverDriveAt > 500) {
          this.lastDriverDriveAt = 0;
          this.callbacks.onFailsafeStop?.();
        }
        if (
          this.transportMode === "relay" &&
          this.lastPeerActivityAt > 0 &&
          now - this.lastPeerActivityAt > 6500
        ) {
          this.transportMode = "none";
          this.remotePeerId = null;
          this.lastDriverDriveAt = 0;
          this.callbacks.onFailsafeStop?.();
          this.callbacks.onDriverMessage?.({ type: "videoFallback", enabled: false });
          this.emitDiagnostics("Driver timed out — waiting for reconnect");
          this.callbacks.onStateChange("waiting-peer", "Driver disconnected — waiting to reconnect");
        }
      }, 150);
    } catch (err) {
      this.callbacks.onStateChange(
        "error",
        err instanceof Error ? err.message : "Wi-Fi pairing relay unavailable"
      );
      throw err;
    }
  }

  /**
   * Start as the Chromebook / MacBook / Meta Quest driver joining the Android phone's roomCode.
   */
  async startDriver(roomCode: string): Promise<void> {
    this.stop();
    const code = normalizeRoomCode(roomCode);
    if (!code) throw new Error("Enter the 4-character Room Code shown on the Android phone");
    this.role = "driver-client";
    this.callbacks.onStateChange("signaling", `Connecting to room ${code}…`);

    const topic = `room-${code}`;
    this.sig = new MultiSignalingChannel(
      topic,
      (payload) => this.enqueueSignal(payload),
      { allowNtfyFallback: true }
    );

    try {
      await this.sig.connect();
      const relays = this.sig.getActiveRelays().join(" + ") || "Relay";
      this.diagnostics.relay = relays;
      this.emitDiagnostics(`Calling Tank ${code} via ${relays}…`);
      this.callbacks.onStateChange("waiting-peer", `Calling Tank ${code} (${relays})…`);
      this.publishSignal({ from: this.peerId, kind: "hello" });

      this.helloTimer = setInterval(() => {
        const busy =
          this.isDataChannelOpen() ||
          (this.pc !== null &&
            (this.pc.connectionState === "connecting" ||
              this.pc.connectionState === "connected" ||
              this.pc.iceConnectionState === "checking"));
        if (!busy) {
          this.publishSignal({ from: this.peerId, kind: "hello" });
        }
      }, 2800);
    } catch (err) {
      this.callbacks.onStateChange(
        "error",
        err instanceof Error ? err.message : "Wi-Fi pairing relay unavailable"
      );
      throw err;
    }
  }

  /**
   * Manually switch a waiting/connecting Driver into Compatible Relay Video mode immediately.
   */
  activateRelayFallbackNow(): boolean {
    if (this.role !== "driver-client" || !this.sig || !this.sig.supportsHighRateRelay()) {
      return false;
    }
    this.clearHandshakeTimers();
    this.closePeerOnly();
    this.transportMode = "relay";
    this.lastPeerActivityAt = Date.now();
    this.publishSignal({
      from: this.peerId,
      sid: this.activeSid ?? undefined,
      kind: "relay-open",
    });
    this.emitDiagnostics(
      "Connected via Compatible Wi-Fi Relay (direct P2P UDP was unavailable on this network)"
    );
    this.callbacks.onStateChange("connected", "Wi-Fi Relay Live");
    // Ask host to start compatible JPEG stream over relay
    this.sendToRover({ type: "videoFallback", enabled: true, fps: 7, maxWidth: 288 });
    return true;
  }

  /**
   * Re-attempt direct peer-to-peer WebRTC negotiation cleanly (e.g. after switching out of Relay mode).
   */
  retryDirectP2P(): void {
    if (this.role !== "driver-client" || !this.sig) return;
    if (this.transportMode === "relay") {
      this.publishSignal({ from: this.peerId, kind: "relay-close" });
    }
    this.clearHandshakeTimers();
    this.closePeerOnly();
    this.transportMode = "none";
    this.activeSid = null;
    this.lastAnswerPayload = null;
    this.diagnostics.localCandidates = emptyCounts();
    this.diagnostics.remoteCandidates = emptyCounts();
    this.diagnostics.offerReady = false;
    this.diagnostics.answerReady = false;
    this.emitDiagnostics("Retrying direct P2P WebRTC video…");
    this.callbacks.onStateChange("connecting", "Retrying direct P2P video…");
    this.publishSignal({ from: this.peerId, kind: "hello" });
  }

  /**
   * 100% offline serverless fallback: Host generates a complete gathered SDP offer string.
   */
  async createOfflineOffer(cameraStream: MediaStream | null): Promise<string> {
    this.stop();
    this.role = "rover-host";
    this.localStream = cameraStream;
    const pc = this.createPeerConnection(true);
    this.setupHostTracksAndChannel(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitForIceComplete(pc, 2500);
    this.callbacks.onStateChange("waiting-peer", "Copy offer code to Driver, then paste Answer");
    return JSON.stringify(pc.localDescription);
  }

  /**
   * Offline fallback: Driver accepts Host offer string and returns an Answer string.
   */
  async acceptOfflineOffer(offerJson: string): Promise<string> {
    this.stop();
    this.role = "driver-client";
    const desc = JSON.parse(offerJson) as RTCSessionDescriptionInit;
    const pc = this.createPeerConnection(true);
    this.setupDriverChannelReceiver(pc);
    await pc.setRemoteDescription(desc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.waitForIceComplete(pc, 2500);
    this.callbacks.onStateChange("connecting", "Copy answer back to Rover phone");
    return JSON.stringify(pc.localDescription);
  }

  /**
   * Offline fallback: Host completes connection with Driver's Answer string.
   */
  async acceptOfflineAnswer(answerJson: string): Promise<void> {
    if (!this.pc) throw new Error("Create an offline offer first");
    const desc = JSON.parse(answerJson) as RTCSessionDescriptionInit;
    await this.pc.setRemoteDescription(desc);
    this.callbacks.onStateChange("connecting", "Connecting directly over Wi-Fi…");
  }

  private waitForIceComplete(pc: RTCPeerConnection, maxWaitMs = 1500): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onState);
        resolve();
      };
      const onState = () => {
        if (pc.iceGatheringState === "complete") {
          finish();
        }
      };
      pc.addEventListener("icegatheringstatechange", onState);
      const timer = setTimeout(finish, maxWaitMs);
    });
  }

  private createPeerConnection(clearPending: boolean): RTCPeerConnection {
    this.closePeerOnly();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;
    this.sdpPublished = false;
    this.diagnostics.localCandidates = emptyCounts();
    if (clearPending) {
      this.pendingCandidates = [];
    }

    pc.onicecandidate = (ev) => {
      if (this.pc !== pc) return;
      if (ev.candidate) {
        const cls = classifyIceCandidate(ev.candidate.candidate);
        if (cls) this.diagnostics.localCandidates[cls] += 1;
        // Candidates gathered BEFORE sdpPublished are bundled atomically inside the SDP offer/answer!
        // Trickle only late candidates discovered after SDP publish.
        if (this.sdpPublished && this.sig) {
          this.publishSignal({
            from: this.peerId,
            sid: this.activeSid ?? undefined,
            kind: "ice",
            candidate: ev.candidate.toJSON(),
          });
        }
      }
    };

    pc.ontrack = (ev) => {
      if (this.pc !== pc) return;
      if (ev.streams && ev.streams[0]) {
        this.callbacks.onRemoteStream?.(ev.streams[0]);
      } else {
        const ms = new MediaStream([ev.track]);
        this.callbacks.onRemoteStream?.(ms);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const ice = pc.iceConnectionState;
      this.emitDiagnostics();
      if (ice === "connected" || ice === "completed") {
        this.clearHandshakeTimers();
        this.transportMode = "webrtc";
        this.emitDiagnostics("Direct peer-to-peer WebRTC link active");
        this.callbacks.onStateChange("connected", "Live Wi-Fi FPV Link");
      } else if (ice === "failed") {
        if (this.role === "driver-client" && this.sig?.supportsHighRateRelay()) {
          // Direct P2P UDP failed (e.g. macOS Local Network block / no router hairpinning)
          // Automatically fall back to Compatible Wi-Fi Relay instead of hanging on black video!
          this.activateRelayFallbackNow();
        } else if (this.role !== "idle") {
          this.emitDiagnostics(
            "Direct Wi-Fi P2P ICE failed — check that both devices allow local network traffic"
          );
          this.callbacks.onStateChange("connecting", "Direct P2P ICE failed — retrying…");
        }
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const st = pc.connectionState;
      this.emitDiagnostics();
      if (st === "connected") {
        this.clearHandshakeTimers();
        this.transportMode = "webrtc";
        this.emitDiagnostics("Direct peer-to-peer WebRTC link active");
        this.callbacks.onStateChange("connected", "Live Wi-Fi FPV Link");
      } else if (st === "disconnected" || st === "failed" || st === "closed") {
        if (this.transportMode === "relay") return;
        if (this.role === "rover-host") {
          this.lastDriverDriveAt = 0;
          this.callbacks.onFailsafeStop?.();
        }
        if (st === "failed" && this.role === "driver-client" && this.sig?.supportsHighRateRelay()) {
          this.activateRelayFallbackNow();
          return;
        }
        if (this.role !== "idle" && this.transportMode === "webrtc") {
          this.transportMode = "none";
          this.callbacks.onStateChange("waiting-peer", "Peer disconnected — waiting to reconnect");
        }
      }
    };

    return pc;
  }

  private setupHostTracksAndChannel(pc: RTCPeerConnection): void {
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        const sender = pc.addTrack(track, this.localStream);
        if (track.kind === "video" && typeof sender.getParameters === "function") {
          try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = 950_000;
            void sender.setParameters(params).catch(() => undefined);
          } catch {
            // ignore unsupported setParameters
          }
        }
      }
    }
    const dc = pc.createDataChannel("vernie-rover", { ordered: true });
    this.attachDataChannel(dc);
  }

  private setupDriverChannelReceiver(pc: RTCPeerConnection): void {
    pc.ondatachannel = (ev) => {
      if (this.pc !== pc) return;
      this.attachDataChannel(ev.channel);
    };
  }

  private attachDataChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.onopen = () => {
      if (this.dc !== dc) return;
      this.clearHandshakeTimers();
      this.transportMode = "webrtc";
      this.lastPeerActivityAt = Date.now();
      this.emitDiagnostics("Direct peer-to-peer WebRTC link active");
      this.callbacks.onStateChange("connected", "Live Wi-Fi FPV Link");
    };
    dc.onclose = () => {
      if (this.dc !== dc || this.transportMode === "relay") return;
      this.transportMode = "none";
      if (this.role === "rover-host") {
        this.lastDriverDriveAt = 0;
        this.callbacks.onFailsafeStop?.();
      }
      if (this.role !== "idle") {
        this.callbacks.onStateChange("waiting-peer", "Link closed — waiting for peer");
      }
    };
    dc.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      this.dispatchAppPayload(ev.data);
    };
  }

  private dispatchAppPayload(raw: string): void {
    this.lastPeerActivityAt = Date.now();
    if (this.role === "rover-host") {
      const msg = parseBridgeMessage<DriverToRoverMessage>(raw);
      if (!msg) return;
      if (msg.type === "drive" && (msg.left !== 0 || msg.right !== 0)) {
        this.lastDriverDriveAt = Date.now();
      } else if (msg.type === "stop" || (msg.type === "drive" && msg.left === 0 && msg.right === 0)) {
        this.lastDriverDriveAt = 0;
      }
      this.callbacks.onDriverMessage?.(msg);
    } else if (this.role === "driver-client") {
      const msg = parseBridgeMessage<RoverToDriverMessage>(raw);
      if (msg) this.callbacks.onRoverMessage?.(msg);
    }
  }

  private publishSignal(env: SignalEnvelope): void {
    this.sig?.publish(JSON.stringify(env));
  }

  private enqueueSignal(raw: string): void {
    const env = parseBridgeMessage<SignalEnvelope>(raw);
    if (!env || env.from === this.peerId) return;

    // Fast path for live Relay Fallback frames & drive commands (never wait behind SDP promises!)
    if (env.kind === "relay-msg" && typeof env.msg === "string") {
      if (this.transportMode === "relay") {
        this.dispatchAppPayload(env.msg);
      }
      return;
    }

    // Serialize all WebRTC SDP/ICE transitions so candidates never race setRemoteDescription
    this.signalQueue = this.signalQueue
      .then(() => this.handleSignal(env))
      .catch(() => undefined);
  }

  private async handleSignal(env: SignalEnvelope): Promise<void> {
    if (this.role === "idle") return;

    try {
      if (this.role === "rover-host") {
        if (env.kind === "relay-open") {
          this.clearHandshakeTimers();
          this.closePeerOnly();
          this.remotePeerId = env.from;
          this.activeSid = env.sid ?? this.activeSid;
          this.transportMode = "relay";
          this.lastPeerActivityAt = Date.now();
          this.emitDiagnostics("Driver switched to Compatible Wi-Fi Relay Video");
          this.callbacks.onStateChange("connected", "Wi-Fi Relay Live");
          this.callbacks.onDriverMessage?.({
            type: "videoFallback",
            enabled: true,
            fps: 7,
            maxWidth: 288,
          });
          return;
        }
        if (env.kind === "relay-close") {
          if (this.transportMode === "relay") {
            this.transportMode = "none";
            this.remotePeerId = null;
            this.lastDriverDriveAt = 0;
            this.callbacks.onFailsafeStop?.();
            this.callbacks.onDriverMessage?.({ type: "videoFallback", enabled: false });
            this.emitDiagnostics("Driver disconnected — waiting for next connection");
            this.callbacks.onStateChange("waiting-peer", "Driver disconnected — waiting for peer");
          }
          return;
        }

        const negotiatingSamePeer =
          this.remotePeerId === env.from &&
          this.pc !== null &&
          (this.pc.connectionState === "new" || this.pc.connectionState === "connecting") &&
          Date.now() - this.lastOfferAt < 13000;

        const stalePreviousPeer =
          this.remotePeerId !== null &&
          this.remotePeerId !== env.from &&
          Date.now() - this.lastPeerActivityAt > 2500;

        if (env.kind === "hello" && (!this.isDataChannelOpen() || stalePreviousPeer) && !negotiatingSamePeer) {
          this.transportMode = "none";
          this.lastDriverDriveAt = 0;
          if (stalePreviousPeer) {
            this.callbacks.onFailsafeStop?.();
            this.callbacks.onDriverMessage?.({ type: "videoFallback", enabled: false });
          }
          this.remotePeerId = env.from;
          this.activeSid = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          this.lastOfferAt = Date.now();
          this.diagnostics.offerReady = false;
          this.diagnostics.answerReady = false;
          this.diagnostics.remoteCandidates = emptyCounts();
          this.callbacks.onStateChange("connecting", "Pairing with Driver — gathering Wi-Fi path…");

          const pc = this.createPeerConnection(true);
          this.setupHostTracksAndChannel(pc);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          // Bundle ALL local LAN IPv4 + STUN ICE candidates atomically inside ONE offer!
          await this.waitForIceComplete(pc, 1500);
          if (this.pc !== pc || this.role !== "rover-host") return;

          this.sdpPublished = true;
          this.diagnostics.offerReady = true;
          this.diagnostics.localCandidates = countCandidatesInSdp(pc.localDescription?.sdp);
          this.emitDiagnostics("Bundled Offer sent — waiting for Driver Answer…");
          this.publishSignal({
            from: this.peerId,
            sid: this.activeSid,
            kind: "offer",
            sdp: pc.localDescription!,
          });
        } else if (env.kind === "answer" && env.sdp && this.pc) {
          if (env.sid && this.activeSid && env.sid !== this.activeSid) return;
          if (this.pc.signalingState === "have-local-offer") {
            this.diagnostics.answerReady = true;
            this.diagnostics.remoteCandidates = countCandidatesInSdp(env.sdp.sdp);
            this.emitDiagnostics("Answer received — connecting direct P2P video…");
            this.callbacks.onStateChange("connecting", "Answer received — opening P2P video…");
            await this.pc.setRemoteDescription(env.sdp);
            await this.flushCandidates(env.from, this.activeSid ?? undefined);
          }
        } else if (env.kind === "ice" && env.candidate) {
          if (env.sid && this.activeSid && env.sid !== this.activeSid) return;
          const cls = classifyIceCandidate(env.candidate.candidate ?? "");
          if (cls) this.diagnostics.remoteCandidates[cls] += 1;
          if (this.pc && this.pc.remoteDescription) {
            await this.pc.addIceCandidate(env.candidate);
          } else {
            this.pendingCandidates.push({
              from: env.from,
              sid: env.sid,
              candidate: env.candidate,
            });
          }
        }
      } else if (this.role === "driver-client") {
        if (env.kind === "hello" && !this.isDataChannelOpen() && !this.pc) {
          this.publishSignal({ from: this.peerId, kind: "hello" });
        } else if (env.kind === "offer" && env.sdp) {
          // Ignore duplicate offer for an already-connected WebRTC session
          if (this.transportMode === "webrtc" && this.isDataChannelOpen()) return;
          if (this.transportMode === "relay") return;

          const samePeerAndSid =
            this.remotePeerId === env.from &&
            Boolean(env.sid) &&
            this.activeSid === env.sid;
          if (samePeerAndSid && this.pc) return;

          this.clearHandshakeTimers();
          this.remotePeerId = env.from;
          this.activeSid = env.sid ?? null;
          this.diagnostics.offerReady = true;
          this.diagnostics.answerReady = false;
          this.diagnostics.remoteCandidates = countCandidatesInSdp(env.sdp.sdp);
          this.emitDiagnostics("Offer received — gathering Wi-Fi path…");
          this.callbacks.onStateChange("connecting", "Offer received — gathering Wi-Fi path…");

          // Keep any early ICE candidates that arrived for this exact peer/session!
          const pc = this.createPeerConnection(false);
          this.setupDriverChannelReceiver(pc);
          await pc.setRemoteDescription(env.sdp);
          await this.flushCandidates(env.from, env.sid);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          // Bundle ALL Driver ICE candidates atomically inside ONE answer!
          await this.waitForIceComplete(pc, 1500);
          if (this.pc !== pc || this.role !== "driver-client") return;

          this.sdpPublished = true;
          this.diagnostics.answerReady = true;
          this.diagnostics.localCandidates = countCandidatesInSdp(pc.localDescription?.sdp);
          const answerEnv: SignalEnvelope = {
            from: this.peerId,
            sid: this.activeSid ?? undefined,
            kind: "answer",
            sdp: pc.localDescription!,
          };
          this.lastAnswerPayload = answerEnv;
          this.publishSignal(answerEnv);

          const rHost = this.diagnostics.remoteCandidates.hostIpv4;
          const rStun = this.diagnostics.remoteCandidates.srflx;
          this.emitDiagnostics(
            `Answer sent — connecting P2P video (Host: ${rHost} LAN, ${rStun} STUN)…`
          );
          this.callbacks.onStateChange("connecting", "Connecting video stream…");

          // Re-send answer once at +2.8s in case MQTT dropped the first packet
          this.answerRetryTimer = setTimeout(() => {
            if (
              this.pc === pc &&
              this.transportMode === "none" &&
              pc.iceConnectionState !== "connected" &&
              pc.iceConnectionState !== "completed" &&
              this.lastAnswerPayload
            ) {
              this.publishSignal(this.lastAnswerPayload);
            }
          }, 2800);

          // Automatic Stage-3B Relay Fallback at +8.0s if direct UDP P2P is blocked by firewall/macOS/router!
          this.iceFallbackTimer = setTimeout(() => {
            if (
              this.pc === pc &&
              this.transportMode === "none" &&
              !this.isDataChannelOpen()
            ) {
              if (this.sig?.supportsHighRateRelay()) {
                this.activateRelayFallbackNow();
              } else {
                this.emitDiagnostics(
                  "Direct P2P timed out — check local Wi-Fi permissions or retry"
                );
                this.callbacks.onStateChange(
                  "connecting",
                  "Direct P2P stalled — check Wi-Fi Local Network access"
                );
              }
            }
          }, 8000);
        } else if (env.kind === "ice" && env.candidate) {
          if (env.sid && this.activeSid && env.sid !== this.activeSid) return;
          const cls = classifyIceCandidate(env.candidate.candidate ?? "");
          if (cls) this.diagnostics.remoteCandidates[cls] += 1;
          if (this.pc && this.pc.remoteDescription) {
            await this.pc.addIceCandidate(env.candidate);
          } else {
            this.pendingCandidates.push({
              from: env.from,
              sid: env.sid,
              candidate: env.candidate,
            });
          }
        }
      }
    } catch {
      // Ignore transient glare / stale signaling messages
    }
  }

  private async flushCandidates(from: string, sid?: string): Promise<void> {
    if (!this.pc) return;
    const remaining: QueuedCandidate[] = [];
    const toApply: RTCIceCandidateInit[] = [];
    for (const item of this.pendingCandidates) {
      if (item.from === from && (!sid || !item.sid || item.sid === sid)) {
        toApply.push(item.candidate);
      } else {
        remaining.push(item);
      }
    }
    this.pendingCandidates = remaining;
    for (const c of toApply) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {
        // Ignore stale candidates
      }
    }
  }

  sendToRover(msg: DriverToRoverMessage): void {
    const raw = JSON.stringify(msg);
    if (this.transportMode === "relay") {
      this.sig?.publishOnMqttOnly(
        JSON.stringify({ from: this.peerId, kind: "relay-msg", msg: raw } satisfies SignalEnvelope)
      );
      return;
    }
    if (!this.dc || this.dc.readyState !== "open") return;
    try {
      this.dc.send(raw);
    } catch {
      // ignore closed race
    }
  }

  sendToDriver(msg: RoverToDriverMessage): void {
    const raw = JSON.stringify(msg);
    if (this.transportMode === "relay") {
      this.sig?.publishOnMqttOnly(
        JSON.stringify({ from: this.peerId, kind: "relay-msg", msg: raw } satisfies SignalEnvelope)
      );
      return;
    }
    if (!this.dc || this.dc.readyState !== "open") return;
    try {
      this.dc.send(raw);
    } catch {
      // ignore closed race
    }
  }

  /** Allow hot-swapping camera video track on the host without dropping DataChannel */
  async replaceCameraStream(stream: MediaStream | null): Promise<void> {
    this.localStream = stream;
    if (!this.pc || !stream) return;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;
    const sender = this.pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) {
      await sender.replaceTrack(videoTrack);
    }
  }

  stop(): void {
    if (this.transportMode === "relay" && this.sig) {
      this.publishSignal({ from: this.peerId, kind: "relay-close" });
    }
    this.role = "idle";
    this.transportMode = "none";
    this.remotePeerId = null;
    this.activeSid = null;
    this.sdpPublished = false;
    this.lastAnswerPayload = null;
    this.lastDriverDriveAt = 0;
    this.lastPeerActivityAt = 0;
    this.pendingCandidates = [];
    this.clearHandshakeTimers();
    if (this.helloTimer) {
      clearInterval(this.helloTimer);
      this.helloTimer = null;
    }
    if (this.linkWatchdog) {
      clearInterval(this.linkWatchdog);
      this.linkWatchdog = null;
    }
    this.closePeerOnly();
    if (this.sig) {
      this.sig.close();
      this.sig = null;
    }
    this.diagnostics = {
      relay: "",
      transport: "none",
      signalingState: "closed",
      iceConnectionState: "new",
      connectionState: "new",
      localCandidates: emptyCounts(),
      remoteCandidates: emptyCounts(),
      offerReady: false,
      answerReady: false,
      note: "",
    };
    this.callbacks.onDiagnostics?.(this.getDiagnostics());
    this.callbacks.onStateChange("idle");
  }
}
