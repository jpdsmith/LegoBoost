// SPDX-License-Identifier: MIT
// Same-Wi-Fi Automatic Tank Discovery (Zero IP Address Required!).
// Devices on the same home Wi-Fi share the router's public IPv4 address.
// Both devices hash that IPv4 locally with SHA-256 into a private household discovery topic
// (the raw IP is NEVER transmitted), so the Android Phone on the tank automatically appears
// on the Chromebook within ~1 second for one-click Wi-Fi pairing!

import { MultiSignalingChannel, normalizeRoomCode } from "./mqttSignaling";

export interface DiscoveredTank {
  code: string;
  name: string;
  bleConnected: boolean;
  cameraReady: boolean;
  lastSeenAt: number;
}

interface DiscoveryBeacon {
  kind: "tank" | "scan";
  from: string;
  code?: string;
  name?: string;
  bleConnected?: boolean;
  cameraReady?: boolean;
  ts?: number;
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function fallbackHashHex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (ch + i), 0x27d4eb2d) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/**
 * Derive a deterministic, privacy-preserving 16-hex discovery topic from the household's public IPv4.
 */
export async function computeHouseholdTopic(ipv4: string): Promise<string> {
  const clean = ipv4.trim();
  const seed = `vernie-pilot-lan-v2:${clean}`;
  try {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const data = new TextEncoder().encode(seed);
      const digest = await crypto.subtle.digest("SHA-256", data);
      const bytes = new Uint8Array(digest);
      let hex = "";
      for (let i = 0; i < 8; i++) {
        hex += bytes[i].toString(16).padStart(2, "0");
      }
      return `lan-${hex}`;
    }
  } catch {
    // Fall back to deterministic JS hash on non-secure origins
  }
  return `lan-${fallbackHashHex(seed)}`;
}

async function fetchWithTimeout(url: string, timeoutMs = 4000): Promise<Response> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    return await fetch(url, { signal: ctrl?.signal });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve the shared home router public IPv4 address (IPv4 only so dual-stack IPv6 devices
 * on the same home Wi-Fi always resolve to the exact same household key!).
 */
