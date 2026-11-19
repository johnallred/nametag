// The program's "real work": a counter that ticks at a fixed interval. It's a
// stand-in for whatever a real app does; what matters is that it can be
// stopped cleanly, with no tick left half-done, before an update swaps it out.

import type { Logger } from "../shared/log.ts";

export interface TickerOptions {
  readonly intervalMs: number;
  readonly initialTicks: number;
  /** Called after each increment. A failure is logged; ticking carries on. */
  readonly onTick: (ticks: number) => void | Promise<void>;
  readonly log: Logger;
}

export class Ticker {
  #ticks: number;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;
  #stopped = false;
  readonly #options: TickerOptions;

  constructor(options: TickerOptions) {
    this.#options = options;
    this.#ticks = options.initialTicks;
  }

  get ticks(): number {
    return this.#ticks;
  }

  start(): void {
    if (this.#stopped || this.#timer) {
      return;
    }
    this.#schedule();
  }

  /** Stops ticking. Resolves once any tick in progress has finished. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#inFlight;
  }

  // A chain of timeouts rather than setInterval: the next tick is scheduled
  // only after the previous one finishes, so slow ticks can't pile up.
  #schedule(): void {
    this.#timer = setTimeout(() => {
      this.#inFlight = this.#tick().finally(() => {
        this.#inFlight = undefined;
        if (!this.#stopped) {
          this.#schedule();
        }
      });
    }, this.#options.intervalMs);
  }

  async #tick(): Promise<void> {
    this.#ticks += 1;
    try {
      await this.#options.onTick(this.#ticks);
    } catch (error) {
      this.#options.log.error("tick failed", { ticks: this.#ticks, error });
    }
  }
}
