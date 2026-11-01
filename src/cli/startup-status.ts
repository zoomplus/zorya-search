export const STARTUP_ID_ENV = "ZORYA_SEARCH_OWNER_STARTUP_ID";

export const STARTUP_PHASES = [
  "child_spawn",
  "child_bootstrap",
  "runtime_import",
  "runtime_start",
  "daemon_ready",
  "control_listen",
  "descriptor_write",
  "parent_authenticated",
] as const;

export type StartupPhase = (typeof STARTUP_PHASES)[number];

const CHILD_PHASES = STARTUP_PHASES.slice(1, -1);
const STARTUP_CAUSES = [
  "ABORT_ERR",
  "CAPABILITY_DISABLED",
  "CHILD_EXIT",
  "CHILD_SPAWN_ERROR",
  "CONFIG_INVALID",
  "CONFIG_NOT_FOUND",
  "EACCES",
  "EADDRINUSE",
  "EEXIST",
  "EIO",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_STATE",
  "ERR_MODULE_NOT_FOUND",
  "OWNER_DESCRIPTOR_CONFLICT",
  "OWNER_DIR_PERMISSIONS_UNSAFE",
  "OWNER_DIR_UNSAFE",
  "OWNER_FILE_INVALID",
  "READINESS_TIMEOUT",
  "UNKNOWN",
] as const;
export type StartupCause = (typeof STARTUP_CAUSES)[number];

type StartupMessage =
  | { version: 1; startupId: string; kind: "phase"; phase: StartupPhase }
  | {
      version: 1;
      startupId: string;
      kind: "failure";
      phase: StartupPhase;
      cause: StartupCause;
    };

const startupCauseSet = new Set<string>(STARTUP_CAUSES);
const startupPhaseRank = new Map<string, number>(
  STARTUP_PHASES.map((phase, index) => [phase, index]),
);
const nodeExitSignals = new Set([
  "SIGABRT",
  "SIGBREAK",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGKILL",
  "SIGQUIT",
  "SIGSEGV",
  "SIGTERM",
]);

export function startupCauseFor(error: unknown): StartupCause {
  if (!error || typeof error !== "object") return "UNKNOWN";
  const candidate = error as { code?: unknown; message?: unknown };
  const code =
    typeof candidate.code === "string"
      ? candidate.code
      : typeof candidate.message === "string"
        ? candidate.message
        : "";
  return startupCauseSet.has(code) ? (code as StartupCause) : "UNKNOWN";
}

export function startupIdFromEnvironment(value = process.env[STARTUP_ID_ENV]) {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value)
    ? value
    : undefined;
}

export class StartupDiagnostics {
  private phaseValue: StartupPhase = "child_spawn";
  private phaseRank = 0;
  private failureValue: StartupCause | undefined;

  constructor(private readonly expectedStartupId: string) {}

  get phase() {
    return this.phaseValue;
  }

  get failureCause() {
    return this.failureValue;
  }

  accept(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const message = value as Record<string, unknown>;
    if (
      message.version !== 1 ||
      message.startupId !== this.expectedStartupId ||
      typeof message.phase !== "string" ||
      !CHILD_PHASES.includes(message.phase as (typeof CHILD_PHASES)[number])
    )
      return false;

    const rank = startupPhaseRank.get(message.phase);
    if (rank === undefined) return false;
    if (message.kind === "phase") {
      if (
        Object.keys(message).length !== 4 ||
        this.failureValue ||
        rank <= this.phaseRank
      )
        return false;
      this.phaseValue = message.phase as StartupPhase;
      this.phaseRank = rank;
      return true;
    }
    if (
      message.kind !== "failure" ||
      Object.keys(message).length !== 5 ||
      this.failureValue ||
      rank !== this.phaseRank ||
      typeof message.cause !== "string" ||
      !startupCauseSet.has(message.cause)
    )
      return false;
    this.failureValue = message.cause as StartupCause;
    return true;
  }

  markAuthenticated() {
    this.phaseValue = "parent_authenticated";
    this.phaseRank = startupPhaseRank.get("parent_authenticated")!;
  }

  format(
    prefix: "OWNER_NOT_READY" | "OWNER_START_FAILED",
    elapsedMs: number,
    fallbackCause: StartupCause,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ) {
    const safeElapsed = Number.isFinite(elapsedMs)
      ? Math.max(0, Math.floor(elapsedMs))
      : 0;
    const cause = this.failureValue ?? fallbackCause;
    const parts = [
      prefix,
      `phase=${this.phaseValue}`,
      `elapsedMs=${safeElapsed}`,
      `cause=${cause}`,
    ];
    if (exitCode !== null && Number.isInteger(exitCode))
      parts.push(`exitCode=${exitCode}`);
    if (signal && nodeExitSignals.has(signal)) parts.push(`signal=${signal}`);
    return parts.join(" ");
  }
}

export function listenForStartupDiagnostics(
  source: { on(event: "message", listener: (message: unknown) => void): unknown; removeListener(event: "message", listener: (message: unknown) => void): unknown },
  diagnostics: StartupDiagnostics,
) {
  const listener = (message: unknown) => diagnostics.accept(message);
  source.on("message", listener);
  let listening = true;
  return () => {
    if (!listening) return;
    listening = false;
    source.removeListener("message", listener);
  };
}

export function createChildStartupReporter(startupId = startupIdFromEnvironment()) {
  let phase: StartupPhase = "child_bootstrap";
  const send = (message: StartupMessage) => {
    if (!startupId || !process.connected || !process.send) return Promise.resolve();
    return new Promise<void>((resolvePromise) => {
      try {
        process.send!(message, undefined, undefined, () => resolvePromise());
      } catch {
        resolvePromise();
      }
    });
  };
  const closeOwnedChannel = () => {
    if (startupId && process.connected) process.disconnect();
  };
  return {
    async phase(next: Exclude<StartupPhase, "child_spawn" | "parent_authenticated">) {
      phase = next;
      await send({ version: 1, startupId: startupId ?? "", kind: "phase", phase });
    },
    async fail(error: unknown) {
      await send({
        version: 1,
        startupId: startupId ?? "",
        kind: "failure",
        phase,
        cause: startupCauseFor(error),
      });
      closeOwnedChannel();
    },
  };
}
