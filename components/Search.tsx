"use client";
// Search over the guide and the reference: titles and section headings, in the reader's language. Opens with the button,
// with Ctrl+K / ⌘K or "/", loads its index only then, and is driven from the keyboard.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Entry = { title: string; href: string; section: string; headings: { text: string; id: string }[] };
type Hit = { title: string; href: string; where: string; score: number };

function norm(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function find(index: Entry[], q: string): Hit[] {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: Hit[] = [];
  for (const e of index) {
    const t = norm(e.title);
    if (words.every((w) => t.includes(w))) hits.push({ title: e.title, href: e.href, where: e.section, score: t.startsWith(words[0]) ? 30 : 20 });
    for (const h of e.headings) {
      const ht = norm(h.text);
      if (words.every((w) => ht.includes(w) || t.includes(w)) && words.some((w) => ht.includes(w)))
        hits.push({ title: h.text, href: `${e.href}#${h.id}`, where: `${e.section} · ${e.title}`, score: 10 + (e.section === index[0]?.section ? 2 : 0) });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 30);
}

export default function Search({ locale, label, placeholder, empty }: { locale: string; label: string; placeholder: string; empty: string }) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState<Entry[] | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const show = useCallback(() => {
    setOpen(true);
    if (!index) fetch(`/${locale}/search.json`).then((r) => r.json()).then(setIndex).catch(() => setIndex([]));
  }, [index, locale]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /input|textarea/i.test((e.target as HTMLElement)?.tagName || "");
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        show();
      } else if (e.key === "Escape") setOpen(false);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [show]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const hits = useMemo(() => (index ? find(index, q) : []), [index, q]);
  useEffect(() => setSel(0), [q]);

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter" && hits[sel]) location.href = hits[sel].href;
  };

  return (
    <>
      <button type="button" className="search-btn" onClick={show} aria-label={label}>
        <span>{label}</span>
        <kbd>⌘K</kbd>
      </button>
      {open && (
        <div className="search" role="dialog" aria-modal="true" aria-label={label} onClick={() => setOpen(false)}>
          <div className="search-box" onClick={(e) => e.stopPropagation()}>
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onInputKey} placeholder={placeholder} aria-label={placeholder} />
            {q && (
              <ul role="listbox">
                {hits.length ? (
                  hits.map((h, i) => (
                    <li key={h.href + i}>
                      <a href={h.href} aria-selected={i === sel} onMouseEnter={() => setSel(i)}>
                        {h.title}
                        <small>{h.where}</small>
                      </a>
                    </li>
                  ))
                ) : (
                  <li className="empty">{index ? empty : "…"}</li>
                )}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}
