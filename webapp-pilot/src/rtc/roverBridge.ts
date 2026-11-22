// SPDX-License-Identifier: MIT
// Two-Device Peer-to-Peer WebRTC Rover Bridge:
//   - Android Phone ("Rover Host"): streams rear camera video + telemetry/vision/map snapshots,
//     receives low-latency drive/assist/explorer commands, enforces 400ms Wi-Fi link-drop failsafe.
//   - Chromebook ("Driver Client"): displays full-screen FPV video + HUD and streams Xbox/touch commands.
// Supports both 4-character Room Code signaling (over WSS MQTT) AND 100% offline manual Offer/Answer copy-paste!

import { TelemetryFrame } from "@core/ble/protocol";
import { MqttSignalingChannel, normalizeRoomCode } from "./mqttSignaling";

export type BridgeRole = "idle" | "rover-host" | "driver-client";
export type BridgeLinkState = "idle" | "signaling" | "waiting-peer" | "connecting" | "connected" | "error";

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
  | { type: "pong"; sentAt: number };

interface SignalEnvelope {
  from: string;
  kind: "hello" | "offer" | "answer" | "ice";
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

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
  private sig: MqttSignalingChannel | null = null;
  private readonly peerId = `p_${Math.random().toString(36).slice(2, 9)}`;
  private remotePeerId: string | null = null;
  private lastOfferAt = 0;
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private linkWatchdog: ReturnType<typeof setInterval> | null = null;
  private lastDriverDriveAt = 0;
  private role: BridgeRole = "idle";
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private localStream: MediaStream | null = null;

  constructor(
    private readonly callbacks: {
      onStateChange: (state: BridgeLinkState, detail?: string) => void;
      onRemoteStream?: (stream: MediaStream) => void;
      onDriverMessage?: (msg: DriverToRoverMessage) => void;
      onRoverMessage?: (msg: RoverToDriverMessage) => void;
      onFailsafeStop?: () => void;
    }
  ) {}

  getRole(): BridgeRole {
    return this.role;
  }

  isDataChannelOpen(): boolean {
    return Boolean(this.dc && this.dc.readyState === "open");
  }

  /**
   * Start as the Android phone mounted on the Tank/Car.
   * Streams the given camera MediaStream and waits for the Chromebook driver on roomCode.
   */
  async startHost(roomCode: string, cameraStream: MediaStream | null): Promise<void> {
    this.stop();
    const code = normalizeRoomCode(roomCode);
    if (!code) throw new Error("Enter a valid Room Code");
    this.role = "rover-host";
    this.localStream = cameraStream;
    this.callbacks.onStateChange("signaling", `Connecting room ${code}…`);

    const topic = `vernie-pilot/v1/room/${code}`;
    this.sig = new MqttSignalingChannel(topic, (payload) => {
      void this.handleSignal(payload);
    });

    try {
      await this.sig.connect();
      this.callbacks.onStateChange("waiting-peer", `Waiting for Driver on code ${code}`);
      // Periodically announce readiness while waiting (never interrupt active ICE negotiation)
      this.publishSignal({ from: this.peerId, kind: "hello" });
      this.helloTimer = setInterval(() => {
        const busy =
          this.isDataChannelOpen() ||
          (this.pc && (this.pc.connectionState === "connecting" || this.pc.connectionState === "connected"));
        if (!busy) {
          this.publishSignal({ from: this.peerId, kind: "hello" });
        }
      }, 3000);

      // Dead-man failsafe: if driver was driving and Wi-Fi stalls > 500 ms, stop motors immediately!
      this.linkWatchdog = setInterval(() => {
        if (this.lastDriverDriveAt > 0 && Date.now() - this.lastDriverDriveAt > 500) {
          this.lastDriverDriveAt = 0;
          this.callbacks.onFailsafeStop?.();
        }
      }, 150);
    } catch (err) {
      this.callbacks.onStateChange(
        "error",
        err instanceof Error ? err.message : "Signaling relay unavailable"
      );
      throw err;
    }
  }

