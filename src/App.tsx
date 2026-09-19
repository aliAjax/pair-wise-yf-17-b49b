import { useEffect, useMemo, useState } from "react";
import "./styles.css";

const PROJECT = {
  sourceNo: 7,
  id: "hxyfront-62005",
  port: 62005,
  title: "管风琴音管调音记录",
  domain: "管风琴维护",
  feature:
    "基准音管联动：每个音栓指定一根已确认基准管，其他音管保存相对音分差；基准管重调或更换后，依赖它的音管全部待复检，复检清零方可结项。",
};

const STORE_KEY = "hxyfront-62005-organ-console-v1";
const CENT_LIMIT = 10; // |合成偏差| 超过 10 音分视为超限
const STOP_TYPES = ["主音栓", "簧片音栓", "混合音栓", "低音管"] as const;
const REED_OPTIONS = ["正常", "簧片需微调", "簧片更换"] as const;

type StopType = (typeof STOP_TYPES)[number];
type ReedStatus = (typeof REED_OPTIONS)[number];
type BatchStatus = "open" | "closed";

interface Batch {
  id: string;
  name: string;
  venue: string;
  temp: number | null;
  humidity: number | null;
  status: BatchStatus;
  closedAt: string | null;
}

interface Stop {
  id: string;
  batchId: string;
  name: string;
  type: StopType;
  referencePipeId: string | null;
}

interface Pipe {
  id: string;
  stopId: string;
  code: string; // 音管编号，如 C4
  pitch: string; // 标称音高
  refPipeId: string | null; // 参照音管（默认本栓基准管，允许指向同栓其他音管）
  relCents: number | null; // 相对参照音管的音分差
  absCents: number | null; // 仅基准管使用：绝对音分偏差
  confirmed: boolean; // 基准管是否已确认
  recheck: boolean; // 待复检
  abnormal: boolean; // 人工标记异常
  reed: ReedStatus;
  note: string;
}

interface State {
  batches: Batch[];
  stops: Stop[];
  pipes: Pipe[];
  selectedBatchId: string;
  selectedStopId: string | null;
  typeFilter: StopType | null;
}

interface BatchCheck {
  missingRef: string[];
  unconfirmed: string[];
  missingDep: string[];
  cycle: string[];
  recheck: string[];
  missingRel: string[];
}

interface CloseReport {
  batchId: string;
  ok: boolean;
  at: string;
  check: BatchCheck;
}

const emptyCheck = (): BatchCheck => ({
  missingRef: [],
  unconfirmed: [],
  missingDep: [],
  cycle: [],
  recheck: [],
  missingRel: [],
});

/* ---------------- 纯逻辑：依赖图 / 合成偏差 / 结项校验 ---------------- */

let seq = 0;
const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const round1 = (n: number) => Math.round(n * 10) / 10;

