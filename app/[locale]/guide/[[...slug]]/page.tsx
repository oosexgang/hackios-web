import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LOCALES, isLocale, type Locale } from "@/lib/locales";
import { getDict } from "@/lib/dict";
import { GUIDE, GUIDE_SECTION, guideNeighbours, loadGuide } from "@/lib/guide";
import DocsShell from "@/components/DocsShell";

type Params = { params: Promise<{ locale: string; slug?: string[] }> };

export function generateStaticParams() {
  return LOCALES.flatMap((locale) => GUIDE.map((g) => ({ locale, slug: g.slug ? [g.slug] : [] })));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, slug } = await params;
  const doc = isLocale(locale) ? loadGuide((slug || []).join("/"), locale) : null;
  return doc ? { title: doc.title, alternates: { canonical: `/${locale}/guide${slug?.length ? `/${slug.join("/")}` : ""}` } } : {};
}

export default async function GuidePage({ params }: Params) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const L = locale as Locale;
  const d = getDict(L);
  const path = (slug || []).join("/");
  const doc = loadGuide(path, L);
  if (!doc) notFound();
  const href = (s: string) => `/${L}/guide${s ? `/${s}` : ""}`;
  const { prev, next } = guideNeighbours(path, L);
  return (
    <DocsShell
      locale={L}
      d={d}
      current={href(path)}
      section={GUIDE_SECTION[L]}
      note={doc.fallback ? d.guide_fallback : undefined}
      html={doc.html}
      headings={doc.headings}
      prev={prev ? { title: prev.title, href: href(prev.slug) } : undefined}
      next={next ? { title: next.title, href: href(next.slug) } : { title: d.docs_ref, href: `/${L}/docs` }}
      source={{ href: `https://github.com/oosexgang/hackios-web/blob/main/${doc.source}`, label: d.docs_source }}
    />
  );
}
