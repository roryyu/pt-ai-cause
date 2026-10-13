import { describe, it, expect, vi } from "vitest";

/**
 * Web 搜索低质量来源过滤（connectors/web.ts）
 * 名词解释/百科/文库类结果不进研究证据池；过滤后无结果就返回空，宁缺毋滥。
 */

// web.ts 导入时触发 env fail-fast，先注入隔离测试环境变量
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("AUTH_SECRET", "CauseIsolatedEnvironmentFixture123456");
vi.stubEnv("DATABASE_URL", "postgresql://fixture@localhost/test?schema=cause");
vi.stubEnv("MODEL_GATEWAY_BASE_URL", "http://localhost:28080/openai/v1");
vi.stubEnv("MODEL_GATEWAY_API_KEY", "isolated-fixture");

// duck-duck-scrape 库直连真实网络（有风控重试），测试中替换为无结果桩
vi.mock("duck-duck-scrape", () => ({
  search: async () => ({ noResults: true, results: [] }),
  SafeSearchType: { OFF: 0 },
}));

const { isLowQualitySource, isRelevantToQuery, webSearch } = await import("@/lib/server/connectors/web");

describe("isLowQualitySource（名词解释类来源判定）", () => {
  it("百科/知道/文库域名判为低质量", () => {
    expect(isLowQualitySource("消费", "https://baike.baidu.com/item/%E6%B6%88%E8%B4%B9")).toBe(true);
    expect(isLowQualitySource("消费", "https://zh.wikipedia.org/wiki/%E6%B6%88%E8%B4%B9")).toBe(true);
    expect(isLowQualitySource("消费", "https://zhidao.baidu.com/question/123.html")).toBe(true);
    expect(isLowQualitySource("LTV", "https://wiki.mbalib.com/view/LTV")).toBe(true);
  });

  it("词典查词页与邮箱门户首页判为低质量", () => {
    expect(isLowQualitySource("163网易免费邮-你的专业电子邮局", "https://mail.163.com/")).toBe(true);
    expect(isLowQualitySource("< 反：ㄈˇ >辭典檢視 - 教育部《重編國語辭典修訂本》 2021", "https://dict.revised.moe.edu.tw/x")).toBe(true);
    expect(isLowQualitySource("消费 - 汉语词典", "https://www.hanyuzidian.com/ci/123")).toBe(true);
  });

  it("名词解释型标题判为低质量（域名不在黑名单也过滤）", () => {
    expect(isLowQualitySource("消费是什么？一文读懂", "https://blog.example.com/a")).toBe(true);
    expect(isLowQualitySource("什么是归因模型", "https://zhuanlan.example.com/b")).toBe(true);
    expect(isLowQualitySource("ROI 名词解释", "https://docs.example.com/c")).toBe(true);
  });

  it("查词页标题（意思/解释/词义辨析/拼音造句）判为低质量", () => {
    expect(isLowQualitySource("针对的意思_针对的解释-汉语国学", "https://www.hanyuguoxue.com/ci/1")).toBe(true);
    expect(isLowQualitySource("争对与针对的词义辨析与正确用法", "https://www.example.com/w")).toBe(true);
    expect(isLowQualitySource("针对的意思,针对的拼音、造句 - 汉语查", "https://www.hanyucha.com/ci/2")).toBe(true);
  });

  it("正常行业报告/新闻来源不误伤", () => {
    expect(isLowQualitySource("2026 中国移动广告行业报告", "https://www.iresearch.com.cn/report/1")).toBe(false);
    expect(isLowQualitySource("TikTok CPI 上涨原因分析", "https://news.example.com/tiktok-cpi")).toBe(false);
    // 非法 URL 不因解析失败被过滤
    expect(isLowQualitySource("正常标题", "not-a-url")).toBe(false);
  });
});

