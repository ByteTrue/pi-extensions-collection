import { afterEach, describe, expect, it, vi } from "vitest";

import { buildByspaceReportRecord, ByspaceReporter } from "./byspace-report.js";
import type { SubagentTaskRecord } from "./index.js";

function makeTask(
  overrides: Partial<SubagentTaskRecord> = {},
): SubagentTaskRecord {
  return {
    id: "sub_abc123",
    parentSessionId: "parent-1",
    description: "review the diff",
    agent: "explore",
    status: "running",
    output: "",
    startedAt: 1000,
    controller: new AbortController(),
    notifyOnExit: false,
    ...overrides,
  };
}

function makeRun(sessionId: string, cwd: string) {
  return {
    id: "run-1",
    agent: "explore",
    prompt: "t",
    sessionId,
    cwd,
    status: "running",
    finalText: "",
    textTail: "",
    thinkingTail: "",
    stderrTail: "",
    tools: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      ctxTokens: 0,
      turns: 0,
    },
  };
}

describe("buildByspaceReportRecord", () => {
  it("carries the child session reference from the first run", () => {
    const task = makeTask({
      progress: {
        kind: "subagent-progress",
        agent: "explore",
        runs: [makeRun("child-session", "/repo")],
      } as unknown as SubagentTaskRecord["progress"],
    });
    expect(
      buildByspaceReportRecord(task, (run) => `/logs/${run.sessionId}.jsonl`),
    ).toEqual({
      id: "sub_abc123",
      status: "running",
      sessionId: "child-session",
      cwd: "/repo",
      sessionFile: "/logs/child-session.jsonl",
    });
  });

  it("resolves the session log in the child profile", () => {
    const task = makeTask({
      progress: {
        kind: "subagent-progress",
        runs: [{ ...makeRun("child-session", "/repo"), agentDir: "/child-profile" }],
      } as unknown as SubagentTaskRecord["progress"],
    });
    expect(buildByspaceReportRecord(task, (run) => `${run.agentDir ?? "/parent-profile"}/${run.sessionId}.jsonl`).sessionFile)
      .toBe("/child-profile/child-session.jsonl");
  });

  it("uses launch pointers when a fast child never emitted progress", () => {
    const task = makeTask({ sessionId: "launch-session", cwd: "/launch-cwd" });
    expect(buildByspaceReportRecord(task, (run) => `/logs/${run.sessionId}.jsonl`)).toEqual({
      id: "sub_abc123",
      status: "running",
      sessionId: "launch-session",
      cwd: "/launch-cwd",
      sessionFile: "/logs/launch-session.jsonl",
    });
  });

  it("omits session fields before the child reports its session", () => {
    expect(buildByspaceReportRecord(makeTask())).toEqual({
      id: "sub_abc123",
      status: "running",
    });
  });
});

