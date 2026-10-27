// Copy the documentation from the hakios repository into content/docs, where the site reads it.
//   npm run docs                    from ../hakios (next to this repository)
//   npm run docs -- /path/to/hakios
// The copy is committed, so that the site builds without the hakios repository beside it.
import fs from "node:fs";
import path from "node:path";

const from = path.resolve(process.argv[2] || "../hakios", "docs");
const to = path.resolve("content", "docs");
if (!fs.existsSync(path.join(from, "index.md"))) {
  console.error(`sync-docs: no ${from}/index.md: give the hakios repository's path (npm run docs -- /path/to/hakios)`);
  process.exit(1);
}
fs.rmSync(to, { recursive: true, force: true });
let n = 0;
const copy = (a, b) => {
  for (const e of fs.readdirSync(a, { withFileTypes: true })) {
    const s = path.join(a, e.name), d = path.join(b, e.name);
    if (e.isDirectory()) copy(s, d);
    else if (e.name.endsWith(".md")) { fs.mkdirSync(b, { recursive: true }); fs.copyFileSync(s, d); n++; }
  }
};
copy(from, to);
console.log(`sync-docs: ${n} pages from ${from}`);
