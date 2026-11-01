export const NODE24_PGLITE_WRAPPER_BUDGET_FLAG =
  "--wasm-wrapper-tiering-budget=1000000000";

export function node24DaemonExecArgv(
  nodeVersion: string,
): string[] {
  const major = Number.parseInt(nodeVersion.split(".")[0] ?? "", 10);
  return major === 24 ? [NODE24_PGLITE_WRAPPER_BUDGET_FLAG] : [];
}
