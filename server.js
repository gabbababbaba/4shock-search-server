import express from "express";
import * as cheerio from "cheerio";

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  next();
});

app.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/search", async (req, res) => {
  const query = String(req.query.q || "").trim();

  if (!query) {
    return res.status(400).json({ error: "Provide a search query with ?q=" });
  }

  if (query.length > 200) {
    return res.status(400).json({ error: "Search queries may contain up to 200 characters." });
  }

  try {
    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent": "4shock-search-server/1.0 (+https://example.com)",
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) {
      throw new Error(`Search provider returned ${response.status}`);
    }

    const $ = cheerio.load(await response.text());
    const results = $(".result")
      .map((_index, element) => {
        const link = $(element).find(".result__a").first();
        const snippet = $(element).find(".result__snippet").first();
        const url = link.attr("href");

        if (!url) return null;

        return {
          title: link.text().trim(),
          url,
          snippet: snippet.text().trim(),
        };
      })
      .get()
      .filter(Boolean)
      .slice(0, 10);

    res.json({ query, results });
  } catch (error) {
    console.error("Search failed:", error.message);
    res.status(502).json({ error: "The search provider could not be reached." });
  }
});

app.listen(port, () => {
  console.log(`Search server listening on port ${port}`);
});
