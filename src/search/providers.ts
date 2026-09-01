import { SearchProvider } from "../types";

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchTavily(query: string, n: number): Promise<WebSearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not set.");
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: n, include_answer: false }),
  });
  if (!res.ok) throw new Error(`Tavily request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return (data.results ?? []).slice(0, n).map((r: any) => ({
    title: r.title ?? "(untitled)",
    url: r.url,
    snippet: (r.content ?? "").slice(0, 400),
  }));
}

async function searchSerper(query: string, n: number): Promise<WebSearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error("SERPER_API_KEY is not set.");
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: n }),
  });
  if (!res.ok) throw new Error(`Serper request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return (data.organic ?? []).slice(0, n).map((r: any) => ({
    title: r.title ?? "(untitled)",
    url: r.link,
    snippet: (r.snippet ?? "").slice(0, 400),
  }));
}

async function searchBrave(query: string, n: number): Promise<WebSearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error("BRAVE_API_KEY is not set.");
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`;
  const res = await fetch(url, { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } });
  if (!res.ok) throw new Error(`Brave request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return (data.web?.results ?? []).slice(0, n).map((r: any) => ({
    title: r.title ?? "(untitled)",
    url: r.url,
    snippet: (r.description ?? "").replace(/<\/?strong>/g, "").slice(0, 400),
  }));
}

/**
 * Zero-config fallback: scrapes DuckDuckGo's no-JS HTML results page. No API
 * key required, but best-effort — DuckDuckGo may change markup or rate-limit
 * this. Prefer setting TAVILY_API_KEY / BRAVE_API_KEY / SERPER_API_KEY for
 * reliable results.
 */
async function searchDuckDuckGo(query: string, n: number): Promise<WebSearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; YodaAgent/1.0)" },
  });
  if (!res.ok) throw new Error(`DuckDuckGo request failed (${res.status})`);
  const html = await res.text();

  const results: WebSearchResult[] = [];
  const blockRegex =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRegex.exec(html)) && results.length < n) {
    results.push({
      title: stripHtmlTags(m[2]),
      url: decodeDuckDuckGoUrl(m[1]),
      snippet: stripHtmlTags(m[3]).slice(0, 400),
    });
  }
  return results;
}

function decodeDuckDuckGoUrl(href: string): string {
  try {
    const u = new URL(href.startsWith("//") ? `https:${href}` : href);
    const real = u.searchParams.get("uddg");
    return real ? decodeURIComponent(real) : href;
  } catch {
    return href;
  }
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractReadableText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n");
  return stripHtmlTags(withoutNoise);
}

export function resolveSearchProvider(explicit?: string): SearchProvider {
  const requested = (explicit ?? "").toLowerCase();
  if (requested === "tavily" || requested === "serper" || requested === "brave" || requested === "duckduckgo") {
    return requested;
  }
  if (process.env.TAVILY_API_KEY) return "tavily";
  if (process.env.BRAVE_API_KEY) return "brave";
  if (process.env.SERPER_API_KEY) return "serper";
  return "duckduckgo";
}

export async function toolWebSearch(
  provider: SearchProvider,
  { query, max_results = 5 }: { query: string; max_results?: number }
): Promise<string> {
  if (!query || !query.trim()) return "Error: 'query' is required.";
  const n = Math.max(1, Math.min(10, Number(max_results) || 5));

  try {
    let results: WebSearchResult[];
    switch (provider) {
      case "tavily":
        results = await searchTavily(query, n);
        break;
      case "serper":
        results = await searchSerper(query, n);
        break;
      case "brave":
        results = await searchBrave(query, n);
        break;
      default:
        results = await searchDuckDuckGo(query, n);
        break;
    }
    if (results.length === 0) return `No results found for: ${query}`;
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
  } catch (e: any) {
    return `Web search error (${provider}): ${e.message ?? e}`;
  }
}

export async function toolWebFetch({
  url,
  max_chars = 6000,
}: {
  url: string;
  max_chars?: number;
}): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return `Error: '${url}' is not a valid http(s) URL.`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; YodaAgent/1.0)" },
      redirect: "follow",
    });
    if (!res.ok) return `Error fetching ${url}: HTTP ${res.status} ${res.statusText}`;

    const contentType = res.headers.get("content-type") ?? "";
    const body = await res.text();
    const text = contentType.includes("html") ? extractReadableText(body) : body;

    const limit = Math.max(500, Math.min(20000, Number(max_chars) || 6000));
    const truncated = text.length > limit;
    return `Fetched ${url} (${contentType || "unknown content-type"}):\n\n${text.slice(0, limit)}${
      truncated ? `\n\n[...truncated, ${text.length - limit} more characters]` : ""
    }`;
  } catch (e: any) {
    return `Error fetching ${url}: ${e.message ?? e}`;
  }
}
