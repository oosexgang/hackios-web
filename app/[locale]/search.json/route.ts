// The search index of one language: every guide page and every reference page, with its section headings. Built once, at
// build time, and fetched by the search box only when it opens.
import { LOCALES, isLocale, type Locale } from "@/lib/locales";
import { GUIDE, GUIDE_SECTION, loadGuide } from "@/lib/guide";
import { allSlugs, loadDoc } from "@/lib/docs";
import { getDict } from "@/lib/dict";

export const dynamic = "force-static";

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export type SearchEntry = { title: string; href: string; section: string; headings: { text: string; id: string }[] };

export async function GET(_: Request, { params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) return new Response("not found", { status: 404 });
  const L = locale as Locale;
  const out: SearchEntry[] = [];
  for (const g of GUIDE) {
    const doc = loadGuide(g.slug, L);
    if (doc) out.push({ title: doc.title, href: `/${L}/guide${g.slug ? `/${g.slug}` : ""}`, section: GUIDE_SECTION[L], headings: doc.headings.filter((h) => h.depth > 1).map((h) => ({ text: h.text, id: h.id })) });
  }
  const ref = getDict(L).docs_ref;
  for (const s of allSlugs()) {
    const doc = loadDoc(s, L);
    if (doc) out.push({ title: doc.title, href: `/${L}/docs${s ? `/${s}` : ""}`, section: ref, headings: doc.headings.filter((h) => h.depth === 2).map((h) => ({ text: h.text, id: h.id })) });
  }
  return Response.json(out);
}