const formatCents = (n: number | null) =>
  n === null || Number.isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${round1(n)}¢`;

/** 沿依赖链收集全部传递依赖（谁依赖了 root） */
function collectDependents(rootId: string, pipes: Pipe[]): string[] {
  const reverse = new Map<string, string[]>();
  for (const p of pipes) {
    if (!p.refPipeId) continue;
    const arr = reverse.get(p.refPipeId);
    if (arr) arr.push(p.id);
    else reverse.set(p.refPipeId, [p.id]);
  }
  const result: string[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const dep of reverse.get(id) ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      result.push(dep);
      queue.push(dep);
    }
  }
  return result;
}

/** 每个音管最多一条出边，逐节点追链即可找出所有环节点 */
function findCycleNodes(pipes: Pipe[]): Set<string> {
  const byId = new Map(pipes.map((p) => [p.id, p]));
  const cycles = new Set<string>();
  for (const start of pipes) {
    const order: string[] = [];
    const pos = new Map<string, number>();
    let cur: string | null = start.id;
    while (cur) {
      if (pos.has(cur)) {
        for (const id of order.slice(pos.get(cur)!)) cycles.add(id);
        break;
      }
      const p = byId.get(cur);
      if (!p || !p.refPipeId) break;
      pos.set(cur, order.length);
      order.push(cur);
      cur = p.refPipeId;
    }
  }
  return cycles;
}

/** 合成绝对偏差：基准管取绝对偏差，其余沿参照链累加相对音分差；环内一律不可计算 */
function computeEffective(pipes: Pipe[], stops: Stop[]): Map<string, number | null> {
  const byId = new Map(pipes.map((p) => [p.id, p]));
  const refByStop = new Map(stops.map((s) => [s.id, s.referencePipeId]));
  const cycle = findCycleNodes(pipes);

  const walk = (id: string): number | null => {
    if (cycle.has(id)) return null;
    const p = byId.get(id);
    if (!p) return null;
    if (refByStop.get(p.stopId) === id) return p.absCents;
    if (p.refPipeId == null || p.relCents == null) return null;
    const base = walk(p.refPipeId);
    return base === null ? null : base + p.relCents;
  };

  return new Map(pipes.map((p) => [p.id, walk(p.id)]));
}

/** 结项前整批校验；只读取数据，不做任何修改 */
function checkBatch(batchId: string, stops: Stop[], pipes: Pipe[]): BatchCheck {
  const result = emptyCheck();
  const bStops = stops.filter((s) => s.batchId === batchId);
  const bPipes = pipes.filter((p) => bStops.some((s) => s.id === p.stopId));
  const byId = new Map(bPipes.map((p) => [p.id, p]));
  const stopName = (stopId: string) => bStops.find((s) => s.id === stopId)?.name ?? "已删除音栓";
  const label = (p: Pipe) => `音栓「${stopName(p.stopId)}」音管 ${p.code}`;

  for (const s of bStops) {
    const ref = s.referencePipeId ? byId.get(s.referencePipeId) : undefined;
    if (!s.referencePipeId) {
      result.missingRef.push(`音栓「${s.name}」未指定基准管`);
    } else if (!ref) {
      result.missingRef.push(`音栓「${s.name}」指定的基准管已缺失`);
    } else {
      if (!ref.confirmed) {
        result.unconfirmed.push(`音栓「${s.name}」基准管 ${ref.code} 未确认`);
      }
      if (ref.absCents == null) {
        result.missingRel.push(`音栓「${s.name}」基准管 ${ref.code} 缺少绝对偏差`);
      }
    }
  }

  for (const p of bPipes) {
    const isRef = bStops.some((s) => s.referencePipeId === p.id);
    if (!isRef) {
      if (!p.refPipeId) {
        result.missingDep.push(`${label(p)} 未指定参照音管`);
      } else if (!byId.get(p.refPipeId)) {
        result.missingDep.push(`${label(p)} 的参照音管已缺失`);
      }
      if (p.relCents == null) {
        result.missingRel.push(`${label(p)} 未录相对音分差`);
      }
    }
    if (p.recheck) result.recheck.push(`${label(p)} 待复检`);
  }

  const cycle = findCycleNodes(bPipes);
  if (cycle.size) {
    const names = [...cycle].map((id) => {
      const p = byId.get(id)!;
      return `「${stopName(p.stopId)}」${p.code}`;
    });
    result.cycle.push(`${names.join("、")} 依赖成环`);
  }
  return result;
}

const checkHasIssues = (c: BatchCheck) =>
  c.missingRef.length +
    c.unconfirmed.length +
    c.missingDep.length +
    c.cycle.length +
    c.recheck.length +
    c.missingRel.length >
  0;

/* ---------------- 示例数据与浏览器存储 ---------------- */

function seedState(): State {
  const batchId = "b-seed-1";
  const stops: Stop[] = [
    { id: "s-seed-1", batchId, name: "Trumpet 8'", type: "簧片音栓", referencePipeId: "p-seed-11" },
    { id: "s-seed-2", batchId, name: "Principal 4'", type: "主音栓", referencePipeId: "p-seed-21" },
    { id: "s-seed-3", batchId, name: "Bourdon 16'", type: "低音管", referencePipeId: "p-seed-31" },
    { id: "s-seed-4", batchId, name: "Mixtur V", type: "混合音栓", referencePipeId: null },
  ];
  const mk = (p: Pipe): Pipe => p;
  const pipes: Pipe[] = [
    mk({ id: "p-seed-11", stopId: "s-seed-1", code: "C4", pitch: "261.6 Hz", refPipeId: null, relCents: null, absCents: 2, confirmed: true, recheck: false, abnormal: false, reed: "正常", note: "本栓基准" }),
    mk({ id: "p-seed-12", stopId: "s-seed-1", code: "C#4", pitch: "277.2 Hz", refPipeId: "p-seed-11", relCents: 7, absCents: null, confirmed: false, recheck: false, abnormal: false, reed: "簧片需微调", note: "簧片需微调" }),
    mk({ id: "p-seed-13", stopId: "s-seed-1", code: "E4", pitch: "329.6 Hz", refPipeId: "p-seed-11", relCents: -3, absCents: null, confirmed: false, recheck: false, abnormal: false, reed: "正常", note: "" }),
    mk({ id: "p-seed-14", stopId: "s-seed-1", code: "G4", pitch: "392.0 Hz", refPipeId: "p-seed-12", relCents: -2, absCents: null, confirmed: false, recheck: false, abnormal: false, reed: "正常", note: "二级参照链" }),
    mk({ id: "p-seed-21", stopId: "s-seed-2", code: "C4", pitch: "261.6 Hz", refPipeId: null, relCents: null, absCents: 0, confirmed: true, recheck: false, abnormal: false, reed: "正常", note: "本栓基准" }),
    mk({ id: "p-seed-22", stopId: "s-seed-2", code: "G3", pitch: "196.0 Hz", refPipeId: "p-seed-21", relCents: -3, absCents: null, confirmed: false, recheck: false, abnormal: false, reed: "正常", note: "正常" }),
    mk({ id: "p-seed-23", stopId: "s-seed-2", code: "A3", pitch: "220.0 Hz", refPipeId: "p-seed-22", relCents: 4, absCents: null, confirmed: false, recheck: false, abnormal: false, reed: "正常", note: "" }),
    mk({ id: "p-seed-31", stopId: "s-seed-3", code: "C2", pitch: "65.4 Hz", refPipeId: null, relCents: null, absCents: -2, confirmed: true, recheck: false, abnormal: false, reed: "正常", note: "本栓基准" }),
    mk({ id: "p-seed-32", stopId: "s-seed-3", code: "F2", pitch: "87.3 Hz", refPipeId: "p-seed-31", relCents: -10, absCents: null, confirmed: false, recheck: true, abnormal: true, reed: "正常", note: "标记复检" }),
    mk({ id: "p-seed-41", stopId: "s-seed-4", code: "C5", pitch: "523.3 Hz", refPipeId: null, relCents: null, absCents: null, confirmed: false, recheck: false, abnormal: false, reed: "正常", note: "" }),
    mk({ id: "p-seed-42", stopId: "s-seed-4", code: "E5", pitch: "659.3 Hz", refPipeId: null, relCents: null, absCents: null, confirmed: false, recheck: false, abnormal: false, reed: "正常", note: "" }),
  ];
  const batch: Batch = {
    id: batchId,
    name: "2026 秋季例行调音",
    venue: "St.Mary 教堂",
    temp: 18.4,
    humidity: 52,
    status: "open",
    closedAt: null,
  };
  return {
    batches: [batch],
    stops,
    pipes,
    selectedBatchId: batchId,
    selectedStopId: "s-seed-1",
    typeFilter: null,
  };
}

function loadState(): State {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as State;
      if (parsed && Array.isArray(parsed.batches) && Array.isArray(parsed.stops) && Array.isArray(parsed.pipes)) {
        return parsed;
      }
    }
  } catch {
    // 存储损坏时回退示例数据
  }
  return seedState();
}

/* ---------------- 小组件 ---------------- */

function RefSwitcher({
  pipes,
  currentId,
  readOnly,
  onSwitch,
}: {
  pipes: Pipe[];
  currentId: string | null;
  readOnly: boolean;
  onSwitch: (pipeId: string) => void;
}) {
  const [value, setValue] = useState(currentId ?? "");
  useEffect(() => setValue(currentId ?? ""), [currentId, pipes.length]);
  return (
    <div className="ref-switcher">
      <select value={value} disabled={readOnly || pipes.length === 0} onChange={(e) => setValue(e.target.value)}>
        <option value="">（请选择基准管）</option>
        {pipes.map((p) => (
          <option key={p.id} value={p.id}>
            {p.code}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="mini warn"
        disabled={readOnly || !value || value === currentId}
        onClick={() => onSwitch(value)}
        title="老基准转为普通音管并待复检，依赖老基准的音管全部待复检"
      >
        更换基准（联动）
      </button>
    </div>
  );
}

function AbsCentsEditor({
  pipe,
  readOnly,
  onRetune,
}: {
  pipe: Pipe;
  readOnly: boolean;
  onRetune: (value: number) => void;
}) {
  const [text, setText] = useState(String(pipe.absCents ?? 0));
  useEffect(() => setText(String(pipe.absCents ?? 0)), [pipe.absCents]);
  const parsed = parseFloat(text);
  const valid = Number.isFinite(parsed);
  return (
    <span className="abs-editor">
      <input
        className="cell-input narrow"
        value={text}
        disabled={readOnly}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        aria-label={`${pipe.code} 绝对音分偏差`}
      />
      <button
        type="button"
        className="mini warn"
        disabled={readOnly || !valid}
        title="按新偏差重调基准：基准转为未确认，全部依赖音管标为待复检"
        onClick={() => valid && onRetune(parsed)}
      >
        重调联动
      </button>
    </span>
  );
}

/* ---------------- 主应用 ---------------- */

function App() {
  const [state, setState] = useState<State>(loadState);
  const [report, setReport] = useState<CloseReport | null>(null);
  const [savedAt, setSavedAt] = useState("");
  const [showBatchForm, setShowBatchForm] = useState(false);

  // 列表、音栓进度与浏览器存储同步：任意变更即写 localStorage，刷新保留
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    } catch {
      setSavedAt("写入失败");
    }
  }, [state]);

  const commit = (mutator: (draft: State) => void) =>
    setState((prev) => {
      const draft = structuredClone(prev) as State;
      mutator(draft);
      return draft;
    });

  const batch =
    state.batches.find((b) => b.id === state.selectedBatchId) ?? state.batches[0];
  const readOnly = batch?.status === "closed";

  const batchStops = useMemo(
    () => state.stops.filter((s) => s.batchId === batch?.id),
    [state.stops, batch?.id],
  );
  const visibleStops = state.typeFilter
    ? batchStops.filter((s) => s.type === state.typeFilter)
    : batchStops;
  const selectedStop =
    batchStops.find((s) => s.id === state.selectedStopId) ?? batchStops[0] ?? null;

  const batchPipes = useMemo(
    () => state.pipes.filter((p) => batchStops.some((s) => s.id === p.stopId)),
    [state.pipes, batchStops],
  );
  const stopPipes = state.pipes.filter((p) => p.stopId === selectedStop?.id);
  const pipeById = new Map(batchPipes.map((p) => [p.id, p]));

  const effective = useMemo(() => computeEffective(batchPipes, batchStops), [batchPipes, batchStops]);
  const cycleNodes = useMemo(() => findCycleNodes(batchPipes), [batchPipes]);
  const check = useMemo(
    () => (batch ? checkBatch(batch.id, state.stops, state.pipes) : emptyCheck()),
    [batch, state.stops, state.pipes],
  );

  const isReference = (p: Pipe) =>
    state.stops.find((s) => s.id === p.stopId)?.referencePipeId === p.id;
  const stopName = (id: string) => state.stops.find((s) => s.id === id)?.name ?? "—";
  const refPipe = (s: Stop | null) =>
    s?.referencePipeId ? pipeById.get(s.referencePipeId) : undefined;

  /* ---------- 变更动作（已结项批次一律只读） ---------- */

  const batchWritable = !!batch && batch.status === "open";
  const stopWritable = batchWritable && !!selectedStop && selectedStop.batchId === batch.id;

  const switchBatch = (id: string) => {
    const first = state.stops.find((s) => s.batchId === id);
    commit((d) => {
      d.selectedBatchId = id;
      d.selectedStopId = first?.id ?? null;
    });
    setReport(null);
  };

  const selectStop = (id: string) => commit((d) => void (d.selectedStopId = id));

  const addBatch = (name: string, venue: string, temp: number | null, humidity: number | null) => {
    const b: Batch = {
      id: uid("b"),
      name: name.trim() || "未命名批次",
      venue: venue.trim(),
      temp,
      humidity,
      status: "open",
      closedAt: null,
    };
    commit((d) => {
      d.batches.push(b);
      d.selectedBatchId = b.id;
      d.selectedStopId = null;
    });
    setShowBatchForm(false);
    setReport(null);
  };

  const patchBatch = (patch: Partial<Batch>) => {
    if (!batchWritable) return;
    commit((d) => {
      const b = d.batches.find((x) => x.id === batch.id);
      if (b && b.status === "open") Object.assign(b, patch);
    });
  };

  const addStop = (name: string, type: StopType) => {
    if (!batchWritable) return;
    const s: Stop = { id: uid("s"), batchId: batch.id, name: name.trim() || "未命名音栓", type, referencePipeId: null };
    commit((d) => {
      d.stops.push(s);
      d.selectedStopId = s.id;
    });
  };

  const addPipe = (code: string, pitch: string) => {
    if (!stopWritable) return;
    const p: Pipe = {
      id: uid("p"),
      stopId: selectedStop!.id,
      code: code.trim() || `音管${stopPipes.length + 1}`,
      pitch: pitch.trim(),
      refPipeId: selectedStop!.referencePipeId,
      relCents: null,
      absCents: null,
      confirmed: false,
      recheck: false,
      abnormal: false,
      reed: "正常",
      note: "",
    };
    commit((d) => void d.pipes.push(p));
  };

  const deletePipe = (pipeId: string) => {
    if (!stopWritable) return;
    const p = state.pipes.find((x) => x.id === pipeId);
    if (!p || !window.confirm(`确定删除音管 ${p.code}？`)) return;
    commit((d) => {
      d.pipes = d.pipes.filter((x) => x.id !== pipeId);
      const s = d.stops.find((x) => x.id === p.stopId);
      if (s && s.referencePipeId === pipeId) s.referencePipeId = null;
      for (const other of d.pipes) if (other.refPipeId === pipeId) other.refPipeId = null;
    });
  };

  /** 更换基准管（联动复检） */
  const switchReference = (newRefId: string) => {
    if (!stopWritable) return;
    const stop = selectedStop!;
    const oldId = stop.referencePipeId;
    if (oldId === newRefId) return;
    const beforeEffective = computeEffective(batchPipes, batchStops);
    commit((d) => {
      const ds = d.stops.find((x) => x.id === stop.id)!;
      const newRef = d.pipes.find((x) => x.id === newRefId)!;
      const oldRef = oldId ? d.pipes.find((x) => x.id === oldId) : undefined;

      // 依赖老基准的音管全部待复检（先于改边计算）
      if (oldId) {
        for (const depId of collectDependents(oldId, d.pipes)) {
          if (depId === newRefId) continue;
          const dep = d.pipes.find((x) => x.id === depId);
          if (dep) dep.recheck = true;
        }
      }

      // 新基准：沿用此前的合成偏差作为绝对偏差，等待重新确认
      const prevEff = beforeEffective.get(newRefId);
      newRef.absCents = Number.isFinite(prevEff as number)
        ? round1(prevEff as number)
        : newRef.absCents ?? 0;
      newRef.refPipeId = null;
      newRef.relCents = null;
      newRef.confirmed = false;
      newRef.recheck = false;

      // 老基准降为普通音管：差值作废，必须复检
      if (oldRef) {
        oldRef.refPipeId = newRefId;
        oldRef.relCents = null;
        oldRef.confirmed = false;
        oldRef.recheck = true;
      }

      ds.referencePipeId = newRefId;
    });
  };

  /** 重调基准管（联动复检） */
  const retuneReference = (refId: string, value: number) => {
    if (!stopWritable) return;
    commit((d) => {
      const ref = d.pipes.find((x) => x.id === refId);
      if (!ref) return;
      ref.absCents = round1(value);
      ref.confirmed = false; // 重调后基准需重新确认
      for (const depId of collectDependents(refId, d.pipes)) {
        const dep = d.pipes.find((x) => x.id === depId);
        if (dep) dep.recheck = true;
      }
    });
  };

  const confirmReference = (refId: string) => {
    if (!stopWritable) return;
    commit((d) => {
      const ref = d.pipes.find((x) => x.id === refId);
      if (ref) ref.confirmed = true;
    });
  };

  const setDependency = (pipeId: string, refId: string) => {
    if (!stopWritable) return;
    commit((d) => {
      const p = d.pipes.find((x) => x.id === pipeId);
      if (p && p.id !== refId) p.refPipeId = refId || null;
    });
  };

  const setRelCents = (pipeId: string, raw: string) => {
    if (!stopWritable) return;
    const value = raw.trim() === "" ? null : parseFloat(raw);
    commit((d) => {
      const p = d.pipes.find((x) => x.id === pipeId);
      if (p) p.relCents = value !== null && Number.isFinite(value) ? round1(value) : null;
    });
  };

  const clearRecheck = (pipeId: string) => {
    if (!stopWritable) return;
    commit((d) => {
      const p = d.pipes.find((x) => x.id === pipeId);
      if (p) p.recheck = false;
    });
  };

  const patchPipe = (pipeId: string, patch: Partial<Pipe>) => {
    if (!stopWritable) return;
    commit((d) => {
      const p = d.pipes.find((x) => x.id === pipeId);
      if (p) Object.assign(p, patch);
    });
  };

  /* ---------- 结项：整批校验，拒绝时原记录与归属不变 ---------- */

  const attemptClose = () => {
    if (!batch || readOnly) return;
    const result = checkBatch(batch.id, state.stops, state.pipes);
    const next: CloseReport = { batchId: batch.id, ok: !checkHasIssues(result), at: new Date().toISOString(), check: result };
    if (next.ok) {
      commit((d) => {
        const b = d.batches.find((x) => x.id === batch.id);
        if (b) {
          b.status = "closed";
          b.closedAt = next.at;
        }
      });
    }
    // 拒绝分支不做任何写入，原记录与归属不变
    setReport(next);
  };

  const reopenBatch = () => {
    if (!batch) return;
    commit((d) => {
      const b = d.batches.find((x) => x.id === batch.id);
      if (b) {
        b.status = "open";
        b.closedAt = null;
      }
    });
    setReport(null);
  };

  const resetDemo = () => {
    if (!window.confirm("将清空当前全部记录并恢复示例数据，确定继续？")) return;
    const seeded = seedState();
    setState(seeded);
    setReport(null);
  };

  /* ---------- 派生统计 ---------- */

  const recheckCount = batchPipes.filter((p) => p.recheck).length;
  const overLimitPipes = batchPipes.filter((p) => {
    const v = effective.get(p.id);
    return v !== null && v !== undefined && Math.abs(v) > CENT_LIMIT;
  });
  const abnormalPipes = batchPipes.filter((p) => p.abnormal);
  const confirmedStops = batchStops.filter((s) => {
    const ref = s.referencePipeId ? pipeById.get(s.referencePipeId) : undefined;
    return !!ref?.confirmed;
  });
  const recordedRels = batchPipes.filter(
    (p) => !isReference(p) && p.relCents !== null && p.refPipeId,
  ).length;
  const totalNonRef = batchPipes.filter((p) => !isReference(p)).length;

  const stopProgress = (s: Stop) => {
    const ps = batchPipes.filter((p) => p.stopId === s.id);
    const nonRefs = ps.filter((p) => s.referencePipeId !== p.id);
    const done = nonRefs.filter((p) => p.relCents !== null && p.refPipeId).length;
    return { total: nonRefs.length, done, recheck: ps.filter((p) => p.recheck).length, cycle: ps.some((p) => cycleNodes.has(p.id)) };
  };

  /* ---------- 维护报告 ---------- */

  const buildReportText = () => {
    const lines = [
      `单次调音维护报告：${batch?.name ?? ""}`,
      `场馆：${batch?.venue || "未填写"}`,
      `温湿度：${batch?.temp ?? "—"}℃ / ${batch?.humidity ?? "—"}%`,
      `状态：${batch?.status === "closed" ? `已结项（${batch.closedAt?.slice(0, 10)}）` : "调音中"}`,
      `音栓 ${batchStops.length} 个（基准已确认 ${confirmedStops.length}），音管 ${batchPipes.length} 根`,
      `相对音分差已录 ${recordedRels}/${totalNonRef}，待复检 ${recheckCount}，偏差超限 ${overLimitPipes.length}，异常标记 ${abnormalPipes.length}`,
      "",
      "超限/异常音管：",
      ...(abnormalPipes.length
        ? abnormalPipes.map((p) => `- ${stopName(p.stopId)} ${p.code}：合成 ${formatCents(effective.get(p.id) ?? null)}，${p.reed}，${p.note || "无备注"}`)
        : ["- 无"]),
    ];
    if (checkHasIssues(check)) {
      lines.push("", "结项阻碍：");
      for (const item of [...check.missingRef, ...check.unconfirmed, ...check.missingDep, ...check.cycle, ...check.recheck, ...check.missingRel]) {
        lines.push(`- ${item}`);
      }
    }
    return lines.join("\n");
  };

  const exportReport = () => {
    const blob = new Blob([buildReportText()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${batch?.name ?? "调音批次"}-维护报告.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const parseNum = (raw: string): number | null => {
    if (raw.trim() === "") return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  };

  /* ============================== 视图 ============================== */

  return (
    <main className="app">
      <section className="hero compact">
        <p>
          {PROJECT.id} · 源提示词{PROJECT.sourceNo} · Port {PROJECT.port}
        </p>
        <h1>{PROJECT.title}</h1>
        <span>{PROJECT.feature}</span>
      </section>

      <section className="metrics">
        <article>
          <small>音栓数量</small>
          <strong>{batchStops.length}</strong>
        </article>
        <article>
          <small>偏差超限（&gt;{CENT_LIMIT}¢）</small>
          <strong className={overLimitPipes.length ? "metric-warn" : ""}>{overLimitPipes.length}</strong>
        </article>
        <article>
          <small>温度 ℃</small>
          <strong>{batch?.temp ?? "—"}</strong>
        </article>
        <article>
          <small>湿度 %</small>
          <strong>{batch?.humidity ?? "—"}</strong>
        </article>
      </section>

      {/* 调音批次 */}
      <section className="panel batch-panel">
        <div className="heading">
          <div>
            <p>调音批次</p>
            <h2>批次与结项</h2>
          </div>
          <div className="batch-actions">
            {readOnly ? (
              <button type="button" onClick={reopenBatch}>撤销结项</button>
            ) : (
              <button type="button" className="primary" onClick={attemptClose}>
                尝试结项
              </button>
            )}
            <button type="button" onClick={() => setShowBatchForm((v) => !v)}>新增批次</button>
          </div>
        </div>

        <div className="batch-tabs">
          {state.batches.map((b) => {
            const recheck = state.pipes.some(
              (p) => p.recheck && state.stops.some((s) => s.id === p.stopId && s.batchId === b.id),
            );
            return (
              <button
                key={b.id}
                type="button"
                className={`tab${b.id === batch?.id ? " active" : ""}${b.status === "closed" ? " closed" : ""}`}
                onClick={() => switchBatch(b.id)}
              >
                <span className={`dot ${b.status === "closed" ? "dot-closed" : recheck ? "dot-recheck" : "dot-ok"}`} />
                {b.name}
                <em>{b.status === "closed" ? "已结项" : "调音中"}</em>
              </button>
            );
          })}
        </div>

        {showBatchForm && !readOnly && (
          <BatchForm onCreate={addBatch} onCancel={() => setShowBatchForm(false)} />
        )}

        {batch && (
          <div className="env-grid">
            <label>
              <span>场馆名称</span>
              <input value={batch.venue} disabled={readOnly} onChange={(e) => patchBatch({ venue: e.target.value })} />
            </label>
            <label>
              <span>温度 ℃</span>
              <input
                value={batch.temp ?? ""}
                inputMode="decimal"
                disabled={readOnly}
                onChange={(e) => patchBatch({ temp: parseNum(e.target.value) })}
              />
            </label>
            <label>
              <span>湿度 %</span>
              <input
                value={batch.humidity ?? ""}
                inputMode="decimal"
                disabled={readOnly}
                onChange={(e) => patchBatch({ humidity: parseNum(e.target.value) })}
              />
            </label>
            <div className="batch-summary">
              <span>基准已确认 {confirmedStops.length}/{batchStops.length}</span>
              <span>相对差已录 {recordedRels}/{totalNonRef}</span>
              <span className={recheckCount ? "metric-warn" : ""}>待复检 {recheckCount}</span>
            </div>
          </div>
        )}

        {readOnly && (
          <p className="locked-tip">🔒 本批次已结项，记录为只读；如需调整请先「撤销结项」。</p>
        )}

        {report && report.batchId === batch?.id && <CloseResult report={report} onDismiss={() => setReport(null)} />}
      </section>

      <section className="workspace">
        {/* 音栓列表 */}
        <aside className="panel">
          <h2>音栓列表</h2>
          <div className="chips">
            <button
              type="button"
              className={state.typeFilter === null ? "chip-on" : ""}
              onClick={() => commit((d) => void (d.typeFilter = null))}
            >
              全部
            </button>
            {STOP_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className={state.typeFilter === t ? "chip-on" : ""}
                onClick={() => commit((d) => void (d.typeFilter = d.typeFilter === t ? null : t))}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="stop-list">
            {visibleStops.map((s) => {
              const ref = refPipe(s);
              const pg = stopProgress(s);
              const pct = pg.total === 0 ? 100 : Math.round((pg.done / pg.total) * 100);
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`stop-item${s.id === selectedStop?.id ? " active" : ""}`}
                  onClick={() => selectStop(s.id)}
                >
                  <span className="stop-line">
                    <b>{s.name}</b>
                    <em>{s.type}</em>
                  </span>
                  <span className="bar"><i style={{ width: `${pct}%` }} /></span>
                  <span className="stop-meta">
                    录差 {pg.done}/{pg.total}
                    {!s.referencePipeId && <i className="tag tag-miss">缺基准</i>}
                    {s.referencePipeId && !ref?.confirmed && <i className="tag tag-miss">基准未确认</i>}
                    {pg.recheck > 0 && <i className="tag tag-recheck">待复检 {pg.recheck}</i>}
                    {pg.cycle && <i className="tag tag-cycle">成环</i>}
                  </span>
                </button>
              );
            })}
            {visibleStops.length === 0 && <p className="muted">本筛选下暂无音栓。</p>}
          </div>

          {!readOnly && <AddStopForm onCreate={addStop} />}
        </aside>

        {/* 音栓详情 / 调音偏差表 */}
        <section className="panel form-panel">
          {!selectedStop ? (
            <div className="empty-hint">
              <p>当前批次还没有音栓。</p>
              <p className="muted">在左侧新增音栓后，为其指定一根基准管并确认，再逐根录入相对音分差。</p>
            </div>
          ) : (
            <>
              <div className="heading">
                <div>
                  <p>{selectedStop.type}</p>
                  <h2>{selectedStop.name} · 调音偏差表</h2>
                </div>
                <div className="ref-control">
                  <span className="muted">基准音管</span>
                  <RefSwitcher
                    pipes={stopPipes}
                    currentId={selectedStop.referencePipeId}
                    readOnly={readOnly}
                    onSwitch={switchReference}
                  />
                  {(() => {
                    const ref = refPipe(selectedStop);
                    if (!selectedStop.referencePipeId) return <i className="tag tag-miss">缺基准</i>;
                    if (!ref) return <i className="tag tag-miss">基准缺失</i>;
                    return ref.confirmed ? (
                      <i className="tag tag-ok">基准 {ref.code} 已确认</i>
                    ) : (
                      <button type="button" className="mini success" disabled={readOnly || ref.absCents === null} onClick={() => confirmReference(ref.id)}>
                        确认基准 {ref.code}
                      </button>
                    );
                  })()}
                </div>
              </div>

              <div className="table-wrap">
                <table className="pipe-table">
                  <thead>
                    <tr>
                      <th>音管编号</th>
                      <th>标称音高</th>
                      <th>参照音管</th>
                      <th>音分差</th>
                      <th>合成偏差</th>
                      <th>簧片状态</th>
                      <th>标记</th>
                      <th>维修备注</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stopPipes.map((p) => {
                      const ref = isReference(p);
                      const eff = effective.get(p.id);
                      const over = eff !== null && eff !== undefined && Math.abs(eff) > CENT_LIMIT;
                      const depChoices = stopPipes.filter((x) => x.id !== p.id);
                      return (
                        <tr
                          key={p.id}
                          className={`${p.recheck ? "row-recheck" : ""}${cycleNodes.has(p.id) ? " row-cycle" : ""}`}
                        >
                          <td>
                            <input
                              className="cell-input"
                              value={p.code}
                              disabled={readOnly}
                              onChange={(e) => patchPipe(p.id, { code: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              className="cell-input"
                              value={p.pitch}
                              disabled={readOnly}
                              onChange={(e) => patchPipe(p.id, { pitch: e.target.value })}
                            />
                          </td>
                          <td>
                            {ref ? (
                              <i className="tag tag-ref">本栓基准</i>
                            ) : (
                              <select
                                className="cell-input"
                                value={p.refPipeId ?? ""}
                                disabled={readOnly}
                                onChange={(e) => setDependency(p.id, e.target.value)}
                              >
                                <option value="">（无）</option>
                                {depChoices.map((x) => (
                                  <option key={x.id} value={x.id}>
                                    {x.code}
                                  </option>
                                ))}
                              </select>
                            )}
                          </td>
                          <td>
                            {ref ? (
                              <AbsCentsEditor pipe={p} readOnly={readOnly} onRetune={(v) => retuneReference(p.id, v)} />
                            ) : (
                              <input
                                className="cell-input narrow"
                                value={p.relCents ?? ""}
                                inputMode="decimal"
                                disabled={readOnly}
                                placeholder="相对¢"
                                onChange={(e) => setRelCents(p.id, e.target.value)}
                              />
                            )}
                          </td>
                          <td className={over ? "cent-over" : ""}>
                            {ref ? formatCents(p.absCents) : formatCents(eff ?? null)}
                          </td>
                          <td>
                            <select
                              className="cell-input"
                              value={p.reed}
                              disabled={readOnly}
                              onChange={(e) => patchPipe(p.id, { reed: e.target.value as ReedStatus })}
                            >
                              {REED_OPTIONS.map((r) => (
                                <option key={r} value={r}>{r}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <span className="tag-stack">
                              {ref && (p.confirmed ? <i className="tag tag-ok">已确认</i> : <i className="tag tag-miss">未确认</i>)}
                              {p.recheck && <i className="tag tag-recheck">待复检</i>}
                              {p.abnormal && <i className="tag tag-abn">异常</i>}
                              {cycleNodes.has(p.id) && <i className="tag tag-cycle">成环</i>}
                              {!ref && !p.recheck && !p.abnormal && !cycleNodes.has(p.id) && <span className="muted">—</span>}
                            </span>
                          </td>
                          <td>
                            <input
                              className="cell-input note"
                              value={p.note}
                              disabled={readOnly}
                              onChange={(e) => patchPipe(p.id, { note: e.target.value })}
                            />
                          </td>
                          <td>
                            <span className="row-actions">
                              {p.recheck && (
                                <button type="button" className="mini success" disabled={readOnly} onClick={() => clearRecheck(p.id)}>
                                  复检通过
                                </button>
                              )}
                              <button
                                type="button"
                                className={`mini${p.abnormal ? " warn" : ""}`}
                                disabled={readOnly}
                                onClick={() => patchPipe(p.id, { abnormal: !p.abnormal })}
                              >
                                {p.abnormal ? "取消异常" : "标记异常"}
                              </button>
                              <button type="button" className="mini danger" disabled={readOnly} onClick={() => deletePipe(p.id)}>
                                删除
                              </button>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {!readOnly && <AddPipeForm onCreate={addPipe} />}
              <p className="muted rule-note">
                非基准管只保存相对参照音管的音分差，合成偏差沿依赖链自动累加；参照可指向同栓其他音管，但依赖成环时批次将无法结项。
              </p>
            </>
          )}
        </section>
      </section>

      {/* 调音记录列表（与状态/存储同步） */}
      <section className="panel">
        <div className="heading">
          <div>
            <p>历史记录</p>
            <h2>调音记录列表 · {batch?.name}</h2>
          </div>
        </div>
        <div className="records records-table">
          {batchPipes.map((p, index) => {
            const eff = effective.get(p.id);
            const ref = isReference(p);
            return (
              <article key={p.id} onClick={() => selectStop(p.stopId)} className="record-row">
                <b>{String(index + 1).padStart(2, "0")}</b>
                <div>
                  <h3>
                    {stopName(p.stopId)} · {p.code}
                    {ref && <i className="tag tag-ref">基准</i>}
                    {p.recheck && <i className="tag tag-recheck">待复检</i>}
                    {p.abnormal && <i className="tag tag-abn">异常</i>}
                  </h3>
                  <p>
                    {batch?.venue} · {p.pitch || "音高未填"} ·{" "}
                    {ref ? `绝对 ${formatCents(p.absCents)}` : `相对 ${formatCents(p.relCents)} → 合成 ${formatCents(eff ?? null)}`} ·{" "}
                    {p.reed}
                    {p.note ? ` · ${p.note}` : ""}
                  </p>
                </div>
              </article>
            );
          })}
          {batchPipes.length === 0 && <p className="muted">本批次暂无音管记录。</p>}
        </div>
      </section>

      {/* 单次维护报告（同页区块，不新增页面） */}
      <section className="panel report-panel">
        <div className="heading">
          <div>
            <p>单次维护报告</p>
            <h2>{batch?.name}</h2>
          </div>
          <button type="button" onClick={exportReport}>导出摘要</button>
        </div>
        <div className="report-grid">
          <div><small>场馆</small><strong>{batch?.venue || "—"}</strong></div>
          <div><small>温湿度</small><strong>{batch?.temp ?? "—"}℃ / {batch?.humidity ?? "—"}%</strong></div>
          <div><small>基准确认</small><strong>{confirmedStops.length}/{batchStops.length} 栓</strong></div>
          <div><small>待复检</small><strong className={recheckCount ? "metric-warn" : ""}>{recheckCount} 根</strong></div>
          <div><small>偏差超限</small><strong>{overLimitPipes.length} 根</strong></div>
          <div><small>批次状态</small><strong>{readOnly ? `已结项 ${batch?.closedAt?.slice(0, 10) ?? ""}` : "调音中"}</strong></div>
        </div>
        {checkHasIssues(check) ? (
          <div className="report-block">
            <h3>结项阻碍项（{[check.missingRef, check.unconfirmed, check.missingDep, check.cycle, check.recheck, check.missingRel].reduce((n, a) => n + a.length, 0)}）</h3>
            <CheckList check={check} />
          </div>
        ) : (
          <p className="ok-line">✓ 基准齐全且已确认、无依赖成环、待复检已清零，本批次可以结项。</p>
        )}
        {abnormalPipes.length > 0 && (
          <div className="report-block">
            <h3>异常音管</h3>
            <ul>
              {abnormalPipes.map((p) => (
                <li key={p.id}>
                  {stopName(p.stopId)} · {p.code}：合成 {formatCents(effective.get(p.id) ?? null)}，{p.reed}
                  {p.note ? `，${p.note}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <footer className="storage-footer">
        <span>数据保存在浏览器 localStorage（{STORE_KEY}），列表与音栓进度实时同步，刷新保留。{savedAt ? `最近保存 ${savedAt}` : ""}</span>
        <button type="button" className="mini" onClick={resetDemo}>恢复示例数据</button>
      </footer>
    </main>
  );
}