describe("webSearch（搜索结果统一过滤）", () => {
  /** 构造 DDG Lite 结构的最小 HTML：a.result-link + 相邻 tr 的 td.result-snippet */
  function liteHtml(items: Array<{ title: string; href: string; snippet: string }>): string {
    const rows = items
      .map(
        (i) =>
          `<tr><td><a class="result-link" href="${i.href}">${i.title}</a></td></tr>` +
          `<tr><td class="result-snippet">${i.snippet}</td></tr>`,
      )
      .join("");
    return `<html><body><table>${rows}</table></body></html>`;
  }

  it("低质量结果被剔除，只返回有效来源", async () => {
    const html = liteHtml([
      { title: "消费是什么_百度百科", href: "https://baike.baidu.com/item/x", snippet: "词条" },
      { title: "2026 消费趋势洞察报告", href: "https://research.example.com/2026", snippet: "趋势数据" },
      { title: "什么是复购率", href: "https://qa.example.com/repurchase", snippet: "解释" },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => html })) as never,
    );
    const results = await webSearch("消费趋势", 6);
    expect(results.map((r) => r.url)).toEqual(["https://research.example.com/2026"]);
    vi.unstubAllGlobals();
  });

  // 全低质量时会逐级走完 5 个搜索后端（每次带 600ms 限流间隔），放宽超时
  it("全部为低质量结果时返回空（没有结果就是没有结果）", { timeout: 20_000 }, async () => {
    const html = liteHtml([
      { title: "消费是什么", href: "https://baike.baidu.com/item/x", snippet: "词条" },
      { title: "什么是消费", href: "https://www.example.com/def", snippet: "名词解释" },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => html })) as never,
    );
    const results = await webSearch("消费是什么", 6);
    expect(results).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("拦截搜索引擎降级返回的无关结果（词面无重合）", async () => {
    const html = liteHtml([
      { title: "网易首页", href: "https://www.163.com/", snippet: "" },
      { title: "2026 东南亚手游投放 CPI 基准报告", href: "https://research.example.com/cpi", snippet: "CPI 数据" },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => html })) as never,
    );
    const results = await webSearch("东南亚手游 CPI 基准", 6);
    expect(results.map((r) => r.url)).toEqual(["https://research.example.com/cpi"]);
    vi.unstubAllGlobals();
  });

  // 复现线上事故：查询含功能词「针对」时词典查词页借词面重合混入引用来源
  it("查询含功能词时查词页仍被剔除（标题模式 + 功能词闸门双保险）", async () => {
    const html = liteHtml([
      { title: "针对的意思_针对的解释-汉语国学", href: "https://www.hanyuguoxue.com/ci/1", snippet: "针对：专有所指" },
      { title: "争对与针对的词义辨析与正确用法", href: "https://www.example.com/w", snippet: "辨析" },
      { title: "针对的意思,针对的拼音、造句 - 汉语查", href: "https://www.hanyucha.com/ci/2", snippet: "拼音 zhēn duì" },
      { title: "App 渠道归因与反作弊技术实战解析", href: "https://blog.example.com/guiyin", snippet: "归因链路实战" },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => html })) as never,
    );
    const results = await webSearch("针对 归因 反作弊", 6);
    expect(results.map((r) => r.url)).toEqual(["https://blog.example.com/guiyin"]);
    vi.unstubAllGlobals();
  });
});

describe("isRelevantToQuery（查询相关性闸门）", () => {
  it("中文二元组或拉丁词任一重合即相关", () => {
    expect(isRelevantToQuery("东南亚手游 CPI 基准", "网易首页", "")).toBe(false);
    expect(isRelevantToQuery("东南亚手游 CPI 基准", "2026 东南亚手游报告", "")).toBe(true);
    expect(isRelevantToQuery("TikTok ads CPM", "TikTok Ads CPM benchmarks", "")).toBe(true);
    expect(isRelevantToQuery("TikTok ads CPM", "网易首页", "")).toBe(false);
  });

  it("仅功能词（针对/关于等）重合不算相关，查词页穿不过闸门", () => {
    expect(isRelevantToQuery("针对 归因 反作弊", "针对的意思_针对的解释-汉语国学", "")).toBe(false);
    expect(isRelevantToQuery("针对 归因 反作弊", "针对 iOS 14 归因的应对方案", "")).toBe(true);
  });
});
