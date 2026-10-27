import { TELEGRAM } from "./site";

// Reads the public subscriber count from the channel's t.me page.
// Cached by Next for 30 minutes, so t.me is hit at most twice an hour.
export async function getTelegramSubscribers(): Promise<number> {
  try {
    const res = await fetch(TELEGRAM.url, {
      next: { revalidate: 1800 },
      headers: { "user-agent": "Mozilla/5.0 (compatible; HakiOSBot/1.0)" },
    });
    if (!res.ok) return TELEGRAM.fallbackSubscribers;
    const html = await res.text();
    // e.g. <div class="tgme_page_extra">16 305 subscribers</div>
    const m = html.match(/tgme_page_extra[^>]*>\s*([\d\s .,]+)\s*(subscribers|members)/i);
    if (!m) return TELEGRAM.fallbackSubscribers;
    const n = parseInt(m[1].replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) && n > 0 ? n : TELEGRAM.fallbackSubscribers;
  } catch {
    return TELEGRAM.fallbackSubscribers;
  }
}
