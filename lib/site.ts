// Everything about the project that is not translated lives here.

// The project's code. NEXT_PUBLIC_GITHUB_URL in the hosting dashboard overrides it.
export const GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_URL || "https://github.com/oosexgang/hakios";
// where a link of the documentation to a file of the repository (not a page) goes
export const REPO_FILES = `${GITHUB_URL}/blob/main/`;

// The public address of the site. Used for canonical URLs, Open Graph tags and the sitemap.
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://hakios.example").replace(/\/$/, "");

export const TELEGRAM = {
  channel: "oosexgangdevs",
  url: "https://t.me/oosexgangdevs",
  // shown until the live count from t.me arrives (and if t.me is unreachable)
  fallbackSubscribers: 16305,
};

export const CONTACT_HANDLE = "netusd";

export type Member = { handle: string; country: "UA" | "RU"; role: "founder" | "ceo" | "team" };
// Order matters: this is the order on the site.
export const TEAM: Member[] = [
  { handle: "oodze", country: "RU", role: "founder" },
  { handle: "netusd", country: "UA", role: "ceo" },
  { handle: "wannqn", country: "UA", role: "team" },
  { handle: "hxfuxyyXD", country: "UA", role: "team" },
];

// The repositories, as the documentation's "How the repositories fit" describes them.
const GH = "https://github.com/oosexgang/";
export const REPOS = [
  { name: "hakios", url: `${GH}hakios`, key: "common" },
  { name: "hakios-sm7325", url: `${GH}hakios-sm7325`, key: "device" },
  { name: "hakios-uefi", url: `${GH}hakios-uefi`, key: "uefi" },
] as const;

// The community token keeps the ticker it was issued with on chain.
export const TOKEN = {
  ticker: "$HackiOS",
  network: "BNB Chain",
  platform: "flap.sh",
  contract: "0x5be8dca38cff485d3a80809195284c7f74c77777",
  url: "https://flap.sh/bnb/0x5be8dca38cff485d3a80809195284c7f74c77777",
  supply: "1,000,000,000",
};

export const PRESS = [
  { file: "hakios-mark.svg", key: "mark" },
  { file: "hakios-mark.png", key: "markpng" },
  { file: "hakios-logo.svg", key: "logo" },
] as const;
