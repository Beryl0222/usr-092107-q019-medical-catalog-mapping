import assert from "node:assert/strict";
import test from "node:test";

import { jaccard, proposeForItem, detectManyToOne, scoreCandidate } from "../src/domain/matcher.js";
import { validateDecision, validateItem } from "../src/domain/validators.js";
import { MappingPlatform } from "../src/platform.js";
import {
  newPlatform, bootCatalogs, proposalIdFor, expert,
} from "./helpers.js";

test("候选引擎：同名等价项得分高且无风险旗标", () => {
  const p = newPlatform();
  bootCatalogs(p);
  const id = proposalIdFor(p, "BJ-B0101");
  const proposal = p.store.stream("mapping_decision", id)[0].payload;
  const bed = proposal.candidates.find((c) => c.national_code === "N110100001");
  assert.ok(bed, "床位费应进入候选");
  assert.equal(bed.unit_compatible, true);
  assert.deepEqual(bed.risk_flags, []);
});

test("候选引擎：计价单位不同必挂禁止合并风险旗标", () => {
  const c = scoreCandidate(
    { name: "超声", clinical_content: "彩色多普勒超声检查", pricing_unit: "次", exclusions: [], applicable_institutions: ["三级"] },
    { name: "彩色多普勒超声检查", clinical_content: "彩色多普勒超声检查并出具报告", pricing_unit: "部位", exclusions: [], applicable_institutions: ["三级"] },
  );
  assert.equal(c.unit_compatible, false);
  assert.ok(c.risk_flags.some((f) => f.includes("计价单位不一致")));
});

test("候选引擎：省内涵包含国家排除项时给出差异旗标", () => {
  const c = scoreCandidate(
    { name: "超声检查含图文报告", clinical_content: "超声检查，含图文报告工本", pricing_unit: "次", exclusions: [], applicable_institutions: ["三级"] },
    { name: "超声检查", clinical_content: "超声检查", pricing_unit: "次", exclusions: ["图文报告工本费"], applicable_institutions: ["三级"] },
  );
  assert.ok(c.risk_flags.some((f) => f.includes("国家明确排除项")));
});

test("候选引擎：国家内涵分散在多个国家项目时给出一对多提示", () => {
  const proposal = proposeForItem(
    { catalog_id: "P", code: "PX", name: "综合护理含口腔护理", clinical_content: "等级疾病护理并含专项口腔清洁护理操作", pricing_unit: "日", exclusions: [], applicable_institutions: ["三级"] },
    [
      { catalog_id: "N", code: "N1", name: "疾病护理", clinical_content: "病情观察与生活照料的疾病护理", pricing_unit: "日", exclusions: [], applicable_institutions: ["三级"] },
      { catalog_id: "N", code: "N2", name: "专项口腔护理", clinical_content: "专项口腔清洁护理操作", pricing_unit: "次", exclusions: [], applicable_institutions: ["三级"] },
    ],
  );
  assert.equal(proposal.combined?.relation_hint, "ONE_TO_MANY");
  assert.ok(proposal.combined.national_codes.includes("N1"));
  assert.ok(proposal.combined.national_codes.includes("N2"));
});

test("候选引擎：两个省项目都近似同一国家项目时给出多对一预警", () => {
  const mk = (code, name) => proposeForItem(
    { catalog_id: "P", code, name, clinical_content: name, pricing_unit: "日", exclusions: [], applicable_institutions: ["三级"] },
    [{ catalog_id: "N", code: "N1", name: "疾病护理按等级", clinical_content: "疾病护理按等级", pricing_unit: "日", exclusions: [], applicable_institutions: ["三级"] }],
  );
  const warnings = detectManyToOne([mk("P1", "疾病护理"), mk("P2", "等级护理")]);
  assert.equal(warnings[0]?.relation_hint, "MANY_TO_ONE");
  assert.deepEqual(warnings[0].provincial_codes.sort(), ["P1", "P2"]);
});

