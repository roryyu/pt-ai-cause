import * as cheerio from "cheerio";
import * as DDG from "duck-duck-scrape";
import { extractFromHtml } from "@extractus/article-extractor";
import { env } from "@/lib/env";

/**
 * Web 数据接入连接器（design.md 5.1.4）
 *
 * 能力（纯 Node 进程内，无需额外服务 / 无需 Docker / 无需 API Key）：
 * 1. webSearch — 多源搜索：DDG Lite（主，轻量端点带摘要）
 *    → DDG HTML / duck-duck-scrape（备）→ Bing RSS / Bing HTML（末位兜底）
 * 2. fetchPage — 抓取网页并提取正文：@extractus/article-extractor（Reader-Mode 级）
 *    → cheerio 启发式（兜底）
 *
 * 约束（design.md 5.1.4）：
 * - 遵守 robots.txt 精神的黑名单（内网地址直接拒绝，防 SSRF）
 * - 频率限制：内置最小间隔
 * - 返回结构化结果（标题/摘要/正文/链接）
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ─── SSRF 防护：拒绝内网/本机地址 ─────────────────────────────────────────────

const BLOCKED_HOST = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|\[::1\]|::1)/i;

export function assertPublicUrl(url: string): { ok: boolean; reason?: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "仅支持 http/https 协议" };
    }
    if (BLOCKED_HOST.test(parsed.hostname)) {
      return { ok: false, reason: "禁止访问内网地址" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "URL 格式非法" };
  }
}

// ─── 简易频率限制（进程内） ────────────────────────────────────────────────────

const MIN_INTERVAL_MS = 600;
let lastFetchAt = 0;
async function throttle() {
  const now = Date.now();
  const wait = lastFetchAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8", ...(init?.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─── 搜索 ─────────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: "bing" | "duckduckgo" | "firecrawl";
}

// ─── 低质量来源过滤 ────────────────────────────────────────────────────────────
// 百科/词典/问答/文库类页面多为名词解释（如「消费是什么」），不构成研究证据，
// 在搜索入口统一剔除；剔除后无结果就返回空，宁缺毋滥。

/** 低质量域名：百科、词典、知道问答、文库、商业名词库 */
const LOW_QUALITY_HOST =
  /(^|\.)(baike\.baidu\.com|baike\.so\.com|baike\.com|wikipedia\.org|wiki\.mbalib\.com|mbalib\.com|zhidao\.baidu\.com|wenku\.baidu\.com|docin\.com|doc88\.com|book118\.com)$/i;

/** 汉语词典/查词站点域名（汉语国学、汉语查、查字典、汉典等）：查词页不构成研究证据 */
const DICT_HOST = /(hanyuguoxue|hanyucha|chazidian|zdic|cidian|zidian|dict\.cn)/i;

/** 名词解释型标题：「什么是X」「X是什么」「X的定义」「X的意思/解释/词义辨析/拼音造句」等 */
const DEFINITION_TITLE =
  /(是什么|什么是|名词解释|术语解释|词语解释|意思解释|的定义|定义是什么|定义与含义|的意思|的解释|词义|辨析|拼音|造句|近义词|反义词|同义词)/;

/** 词典/邮箱门户/登录注册类标题：查词页与邮箱首页不构成研究证据 */
const JUNK_TITLE =
  /(词典|辞典|字典|詞典|辭典|检视|檢視|邮箱|郵箱|免费邮|免費郵|电子邮箱|電子郵箱|登录入口|请登录|請登錄|注册账号|註冊賬號)/;

/** 判断搜索结果是否为名词解释类低质量来源 */
export function isLowQualitySource(title: string, url: string): boolean {
  if (DEFINITION_TITLE.test(title) || JUNK_TITLE.test(title)) return true;
  try {
    const hostname = new URL(url).hostname;
    // mail.* 一律为邮箱门户首页（如 mail.163.com）
    if (/^mail\./i.test(hostname)) return true;
    if (DICT_HOST.test(hostname)) return true;
    return LOW_QUALITY_HOST.test(hostname);
  } catch {
    return false;
  }
}

/**
 * 弱语素二元组：「针对/关于/通过」一类功能词不构成主题相关性。
 * 查词页标题常复述查询中的功能词（如查「针对」返回「针对的意思」），
 * 仅此类重合不算相关，避免词典页借功能词穿过相关性闸门。
 */
const STOP_BIGRAMS = new Set(["针对", "关于", "对于", "通过", "进行", "以及", "其中", "可以", "需要"]);

/**
 * 查询相关性闸门：结果标题+摘要须与查询共享至少一个词（中文二元组或拉丁词）。
 * 搜索引擎对机器人客户端会「非空降级」返回毫无相关的页面（如搜投放指标返回
 * 邮箱首页），条数非空不代表相关，故在入口按词面重合度兜底拦截。
 */
