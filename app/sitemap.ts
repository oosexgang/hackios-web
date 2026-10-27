import type { MetadataRoute } from "next";
import { LOCALES } from "@/lib/locales";
import { SITE_URL } from "@/lib/site";
import { allSlugs } from "@/lib/docs";

// every page in every language: the home page, the FAQ, each page of the documentation
export default function sitemap(): MetadataRoute.Sitemap {
  const paths = ["", "/faq", ...allSlugs().map((s) => (s ? `/docs/${s}` : "/docs"))];
  return LOCALES.flatMap((l) => paths.map((p) => ({
    url: `${SITE_URL}/${l}${p}`,
    lastModified: new Date(),
    changeFrequency: "weekly" as const,
    priority: p === "" ? (l === "en" ? 1 : 0.8) : 0.6,
  })));
}