  /**
   * Start as the Chromebook / remote driver joining the Android phone's roomCode.
   */
  async startDriver(roomCode: string): Promise<void> {
    this.stop();
    const code = normalizeRoomCode(roomCode);
    if (!code) throw new Error("Enter the 4-character Room Code shown on the Rover phone");
    this.role = "driver-client";
    this.callbacks.onStateChange("signaling", `Joining room ${code}…`);

    const topic = `vernie-pilot/v1/room/${code}`;
    this.sig = new MqttSignalingChannel(topic, (payload) => {
      void this.handleSignal(payload);
    });

    try {
      await this.sig.connect();
      this.callbacks.onStateChange("waiting-peer", `Looking for Tank on code ${code}…`);
      this.publishSignal({ from: this.peerId, kind: "hello" });
      this.helloTimer = setInterval(() => {
        const busy =
          this.isDataChannelOpen() ||
          (this.pc && (this.pc.connectionState === "connecting" || this.pc.connectionState === "connected"));
        if (!busy) {
          this.publishSignal({ from: this.peerId, kind: "hello" });
        }
      }, 3000);
    } catch (err) {
      this.callbacks.onStateChange(
        "error",
        err instanceof Error ? err.message : "Signaling relay unavailable"
      );
      throw err;
    }
  }

  /**
   * 100% offline serverless fallback: Host generates a complete gathered SDP offer string.
   */
  async createOfflineOffer(cameraStream: MediaStream | null): Promise<string> {
    this.stop();
    this.role = "rover-host";
    this.localStream = cameraStream;
    const pc = this.createPeerConnection();
    this.setupHostTracksAndChannel(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitForIceComplete(pc);
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
    const pc = this.createPeerConnection();
    this.setupDriverChannelReceiver(pc);
    await pc.setRemoteDescription(desc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.waitForIceComplete(pc);
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

  private waitForIceComplete(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", done);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", done);
      setTimeout(() => {
        pc.removeEventListener("icegatheringstatechange", done);
        resolve();
      }, 2500);
    });
  }

