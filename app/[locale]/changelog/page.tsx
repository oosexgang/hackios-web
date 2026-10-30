import type { Metadata } from "next";
import { notFound } from "next/navigation";
import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { isLocale, type Locale } from "@/lib/locales";
import { getDict } from "@/lib/dict";

type Params = { params: Promise<{ locale: string }> };

/*
 * The changelog: content/changelog.md, the hakios-xnu-kernel repository's CHANGELOG.md (copied with the documentation,
 * npm run docs). One "## YYYY-MM-DD" section a day, newest first, one line a change; a section with another heading
 * (Sources: what a build is made of) is shown as it is, before the dates. What is above the first section is the
 * file's own introduction, which this page says in the reader's language instead.
 */
type Day = { date: string; html: string; isDate: boolean };

function days(): Day[] {
  const file = path.join(process.cwd(), "content", "changelog.md");
  if (!fs.existsSync(file)) return [];
  const parts = fs.readFileSync(file, "utf8").split(/^## /m).slice(1);
  return parts.map((part) => {
    const nl = part.indexOf("\n");
    const date = part.slice(0, nl).trim();
    return { date, html: marked.parse(part.slice(nl + 1), { async: false }) as string, isDate: /^\d{4}-\d{2}-\d{2}$/.test(date) };
  });
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  return isLocale(locale) ? { title: getDict(locale).changelog_t, alternates: { canonical: `/${locale}/changelog` } } : {};
}

export default async function Changelog({ params }: Params) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale as Locale);
  return (
    <main className="wrap sec changelog">
      <h1>{d.changelog_t}</h1>
      <p className="sub">{d.changelog_p}</p>
      {days().map((day) => (
        <section key={day.date} id={day.date.toLowerCase().replace(/[^a-z0-9]+/g, "-")}>
          <h2><a href={`#${day.date.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{day.isDate ? <time dateTime={day.date}>{day.date}</time> : day.date}</a></h2>
          <div className="prose" dangerouslySetInnerHTML={{ __html: day.html }} />
        </section>
      ))}
    </main>
  );
}
