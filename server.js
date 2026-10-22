
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

function isPublicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c, d] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0)) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }

  if (net.isIP(address) === 6) {
    const x = address.toLowerCase();
    if (x.startsWith('::ffff:')) {
      return isPublicAddress(x.slice(7));
    }

    return x !== '::' &&
      x !== '::1' &&
      !x.startsWith('fc') &&
      !x.startsWith('fd') &&
      !/^fe[89ab]/.test(x) &&
      !x.startsWith('2001:db8:') &&
      !x.startsWith('2001:') &&
      !x.startsWith('64:ff9b:');
  }

  return false;
}

async function validateUrl(input) {
  const url = new URL(input);

  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error('Only public HTTP(S) URLs are supported');
  }

  if (
    (url.port && !['80', '443'].includes(url.port)) ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    url.hostname.endsWith('.local') ||
    url.hostname.endsWith('.internal')
  ) {
    throw new Error('Local or custom-port destinations are blocked');
  }

  const addresses = net.isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.lookup(url.hostname, { all: true });

  if (
    !addresses.length ||
    addresses.some(x => !isPublicAddress(x.address))
  ) {
    throw new Error('Destination is not a public address');
  }

  return url.href;
}

let browserPromise;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      timeout: 15000,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage'
      ]
    }).then(browser => {
      browser.on('disconnected', () => {
        browserPromise = undefined;
      });
      return browser;
    }).catch(error => {
      browserPromise = undefined;
      throw error;
    });
  }

  return browserPromise;
}

async function visit(inputUrl, extract) {
  const url = await validateUrl(inputUrl);
  const browser = await getBrowser();

  const context = await browser.newContext({
    javaScriptEnabled: false,
    serviceWorkers: 'block'
  });

  try {
    await context.route('**/*', async route => {
      const request = route.request();

      if (
        request.resourceType() !== 'document' ||
        !request.isNavigationRequest() ||
        request.frame() !== request.frame().page().mainFrame()
      ) {
        return route.abort().catch(() => {});
      }

      try {
        await validateUrl(request.url());
        await route.continue();
      } catch {
        await route.abort().catch(() => {});
      }
    });

    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 12000
    });

    return await extract(page);
  } finally {
    await context.close().catch(() => {});
  }
}

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: '4SHOCK Search',
    endpoints: [
      '/health',
      '/api/search?q=example',
      '/api/browse?url=https://example.com'
    ]
  });
});

app.get('/health', async (_req, res) => {
  try {
    const browser = await getBrowser();

    res.json({
      status: 'ok',
      service: '4SHOCK Search',
      chromium: browser.isConnected()
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      chromium: false,
      detail: error.message
    });
  }
});

app.get('/api/browse', async (req, res) => {
  const input = String(req.query.url || '');

  if (!input) {
    return res.status(400).json({
      error: 'Missing url parameter'
    });
  }

  try {
    const result = await visit(input, async page => ({
      url: page.url(),
      title: await page.title(),
      description: await page
        .locator('meta[name="description"]')
        .first()
        .getAttribute('content', { timeout: 1500 })
        .catch(() => null)
    }));

    res.json(result);
  } catch (error) {
    console.error('BROWSE ERROR:', error.message);

    res.status(502).json({
      error: 'Unable to browse URL',
      detail: error.message.slice(0, 300)
    });
  }
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '')
    .trim()
    .slice(0, 200);

  if (!q) {
    return res.status(400).json({
      error: 'Missing q parameter',
      results: []
    });
  }

  try {
    const results = await visit(
      'https://www.google.com/search?q=' +
        encodeURIComponent(q),
      page => page.evaluate(() => {
        const seen = new Set();

        return [
          ...document.querySelectorAll('a:has(h3)')
        ].map(a => ({
          title:
            a.querySelector('h3')?.textContent?.trim() || '',
          url: a.href,
          snippet:
            a.parentElement?.textContent
              ?.trim()
              .slice(0, 250) || ''
        })).filter(x =>
          x.title &&
          /^https?:\/\//.test(x.url) &&
          !seen.has(x.url) &&
          seen.add(x.url)
        ).slice(0, 10);
      })
    );

    res.json({
      query: q,
      results,
      source: 'Google'
    });
  } catch (error) {
    console.error('SEARCH ERROR:', error.message);

    res.status(502).json({
      error: 'Search unavailable',
      detail: error.message.slice(0, 300),
      results: []
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`4SHOCK listening on ${PORT}`);
});
