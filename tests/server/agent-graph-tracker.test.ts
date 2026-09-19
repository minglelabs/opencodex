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
  });
});
