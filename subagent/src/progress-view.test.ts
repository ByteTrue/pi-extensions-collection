import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import type { SubagentTaskRecord } from "./index.js";
import { showProgressView } from "./progress-view.js";

const task = { id: "sub_progress_view", status: "running" } as SubagentTaskRecord;

it("shows a notification in RPC even when custom exists", async () => {
  const ui = { custom: vi.fn(), notify: vi.fn() };
  await showProgressView({ mode: "rpc", ui } as unknown as ExtensionCommandContext, task);
  expect(ui.custom).not.toHaveBeenCalled();
  expect(ui.notify).toHaveBeenCalledWith("(no progress yet)", "info");
});

it("fits narrow terminals and stops refreshing when the host disposes the view", async () => {
  vi.useFakeTimers();
  const requestRender = vi.fn();
  try {
    await showProgressView({
      mode: "tui",
      ui: { custom: async (create: Function) => {
        const view = create(
          { requestRender, terminal: { rows: 24 } },
          { fg: (_color: string, value: string) => value, bold: (value: string) => value },
          undefined, vi.fn(),
        );
        expect(view.render(12).every((line: string) => visibleWidth(line) <= 12)).toBe(true);
        vi.advanceTimersByTime(500);
        expect(requestRender).toHaveBeenCalledTimes(1);
        view.dispose();
        vi.advanceTimersByTime(1000);
        expect(requestRender).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } },
    } as unknown as ExtensionCommandContext, task);
  } finally {
    vi.useRealTimers();
  }
});
