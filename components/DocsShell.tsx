// The frame of every documentation page: the guide and the reference in one sidebar (folded on a phone), the page, the
// previous / next links and the table of contents of the page.
import type { Dict } from "@/lib/dict";
import type { Locale } from "@/lib/locales";
import type { Heading } from "@/lib/docs";
import { NAV } from "@/lib/docs-nav";
import { GUIDE, GUIDE_SECTION } from "@/lib/guide";
import ProseTools from "./ProseTools";

type Link = { title: string; href: string };

type Props = {
  locale: Locale;
  d: Dict;
  current: string; // the href of this page
  section: string; // shown above the title
  note?: string;
  html: string;
  headings: Heading[];
  prev?: Link;
  next?: Link;
  source: { href: string; label: string };
};

export default function DocsShell({ locale, d, current, section, note, html, headings, prev, next, source }: Props) {
  const toc = headings.filter((h) => h.depth === 2 || h.depth === 3);
  const guide = (slug: string) => `/${locale}/guide${slug ? `/${slug}` : ""}`;
  const ref = (slug: string) => `/${locale}/docs${slug ? `/${slug}` : ""}`;
  return (
    <main className="docs wide">
      <aside className="docs-nav" aria-label={d.docs_t}>
        <input type="checkbox" id="docs-nav-toggle" className="docs-nav-toggle" aria-hidden="true" />
        <label htmlFor="docs-nav-toggle" className="docs-nav-label">{d.docs_contents}</label>
        <div className="docs-nav-list">
          <p className="nav-h guide">{GUIDE_SECTION[locale]}</p>
          <ul>
            {GUIDE.map((g) => (
              <li key={g.slug}><a href={guide(g.slug)} aria-current={guide(g.slug) === current ? "page" : undefined}>{g.title[locale]}</a></li>
            ))}
          </ul>
          <p className="nav-ref">{d.docs_ref}</p>
          {NAV.map((sec) => (
            <div key={sec.title}>
              <p className="nav-h">{sec.title}</p>
              <ul>
                {sec.items.map((it) => (
                  <li key={it.slug}><a href={ref(it.slug)} aria-current={ref(it.slug) === current ? "page" : undefined}>{it.title}</a></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </aside>
      <article className="doc">
        <p className="crumbs">{section}</p>
        {note && <p className="lang-note">{note}</p>}
        <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
        <ProseTools copy={d.copy} copied={d.copied} />
        <nav className="pager">
          {prev ? <a href={prev.href}><small>← {d.docs_prev}</small>{prev.title}</a> : <span />}
          {next ? <a className="next" href={next.href}><small>{d.docs_next} →</small>{next.title}</a> : <span />}
        </nav>
        <p className="small"><a href={source.href} target="_blank" rel="noopener">{source.label}</a></p>
      </article>
      {toc.length > 2 && (
        <aside className="docs-toc">
          <p className="nav-h">{d.docs_toc}</p>
          <ul>{toc.map((h) => <li key={h.id} className={`d${h.depth}`}><a href={`#${h.id}`}>{h.text}</a></li>)}</ul>
        </aside>
      )}
    </main>
  );
}
