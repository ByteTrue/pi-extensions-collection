import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { manager, runBackgroundCommand } from "./background-terminal.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const SESSION_ID = "background-command-test-session";

function makeContext(
  select: (title: string, options: string[]) => string | undefined,
  confirm = true,
) {
  const ui = {
    select: vi.fn(async (title: string, options: string[]) => select(title, options)),
    confirm: vi.fn(async () => confirm),
    editor: vi.fn(async (_title: string, _prefill: string) => undefined),
    notify: vi.fn(),
  };
  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => SESSION_ID },
    ui,
  } as unknown as ExtensionCommandContext;
  return { ctx, ui };
}

describe("/background command", () => {
  afterEach(async () => {
    await manager.clearSession(SESSION_ID);
  });

  it("lists a running command, opens its output, then returns through the menus", async () => {
    manager.init(() => {});
    const started = manager.start(
      'node -e "console.log(\'menu output\'); setInterval(() => {}, 1000)"',
      process.cwd(),
      SESSION_ID,
    );
    await vi.waitFor(() => expect(manager.get(started.id, SESSION_ID)?.tail).toContain("menu output"), { timeout: 8000 });

    let selectCount = 0;
    const { ctx, ui } = makeContext((_title, options) => {
      selectCount += 1;
      if (selectCount === 1) return options[0];
      if (selectCount === 2) {
        expect(options).toEqual(["View output", "Kill", "Back"]);
        return "View output";
      }
      return options.at(-1);
    });

    await runBackgroundCommand(ctx);

    expect(ui.editor).toHaveBeenCalledWith(expect.stringContaining("Output"), expect.stringContaining("menu output"));
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it.each(["long line", "many lines"])("shows a bounded recent preview for %s without reading the log", async (shape) => {
    manager.init(() => {});
    const output = shape === "long line"
      ? "old output\n" + "x".repeat(12_000) + "\n\x1b[31mnewest output\x1b[0m\n"
      : Array.from({ length: 100 }, (_, index) => "line " + index).join("\n") + "\n";
    const started = manager.start("unused", process.cwd(), SESSION_ID, {
      operations: { exec: async (_command, _cwd, { onData, signal }) => {
        onData(Buffer.from(output));
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      } },
    });
    let selections = 0;
    const { ctx, ui } = makeContext((_title, options) => {
      selections++;
      if (selections === 1) return options[0];
      if (selections === 2) return "View output";
      return options.at(-1);
    });
    vi.mocked(readFile).mockClear();

    await runBackgroundCommand(ctx);

    expect(readFile).not.toHaveBeenCalled();
    expect(ui.editor).toHaveBeenCalledWith(expect.stringContaining("Output preview"), expect.any(String));
    const preview = ui.editor.mock.calls[0]![1];
    expect(preview.length).toBeLessThan(4600 + started.outputPath.length);
    expect(preview).toContain(started.outputPath);
    expect(preview).toContain("50 MiB");
    expect(preview).toContain("[earlier output omitted]");
    expect(preview).not.toContain("\x1b");
    if (shape === "long line") {
      expect(preview).not.toContain("old output");
      expect(preview).toContain("newest output");
    } else {
      expect(preview).not.toContain("line 49\n");
      expect(preview).toContain("line 50\n");
      expect(preview).toContain("line 99");
    }
  });

  it("does not show finished commands in the management menu", async () => {
    manager.init(() => {});
    const started = manager.start("node -e \"\"", process.cwd(), SESSION_ID);
    await vi.waitFor(() => expect(manager.get(started.id, SESSION_ID)?.status).toBe("exited"), { timeout: 8000 });
    const { ctx, ui } = makeContext(() => undefined);

    await runBackgroundCommand(ctx);

    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("No running background commands.", "info");
  });

  it("kills the selected running command without asking the user for an id", async () => {
    manager.init(() => {});
    const started = manager.start('node -e "setInterval(() => {}, 1000)"', process.cwd(), SESSION_ID);

    let selectCount = 0;
    const { ctx, ui } = makeContext((_title, options) => {
      selectCount += 1;
      if (selectCount === 1) return options[0];
      if (selectCount === 2) return "Kill";
      return options.at(-1);
    });

    await runBackgroundCommand(ctx);

    await vi.waitFor(() => expect(manager.get(started.id, SESSION_ID)?.status).toBe("killed"), { timeout: 8000 });
    expect(ui.confirm).toHaveBeenCalledOnce();
    expect(ui.notify).toHaveBeenCalledWith("Background command stopped.", "info");
  });

  it("returns to the menu when stopping a command is canceled", async () => {
    manager.init(() => {});
    const started = manager.start('node -e "setInterval(() => {}, 1000)"', process.cwd(), SESSION_ID);

    let selectCount = 0;
    const { ctx, ui } = makeContext(
      (_title, options) => {
        selectCount += 1;
        if (selectCount === 1) return options[0];
        if (selectCount === 2) return "Kill";
        return options.at(-1);
      },
      false,
    );

    await runBackgroundCommand(ctx);

    expect(manager.get(started.id, SESSION_ID)?.status).toBe("running");
    expect(ui.confirm).toHaveBeenCalledOnce();
    expect(ui.notify).not.toHaveBeenCalled();
  });
});
