import express from 'express';
import { chromium } from 'playwright';
import dns from 'node:dns/promises';
import net from 'node:net';

const app = express();
app.disable('x-powered-by');
const PORT = Number(process.env.PORT || 3000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Block access to localhost, private networks and metadata endpoints.
function publicIP(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const a = ip.split('.').map(Number);
    return !(a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224 ||
      (a[0] === 169 && a[1] === 254) || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
      (a[0] === 192 && a[1] === 168) || (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
      (a[0] === 192 && a[1] === 0) || (a[0] === 198 && (a[1] === 18 || a[1] === 19)));
  }
  if (version === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return publicIP(v.slice(7));
    return !(v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') ||
      /^fe[89ab]/.test(v) || v.startsWith('2001:db8:'));
  }
  return false;
}
async function validateUrl(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP(S) URLs are allowed');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) throw new Error('Local addresses are blocked');
  const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicIP(address))) throw new Error('Private or unsafe address blocked');
  return url.href;
}

let browserPromise;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    browserPromise.catch(() => { browserPromise = undefined; });
  }
  return browserPromise;
}
async function withPage(task) {
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
  // Re-check every request, including redirects and subresources, before it reaches the network.
  await context.route('**/*', async route => {
    try { await validateUrl(route.request().url()); await route.continue(); }
    catch { await route.abort(); }
  });
  try {
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(20000);
    return await task(page);
  } finally { await context.close(); }
}

app.get('/', (req, res) => res.json({ status: 'ok', service: '4SHOCK Search', endpoints: ['/health', '/api/search?q=example', '/api/browse?url=https://example.com'] }));
app.get('/health', async (req, res) => {
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try { await page.goto('about:blank'); }
    finally { await page.close(); }
    res.json({ status: 'ok', service: '4SHOCK Search', chromium: true });
  } catch (error) {
    res.status(503).json({ status: 'error', chromium: false, error: String(error.message).slice(0, 400) });
  }
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: 'Missing q parameter', results: [] });
  try {
    const results = await withPage(async page => {
      await page.goto('https://www.google.com/search?q=' + encodeURIComponent(q), { waitUntil: 'domcontentloaded' });
      return page.evaluate(() => {
        const seen = new Set();
        return [...document.querySelectorAll('a:has(h3)')].map(a => {
          const h = a.querySelector('h3');
          const url = a.href;
          const description = a.closest('div.MjjYud, div.g')?.innerText || a.parentElement?.innerText || '';
          return { title: h?.innerText?.trim() || '', url, snippet: description.replace(h?.innerText || '', '').trim().slice(0, 350) };
        }).filter(x => x.title && /^https?:\/\//.test(x.url) && !seen.has(x.url) && seen.add(x.url)).slice(0, 10);
      });
    });
    res.json({ query: q, results, source: 'Google', note: results.length ? undefined : 'Search provider returned no extractable results; it may be blocking automated browsing.' });
  } catch (error) { res.status(502).json({ error: 'Search unavailable', detail: String(error.message).slice(0, 200), results: [] }); }
});

app.get('/api/browse', async (req, res) => {
  try {
    const url = await validateUrl(String(req.query.url || ''));
    const result = await withPage(async page => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return { title: await page.title(), url: page.url(), description: await page.locator('meta[name="description"]').first().getAttribute('content').catch(() => null) };
    });
    res.json(result);
  } catch (error) { res.status(400).json({ error: 'Unable to browse URL', detail: String(error.message).slice(0, 200) }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`4SHOCK server listening on port ${PORT}`));
