/**
 * bash-timeout — opencode-style default timeout for Pi's built-in bash/powershell tools.
 *
 * Loaded from the root pi manifest as part of this repository’s git package.
 * No build step or runtime imports; jiti loads TypeScript directly.
 *
 * Why it exists: Pi's built-in bash runs with no timeout unless the model passes one, so
 * a single runaway foreground command (`find /`) can wedge the agent for hours. opencode's
 * shell tool defaults foreground calls to 2 minutes and treats `timeout: 0` as an explicit
 * opt-out; this hook copies that contract onto pi's built-in tools.
 *
 * A tool_call hook sets the default timeout and handles explicit opt-outs.
 * No tool is registered, overridden, or executed here.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Default foreground timeout in seconds, matching opencode's shell tool. */
export const DEFAULT_TIMEOUT_SECONDS = 120;

/** An explicit timeout the model can have meant: finite and non-negative.
 * `0` is valid and disables the timeout (opencode's contract). Negative,
 * non-finite and non-number values count as absent and get the default. */
export function hasExplicitTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

type ShellToolInput = {
  timeout?: number;
};

/** Pi's built-in shell rejects a timeout above this (24.8 days); clamping keeps a
 * huge explicit value working instead of turning the tool call into an error.
 * This is the platform's limit, not the old 300s cap. */
const PI_MAX_TIMEOUT_SECONDS = 2_147_483;

export function registerBashDefaultTimeout(pi: ExtensionAPI): void {
  // Direct tool-name checks keep this hook free of runtime imports.
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") return;
    const input = event.input as ShellToolInput;
    if (input.timeout === 0) {
      // opencode spells "no timeout" as 0, but pi's built-in shell rejects <= 0.
      // Removing the parameter gives the same behavior: the built-in has no default.
      delete input.timeout;
      return;
    }
    if (!hasExplicitTimeout(input.timeout)) {
      input.timeout = DEFAULT_TIMEOUT_SECONDS;
    } else if (input.timeout > PI_MAX_TIMEOUT_SECONDS) {
      input.timeout = PI_MAX_TIMEOUT_SECONDS;
    }
  });
}

/** Extension entry point (jiti loads the default export). */
export default function registerBashTimeout(pi: ExtensionAPI): void {
  registerBashDefaultTimeout(pi);
}
