// Structured JSON-lines logging (DESIGN.md#logging). Every line carries the
// component, version and PID, so a failed update on a client machine can be
// reconstructed from its logs alone.

export type Level = "debug" | "info" | "warn" | "error";

export type Fields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** A logger that adds `fields` to every line it writes. */
  child(fields: Fields): Logger;
}

/** Receives one complete JSON line, including the trailing newline. */
export type Sink = (line: string) => void;

export interface LoggerOptions {
  readonly component: string;
  readonly version?: string;
  readonly sinks?: readonly Sink[];
  readonly now?: () => Date;
}

export const stdoutSink: Sink = (line) => {
  process.stdout.write(line);
};

export function createLogger(options: LoggerOptions): Logger {
  const base: Fields = {
    component: options.component,
    ...(options.version === undefined ? {} : { version: options.version }),
    pid: process.pid,
  };
  return build(base, options.sinks ?? [stdoutSink], options.now ?? (() => new Date()));
}

function build(base: Fields, sinks: readonly Sink[], now: () => Date): Logger {
  const write = (level: Level, message: string, fields: Fields = {}): void => {
    const record = { time: now().toISOString(), level, msg: message, ...base, ...serializeErrors(fields) };
    const line = `${JSON.stringify(record)}\n`;
    for (const sink of sinks) {
      try {
        sink(line);
      } catch {
        // A broken log sink (full disk, closed pipe) must never take down
        // the program it's observing.
      }
    }
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (fields) => build({ ...base, ...fields }, sinks, now),
  };
}

// JSON.stringify turns an Error into {}, which hides the one thing you need.
function serializeErrors(fields: Fields): Fields {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack, code: (value as NodeJS.ErrnoException).code }
        : value;
  }
  return result;
}
