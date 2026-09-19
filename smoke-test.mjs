// 冒烟测试：验证基准联动与结项校验的纯逻辑（不渲染 React）
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { build } from "esbuild";

const tmp = mkdtempSync(join(tmpdir(), "organtest-"));
const reactStub = join(tmp, "react-stub.js");
writeFileSync(reactStub, "export const useState=()=>[{},()=>{}];export const useEffect=()=>{};export const useMemo=(f)=>f();export default {};");

const appSource = readFileSync("src/App.tsx", "utf8").replace('import "./styles.css";', "");
const injected = appSource.replace(
  "export default App;",
  "export const _t = { collectDependents, findCycleNodes, computeEffective, checkBatch, checkHasIssues, seedState };\nexport default App;",
);
const injFile = join(tmp, "AppInj.tsx");
writeFileSync(injFile, injected);
const injOut = join(tmp, "out.js");
await build({
  entryPoints: [injFile],
  bundle: true,
  format: "esm",
  write: true,
  outfile: injOut,
  external: ["*.css"],
  alias: { react: reactStub },
  logLevel: "silent",
});
const T = (await import("file://" + injOut))._t;

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log("PASS", msg);
  else {
    console.error("FAIL", msg);
    failures++;
  }
};

const seeded = T.seedState();

/* 1. 示例批次结项：缺基准(Mixtur V) + 待复检(F2)，必须被拒绝 */
const c1 = T.checkBatch("b-seed-1", seeded.stops, seeded.pipes);
ok(T.checkHasIssues(c1), "示例批次存在结项阻碍");
ok(c1.missingRef.some((m) => m.includes("Mixtur V")), "缺基准被检出");
ok(c1.recheck.some((m) => m.includes("F2")), "待复检被检出");

/* 2. 合成偏差沿链累加：C4=2, C#4=+7→9, G4 依 C#4 -2→7 */
const eff = T.computeEffective(seeded.pipes, seeded.stops);
ok(eff.get("p-seed-12") === 9, "二级相对差合成 2+7=9");
ok(eff.get("p-seed-14") === 7, "传递链合成 2+7-2=7");
ok(eff.get("p-seed-23") === 1, "Principal A3 合成 0-3+4=1");

/* 3. 传递依赖收集：C4 的依赖包含 C#4 与 G4（二级），不含自身 */
const deps = T.collectDependents("p-seed-11", seeded.pipes);
ok(deps.includes("p-seed-12") && deps.includes("p-seed-14"), "二级传递依赖被收集");
ok(!deps.includes("p-seed-11"), "不含自身");

/* 4. 成环检测：C4→G4→C#4→C4 */
const cyclic = seeded.pipes.map((p) => ({ ...p }));
const s1 = cyclic.find((p) => p.id === "p-seed-11");
s1.refPipeId = "p-seed-14";
s1.relCents = 0;
const cyc = T.findCycleNodes(cyclic);
ok(["p-seed-11", "p-seed-12", "p-seed-14"].every((id) => cyc.has(id)), "环节点全部识别");
ok(!cyc.has("p-seed-13"), "非环节点不被误报");
const c2 = T.checkBatch("b-seed-1", seeded.stops, cyclic);
ok(c2.cycle.length > 0, "成环批次被拒绝");
ok(T.computeEffective(cyclic, seeded.stops).get("p-seed-11") === null, "成环时合成偏差安全降级为 null");

/* 5. 全部合规后可结项：补 Mixtur 基准并确认、E5 录差值、F2 清零复检 */
const fixed = T.seedState();
fixed.stops.find((s) => s.id === "s-seed-4").referencePipeId = "p-seed-41";
const p41 = fixed.pipes.find((p) => p.id === "p-seed-41");
p41.absCents = 1;
p41.confirmed = true;
const p42 = fixed.pipes.find((p) => p.id === "p-seed-42");
p42.refPipeId = "p-seed-41";
p42.relCents = 2;
fixed.pipes.find((p) => p.id === "p-seed-32").recheck = false;
ok(!T.checkHasIssues(T.checkBatch("b-seed-1", fixed.stops, fixed.pipes)), "修复后批次可结项");

/* 6. 基准未确认场景 */
const unconf = T.seedState();
unconf.pipes.find((p) => p.id === "p-seed-11").confirmed = false;
ok(T.checkBatch("b-seed-1", unconf.stops, unconf.pipes).unconfirmed.some((m) => m.includes("Trumpet")), "基准未确认被检出");

/* 7. 参照指向已删除音管 → 参照缺失 */
const dangling = T.seedState();
dangling.pipes.find((p) => p.id === "p-seed-22").refPipeId = "p-gone";
ok(T.checkBatch("b-seed-1", dangling.stops, dangling.pipes).missingDep.length > 0, "悬空参照被检出");

/* 8. 相对音分差未录 → 拒绝 */
const noRel = T.seedState();
noRel.pipes.find((p) => p.id === "p-seed-13").relCents = null;
ok(T.checkBatch("b-seed-1", noRel.stops, noRel.pipes).missingRel.some((m) => m.includes("E4")), "相对差未录被检出");

process.exit(failures ? 1 : 0);
