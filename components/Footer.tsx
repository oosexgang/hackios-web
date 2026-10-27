import type { Dict } from "@/lib/dict";
import type { Locale } from "@/lib/locales";
import { GITHUB_URL, TELEGRAM } from "@/lib/site";
import { Mark, Wordmark } from "./Logo";

export default function Footer({ d, locale }: { d: Dict; locale: Locale }) {
  return (
    <footer className="ftr">
      <div className="ftr-in">
        <div className="ftr-brand">
          <Mark size={22} />
          <Wordmark />
        </div>
        <nav className="ftr-nav">
          <a href={`/${locale}/docs`}>{d.nav.docs}</a>
          <a href={`/${locale}/docs/devices`}>{d.nav.devices}</a>
          <a href={`/${locale}/faq`}>{d.nav.faq}</a>
          <a href={GITHUB_URL} target="_blank" rel="noopener">{d.nav.github}</a>
          <a href={TELEGRAM.url} target="_blank" rel="noopener">{d.nav.telegram}</a>
        </nav>
        <p className="disc">{d.disc}</p>
        <p className="legal">© 2026 HakiOS. {d.rights} <a href="#top">{d.top}</a></p>
      </div>
    </footer>
  );
}
