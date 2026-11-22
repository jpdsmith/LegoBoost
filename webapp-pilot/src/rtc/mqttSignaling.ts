// SPDX-License-Identifier: MIT
// Zero-dependency Dual-Relay Signaling Layer (Port-443 HTTPS/WSS ntfy.sh + MQTT 3.1.1 over WSS)
// for static GitHub Pages. Used ONLY for WebRTC SDP/ICE handshake & same-Wi-Fi discovery;
// all live FPV video & drive commands flow directly peer-to-peer over your local Wi-Fi once paired!

export const DEFAULT_SIGNALING_BROKERS = [
  "wss://broker.emqx.io:8084/mqtt",
  "wss://test.mosquitto.org:8081/mqtt",
  "wss://broker.hivemq.com:8884/mqtt",
];

export const DEFAULT_NTFY_ORIGIN = "https://ntfy.sh";

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

/**
 * Close a WebSocket safely without triggering Chrome's
 * "WebSocket is closed before the connection is established" console error.
 * If the socket is still CONNECTING, strip handlers and close cleanly as soon as it opens.
 */
export function safeCloseWebSocket(
  ws: WebSocket | null,
  beforeClose?: (socket: WebSocket) => void
): void {
  if (!ws) return;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  if (ws.readyState === WebSocket.OPEN) {
    ws.onopen = null;
    try {
      beforeClose?.(ws);
    } catch {
      // ignore
    }
    try {
      ws.close();
    } catch {
      // ignore
    }
  } else if (ws.readyState === WebSocket.CONNECTING) {
    ws.onopen = () => {
      try {
        beforeClose?.(ws);
      } catch {
        // ignore
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
  } else {
    ws.onopen = null;
  }
}

export function encodeRemainingLength(len: number): number[] {
  const out: number[] = [];
  let x = len;
  do {
    let byte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) byte |= 0x80;
    out.push(byte);
  } while (x > 0);
  return out;
}

function encodeUtf8String(str: string): Uint8Array {
  const bytes = textEnc.encode(str);
  const out = new Uint8Array(2 + bytes.length);
  out[0] = (bytes.length >> 8) & 0xff;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

export function buildMqttConnectPacket(clientId: string, keepAliveSec = 45): Uint8Array {
  const proto = encodeUtf8String("MQTT");
  const id = encodeUtf8String(clientId);
  const bodyLen = proto.length + 1 + 1 + 2 + id.length;
  const rem = encodeRemainingLength(bodyLen);
  const pkt = new Uint8Array(1 + rem.length + bodyLen);
  let p = 0;
  pkt[p++] = 0x10; // CONNECT
  pkt.set(rem, p);
  p += rem.length;
  pkt.set(proto, p);
  p += proto.length;
  pkt[p++] = 0x04; // Protocol level 4 (MQTT 3.1.1)
  pkt[p++] = 0x02; // Clean Session
  pkt[p++] = (keepAliveSec >> 8) & 0xff;
  pkt[p++] = keepAliveSec & 0xff;
  pkt.set(id, p);
  return pkt;
}

export function buildMqttSubscribePacket(packetId: number, topic: string): Uint8Array {
  const topicBytes = encodeUtf8String(topic);
  const bodyLen = 2 + topicBytes.length + 1;
  const rem = encodeRemainingLength(bodyLen);
  const pkt = new Uint8Array(1 + rem.length + bodyLen);
  let p = 0;
  pkt[p++] = 0x82; // SUBSCRIBE (QoS 1 header flag)
  pkt.set(rem, p);
  p += rem.length;
  pkt[p++] = (packetId >> 8) & 0xff;
  pkt[p++] = packetId & 0xff;
  pkt.set(topicBytes, p);
  p += topicBytes.length;
  pkt[p++] = 0x00; // Requested QoS 0
  return pkt;
}

export function buildMqttPublishPacket(topic: string, payload: string): Uint8Array {
  const topicBytes = encodeUtf8String(topic);
  const msgBytes = textEnc.encode(payload);
  const bodyLen = topicBytes.length + msgBytes.length;
  const rem = encodeRemainingLength(bodyLen);
  const pkt = new Uint8Array(1 + rem.length + bodyLen);
  let p = 0;
  pkt[p++] = 0x30; // PUBLISH QoS 0
  pkt.set(rem, p);
  p += rem.length;
  pkt.set(topicBytes, p);
  p += topicBytes.length;
  pkt.set(msgBytes, p);
  return pkt;
}

export interface DecodedMqttPublish {
  topic: string;
  payload: string;
}

export type DecodedMqttPacket =
  | { type: "connack"; code: number }
  | { type: "suback" }
  | { type: "pingresp" }
  | { type: "publish"; msg: DecodedMqttPublish };

/**
 * Decode all complete MQTT frames inside a byte buffer and return both decoded packets
 * and any trailing incomplete bytes for stream reassembly.
 */
export function decodeMqttStream(buf: Uint8Array): {
  packets: DecodedMqttPacket[];
  remainder: Uint8Array;
} {
  const packets: DecodedMqttPacket[] = [];
  let offset = 0;

  while (offset + 2 <= buf.length) {
    const header = buf[offset];
    const packetType = header >> 4;
    let multiplier = 1;
    let remLen = 0;
    let idx = offset + 1;
    let byte = 0;
    let headerComplete = false;
    while (idx < buf.length && multiplier <= 128 * 128 * 128) {
      byte = buf[idx++];
      remLen += (byte & 0x7f) * multiplier;
      multiplier *= 128;
      if ((byte & 0x80) === 0) {
        headerComplete = true;
        break;
      }
    }
    if (!headerComplete) break;

    const end = idx + remLen;
    if (end > buf.length) break;

    if (packetType === 2 && remLen >= 2) {
      packets.push({ type: "connack", code: buf[idx + 1] });
    } else if (packetType === 9) {
      packets.push({ type: "suback" });
    } else if (packetType === 13) {
      packets.push({ type: "pingresp" });
    } else if (packetType === 3 && remLen >= 2) {
      const qos = (header >> 1) & 0x03;
      const topicLen = (buf[idx] << 8) | buf[idx + 1];
      const topicStart = idx + 2;
      const topicEnd = topicStart + topicLen;
      if (topicEnd <= end) {
        const topic = textDec.decode(buf.subarray(topicStart, topicEnd));
        const payloadStart = topicEnd + (qos > 0 ? 2 : 0);
        if (payloadStart <= end) {
          const payload = textDec.decode(buf.subarray(payloadStart, end));
          packets.push({ type: "publish", msg: { topic, payload } });
        }
      }
    }

    offset = end;
  }

  return {
    packets,
    remainder: offset < buf.length ? buf.slice(offset) : new Uint8Array(0),
  };
}

export function decodeMqttPackets(buf: Uint8Array): DecodedMqttPacket[] {
  return decodeMqttStream(buf).packets;
}

/**
 * Split payloads larger than maxChunkLen into numbered JSON chunks so large Chrome WebRTC SDPs
 * (~3-6 KB) always fit safely inside 4 KB HTTP/SSE pub-sub limits (like ntfy.sh).
 */
export function chunkSignalingPayload(payload: string, maxChunkLen = 2400): string[] {
  if (payload.length <= maxChunkLen) return [payload];
  const cid = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const total = Math.ceil(payload.length / maxChunkLen);
  const out: string[] = [];
  for (let i = 0; i < total; i++) {
    out.push(
      JSON.stringify({
        __vpChunk: 1,
        cid,
        idx: i,
        total,
        data: payload.slice(i * maxChunkLen, (i + 1) * maxChunkLen),
      })
    );
  }
  return out;
}

export class SignalingChunkReassembler {
  private readonly pending = new Map<string, { total: number; parts: Map<number, string>; at: number }>();

  push(raw: string): string | null {
    if (!raw.startsWith('{"__vpChunk":1,')) return raw;
    try {
      const obj = JSON.parse(raw) as {
        __vpChunk?: number;
        cid?: string;
        idx?: number;
        total?: number;
        data?: string;
      };
      if (
        obj.__vpChunk !== 1 ||
        typeof obj.cid !== "string" ||
        typeof obj.idx !== "number" ||
        typeof obj.total !== "number" ||
        typeof obj.data !== "string"
      ) {
        return null;
      }
      const now = Date.now();
      for (const [k, v] of this.pending.entries()) {
        if (now - v.at > 15000) this.pending.delete(k);
      }
      let entry = this.pending.get(obj.cid);
      if (!entry) {
        entry = { total: obj.total, parts: new Map(), at: now };
        this.pending.set(obj.cid, entry);
      }
      entry.parts.set(obj.idx, obj.data);
      if (entry.parts.size === entry.total) {
        let joined = "";
        for (let i = 0; i < entry.total; i++) {
          const part = entry.parts.get(i);
          if (part === undefined) return null;
          joined += part;
        }
        this.pending.delete(obj.cid);
        return joined;
      }
      return null;
    } catch {
      return null;
    }
  }
}

export function sanitizeNtfyTopic(topic: string): string {
  return topic.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/**
 * Standard Port-443 HTTPS/WSS pub-sub fallback via ntfy.sh (used ONLY when all MQTT WSS
 * ports are blocked by a strict firewall, avoiding ntfy.sh's 250 msg/day free-tier quota).
 */
export class NtfySignalingChannel {
  private ws: WebSocket | null = null;
  private connectingWs: WebSocket | null = null;
  private closed = false;
  private rateLimitedUntil = 0;
  private sendQueue: Promise<void> = Promise.resolve();
  private readonly safeTopic: string;
  private readonly reassembler = new SignalingChunkReassembler();

  constructor(
    topic: string,
    private readonly onMessage: (payload: string) => void,
    private readonly origin = DEFAULT_NTFY_ORIGIN
  ) {
    this.safeTopic = sanitizeNtfyTopic(topic);
  }

  isOpen(): boolean {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  connect(): Promise<void> {
    this.closed = false;
    const wsBase = this.origin.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
    const wsUrl = `${wsBase}/${this.safeTopic}/ws`;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl);
      this.connectingWs = ws;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (this.connectingWs === ws) this.connectingWs = null;
          safeCloseWebSocket(ws);
          reject(new Error("HTTPS relay timeout (ntfy.sh)"));
        }
      }, 6000);

      ws.onmessage = (ev) => {
        if (this.closed || typeof ev.data !== "string") return;
        try {
          const frame = JSON.parse(ev.data) as { event?: string; message?: string };
          if (frame.event === "open") {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              if (this.connectingWs === ws) this.connectingWs = null;
              this.ws = ws;
              resolve();
            }
            return;
          }
          if (frame.event === "message" && typeof frame.message === "string") {
            const full = this.reassembler.push(frame.message);
            if (full) this.onMessage(full);
          }
        } catch {
          // ignore malformed event
        }
      };

      ws.onopen = () => {
        if (this.closed) {
          safeCloseWebSocket(ws);
          return;
        }
        setTimeout(() => {
          if (!settled && !this.closed && ws.readyState === WebSocket.OPEN) {
            settled = true;
            clearTimeout(timeout);
            if (this.connectingWs === ws) this.connectingWs = null;
            this.ws = ws;
            resolve();
          }
        }, 500);
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          if (this.connectingWs === ws) this.connectingWs = null;
          reject(new Error("HTTPS relay connection failed (ntfy.sh)"));
        }
      };

      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        if (this.connectingWs === ws) this.connectingWs = null;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("HTTPS relay closed (ntfy.sh)"));
        }
      };
    });
  }

  publish(payload: string): void {
    if (this.closed || Date.now() < this.rateLimitedUntil) return;
    const chunks = chunkSignalingPayload(payload, 2400);
    const url = `${this.origin}/${this.safeTopic}`;
    this.sendQueue = this.sendQueue.then(async () => {
      for (const chunk of chunks) {
        if (this.closed || Date.now() < this.rateLimitedUntil) return;
        try {
          // Plain-text body without custom headers avoids CORS preflight!
          const res = await fetch(url, {
            method: "POST",
            body: chunk,
          });
          if (res.status === 429) {
            const retrySec = Number.parseInt(res.headers.get("retry-after") ?? "60", 10);
            this.rateLimitedUntil = Date.now() + Math.max(30, Math.min(300, retrySec || 60)) * 1000;
            return;
          }
        } catch {
          // ignore transient send error; peer retries cleanly
        }
      }
    });
  }

  close(): void {
    this.closed = true;
    safeCloseWebSocket(this.connectingWs);
    this.connectingWs = null;
    safeCloseWebSocket(this.ws);
    this.ws = null;
  }
}

