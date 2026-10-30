"use client";
// A copy button on every code block of the page, so a command goes to the terminal in one click.
import { useEffect } from "react";

export default function ProseTools({ copy, copied }: { copy: string; copied: string }) {
  useEffect(() => {
    const blocks = document.querySelectorAll<HTMLPreElement>(".prose pre");
    const added: HTMLButtonElement[] = [];
    blocks.forEach((pre) => {
      if (pre.querySelector("button.copy")) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "copy";
      b.textContent = copy;
      b.addEventListener("click", async () => {
        // comments after a command are for reading, not for the terminal
        const text = (pre.querySelector("code")?.textContent || "").replace(/[ \t]+#[^\n]*$/gm, "").trimEnd();
        try {
          await navigator.clipboard.writeText(text);
          b.textContent = copied;
          setTimeout(() => (b.textContent = copy), 1500);
        } catch {
          /* the clipboard is not available: the reader can still select the text */
        }
      });
      pre.appendChild(b);
      added.push(b);
    });
    return () => added.forEach((b) => b.remove());
  }, [copy, copied]);
  return null;
}
