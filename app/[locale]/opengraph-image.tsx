import { ImageResponse } from "next/og";
import { LOCALES } from "@/lib/locales";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "hakios: the Darwin kernel on Android phones";
export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

// what a link to the site shows: the mark, the wordmark, one line
export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 96px", background: "#fbfaf9", color: "#161312" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
          <svg width="128" height="128" viewBox="0 0 64 64">
            <rect width="64" height="64" rx="16" fill="#161312" />
            <path d="M22 14v36M22 33c0-6 4.5-9.5 9.5-9.5S41 27 41 33v17" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="45.5" cy="16.5" r="4.5" fill="#e8170f" />
          </svg>
          <div style={{ display: "flex", alignItems: "flex-end", fontSize: 120, fontWeight: 600, letterSpacing: -4 }}>
            hakios<div style={{ width: 22, height: 22, borderRadius: 11, background: "#e8170f", marginLeft: 6, marginBottom: 26 }} />
          </div>
        </div>
        <div style={{ marginTop: 44, fontSize: 40, color: "#6f6866" }}>The Darwin kernel on Android phones</div>
      </div>
    ),
    size,
  );
}
