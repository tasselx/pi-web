import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { SleepInhibitStatus } from "./api-types";
import {
  HOLDER_READY_LINE,
  holderEnvironment,
  planSleepInhibitor,
  type HolderCommand,
  type SleepInhibitPlan,
} from "./sleep-inhibit-adapters";
import { readPreventSleep } from "./sleep-inhibit-settings";

// 运行时防止系统休眠（Settings › General）。服务端这一份统一管理，与浏览器无关：
// 开关打开且至少有一个 agent 在跑，就拿一把系统防休眠锁；全部跑完或关掉开关，就放锁。
// 「在跑」直接用 rpc-manager 里每个会话的 isRunning()（子代理会话也在同一张表里），不另起一套状态，
// 也不轮询：rpc-manager 在运行状态可能变化的地方调用 refreshSleepInhibitor()。
//
// 锁由 lib/sleep-inhibit-adapters.ts 给的「持锁进程」持有：关掉它的 stdin 或杀掉它，锁就释放；
// Pi Web 崩溃时操作系统关掉 stdin，持锁进程自己退出，所以不会留下一把没人管的锁。
// 失败（命令缺失、起不来、中途退出）只记日志并反映在设置页，从不影响任务；同一轮任务里不自动重试，
// 下一轮任务（任务数从 0 变回 ≥1）或用户重新开关时再试一次。

const READY_TIMEOUT_MS = 10_000; // Windows 上 Add-Type 要现编一小段 C#，要几百毫秒到几秒
const GRACE_MS = 2_000; // 放锁时先关 stdin 并 SIGTERM，到点还没退就 SIGKILL
const WATCHDOG_MS = 30_000;

export interface SleepInhibitorDeps {
  plan: SleepInhibitPlan;
  /** 正在运行的会话数。 */
  countRunning: () => number;
  /** 读保存的开关。 */
  loadEnabled: () => Promise<boolean>;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  env: NodeJS.ProcessEnv;
  readyTimeoutMs: number;
  graceMs: number;
  /** 持锁期间的兜底复核间隔：漏掉的「变闲」转换最多拖这么久。 */
  watchdogMs: number;
  log: (message: string) => void;
}

