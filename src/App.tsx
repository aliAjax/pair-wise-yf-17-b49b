import { useEffect, useMemo, useState } from "react";
import "./styles.css";

const project = {
  sourceNo: 7,
  id: "hxyfront-62005",
  port: 62005,
  title: "管风琴音管调音记录",
  domain: "管风琴维护",
  prompt:
    "做一个给管风琴维护人员使用的音管调音记录前端项目，可以记录教堂或音乐厅名称、音栓、音管编号、音高、音分偏差、温湿度、簧片状态和维修备注。页面需要有音栓列表、调音偏差表、温湿度记录、异常音管标记和单次维护报告页。",
};

// ---------- 数据模型 ----------

type PipeStatus = "ok" | "pending"; // pending = 待复检
type BatchStatus = "open" | "closed" | "rejected";

export interface Pipe {
  id: string;
  stopId: string;
  batchId: string;
  code: string; // 音管编号
  pitch: string; // 音高
  cents: number; // 相对基准管的音分差
  note: string; // 维修备注
  referenceId: string | null; // 依赖的基准管（基准管自身为 null）
  confirmed: boolean; // 作为基准管是否已确认
  status: PipeStatus;
}

export interface Stop {
  id: string;
  venue: string; // 场馆名称
  name: string; // 音栓
  referencePipeId: string | null; // 指定的基准管
}

export interface Batch {
  id: string;
  name: string;
  status: BatchStatus;
  reason?: string; // 整批拒绝原因
}

export interface TuningState {
  stops: Stop[];
  pipes: Pipe[];
  batches: Batch[];
  currentBatchId: string;
}

const STORAGE_KEY = "hxyfront-62005.tuning.v1";

export const seedState: TuningState = {
  stops: [
    { id: "s-trumpet", venue: "St.Mary", name: "Trumpet 8'", referencePipeId: "p-tp-cs4" },
    { id: "s-principal", venue: "ConcertHall A", name: "Principal 4'", referencePipeId: "p-pr-g3" },
    { id: "s-bourdon", venue: "Abbey Room", name: "Bourdon 16'", referencePipeId: "p-bd-f2" },
  ],
  pipes: [
    { id: "p-tp-cs4", stopId: "s-trumpet", batchId: "b-autumn", code: "TP-013", pitch: "C#4", cents: 0, note: "基准管", referenceId: null, confirmed: true, status: "ok" },
    { id: "p-tp-d4", stopId: "s-trumpet", batchId: "b-autumn", code: "TP-014", pitch: "D4", cents: 9, note: "簧片需微调", referenceId: "p-tp-cs4", confirmed: false, status: "ok" },
    { id: "p-tp-e4", stopId: "s-trumpet", batchId: "b-autumn", code: "TP-015", pitch: "E4", cents: -4, note: "正常", referenceId: "p-tp-cs4", confirmed: false, status: "ok" },
    { id: "p-pr-g3", stopId: "s-principal", batchId: "b-autumn", code: "PR-201", pitch: "G3", cents: 0, note: "基准管", referenceId: null, confirmed: true, status: "ok" },
    { id: "p-pr-a3", stopId: "s-principal", batchId: "b-autumn", code: "PR-202", pitch: "A3", cents: -3, note: "正常", referenceId: "p-pr-g3", confirmed: false, status: "ok" },
    { id: "p-bd-f2", stopId: "s-bourdon", batchId: "b-autumn", code: "BD-301", pitch: "F2", cents: 0, note: "基准管", referenceId: null, confirmed: true, status: "ok" },
    { id: "p-bd-c3", stopId: "s-bourdon", batchId: "b-autumn", code: "BD-302", pitch: "C3", cents: -12, note: "标记复检", referenceId: "p-bd-f2", confirmed: false, status: "pending" },
  ],
  batches: [
    { id: "b-autumn", name: "2026-09 秋季巡检", status: "open" },
    { id: "b-summer", name: "2026-06 夏季巡检", status: "closed" },
  ],
  currentBatchId: "b-autumn",
};

function loadState(): TuningState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedState;
    const parsed = JSON.parse(raw) as TuningState;
    if (
      !parsed ||
      !Array.isArray(parsed.stops) ||
      !Array.isArray(parsed.pipes) ||
      !Array.isArray(parsed.batches) ||
      typeof parsed.currentBatchId !== "string"
    ) {
      return seedState;
    }
    return parsed;
  } catch {
    return seedState;
  }
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 沿 referenceId 依赖链检查是否成环 */
export function chainHasCycle(pipes: Pipe[], startId: string): boolean {
  const byId = new Map(pipes.map((p) => [p.id, p]));
  const seen = new Set<string>();
  let cur: string | null = startId;
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = byId.get(cur)?.referenceId ?? null;
  }
  return false;
}

