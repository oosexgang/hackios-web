import { notFound } from "next/navigation";
import CopyButton from "@/components/CopyButton";
import { isLocale, type Locale } from "@/lib/locales";
import { getDict } from "@/lib/dict";
import { TELEGRAM, TEAM, TOKEN, PRESS, CONTACT_HANDLE, REPOS } from "@/lib/site";

const QUICK = `git clone https://github.com/oosexgang/hakios-xnu-kernel.git hakios
cd hakios
make doctor          # what this machine lacks, and what to do
make qemu-open       # the open kernel in QEMU: nothing of Apple's, nothing of a phone's`;

// The boot chain and the Metal path, as the guide's "How it works" and "Metal" pages tell them. `theirs` is what the
// user brings: the phone's own boot loader, and the user space from their own restore image.
// The captions under each step are translated (d.chain_s, d.metal_s).
const CHAIN: { b: string; theirs?: boolean }[] = [
  { b: "fastboot", theirs: true },
  { b: "HakiOS UEFI · U-Boot" },
  { b: "xnuloader" },
  { b: "XNU + drivers" },
  { b: "launchd" },
  { b: "Darwin user space", theirs: true },
];
const METAL = ["MTLCommandBuffer", "HakiosMetal.bundle", "hakios-metal", "HakiosGPU", "Adreno 642L"];

/* "yes" and its translations read as working, "no" as not there, anything else as partly */
function tone(v: string): string {
  if (/^(yes|да|так|可用)/i.test(v)) return "ok";
  if (/^(no|нет|ні|不可用)$/i.test(v)) return "no";
  return "part";
}

