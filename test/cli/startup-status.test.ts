import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  listenForStartupDiagnostics,
  StartupDiagnostics,
} from "../../src/cli/startup-status.js";

const startupId = "a".repeat(32);

test("startup diagnostics accept only fresh, ordered, finite child events", () => {
  const diagnostics = new StartupDiagnostics(startupId);
  assert.equal(
    diagnostics.accept({
      version: 1,
      startupId,
      kind: "phase",
      phase: "child_bootstrap",
    }),
    true,
  );
  assert.equal(
    diagnostics.accept({
      version: 1,
      startupId: "b".repeat(32),
      kind: "phase",
      phase: "runtime_start",
    }),
    false,
  );
  const inheritedMessage = Object.create({
    version: 1,
    startupId,
    kind: "phase",
    phase: "runtime_start",
  });
  assert.equal(diagnostics.accept(inheritedMessage), false);
  assert.equal(
    diagnostics.accept({
      version: 1,
      startupId,
      kind: "phase",
      phase: "runtime_import",
      path: "C:\\private\\config.json",
    }),
    false,
  );
  assert.equal(
    diagnostics.accept({
      version: 1,
      startupId,
      kind: "phase",
      phase: "runtime_import",
    }),
    true,
  );
  assert.equal(
    diagnostics.accept({
      version: 1,
      startupId,
      kind: "phase",
      phase: "child_bootstrap",
    }),
    false,
  );
  assert.equal(
    diagnostics.accept({
      version: 1,
      startupId,
      kind: "phase",
      phase: "unknown_phase",
    }),
    false,
  );

  assert.equal(diagnostics.phase, "runtime_import");
  assert.equal(diagnostics.failureCause, undefined);
});

test("startup diagnostics report stalled and known failure phases without secret text", () => {
  const cold = new StartupDiagnostics(startupId);
  assert.equal(
    cold.format("OWNER_NOT_READY", 15_000, "READINESS_TIMEOUT", null, null),
    "OWNER_NOT_READY phase=child_spawn elapsedMs=15000 cause=READINESS_TIMEOUT",
  );

  const stalled = new StartupDiagnostics(startupId);
  assert.equal(
    stalled.accept({
      version: 1,
      startupId,
      kind: "phase",
      phase: "runtime_start",
    }),
    true,
  );
  const stalledMessage = stalled.format(
    "OWNER_NOT_READY",
    15_000,
    "READINESS_TIMEOUT",
    null,
    null,
  );
  assert.equal(
    stalledMessage,
    "OWNER_NOT_READY phase=runtime_start elapsedMs=15000 cause=READINESS_TIMEOUT",
  );

  const failed = new StartupDiagnostics(startupId);
  assert.equal(
    failed.accept({
      version: 1,
      startupId,
      kind: "phase",
      phase: "runtime_start",
    }),
    true,
  );
  assert.equal(
    failed.accept({
      version: 1,
      startupId,
      kind: "failure",
      phase: "runtime_start",
      cause: "EACCES",
    }),
    true,
  );
  const failedMessage = failed.format(
    "OWNER_NOT_READY",
    920,
    "READINESS_TIMEOUT",
    1,
    "SIGTERM",
  );
  assert.match(
    failedMessage,
    /^OWNER_NOT_READY phase=runtime_start elapsedMs=920 cause=EACCES exitCode=1 signal=SIGTERM$/,
  );
  assert.doesNotMatch(failedMessage, /private|config\.json|token|secret/i);
  assert.equal(
    failed.accept({
      version: 1,
      startupId,
      kind: "failure",
      phase: "runtime_start",
      cause: "UNKNOWN",
      detail: "secret value",
    }),
    false,
  );
});

test("startup message listener is removed after owner handoff", () => {
  const child = new EventEmitter();
  const diagnostics = new StartupDiagnostics(startupId);
  const removeListener = listenForStartupDiagnostics(child, diagnostics);
  assert.equal(child.listenerCount("message"), 1);
  child.emit("message", {
    version: 1,
    startupId,
    kind: "phase",
    phase: "daemon_ready",
  });
  assert.equal(diagnostics.phase, "daemon_ready");

  removeListener();
  removeListener();
  child.emit("message", {
    version: 1,
    startupId,
    kind: "phase",
    phase: "control_listen",
  });
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(diagnostics.phase, "daemon_ready");
});