/* ---------------- 主视图用到的表单与结果区块 ---------------- */

function BatchForm({
  onCreate,
  onCancel,
}: {
  onCreate: (name: string, venue: string, temp: number | null, humidity: number | null) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [venue, setVenue] = useState("");
  const [temp, setTemp] = useState("");
  const [humidity, setHumidity] = useState("");
  const num = (raw: string) => (raw.trim() === "" ? null : parseFloat(raw));
  return (
    <div className="inline-form">
      <input placeholder="批次名称，如 2026 圣诞前调音" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="教堂 / 音乐厅名称" value={venue} onChange={(e) => setVenue(e.target.value)} />
      <input placeholder="温度 ℃" inputMode="decimal" value={temp} onChange={(e) => setTemp(e.target.value)} />
      <input placeholder="湿度 %" inputMode="decimal" value={humidity} onChange={(e) => setHumidity(e.target.value)} />
      <button
        type="button"
        className="primary"
        onClick={() => {
          const t = num(temp);
          const h = num(humidity);
          onCreate(name, venue, t !== null && Number.isFinite(t) ? t : null, h !== null && Number.isFinite(h) ? h : null);
          setName("");
          setVenue("");
          setTemp("");
          setHumidity("");
        }}
      >
        创建
      </button>
      <button type="button" onClick={onCancel}>取消</button>
    </div>
  );
}

function AddStopForm({ onCreate }: { onCreate: (name: string, type: StopType) => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<StopType>("主音栓");
  return (
    <div className="inline-form stacked">
      <input placeholder="新增音栓名称，如 Flute 4'" value={name} onChange={(e) => setName(e.target.value)} />
      <select value={type} onChange={(e) => setType(e.target.value as StopType)}>
        {STOP_TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      <button
        type="button"
        className="primary"
        onClick={() => {
          if (!name.trim()) return;
          onCreate(name, type);
          setName("");
        }}
      >
        新增音栓
      </button>
    </div>
  );
}

function AddPipeForm({ onCreate }: { onCreate: (code: string, pitch: string) => void }) {
  const [code, setCode] = useState("");
  const [pitch, setPitch] = useState("");
  return (
    <div className="inline-form">
      <input placeholder="音管编号，如 A#3" value={code} onChange={(e) => setCode(e.target.value)} />
      <input placeholder="标称音高，如 233.1 Hz" value={pitch} onChange={(e) => setPitch(e.target.value)} />
      <button
        type="button"
        className="primary"
        onClick={() => {
          if (!code.trim()) return;
          onCreate(code, pitch);
          setCode("");
          setPitch("");
        }}
      >
        新增音管
      </button>
    </div>
  );
}

function CheckList({ check }: { check: BatchCheck }) {
  const groups: Array<[string, string[]]> = [
    ["缺基准", check.missingRef],
    ["基准未确认", check.unconfirmed],
    ["参照缺失", check.missingDep],
    ["依赖成环", check.cycle],
    ["待复检未清零", check.recheck],
    ["相对音分差未录", check.missingRel],
  ];
  return (
    <ul className="check-list">
      {groups.map(([title, items]) =>
        items.map((item, i) => (
          <li key={`${title}-${i}`} className={title === "依赖成环" ? "cycle" : title.includes("复检") ? "recheck" : "block"}>
            <b>{title}</b> {item.replace(/^.*?(?=音栓|音管|「)/, "")}
          </li>
        )),
      )}
    </ul>
  );
}

function CloseResult({ report, onDismiss }: { report: CloseReport; onDismiss: () => void }) {
  if (report.ok) {
    return (
      <div className="close-report ok">
        <div>
          <strong>✓ 批次已结项</strong>
          <span>{new Date(report.at).toLocaleString("zh-CN", { hour12: false })}，记录转为只读。</span>
        </div>
        <button type="button" className="mini" onClick={onDismiss}>知道了</button>
      </div>
    );
  }
  const total = [report.check.missingRef, report.check.unconfirmed, report.check.missingDep, report.check.cycle, report.check.recheck, report.check.missingRel].reduce(
    (n, a) => n + a.length,
    0,
  );
  return (
    <div className="close-report fail">
      <div className="fail-head">
        <strong>✕ 整批拒绝结项（{total} 项）</strong>
        <span>原记录与归属保持不变，请处理以下问题后重试：</span>
        <button type="button" className="mini" onClick={onDismiss}>收起</button>
      </div>
      <CheckList check={report.check} />
    </div>
  );
}

export default App;
