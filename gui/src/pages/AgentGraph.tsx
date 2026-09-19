import { useEffect, useMemo, useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { readJsonOrThrow } from "../fetch-json";
import { IconActivity, IconBot, IconRefresh, IconX } from "../icons";
import { useI18n, useT } from "../i18n/shared";
import "../styles-agent-graph.css";

type AgentStatus = "running" | "waiting" | "completed" | "error";

interface AgentNode {
  id: string;
  name: string;
  role: string;
  model: string;
  status: AgentStatus;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  sessionId: string;
  recentError: string;
  children: AgentNode[];
}

interface AgentThread {
  id: string;
  name: string;
  status: AgentStatus;
  updatedAt: string;
  root: AgentNode;
}

interface AgentGraphState {
  threads: AgentThread[];
  updatedAt: string;
}

type Dict = Record<string, unknown>;

const EMPTY_STATE: AgentGraphState = { threads: [], updatedAt: "" };
interface GraphCopy {
  title: string; subtitle: string; refresh: string; refreshing: string; updated: string;
  running: string; waiting: string; completed: string; error: string; threads: string;
  agents: string; tokens: string; turns: string; elapsed: string; model: string; role: string;
  session: string; recentError: string; noError: string; selectNode: string; empty: string;
  loadFailed: string; retry: string; close: string; liveWorkflow: string; polling: string;
  thread: string; agentDetail: string; tokensIn: string; tokensOut: string;
}

function asDict(value: unknown): Dict | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Dict : null;
}

function readString(value: Dict, keys: string[], fallback: string): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return fallback;
}

function readNumber(value: Dict, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return fallback;
}

function normalizeStatus(value: unknown): AgentStatus {
  const status = typeof value === "string" ? value.toLowerCase().replace(/[ -]/g, "_") : "waiting";
  if (["running", "active", "in_progress", "working", "streaming"].includes(status)) return "running";
  if (["error", "failed", "failure", "errored"].includes(status)) return "error";
  if (["completed", "complete", "done", "success", "succeeded", "stopped"].includes(status)) return "completed";
  return "waiting";
}

