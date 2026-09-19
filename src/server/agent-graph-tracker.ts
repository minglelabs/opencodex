import { isThreadSpawnRequest } from "./effort-policy";
import type { RequestLogContext } from "./request-log";

export type AgentThreadStatus = "active" | "idle" | "completed" | "error";
export type AgentNodeStatus = "running" | "idle" | "completed" | "error";

export interface AgentNode {
  id: string;
  parentId: string | null;
  name: string;
  role: string;
  model: string;
  status: AgentNodeStatus;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  lastActiveAt: string;
  errorReason?: string;
  // Hierarchical view support for GUI / API clients
  children?: AgentNode[];
}

export interface AgentThread {
  id: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  status: AgentThreadStatus;
  agents: Record<string, AgentNode>;
}

export interface AgentGraphResponse {
  threads: Array<{
    id: string;
    title: string;
    name?: string;
    startedAt: string;
    updatedAt: string;
    status: AgentThreadStatus;
    root: AgentNode;
    agents: AgentNode[];
  }>;
  updatedAt: string;
}

const MAX_TRACKED_THREADS = 100;

export class AgentGraphTracker {
  private static instance: AgentGraphTracker | null = null;
  private threads = new Map<string, AgentThread>();

  public static getInstance(): AgentGraphTracker {
    if (!AgentGraphTracker.instance) {
      AgentGraphTracker.instance = new AgentGraphTracker();
    }
    return AgentGraphTracker.instance;
  }

  public static resetForTests(): void {
    AgentGraphTracker.instance = new AgentGraphTracker();
  }

  /**
   * Extracts thread and agent identity from incoming request headers and context.
   */
  public resolveContext(headers: Headers, reqBody?: unknown): {
    threadId: string;
    agentId: string;
    parentId: string | null;
    isSubagent: boolean;
    role: string;
    name: string;
  } {
    const isSubagent = isThreadSpawnRequest(headers);
    const parentThreadHeader = headers.get("x-codex-parent-thread-id")?.trim();
    const threadIdHeader = headers.get("thread-id")?.trim();
    const sessionIdHeader = headers.get("session_id")?.trim() || headers.get("session-id")?.trim();

    let metaSubagentKind: string | undefined;
    let metaThreadId: string | undefined;
    const turnMetaRaw = headers.get("x-codex-turn-metadata");
    if (turnMetaRaw) {
      try {
        const parsed = JSON.parse(turnMetaRaw) as { subagent_kind?: string; thread_id?: string };
        metaSubagentKind = typeof parsed.subagent_kind === "string" ? parsed.subagent_kind : undefined;
        metaThreadId = typeof parsed.thread_id === "string" ? parsed.thread_id : undefined;
      } catch {
        // ignore malformed JSON
      }
    }

    // Thread ID resolution
    const threadId = parentThreadHeader || threadIdHeader || sessionIdHeader || metaThreadId || "default-session";

    // Agent ID and hierarchy resolution
    let agentId = "main-agent";
    let parentId: string | null = null;
    let role = "Coordinator";
    let name = "Main Agent";

    if (isSubagent || metaSubagentKind === "thread_spawn") {
      const specificId = threadIdHeader && threadIdHeader !== parentThreadHeader
        ? threadIdHeader
        : sessionIdHeader || (metaThreadId && metaThreadId !== parentThreadHeader ? metaThreadId : undefined);
      agentId = specificId ? `subagent-${specificId}` : `subagent-${Date.now()}`;
      parentId = "main-agent";
      role = "Worker";
      name = "Sub-agent";
    }

    return {
      threadId,
      agentId,
      parentId,
      isSubagent,
      role,
      name,
    };
  }

  public recordRequestStart(params: {
    threadId: string;
    agentId: string;
    parentId?: string | null;
    name?: string;
    role?: string;
    model: string;
  }): void {
    const now = new Date().toISOString();
    let thread = this.threads.get(params.threadId);

    if (!thread) {
      // LRU eviction if capacity exceeded
      if (this.threads.size >= MAX_TRACKED_THREADS) {
        const oldestKey = this.threads.keys().next().value;
        if (oldestKey !== undefined) this.threads.delete(oldestKey);
      }
      thread = {
        id: params.threadId,
        title: `Thread ${params.threadId.length > 12
          ? `${params.threadId.slice(0, 8)}…${params.threadId.slice(-4)}`
          : params.threadId}`,
        startedAt: now,
        updatedAt: now,
        status: "active",
        agents: {},
      };
      this.threads.set(params.threadId, thread);
    } else {
      thread.updatedAt = now;
      if (thread.status !== "active") {
        thread.status = "active";
      }
    }

    let agent = thread.agents[params.agentId];
    if (!agent) {
      agent = {
        id: params.agentId,
        parentId: params.parentId ?? null,
        name: params.name || (params.parentId ? "Sub-agent" : "Main Agent"),
        role: params.role || (params.parentId ? "Worker" : "Coordinator"),
        model: params.model,
        status: "running",
        turnCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        lastActiveAt: now,
      };
      thread.agents[params.agentId] = agent;
    } else {
      agent.status = "running";
      agent.turnCount += 1;
      agent.lastActiveAt = now;
      if (params.model && params.model !== "unknown") {
        agent.model = params.model;
      }
    }
  }

