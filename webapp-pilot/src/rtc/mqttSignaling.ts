// SPDX-License-Identifier: MIT
// Zero-dependency MQTT 3.1.1 over Secure WebSocket (WSS) signaling client for static GitHub Pages.
// Used ONLY to exchange compact WebRTC SDP Offer/Answer/ICE messages by 4-character Room Code;
// all live FPV video & joystick data flows directly peer-to-peer over local Wi-Fi once connected!

export const DEFAULT_SIGNALING_BROKERS = [
  "wss://broker.emqx.io:8084/mqtt",
  "wss://broker.hivemq.com:8884/mqtt",
];

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

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

/**
 * Decode all complete MQTT frames inside a received WebSocket binary buffer.
 */
export function decodeMqttPackets(buf: Uint8Array): Array<
  | { type: "connack"; code: number }
  | { type: "suback" }
  | { type: "pingresp" }
  | { type: "publish"; msg: DecodedMqttPublish }
> {
  const out: Array<
    | { type: "connack"; code: number }
    | { type: "suback" }
    | { type: "pingresp" }
    | { type: "publish"; msg: DecodedMqttPublish }
  > = [];

  let offset = 0;
  while (offset + 2 <= buf.length) {
    const header = buf[offset];
    const packetType = header >> 4;
    let multiplier = 1;
    let remLen = 0;
    let idx = offset + 1;
    let byte = 0;
    do {
      if (idx >= buf.length) return out;
      byte = buf[idx++];
      remLen += (byte & 0x7f) * multiplier;
      multiplier *= 128;
    } while ((byte & 0x80) !== 0 && multiplier <= 128 * 128 * 128);

    const end = idx + remLen;
    if (end > buf.length) break;

    if (packetType === 2 && remLen >= 2) {
      out.push({ type: "connack", code: buf[idx + 1] });
    } else if (packetType === 9) {
      out.push({ type: "suback" });
    } else if (packetType === 13) {
      out.push({ type: "pingresp" });
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
          out.push({ type: "publish", msg: { topic, payload } });
        }
      }
    }

    offset = end;
  }
  return out;
}

export class MqttSignalingChannel {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private brokerUsed = "";

  constructor(
    private readonly topic: string,
    private readonly onMessage: (payload: string) => void,
    private readonly onStatus?: (status: string) => void
  ) {}

  getBroker(): string {
    return this.brokerUsed;
  }

  async connect(brokers: string[] = DEFAULT_SIGNALING_BROKERS): Promise<void> {
    this.closed = false;
    let lastError: Error = new Error("Unable to reach signaling relay");

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

  private connectSingle(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url, "mqtt");
      ws.binaryType = "arraybuffer";

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            ws.close();
          } catch {
            // ignore
          }
          reject(new Error(`Signaling relay timeout (${url})`));
        }
      }, 6500);

      ws.onopen = () => {
        const rand = Math.random().toString(36).slice(2, 10);
        ws.send(buildMqttConnectPacket(`vp_${rand}`));
      };

      ws.onmessage = (ev) => {
        const raw =
          ev.data instanceof ArrayBuffer
            ? new Uint8Array(ev.data)
            : new Uint8Array(0);
        for (const pkt of decodeMqttPackets(raw)) {
          if (pkt.type === "connack") {
            if (pkt.code === 0) {
              ws.send(buildMqttSubscribePacket(1, this.topic));
              if (!settled) {
                settled = true;
                clearTimeout(timeout);
                this.ws = ws;
                this.onStatus?.("Signaling ready");
                this.pingTimer = setInterval(() => {
                  if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(new Uint8Array([0xc0, 0x00])); // PINGREQ
                  }
                }, 25000);
                resolve();
              }
            } else if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(new Error(`MQTT CONNACK rejected (${pkt.code})`));
            }
          } else if (pkt.type === "publish") {
            this.onMessage(pkt.msg.payload);
          }
        }
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Signaling connection failed (${url})`));
        }
      };

      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = null;
          if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
          }
        }
      };
    });
  }

  publish(payload: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(buildMqttPublishPacket(this.topic, payload));
  }

  close(): void {
    this.closed = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.send(new Uint8Array([0xe0, 0x00])); // DISCONNECT
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
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