/** 依赖链经过 targetId 的全部音管（含跨级依赖） */
export function dependentIds(pipes: Pipe[], targetId: string): Set<string> {
  const byId = new Map(pipes.map((p) => [p.id, p]));
  const result = new Set<string>();
  for (const p of pipes) {
    const seen = new Set<string>([p.id]);
    let cur = p.referenceId;
    while (cur) {
      if (cur === targetId) {
        result.add(p.id);
        break;
      }
      if (seen.has(cur)) break; // 已有环，停止追溯
      seen.add(cur);
      cur = byId.get(cur)?.referenceId ?? null;
    }
  }
  return result;
}

/** 指定/更换基准管：依赖旧基准的音管（含旧基准管自身）全部标为待复检 */
export function applySetReference(s: TuningState, stopId: string, pipeId: string): TuningState {
  const stop = s.stops.find((x) => x.id === stopId);
  if (!stop || stop.referencePipeId === pipeId) return s;
  const oldRefId = stop.referencePipeId;
  const pendingIds = oldRefId ? dependentIds(s.pipes, oldRefId) : new Set<string>();
  const nextPipes = s.pipes.map((p) => {
    if (p.id === pipeId) {
      // 新基准管成为基准：先断开自身依赖，避免与旧基准互指成环
      return { ...p, referenceId: null, cents: 0, status: "ok" as PipeStatus };
    }
    if (oldRefId === null && p.stopId === stopId && p.referenceId === null) {
      // 首次指定基准：同音栓未挂依赖的音管挂到基准下
      return { ...p, referenceId: pipeId };
    }
    if (p.id === oldRefId) {
      // 旧基准管改为依赖新基准，同样需要复检
      return { ...p, referenceId: pipeId, status: "pending" as PipeStatus };
    }
    if (pendingIds.has(p.id)) {
      return { ...p, status: "pending" as PipeStatus };
    }
    return p;
  });
  const nextStops = s.stops.map((x) => (x.id === stopId ? { ...x, referencePipeId: pipeId } : x));
  return { ...s, stops: nextStops, pipes: nextPipes };
}

/** 重调基准管：依赖它的音管全部标为待复检 */
export function applyRetuneReference(s: TuningState, stopId: string): TuningState {
  const stop = s.stops.find((x) => x.id === stopId);
  const refId = stop?.referencePipeId;
  if (!stop || !refId) return s;
  const ids = dependentIds(s.pipes, refId);
  return {
    ...s,
    pipes: s.pipes.map((p) => (ids.has(p.id) ? { ...p, status: "pending" as PipeStatus } : p)),
  };
}

export type BatchCloseResult =
  | { outcome: "closed" }
  | { outcome: "blocked"; pending: number } // 待复检未清零，不能结项
  | { outcome: "rejected"; reason: string }; // 缺基准 / 基准未确认 / 依赖成环 → 整批拒绝

/** 结项校验：待复检清零才可结项；缺基准、基准未确认或依赖成环时整批拒绝 */
export function evaluateBatchClose(s: TuningState, batchId: string): BatchCloseResult {
  const batch = s.batches.find((b) => b.id === batchId);
  if (!batch || batch.status !== "open") return { outcome: "blocked", pending: 0 };
  const batchPipes = s.pipes.filter((p) => p.batchId === batchId);
  const pending = batchPipes.filter((p) => p.status === "pending").length;
  if (pending > 0) return { outcome: "blocked", pending };
  const stopsById = new Map(s.stops.map((x) => [x.id, x]));
  const pipesById = new Map(s.pipes.map((x) => [x.id, x]));
  const stopIds = [...new Set(batchPipes.map((p) => p.stopId))];
  for (const stopId of stopIds) {
    const stop = stopsById.get(stopId);
    if (!stop) continue;
    if (!stop.referencePipeId) {
      return { outcome: "rejected", reason: `音栓「${stop.venue} · ${stop.name}」缺少基准管` };
    }
    const ref = pipesById.get(stop.referencePipeId);
    if (!ref || !ref.confirmed) {
      return { outcome: "rejected", reason: `音栓「${stop.venue} · ${stop.name}」的基准管未确认` };
    }
  }
  for (const p of batchPipes) {
    if (chainHasCycle(s.pipes, p.id)) {
      return { outcome: "rejected", reason: `音管 ${p.code} 的依赖关系成环` };
    }
  }
  return { outcome: "closed" };
}

