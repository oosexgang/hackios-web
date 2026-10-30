// The guide: the site's own documentation, written for people (content/guide/<locale>/*.md), kept here and not in the hakios
// repository, so `npm run docs` never overwrites it. A page missing in a language falls back to English. Links inside a page:
// "metal.md" is another guide page, "/docs/boot-args" a page of the synced reference; both get the reader's language.
import fs from "node:fs";
import path from "node:path";
import type { Locale } from "./locales";
import { renderMarkdown, type Heading } from "./docs";

const ROOT = path.join(process.cwd(), "content", "guide");

type Titles = Record<Locale, string>;
export type GuidePage = { slug: string; title: Titles };

// Order matters: this is the order of the sidebar and of the previous / next links.
export const GUIDE: GuidePage[] = [
  { slug: "", title: { en: "Start here", ru: "С чего начать", uk: "З чого почати", zh: "从这里开始" } },
  { slug: "how-it-works", title: { en: "How it works", ru: "Как всё устроено", uk: "Як усе влаштовано", zh: "工作原理" } },
  { slug: "qemu", title: { en: "Run it in QEMU", ru: "Запуск в QEMU", uk: "Запуск у QEMU", zh: "在 QEMU 中运行" } },
  { slug: "phone", title: { en: "Run it on a phone", ru: "Запуск на телефоне", uk: "Запуск на телефоні", zh: "在手机上运行" } },
  { slug: "metal", title: { en: "Metal", ru: "Metal", uk: "Metal", zh: "Metal" } },
  { slug: "your-device", title: { en: "Adapt it to your device", ru: "Адаптация под устройство", uk: "Адаптація під пристрій", zh: "适配你的设备" } },
  { slug: "troubleshooting", title: { en: "When something goes wrong", ru: "Если что-то пошло не так", uk: "Якщо щось пішло не так", zh: "常见问题排查" } },
];

export const GUIDE_SECTION: Titles = { en: "Guide", ru: "Руководство", uk: "Посібник", zh: "指南" };

export type GuideDoc = { slug: string; title: string; html: string; headings: Heading[]; source: string; fallback: boolean };

function fileOf(locale: Locale, slug: string): string {
  return path.join(ROOT, locale, `${slug || "index"}.md`);
}

function link(href: string, locale: Locale): { to: string; external: boolean } {
  const [p, hash] = href.split("#");
  const h = hash ? `#${hash}` : "";
  if (p.startsWith("/")) return { to: `/${locale}${p}${h}`, external: false };
  const slug = p.replace(/\.md$/, "").replace(/^\.\//, "").replace(/^index$/, "");
  return { to: `/${locale}/guide${slug ? `/${slug}` : ""}${h}`, external: false };
}

export function loadGuide(slug: string, locale: Locale): GuideDoc | null {
  if (!GUIDE.some((g) => g.slug === slug)) return null;
  let file = fileOf(locale, slug);
  let fallback = false;
  if (!fs.existsSync(file)) {
    file = fileOf("en", slug);
    fallback = locale !== "en";
    if (!fs.existsSync(file)) return null;
  }
  const { html, headings } = renderMarkdown(fs.readFileSync(file, "utf8"), (href) => link(href, locale));
  const title = headings.find((h) => h.depth === 1)?.text || GUIDE.find((g) => g.slug === slug)!.title[locale];
  return { slug, title, html, headings, source: path.relative(process.cwd(), file), fallback };
}

export function guideNeighbours(slug: string, locale: Locale) {
  const i = GUIDE.findIndex((g) => g.slug === slug);
  const at = (j: number) => (GUIDE[j] ? { slug: GUIDE[j].slug, title: GUIDE[j].title[locale] } : undefined);
  return { prev: at(i - 1), next: at(i + 1) };
}
