import type { MetadataRoute } from "next";
import { LOCALES } from "@/lib/locales";
import { SITE_URL } from "@/lib/site";
import { allSlugs } from "@/lib/docs";
import { GUIDE } from "@/lib/guide";

// every page in every language: the home page, the FAQ, the guide, each page of the reference
export default function sitemap(): MetadataRoute.Sitemap {
  const paths = ["", "/faq", "/changelog", ...GUIDE.map((g) => (g.slug ? `/guide/${g.slug}` : "/guide")), ...allSlugs().map((s) => (s ? `/docs/${s}` : "/docs"))];
  return LOCALES.flatMap((l) => paths.map((p) => ({
    url: `${SITE_URL}/${l}${p}`,
    lastModified: new Date(),
    changeFrequency: "weekly" as const,
    priority: p === "" ? (l === "en" ? 1 : 0.8) : 0.6,
  })));
}