  private createPeerConnection(): RTCPeerConnection {
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        // ignore
      }
    }
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;
    this.pendingCandidates = [];

    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.sig) {
        this.publishSignal({
          from: this.peerId,
          kind: "ice",
          candidate: ev.candidate.toJSON(),
        });
      }
    };

    pc.ontrack = (ev) => {
      if (ev.streams && ev.streams[0]) {
        this.callbacks.onRemoteStream?.(ev.streams[0]);
      } else {
        const ms = new MediaStream([ev.track]);
        this.callbacks.onRemoteStream?.(ms);
      }
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "connected") {
        this.callbacks.onStateChange("connected", "Live Wi-Fi FPV Link");
      } else if (st === "disconnected" || st === "failed" || st === "closed") {
        if (this.role === "rover-host") {
          this.lastDriverDriveAt = 0;
          this.callbacks.onFailsafeStop?.();
        }
        if (this.role !== "idle") {
          this.callbacks.onStateChange("waiting-peer", "Peer disconnected — waiting to reconnect");
        }
      }
    };

    return pc;
  }

  private setupHostTracksAndChannel(pc: RTCPeerConnection): void {
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }
    }
    const dc = pc.createDataChannel("vernie-rover", { ordered: true });
    this.attachDataChannel(dc);
  }

  private setupDriverChannelReceiver(pc: RTCPeerConnection): void {
    pc.ondatachannel = (ev) => {
      this.attachDataChannel(ev.channel);
    };
  }

  private attachDataChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.onopen = () => {
      this.callbacks.onStateChange("connected", "Live Wi-Fi FPV Link");
    };
    dc.onclose = () => {
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
      if (this.role === "rover-host") {
        const msg = parseBridgeMessage<DriverToRoverMessage>(ev.data);
        if (!msg) return;
        if (msg.type === "drive" && (msg.left !== 0 || msg.right !== 0)) {
          this.lastDriverDriveAt = Date.now();
        } else if (msg.type === "stop" || (msg.type === "drive" && msg.left === 0 && msg.right === 0)) {
          this.lastDriverDriveAt = 0;
        }
        this.callbacks.onDriverMessage?.(msg);
      } else if (this.role === "driver-client") {
        const msg = parseBridgeMessage<RoverToDriverMessage>(ev.data);
        if (msg) this.callbacks.onRoverMessage?.(msg);
      }
    };
  }

  private publishSignal(env: SignalEnvelope): void {
    this.sig?.publish(JSON.stringify(env));
  }

  private async handleSignal(raw: string): Promise<void> {
    const env = parseBridgeMessage<SignalEnvelope>(raw);
    if (!env || env.from === this.peerId) return;

    try {
      if (this.role === "rover-host") {
        const negotiatingSamePeer =
          this.remotePeerId === env.from &&
          this.pc !== null &&
          (this.pc.connectionState === "new" || this.pc.connectionState === "connecting") &&
          Date.now() - this.lastOfferAt < 10000;
        if (env.kind === "hello" && !this.isDataChannelOpen() && !negotiatingSamePeer) {
          this.remotePeerId = env.from;
          this.lastOfferAt = Date.now();
          this.callbacks.onStateChange("connecting", "Pairing with Chromebook Driver…");
          const pc = this.createPeerConnection();
          this.setupHostTracksAndChannel(pc);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          this.publishSignal({ from: this.peerId, kind: "offer", sdp: pc.localDescription! });
        } else if (env.kind === "answer" && env.sdp && this.pc) {
          if (this.pc.signalingState === "have-local-offer") {
            await this.pc.setRemoteDescription(env.sdp);
            await this.flushCandidates();
          }
        } else if (env.kind === "ice" && env.candidate && this.pc) {
          if (this.pc.remoteDescription) {
            await this.pc.addIceCandidate(env.candidate);
          } else {
            this.pendingCandidates.push(env.candidate);
          }
        }
      } else if (this.role === "driver-client") {
        if (env.kind === "hello" && !this.isDataChannelOpen()) {
          // Reply with hello so host initiates an offer immediately
          this.publishSignal({ from: this.peerId, kind: "hello" });
        } else if (env.kind === "offer" && env.sdp) {
          this.remotePeerId = env.from;
          this.callbacks.onStateChange("connecting", "Connecting video stream…");
          const pc = this.createPeerConnection();
          this.setupDriverChannelReceiver(pc);
          await pc.setRemoteDescription(env.sdp);
          await this.flushCandidates();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.publishSignal({ from: this.peerId, kind: "answer", sdp: pc.localDescription! });
        } else if (env.kind === "ice" && env.candidate && this.pc) {
          if (this.pc.remoteDescription) {
            await this.pc.addIceCandidate(env.candidate);
          } else {
            this.pendingCandidates.push(env.candidate);
          }
        }
      }
    } catch {
      // Ignore transient glare / stale signaling messages
    }
  }

  private async flushCandidates(): Promise<void> {
    if (!this.pc) return;
    const list = this.pendingCandidates.splice(0);
    for (const c of list) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {
        // Ignore stale candidates
      }
    }
  }

  sendToRover(msg: DriverToRoverMessage): void {
    if (!this.dc || this.dc.readyState !== "open") return;
    try {
      this.dc.send(JSON.stringify(msg));
    } catch {
      // ignore closed race
    }
  }

  sendToDriver(msg: RoverToDriverMessage): void {
    if (!this.dc || this.dc.readyState !== "open") return;
    try {
      this.dc.send(JSON.stringify(msg));
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
    this.role = "idle";
    this.remotePeerId = null;
    this.lastDriverDriveAt = 0;
    this.pendingCandidates = [];
    if (this.helloTimer) {
      clearInterval(this.helloTimer);
      this.helloTimer = null;
    }
    if (this.linkWatchdog) {
      clearInterval(this.linkWatchdog);
      this.linkWatchdog = null;
    }
    if (this.dc) {
      try {
        this.dc.close();
      } catch {
        // ignore
      }
      this.dc = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        // ignore
      }
      this.pc = null;
    }
    if (this.sig) {
      this.sig.close();
      this.sig = null;
    }
    this.callbacks.onStateChange("idle");
  }
}
