// Offline host check: node --experimental-strip-types bywork/work/notification-batching/probe.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerCompletionSource } from "../../../shared/completion-delivery.ts";

for (const mode of ["old-followUp", "shared-busy", "shared-idle", "shared-settled"]) {
  const dir = mkdtempSync(join(tmpdir(), "pi-completion-probe-"));
  let session;
  try {
    const faux = fauxProvider();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath: null,
      modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const seen = [];
    faux.setResponses(Array.from({ length: 6 }, () => (context) => {
      seen.push(JSON.stringify(context.messages));
      return fauxAssistantMessage("ok");
    }));
    const settingsManager = SettingsManager.inMemory({
      steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
      compaction: { enabled: false }, retry: { enabled: false },
    });
    let flush;
    let injected = false;
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      systemPromptOverride: () => "Offline delivery probe.",
      extensionFactories: [(pi) => {
        const messages = ["SHELL_RESULT", "CHILD_ONE", "CHILD_TWO"].map((content, index) => ({
          customType: index === 0 ? "background-exit" : "subagent-notify", content, display: true, details: { index },
        }));
        const register = (id, entries) => registerCompletionSource(id, {
          sessionId: () => "probe-parent",
          send: (message, options) => pi.sendMessage(message, options),
          pending: () => entries.map((message) => ({
            message, delivered: () => entries.splice(entries.indexOf(message), 1),
          })),
        });
        const shell = register("probe-shell", messages.slice(0, 1));
        const child = register("probe-child", messages.slice(1));
        flush = () => {
          if (mode === "old-followUp") {
            for (const message of messages) pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
          } else {
            shell.flush();
            child.flush();
          }
        };
        pi.on("turn_end", () => {
          if (mode === "shared-idle" || mode === "shared-settled" || injected) return;
          injected = true;
          flush();
        });
        pi.on("agent_settled", () => {
          if (mode !== "shared-settled" || injected) return;
          injected = true;
          flush();
        });
      }],
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel(), thinkingLevel: "off",
      resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir), tools: [],
    }));
    await session.bindExtensions({});
    await session.prompt("Start the probe.");
    if (mode === "shared-idle") {
      flush();
      await session.waitForIdle();
    }
    const expected = mode === "old-followUp" ? 4 : 2;
    assert.equal(faux.state.callCount, expected, mode + ": model requests");
    if (mode !== "old-followUp") {
      for (const marker of ["SHELL_RESULT", "CHILD_ONE", "CHILD_TWO"]) assert.ok(seen[1].includes(marker), marker);
    }
    const cards = session.messages.filter((message) => message.role === "custom");
    assert.deepEqual(cards.map((message) => message.details.index), [0, 1, 2]);
    console.log(mode + ": " + faux.state.callCount + " model requests, all three replay cards retained");
  } finally {
    session?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}