  public updateRequestModel(params: {
    threadId: string;
    agentId: string;
    model: string;
  }): void {
    const model = params.model.trim();
    if (!model || model === "unknown") return;
    const thread = this.threads.get(params.threadId);
    const agent = thread?.agents[params.agentId];
    if (!thread || !agent) return;
    agent.model = model;
    const now = new Date().toISOString();
    agent.lastActiveAt = now;
    thread.updatedAt = now;
  }

  public recordRequestEnd(params: {
    threadId: string;
    agentId: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    status: number;
    errorReason?: string;
  }): void {
    const thread = this.threads.get(params.threadId);
    if (!thread) return;

    const now = new Date().toISOString();
    thread.updatedAt = now;

    const agent = thread.agents[params.agentId];
    if (agent) {
      agent.lastActiveAt = now;
      if (params.model && params.model !== "unknown") {
        agent.model = params.model;
      }
      if (params.inputTokens && params.inputTokens > 0) {
        agent.inputTokens += params.inputTokens;
      }
      if (params.outputTokens && params.outputTokens > 0) {
        agent.outputTokens += params.outputTokens;
      }

      if (params.status >= 400 && params.status !== 499) {
        agent.status = "error";
        agent.errorReason = params.errorReason || `HTTP ${params.status}`;
        thread.status = "error";
      } else {
        agent.status = "idle";
      }
    }

    // An error in one agent does not end the Thread while another agent is
    // still running. Keep the live graph visible until every agent settles.
    const agents = Object.values(thread.agents);
    if (agents.some(a => a.status === "running")) {
      thread.status = "active";
    } else if (agents.some(a => a.status === "error")) {
      thread.status = "error";
    } else {
      thread.status = "idle";
    }
  }

  /**
   * Keeps an agent running until the response body is consumed or cancelled.
   * Responses requests return before an SSE stream finishes, so recording the
   * request at the handler boundary would make the live graph look idle.
   */
  public trackResponse(
    response: Response,
    params: {
      threadId: string;
      agentId: string;
      model?: string;
      getModel?: () => string;
      getUsage?: () => { inputTokens?: number; outputTokens?: number };
      abortSignal?: AbortSignal;
    },
  ): Response {
    const finish = (status: number, errorReason?: string) => {
      const usage = params.getUsage?.();
      this.recordRequestEnd({
        threadId: params.threadId,
        agentId: params.agentId,
        model: params.getModel?.() || params.model,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        status,
        errorReason,
      });
    };

    let settled = false;
    let removeAbortListener: (() => void) | undefined;
    const settle = (status: number, errorReason?: string) => {
      if (settled) return;
      settled = true;
      removeAbortListener?.();
      finish(status, errorReason);
    };

    if (params.abortSignal) {
      const onAbort = () => settle(499, "client_cancel");
      if (params.abortSignal.aborted) {
        settle(499, "client_cancel");
      } else {
        params.abortSignal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => params.abortSignal?.removeEventListener("abort", onAbort);
      }
    }

    if (!response.body) {
      settle(response.status);
      return response;
    }

    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            settle(response.status);
            controller.close();
            return;
          }
          if (value) controller.enqueue(value);
        } catch (error) {
          settle(502, error instanceof Error ? error.name : "stream_error");
          try { controller.error(error); } catch { /* already torn down */ }
        }
      },
      async cancel(reason) {
        settle(499, "client_cancel");
        await reader.cancel(reason).catch(() => {});
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  public markThreadCompleted(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.status = "completed";
    thread.updatedAt = new Date().toISOString();
    for (const agent of Object.values(thread.agents)) {
      if (agent.status === "running" || agent.status === "idle") {
        agent.status = "completed";
      }
    }
  }

  public getSnapshot(): AgentGraphResponse {
    const now = new Date().toISOString();
    const resultThreads: AgentGraphResponse["threads"] = [];

    for (const thread of this.threads.values()) {
      // The graph is a live view. Completed requests remain in the tracker for
      // status/debugging, but must not be returned as active graph threads.
      if (thread.status !== "active") continue;
      const agentList = Object.values(thread.agents);
      if (agentList.length === 0) continue;

      // Find root (parentId === null) or create a synthetic root
      let rootAgent = agentList.find(a => a.parentId === null);
      if (!rootAgent) {
        rootAgent = agentList[0]!;
      }

      // Build hierarchical tree
      const agentMap = new Map<string, AgentNode>();
      for (const a of agentList) {
        agentMap.set(a.id, { ...a, children: [] });
      }

      const rootNode = agentMap.get(rootAgent.id)!;
      for (const a of agentMap.values()) {
        if (a.id !== rootNode.id && a.parentId && agentMap.has(a.parentId)) {
          agentMap.get(a.parentId)!.children!.push(a);
        } else if (a.id !== rootNode.id && a.parentId === null) {
          // If multiple roots, attach as child of main root
          rootNode.children!.push(a);
        }
      }

      resultThreads.push({
        id: thread.id,
        title: thread.title,
        name: thread.title,
        startedAt: thread.startedAt,
        updatedAt: thread.updatedAt,
        status: thread.status,
        root: rootNode,
        agents: Array.from(agentMap.values()),
      });
    }

    return {
      threads: resultThreads,
      updatedAt: now,
    };
  }
}

export const agentGraphTracker = AgentGraphTracker.getInstance();