export async function resolvePublicIpv4(): Promise<string | null> {
  try {
    const res = await fetchWithTimeout("https://api.ipify.org?format=json", 3800);
    if (res.ok) {
      const json = (await res.json()) as { ip?: string };
      if (json.ip && IPV4_RE.test(json.ip.trim())) return json.ip.trim();
    }
  } catch {
    // try fallback
  }

  for (const url of ["https://api.ipify.org", "https://ipv4.icanhazip.com"]) {
    try {
      const res = await fetchWithTimeout(url, 3800);
      if (res.ok) {
        const ip = (await res.text()).trim();
        if (IPV4_RE.test(ip)) return ip;
      }
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Runs on the Android Phone mounted on the tank: broadcasts live presence to the household Wi-Fi
 * discovery topic so the Chromebook finds it automatically with zero IP or code typing!
 */
export class WifiTankAdvertiser {
  private channel: MultiSignalingChannel | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly id = `h_${Math.random().toString(36).slice(2, 8)}`;
  private info: { code: string; name: string; bleConnected: boolean; cameraReady: boolean } = {
    code: "",
    name: "VernieOS Tank",
    bleConnected: false,
    cameraReady: false,
  };

  constructor(private readonly onStatus?: (status: string) => void) {}

  update(info: { code: string; name?: string; bleConnected: boolean; cameraReady: boolean }): void {
    this.info = {
      code: normalizeRoomCode(info.code),
      name: info.name ?? "VernieOS Tank",
      bleConnected: info.bleConnected,
      cameraReady: info.cameraReady,
    };
    this.broadcast();
  }

  async start(info: {
    code: string;
    name?: string;
    bleConnected: boolean;
    cameraReady: boolean;
  }): Promise<boolean> {
    this.stop();
    this.stopped = false;
    this.info = {
      code: normalizeRoomCode(info.code),
      name: info.name ?? "VernieOS Tank",
      bleConnected: info.bleConnected,
      cameraReady: info.cameraReady,
    };

    this.onStatus?.("Starting same-Wi-Fi auto-discovery…");
    const ip = await resolvePublicIpv4();
    if (this.stopped) return false;
    if (!ip) {
      this.onStatus?.("Auto-discovery offline — use the 4-letter Room Code");
      return false;
    }

    const topic = await computeHouseholdTopic(ip);
    if (this.stopped) return false;

    const ch = new MultiSignalingChannel(topic, (raw) => {
      try {
        const msg = JSON.parse(raw) as DiscoveryBeacon;
        if (msg.kind === "scan" && msg.from !== this.id) {
          this.broadcast();
        }
      } catch {
        // ignore
      }
    });
    this.channel = ch;

    try {
      await ch.connect();
      if (this.stopped) {
        ch.close();
        return false;
      }
      this.onStatus?.("Broadcasting on your Wi-Fi (Chromebook will auto-discover!)");
      this.broadcast();
      this.timer = setInterval(() => this.broadcast(), 2500);
      return true;
    } catch {
      this.onStatus?.("Auto-discovery relay unavailable — use 4-letter Room Code");
      return false;
    }
  }

  private broadcast(): void {
    if (!this.channel || !this.info.code) return;
    const beacon: DiscoveryBeacon = {
      kind: "tank",
      from: this.id,
      code: this.info.code,
      name: this.info.name,
      bleConnected: this.info.bleConnected,
      cameraReady: this.info.cameraReady,
      ts: Date.now(),
    };
    this.channel.publish(JSON.stringify(beacon));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }
}

/**
 * Runs on the Chromebook Driver: automatically discovers any hosting Android Phone Tank on the
 * same home Wi-Fi network without typing any IP address or room code!
 */
export class WifiTankScanner {
  private channel: MultiSignalingChannel | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly id = `d_${Math.random().toString(36).slice(2, 8)}`;
  private readonly tanks = new Map<string, DiscoveredTank>();

  constructor(
    private readonly callbacks: {
      onTanksChange: (tanks: DiscoveredTank[]) => void;
      onStatus?: (status: string) => void;
    }
  ) {}

  async start(): Promise<boolean> {
    this.stop();
    this.stopped = false;
    this.callbacks.onStatus?.("Checking Wi-Fi for nearby tanks (no IP needed)…");

    const ip = await resolvePublicIpv4();
    if (this.stopped) return false;
    if (!ip) {
      this.callbacks.onStatus?.("Enter the 4-letter Room Code shown on your Android phone");
      return false;
    }

    const topic = await computeHouseholdTopic(ip);
    if (this.stopped) return false;

    const ch = new MultiSignalingChannel(topic, (raw) => {
      try {
        const msg = JSON.parse(raw) as DiscoveryBeacon;
        if (msg.kind === "tank" && msg.code && msg.from !== this.id) {
          const code = normalizeRoomCode(msg.code);
          if (!code) return;
          this.tanks.set(code, {
            code,
            name: msg.name || "VernieOS Tank",
            bleConnected: Boolean(msg.bleConnected),
            cameraReady: Boolean(msg.cameraReady),
            lastSeenAt: Date.now(),
          });
          this.emitList();
        }
      } catch {
        // ignore
      }
    });
    this.channel = ch;

    try {
      await ch.connect();
      if (this.stopped) {
        ch.close();
        return false;
      }
      this.callbacks.onStatus?.(
        "Scanning your Wi-Fi automatically — tap Start Hosting on your Android phone…"
      );
      this.probe();
      this.scanTimer = setInterval(() => this.probe(), 3500);
      this.pruneTimer = setInterval(() => this.pruneStale(), 2500);
      return true;
    } catch {
      this.callbacks.onStatus?.("Auto-discovery unavailable — enter 4-letter Room Code manually");
      return false;
    }
  }

  probe(): void {
    if (!this.channel) return;
    const msg: DiscoveryBeacon = { kind: "scan", from: this.id, ts: Date.now() };
    this.channel.publish(JSON.stringify(msg));
  }

  private pruneStale(): void {
    const now = Date.now();
    let changed = false;
    for (const [code, tank] of this.tanks.entries()) {
      if (now - tank.lastSeenAt > 10000) {
        this.tanks.delete(code);
        changed = true;
      }
    }
    if (changed) this.emitList();
  }

  private emitList(): void {
    const list = Array.from(this.tanks.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    this.callbacks.onTanksChange(list);
    if (list.length > 0) {
      this.callbacks.onStatus?.(
        `Found ${list.length === 1 ? "your Tank" : `${list.length} Tanks`} on your Wi-Fi!`
      );
    } else {
      this.callbacks.onStatus?.(
        "Scanning your Wi-Fi automatically — tap Start Hosting on your Android phone…"
      );
    }
  }

  stop(): void {
    this.stopped = true;
    this.tanks.clear();
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }
}
