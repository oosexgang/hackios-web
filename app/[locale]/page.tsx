import { notFound } from "next/navigation";
import CopyButton from "@/components/CopyButton";
import { isLocale, type Locale } from "@/lib/locales";
import { getDict } from "@/lib/dict";
import { TELEGRAM, TEAM, TOKEN, PRESS, CONTACT_HANDLE, REPOS } from "@/lib/site";

const QUICK = `git clone https://github.com/oosexgang/hakios.git
cd hakios
make doctor          # what this machine lacks, and what to do
make qemu-open       # the open kernel in QEMU: nothing of Apple's, nothing of a phone's`;

/* "yes" and its translations read as working, "no" as not there, anything else as partly */
function tone(v: string): string {
  if (/^(yes|да|так|可用)/i.test(v)) return "ok";
  if (/^(no|нет|ні|不可用)$/i.test(v)) return "no";
  return "part";
}

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale as Locale);
  const L = `/${locale}`;

  return (
    <main className="home wrap">
      <section className="hero">
        <p className="kicker">{d.hero_kicker}</p>
        <h1 className="title">hakios<span className="dot" aria-hidden="true" /></h1>
        <p className="lead">{d.hero_sub}</p>
        <p className="links">
          <a className="btn" href={`${L}/docs/getting-started`}>{d.cta_start}</a>
          <a href={`${L}/docs`}>{d.cta_docs}</a>
          <a href={`${L}/docs/porting`}>{d.cta_port}</a>
        </p>
        <p className="meta">{d.hero_meta.join(" · ")}</p>
      </section>

      <section id="status">
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
        <p><a href={`${L}/docs/devices`}>{d.status_more}</a></p>
      </section>

      <section id="layers">
        <h2>{d.layers_t}</h2>
        <ol className="layers">
          {d.layers.map((x, i) => <li key={i}><strong>{x[0]}</strong> {x[1]}</li>)}
        </ol>
        <p className="note"><strong>{d.safe_t}.</strong> {d.safe_p}</p>
      </section>

      <section id="start">
        <h2>{d.start_t}</h2>
        <p className="sub">{d.start_p}</p>
        <pre className="code"><code>{QUICK}</code></pre>
      </section>

      <section id="repos">
        <h2>{d.repos_t}</h2>
        <p className="sub">{d.repos_p}</p>
        <ul className="rows">
          {REPOS.map((r) => (
            <li key={r.name}><a href={r.url} target="_blank" rel="noopener"><code>{r.name}</code></a><span>{d.repo_desc[r.key]}</span></li>
          ))}
        </ul>
      </section>

      <section id="team">
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
    </main>
  );
}
