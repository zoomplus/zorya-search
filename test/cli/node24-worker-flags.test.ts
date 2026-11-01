import test from "node:test";
import assert from "node:assert/strict";
import {
  NODE24_PGLITE_WRAPPER_BUDGET_FLAG,
  node24DaemonExecArgv,
} from "../../src/cli/node24.js";

test("Node 24 owned daemons receive the wrapper budget flag only when needed", () => {
  assert.deepEqual(node24DaemonExecArgv("24.12.0"), [
    NODE24_PGLITE_WRAPPER_BUDGET_FLAG,
  ]);
  assert.deepEqual(node24DaemonExecArgv("22.23.2"), []);
  assert.deepEqual(node24DaemonExecArgv("25.0.0"), []);
});

test("Node 24 test workers receive the explicit wrapper budget flag", () => {
  if (process.env.ZORYA_TEST_NODE24 !== "1") return;
  assert.ok(process.execArgv.includes(NODE24_PGLITE_WRAPPER_BUDGET_FLAG));
  assert.ok(process.execArgv.includes("--import"));
  assert.ok(process.execArgv.includes("tsx"));
});
