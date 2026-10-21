import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
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


const MAX_HTML = 2 * 1024 * 1024;
const MAX_ASSET = 5 * 1024 * 1024;
const MAX_REDIRECTS = 4;

function publicIP(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 || p[0] === 169 && p[1] === 254 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 192 && p[1] === 168 || p[0] === 100 && p[1] >= 64 && p[1] <= 127 || p[0] === 192 && p[1] === 0 || p[0] === 192 && p[1] === 0 && p[2] === 2 || p[0] === 198 && (p[1] === 18 || p[1] === 19 || p[1] === 51 && p[2] === 100) || p[0] === 203 && p[1] === 0 && p[2] === 113) return false;
    return true;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || /^fe[89ab]/.test(s) || s.startsWith('ff') || s.startsWith('2001:db8:') || s.startsWith('::ffff:')) return false;
    return true;
  }
  return false;
}

async function checkTarget(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('Invalid URL');
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80', '443'].includes(u.port))) throw new Error('Only public HTTP(S) websites on standard ports are supported');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || net.isIP(host)) throw new Error('Only public website hostnames are supported');
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(r => !r.address || !publicIP(r.address))) throw new Error('Private or reserved addresses are blocked');
  return { u, address: records[0].address, family: records[0].family };
}

async function fetchPublic(raw, limit, hops = 0) {
  if (hops > MAX_REDIRECTS) throw new Error('Too many redirects');
  const { u, address, family } = await checkTarget(raw);
  const transport = u.protocol === 'https:' ? https : http;
  return await new Promise((resolve, reject) => {
    const req = transport.request(u, {
      method: 'GET',
      lookup: (_hostname, options, cb) => {
        // Node's HTTP agent can request all resolved addresses. Return the matching shape.
        if (options && options.all) cb(null, [{ address, family }]);
        else cb(null, address, family);
      },
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; 4SHOCKBrowser/1.0)', 'accept': 'text/html,application/xhtml+xml,image/*,text/css,font/*;q=0.8,*/*;q=0.5', 'accept-encoding': 'identity' },
      timeout: 12000,
    }, resp => {
      const code = resp.statusCode || 0;
      if ([301,302,303,307,308].includes(code) && resp.headers.location) {
        const next = new URL(resp.headers.location, u).href;
        resp.resume();
        resolve(fetchPublic(next, limit, hops + 1));
        return;
      }
      if (code < 200 || code >= 300) { resp.resume(); reject(new Error('Website returned HTTP ' + code)); return; }
      const chunks = []; let size = 0;
      resp.on('data', chunk => { size += chunk.length; if (size > limit) { req.destroy(new Error('Page exceeds size limit')); return; } chunks.push(chunk); });
      resp.on('end', () => resolve({ url: u.href, body: Buffer.concat(chunks), type: String(resp.headers['content-type'] || 'application/octet-stream') }));
      resp.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Website timed out')));
    req.end();
  });
}

function absolute(raw, base) {
  try {
    if (!raw || /^(#|data:|blob:|javascript:|mailto:|tel:)/i.test(raw.trim())) return null;
    const u = new URL(raw, base);
    return ['https:', 'http:'].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}
const browsePath = u => '/api/browse?url=' + encodeURIComponent(u);
const assetPath = u => '/api/asset?url=' + encodeURIComponent(u);
function rewriteCss(css, base) {
  return css.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (full, _q, url) => {
    const a = absolute(url, base); return a ? `url("${assetPath(a)}")` : full;
  }).replace(/@import\s+(['"])([^'"]+)\1/gi, (full, _q, url) => {
    const a = absolute(url, base); return a ? `@import url("${assetPath(a)}")` : full;
  });
}
function rewriteHtml(html, base) {
  const $ = cheerio.load(html);
  $('script,object,embed,applet,base,iframe,frame,meta[http-equiv="refresh"],link[rel="preload"],link[rel="modulepreload"]').remove();
  $('*').each((_, el) => {
    const attrs = el.attribs || {};
    for (const name of Object.keys(attrs)) if (/^on/i.test(name)) $(el).removeAttr(name);
  });
  $('form').each((_, el) => { $(el).attr('onsubmit', 'return false'); $(el).find('button[type="submit"],input[type="submit"]').attr('disabled', 'disabled'); });
  $('[href]').each((_, el) => {
    const old = $(el).attr('href'); const a = absolute(old, base);
    if (!a) { if (old && /^(javascript:|data:)/i.test(old)) $(el).removeAttr('href'); return; }
    const tag = el.tagName?.toLowerCase();
    $(el).attr('href', tag === 'link' ? assetPath(a) : browsePath(a));
    if (tag === 'a') $(el).removeAttr('target').removeAttr('download');
  });
  $('[src],[poster]').each((_, el) => {
    for (const key of ['src','poster']) { const old = $(el).attr(key); if (!old) continue; const a = absolute(old, base); if (a) $(el).attr(key, assetPath(a)); }
  });
  $('[srcset]').each((_, el) => { const value = $(el).attr('srcset'); if (!value) return; $(el).attr('srcset', value.split(',').map(x => { const [url, ...rest] = x.trim().split(/\s+/); const a = absolute(url, base); return a ? [assetPath(a), ...rest].join(' ') : ''; }).filter(Boolean).join(', ')); });
  $('[style]').each((_, el) => $(el).attr('style', rewriteCss($(el).attr('style'), base)));
  $('style').each((_, el) => $(el).text(rewriteCss($(el).html() || '', base)));
  $('meta[http-equiv="Content-Security-Policy"]').remove();
  // Only this small trusted navigation script executes; remote scripts are removed.
  const js = `(() => { const target=${JSON.stringify(base).replace(/</g, '\\u003c')}; parent.postMessage({kind:'4sh-browser-page',url:target},'*'); document.addEventListener('click',e=>{const a=e.target.closest('a[href^="/api/browse?"]');if(a){const u=new URL(a.href);const next=u.searchParams.get('url');if(next)parent.postMessage({kind:'4sh-browser-page',url:next},'*');}},true); })();`;
  $('body').append(`<script>${js.replace(/<\//g, '<\\/')}</script>`);
  return $.html();
}

const visits = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip; const now = Date.now(); const rec = visits.get(ip) || { start: now, count: 0 };
  if (now - rec.start > 60000) { rec.start = now; rec.count = 0; }
  if (++rec.count > 90) return res.status(429).send('Browser rate limit exceeded. Try again shortly.');
  visits.set(ip, rec);
  if (visits.size > 5000) visits.clear();
  next();
}
function installBrowserProxy(app) {
  app.get('/api/browse', rateLimit, async (req, res) => {
    try {
      const page = await fetchPublic(String(req.query.url || ''), MAX_HTML);
      if (!/text\/html|application\/xhtml\+xml/i.test(page.type)) return res.status(415).send('This address is not an HTML page.');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline' https://fourshock-search-server.onrender.com; img-src https://fourshock-search-server.onrender.com data:; font-src https://fourshock-search-server.onrender.com data:; script-src 'unsafe-inline'; form-action 'none'; frame-ancestors https://4shockauth.shop");
      res.setHeader('Cache-Control', 'no-store');
      res.send(rewriteHtml(page.body.toString('utf8'), page.url));
    } catch (e) { res.status(502).type('text/plain').send('Unable to load this website: ' + String(e.message || e)); }
  });
  app.get('/api/asset', rateLimit, async (req, res) => {
    try {
      const asset = await fetchPublic(String(req.query.url || ''), MAX_ASSET);
      if (!/^(image\/(?:png|jpeg|gif|webp|svg\+xml|avif)|text\/css|font\/|application\/(?:font|vnd\.ms-fontobject|octet-stream))/i.test(asset.type)) return res.status(415).send('Unsupported resource type');
      res.setHeader('Content-Type', asset.type);
      res.setHeader('Cache-Control', 'public, max-age=600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (/text\/css/i.test(asset.type)) res.send(rewriteCss(asset.body.toString('utf8'), asset.url));
      else res.send(asset.body);
    } catch (e) { res.status(502).type('text/plain').send('Resource unavailable'); }
  });
}

installBrowserProxy(app);

app.listen(PORT, '0.0.0.0', () => console.log(`4SHOCK search listening on ${PORT}`));
