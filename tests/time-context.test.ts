import { describe, expect, it } from "vitest";
import { currentTimeContextBlock } from "@/lib/server/agents/prompts";

/**
 * 当前时间上下文块（纯函数层）
 * 注入点位于 supervisor.ts / workers.ts 的系统提示词组装（依赖网关，走集成验证）
 */
describe("当前时间上下文块", () => {
  it("按业务时区注入日期、时刻与星期", () => {
    // 2026-11-26 14:30 北京时间（星期四）
    const block = currentTimeContextBlock(new Date("2026-11-26T14:30:00+08:00"));
    expect(block).toContain("2026-11-26 14:30");
    expect(block).toContain("星期四");
    expect(block).toContain("Asia/Shanghai");
  });

  it("UTC 跨日时刻换算为业务时区日期，不受服务器系统时区影响", () => {
    // UTC 2026-11-25 17:00 → 北京时间 2026-11-26 01:00
    const block = currentTimeContextBlock(new Date("2026-11-25T17:00:00Z"));
    expect(block).toContain("2026-11-26 01:00");
    expect(block).toContain("星期四");
  });

  it("要求相对时间以注入时间为基准换算成具体日期区间", () => {
    const block = currentTimeContextBlock(new Date("2026-11-26T09:00:00+08:00"));
    expect(block).toContain("近一周");
    expect(block).toContain("具体日期区间");
    expect(block).toContain("禁止凭训练知识猜测当前日期");
  });
});