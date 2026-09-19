import { describe, expect, test } from "bun:test";
import { AgentGraphTracker } from "../../src/server/agent-graph-tracker";

describe("AgentGraphTracker", () => {
  test("records a main-agent request without subagent headers", () => {
    const tracker = new AgentGraphTracker();
    const context = tracker.resolveContext(new Headers({ "session-id": "main-session" }));

    expect(context).toMatchObject({
      threadId: "main-session",
      agentId: "main-agent",
      parentId: null,
      isSubagent: false,
    });

    tracker.recordRequestStart({
      ...context,
      model: "gpt-5.5",
    });

    expect(tracker.getSnapshot().threads[0]?.root).toMatchObject({
      id: "main-agent",
      status: "running",
      model: "gpt-5.5",
    });
  });

  test("keeps a main-agent stream running until its response body finishes", async () => {
    const tracker = new AgentGraphTracker();
    tracker.recordRequestStart({ threadId: "stream-session", agentId: "main-agent", model: "unknown" });

    const response = tracker.trackResponse(new Response(new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode("done"));
          controller.close();
        }, 20);
      },
    })), {
      threadId: "stream-session",
      agentId: "main-agent",
    });

    expect(tracker.getSnapshot().threads[0]?.root.status).toBe("running");
    await expect(response.text()).resolves.toBe("done");
    expect(tracker.getSnapshot().threads[0]?.root.status).toBe("idle");
    expect(tracker.getSnapshot().threads[0]?.status).toBe("idle");
  });

  test("keeps thread labels distinct when UUIDs share their first eight characters", () => {
    const tracker = new AgentGraphTracker();
    for (const threadId of [
      "01a0bac7-1111-1111-1111-aaaaaaaaaaaa",
      "01a0bac7-2222-2222-2222-bbbbbbbbbbbb",
    ]) {
      tracker.recordRequestStart({ threadId, agentId: "main-agent", model: "gpt-5.6-luna" });
    }

    const titles = tracker.getSnapshot().threads.map(thread => thread.title);
    expect(new Set(titles).size).toBe(2);
    expect(titles).toContain("Thread 01a0bac7…aaaa");
    expect(titles).toContain("Thread 01a0bac7…bbbb");
  });
});
