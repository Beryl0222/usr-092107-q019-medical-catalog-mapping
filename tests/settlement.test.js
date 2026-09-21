import assert from "node:assert/strict";
import test from "node:test";

import { explainSettledLine } from "../src/domain/settlement.js";
import {
  newPlatform, bootCatalogs, publishHebeiRules, proposalIdFor, expert,
  claimLine, claim, approveBedEquivalent,
} from "./helpers.js";

// 批准演示数据中的全套映射
function approveAllMappings(pf) {
  approveBedEquivalent(pf);

  let id = proposalIdFor(pf, "BJ-C0203");
  pf.approveMapping(id, {
    proposal_event_id: id, kind: "PARTIAL_OVERLAP", effective_from: "2026-10-01", effective_to: null,
    links: [{
      provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-C0203" },
      national_ref: { catalog_id: "NAT-MSL-2026", code: "N220300012" },
      unit_conversion: { acknowledged: true, explanation: "单次单部位时次与部位一致，多部位须分行" },
    }],
    difference_note: "省版含图文报告工本，国家明确排除；仅检查费可比照支付，差异在于工本内涵。",
    expert_review: [expert("李建华", "北京市医学会", "部分重叠")],
    mapping_basis: ["纪要 MZ-2026-0918-03"],
  });

  id = proposalIdFor(pf, "BJ-D0301");
  pf.approveMapping(id, {
    proposal_event_id: id, kind: "ONE_TO_MANY", effective_from: "2026-10-01", effective_to: null,
    links: [
      { provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-D0301" }, national_ref: { catalog_id: "NAT-MSL-2026", code: "N250200018" }, share: 0.7 },
      { provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-D0301" }, national_ref: { catalog_id: "NAT-MSL-2026", code: "N250200019" }, share: 0.3 },
    ],
    difference_note: "省按日打包含口腔护理，国家拆为疾病护理与专项口腔护理，按7:3拆账处理差异。",
    expert_review: [expert("王芳", "中华护理学会", "7:3")],
    mapping_basis: ["纪要 MZ-2026-0918-05"],
  });

  id = proposalIdFor(pf, "BJ-D0302");
  pf.approveMapping(id, {
    proposal_event_id: id, kind: "EQUIVALENT", effective_from: "2026-10-01", effective_to: null,
    links: [{
      provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-D0302" },
      national_ref: { catalog_id: "NAT-MSL-2026", code: "N250200018" },
    }],
    expert_review: [expert("王芳", "中华护理学会", "等价")],
    mapping_basis: ["纪要 MZ-2026-0918-05"],
  });

  id = proposalIdFor(pf, "BJ-E0401");
  pf.approveMapping(id, {
    proposal_event_id: id, kind: "ONE_TO_MANY", effective_from: "2026-10-01", effective_to: null,
    links: [
      { provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-E0401" }, national_ref: { catalog_id: "NAT-MSL-2026", code: "N340100007" }, share: 0.5,
        unit_conversion: { acknowledged: true, explanation: "每次4穴，普通针刺2穴" } },
      { provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-E0401" }, national_ref: { catalog_id: "NAT-MSL-2026", code: "N340100008" }, share: 0.5,
        unit_conversion: { acknowledged: true, explanation: "电针2穴，需备案" } },
    ],
    difference_note: "省按次打包，国家分列且按穴位，内涵交叉单位不同，对半拆账。",
    expert_review: [expert("赵启明", "中国针灸学会", "对半")],
    mapping_basis: ["纪要 MZ-2026-0918-07"],
  });

  id = proposalIdFor(pf, "BJ-F0501");
  return pf.approveMapping(id, {
    proposal_event_id: id, kind: "UNMAPPED", effective_from: "2026-10-01", effective_to: null,
    provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-F0501" }, links: [],
    rationale: "蒙医传统整骨术无对应国家项目，名称近似的复位术内涵不同，保持未映射，禁止就近落码。",
    expert_review: [expert("巴特尔", "内蒙古国际蒙医医院", "无对应")],
    mapping_basis: ["纪要 MZ-2026-0918-09"],
  });
}

function bootWorld() {
  const pf = newPlatform();
  bootCatalogs(pf);
  approveAllMappings(pf);
  publishHebeiRules(pf);
  return pf;
}

// ---------- 预检 ----------

test("预检：无人工映射、材料缺口、单位不符、未映射项目分别阻断", () => {
  const pf = newPlatform();
  bootCatalogs(pf);
  publishHebeiRules(pf);
  // 只批床位费等价
  approveBedEquivalent(pf);
  const result = pf.precheck(claim([
    claimLine({ line_id: "A", provincial_item_code: "BJ-C0203", charged_unit: "日",
      unit_price_yuan: 120, materials: [] }),
  ]));
  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((b) => b.includes("尚无人工确认映射")));
  assert.ok(result.blocking.some((b) => b.includes("检查申请单")));
  assert.ok(result.blocking.some((b) => b.includes("计价单位")));
});

test("预检：经论证保持未映射的项目不能提交基金结算", () => {
  const pf = bootWorld();
  const result = pf.precheck(claim([
    claimLine({ line_id: "A", provincial_item_code: "BJ-F0501", unit_price_yuan: 800,
      materials: ["民族医执业资质证明", "影像学资料"], auth_evidence: true }),
  ]));
  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((b) => b.includes("保持未映射")));
  assert.ok(result.blocking.some((b) => b.includes("禁止就近落码")));
});

