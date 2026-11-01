import { run } from "node:test";
import { spec } from "node:test/reporters";

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
if (nodeMajor !== 24) {
  process.stderr.write(
    `test:node24 requires Node 24; received ${process.versions.node}\n`,
  );
  process.exitCode = 2;
} else {
  process.env.ZORYA_TEST_NODE24 = "1";
  const abort = new AbortController();
  let interrupted = 0;
  const onInterrupt = (signal, code) => {
    interrupted = code;
    abort.abort(new Error(`Interrupted by ${signal}`));
  };
  const onSigint = () => onInterrupt("SIGINT", 130);
  const onSigterm = () => onInterrupt("SIGTERM", 143);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  let runnerFailed = false;
  const stream = run({
    globPatterns: ["test/**/*.test.ts"],
    concurrency: true,
    isolation: "process",
    execArgv: [
      "--wasm-wrapper-tiering-budget=1000000000",
      "--import",
      "tsx",
    ],
    signal: abort.signal,
  });
  stream.compose(spec()).pipe(process.stdout);
  stream.on("test:fail", () => {
    runnerFailed = true;
  });
  stream.on("test:summary", (summary) => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.exitCode = interrupted || (runnerFailed || !summary.success ? 1 : 0);
  });
  stream.on("error", (error) => {
    runnerFailed = true;
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.stderr.write(`Node 24 test runner failed: ${error.stack ?? error}\n`);
    process.exitCode = interrupted || 1;
  });
}
