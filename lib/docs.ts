// The documentation pages: Markdown files of content/docs, rendered at build time. A link between pages becomes a link between
// the site's pages; a link to a file of the repository outside docs/ goes to that file on GitHub; headings get the anchors GitHub
// gives them, so a link that works in the repository works here (the hakios repository's tools/docs-check.py checks them).
import fs from "node:fs";
import path from "node:path";
import { Marked, type Tokens } from "marked";
import { NAV } from "./docs-nav";
import { REPO_FILES } from "./site";

const ROOT = path.join(process.cwd(), "content", "docs");

export type Heading = { depth: number; text: string; id: string };
export type Doc = { slug: string; title: string; html: string; headings: Heading[]; source: string };

/* "getting-started/index.md" -> "getting-started", "index.md" -> "", "driver-review/README.md" -> "driver-review" */
function slugOf(file: string): string {
  const s = file.replace(/\\/g, "/").replace(/\.md$/, "");
  return s.replace(/(^|\/)(index|README)$/, "").replace(/\/$/, "");
}

function walk(dir: string, base = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) return walk(path.join(dir, e.name), rel);
    return e.name.endsWith(".md") ? [rel] : [];
  });
}

const FILES: Map<string, string> = new Map(walk(ROOT).map((f) => [slugOf(f), f]));

export function allSlugs(): string[] {
  return [...FILES.keys()];
}

/* the anchor GitHub makes of a heading: lower case, punctuation dropped, spaces to dashes */
export function anchor(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}_\- ]/gu, "")
    .replace(/ /g, "-");
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/* the words of a heading, without markup; marked escapes text tokens, and the table of contents wants it as typed */
function plain(tokens: Tokens.Generic[] | undefined): string {
  return (tokens || [])
    .map((t) => ("tokens" in t && t.tokens ? plain(t.tokens as Tokens.Generic[]) : (t as { text?: string }).text || ""))
    .join("")
    .replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]);
}

export function loadDoc(slug: string, locale: string): Doc | null {
  const file = FILES.get(slug);
  if (!file) return null;
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const { html, headings } = renderMarkdown(text, (href) => resolveDocLink(href, path.posix.dirname(file), locale));
  const title = headings.find((h) => h.depth === 1)?.text || slug || "HakiOS";
  return { slug, title, html, headings, source: `docs/${file}` };
}

/* where a link of a synced page goes: another page of the site, or a file of the repository on GitHub */
function resolveDocLink(href: string, dir: string, locale: string): { to: string; external: boolean } {
  const [p, hash] = href.split("#");
  const resolved = path.posix.normalize(path.posix.join(dir, p));
  if (resolved.startsWith("../")) return { to: `${REPO_FILES}${resolved.replace(/^(\.\.\/)+/, "")}${hash ? `#${hash}` : ""}`, external: true };
  if (resolved.endsWith(".md") || FILES.has(resolved.replace(/\/$/, ""))) {
    const s = slugOf(resolved);
    return { to: `/${locale}/docs${s ? `/${s}` : ""}${hash ? `#${hash}` : ""}`, external: false };
  }
  return { to: `${REPO_FILES}docs/${resolved}`, external: true };
}

/* Markdown to HTML with GitHub's heading anchors; `link` decides where a relative link goes. Shared by the synced
   documentation and the site's own guide. */
export function renderMarkdown(
  source: string,
  link: (href: string) => { to: string; external: boolean },
): { html: string; headings: Heading[] } {
  const text = source.replace(/<!--[\s\S]*?-->\n*/g, "");
  const headings: Heading[] = [];
  const seen = new Map<string, number>();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { tokens, depth }: Tokens.Heading) {
        const raw = plain(tokens as Tokens.Generic[]);
        let id = anchor(raw);
        const n = seen.get(id) || 0;
        seen.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        headings.push({ depth, text: raw, id });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${this.parser.parseInline(tokens as Tokens.Generic[])}</h${depth}>\n`;
      },
      link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens as Tokens.Generic[]);
        let to = href;
        let external = /^[a-z]+:/i.test(href);
        if (!external && !href.startsWith("#")) ({ to, external } = link(href));
        const t = title ? ` title="${title}"` : "";
        return `<a href="${to}"${t}${external ? ' target="_blank" rel="noopener"' : ""}>${inner}</a>`;
      },
    },
  });
  const html = (marked.parse(text, { async: false }) as string)
    .replace(/<table>/g, '<div class="table"><table>')               // wide tables scroll inside their own box on a phone
    .replace(/<\/table>/g, "</table></div>");
  return { html, headings };
}

/* the page before and after this one in the table of contents */
export function neighbours(slug: string): { prev?: { title: string; slug: string }; next?: { title: string; slug: string } } {
  const flat = NAV.flatMap((s) => s.items);
  const i = flat.findIndex((x) => x.slug === slug);
  if (i < 0) return {};
  return { prev: flat[i - 1], next: flat[i + 1] };
}
