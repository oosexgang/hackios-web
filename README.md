# HakiOS website

The project's site: what HakiOS is and what works, the documentation, and the FAQ, in English, Russian, Ukrainian and Chinese.
Next.js 15 (App Router, TypeScript), rendered to static pages at build time.

| Page | What |
|---|---|
| `/<lang>` | the project, the status of each device, how it fits together, the repositories, the team, the press kit; the community token last, folded |
| `/<lang>/guide/...` | the guide: start here, how it works, QEMU, the phone, Metal, adapting to your device, troubleshooting. Written for people, kept in this repository |
| `/<lang>/docs/...` | the documentation of the [hakios-xnu-kernel](https://github.com/oosexgang/hakios-xnu-kernel/tree/hakios) repository, with a table of contents |
| `/<lang>/faq` | the questions people ask, answered short |

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
npm run build && node .next/standalone/server.js     # production (output: standalone)
```

## The guide

`content/guide/<lang>/*.md` is the site's own documentation: what a person needs, in order, with the commands to copy. English and
Russian today; a page missing in a language is shown in English with a note. The order of its pages and their titles in every
language are `lib/guide.ts`. A link inside a guide page is either another guide page (`metal.md`) or a page of the reference
(`/docs/boot-args`); both get the reader's language. `npm run docs` never touches it.

Every page has a copy button on its code blocks (`components/ProseTools.tsx`) and the header has a search over the guide and the
reference (`components/Search.tsx`, Ctrl+K or /), which loads `/<lang>/search.json`, built with the site.

## The reference

The pages are the hakios repository's `docs/`, copied into `content/docs/`:

```bash
npm run docs                     # from ../hakios
npm run docs -- /path/to/hakios
```

The copy is committed, so that the site builds without the hakios repository beside it. Links between pages become links between
the site's pages, a link to a file of the repository goes to GitHub, and headings get the anchors GitHub gives them: a link that
works in the repository works here (the hakios repository's `tools/docs-check.py` checks them). The order of the sidebar is
`lib/docs-nav.ts`.

## Where to change things

| What | File |
|---|---|
| texts in four languages, the FAQ, the status table | `lib/dict.ts` |
| GitHub link, Telegram, team, repositories, token, press kit | `lib/site.ts` (or `NEXT_PUBLIC_GITHUB_URL`, `NEXT_PUBLIC_SITE_URL`) |
| the guide's pages and titles | `lib/guide.ts`, `content/guide/<lang>/` |
| the reference's sidebar | `lib/docs-nav.ts` |
| styles: khaki paper, olive ink, the red dot (light and dark) | `app/globals.css` |
| the logo | `components/Logo.tsx` (the mark: a lowercase h and a red dot; the wordmark: hakios and the dot); `public/press/hakios-mark.svg`, `hakios-logo.svg` |
| icons, share image | `app/[locale]/icon.svg`, `apple-icon.tsx`, `opengraph-image.tsx`; the PNG icons: `npm run brand` (`scripts/brand.py`) |

Copy `.env.example` to `.env.local` for local values. The Docker image (`Dockerfile`) runs the standalone server.
