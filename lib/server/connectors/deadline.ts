export const GOOGLE_INITIALIZATION_TIMEOUT_MS = 15_000;
export const GOOGLE_OPERATION_TIMEOUT_MS = 30_000;
export const GOOGLE_QUERY_TIMEOUT_MS = 45_000;
export const API_QUERY_TIMEOUT_MS = 90_000;
export const CACHE_OPERATION_TIMEOUT_MS = 1_000;

/** 退避/限流等待可取消，取消后清理定时器，不继续下一次请求。 */
export async function waitWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: () => void = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, ms);
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener("abort", onAbort);
  }
}

export class QueryTimeoutError extends Error {
  readonly code = "QUERY_TIMEOUT";
  constructor() {
    super("查询超过时间预算，已停止等待；请使用其他已取得的数据继续回答");
    this.name = "QueryTimeoutError";
  }
}

/**
 * 总截止时间覆盖认证、初始化以及不响应 AbortSignal 的依赖。
 * 超时后通知支持取消的调用；迟到的成功/失败仍有监听，不产生未处理拒绝。
 * 无法取消的底层操作可能稍后结束，调用方须在后续副作用前检查 signal。
 */
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  parent?.throwIfAborted();
  const controller = new AbortController();
  const signal = controller.signal;
  const onParentAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new QueryTimeoutError()), timeoutMs);
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      cancelled,
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation(signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    parent?.removeEventListener("abort", onParentAbort);
  }
}
