// The app's own persisted state (app-state.json). It survives restarts and
// updates, which is what makes a swap look seamless: the new version carries
// on counting where the old one stopped (DESIGN.md, question 6).
//
// Compatibility rule: after a rollback, an *older* version reads state written
// by a newer one. So fields may be added but never repurposed, and unknown
// fields are ignored.

import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../shared/fs.ts";
import type { Logger } from "../shared/log.ts";

export interface AppState {
  readonly ticks: number;
}

export const INITIAL_STATE: AppState = { ticks: 0 };

/**
 * Loads saved state, falling back to the initial state if there is none or it
 * is unreadable. A corrupt state file must never stop the program from
 * starting: that would turn a cosmetic loss into an outage.
 */
export async function loadAppState(file: string, log: Logger): Promise<AppState> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return INITIAL_STATE;
    }
    log.warn("could not read app state; starting fresh", { file, error });
    return INITIAL_STATE;
  }

  try {
    const value: unknown = JSON.parse(text);
    const ticks = (value as { ticks?: unknown } | null)?.ticks;
    if (typeof ticks === "number" && Number.isSafeInteger(ticks) && ticks >= 0) {
      return { ticks };
    }
    log.warn("app state has an invalid shape; starting fresh", { file });
  } catch (error) {
    log.warn("app state is not valid JSON; starting fresh", { file, error });
  }
  return INITIAL_STATE;
}

export async function saveAppState(file: string, state: AppState): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(state)}\n`);
}