type HoldState = "idle" | "acquiring" | "held";
type StartOutcome = { ok: true } | { ok: false; error: string };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SleepInhibitor {
  private enabled = false;
  private loaded = false;
  private loading: Promise<void> | null = null;
  /** dispose() 之后不再拿锁：进程退出途中 rpc-manager 还会销毁会话并发来 refresh。 */
  private disposed = false;
  private state: HoldState = "idle";
  /** 持有（或正要持有）锁的那个进程。 */
  private child: ChildProcess | null = null;
  /** 每次放锁加一：还在路上的获取据此知道自己已被作废。 */
  private epoch = 0;
  /** 这一轮任务里已经失败过：不再自动重试，等任务数回到 0 再算新一轮。 */
  private failedThisRun = false;
  /** 最近一次拿锁失败的原因（给设置页看）。 */
  private failure: string | undefined;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** 还在进行的获取和放锁，供 setEnabled 等它们做完。 */
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: SleepInhibitorDeps) {}

  status(): SleepInhibitStatus {
    const { plan } = this.deps;
    return {
      enabled: this.enabled,
      supported: plan.supported,
      ...(plan.supported ? {} : { unsupportedReason: plan.reason }),
      active: this.state === "held",
      ...(this.failure ? { failure: this.failure } : {}),
    };
  }

  /** 保存的开关读完了（第一次用到时才读）。 */
  async ready(): Promise<void> {
    if (!this.loaded) this.startLoading();
    await this.loading;
  }

  /**
   * 运行状态可能变了（一轮开始或结束、压缩、`!` 命令、会话销毁）：必要时拿锁或放锁。
   * 同步返回，从不抛：这是 agent 事件路径上的一次调用，不能拖慢也不能打断任务。
   */
  refresh(): void {
    if (this.disposed) return;
    if (!this.loaded) {
      this.startLoading();
      return;
    }
    // 默认关：什么都不用算。
    if (!this.enabled && this.state === "idle") return;
    this.sync();
  }

  /** 用户在设置页切换开关：立即生效，并等锁真的拿到或放掉之后返回真实状态。 */
  async setEnabled(enabled: boolean): Promise<SleepInhibitStatus> {
    this.loaded = true; // 用户的明确选择压过启动时那次读取
    this.enabled = enabled;
    this.failedThisRun = false; // 重新开关就重新试一次
    this.failure = undefined;
    this.sync();
    await this.settled();
    return this.status();
  }

  /** 进程退出时同步放锁。崩溃和被强杀时靠持锁进程自己退出（stdin 随父进程关闭）。 */
  dispose(): void {
    this.disposed = true;
    this.epoch += 1;
    this.state = "idle";
    this.failedThisRun = false;
    this.armWatchdog();
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin?.destroy();
      child.kill();
    } catch {
      // 退出途中，没有可补救的
    }
  }

  private startLoading(): void {
    if (this.loading) return;
    // 经 then 调用：loadEnabled 同步抛出也只是一次读取失败，不会让 refresh() 抛。
    this.loading = Promise.resolve().then(() => this.deps.loadEnabled()).then(
      (enabled) => {
        if (!this.loaded) this.enabled = enabled;
      },
      (error) => this.deps.log(`could not read the setting, leaving it off: ${describe(error)}`),
    ).then(() => {
      this.loaded = true;
      this.loading = null;
      this.sync();
    });
  }

  private sync(): void {
    if (this.disposed) return;
    try {
      const running = this.enabled || this.state !== "idle" ? this.deps.countRunning() : 0;
      if (running === 0) this.failedThisRun = false;
      const want = this.enabled && this.deps.plan.supported && running > 0 && !this.failedThisRun;
      if (want) {
        if (this.state === "idle") this.acquire();
      } else if (this.state !== "idle") {
        this.release();
      }
      this.armWatchdog();
    } catch (error) {
      this.deps.log(`could not update the sleep hold: ${describe(error)}`);
    }
  }

  private acquire(): void {
    const { plan } = this.deps;
    if (!plan.supported) return;
    const epoch = ++this.epoch;
    this.state = "acquiring";
    const fail = (reason: string) => {
      const leftover = this.child;
      this.child = null;
      if (leftover) this.terminate(leftover); // 意料之外的异常时可能还留着一个没确认的进程
      this.state = "idle";
      this.failedThisRun = true;
      this.failure = reason;
      this.deps.log(`could not prevent system sleep (${reason})`);
      this.armWatchdog();
    };
    void this.track((async () => {
      const failures: string[] = [];
      for (const holder of plan.holders) {
        const outcome = await this.start(holder, epoch);
        if (epoch !== this.epoch) return; // 放锁或关开关把这次获取作废了，进程在那时已经收拾掉
        if (outcome.ok) {
          this.state = "held";
          this.failure = undefined;
          return;
        }
        failures.push(`${holder.label}: ${outcome.error}`);
      }
      fail(failures.join("; "));
    })().catch((error) => {
      // 意料之外的异常也不能把状态卡在「正在获取」，否则这一轮之后再也不会重试。
      if (epoch === this.epoch) fail(describe(error));
    }));
  }

  /** 起一个持锁进程，等它打出 ready；起不来、提前退出或超时都算失败。 */
  private start(holder: HolderCommand, epoch: number): Promise<StartOutcome> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.deps.spawn(holder.command, holder.args, {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: holderEnvironment(this.deps.env),
        });
      } catch (error) {
        resolve({ ok: false, error: describe(error) });
        return;
      }
      this.child = child;
      let ready = false;
      let settled = false;
      let output = "";
      let stderr = "";
      const finish = (outcome: StartOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        this.terminate(child);
        finish({ ok: false, error: `it did not report ready within ${Math.round(this.deps.readyTimeoutMs / 1000)} s` });
      }, this.deps.readyTimeoutMs);
      timer.unref?.();

      // 对端退出后再写或关 stdin 会报 EPIPE：不是错误，也不能变成未处理的 'error'。
      child.stdin?.on("error", () => {});
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (ready) return;
        output += chunk;
        if (output.split(/\r?\n/).includes(HOLDER_READY_LINE)) {
          ready = true;
          finish({ ok: true });
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      child.once("error", (error) => {
        if (this.child === child) this.child = null;
        finish({ ok: false, error: describe(error) });
      });
      child.once("exit", (code, signal) => {
        const how = signal ?? `code ${code}`;
        if (!ready) finish({ ok: false, error: stderr.trim() || `it exited (${how}) before it held the lock` });
        if (this.child !== child) return; // 已经是我们自己放的锁
        this.child = null;
        if (this.state !== "held" || epoch !== this.epoch) return;
        // 持锁中途被外面杀掉：不再算持有，也不自动重新起（同一轮任务里最多试一次）。
        this.state = "idle";
        this.failedThisRun = true;
        this.failure = `${holder.label} stopped unexpectedly (${how})${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
        this.deps.log(`the sleep hold ended early (${this.failure})`);
        this.armWatchdog();
      });
    });
  }

  private release(): void {
    this.epoch += 1;
    const child = this.child;
    this.child = null;
    this.state = "idle";
    if (child) this.terminate(child);
  }

  /** 关 stdin（持锁进程读到 EOF 自己退）并杀掉，宽限期过了还在就强杀。 */
  private terminate(child: ChildProcess): void {
    this.track(new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const force = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已经退了
        }
      }, this.deps.graceMs);
      force.unref?.();
      const done = () => {
        clearTimeout(force);
        resolve();
      };
      child.once("exit", done);
      child.once("error", done);
    }));
    try {
      child.stdin?.destroy();
      child.kill();
    } catch {
      // 已经退了
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    const forget = () => this.pending.delete(promise);
    promise.then(forget, forget);
    return promise;
  }

  /** 等进行中的获取和放锁做完，但有上限：命令卡住也不能把设置页的请求拖住。 */
  private async settled(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.deps.readyTimeoutMs + this.deps.graceMs + 1_000);
      timer.unref?.();
    });
    const drained = (async () => {
      while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
    })();
    await Promise.race([drained, limit]);
    clearTimeout(timer);
  }

  /**
   * 持锁（或正在拿）期间，以及这一轮已经失败、在等任务数回到 0 期间，每隔一会儿复核一次：
   * 兜住没有事件的「变闲」，免得漏掉一次就让下一轮任务白白不被保护。其余时候没有任何定时器。
   */
  private armWatchdog(): void {
    if (this.state === "idle" && !this.failedThisRun) {
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
      return;
    }
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.sync(), this.deps.watchdogMs);
    this.watchdog.unref?.();
  }
}

export function createSleepInhibitor(overrides: Partial<SleepInhibitorDeps> = {}): SleepInhibitor {
  return new SleepInhibitor({
    plan: planSleepInhibitor(),
    countRunning: countRunningSessions,
    loadEnabled: () => readPreventSleep(),
    spawn,
    env: process.env,
    readyTimeoutMs: READY_TIMEOUT_MS,
    graceMs: GRACE_MS,
    watchdogMs: WATCHDOG_MS,
    log: (message) => console.warn(`[pi-web] sleep inhibitor: ${message}`),
    ...overrides,
  });
}

/** rpc-manager 的会话表在 globalThis 上，路由和热更新各自的模块副本也读到同一批会话（子代理会话也在里面）。 */
function countRunningSessions(): number {
  let running = 0;
  for (const wrapper of globalThis.__piSessions?.values() ?? []) {
    if (wrapper.isRunning()) running += 1;
  }
  return running;
}

declare global {
  var __piSleepInhibitor: SleepInhibitor | undefined;
}

export function getSleepInhibitor(): SleepInhibitor {
  if (!globalThis.__piSleepInhibitor) {
    const inhibitor = createSleepInhibitor();
    globalThis.__piSleepInhibitor = inhibitor;
    process.once("exit", () => inhibitor.dispose());
  }
  return globalThis.__piSleepInhibitor;
}

/** rpc-manager 在运行状态可能变化的地方调用。 */
export function refreshSleepInhibitor(): void {
  try {
    getSleepInhibitor().refresh();
  } catch (error) {
    console.warn(`[pi-web] sleep inhibitor: ${describe(error)}`);
  }
}