describe("ByspaceReporter", () => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(null, { status: 204 })),
  );

  afterEach(async () => {
    vi.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve));
    fetchMock.mockClear();
    vi.unstubAllGlobals();
  });

  function reporterWith(env: NodeJS.ProcessEnv) {
    vi.stubGlobal("fetch", fetchMock);
    return new ByspaceReporter(env);
  }

  it("is disabled without the BySpace env pair and never fetches", () => {
    const reporter = reporterWith({ BYSPACE_SUBAGENT_REPORT_URL: "http://x" });
    reporter.report({ id: "sub_1", status: "running" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the token-only envelope to the report URL", () => {
    const reporter = reporterWith({
      BYSPACE_SUBAGENT_REPORT_URL:
        "http://127.0.0.1:6778/api/subagent-report",
      BYSPACE_SUBAGENT_REPORT_TOKEN: "tok",
    });
    reporter.report({ id: "sub_1", status: "failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://127.0.0.1:6778/api/subagent-report");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      token: "tok",
      observations: [{ id: "sub_1", status: "failed" }],
    });
  });

  it("throttles same-status repeats but always sends status changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const reporter = reporterWith({
      BYSPACE_SUBAGENT_REPORT_URL: "http://x/report",
      BYSPACE_SUBAGENT_REPORT_TOKEN: "tok",
    });
    const record = { id: "sub_1", status: "running" } as const;
    reporter.report(record);
    vi.setSystemTime(200);
    reporter.report(record);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(400);
    reporter.report({ id: "sub_1", status: "succeeded" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    vi.setSystemTime(1200);
    reporter.report({ id: "sub_1", status: "succeeded" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("queues terminal state behind in-flight progress without blocking other tasks", async () => {
    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const reporter = reporterWith({
      BYSPACE_SUBAGENT_REPORT_URL: "http://x/report",
      BYSPACE_SUBAGENT_REPORT_TOKEN: "tok",
    });
    reporter.report({ id: "sub_1", status: "running" });
    reporter.report({ id: "sub_1", status: "succeeded" });
    reporter.report({ id: "sub_2", status: "running" });
    const observations = () => fetchMock.mock.calls.map((args) =>
      JSON.parse(String((args as unknown as [string, RequestInit])[1].body)).observations[0],
    );
    expect(observations()).toEqual([
      { id: "sub_1", status: "running" },
      { id: "sub_2", status: "running" },
    ]);
    release(new Response(null, { status: 204 }));
    await vi.waitFor(() => expect(observations().at(-1)).toEqual({ id: "sub_1", status: "succeeded" }));
  });

  it("keeps report ordering across a reload", async () => {
    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const env = { BYSPACE_SUBAGENT_REPORT_URL: "http://x/reload", BYSPACE_SUBAGENT_REPORT_TOKEN: "tok" };
    reporterWith(env).report({ id: "sub_reload", status: "running" });
    vi.resetModules();
    const { ByspaceReporter: ReloadedReporter } = await import("./byspace-report.js");
    new ReloadedReporter(env).report({ id: "sub_reload", status: "succeeded" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(new Response(null, { status: 204 }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)).observations[0].status)
      .toBe("succeeded");
  });

  it("does not let an older failure clear the latest running snapshot", async () => {
    let reject!: (error: Error) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const reporter = reporterWith({
      BYSPACE_SUBAGENT_REPORT_URL: "http://x/report",
      BYSPACE_SUBAGENT_REPORT_TOKEN: "tok",
    });
    reporter.report({ id: "sub_1", status: "running" });
    const latest = { id: "sub_1", status: "running", sessionId: "child" } as const;
    reporter.report(latest);
    reject(new Error("offline"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    reporter.report(latest);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows an identical running report after a rejected attempt", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const reporter = reporterWith({
      BYSPACE_SUBAGENT_REPORT_URL: "http://x/report",
      BYSPACE_SUBAGENT_REPORT_TOKEN: "tok",
    });
    const record = { id: "sub_1", status: "running" } as const;
    reporter.report(record);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));

    reporter.report(record);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 500 });
  });

  it("retries a terminal report after rejection", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const reporter = reporterWith({
      BYSPACE_SUBAGENT_REPORT_URL: "http://x/report",
      BYSPACE_SUBAGENT_REPORT_TOKEN: "tok",
    });
    reporter.report({ id: "sub_1", status: "failed" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 500 });
  });

  it("treats a non-OK terminal response as failed and retries it", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const reporter = reporterWith({
      BYSPACE_SUBAGENT_REPORT_URL: "http://x/report",
      BYSPACE_SUBAGENT_REPORT_TOKEN: "tok",
    });
    reporter.report({ id: "sub_1", status: "failed" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 500 });
  });

  it("swallows fetch rejections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("down"))),
    );
    const reporter = new ByspaceReporter({
      BYSPACE_SUBAGENT_REPORT_URL: "http://x/report",
      BYSPACE_SUBAGENT_REPORT_TOKEN: "tok",
    });
    expect(() =>
      reporter.report({ id: "sub_1", status: "running" }),
    ).not.toThrow();
    await vi.waitFor(() => {}, 0);
  });
});