function Badge() {
  return (
    <svg className="badge" viewBox="0 0 120 120" aria-hidden="true">
      <defs>
        <path id="ring" d="M60 60 m-46 0 a46 46 0 1 1 92 0 a46 46 0 1 1 -92 0" />
      </defs>
      <text fontFamily="var(--mono)" fontWeight="700" fontSize="9.6" letterSpacing="2.6" fill="currentColor">
        <textPath href="#ring">OPEN SOURCE · XNU · METAL · HAKIOS · </textPath>
      </text>
      <circle cx="60" cy="60" r="30" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="60" cy="60" r="7" fill="#e8170f" />
    </svg>
  );
}

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale as Locale);
  const L = `/${locale}`;
  const ticker = "CP_MEMCPY · 0x70460004 · CP_MEM_WRITE · xnu-8796.121.2 · gpu=1 · touchscreen=1 · launchd · HakiosGPU · fence 40/40 · 16 MB / 182 ms · ";

  return (
    <main className="home">
      <div className="wide">
        <section className="poster" aria-labelledby="hakios-title">
          <span className="stamp">XNU · ANDROID · QEMU</span>
          <p className="poster-meta"><span>hakios / 04</span><span>{d.hero_kicker}</span><span>Adreno · Snapdragon 778G</span></p>
          <h1 className="title" id="hakios-title">hakios<span className="dot" aria-hidden="true" /></h1>
          <p className="lead">{d.hero_sub}</p>
          <p className="links">
            <a className="btn" href={`${L}/guide`}>{d.cta_start} →</a>
            <a className="btn ghost" href={`${L}/guide/your-device`}>{d.cta_port}</a>
            <a href={`${L}/docs`}>{d.cta_docs}</a>
          </p>
          <p className="meta">{d.hero_meta.join(" · ")}</p>
          <Badge />
        </section>
      </div>
      <div className="ticker" aria-hidden="true"><span>{ticker.repeat(6)}</span></div>

      <div className="wide">
        <section id="paths">
          <p className="cap">01 · {d.nav.docs}</p>
          <h2>{d.home_paths_t}</h2>
          <p className="sub">{d.home_paths_p}</p>
          <nav className="paths">
            {d.paths.map(([t, p, slug], i) => (
              <a key={slug} href={`${L}/guide/${slug}`}>
                <span className="n">0{i + 1}</span>
                <strong>{t}</strong>
                <p>{p}</p>
                <span className="go">→</span>
              </a>
            ))}
          </nav>
        </section>

        <section id="how">
          <p className="cap">02 · boot</p>
          <h2>{d.how_t}</h2>
          <p className="sub">{d.how_p}</p>
          <ol className="chain ours" style={{ ["--n" as string]: CHAIN.length }}>
            {CHAIN.map((c, i) => (
              <li key={c.b} className={c.theirs ? "theirs" : undefined}><b>{c.b}</b><span>{d.chain_s[i]}</span></li>
            ))}
          </ol>
          <p className="legend"><span><i />{d.legend[0]}</span><span><i className="t" />{d.legend[1]}</span></p>
          <p><a href={`${L}/guide/how-it-works`}>{d.how_more} →</a></p>
        </section>

        <section id="metal">
          <p className="cap">03 · metal</p>
          <h2>{d.metal_t}</h2>
          <p className="sub">{d.metal_p}</p>
          <ol className="chain" style={{ ["--n" as string]: METAL.length }}>
            {METAL.map((b, i) => <li key={b}><b>{b}</b><span>{d.metal_s[i]}</span></li>)}
          </ol>
          <p><a href={`${L}/guide/metal`}>{d.metal_more} →</a></p>
        </section>

        <section id="status">
          <p className="cap">04 · status</p>
          <h2>{d.status_t}</h2>
          <p className="sub">{d.status_p}</p>
          <div className="table">
            <table className="status">
              <thead><tr>{d.status_cols.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
              <tbody>
                {d.status_rows.map((r, i) => (
                  <tr key={i}><td>{r[0]}</td>{r.slice(1).map((v, j) => <td key={j}><span className={`st ${tone(v)}`}>{v}</span></td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <p><a href={`${L}/docs/devices`}>{d.status_more} →</a></p>
        </section>

        <section id="layers">
          <p className="cap">05 · layers</p>
          <h2>{d.layers_t}</h2>
          <ol className="layers">
            {d.layers.map((x, i) => <li key={i}><strong>{x[0]}</strong> <span>{x[1]}</span></li>)}
          </ol>
          <p className="note"><strong>{d.safe_t}.</strong> {d.safe_p}</p>
        </section>

        <section id="start">
          <p className="cap">06 · try</p>
          <h2>{d.start_t}</h2>
          <p className="sub">{d.start_p}</p>
          <pre className="code"><code>{QUICK.split("\n").map((line, i) => {
            const at = line.indexOf("#");
            return <span key={i}>{at < 0 ? line : <>{line.slice(0, at)}<span className="c">{line.slice(at)}</span></>}{"\n"}</span>;
          })}</code></pre>
          <p style={{ marginTop: 22 }}><a href={`${L}/guide/qemu`}>{d.cta_start} →</a></p>
        </section>

        <section id="repos">
          <p className="cap">07 · code</p>
          <h2>{d.repos_t}</h2>
          <p className="sub">{d.repos_p}</p>
          <ul className="rows">
            {REPOS.map((r) => (
              <li key={r.name}><a href={r.url} target="_blank" rel="noopener"><code>{r.name}</code></a><span>{d.repo_desc[r.key]}</span></li>
            ))}
          </ul>
        </section>

        <section id="team">
          <p className="cap">08 · people</p>
          <h2>{d.team_t}</h2>
          <ul className="rows">
            {TEAM.map((m) => (
              <li key={m.handle}>
                <a href={`https://t.me/${m.handle}`} target="_blank" rel="noopener">@{m.handle}</a>
                <span>{m.role === "founder" ? d.founder : m.role === "ceo" ? d.ceo : d.teammate}</span>
              </li>
            ))}
            <li><a href={`https://t.me/${CONTACT_HANDLE}`} target="_blank" rel="noopener">@{CONTACT_HANDLE}</a><span>{d.coop_l}</span></li>
            <li><a href={TELEGRAM.url} target="_blank" rel="noopener">t.me/{TELEGRAM.channel}</a><span>Telegram</span></li>
          </ul>
        </section>

        <section id="press">
          <p className="cap">09 · press</p>
          <h2>{d.press_t}</h2>
          <p className="sub">{d.press_p}</p>
          <p className="press">
            {PRESS.map((p) => <a key={p.file} href={`/press/${p.file}`} download>{d.press_items[p.key]}</a>)}
          </p>
        </section>

        {/* the token is the community's, not the project's: last on the page, closed until asked for */}
        <details className="token" id="token">
          <summary>{d.token_t}</summary>
          <p>{d.token_p}</p>
          <dl className="spec">
            <dt>{d.sp.net}</dt><dd>{TOKEN.network}</dd>
            <dt>{d.sp.tick}</dt><dd>{TOKEN.ticker}</dd>
            <dt>{d.sp.sup}</dt><dd>{TOKEN.supply}</dd>
            <dt>{d.sp.addr}</dt><dd className="addr"><code>{TOKEN.contract}</code> <CopyButton value={TOKEN.contract} label={d.copy} done={d.copied} /></dd>
            <dt>{d.sp.plat}</dt><dd><a href={TOKEN.url} target="_blank" rel="noopener">{TOKEN.platform}</a></dd>
          </dl>
          <p className="small">{d.risk}</p>
        </details>
      </div>
    </main>
  );
}