test("候选引擎：无近似项时明确建议 UNMAPPED，而不是给最近代码", () => {
  const proposal = proposeForItem(
    { catalog_id: "P", code: "P9", name: "蒙医传统整骨术", clinical_content: "蒙医传统手法骨折整复", pricing_unit: "次", exclusions: [], applicable_institutions: ["三级"] },
    [{ catalog_id: "N", code: "N1", name: "彩色多普勒超声检查", clinical_content: "超声影像检查", pricing_unit: "部位", exclusions: [], applicable_institutions: ["三级"] }],
  );
  assert.equal(proposal.suggested_kind, "UNMAPPED");
  assert.deepEqual(proposal.candidates, []);
});

test("相似度：完全相同为 1，完全不相交为 0", () => {
  assert.equal(jaccard("普通病房床位费", "普通病房床位费"), 1);
  assert.equal(jaccard("甲乙丙丁", "子丑寅卯"), 0);
});

// ---------- 人工裁定校验 ----------

const validLink = () => ({
  provincial_ref: { catalog_id: "P", code: "P1" },
  national_ref: { catalog_id: "N", code: "N1" },
});

test("裁定：无专家论证或无映射依据一律驳回", () => {
  const base = {
    proposal_event_id: "pr1", kind: "EQUIVALENT", effective_from: "2026-10-01",
    links: [validLink()], expert_review: [expert()], mapping_basis: ["依据1"],
  };
  assert.ok(validateDecision({ ...base, expert_review: [] }).some((e) => e.includes("专家论证")));
  assert.ok(validateDecision({ ...base, mapping_basis: [] }).some((e) => e.includes("映射依据")));
});

test("裁定：一对多分摊比例之和必须为 1", () => {
  const payload = {
    proposal_event_id: "pr1", kind: "ONE_TO_MANY", effective_from: "2026-10-01",
    expert_review: [expert()], mapping_basis: ["依据1"], difference_note: "省项目覆盖两个国家项目内涵，需拆账处理差异。",
    links: [
      { ...validLink(), national_ref: { catalog_id: "N", code: "N1" }, share: 0.7 },
      { ...validLink(), national_ref: { catalog_id: "N", code: "N2" }, share: 0.2 },
    ],
  };
  assert.ok(validateDecision(payload).some((e) => e.includes("分摊比例之和必须为 1")));
  payload.links[1].share = 0.3;
  assert.deepEqual(validateDecision(payload), []);
});

test("裁定：单位换算必须人工确认并书面说明", () => {
  const payload = {
    proposal_event_id: "pr1", kind: "EQUIVALENT", effective_from: "2026-10-01",
    expert_review: [expert()], mapping_basis: ["依据1"],
    links: [{ ...validLink(), unit_conversion: { acknowledged: false, explanation: "" } }],
  };
  assert.ok(validateDecision(payload).some((e) => e.includes("人工明确确认")));
});

test("裁定：非等价映射必须书面说明差异", () => {
  const payload = {
    proposal_event_id: "pr1", kind: "PARTIAL_OVERLAP", effective_from: "2026-10-01",
    expert_review: [expert()], mapping_basis: ["依据1"], links: [validLink()],
  };
  assert.ok(validateDecision(payload).some((e) => e.includes("差异")));
});

test("裁定：保持未映射不得附带国家链接，且必须书面说明理由", () => {
  assert.ok(validateDecision({
    proposal_event_id: "pr1", kind: "UNMAPPED", effective_from: "2026-10-01",
    provincial_ref: { catalog_id: "P", code: "P9" },
    expert_review: [expert()], mapping_basis: ["依据1"], links: [validLink()], rationale: "无对应国家项目，禁止就近落码。",
  }).some((e) => e.includes("不得附带")));
  assert.ok(validateDecision({
    proposal_event_id: "pr1", kind: "UNMAPPED", effective_from: "2026-10-01",
    provincial_ref: { catalog_id: "P", code: "P9" },
    expert_review: [expert()], mapping_basis: ["依据1"], links: [],
  }).some((e) => e.includes("书面说明理由")));
});

