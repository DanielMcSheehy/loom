import { ArrowsOutSimple, FrameCorners } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { RunState, TaskSpec } from "../types";

const MIN_NODE_W = 168;
const MAX_NODE_W = 248;
const GAP_X = 72;
const GAP_Y = 24;
const PAD = 16;
const LINE_H = 15;
const MAX_LINES = 3;
// Rough glyph widths for the node fonts (12.5px semibold sans / 10.5px mono).
const SANS_CHAR = 6.9;
const MONO_CHAR = 6.3;
const TEXT_PAD = 14;

interface Placed {
  id: string;
  task: TaskSpec;
  x: number;
  y: number;
}

/** Layer tasks with Kahn's algorithm (mirrors the server's scheduler view). */
export function layerTasks(tasks: TaskSpec[]): string[][] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    indegree.set(t.id, t.depends_on.length);
    for (const dep of t.depends_on) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), t.id]);
    }
  }
  const layers: string[][] = [];
  let frontier = tasks.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  const seen = new Set<string>();
  while (frontier.length) {
    layers.push(frontier);
    const next: string[] = [];
    for (const id of frontier) {
      seen.add(id);
      for (const dep of dependents.get(id) ?? []) {
        indegree.set(dep, (indegree.get(dep) ?? 1) - 1);
        if (indegree.get(dep) === 0) next.push(dep);
      }
    }
    frontier = next;
  }
  // Cyclic leftovers (shouldn't exist — the server rejects them) get a layer.
  const leftovers = tasks.filter((t) => !seen.has(t.id)).map((t) => t.id);
  if (leftovers.length) layers.push(leftovers);
  return layers;
}

