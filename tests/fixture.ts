// Shared test support. Only helpers that are literally identical in both suites live here:
// `deferred` (a manually completed promise) and `captureConsoleError` (the observer diagnostic sink).
//
// Deliberately NOT shared: the core fixture builds a virtual Clock, a plain object Store and drives
// `Manager` directly, while the Vue fixture mounts a real app with a real KeepAlive, a real Pinia and
// the real platform Clock. Those are different subjects to test, not copies of one subject — moving
// them here would be relocation, not reuse.

/** 手动完成的 Promise；`resolve` / `reject` 由测试自己控制。 */
export function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/**
 * 捕获 observer 诊断：observer 只写 `console.error`，测试要断言「只报告一次」与日志实参。
 * 返回日志数组（每条是原始实参列表）与还原函数；还原必须放在 `finally` 里。
 */
export function captureConsoleError(): { logs: unknown[][]; restore: () => void } {
  const original = console.error
  const logs: unknown[][] = []
  console.error = (...args: unknown[]) => { logs.push(args) }
  return { logs, restore: () => { console.error = original } }
}