export class MqttSignalingChannel {
  private ws: WebSocket | null = null;
  private connectingWs: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private brokerUsed = "";
  private lastBrokers: string[] = DEFAULT_SIGNALING_BROKERS;
  private reconnectAttempts = 0;
  private rxBuf: Uint8Array = new Uint8Array(0);

  constructor(
    private readonly topic: string,
    private readonly onMessage: (payload: string) => void,
    private readonly onStatus?: (status: string) => void
  ) {}

  getBroker(): string {
    return this.brokerUsed;
  }

  getBrokerShortName(): string {
    if (this.brokerUsed.includes("emqx")) return "EMQX";
    if (this.brokerUsed.includes("mosquitto")) return "Mosquitto";
    if (this.brokerUsed.includes("hivemq")) return "HiveMQ";
    return "MQTT-WSS";
  }

  isOpen(): boolean {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  getBufferedAmount(): number {
    return this.ws ? this.ws.bufferedAmount : 0;
  }

  async connect(brokers: string[] = DEFAULT_SIGNALING_BROKERS): Promise<void> {
    this.closed = false;
    this.lastBrokers = brokers;
    this.reconnectAttempts = 0;
    let lastError: Error = new Error("Unable to reach MQTT signaling relay");

    for (const url of brokers) {
      if (this.closed) return;
      try {
        await this.connectSingle(url);
        this.brokerUsed = url;
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || this.reconnectAttempts >= 6) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(6000, 1200 * this.reconnectAttempts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || this.isOpen()) return;
      const ordered = this.brokerUsed
        ? [this.brokerUsed, ...this.lastBrokers.filter((b) => b !== this.brokerUsed)]
        : this.lastBrokers;
      void this.connect(ordered).catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
  }

  private connectSingle(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      this.rxBuf = new Uint8Array(0);
      const ws = new WebSocket(url, "mqtt");
      ws.binaryType = "arraybuffer";
      this.connectingWs = ws;

      const finishReady = () => {
        if (settled || this.closed) return;
        settled = true;
        clearTimeout(timeout);
        if (this.connectingWs === ws) this.connectingWs = null;
        this.ws = ws;
        this.reconnectAttempts = 0;
        this.onStatus?.("Signaling ready");
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(new Uint8Array([0xc0, 0x00])); // PINGREQ
          }
        }, 25000);
        resolve();
      };

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (this.connectingWs === ws) this.connectingWs = null;
          safeCloseWebSocket(ws);
          reject(new Error(`Signaling relay timeout (${url})`));
        }
      }, 5500);

      ws.onopen = () => {
        if (this.closed) {
          safeCloseWebSocket(ws);
          return;
        }
        const rand = Math.random().toString(36).slice(2, 10);
        ws.send(buildMqttConnectPacket(`vp_${rand}`));
      };

      ws.onmessage = (ev) => {
        if (this.closed) return;
        const chunk =
          ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(0);
        if (chunk.length === 0) return;

        // Concatenate with any leftover incomplete packet bytes from previous frame
        let combined: Uint8Array;
        if (this.rxBuf.length > 0) {
          combined = new Uint8Array(this.rxBuf.length + chunk.length);
          combined.set(this.rxBuf, 0);
          combined.set(chunk, this.rxBuf.length);
        } else {
          combined = chunk;
        }
        const { packets, remainder } = decodeMqttStream(combined);
        this.rxBuf = remainder;

        for (const pkt of packets) {
          if (pkt.type === "connack") {
            if (pkt.code === 0) {
              ws.send(buildMqttSubscribePacket(1, this.topic));
              // Wait briefly for SUBACK so first published message isn't missed
              setTimeout(finishReady, 450);
            } else if (!settled) {
              settled = true;
              clearTimeout(timeout);
              if (this.connectingWs === ws) this.connectingWs = null;
              safeCloseWebSocket(ws);
              reject(new Error(`MQTT CONNACK rejected (${pkt.code})`));
            }
          } else if (pkt.type === "suback") {
            finishReady();
          } else if (pkt.type === "publish") {
            this.onMessage(pkt.msg.payload);
          }
        }
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          if (this.connectingWs === ws) this.connectingWs = null;
          reject(new Error(`Signaling connection failed (${url})`));
        }
      };

      ws.onclose = () => {
        const wasActive = this.ws === ws;
        if (wasActive) {
          this.ws = null;
          if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
          }
        }
        if (this.connectingWs === ws) this.connectingWs = null;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Signaling closed (${url})`));
        } else if (wasActive && !this.closed) {
          this.scheduleReconnect();
        }
      };
    });
  }

  publish(payload: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(buildMqttPublishPacket(this.topic, payload));
    } catch {
      // ignore transient send error
    }
  }

  close(): void {
    this.closed = true;
    this.rxBuf = new Uint8Array(0);
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    safeCloseWebSocket(this.connectingWs);
    this.connectingWs = null;
    safeCloseWebSocket(this.ws, (sock) => sock.send(new Uint8Array([0xe0, 0x00])));
    this.ws = null;
  }
}

export interface MultiSignalingOptions {
  /** Allow falling back to Port-443 ntfy.sh ONLY if every MQTT WSS broker fails. */
  allowNtfyFallback?: boolean;
}

/**
 * Reliable Multi-Broker Signaling Channel:
 *  - Primary: MQTT 3.1.1 over WSS (EMQX -> Mosquitto -> HiveMQ) with zero daily quota limits
 *    and ~35 ms warm RTT (also powers automatic WSS Relay Fallback if direct P2P UDP is blocked!).
 *  - Backup: Port-443 ntfy.sh ONLY when every MQTT WSS broker is blocked by a firewall.
 */
export class MultiSignalingChannel {
  private readonly ntfy: NtfySignalingChannel;
  private readonly mqtt: MqttSignalingChannel;
  private readonly allowNtfyFallback: boolean;
  private readonly seenIds = new Map<string, number>();
  private closed = false;
  private activeRelays: string[] = [];

  constructor(
    topic: string,
    private readonly onMessage: (payload: string) => void,
    options?: MultiSignalingOptions
  ) {
    this.allowNtfyFallback = options?.allowNtfyFallback ?? false;

    const handleIncoming = (raw: string) => {
      if (this.closed) return;
      try {
        const parsed = JSON.parse(raw) as { __mid?: string; __body?: string };
        if (parsed && typeof parsed.__mid === "string" && typeof parsed.__body === "string") {
          const now = Date.now();
          if (this.seenIds.has(parsed.__mid)) return;
          this.seenIds.set(parsed.__mid, now);
          if (this.seenIds.size > 150) {
            for (const [k, t] of this.seenIds.entries()) {
              if (now - t > 30000) this.seenIds.delete(k);
            }
          }
          this.onMessage(parsed.__body);
          return;
        }
      } catch {
        // Fall through to raw payload
      }
      this.onMessage(raw);
    };

    this.ntfy = new NtfySignalingChannel(`vp2-${topic}`, handleIncoming);
    this.mqtt = new MqttSignalingChannel(`vernie-pilot/v2/${topic}`, handleIncoming);
  }

  getActiveRelays(): string[] {
    return [...this.activeRelays];
  }

  isOpen(): boolean {
    return this.mqtt.isOpen() || this.ntfy.isOpen();
  }

  supportsHighRateRelay(): boolean {
    return this.mqtt.isOpen();
  }

  getBufferedAmount(): number {
    return this.mqtt.getBufferedAmount();
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.activeRelays = [];

    try {
      await this.mqtt.connect();
      if (!this.closed) {
        this.activeRelays = [this.mqtt.getBrokerShortName()];
      }
      return;
    } catch (mqttErr) {
      if (this.closed) return;
      if (!this.allowNtfyFallback) {
        throw mqttErr instanceof Error
          ? mqttErr
          : new Error("Could not connect to Wi-Fi pairing relay");
      }
    }

    // Strict firewall fallback (Port 443 HTTPS/WSS via ntfy.sh)
    await this.ntfy.connect();
    if (!this.closed) {
      this.activeRelays = ["HTTPS-443"];
    }
  }

  publish(payload: string): void {
    if (this.closed) return;
    const wrapped = JSON.stringify({
      __mid: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      __body: payload,
    });
    if (this.mqtt.isOpen()) this.mqtt.publish(wrapped);
    if (this.ntfy.isOpen()) this.ntfy.publish(wrapped);
  }

  /** High-rate publish strictly over MQTT WSS (never touches ntfy.sh quota). */
  publishOnMqttOnly(payload: string): void {
    if (this.closed || !this.mqtt.isOpen()) return;
    this.mqtt.publish(payload);
  }

  close(): void {
    this.closed = true;
    this.activeRelays = [];
    this.ntfy.close();
    this.mqtt.close();
  }
}

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRoomCode(length = 4): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  }
  return code;
}

export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}
