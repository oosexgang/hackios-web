import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, type Locale } from "@/lib/locales";
import { getDict } from "@/lib/dict";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  return isLocale(locale) ? { title: getDict(locale).faq_t, alternates: { canonical: `/${locale}/faq` } } : {};
}

export default async function Faq({ params }: Params) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale as Locale);
  const jsonLd = {
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: d.faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  };
  return (
    <main className="wrap sec faq">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <h1>{d.faq_t}</h1>
      <p className="sub">{d.faq_p} <a href={`/${locale}/docs`}>{d.nav.docs}</a></p>
      {d.faq.map(([q, a], i) => (
        <details key={i} open={i === 0}>
          <summary>{q}</summary>
          <p>{a}</p>
        </details>
      ))}
    </main>
  );
}