const batchStatusText: Record<BatchStatus, string> = {
  open: "进行中",
  closed: "已结项",
  rejected: "已拒绝",
};

function formatCents(cents: number): string {
  return `${cents > 0 ? "+" : ""}${cents} cent`;
}

// ---------- 组件 ----------

function App() {
  const [state, setState] = useState<TuningState>(loadState);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "ok" | "reference">("all");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ venue: "", stop: "", code: "", pitch: "", cents: "0", note: "" });
  const [recheckCents, setRecheckCents] = useState<Record<string, string>>({});

  // 浏览器存储同步：任何状态变化都写回 localStorage，刷新后保留
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const { stops, pipes, batches } = state;
  const pipesById = useMemo(() => new Map(pipes.map((p) => [p.id, p])), [pipes]);
  const stopsById = useMemo(() => new Map(stops.map((s) => [s.id, s])), [stops]);
  const batchesById = useMemo(() => new Map(batches.map((b) => [b.id, b])), [batches]);
  const openBatches = batches.filter((b) => b.status === "open");
  const currentBatch = batchesById.get(state.currentBatchId);

  const update = (fn: (s: TuningState) => TuningState) => setState((s) => fn(s));

  // ---------- 联动操作 ----------

  /** 新增音管记录：归属当前进行中批次，依赖默认挂到所在音栓的基准管 */
  const addRecord = () => {
    const venue = form.venue.trim();
    const stopName = form.stop.trim();
    const code = form.code.trim();
    if (!venue || !stopName || !code) {
      setNotice("请至少填写场馆名称、音栓和音管编号");
      return;
    }
    if (!currentBatch || currentBatch.status !== "open") {
      setNotice("当前没有进行中的调音批次，请先新建批次再保存记录");
      return;
    }
    const cents = Number(form.cents);
    update((s) => {
      const existing = s.stops.find((x) => x.venue === venue && x.name === stopName);
      const stopId = existing ? existing.id : uid("s");
      const nextStops = existing
        ? s.stops
        : [...s.stops, { id: stopId, venue, name: stopName, referencePipeId: null }];
      const pipe: Pipe = {
        id: uid("p"),
        stopId,
        batchId: s.currentBatchId,
        code,
        pitch: form.pitch.trim() || "—",
        cents: Number.isFinite(cents) ? cents : 0,
        note: form.note.trim() || "—",
        referenceId: existing?.referencePipeId ?? null,
        confirmed: false,
        status: "ok",
      };
      return { ...s, stops: nextStops, pipes: [...s.pipes, pipe] };
    });
    setForm((f) => ({ ...f, code: "", pitch: "", cents: "0", note: "" }));
    setNotice(`已记录音管 ${code}，归属批次「${currentBatch.name}」`);
  };

  /** 指定/更换基准管：依赖旧基准的音管全部标为待复检 */
  const setReference = (stopId: string, pipeId: string) => {
    const stop = stopsById.get(stopId);
    const target = pipesById.get(pipeId);
    if (!stop || !target || stop.referencePipeId === pipeId) return;
    const replacing = stop.referencePipeId !== null;
    update((s) => applySetReference(s, stopId, pipeId));
    setNotice(
      replacing
        ? `已更换「${stop.venue} · ${stop.name}」的基准管为 ${target.code}，依赖它的音管全部标为待复检`
        : `已指定 ${target.code} 为「${stop.venue} · ${stop.name}」的基准管，确认后方可通过结项校验`
    );
  };

  /** 重调基准管：依赖它的音管全部标为待复检 */
  const retuneReference = (stopId: string) => {
    const stop = stopsById.get(stopId);
    if (!stop || !stop.referencePipeId) return;
    update((s) => applyRetuneReference(s, stopId));
    setNotice(`基准管 ${pipesById.get(stop.referencePipeId)?.code ?? ""} 已重调，依赖它的音管全部标为待复检`);
  };

  /** 确认基准管 */
  const confirmReference = (pipeId: string) => {
    update((s) => ({
      ...s,
      pipes: s.pipes.map((p) => (p.id === pipeId ? { ...p, confirmed: true } : p)),
    }));
    setNotice("基准管已确认");
  };

  /** 复检：录入新的相对音分差，清除待复检标记 */
  const recheck = (pipeId: string) => {
    const raw = recheckCents[pipeId];
    const fallback = pipesById.get(pipeId)?.cents ?? 0;
    const cents = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
    update((s) => ({
      ...s,
      pipes: s.pipes.map((p) =>
        p.id === pipeId ? { ...p, status: "ok" as PipeStatus, cents: Number.isFinite(cents) ? cents : p.cents } : p
      ),
    }));
    setRecheckCents((m) => ({ ...m, [pipeId]: "" }));
    setNotice(`音管 ${pipesById.get(pipeId)?.code ?? ""} 复检完成，待复检标记已清除`);
  };

  /** 调整单根音管的依赖指向（结项时统一校验是否成环） */
  const changeDependency = (pipeId: string, referenceId: string) => {
    if (referenceId === pipeId) return;
    update((s) => ({
      ...s,
      pipes: s.pipes.map((p) => (p.id === pipeId ? { ...p, referenceId: referenceId || null } : p)),
    }));
    setNotice("已更新依赖关系，批次结项时将校验是否成环");
  };

  /** 新建调音批次，后续记录归属该批次 */
  const newBatch = () => {
    const name = `巡检批次 ${new Date().toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })}`;
    const id = uid("b");
    update((s) => ({
      ...s,
      batches: [...s.batches, { id, name, status: "open" as BatchStatus }],
      currentBatchId: id,
    }));
    setNotice(`已新建批次「${name}」，新记录将归属该批次`);
  };

  const rejectBatch = (batchId: string, reason: string) => {
    // 整批拒绝：仅标记批次，原记录与归属不变
    update((s) => ({
      ...s,
      batches: s.batches.map((b) => (b.id === batchId ? { ...b, status: "rejected" as BatchStatus, reason } : b)),
    }));
    setNotice(`批次已拒绝：${reason}（原记录与归属不变）`);
  };

  /** 结项：待复检清零才可结项；缺基准 / 基准未确认 / 依赖成环 → 整批拒绝 */
  const closeBatch = (batchId: string) => {
    const batch = batchesById.get(batchId);
    if (!batch || batch.status !== "open") return;
    const result = evaluateBatchClose(state, batchId);
    if (result.outcome === "blocked") {
      setNotice(`批次「${batch.name}」还有 ${result.pending} 根音管待复检，清零后才能结项`);
      return;
    }
    if (result.outcome === "rejected") {
      rejectBatch(batchId, result.reason);
      return;
    }
    update((s) => ({
      ...s,
      batches: s.batches.map((b) => (b.id === batchId ? { ...b, status: "closed" as BatchStatus } : b)),
    }));
    setNotice(`批次「${batch.name}」已结项`);
  };

  /** 导出单次维护报告摘要 */
  const exportSummary = () => {
    const lines: string[] = [`管风琴音管调音记录摘要 · ${new Date().toLocaleString("zh-CN")}`, ""];
    for (const b of batches) {
      const bp = pipes.filter((p) => p.batchId === b.id);
      const pend = bp.filter((p) => p.status === "pending").length;
      lines.push(
        `批次「${b.name}」 ${batchStatusText[b.status]} · 音管 ${bp.length} 根 · 待复检 ${pend} 根` +
          (b.reason ? ` · 拒绝原因：${b.reason}` : "")
      );
    }
    lines.push("");
    for (const s of stops) {
      const sp = pipes.filter((p) => p.stopId === s.id);
      const ref = s.referencePipeId ? pipesById.get(s.referencePipeId) : undefined;
      lines.push(
        `音栓「${s.venue} · ${s.name}」 基准管：${ref ? `${ref.code}（${ref.confirmed ? "已确认" : "未确认"}）` : "未指定"} · 音管 ${sp.length} 根 · 待复检 ${sp.filter((p) => p.status === "pending").length} 根`
      );
      for (const p of sp) {
        lines.push(`  ${p.code} ${p.pitch} ${formatCents(p.cents)} · ${p.status === "pending" ? "待复检" : "正常"} · ${p.note}`);
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "调音记录摘要.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  // ---------- 派生数据 ----------

  const pendingTotal = pipes.filter((p) => p.status === "pending").length;
  const overLimit = pipes.filter((p) => Math.abs(p.cents) > 10).length;
  const metrics: Array<[string, number]> = [
    ["音栓数量", stops.length],
    ["待复检音管", pendingTotal],
    ["偏差超限", overLimit],
    ["进行中批次", openBatches.length],
  ];

  const stopProgress = (stopId: string) => {
    const sp = pipes.filter((p) => p.stopId === stopId);
    const pending = sp.filter((p) => p.status === "pending").length;
    return { total: sp.length, pending, ok: sp.length - pending };
  };

  const visiblePipes = pipes.filter((p) => {
    if (selectedStopId && p.stopId !== selectedStopId) return false;
    if (statusFilter === "pending") return p.status === "pending";
    if (statusFilter === "ok") return p.status === "ok";
    if (statusFilter === "reference") return stopsById.get(p.stopId)?.referencePipeId === p.id;
    return true;
  });

  const filterChips: Array<["all" | "pending" | "ok" | "reference", string]> = [
    ["all", "全部"],
    ["pending", "待复检"],
    ["ok", "正常"],
    ["reference", "基准管"],
  ];

  return (
    <main className="app">
      <section className="hero">
        <p>
          {project.id} · 源提示词{project.sourceNo} · Port {project.port}
        </p>
        <h1>{project.title}</h1>
        <span>{project.prompt}</span>
      </section>

      <section className="metrics">
        {metrics.map(([label, value]) => (
          <article key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
          </article>
        ))}
      </section>

      {notice && (
        <section className="notice" role="status">
          <span>{notice}</span>
          <button onClick={() => setNotice("")}>知道了</button>
        </section>
      )}

      <section className="workspace">
        <aside className="panel">
          <h2>{project.domain} · 音栓列表</h2>
          <div className="stop-list">
            {stops.map((s) => {
              const ref = s.referencePipeId ? pipesById.get(s.referencePipeId) : undefined;
              const prog = stopProgress(s.id);
              const percent = prog.total === 0 ? 0 : Math.round((prog.ok / prog.total) * 100);
              return (
                <button
                  key={s.id}
                  className={"stop-card" + (selectedStopId === s.id ? " active" : "")}
                  onClick={() => setSelectedStopId(selectedStopId === s.id ? null : s.id)}
                >
                  <strong>{s.name}</strong>
                  <small>{s.venue}</small>
                  <span className="stop-ref">
                    基准管：
                    {ref ? (
                      <>
                        {ref.code}
                        <em className={"badge " + (ref.confirmed ? "ok" : "warn")}>
                          {ref.confirmed ? "已确认" : "未确认"}
                        </em>
                      </>
                    ) : (
                      <em className="badge danger">未指定</em>
                    )}
                  </span>
                  <span className="progress">
                    <i style={{ width: `${percent}%` }} />
                  </span>
                  <small>
                    正常 {prog.ok}/{prog.total} · 待复检 {prog.pending}
                  </small>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>专业字段</p>
              <h2>新增记录</h2>
            </div>
            <div className="batch-picker">
              <select
                value={currentBatch?.status === "open" ? currentBatch.id : ""}
                onChange={(e) => update((s) => ({ ...s, currentBatchId: e.target.value }))}
              >
                {openBatches.length === 0 && <option value="">无进行中批次</option>}
                {openBatches.map((b) => (
                  <option key={b.id} value={b.id}>
                    归属批次：{b.name}
                  </option>
                ))}
              </select>
              <button className="primary" onClick={newBatch}>
                新建批次
              </button>
            </div>
          </div>
          <div className="field-grid">
            <label>
              <span>场馆名称</span>
              <input
                placeholder="填写场馆名称"
                value={form.venue}
                onChange={(e) => setForm({ ...form, venue: e.target.value })}
              />
            </label>
            <label>
              <span>音栓</span>
              <input
                placeholder="填写音栓"
                value={form.stop}
                onChange={(e) => setForm({ ...form, stop: e.target.value })}
              />
            </label>
            <label>
              <span>音管编号</span>
              <input
                placeholder="填写音管编号"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
              />
            </label>
            <label>
              <span>音高</span>
              <input
                placeholder="填写音高"
                value={form.pitch}
                onChange={(e) => setForm({ ...form, pitch: e.target.value })}
              />
            </label>
            <label>
              <span>音分偏差（相对基准管）</span>
              <input
                type="number"
                placeholder="填写音分偏差"
                value={form.cents}
                onChange={(e) => setForm({ ...form, cents: e.target.value })}
              />
            </label>
            <label>
              <span>维修备注</span>
              <input
                placeholder="填写维修备注"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </label>
          </div>
          <div className="form-footer">
            <button className="primary" onClick={addRecord}>
              保存记录
            </button>
          </div>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>调音偏差表</p>
            <h2>
              音管调音记录
              {selectedStopId && stopsById.get(selectedStopId)
                ? ` · ${stopsById.get(selectedStopId)!.venue} ${stopsById.get(selectedStopId)!.name}`
                : ""}
            </h2>
          </div>
          <div className="chips">
            {filterChips.map(([key, label]) => (
              <button
                key={key}
                className={statusFilter === key ? "chip-active" : ""}
                onClick={() => setStatusFilter(key)}
              >
                {label}
              </button>
            ))}
            <button onClick={exportSummary}>导出摘要</button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="tuning">
            <thead>
              <tr>
                <th>音管编号</th>
                <th>音高</th>
                <th>相对音分</th>
                <th>依赖基准</th>
                <th>状态</th>
                <th>批次</th>
                <th>维修备注</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visiblePipes.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    暂无匹配记录
                  </td>
                </tr>
              )}
              {visiblePipes.map((p) => {
                const stop = stopsById.get(p.stopId);
                const isReference = stop?.referencePipeId === p.id;
                const batch = batchesById.get(p.batchId);
                const siblings = pipes.filter((x) => x.stopId === p.stopId && x.id !== p.id);
                return (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.code}</strong>
                      <br />
                      <small className="muted">
                        {stop?.venue} · {stop?.name}
                      </small>
                    </td>
                    <td>{p.pitch}</td>
                    <td className={Math.abs(p.cents) > 10 ? "over" : ""}>
                      {isReference ? "0（基准）" : formatCents(p.cents)}
                    </td>
                    <td>
                      {isReference ? (
                        <span className="muted">本管为基准</span>
                      ) : (
                        <select
                          value={p.referenceId ?? ""}
                          onChange={(e) => changeDependency(p.id, e.target.value)}
                        >
                          <option value="">未指定</option>
                          {siblings.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.code}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      {isReference && <em className={"badge " + (p.confirmed ? "ref" : "warn")}>基准管{p.confirmed ? "" : "·未确认"}</em>}
                      {!isReference && p.status === "pending" && <em className="badge danger">待复检</em>}
                      {!isReference && p.status === "ok" && <em className="badge ok">正常</em>}
                    </td>
                    <td>
                      <small>{batch?.name ?? "—"}</small>
                    </td>
                    <td>
                      <small>{p.note}</small>
                    </td>
                    <td>
                      <div className="row-actions">
                        {p.status === "pending" && (
                          <>
                            <input
                              className="cents-input"
                              type="number"
                              placeholder={String(p.cents)}
                              value={recheckCents[p.id] ?? ""}
                              onChange={(e) => setRecheckCents((m) => ({ ...m, [p.id]: e.target.value }))}
                            />
                            <button onClick={() => recheck(p.id)}>复检确认</button>
                          </>
                        )}
                        {!isReference && (
                          <button onClick={() => setReference(p.stopId, p.id)}>设为基准</button>
                        )}
                        {isReference && !p.confirmed && (
                          <button onClick={() => confirmReference(p.id)}>确认基准</button>
                        )}
                        {isReference && p.confirmed && (
                          <button onClick={() => retuneReference(p.stopId)}>重调基准</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>单次维护报告</p>
            <h2>调音批次</h2>
          </div>
          <button className="primary" onClick={newBatch}>
            新建批次
          </button>
        </div>
        <div className="batch-list">
          {batches.map((b) => {
            const bp = pipes.filter((p) => p.batchId === b.id);
            const pend = bp.filter((p) => p.status === "pending").length;
            return (
              <article key={b.id} className="batch-card">
                <div>
                  <h3>
                    {b.name} <em className={"badge " + (b.status === "open" ? "warn" : b.status === "closed" ? "ok" : "danger")}>{batchStatusText[b.status]}</em>
                    {b.id === state.currentBatchId && b.status === "open" && <em className="badge ref">当前批次</em>}
                  </h3>
                  <p className="muted">
                    音管 {bp.length} 根 · 待复检 {pend} 根
                    {b.reason ? ` · 拒绝原因：${b.reason}` : ""}
                  </p>
                </div>
                {b.status === "open" && (
                  <div className="row-actions">
                    {b.id !== state.currentBatchId && (
                      <button onClick={() => update((s) => ({ ...s, currentBatchId: b.id }))}>设为当前</button>
                    )}
                    <button className="primary" onClick={() => closeBatch(b.id)}>
                      结项
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}

export default App;
