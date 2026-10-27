import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { Inter, JetBrains_Mono } from "next/font/google";
import "../globals.css";
import { LOCALES, HTML_LANG, OG_LOCALE, isLocale, type Locale } from "@/lib/locales";
import { getDict } from "@/lib/dict";
import { SITE_URL, TELEGRAM, GITHUB_URL } from "@/lib/site";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

const sans = Inter({ subsets: ["latin", "cyrillic"], weight: ["400", "500", "600", "700"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin", "cyrillic"], weight: ["400", "500", "700"], variable: "--font-mono", display: "swap" });

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export const viewport: Viewport = {
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#fbfaf9" }, { media: "(prefers-color-scheme: dark)", color: "#0e0d0c" }],
  colorScheme: "light dark", width: "device-width", initialScale: 1,
};

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  const languages = Object.fromEntries(LOCALES.map((l) => [HTML_LANG[l], `/${l}`]));
  return {
    metadataBase: new URL(SITE_URL),
    title: { default: d.meta_title, template: "%s · HakiOS" },
    description: d.meta_desc,
    applicationName: "HakiOS",
    keywords: ["HakiOS", "XNU", "Darwin", "Android", "Qualcomm", "POCO X5 Pro", "kernel"],
    alternates: { canonical: `/${locale}`, languages: { ...languages, "x-default": "/en" } },
    openGraph: {
      type: "website", siteName: "HakiOS", url: `/${locale}`, title: d.meta_title, description: d.meta_desc,
      locale: OG_LOCALE[locale], alternateLocale: LOCALES.filter((l) => l !== locale).map((l) => OG_LOCALE[l]),
    },
    twitter: { card: "summary_large_image", title: d.meta_title, description: d.meta_desc },
    manifest: "/manifest.webmanifest",
  };
}

export default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale as Locale);
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "SoftwareSourceCode", name: "HakiOS", codeRepository: GITHUB_URL, programmingLanguage: ["C", "C++", "Python"], description: d.meta_desc },
      { "@type": "WebSite", name: "HakiOS", url: `${SITE_URL}/${locale}`, inLanguage: HTML_LANG[locale as Locale], sameAs: [TELEGRAM.url, GITHUB_URL] },
    ],
  };
  return (
    <html lang={HTML_LANG[locale as Locale]} className={`${sans.variable} ${mono.variable}`}>
      <body id="top">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <Header locale={locale as Locale} github={GITHUB_URL} telegram={TELEGRAM.url} labels={{ menu: d.menu, close: d.close, nav: d.nav }} />
        {children}
        <Footer d={d} locale={locale as Locale} />
      </body>
    </html>
  );
}