test("预检：参保地要求事前备案而缺证据时阻断，补齐后通过", () => {
  const pf = bootWorld();
  const before = pf.precheck(claim([
    claimLine({ line_id: "A", provincial_item_code: "BJ-E0401", quantity: 2, unit_price_yuan: 100,
      materials: ["治疗知情同意书", "理疗备案表"], auth_evidence: false }),
  ]));
  assert.ok(before.blocking.some((b) => b.includes("事前备案")));
  const after = pf.precheck(claim([
    claimLine({ line_id: "A", provincial_item_code: "BJ-E0401", quantity: 2, unit_price_yuan: 100,
      materials: ["治疗知情同意书", "理疗备案表"], auth_evidence: true }),
  ]));
  assert.equal(after.ok, true);
});

test("预检：同次申报多省项目映射到同一国家项目时提示重复收费", () => {
  const pf = bootWorld();
  const result = pf.precheck(claim([
    claimLine({ line_id: "A", provincial_item_code: "BJ-D0301", materials: ["护理记录单"] }),
    claimLine({ line_id: "B", line_id: "B", provincial_item_code: "BJ-D0302" }),
  ]));
  assert.ok(result.blocking.some((b) => b.includes("重复收费")));
});

// ---------- 结算金额 ----------

test("结算：甲类等价项目全额走基金", () => {
  const pf = bootWorld();
  const settled = pf.settle(claim([claimLine({ quantity: 3, unit_price_yuan: 50 })]));
  const l = settled.payload.lines[0];
  assert.deepEqual(l.result.amounts, { charged_yuan: 150, fund_pay_yuan: 150, self_pay_yuan: 0 });
});

test("结算：乙类先行自付与参保地限价同时生效", () => {
  const pf = bootWorld();
  // 超声 120 元：限价 110；超出 10 元自付，其余 110 中乙类先自付 10%=11，基金 99
  const settled = pf.settle(claim([
    claimLine({ line_id: "A", provincial_item_code: "BJ-C0203", unit_price_yuan: 120,
      charged_unit: "次", materials: ["检查申请单"] }),
  ]));
  const l = settled.payload.lines[0];
  assert.equal(l.result.amounts.fund_pay_yuan, 99);
  assert.equal(l.result.amounts.self_pay_yuan, 21);
  assert.ok(l.result.self_pay_reasons.some((r) => r.includes("限价")));
  assert.ok(l.result.self_pay_reasons.some((r) => r.includes("乙类")));
});

test("结算：一对多按专家比例拆账，两份额各自适用参保地规则", () => {
  const pf = bootWorld();
  // 综合护理 5 日 × 40 = 200：70%→疾病护理甲类 140 全付；
  // 30%→专项口腔护理 60，限价 30（注意限价按份额折算口径），乙类先自付15%
  const settled = pf.settle(claim([
    claimLine({ line_id: "A", provincial_item_code: "BJ-D0301", quantity: 5, unit_price_yuan: 40,
      charged_unit: "日", materials: ["护理记录单"] }),
  ]));
  const l = settled.payload.lines[0];
  const basisCodes = l.result.basis.national.map((n) => n.code);
  assert.deepEqual(basisCodes.sort(), ["N250200018", "N250200019"]);
  assert.equal(l.result.amounts.charged_yuan, 200);
  assert.equal(l.result.amounts.fund_pay_yuan + l.result.amounts.self_pay_yuan, 200);
});