test("裁定：机器候选不能直接当决定——没有候选事件不得裁定", () => {
  const pf = newPlatform();
  assert.throws(() => pf.approveMapping("md-not-exist", {
    proposal_event_id: "md-not-exist", kind: "EQUIVALENT", effective_from: "2026-10-01",
    expert_review: [expert()], mapping_basis: ["x"], links: [validLink()],
  }), /必须基于已登记的机器候选/);
});

test("项目：临床内涵、计价单位、适用机构、支付条件缺一不可", () => {
  const errors = validateItem({
    code: "X", name: "X", clinical_content: "", exclusions: [],
    pricing_unit: "次", applicable_institutions: ["三级"],
    payment_conditions: {},
  }, "national");
  assert.ok(errors.some((e) => e.includes("临床内涵")));
  assert.ok(errors.some((e) => e.includes("事前备案")));
});

// ---------- 停用与替代 ----------

test("停用项目：服务日到达停用日后不得结算，须走替代项目", () => {
  const pf = newPlatform();
  bootCatalogs(pf);
  pf.discontinueItem({
    catalog_id: "BJ-MSL-2026", code: "BJ-B0101", discontinued_from: "2026-11-01",
    replacements: ["BJ-B0199"], reason: "并入新床位费项目",
  });
  const v = pf.projection().activeVersion("provincial", "110000", "2026-11-03");
  const item = pf.projection().findItem(v, "BJ-B0101", "2026-11-03");
  assert.equal(item.discontinued, true);
  assert.deepEqual(item.replacements, ["BJ-B0199"]);
  // 停用日之前仍有效
  const before = pf.projection().findItem(v, "BJ-B0101", "2026-10-20");
  assert.equal(before.discontinued, false);
});

// ---------- 生效区间：后继版本自动接续，旧服务单仍取旧版 ----------

test("版本接续：新国家目录生效后，旧服务日仍取旧版，新服务日取新版", () => {
  const pf = new MappingPlatform("CN");
  pf.draftCatalog({
    catalog_id: "NAT-V1", name: "国家目录V1", level: "national", scope: "CN",
    items: [{ code: "N1", name: "项目", clinical_content: "内涵甲", exclusions: [], pricing_unit: "次", applicable_institutions: ["三级"], payment_conditions: { prior_auth_required: false } }],
  });
  pf.activateCatalog("NAT-V1", { effective_from: "2026-01-01" });
  pf.draftCatalog({
    catalog_id: "NAT-V2", name: "国家目录V2", level: "national", scope: "CN",
    items: [{ code: "N1", name: "项目", clinical_content: "内涵乙", exclusions: [], pricing_unit: "次", applicable_institutions: ["三级"], payment_conditions: { prior_auth_required: false } }],
  });
  pf.activateCatalog("NAT-V2", { effective_from: "2026-12-01" });
  const proj = pf.projection();
  assert.equal(proj.activeVersion("national", "CN", "2026-11-30").catalog_id, "NAT-V1");
  assert.equal(proj.activeVersion("national", "CN", "2026-12-01").catalog_id, "NAT-V2");
});

test("发布固化：生效后再以同 ID 草拟不同内容，已发布版本的项目快照不变", () => {
  const pf = new MappingPlatform("CN");
  const v1 = {
    catalog_id: "NAT-X", name: "国家目录X", level: "national", scope: "CN",
    items: [{ code: "N1", name: "项目", clinical_content: "原始内涵", exclusions: [], pricing_unit: "次", applicable_institutions: ["三级"], payment_conditions: { prior_auth_required: false } }],
  };
  pf.draftCatalog(v1);
  pf.activateCatalog("NAT-X", { effective_from: "2026-01-01" });
  // 激活后同 ID 草稿被改写（错误操作或重放重复草拟）：不得影响已发布口径
  pf.draftCatalog({ ...v1, items: [{ ...v1.items[0], clinical_content: "被改写的内涵" }] });
  const active = pf.projection().activeVersion("national", "CN", "2026-06-01");
  assert.equal(active.items[0].clinical_content, "原始内涵");
});
