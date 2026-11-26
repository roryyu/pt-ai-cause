"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-fetch";
import { DataTable } from "@/components/data/DataTable";

const control = "rounded-[8px] border px-3 py-2 text-xs disabled:opacity-50";
const style = { borderColor: "var(--line)", background: "var(--paper)", color: "var(--ink)" };
type Item = { id: string; name?: string; status?: string; manager?: boolean; resourceName?: string; type?: string };
type Result = { rows: Record<string, unknown>[]; account?: { name: string; manager: boolean; currencyCode: string; timeZone: string }; note?: string; nextAfterId?: string | null; warning?: string };
type GoogleAdsResponse = {
  status: number;
  elapsedMs: number;
  fromCache: boolean;
  body: Result & { error?: string; codes?: string[]; help?: Array<{ label: string; url: string }> };
};
type Page = { rows: Item[]; nextAfterId?: string | null };
const statusName = (status?: string) => ({ ENABLED: "启用", PAUSED: "暂停", REMOVED: "已移除" })[status ?? ""] ?? status ?? "—";

export function GoogleAdsAuthHelp() {
  return <div className="space-y-1 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
    <p>复用服务端 GOOGLE_APPLICATION_CREDENTIALS 指向的 JSON，不需要 Property ID，不在浏览器上传私钥。</p>
    <p>依次检查：<a className="underline" href="https://console.cloud.google.com/apis/library/googleads.googleapis.com" target="_blank" rel="noreferrer">启用 Google Ads API</a> · <a className="underline" href="https://console.cloud.google.com/google/ads-apis/overview" target="_blank" rel="noreferrer">Cloud 项目 API 访问等级</a> · <a className="underline" href="https://ads.google.com/" target="_blank" rel="noreferrer">Google Ads → 管理 → 访问权限和安全</a>，给 JSON 中的 client_email 添加只读权限。</p>
    <p>只有 JSON 也可先注册并发现账户。经理账户需选择实际投放子账户；注册、账户发现成功均不代表已取得报表权限。</p>
  </div>;
}

