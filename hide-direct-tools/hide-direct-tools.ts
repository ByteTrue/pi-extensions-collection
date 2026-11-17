/**
 * hide-direct-tools — make `codemode.mode: "only"` a hard single entry point.
 *
 * Pi 1.5.x hides direct-exposure tools from request declarations and from <tools>, and
 * marks skills' reader as indirect, but hidden tools stay active: a model that names one
 * anyway still gets it executed. This blocks every top-level call except `codemode`;
 * nested calls from a script carry `parentToolCallId` and pass. No-op unless mode is
 * "only".
 *
 * One <rules> bullet is the only prompt change needed — the tool list is filtered natively,
 * so no prompt parsing or section rewriting.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ONLY_GUIDELINE =
  "Only codemode is called directly; run every other tool from inside a codemode script.";

export default function registerHideDirectTools(pi: ExtensionAPI): void {
  const only = (): boolean => pi.getSettings().codemode?.mode === "only";

  pi.on("tool_call", (event) => {
    if (!only()) return;
    if (event.parentToolCallId) return; // nested call from a codemode script: allowed
    if (event.toolName === "codemode") return; // the only direct entry point
    return {
      block: true,
      reason:
        `${event.toolName} is not directly callable in codemode-only mode. ` +
        `Call it from inside a codemode script instead: await tools.${event.toolName}({ ... }).`,
    };
  });

  pi.on("before_agent_start", (event) => {
    if (!only()) return;
    event.systemPromptOptions.promptGuidelines.push(ONLY_GUIDELINE);
  });
}
