import { notFound } from "next/navigation";
import CopyButton from "@/components/CopyButton";
import { Emblem } from "@/components/Logo";
import { isLocale, type Locale } from "@/lib/locales";
import { getDict } from "@/lib/dict";
import { getTelegramSubscribers } from "@/lib/telegram";
import { TELEGRAM, TEAM, TOKEN, PRESS, CONTACT_HANDLE, REPOS } from "@/lib/site";

export const revalidate = 1800;

const QUICK = `git clone https://github.com/shimoku74/hakios.git
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
  const subs = await getTelegramSubscribers();
  const nf = new Intl.NumberFormat(locale === "zh" ? "zh-CN" : locale);
  const L = `/${locale}`;

  return (
    <main>
      <section className="hero">
        <div className="wrap hero-in">
          <div className="hero-copy">
            <p className="kicker">{d.hero_kicker}</p>
            <h1>HakiOS</h1>
            <p className="lead">{d.hero_sub}</p>
            <div className="ctas">
              <a className="btn" href={`${L}/docs/getting-started`}>{d.cta_start}</a>
              <a className="btn ghost" href={`${L}/docs`}>{d.cta_docs}</a>
              <a className="btn ghost" href={`${L}/docs/porting`}>{d.cta_port}</a>
            </div>
            <p className="meta">{d.hero_meta.join("  /  ")}  /  <a href={TELEGRAM.url} target="_blank" rel="noopener">{d.live.replace("{n}", nf.format(subs))}</a></p>
          </div>
          <div className="hero-mark" aria-hidden="true"><Emblem size={220} /></div>
        </div>
      </section>

      <section className="wrap sec" id="status">
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
        <p><a className="more" href={`${L}/docs/devices`}>{d.status_more}</a></p>
      </section>

      <section className="wrap sec" id="layers">
        <h2>{d.layers_t}</h2>
        <div className="cards three">
          {d.layers.map((x, i) => (
            <article className="card" key={i}><span className="num">{i + 1}</span><h3>{x[0]}</h3><p>{x[1]}</p></article>
          ))}
        </div>
        <div className="note"><h3>{d.safe_t}</h3><p>{d.safe_p}</p></div>
      </section>

      <section className="wrap sec" id="start">
        <h2>{d.start_t}</h2>
        <p className="sub">{d.start_p}</p>
        <pre className="code"><code>{QUICK}</code></pre>
        <p><a className="more" href={`${L}/docs/getting-started`}>{d.cta_start}</a></p>
      </section>

      <section className="wrap sec" id="repos">
        <h2>{d.repos_t}</h2>
        <p className="sub">{d.repos_p}</p>
        <ul className="repos">
          {REPOS.map((r) => (
            <li key={r.name}><a href={r.url} target="_blank" rel="noopener"><code>{r.name}</code></a><span>{d.repo_desc[r.key]}</span></li>
          ))}
        </ul>
        <p><a className="more" href={`${L}/docs/porting/repositories`}>{d.cta_port}</a></p>
      </section>

      <section className="wrap sec" id="team">
        <h2>{d.team_t}</h2>
        <p className="sub">{d.team_p}</p>
        <ul className="team">
          {TEAM.map((m) => (
            <li key={m.handle}>
              <a href={`https://t.me/${m.handle}`} target="_blank" rel="noopener">@{m.handle}</a>
              <span>{m.role === "founder" ? d.founder : m.role === "ceo" ? d.ceo : d.teammate}</span>
            </li>
          ))}
        </ul>
        <p className="small">{d.coop_l}: <a href={`https://t.me/${CONTACT_HANDLE}`} target="_blank" rel="noopener">@{CONTACT_HANDLE}</a></p>
      </section>

      <section className="wrap sec" id="press">
        <h2>{d.press_t}</h2>
        <p className="sub">{d.press_p}</p>
        <div className="press">
          {PRESS.map((p) => (
            <a className="asset" key={p.file} href={`/press/${p.file}`} download>
              <img src={`/press/${p.file}`} alt={d.press_items[p.key]} loading="lazy" />
              <span>{d.press_items[p.key]}</span><small>{p.size} PNG, {d.press_dl}</small>
            </a>
          ))}
        </div>
      </section>

      <section className="wrap sec" id="token">
        <h2>{d.token_t}</h2>
        <p className="sub">{d.token_p}</p>
        <dl className="spec">
          <dt>{d.sp.net}</dt><dd>{TOKEN.network}</dd>
          <dt>{d.sp.plat}</dt><dd><a href={TOKEN.url} target="_blank" rel="noopener">{TOKEN.platform}</a></dd>
          <dt>{d.sp.tick}</dt><dd>{TOKEN.ticker}</dd>
          <dt>{d.sp.sup}</dt><dd>{TOKEN.supply}</dd>
          <dt>{d.sp.addr}</dt><dd className="addr"><code>{TOKEN.contract}</code> <CopyButton value={TOKEN.contract} label={d.copy} done={d.copied} /></dd>
        </dl>
        <p className="small">{d.risk}</p>
      </section>
    </main>
  );
}
