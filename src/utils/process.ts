import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Shared promisified execFile — use this instead of re-creating in each module. */
export const execFileAsync = promisify(execFile);
