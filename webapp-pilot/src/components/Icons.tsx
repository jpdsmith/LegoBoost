// SPDX-License-Identifier: MIT
// Cohesive minimalist geometric SVG icon set for Vernie Pilot hardware console.

import React from "react";

interface IconProps {
  size?: number;
  className?: string;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.85,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
});

export const IconJoystick: React.FC<IconProps> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="8" r="4" />
    <path d="M12 12v5" />
    <path d="M6 20h12a2 2 0 0 0 0-3H6a2 2 0 0 0 0 3Z" />
  </svg>
);

export const IconMusic: React.FC<IconProps> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M9 18V6l11-2v12" />
    <circle cx="6.5" cy="18.5" r="2.5" />
    <circle cx="17.5" cy="16.5" r="2.5" />
  </svg>
);

export const IconBlocks: React.FC<IconProps> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="4" width="18" height="6" rx="2" />
    <rect x="3" y="14" width="12" height="6" rx="2" />
    <path d="M12 10v4" />
  </svg>
);

export const IconEye: React.FC<IconProps> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M2.5 12S6.2 6 12 6s9.5 6 9.5 6-3.7 6-9.5 6-9.5-6-9.5-6Z" />
    <circle cx="12" cy="12" r="2.8" />
  </svg>
);

export const IconWrench: React.FC<IconProps> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1a5.5 5.5 0 0 1-7.4 7.4l-6.6 6.6a2 2 0 0 1-2.8-2.8l6.6-6.6a5.5 5.5 0 0 1 7.4-7.4l-3.3 2.9Z" />
  </svg>
);

export const IconBluetooth: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="m6.5 6.5 11 11L12 22V2l5.5 4.5-11 11" />
  </svg>
);

export const IconPlay: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <polygon points="7 5 19 12 7 19 7 5" fill="currentColor" stroke="none" />
  </svg>
);

export const IconStop: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </svg>
);

export const IconMic: React.FC<IconProps> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
    <path d="M8.5 21h7" />
  </svg>
);

export const IconCamera: React.FC<IconProps> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M4 8a2 2 0 0 1 2-2h2l1.6-2h4.8L16 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z" />
    <circle cx="12" cy="13" r="3.2" />
  </svg>
);

export const IconShield: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3 5 6v6c0 4.5 3 7.7 7 9 4-1.3 7-4.5 7-9V6l-7-3Z" />
  </svg>
);

export const IconSpark: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
  </svg>
);

export const IconVolume: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.5 6a8.5 8.5 0 0 1 0 12" />
  </svg>
);

export const IconVolumeMute: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <path d="m16 9 5 6" />
    <path d="m21 9-5 6" />
  </svg>
);

export const IconTarget: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </svg>
);

export const IconDownload: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M4 20h16" />
  </svg>
);

export const IconRefresh: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </svg>
);

export const IconGamepad: React.FC<IconProps> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="2.5" y="7" width="19" height="10" rx="5" />
    <path d="M7 10.5v3M5.5 12h3" />
    <circle cx="15.5" cy="10.8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="17.7" cy="12.6" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

export const IconWifi: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M5 12.6a10 10 0 0 1 14 0" />
    <path d="M8.5 16.1a5.5 5.5 0 0 1 7 0" />
    <circle cx="12" cy="19.2" r="1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconFlashlight: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3v3M5.6 5.6l2.1 2.1M18.4 5.6l-2.1 2.1" />
    <path d="M8 10h8l-1.5 4v7h-5v-7L8 10Z" />
  </svg>
);

export const IconCompass: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="9" />
    <polygon points="15.2 8.8 13.4 13.4 8.8 15.2 10.6 10.6 15.2 8.8" fill="currentColor" stroke="none" />
  </svg>
);

export const IconMap: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21 3 6" />
    <path d="M9 3v15M15 6v15" />
  </svg>
);

export const IconTank: React.FC<IconProps> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="13" width="18" height="6" rx="3" />
    <path d="M6 13V9a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4" />
    <circle cx="13.5" cy="10" r="1.4" />
    <path d="M6.5 16h11" />
  </svg>
);

export const IconVrHeadset: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3.6a1.5 1.5 0 0 1-1.3-.8l-.9-1.6a1.4 1.4 0 0 0-2.4 0l-.9 1.6a1.5 1.5 0 0 1-1.3.8H5a2 2 0 0 1-2-2V8Z" />
    <circle cx="8.5" cy="11.5" r="1.5" />
    <circle cx="15.5" cy="11.5" r="1.5" />
  </svg>
);


