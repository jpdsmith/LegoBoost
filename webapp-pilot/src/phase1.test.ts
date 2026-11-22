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
  decodeMqttPackets,
  encodeRemainingLength,
  generateRoomCode,
  normalizeRoomCode,
} from "./rtc/mqttSignaling";
import { parseBridgeMessage, DriverToRoverMessage } from "./rtc/roverBridge";

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

describe("Phase 1 — Zero-Dependency MQTT-over-WSS Signaling Codec", () => {
  it("encodes variable-length remaining lengths per MQTT 3.1.1 spec", () => {
    expect(encodeRemainingLength(0)).toEqual([0]);
    expect(encodeRemainingLength(127)).toEqual([127]);
    expect(encodeRemainingLength(128)).toEqual([0x80, 0x01]);
    expect(encodeRemainingLength(16383)).toEqual([0xff, 0x7f]);
  });

  it("round-trips PUBLISH packets cleanly alongside CONNACK/SUBACK frames", () => {
    const conn = buildMqttConnectPacket("vp_test1");
    expect(conn[0]).toBe(0x10);
    const sub = buildMqttSubscribePacket(1, "vernie-pilot/v1/room/K4M9");
    expect(sub[0]).toBe(0x82);

    const pub = buildMqttPublishPacket(
      "vernie-pilot/v1/room/K4M9",
      JSON.stringify({ from: "p1", kind: "hello" })
    );
    const connack = new Uint8Array([0x20, 0x02, 0x00, 0x00]);
    const combined = new Uint8Array(connack.length + pub.length);
    combined.set(connack, 0);
    combined.set(pub, connack.length);

    const decoded = decodeMqttPackets(combined);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toEqual({ type: "connack", code: 0 });
    expect(decoded[1]).toEqual({
      type: "publish",
      msg: {
        topic: "vernie-pilot/v1/room/K4M9",
        payload: '{"from":"p1","kind":"hello"}',
      },
    });
  });

  it("generates and normalizes human-friendly 4-character Room Codes", () => {
    const code = generateRoomCode(4);
    expect(code).toMatch(/^[A-Z0-9]{4}$/);
    expect(normalizeRoomCode(" k4-m9! ")).toBe("K4M9");
  });
});

describe("Phase 1 — WebRTC Rover Bridge Message Parsing", () => {
  it("parses valid DriverToRover messages and rejects corrupt JSON safely", () => {
    const parsed = parseBridgeMessage<DriverToRoverMessage>(
      '{"type":"drive","left":50,"right":50,"timeoutMs":400,"seq":1,"sentAt":1000}'
    );
    expect(parsed?.type).toBe("drive");
    expect(parseBridgeMessage("not-json{")).toBeNull();
  });
});