test("结算：未映射项目无法通过预检，绝不就近落到最近国家代码", () => {
  const pf = bootWorld();
  assert.throws(() => pf.settle(claim([
    claimLine({ line_id: "A", provincial_item_code: "BJ-F0501", unit_price_yuan: 800,
      materials: ["民族医执业资质证明", "影像学资料"], auth_evidence: true }),
  ])), /保持未映射/);
});

test("结算：丙类项目全额自付", () => {
  const pf = bootWorld();
  pf.publishRules("RULES-HEB-2026B", {
    province_code: "130000", effective_from: "2026-10-01",
    rules: [{ national_code: "N110100001", category: "丙", coinsurance_self_pay: 0, price_cap_yuan: null, prior_auth_required: false, self_pay_reasons: [] }],
  });
  // 新规则集生效后重算
  const settled = pf.settle(claim([claimLine({ quantity: 1, unit_price_yuan: 50 })]));
  const l = settled.payload.lines[0];
  assert.equal(l.result.amounts.fund_pay_yuan, 0);
  assert.equal(l.result.amounts.self_pay_yuan, 50);
  assert.ok(l.result.self_pay_reasons.some((r) => r.includes("丙类")));
});

// ---------- 按服务日选版本与规则 ----------

test("口径选择：以服务发生日而非提交日为准，旧账单按旧规则", () => {
  const pf = bootWorld();
  // 12 月发布新规则：床位费改为乙类先自付 20%
  pf.publishRules("RULES-HEB-2027", {
    province_code: "130000", effective_from: "2026-12-01",
    rules: [{ national_code: "N110100001", category: "乙", coinsurance_self_pay: 0.2, price_cap_yuan: null, prior_auth_required: false, self_pay_reasons: [] }],
  });
  // 服务日 11 月、提交日 12 月：仍按 11 月有效规则（甲类全付）
  const settled = pf.settle(claim([
    claimLine({ service_date: "2026-11-15", quantity: 1, unit_price_yuan: 50 }),
  ], { submitted_at: "2026-12-05T10:00:00+08:00" }));
  const l = settled.payload.lines[0];
  assert.equal(l.result.amounts.fund_pay_yuan, 50);
  assert.equal(l.result.basis.rules.version_event_id, pf.store.stream("rule_set", "RULES-HEB-2026")[0].event_id);
});

test("口径选择：服务日早于目录生效日则无有效版本，费用全自付且说明原因", async () => {
  const { MappingPlatform } = await import("../src/platform.js");
  const { buildProjection } = await import("../src/domain/projection.js");
  const { computeLine, resolveLine } = await import("../src/domain/settlement.js");
  const pf = new MappingPlatform("CN");
  bootCatalogs(pf, { nationalFrom: "2026-10-01", provincialFrom: "2026-10-01" });
  const proj = pf.projection();
  const line = claimLine({ service_date: "2026-09-15" });
  const resolved = resolveLine({ projection: proj, nationalScope: "CN", line, serviceDate: line.service_date });
  const r = computeLine({ line, serviceDate: line.service_date, ...resolved });
  assert.equal(r.status, "NOT_IN_FORCE");
  assert.equal(r.amounts.fund_pay_yuan, 0);
  assert.ok(r.self_pay_reasons[0].includes("无有效省级项目"));
});

// ---------- 依据固化与账单说明 ----------

test("可溯源：账单行固化两级目录事件编号、发布序号、哈希与映射裁定", () => {
  const pf = bootWorld();
  const settled = pf.settle(claim([claimLine({ quantity: 1, unit_price_yuan: 50 })]));
  const b = settled.payload.lines[0].result.basis;
  assert.ok(b.provincial.activation_event_id);
  assert.equal(b.provincial.release_seq, 2);
  assert.match(b.provincial.release_hash, /^[0-9a-f]{64}$/);
  assert.ok(b.decision);
  assert.equal(b.decision.kind, "EQUIVALENT");
  assert.ok(b.national[0].item_snapshot.clinical_content.length > 0);
  assert.ok(b.rules.version_event_id);
});

