"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { LOCALES, LOCALE_LABEL, type Locale } from "@/lib/locales";
import { Mark, Wordmark } from "./Logo";

type Props = {
  locale: Locale;
  github: string;
  telegram: string;
  labels: { menu: string; close: string; nav: { home: string; docs: string; devices: string; faq: string; github: string; telegram: string } };
};

export default function Header({ locale, github, telegram, labels }: Props) {
  const [open, setOpen] = useState(false);
  const path = usePathname() || `/${locale}`;
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  // the same page in another language
  const rest = path.replace(/^\/[a-z]{2}(?=\/|$)/, "");
  const remember = (l: Locale) => { document.cookie = `lang=${l}; path=/; max-age=31536000; samesite=lax`; };
  const n = labels.nav;
  const links: [string, string][] = [[`/${locale}/docs`, n.docs], [`/${locale}/docs/devices`, n.devices], [`/${locale}/faq`, n.faq]];
  const here = (href: string) => (href === `/${locale}/docs` ? path.startsWith(href) && !path.startsWith(`${href}/devices`) : path.startsWith(href));

  return (
    <header className="hdr">
      <div className="hdr-in">
        <a className="logo" href={`/${locale}`} aria-label="HakiOS">
          <Mark />
          <Wordmark />
        </a>
        <nav className={`hdr-nav${open ? " open" : ""}`} aria-label="Main">
          {links.map(([href, text]) => (
            <a key={href} href={href} aria-current={here(href) ? "page" : undefined}>{text}</a>
          ))}
          <a href={github} target="_blank" rel="noopener">{n.github}</a>
          <a href={telegram} target="_blank" rel="noopener">{n.telegram}</a>
          <div className="langs" role="group" aria-label="Language">
            {LOCALES.map((l) => (
              <a key={l} href={`/${l}${rest}`} aria-current={l === locale ? "true" : undefined} onClick={() => remember(l)}>{LOCALE_LABEL[l]}</a>
            ))}
          </div>
        </nav>
        <button type="button" className="menu-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? labels.close : labels.menu}
        </button>
      </div>
    </header>
  );
}