export function GoogleAdsPanel({ source, onSaved }: {
  source: { id: string; name: string; meta: { customerId?: string; loginCustomerId?: string } | null };
  onSaved: () => void;
}) {
  const [customerId, setCustomerId] = useState(source.meta?.customerId ?? "");
  const [loginCustomerId, setLoginCustomerId] = useState(source.meta?.loginCustomerId ?? "");
  const [accounts, setAccounts] = useState<Page | null>(null);
  const [clients, setClients] = useState<Page | null>(null);
  const [campaigns, setCampaigns] = useState<Page | null>(null);
  const [actions, setActions] = useState<Page | null>(null);
  const [account, setAccount] = useState<Result["account"]>();
  const [campaignId, setCampaignId] = useState("");
  const [installAction, setInstallAction] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cache, setCache] = useState("");

  function clearScope() {
    setClients(null); setCampaigns(null); setActions(null); setAccount(undefined);
    setCampaignId(""); setInstallAction(""); setResult(null); setError(""); setNotice("");
  }
  function chooseCustomer(id: string, manager = "") {
    clearScope(); setCustomerId(id); setLoginCustomerId(manager);
  }
  async function request(path: string, body: Record<string, unknown>) {
    const response = await apiFetch<GoogleAdsResponse>(`/api/v1/datasources/${source.id}/request`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "POST", path, body }),
    });
    if (!response.ok) throw new Error(response.error?.message ?? "请求失败");
    const data = response.data;
    if (data.status !== 200) throw new Error(`${data.body?.error ?? "Google Ads 请求失败"}（HTTP ${data.status}）\n${(data.body?.codes ?? []).join(" / ")}\n${(data.body?.help ?? []).map((h: { label: string; url: string }) => `${h.label}：${h.url}`).join("\n")}`);
    if (path === "report") setCache(`${data.elapsedMs}ms · ${data.fromCache ? "短缓存" : "实时请求"}`);
    setNotice(data.body.warning ?? "");
    return data.body;
  }
  async function run(path: "accounts" | "account" | "clients" | "campaigns" | "conversionActions" | "report", afterId?: string | null) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    if (path === "report") setResult(null);
    try {
      const scope = { customerId: customerId.replace(/-/g, "").trim(), loginCustomerId: loginCustomerId.replace(/-/g, "").trim() };
      const page = { limit: 50, ...(afterId ? { afterId } : {}) };
      const body = path === "accounts" ? page : path === "account" ? scope : path === "report" ? {
        ...scope, campaignId, startDate, endDate, ...(installAction ? { installAction } : {}),
      } : { ...scope, ...page };
      const data = await request(path, body);
      if (data.account) setAccount(data.account);
      const append = (previous: Page | null): Page => ({ rows: [...(afterId ? previous?.rows ?? [] : []), ...data.rows as Item[]], nextAfterId: data.nextAfterId });
      if (path === "accounts") setAccounts(append);
      if (path === "clients") setClients(append);
      if (path === "campaigns") setCampaigns(append);
      if (path === "conversionActions") setActions(append);
      if (path === "report") setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络异常");
    } finally { setBusy(false); }
  }
  async function save() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await apiFetch(`/api/v1/datasources/${source.id}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId: customerId.replace(/-/g, "").trim(), loginCustomerId: loginCustomerId.replace(/-/g, "").trim() }),
      });
      if (!response.ok) throw new Error(response.error?.message ?? "保存失败");
      setNotice("默认账户已保存，网页问答与 MCP ask 会共用此配置。");
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : "网络异常"); }
    finally { setBusy(false); }
  }
  const money = (v: unknown) => v == null ? "—" : Number(v).toFixed(2);
  const reportRows = result?.rows.map((r) => ({ 日期: r.date, 曝光量: r.impressions, 点击量: r.clicks,
    点击率: `${(Number(r.ctr) * 100).toFixed(2)}%`, 花费: money(r.cost), 安装量: r.installs == null ? "未选择口径" : r.installs,
    安装成本: money(r.cpi) })) ?? [];
  const canQuery = !!customerId && account?.manager !== true;
  return <section className="space-y-4 rounded-[var(--radius-sm)] border p-5" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
    <h2 className="text-sm font-bold" style={{ color: "var(--ink)" }}>Google Ads · 只读广告查询</h2>
    <GoogleAdsAuthHelp />
    <fieldset disabled={busy} className="space-y-4 disabled:opacity-70">
      <div className="flex flex-wrap gap-2">
        <button className={control} style={style} onClick={() => run("accounts")}>发现可访问账户</button>
        {accounts?.nextAfterId && <button className={control} style={style} onClick={() => run("accounts", accounts.nextAfterId)}>更多账户</button>}
      </div>
      {accounts && <div className="flex flex-wrap gap-2 text-xs">
        {accounts.rows.length === 0 ? <p>没有可见账户，请先授权服务账号。</p> : accounts.rows.map((a) => <button className={control} style={style} key={a.id} onClick={() => chooseCustomer(a.id)}>选择 {a.id}</button>)}
      </div>}
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1 text-xs">客户 ID
          <input aria-label="Google Ads 客户 ID" className={`${control} w-full`} style={style} value={customerId} onChange={(e) => { clearScope(); setCustomerId(e.target.value); }} placeholder="10 位数字，可粘贴带连字符的 ID" />
        </label>
        <label className="space-y-1 text-xs">经理 ID（直接访问留空）
          <input aria-label="Google Ads 经理 ID" className={`${control} w-full`} style={style} value={loginCustomerId} onChange={(e) => { clearScope(); setLoginCustomerId(e.target.value); }} />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className={control} style={style} disabled={!customerId} onClick={() => run("account")}>检查账户类型</button>
        <button className={control} style={style} disabled={!customerId} onClick={save}>保存为默认查询账户</button>
        {account?.manager && <button className={control} style={style} onClick={() => run("clients")}>读取投放子账户</button>}
      </div>
      {account && <p className="text-xs">{account.name} · {account.manager ? "经理账户（请选择子账户）" : "投放账户"} · {account.currencyCode} · {account.timeZone}</p>}
      {clients && <div className="space-y-2">
        {clients.rows.length === 0 && <p className="text-xs">没有可见子账户。</p>}
        {clients.rows.map((c) => <button className={`${control} mr-2`} style={style} key={c.id} onClick={() => chooseCustomer(c.id, loginCustomerId || customerId)}>{c.name || c.id} · {c.id} · {c.manager ? "经理" : "投放"}</button>)}
        {clients.nextAfterId && <button className={control} style={style} onClick={() => run("clients", clients.nextAfterId)}>更多子账户</button>}
      </div>}
      <div className="flex flex-wrap gap-2">
        <button className={control} style={style} disabled={!canQuery} onClick={() => run("campaigns")}>查询 campaign 列表</button>
        <button className={control} style={style} disabled={!canQuery} onClick={() => run("conversionActions")}>查询安装转化动作</button>
      </div>
      {campaigns && <div className="max-h-72 overflow-auto rounded border" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-left text-xs"><thead><tr><th className="p-2">Campaign ID</th><th className="p-2">名称</th><th className="p-2">状态</th><th className="p-2">操作</th></tr></thead>
          <tbody>{campaigns.rows.map((c) => <tr key={c.id} style={{ background: campaignId === c.id ? "var(--purple-pale)" : undefined }}><td className="p-2">{c.id}</td><td className="p-2">{c.name}</td><td className="p-2">{statusName(c.status)}</td><td><button className={control} style={style} onClick={() => { setCampaignId(c.id); setResult(null); }}>选择</button></td></tr>)}</tbody>
        </table>
        {!campaigns.rows.length && <p className="p-3 text-xs">当前账户没有未移除的 campaign。</p>}
        {campaigns.nextAfterId && <button className={control} style={style} onClick={() => run("campaigns", campaigns.nextAfterId)}>加载更多 campaign</button>}
      </div>}
      <label className="block space-y-1 text-xs">安装口径（单一安装/首次打开动作，不是全部转化）
        <select aria-label="安装转化动作" className={`${control} w-full`} style={style} value={installAction} onChange={(e) => { setInstallAction(e.target.value); setResult(null); }}>
          <option value="">不查询安装（先查询曝光、点击、花费）</option>
          {actions?.rows.map((a) => <option key={a.resourceName} value={a.resourceName}>{a.name} · {a.type} · {statusName(a.status)}</option>)}
        </select>
      </label>
      {actions?.rows.length === 0 && <p className="text-xs">没有识别到安装类转化动作；请在 Google Ads 转化设置中核对跟踪来源。</p>}
      {actions?.nextAfterId && <button className={control} style={style} onClick={() => run("conversionActions", actions.nextAfterId)}>更多转化动作</button>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs">开始日期<input aria-label="开始日期" type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setResult(null); }} className={`block ${control}`} style={style} /></label>
        <label className="space-y-1 text-xs">结束日期<input aria-label="结束日期" type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); setResult(null); }} className={`block ${control}`} style={style} /></label>
        <button className={control} style={style} disabled={!canQuery || !campaignId || !startDate || !endDate} onClick={() => run("report")}>查询所选 campaign 日报</button>
      </div>
      <p className="text-xs" style={{ color: "var(--muted)" }}>当前 campaign：{campaignId || "尚未选择"}。日期按广告账户时区，单次最多 366 天。切换查询账户后可保存为 MCP 默认账户。</p>
    </fieldset>
    {busy && <p className="text-xs" role="status">正在请求 Google Ads…</p>}
    {notice && <p className="text-xs" style={{ color: "var(--warning)" }}>{notice}</p>}
    {error && <p className="whitespace-pre-wrap break-all text-xs" role="alert" style={{ color: "var(--danger)" }}>{error}</p>}
    {result && <div className="space-y-3">
      <p className="text-xs">{cache} · 币种 {result.account?.currencyCode} · 时区 {result.account?.timeZone}</p>
      <DataTable title={`Google Ads · campaign ${campaignId}`} columns={["日期", "曝光量", "点击量", "点击率", "花费", "安装量", "安装成本"]} rows={reportRows} defaultOpen maxHeight={400} />
      <p className="text-xs" style={{ color: "var(--muted)" }}>{result.note}</p>
    </div>}
  </section>;
}
