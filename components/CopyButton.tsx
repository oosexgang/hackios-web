"use client";
import { useState } from "react";

// Copies `value`, or the current page URL when `value` is "location".
export default function CopyButton({ value, label, done, className = "copy" }: { value: string; label: string; done: string; className?: string }) {
  const [ok, setOk] = useState(false);
  const copy = async () => {
    const text = value === "location" ? location.href.split("#")[0] : value;
    try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1600); }
    catch { window.prompt?.("", text); }
  };
  return <button type="button" className={className} onClick={copy}>{ok ? done : label}</button>;
}
