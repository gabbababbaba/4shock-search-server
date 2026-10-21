import express from 'express';
import * as cheerio from 'cheerio';

const app = express();
app.disable('x-powered-by');
const PORT = Number(process.env.PORT || 3000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://4shockauth.shop';

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers.origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  next();
});

const lastRequests = new Map();
app.get('/health', (req, res) => res.json({ status: 'ok', service: '4SHOCK Search' }));

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length > 180) return res.status(400).json({ error: 'Search must be 1–180 characters.' });
  const ip = req.ip;
  const now = Date.now();
  const record = lastRequests.get(ip) || { time: now, count: 0 };
  if (now - record.time > 60000) { record.time = now; record.count = 0; }
  record.count++;
  lastRequests.set(ip, record);
  if (record.count > 25) return res.status(429).json({ error: 'Too many searches. Try again shortly.' });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const target = new URL('https://html.duckduckgo.com/html/');
    target.searchParams.set('q', q);
    const response = await fetch(target, {
      signal: controller.signal,
      headers: {
        'Accept': 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; 4SHOCKSearch/1.0)'
      }
    });
    if (!response.ok) throw new Error(`Search provider returned HTTP ${response.status}`);
    const html = await response.text();
    const $ = cheerio.load(html);
    const results = [];
    $('.result').each((_, element) => {
      const link = $(element).find('.result__a').first();
      let href = link.attr('href') || '';
      try {
        const parsed = new URL(href, 'https://duckduckgo.com');
        if (parsed.hostname.endsWith('duckduckgo.com') && parsed.searchParams.has('uddg')) {
          href = parsed.searchParams.get('uddg');
        } else href = parsed.href;
        const destination = new URL(href);
        if (!['http:', 'https:'].includes(destination.protocol)) return;
        href = destination.href;
      } catch { return; }
      const title = link.text().trim();
      const snippet = $(element).find('.result__snippet').first().text().trim();
      if (title && href) results.push({ title, url: href, description: snippet });
    });
    if (!results.length) return res.status(502).json({ error: 'DuckDuckGo returned no parseable results. It may be blocking automated searches.' });
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json({ query: q, results: results.slice(0, 20) });
  } catch (e) {
    return res.status(502).json({ error: 'Search provider unavailable. Try again later.', detail: String(e.message || e) });
  } finally { clearTimeout(timeout); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`4SHOCK search listening on ${PORT}`));