export function isRelevantToQuery(query: string, title: string, snippet: string): boolean {
  const hay = `${title} ${snippet}`.toLowerCase();
  const latinWords = query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  if (latinWords.some((w) => hay.includes(w))) return true;
  const cjkSegs = query.match(/[一-鿿]{2,}/g) ?? [];
  for (const seg of cjkSegs) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      const bigram = seg.slice(i, i + 2);
      if (STOP_BIGRAMS.has(bigram)) continue; // 功能词重合不算主题相关
      if (hay.includes(bigram)) return true;
    }
  }
  // 查询无可提取词面（纯符号等）时不拦截
  return latinWords.length === 0 && cjkSegs.length === 0;
}

function filterLowQuality(results: SearchResult[], query: string): SearchResult[] {
  return results.filter(
    (r) => !isLowQualitySource(r.title, r.url) && isRelevantToQuery(query, r.title, r.snippet),
  );
}

/**
 * 网页搜索（纯 Node 进程内，无需 Key / 服务 / Docker）：
 * 主源 DDG Lite（轻量 HTML 端点，反爬宽松，结果相关度高且带摘要）
 * → DDG HTML（旧端点兜底）→ duck-duck-scrape（库直连，部分网络可用）
 * → Bing RSS（官方 XML feed）→ Bing HTML（最后兜底）
 * 注：Bing 对机器人客户端会降级返回低相关结果，故置于链路末位
 * 所有结果统一经低质量来源过滤（百科/名词解释类不进证据池）
 */
export async function webSearch(query: string, maxResults = 6): Promise<SearchResult[]> {
  const q = query.trim().slice(0, 300);
  if (!q) return [];

  // 多取数条弥补过滤损耗，保证过滤后仍尽量凑足 maxResults
  const fetchCount = maxResults + 4;
  let results = filterLowQuality(await searchDdgLite(q, fetchCount), q);
  if (results.length === 0) results = filterLowQuality(await searchDuckDuckGo(q, fetchCount), q);
  if (results.length === 0) results = filterLowQuality(await searchDdgLib(q, fetchCount), q);
  if (results.length === 0) results = filterLowQuality(await searchBingRss(q, fetchCount), q);
  if (results.length === 0) results = filterLowQuality(await searchBing(q, fetchCount), q);
  return results.slice(0, maxResults);
}

/** 主源：DuckDuckGo Lite（极简 HTML 端点，结构稳定：a.result-link 标题 + 相邻 tr 的 td.result-snippet 摘要） */
async function searchDdgLite(query: string, maxResults: number): Promise<SearchResult[]> {
  await throttle();
  try {
    const res = await fetchWithTimeout(
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
      { method: "GET" },
      12_000,
    );
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    $("a.result-link").each((_, el) => {
      if (results.length >= maxResults) return;
      const title = $(el).text().trim();
      const url = decodeDdgUrl($(el).attr("href") ?? "");
      // 摘要位于标题所在 tr 的相邻 tr
      const snippet = $(el).closest("tr").next("tr").find("td.result-snippet").text().trim();
      if (title && url && !url.includes("duckduckgo.com/y.js")) {
        results.push({ title, url, snippet, source: "duckduckgo" });
      }
    });
    return results;
  } catch (error) {
    console.warn("[web-connector] DDG Lite 搜索失败:", error instanceof Error ? error.message : error);
    return [];
  }
}

/** 备源：duck-duck-scrape（npm 库，进程内直连，返回带摘要的结构化结果；部分网络会被风控拦截） */
async function searchDdgLib(query: string, maxResults: number): Promise<SearchResult[]> {
  await throttle();
  try {
    const res = await DDG.search(query, {
      safeSearch: DDG.SafeSearchType.OFF,
      locale: "cn-zh",
    });
    if (!res || res.noResults) return [];
    const out: SearchResult[] = [];
    for (const r of res.results) {
      if (out.length >= maxResults) break;
      const url = r.url ?? "";
      const title = (r.title ?? "").trim();
      if (title && /^https?:\/\//.test(url)) {
        out.push({ title, url, snippet: (r.description ?? "").trim(), source: "duckduckgo" });
      }
    }
    return out;
  } catch (error) {
    console.warn("[web-connector] DDG(lib) 搜索失败:", error instanceof Error ? error.message : error);
    return [];
  }
}