/** Greedy word wrap; the last permitted line is truncated with an ellipsis. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length <= maxChars) {
      cur = candidate;
      continue;
    }
    if (cur) lines.push(cur);
    // A single word longer than the line is hard-broken.
    let rest = w;
    while (rest.length > maxChars) {
      lines.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    cur = rest;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, Math.max(0, maxChars - 1))}…`;
    return kept;
  }
  return lines.length ? lines : [""];
}

function layout(tasks: TaskSpec[]) {
  const layers = layerTasks(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // Node width grows with the longest label (up to a cap); longer labels wrap.
  const longest = Math.max(0, ...tasks.map((t) => (t.name ?? t.id).length));
  const nodeW = Math.round(Math.min(MAX_NODE_W, Math.max(MIN_NODE_W, longest * SANS_CHAR + TEXT_PAD * 2)));
  const maxChars = Math.max(8, Math.floor((nodeW - TEXT_PAD * 2) / SANS_CHAR));
  const monoChars = Math.max(8, Math.floor((nodeW - TEXT_PAD * 2) / MONO_CHAR));
  const labels = new Map(tasks.map((t) => [t.id, wrap(t.name ?? t.id, maxChars, MAX_LINES)]));
  const lineCount = Math.max(1, ...[...labels.values()].map((l) => l.length));
  // 1 line → 52px (the classic node), each extra line adds LINE_H.
  const nodeH = 52 + (lineCount - 1) * LINE_H;

  const placed = new Map<string, Placed>();
  const maxRows = Math.max(1, ...layers.map((l) => l.length));
  const height = PAD * 2 + maxRows * nodeH + (maxRows - 1) * GAP_Y;
  layers.forEach((layer, col) => {
    const columnHeight = layer.length * nodeH + (layer.length - 1) * GAP_Y;
    const yStart = (height - columnHeight) / 2;
    layer.forEach((id, row) => {
      placed.set(id, { id, task: byId.get(id)!, x: PAD + col * (nodeW + GAP_X), y: yStart + row * (nodeH + GAP_Y) });
    });
  });
  const edges = tasks.flatMap((t) =>
    t.depends_on.filter((dep) => placed.has(dep)).map((dep) => ({ from: placed.get(dep)!, to: placed.get(t.id)! })),
  );
  const width = PAD * 2 + layers.length * nodeW + (layers.length - 1) * GAP_X;
  return { placed: [...placed.values()], edges, width, height, nodeW, nodeH, labels, monoChars };
}

function edgeClass(upstream?: RunState, downstream?: RunState): string {
  // `active`: results flowing into a running task — animated.
  // `done`: this hop completed. Plain otherwise.
  if (upstream === "completed" && downstream === "running") return " active";
  if (upstream === "completed" && downstream && downstream !== "pending") return " done";
  return "";
}

export default function DagGraph({
  tasks,
  states,
  selected,
  onSelect,
}: {
  tasks: TaskSpec[];
  states?: Record<string, RunState>;
  /** Highlighted task id (controlled by the page). */
  selected?: string | null;
  /** Nodes become clickable; the page decides what a click shows. */
  onSelect?: (taskId: string) => void;
}) {
  const g = useMemo(() => layout(tasks), [tasks]);
  // `fit` scales a wide graph down to the card width; `actual` keeps 1:1 and scrolls.
  const [mode, setMode] = useState<"fit" | "actual">("fit");
  const interactive = Boolean(onSelect);
  const { nodeW, nodeH } = g;

  return (
    <div className={`dag-wrap ${mode}`}>
      <div className="dag-tools">
        <div className="seg">
          <button className={mode === "fit" ? "on" : ""} onClick={() => setMode("fit")} title="Fit the graph to the available width">
            <FrameCorners size={12} /> Fit
          </button>
          <button className={mode === "actual" ? "on" : ""} onClick={() => setMode("actual")} title="Actual size (scroll horizontally)">
            <ArrowsOutSimple size={12} /> 1:1
          </button>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${g.width} ${g.height}`}
        width={mode === "actual" ? g.width : undefined}
        height={mode === "actual" ? g.height : undefined}
        style={mode === "fit" ? { width: "100%", maxWidth: g.width, height: "auto", display: "block" } : { display: "block" }}
        role="img"
        aria-label="Workflow task graph"
      >
        {g.edges.map(({ from, to }, i) => {
          const x1 = from.x + nodeW;
          const y1 = from.y + nodeH / 2;
          const x2 = to.x;
          const y2 = to.y + nodeH / 2;
          const mx = (x1 + x2) / 2;
          return <path key={i} className={`dag-edge${edgeClass(states?.[from.id], states?.[to.id])}`} d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} />;
        })}
        {g.placed.map(({ id, task, x, y }) => {
          const lines = g.labels.get(id) ?? [id];
          const deps = task.depends_on.length ? ` ← ${task.depends_on.join(", ")}` : "";
          const rt = `${task.runtime}${deps}`;
          const rtText = rt.length > g.monoChars ? `${rt.slice(0, g.monoChars - 1)}…` : rt;
          const isSel = selected === id;
          return (
            <g
              key={id}
              className={`dag-node ${states?.[id] ?? ""}${isSel ? " selected" : ""}${interactive ? " clickable" : ""}`}
              transform={`translate(${x},${y})`}
              role={interactive ? "button" : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-pressed={interactive ? isSel : undefined}
              aria-label={interactive ? `Task ${task.name ?? id}` : undefined}
              onClick={interactive ? () => onSelect?.(id) : undefined}
              onKeyDown={
                interactive
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect?.(id);
                      }
                    }
                  : undefined
              }
            >
              <title>{`${task.name ?? id} (${id}) · ${task.runtime}${states?.[id] ? ` · ${states[id]}` : ""}`}</title>
              <rect width={nodeW} height={nodeH} rx="8" />
              {states && <circle className="state-dot" cx={nodeW - 14} cy={16} r={4} />}
              <text x={TEXT_PAD} y={22}>
                {lines.map((line, i) => (
                  <tspan key={i} x={TEXT_PAD} dy={i === 0 ? 0 : LINE_H}>
                    {line}
                  </tspan>
                ))}
              </text>
              <text className="rt" x={TEXT_PAD} y={22 + (lines.length - 1) * LINE_H + 17}>
                {rtText}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── compact preview (workflow cards) ───────────────────────────────────

const MINI_H = 20;
const MINI_GAP_X = 26;
const MINI_GAP_Y = 8;
const MINI_PAD = 4;
const MINI_CHAR = 6.3;
const MINI_MAX_CHARS = 16;

/** Tiny read-only DAG: task ids as runtime-tinted chips with edges. Scales to its container. */
export function MiniDag({ tasks, states, maxHeight = 120 }: { tasks: TaskSpec[]; states?: Record<string, RunState>; maxHeight?: number }) {
  const g = useMemo(() => {
    const layers = layerTasks(tasks);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const label = (id: string) => (id.length > MINI_MAX_CHARS ? `${id.slice(0, MINI_MAX_CHARS - 1)}…` : id);
    const widthOf = (id: string) => Math.round(label(id).length * MINI_CHAR + 24);
    const colW = layers.map((l) => Math.max(...l.map(widthOf)));
    const maxRows = Math.max(1, ...layers.map((l) => l.length));
    const height = MINI_PAD * 2 + maxRows * MINI_H + (maxRows - 1) * MINI_GAP_Y;
    const placed = new Map<string, { id: string; task: TaskSpec; x: number; y: number; w: number; text: string }>();
    let x = MINI_PAD;
    layers.forEach((layer, col) => {
      const colHeight = layer.length * MINI_H + (layer.length - 1) * MINI_GAP_Y;
      const yStart = (height - colHeight) / 2;
      layer.forEach((id, row) => {
        placed.set(id, { id, task: byId.get(id)!, x, y: yStart + row * (MINI_H + MINI_GAP_Y), w: widthOf(id), text: label(id) });
      });
      x += colW[col] + MINI_GAP_X;
    });
    const width = x - MINI_GAP_X + MINI_PAD;
    const edges = tasks.flatMap((t) => t.depends_on.filter((d) => placed.has(d)).map((d) => ({ from: placed.get(d)!, to: placed.get(t.id)! })));
    return { placed: [...placed.values()], edges, width, height };
  }, [tasks]);

  if (tasks.length === 0) return <span className="muted small">No tasks</span>;
  const shownH = Math.min(g.height, maxHeight);
  return (
    <svg
      className="mini-dag"
      viewBox={`0 0 ${g.width} ${g.height}`}
      preserveAspectRatio="xMinYMid meet"
      style={{ width: "100%", maxWidth: g.width, height: shownH, display: "block" }}
      aria-label="Task graph preview"
      role="img"
    >
      {g.edges.map(({ from, to }, i) => {
        const x1 = from.x + from.w;
        const y1 = from.y + MINI_H / 2;
        const x2 = to.x;
        const y2 = to.y + MINI_H / 2;
        const mx = (x1 + x2) / 2;
        return <path key={i} className={`dag-edge${edgeClass(states?.[from.id], states?.[to.id])}`} d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} />;
      })}
      {g.placed.map(({ id, task, x, y, w, text }) => (
        <g key={id} className={`mini-node ${task.runtime} ${states?.[id] ?? ""}`} transform={`translate(${x},${y})`}>
          <title>{`${task.name ?? id} (${id}) · ${task.runtime}`}</title>
          <rect width={w} height={MINI_H} rx="5" />
          <circle className="rt-dot" cx={9} cy={MINI_H / 2} r={2.5} />
          <text x={16} y={13.5}>
            {text}
          </text>
        </g>
      ))}
    </svg>
  );
}