function childRows(value: Dict): unknown[] {
  for (const key of ["children", "subagents", "subAgents", "agents", "nodes", "delegates"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function normalizeNode(raw: unknown, fallbackId: string, index = 0): AgentNode {
  const value = asDict(raw) ?? {};
  const inputTokens = readNumber(value, ["inputTokens", "input_tokens", "tokensIn", "tokens_in"]);
  const outputTokens = readNumber(value, ["outputTokens", "output_tokens", "tokensOut", "tokens_out"]);
  const rawChildren = childRows(value);
  return {
    id: readString(value, ["id", "agentId", "agent_id", "nodeId", "node_id"], `${fallbackId}-agent-${index + 1}`),
    name: readString(value, ["name", "agentName", "agent_name", "label", "title"], `${fallbackId}-agent-${index + 1}`),
    role: readString(value, ["role", "purpose", "description", "task"], index === 0 ? "coordinator" : "delegate"),
    model: readString(value, ["model", "modelName", "model_name"], "unknown-model"),
    status: normalizeStatus(value.status ?? value.state),
    turns: readNumber(value, ["turns", "turnCount", "turn_count", "iterations"]),
    inputTokens,
    outputTokens,
    elapsedMs: readNumber(value, ["elapsedMs", "elapsed_ms", "durationMs", "duration_ms", "duration"]),
    sessionId: readString(value, ["sessionId", "session_id", "threadId", "thread_id"], "—"),
    recentError: readString(value, ["recentError", "recent_error", "error", "lastError", "last_error"], ""),
    children: rawChildren.map((child, childIndex) => normalizeNode(child, fallbackId, childIndex + 1)),
  };
}

function normalizeThread(raw: unknown, index: number): AgentThread {
  const value = asDict(raw) ?? {};
  const id = readString(value, ["id", "threadId", "thread_id", "sessionId", "session_id"], `thread-${index + 1}`);
  const rootCandidate = value.root ?? value.mainAgent ?? value.main_agent ?? value.agent ?? value.main ?? value.node ?? value;
  const root = normalizeNode(rootCandidate, id);
  if (root.children.length === 0) {
    const children = childRows(value);
    root.children = children
      .filter(child => {
        const childValue = asDict(child);
        if (!childValue) return true;
        return readString(childValue, ["id", "agentId", "agent_id", "nodeId", "node_id"], "") !== root.id;
      })
      .map((child, childIndex) => normalizeNode(child, id, childIndex + 1));
  }
  return {
    id,
    name: readString(value, ["name", "title", "label", "threadName", "thread_name"], `thread-${index + 1}`),
    status: normalizeStatus(value.status ?? value.state ?? root.status),
    updatedAt: readString(value, ["updatedAt", "updated_at", "lastUpdated", "last_updated"], ""),
    root,
  };
}

function normalizeGraph(payload: unknown): AgentGraphState {
  const value = asDict(payload);
  const candidates = Array.isArray(payload)
    ? payload
    : value && ["threads", "sessions", "workflows", "items"].map(key => value[key]).find(Array.isArray);
  const threads = (Array.isArray(candidates) ? candidates : []).map(normalizeThread);
  return {
    threads,
    updatedAt: value ? readString(value, ["updatedAt", "updated_at", "timestamp"], new Date().toISOString()) : new Date().toISOString(),
  };
}

function flattenNode(node: AgentNode): AgentNode[] {
  return [node, ...node.children.flatMap(flattenNode)];
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatDuration(value: number): string {
  if (!value) return "—";
  const seconds = Math.max(0, Math.round(value > 100_000 ? value / 1000 : value));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatUpdated(value: string, locale: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function StatusBadge({ status, copy }: { status: AgentStatus; copy: GraphCopy }) {
  const label = copy[status];
  return <span className={`agent-graph-status agent-graph-status--${status}`}><span className="agent-graph-status-dot" />{label}</span>;
}

function AgentNodeCard({ node, copy, onSelect, selectedId }: { node: AgentNode; copy: GraphCopy; onSelect: (node: AgentNode) => void; selectedId: string | null }) {
  const totalTokens = node.inputTokens + node.outputTokens;
  return (
    <div className="agent-graph-node-branch">
      <button type="button" className={`agent-graph-node-card${selectedId === node.id ? " is-selected" : ""}`} onClick={() => onSelect(node)}>
        <span className="agent-graph-node-topline"><span className="agent-graph-node-icon"><IconBot width={14} height={14} /></span><StatusBadge status={node.status} copy={copy} /></span>
        <span className="agent-graph-node-name">{node.name}</span>
        <span className="agent-graph-node-role">{node.role}</span>
        <span className="agent-graph-model-wrap"><span className="agent-graph-model-label">{copy.model}</span><span className="agent-graph-model">{node.model}</span></span>
        <span className="agent-graph-node-metrics"><span>{node.turns} {copy.turns}</span><span>{formatCompact(totalTokens)} {copy.tokens}</span><span>{formatDuration(node.elapsedMs)}</span></span>
      </button>
      {node.children.length > 0 && <div className="agent-graph-children">{node.children.map(child => <AgentNodeCard key={child.id} node={child} copy={copy} onSelect={onSelect} selectedId={selectedId} />)}</div>}
    </div>
  );
}

export default function AgentGraph({ apiBase }: { apiBase: string }) {
  const { locale } = useI18n();
  const t = useT();
  const copy: GraphCopy = {
    title: t("agentGraph.title"), subtitle: t("agentGraph.subtitle"), refresh: t("agentGraph.refresh"),
    refreshing: t("agentGraph.refreshing"), updated: t("agentGraph.updated"), running: t("agentGraph.running"),
    waiting: t("agentGraph.waiting"), completed: t("agentGraph.completed"), error: t("agentGraph.error"),
    threads: t("agentGraph.threads"), agents: t("agentGraph.agents"), tokens: t("agentGraph.tokens"),
    turns: t("agentGraph.turns"), elapsed: t("agentGraph.elapsed"), model: t("agentGraph.model"),
    role: t("agentGraph.role"), session: t("agentGraph.session"), recentError: t("agentGraph.recentError"),
    noError: t("agentGraph.noError"), selectNode: t("agentGraph.selectNode"), empty: t("agentGraph.empty"),
    loadFailed: t("agentGraph.loadFailed"), retry: t("common.retry"), close: t("common.close"),
    liveWorkflow: t("agentGraph.liveWorkflow"), polling: t("agentGraph.polling"), thread: t("agentGraph.thread"),
    agentDetail: t("agentGraph.agentDetail"), tokensIn: t("agentGraph.tokensIn"), tokensOut: t("agentGraph.tokensOut"),
  };
  const resource = useKeyedClientResource<AgentGraphState>(
    `agent-graph:${apiBase}`,
    [apiBase],
    async signal => {
      const response = await fetch(`${apiBase}/api/agent-graph`, { signal, cache: "no-store" });
      const payload = await readJsonOrThrow<unknown>(response, copy.loadFailed);
      return payload === undefined ? EMPTY_STATE : normalizeGraph(payload);
    },
    { pollMs: 3_000, deadlineMs: 10_000 },
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const state = resource.data ?? EMPTY_STATE;
  const nodes = useMemo(() => state.threads.flatMap(thread => flattenNode(thread.root)), [state.threads]);
  const selectedNode = nodes.find(node => node.id === selectedId) ?? null;
  const runningCount = nodes.filter(node => node.status === "running").length;
  const totalTokens = nodes.reduce((sum, node) => sum + node.inputTokens + node.outputTokens, 0);

  useEffect(() => {
    if (!selectedId || nodes.some(node => node.id === selectedId)) return;
    setSelectedId(null);
  }, [nodes, selectedId]);

  useEffect(() => {
    if (!selectedNode) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedId(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedNode]);

  return (
    <div className="agent-graph-page">
      <div className="page-head agent-graph-page-head">
        <div><div className="eyebrow"><IconActivity width={14} height={14} /> {copy.liveWorkflow}</div><h1 className="page-title">{copy.title}</h1><p className="page-sub">{copy.subtitle}</p></div>
        <button type="button" className="btn btn-secondary agent-graph-refresh" onClick={() => resource.refresh()} disabled={resource.refreshing}>
          <IconRefresh width={14} height={14} /> {resource.refreshing ? copy.refreshing : copy.refresh}
        </button>
      </div>
      <div className="agent-graph-toolbar"><span>{copy.updated} {formatUpdated(state.updatedAt, locale)}</span><span className="agent-graph-poll"><span className="agent-graph-live-dot" /> {copy.polling}</span></div>
      <section className="agent-graph-summary" aria-label={copy.title}>
        <div><span>{copy.threads}</span><strong>{state.threads.length}</strong></div>
        <div><span>{copy.agents}</span><strong>{nodes.length}</strong></div>
        <div><span>{copy.running}</span><strong className="agent-graph-summary-running">{runningCount}</strong></div>
        <div><span>{copy.tokens}</span><strong>{formatCompact(totalTokens)}</strong></div>
      </section>
      {Boolean(resource.error) && !resource.data && <div className="notice notice-error agent-graph-notice"><span>{copy.loadFailed}</span><button type="button" className="btn btn-secondary" onClick={() => resource.refresh({ forceLoading: true })}>{copy.retry}</button></div>}
      {resource.loading && !resource.data ? <div className="agent-graph-empty">{t("common.loading")}</div> : state.threads.length === 0 ? <div className="agent-graph-empty"><IconBot width={36} height={36} /><strong>{copy.empty}</strong><span>{copy.selectNode}</span></div> : (
        <div className="agent-graph-threads">{state.threads.map(thread => (
          <section className="agent-graph-thread" key={thread.id}>
            <header className="agent-graph-thread-head"><div><span className="agent-graph-thread-kicker">{copy.thread}</span><h2>{thread.name}</h2><code>{thread.id}</code></div><StatusBadge status={thread.status} copy={copy} /></header>
            <div className="agent-graph-tree"><AgentNodeCard node={thread.root} copy={copy} onSelect={node => setSelectedId(node.id)} selectedId={selectedId} /></div>
          </section>
        ))}</div>
      )}
      {selectedNode && <div className="agent-graph-detail-backdrop" role="presentation" onClick={() => setSelectedId(null)}>
        <aside className="agent-graph-detail" role="dialog" aria-modal="true" aria-label={selectedNode.name} onClick={event => event.stopPropagation()}>
          <div className="agent-graph-detail-head"><div><span className="agent-graph-thread-kicker">{copy.agentDetail}</span><h2>{selectedNode.name}</h2></div><button type="button" className="icon-btn" onClick={() => setSelectedId(null)} aria-label={copy.close} title={copy.close}><IconX width={16} height={16} /></button></div>
          <StatusBadge status={selectedNode.status} copy={copy} />
          <p className="agent-graph-detail-role">{selectedNode.role}</p>
          <dl className="agent-graph-detail-list"><div><dt>{copy.model}</dt><dd><code>{selectedNode.model}</code></dd></div><div><dt>{copy.session}</dt><dd><code>{selectedNode.sessionId}</code></dd></div><div><dt>{copy.turns}</dt><dd>{selectedNode.turns}</dd></div><div><dt>{copy.elapsed}</dt><dd>{formatDuration(selectedNode.elapsedMs)}</dd></div><div><dt>{copy.tokens}</dt><dd>{formatCompact(selectedNode.inputTokens)} {copy.tokensIn} / {formatCompact(selectedNode.outputTokens)} {copy.tokensOut}</dd></div></dl>
          <div className={`agent-graph-error-box${selectedNode.recentError ? " has-error" : ""}`}><span>{copy.recentError}</span><p>{selectedNode.recentError || copy.noError}</p></div>
        </aside>
      </div>}
    </div>
  );
}