/** 次源：Bing 官方 RSS feed（结构化 XML，反爬远弱于 HTML 页，复用 cheerio 解析） */
async function searchBingRss(query: string, maxResults: number): Promise<SearchResult[]> {
  await throttle();
  try {
    const res = await fetchWithTimeout(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&setmkt=zh-CN&count=${maxResults}`,
      { method: "GET" },
      15_000,
    );
    if (!res.ok) return [];
    const xml = await res.text();
    const $ = cheerio.load(xml, { xml: true });
    const results: SearchResult[] = [];
    $("item").each((_, el) => {
      if (results.length >= maxResults) return;
      const title = $(el).find("title").text().trim();
      const url = $(el).find("link").text().trim();
      const snippet = $(el).find("description").text().trim();
      if (title && /^https?:\/\//.test(url)) {
        results.push({ title, url, snippet, source: "bing" });
      }
    });
    return results;
  } catch (error) {
    console.warn("[web-connector] Bing RSS 搜索失败:", error instanceof Error ? error.message : error);
    return [];
  }
}

async function searchBing(query: string, maxResults: number): Promise<SearchResult[]> {
  await throttle();
  try {
    const res = await fetchWithTimeout(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-hans&count=${maxResults}`,
      { method: "GET" },
      15_000,
    );
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    $("li.b_algo").each((_, el) => {
      if (results.length >= maxResults) return;
      const linkEl = $(el).find("h2 a").first();
      const url = linkEl.attr("href") ?? "";
      const title = linkEl.text().trim();
      const snippet = $(el).find(".b_caption p, p").first().text().trim();
      if (title && /^https?:\/\//.test(url)) {
        results.push({ title, url, snippet, source: "bing" });
      }
    });
    return results;
  } catch (error) {
    console.warn("[web-connector] Bing 搜索失败:", error instanceof Error ? error.message : error);
    return [];
  }
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
  await throttle();
  try {
    const res = await fetchWithTimeout(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { method: "GET" },
      12_000,
    );
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    $("div.result, div.web-result").each((_, el) => {
      if (results.length >= maxResults) return;
      const linkEl = $(el).find("a.result__a").first();
      const title = linkEl.text().trim();
      const url = decodeDdgUrl(linkEl.attr("href") ?? "");
      const snippet = $(el).find(".result__snippet").first().text().trim();
      // 过滤广告链接（uddg 解码后指向 duckduckgo.com/y.js 的为广告）
      if (title && url && !url.includes("duckduckgo.com/y.js")) {
        results.push({ title, url, snippet, source: "duckduckgo" });
      }
    });
    return results;
  } catch (error) {
    console.warn("[web-connector] DuckDuckGo 搜索失败:", error instanceof Error ? error.message : error);
    return [];
  }
}

function decodeDdgUrl(href: string): string {
  try {
    if (href.startsWith("//duckduckgo.com/l/") || href.includes("duckduckgo.com/l/")) {
      const u = new URL(href.startsWith("//") ? `https:${href}` : href);
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
    if (href.startsWith("http")) return href;
    return "";
  } catch {
    return "";
  }
}

// ─── 网页抓取 ─────────────────────────────────────────────────────────────────

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  wordCount: number;
  fetchedAt: string;
}

/**
 * 抓取网页正文：
 * 主提取器 @extractus/article-extractor（Reader-Mode 级正文抽取，自动去噪）
 * → 兜底 cheerio 启发式（抽取失败或正文过短时）
 */
export async function fetchPage(url: string, maxChars = 6000): Promise<FetchedPage> {
  const guard = assertPublicUrl(url);
  if (!guard.ok) throw new Error(guard.reason ?? "URL 校验失败");

  await throttle();
  const res = await fetchWithTimeout(url, { method: "GET" }, 20_000);
  if (!res.ok) {
    throw new Error(`抓取失败：HTTP ${res.status}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    throw new Error(`不支持的内容类型：${contentType || "unknown"}`);
  }
  const html = await res.text();

  // 主提取器：article-extractor（返回清洗后的正文 HTML 与标题）
  let title = "";
  let text = "";
  try {
    const article = await extractFromHtml(html, url);
    if (article) {
      title = (article.title ?? "").trim();
      text = cheerio.load(article.content ?? "").text();
    }
  } catch (error) {
    console.warn(
      "[web-connector] article-extractor 抽取失败，降级 cheerio:",
      error instanceof Error ? error.message : error,
    );
  }

  // 兜底：原 cheerio 启发式解析（抽取失败或正文过短时）
  if (text.trim().length < 120) {
    const $ = cheerio.load(html);
    title =
      title ||
      $("title").first().text().trim() ||
      $('meta[property="og:title"]').attr("content")?.trim() ||
      url;
    // 移除噪声节点
    $("script, style, noscript, nav, header, footer, aside, iframe, form, button, svg").remove();
    $("[role=navigation], [role=banner], [role=contentinfo], .nav, .footer, .sidebar, .ad, .advertisement").remove();
    // 提取正文容器优先
    const candidates = ["article", "main", ".article-content", "#content", ".content", "body"];
    let fallbackText = "";
    for (const sel of candidates) {
      const content = $(sel).first().text();
      if (content.length > fallbackText.length) fallbackText = content;
    }
    if (fallbackText.length > text.length) text = fallbackText;
  }

  if (!title) title = url;
  // 归一化空白
  text = text.replace(/\s+/g, " ").replace(/\s([，。；：、！？])/g, "$1").trim();

  return {
    url,
    title,
    text: text.slice(0, maxChars),
    wordCount: text.length,
    fetchedAt: new Date().toISOString(),
  };
}

/** 是否已配置 Firecrawl（预留扩展位） */
export function hasFirecrawl(): boolean {
  return Boolean(env.FIRECRAWL_API_KEY);
}
