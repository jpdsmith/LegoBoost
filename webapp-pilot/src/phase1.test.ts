// SPDX-License-Identifier: MIT
// Phase 1 Unit Tests: Xbox Controller Engine, MQTT-over-WSS Signaling Codec,
// WebRTC Rover Bridge Protocol, and Virtual FPV Rover Camera Geometry.

import { describe, expect, it } from "vitest";
import {
  GamepadLike,
  mixXboxToTank,
  shapeAxis,
  XboxControllerReader,
} from "./input/xboxController";
import {
  buildMqttConnectPacket,
  buildMqttPublishPacket,
  buildMqttSubscribePacket,
  chunkSignalingPayload,
  decodeMqttPackets,
  decodeMqttStream,
  encodeRemainingLength,
  generateRoomCode,
  normalizeRoomCode,
  safeCloseWebSocket,
  SignalingChunkReassembler,
} from "./rtc/mqttSignaling";
import {
  classifyIceCandidate,
  countCandidatesInSdp,
  DriverToRoverMessage,
  parseBridgeMessage,
  RoverToDriverMessage,
} from "./rtc/roverBridge";
import { computeHouseholdTopic } from "./rtc/wifiDiscovery";

function makePad(overrides: Partial<GamepadLike> = {}): GamepadLike {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  return {
    id: "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)",
    connected: true,
    axes: [0, 0, 0, 0],
    buttons,
    ...overrides,
  };
}

describe("Phase 1 — XboxControllerReader & driving math", () => {
  it("applies deadzone and smooth cubic shaping on axes", () => {
    expect(shapeAxis(0.1)).toBe(0);
    expect(shapeAxis(-0.12)).toBe(0);
    expect(shapeAxis(1)).toBe(1);
    expect(shapeAxis(-1)).toBe(-1);
    // Mid-deflection curves gentler than linear for smooth indoor creeping
    const mid = shapeAxis(0.57);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.5);
  });

  it("supports both Left-Stick arcade drive and RT/LT car trigger drive", () => {
    const reader = new XboxControllerReader();

    // Left stick full forward (Web Gamepad API: axis 1 = -1 is up/forward)
    const s1 = reader.poll(makePad({ axes: [0, -1, 0, 0] }));
    expect(s1.connected).toBe(true);
    expect(s1.usingTriggers).toBe(false);
    expect(s1.throttle).toBe(1);
    expect(mixXboxToTank(s1.steer, s1.throttle, 65)).toEqual({ left: 65, right: 65 });

    // Car mode: RT full throttle + Left Stick right turn
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
    buttons[7] = { pressed: true, value: 1 }; // RT
    const s2 = reader.poll(makePad({ axes: [1, 0, 0, 0], buttons }));
    expect(s2.usingTriggers).toBe(true);
    expect(s2.throttle).toBe(1);
    expect(s2.steer).toBe(1);
    expect(mixXboxToTank(s2.steer, s2.throttle, 80)).toEqual({ left: 80, right: 0 });
  });

  it("edge-triggers A/B/X/Y/LB/RB button presses without spamming on hold", () => {
    const reader = new XboxControllerReader();
    const btns = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
    btns[1] = { pressed: true, value: 1 }; // B = stop
    btns[2] = { pressed: true, value: 1 }; // X = headlights

    const first = reader.poll(makePad({ buttons: btns }));
    expect(first.actions).toEqual(["stop", "headlights"]);

    // Holding same buttons on next tick emits zero duplicate actions
    const held = reader.poll(makePad({ buttons: btns }));
    expect(held.actions).toEqual([]);

    // Release and press Y (cycle-assist)
    const btns2 = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
    btns2[3] = { pressed: true, value: 1 };
    const third = reader.poll(makePad({ buttons: btns2 }));
    expect(third.actions).toEqual(["cycle-assist"]);
  });
});

