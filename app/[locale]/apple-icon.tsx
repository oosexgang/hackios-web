import { ImageResponse } from "next/og";
import { LOCALES } from "@/lib/locales";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";
export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

// the mark on its own, for a phone's home screen
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#161312" }}>
        <svg width="180" height="180" viewBox="0 0 64 64">
          <path d="M22 14v36M22 33c0-6 4.5-9.5 9.5-9.5S41 27 41 33v17" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="45.5" cy="16.5" r="4.5" fill="#e8170f" />
        </svg>
      </div>
    ),
    size,
  );
}
