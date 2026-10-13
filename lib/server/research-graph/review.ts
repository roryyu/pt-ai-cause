import type { CitationEntry } from "@/lib/server/agents/deep-research";

/**
 * 报告引用完整性校验（设计文档 4.5，UA graph-reviewer 的 referential integrity 思想）
 *
 * 校验报告正文中的 [n] 引用编号与引用表一致：
 * - 正文引用的每个编号必须存在于引用表
 * - 引用表非空且至少一条被正文引用
 * 纯函数可测；软校验——不通过仅记录 issues，不阻断研究完成。
 */

export interface CitationReview {
  passed: boolean;
  issues: string[];
}

/** 从文本中提取 [n] 编号（与 deep-research.ts extractCitationNos 同规则） */
export function extractCitationNos(text: string): number[] {
  const nos: number[] = [];
  for (const m of text.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) nos.push(n);
  }
  return nos;
}

/** 按 旧→新 映射改写文本中的 [n] 引用编号（映射外的编号如年份 [2026] 原样保留） */
export function remapCitationText(text: string, remap: Map<number, number>): string {
  return text.replace(/\[(\d+)\]/g, (token, digits: string) => {
    const next = remap.get(Number(digits));
    return next === undefined ? token : `[${next}]`;
  });
}

/**
 * 引用表收敛重排：仅保留被 citedNos 命中的来源，按保留顺序重排为连续 1..N，
 * 返回重排后的引用表与 旧→新 编号映射（供正文/发现文本同步改写，消除断号）
 */
export function renumberCitations(
  citations: CitationEntry[],
  citedNos: Set<number>,
): { citations: CitationEntry[]; remap: Map<number, number> } {
  const remap = new Map<number, number>();
  const renumbered = citations
    .filter((c) => citedNos.has(c.no))
    .map((c, i) => {
      remap.set(c.no, i + 1);
      return { ...c, no: i + 1 };
    });
  return { citations: renumbered, remap };
}

export function verifyCitationIntegrity(report: string, citations: CitationEntry[]): CitationReview {
  const issues: string[] = [];
  const citedNos = [...new Set(extractCitationNos(report))];
  const registryNos = new Set(citations.map((c) => c.no));

  if (citations.length === 0) {
    issues.push("报告未附任何引用来源");
  }
  const dangling = citedNos.filter((n) => !registryNos.has(n));
  if (dangling.length > 0) {
    issues.push(`正文引用编号 [${dangling.join("] [")}] 在引用表中不存在`);
  }
  if (citations.length > 0 && citedNos.length === 0) {
    issues.push("引用表有来源但正文未引用任何编号");
  }
  const unused = citations.filter((c) => !citedNos.includes(c.no)).map((c) => c.no);
  if (citedNos.length > 0 && unused.length > 0) {
    issues.push(`引用 [${unused.join("] [")}] 未被正文引用（可精简）`);
  }

  // 「未被正文引用」属可精简项，不影响通过判定；悬挂引用与空引用表才判不通过
  const passed = citations.length > 0 && dangling.length === 0;
  return { passed, issues };
}
