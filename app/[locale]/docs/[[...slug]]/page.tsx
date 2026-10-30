import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LOCALES, isLocale, type Locale } from "@/lib/locales";
import { getDict } from "@/lib/dict";
import { allSlugs, loadDoc, neighbours } from "@/lib/docs";
import { REPO_FILES } from "@/lib/site";
import DocsShell from "@/components/DocsShell";

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
  const L = locale as Locale;
  const d = getDict(L);
  const path = (slug || []).join("/");
  const doc = loadDoc(path, L);
  if (!doc) notFound();
  const { prev, next } = neighbours(path);
  const href = (s: string) => `/${L}/docs${s ? `/${s}` : ""}`;
  return (
    <DocsShell
      locale={L}
      d={d}
      current={href(path)}
      section={d.docs_ref}
      note={L !== "en" ? `${d.docs_lang} ${d.docs_ref_note}` : d.docs_ref_note}
      html={doc.html}
      headings={doc.headings}
      prev={prev ? { title: prev.title, href: href(prev.slug) } : undefined}
      next={next ? { title: next.title, href: href(next.slug) } : undefined}
      source={{ href: `${REPO_FILES}${doc.source}`, label: d.docs_source }}
    />
  );
}
