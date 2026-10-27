import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LOCALES, isLocale, type Locale } from "@/lib/locales";
import { getDict } from "@/lib/dict";
import { allSlugs, loadDoc, neighbours } from "@/lib/docs";
import { NAV } from "@/lib/docs-nav";
import { REPO_FILES } from "@/lib/site";

type Params = { params: Promise<{ locale: string; slug?: string[] }> };

export function generateStaticParams() {
  return LOCALES.flatMap((locale) => allSlugs().map((s) => ({ locale, slug: s ? s.split("/") : [] })));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, slug } = await params;
  const doc = isLocale(locale) ? loadDoc((slug || []).join("/"), locale) : null;
  return doc ? { title: doc.title, alternates: { canonical: `/${locale}/docs${slug?.length ? `/${slug.join("/")}` : ""}` } } : {};
}

export default async function DocPage({ params }: Params) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale as Locale);
  const path = (slug || []).join("/");
  const doc = loadDoc(path, locale);
  if (!doc) notFound();
  const { prev, next } = neighbours(path);
  const base = `/${locale}/docs`;
  const href = (s: string) => (s ? `${base}/${s}` : base);
  const toc = doc.headings.filter((h) => h.depth === 2 || h.depth === 3);

  return (
    <main className="docs wrap">
      <aside className="docs-nav" aria-label={d.docs_t}>
        {NAV.map((sec) => (
          <div key={sec.title}>
            <p className="nav-h">{sec.title}</p>
            <ul>
              {sec.items.map((it) => (
                <li key={it.slug}><a href={href(it.slug)} aria-current={it.slug === path ? "page" : undefined}>{it.title}</a></li>
              ))}
            </ul>
          </div>
        ))}
      </aside>
      <article className="doc">
        {locale !== "en" && <p className="lang-note">{d.docs_lang}</p>}
        <div className="prose" dangerouslySetInnerHTML={{ __html: doc.html }} />
        <nav className="pager">
          {prev ? <a href={href(prev.slug)}><small>{d.docs_prev}</small>{prev.title}</a> : <span />}
          {next ? <a className="next" href={href(next.slug)}><small>{d.docs_next}</small>{next.title}</a> : <span />}
        </nav>
        <p className="small"><a href={`${REPO_FILES}${doc.source}`} target="_blank" rel="noopener">{d.docs_source}</a></p>
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