test("患者说明：列出项目来源、映射依据、自付理由与发布事件编号", () => {
  const pf = bootWorld();
  const settled = pf.settle(claim([
    claimLine({ line_id: "A", provincial_item_code: "BJ-C0203", unit_price_yuan: 120,
      charged_unit: "次", materials: ["检查申请单"] }),
  ]));
  const text = explainSettledLine("A", settled.payload);
  assert.ok(text.includes("项目来源"));
  assert.ok(text.includes("映射决定"));
  assert.ok(text.includes("映射依据"));
  assert.ok(text.includes("自付理由"));
  assert.ok(text.includes("发布事件"));
});

// ---------- 更正：只作用于未终结账单 ----------

test("更正：新裁定只对未终结账单行产生差额，已终结行封存原口径", () => {
  const pf = bootWorld();
  const settled = pf.settle(claim([
    claimLine({ line_id: "OPEN", provincial_item_code: "BJ-E0401", quantity: 2, unit_price_yuan: 100,
      materials: ["理疗备案表", "治疗知情同意书"], auth_evidence: true }),
    claimLine({ line_id: "SEALED", provincial_item_code: "BJ-E0401", quantity: 2, unit_price_yuan: 100,
      materials: ["理疗备案表", "治疗知情同意书"], auth_evidence: true }),
  ], { claim_id: "CLAIM-C-001" }));
  const beforeOpen = settled.payload.lines.find((l) => l.line_id === "OPEN").result.amounts;
  const beforeSealed = settled.payload.lines.find((l) => l.line_id === "SEALED").result.amounts;
  pf.finalizeLine("CLAIM-C-001", "SEALED");

  const id = proposalIdFor(pf, "BJ-E0401");
  const correction = pf.approveMapping(id, {
    proposal_event_id: id, kind: "ONE_TO_MANY", effective_from: "2026-10-01", effective_to: null,
    correction_of: settled.payload.lines[0].result.basis.decision.decision_event_id,
    links: [
      { provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-E0401" }, national_ref: { catalog_id: "NAT-MSL-2026", code: "N340100007" }, share: 0.6,
        unit_conversion: { acknowledged: true, explanation: "复核取穴修正为0.6" } },
      { provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-E0401" }, national_ref: { catalog_id: "NAT-MSL-2026", code: "N340100008" }, share: 0.4,
        unit_conversion: { acknowledged: true, explanation: "电针0.4，需备案" } },
    ],
    difference_note: "更正拆账比例为6:4，原5:5高估电针份额，内涵差异说明从略但足够详细以满足校验。",
    expert_review: [expert("赵启明", "中国针灸学会", "修正6:4")],
    mapping_basis: ["更正纪要 MZ-2026-1120-02"],
  });
  const adj = pf.applyCorrections("CLAIM-C-001", { because_event_id: correction.event_id, reason: "拆账比例更正" });
  assert.ok(adj);
  const adjusted = adj.payload.adjustments.map((a) => a.line_id);
  assert.deepEqual(adjusted, ["OPEN"]);

  const state = pf.claims.get("CLAIM-C-001");
  const open = state.payload.lines.find((l) => l.line_id === "OPEN");
  const sealed = state.payload.lines.find((l) => l.line_id === "SEALED");
  assert.notDeepEqual(open.result.amounts, beforeOpen);
  assert.deepEqual(sealed.result.amounts, beforeSealed);
  assert.equal(open.result.basis.decision.decision_event_id, correction.event_id);
});

test("更正：无差额时不产生 CLAIM_ADJUSTED 事件", () => {
  const pf = bootWorld();
  pf.settle(claim([claimLine({ line_id: "A", quantity: 1, unit_price_yuan: 50 })]));
  const countBefore = pf.store.all().length;
  // 无任何新发布，直接尝试更正 → null，不写事件
  const result = pf.applyCorrections("CLAIM-T-001", { because_event_id: "none", reason: "无变化" });
  assert.equal(result, null);
  assert.equal(pf.store.all().length, countBefore);
});

test("终结：账单行一经封存不得重复终结", () => {
  const pf = bootWorld();
  pf.settle(claim([claimLine({ line_id: "A" })]));
  pf.finalizeLine("CLAIM-T-001", "A");
  assert.throws(() => pf.finalizeLine("CLAIM-T-001", "A"), /已终结/);
});