describe("Phase 1 — Dual-Relay Port-443 + MQTT Signaling & Auto-Discovery", () => {
  it("encodes variable-length remaining lengths per MQTT 3.1.1 spec", () => {
    expect(encodeRemainingLength(0)).toEqual([0]);
    expect(encodeRemainingLength(127)).toEqual([127]);
    expect(encodeRemainingLength(128)).toEqual([0x80, 0x01]);
    expect(encodeRemainingLength(16383)).toEqual([0xff, 0x7f]);
  });

  it("round-trips PUBLISH packets cleanly across fragmented WebSocket frames", () => {
    const conn = buildMqttConnectPacket("vp_test1");
    expect(conn[0]).toBe(0x10);
    const sub = buildMqttSubscribePacket(1, "vernie-pilot/v2/room-K4M9");
    expect(sub[0]).toBe(0x82);

    const pub = buildMqttPublishPacket(
      "vernie-pilot/v2/room-K4M9",
      JSON.stringify({ from: "p1", kind: "hello" })
    );
    const connack = new Uint8Array([0x20, 0x02, 0x00, 0x00]);
    const combined = new Uint8Array(connack.length + pub.length);
    combined.set(connack, 0);
    combined.set(pub, connack.length);

    // Split mid-packet to verify stream reassembly!
    const splitAt = connack.length + 10;
    const part1 = decodeMqttStream(combined.slice(0, splitAt));
    expect(part1.packets).toEqual([{ type: "connack", code: 0 }]);
    expect(part1.remainder.length).toBe(10);

    const merged = new Uint8Array(part1.remainder.length + (combined.length - splitAt));
    merged.set(part1.remainder, 0);
    merged.set(combined.slice(splitAt), part1.remainder.length);
    const part2 = decodeMqttStream(merged);
    expect(part2.remainder.length).toBe(0);
    expect(part2.packets).toEqual([
      {
        type: "publish",
        msg: {
          topic: "vernie-pilot/v2/room-K4M9",
          payload: '{"from":"p1","kind":"hello"}',
        },
      },
    ]);

    expect(decodeMqttPackets(combined)).toHaveLength(2);
  });

  it("chunks and reassembles large 5 KB WebRTC SDP offers cleanly for port-443 ntfy.sh", () => {
    const largeSdp = JSON.stringify({
      from: "p_host",
      kind: "offer",
      sdp: { type: "offer", sdp: "v=0\r\n" + "a=candidate:foo ".repeat(380) },
    });
    expect(largeSdp.length).toBeGreaterThan(5000);

    const chunks = chunkSignalingPayload(largeSdp, 2400);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThan(2600);
    }

    const reassembler = new SignalingChunkReassembler();
    let reassembled: string | null = null;
    for (const c of chunks) {
      reassembled = reassembler.push(c);
    }
    expect(reassembled).toBe(largeSdp);
  });

  it("hashes shared public IPv4 into deterministic private Same-Wi-Fi discovery topic", async () => {
    const t1 = await computeHouseholdTopic("203.0.113.42");
    const t2 = await computeHouseholdTopic("203.0.113.42");
    const tOther = await computeHouseholdTopic("198.51.100.7");
    expect(t1).toBe(t2);
    expect(t1).not.toBe(tOther);
    expect(t1).toMatch(/^lan-[0-9a-f]{16}$/);
    expect(t1).not.toContain("203");
  });

  it("generates and normalizes human-friendly 4-character Room Codes", () => {
    const code = generateRoomCode(4);
    expect(code).toMatch(/^[A-Z0-9]{4}$/);
    expect(normalizeRoomCode(" k4-m9! ")).toBe("K4M9");
  });
});

describe("Phase 1 — WebRTC Rover Bridge Message Parsing & ICE Diagnostics", () => {
  it("parses valid DriverToRover & RoverToDriver fallback messages and rejects corrupt JSON safely", () => {
    const parsed = parseBridgeMessage<DriverToRoverMessage>(
      '{"type":"drive","left":50,"right":50,"timeoutMs":400,"seq":1,"sentAt":1000}'
    );
    expect(parsed?.type).toBe("drive");

    const fbReq = parseBridgeMessage<DriverToRoverMessage>(
      '{"type":"videoFallback","enabled":true,"fps":7,"maxWidth":288}'
    );
    expect(fbReq).toEqual({ type: "videoFallback", enabled: true, fps: 7, maxWidth: 288 });

    const frame = parseBridgeMessage<RoverToDriverMessage>(
      '{"type":"jpegFrame","dataUrl":"data:image/jpeg;base64,AA==","width":288,"height":162,"ts":1234}'
    );
    expect(frame?.type).toBe("jpegFrame");
    expect(parseBridgeMessage("not-json{")).toBeNull();
  });

  it("defers WebSocket close when CONNECTING to avoid browser console errors", () => {
    let closedCount = 0;
    const mockConnecting = {
      readyState: WebSocket.CONNECTING,
      onopen: null as (() => void) | null,
      onmessage: () => undefined,
      onerror: () => undefined,
      onclose: () => undefined,
      close: () => {
        closedCount += 1;
      },
    } as unknown as WebSocket;

    safeCloseWebSocket(mockConnecting);
    expect(closedCount).toBe(0);
    expect(mockConnecting.onmessage).toBeNull();
    expect(typeof mockConnecting.onopen).toBe("function");
    (mockConnecting.onopen as () => void)();
    expect(closedCount).toBe(1);

    let openClosed = 0;
    const mockOpen = {
      readyState: WebSocket.OPEN,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      close: () => {
        openClosed += 1;
      },
    } as unknown as WebSocket;
    safeCloseWebSocket(mockOpen);
    expect(openClosed).toBe(1);
  });

  it("classifies LAN IPv4 host, mDNS .local, STUN srflx, and TURN relay SDP candidates accurately", () => {
    expect(
      classifyIceCandidate("candidate:1 1 udp 2122260223 192.168.1.45 54321 typ host")
    ).toBe("hostIpv4");
    expect(
      classifyIceCandidate("candidate:2 1 udp 2122194687 a1b2c3d4.local 54322 typ host")
    ).toBe("mdns");
    expect(
      classifyIceCandidate("candidate:3 1 udp 1686052607 203.0.113.5 54321 typ srflx raddr 0.0.0.0")
    ).toBe("srflx");
    expect(
      classifyIceCandidate("candidate:4 1 udp 41885439 198.51.100.2 3478 typ relay")
    ).toBe("relay");

    const sdp = [
      "v=0",
      "a=candidate:1 1 udp 2122260223 192.168.1.45 54321 typ host",
      "a=candidate:2 1 udp 2122194687 a1b2c3d4.local 54322 typ host",
      "a=candidate:3 1 udp 1686052607 203.0.113.5 54321 typ srflx raddr 0.0.0.0",
    ].join("\r\n");
    expect(countCandidatesInSdp(sdp)).toEqual({
      hostIpv4: 1,
      mdns: 1,
      srflx: 1,
      relay: 0,
    });
  });
});
