import express from 'express';
import { chromium } from 'playwright';
import dns from 'node:dns/promises';
import net from 'node:net';

const app = express();
app.disable('x-powered-by');
const PORT = Number(process.env.PORT || 3000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://4shockauth.shop';
const SEARCH_TIMEOUT = 18000;

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.sendStatus(204);
  }
  next();
});

let browserPromise;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
      .then(browser => {
        browser.on('disconnected', () => { browserPromise = undefined; });
        return browser;
      }).catch(error => { browserPromise = undefined; throw error; });
  }
  return browserPromise;
}

// Reject internal and private destinations before Chromium visits any URL.
function publicIP(ip) {
  if (net.isIP(ip) === 4) {
    const n = ip.split('.').map(Number);
    return !(n[0] === 0 || n[0] === 10 || n[0] === 127 || n[0] >= 224 ||
      (n[0] === 169 && n[1] === 254) || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) ||
      (n[0] === 192 && n[1] === 168) || (n[0] === 100 && n[1] >= 64 && n[1] <= 127) ||
      (n[0] === 192 && n[1] === 0) || (n[0] === 198 && (n[1] === 18 || n[1] === 19)) ||
      (n[0] === 192 && n[1] === 0 && n[2] === 2) ||
      (n[0] === 198 && n[1] === 51 && n[2] === 100) ||
      (n[0] === 203 && n[1] === 0 && n[2] === 113));
  }
  if (net.isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower.startsWith('::ffff:')) return publicIP(lower.slice(7));
    return !(lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') ||
      /^fe[89ab]/.test(lower) || lower.startsWith('ff') || lower.startsWith('2001:db8:'));
  }
  return false;
}
async function validateURL(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) throw new Error('Invalid public URL');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
      url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) throw new Error('Private host');
  const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicIP(address))) throw new Error('Private address');
  return url.href;
}

async function withPage(task) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block',
    acceptDownloads: false
  });
  const page = await context.newPage();
  page.setDefaultTimeout(SEARCH_TIMEOUT);
  await page.route('**/*', async route => {
    try {
      const request = route.request();
      if (!['http:', 'https:'].includes(new URL(request.url()).protocol)) return route.abort();
      await validateURL(request.url());
      if (['image', 'media', 'font', 'websocket'].includes(request.resourceType())) return route.abort();
      await route.continue();
    } catch { await route.abort().catch(() => {}); }
  });
  try { return await task(page); }
  finally { await context.close(); }
}

app.get('/', (_req, res) => res.json({ name: '4SHOCK Chromium Search', status: 'online', endpoints: ['/health', '/api/search?q=hello', '/api/browse?url=https://example.com'] }));
app.get('/health', async (_req, res) => {
  try { const browser = await getBrowser(); res.json({ ok: true, chromium: browser.isConnected() }); }
  catch { res.status(503).json({ ok: false, chromium: false }); }
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: 'Missing q' });
  try {
    const results = await withPage(async page => {
      await page.goto('https://www.google.com/search?q=' + encodeURIComponent(q), { waitUntil: 'domcontentloaded', timeout: SEARCH_TIMEOUT });
      return await page.evaluate(() => {
        const entries = [];
        for (const h of document.querySelectorAll('h3')) {
          const a = h.closest('a');
          if (!a || !a.href || !h.textContent.trim()) continue;
          let url;
          try { url = new URL(a.href); } catch { continue; }
          if (!['https:', 'http:'].includes(url.protocol) || url.hostname.includes('google.com')) continue;
          const block = h.closest('div.MjjYud') || h.parentElement?.parentElement?.parentElement;
          const snippet = (block?.innerText || '').replace(/\s+/g, ' ').slice(0, 450);
          if (!entries.some(x => x.url === url.href)) entries.push({ title: h.textContent.trim(), url: url.href, link: url.href, snippet });
          if (entries.length >= 10) break;
        }
        return entries;
      });
    });
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ query: q, results, count: results.length, source: 'chromium-google' });
  } catch (error) {
    console.error('Search failed:', error.message);
    res.status(502).json({ error: 'Search unavailable', details: 'Chromium could not retrieve results' });
  }
});

// Metadata browsing, not an interactive embedded browser or HTML proxy.
app.get('/api/browse', async (req, res) => {
  try {
    const url = await validateURL(String(req.query.url || ''));
    const result = await withPage(async page => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SEARCH_TIMEOUT });
      return { title: await page.title(), url: page.url() };
    });
    res.json(result);
  } catch (error) {
    console.error('Browse failed:', error.message);
    res.status(400).json({ error: 'Unable to browse this URL' });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`4SHOCK Chromium server listening on ${PORT}`));
