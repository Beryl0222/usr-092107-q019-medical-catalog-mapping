import { MappingPlatform } from "../src/platform.js";
import { proposeForItem, detectManyToOne } from "../src/domain/matcher.js";
import { explainSettledLine } from "../src/domain/settlement.js";
import { nationalCatalog, provincialCatalog } from "../data/sample-catalogs.js";

const pf = new MappingPlatform("CN");

const line = (s) => console.log(`\n${"─".repeat(72)}\n${s}\n${"─".repeat(72)}`);

// 1. 两级目录草拟并正式发布（进入发布链）
pf.draftCatalog(nationalCatalog);
pf.activateCatalog("NAT-MSL-2026", {
  effective_from: "2026-10-01",
  announced_at: "2026-09-10",
  notice: "国家医保局2026年第3号公告，跨省直接结算试运行目录",
});
pf.draftCatalog(provincialCatalog);
pf.activateCatalog("BJ-MSL-2026", {
  effective_from: "2026-10-01",
  announced_at: "2026-09-12",
  notice: "京医保发〔2026〕18号",
});
line("① 两级目录已发布（国家 NAT-MSL-2026 / 北京 BJ-MSL-2026，均自 2026-10-01 生效）");

// 2. 机器只出候选
const proposals = provincialCatalog.items.map((item) =>
  proposeForItem({ ...item, catalog_id: provincialCatalog.catalog_id },
    nationalCatalog.items.map((n) => ({ ...n, catalog_id: nationalCatalog.catalog_id }))));
const proposalIds = new Map();
for (const p of proposals) proposalIds.set(p.provincial_ref.code, pf.recordProposal(p));
line("② 机器候选（仅候选，不产生任何映射效力）");
for (const p of proposals) {
  const top = p.candidates[0];
  console.log(`${p.provincial_ref.code} → 建议 ${p.suggested_kind}` +
    (top ? `；最接近 ${top.national_code}（得分 ${top.score}）` : "；无候选") +
    (p.combined ? `；疑似一对多 → ${p.combined.national_codes.join("+")}` : ""));
  for (const f of top?.risk_flags ?? []) console.log(`   ⚠ ${f}`);
}
for (const m of detectManyToOne(proposals)) {
  console.log(`   ⚑ 多对一预警：省项目 ${m.provincial_codes.join("、")} 都近似国家 ${m.national_code}`);
}

// 3. 人工逐条裁定，附专家论证与映射依据
const expert = (who, org, conclusion) => ({
  expert: who, organization: org, conclusion, reviewed_at: "2026-09-18",
});
pf.approveMapping(proposalIds.get("BJ-B0101"), {
  proposal_event_id: proposalIds.get("BJ-B0101"),
  kind: "EQUIVALENT", effective_from: "2026-10-01", effective_to: null,
  links: [{
    provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-B0101" },
    national_ref: { catalog_id: "NAT-MSL-2026", code: "N110100001" },
  }],
  expert_review: [expert("张敏", "国家医保研究院", "名称、内涵、计价单位（日）与排除项一致，判定等价")],
  mapping_basis: ["国家医保局2026年第3号公告附件2第1101项", "京医保发〔2026〕18号附件对照表第1行"],
});
pf.approveMapping(proposalIds.get("BJ-C0203"), {
  proposal_event_id: proposalIds.get("BJ-C0203"),
  kind: "PARTIAL_OVERLAP", effective_from: "2026-10-01", effective_to: null,
  links: [{
    provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-C0203" },
    national_ref: { catalog_id: "NAT-MSL-2026", code: "N220300012" },
    unit_conversion: {
      acknowledged: true,
      explanation: "省按“次”申报且一次检查单部位，与国家“部位”在单次单部位时一致；多部位须分行申报，不得按次打包",
    },
  }],
  difference_note: "省项目内涵含图文报告工本及影像存储，国家项目明确排除图文报告工本费；结算按国家口径剔除工本内涵，仅检查费可比照支付。",
  expert_review: [expert("李建华", "北京市医学会超声分会", "检查主体内涵一致，但省版含国家排除项，判定部分重叠并注明单位换算")],
  mapping_basis: ["专家论证会纪要 MZ-2026-0918-03", "国家项目 N220300012 排除项条款"],
});
pf.approveMapping(proposalIds.get("BJ-D0301"), {
  proposal_event_id: proposalIds.get("BJ-D0301"),
  kind: "ONE_TO_MANY", effective_from: "2026-10-01", effective_to: null,
  links: [
    {
      provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-D0301" },
      national_ref: { catalog_id: "NAT-MSL-2026", code: "N250200018" }, share: 0.7,
    },
    {
      provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-D0301" },
      national_ref: { catalog_id: "NAT-MSL-2026", code: "N250200019" }, share: 0.3,
    },
  ],
  difference_note: "省“综合护理（含口腔护理）”按日打包，国家目录拆为疾病护理（日）与专项口腔护理（次）两个项目，经论证按 7:3 拆账。",
  expert_review: [expert("王芳", "中华护理学会医保专委会", "省项目同时覆盖两个国家项目内涵，建议按护理工时7:3拆分")],
  mapping_basis: ["专家论证会纪要 MZ-2026-0918-05", "护理工时测算表 HS-2026-11"],
});
pf.approveMapping(proposalIds.get("BJ-D0302"), {
  proposal_event_id: proposalIds.get("BJ-D0302"),
  kind: "EQUIVALENT", effective_from: "2026-10-01", effective_to: null,
  links: [{
    provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-D0302" },
    national_ref: { catalog_id: "NAT-MSL-2026", code: "N250200018" },
  }],
  expert_review: [expert("王芳", "中华护理学会医保专委会", "与国家疾病护理内涵、单位（日）一致，判定等价")],
  mapping_basis: ["专家论证会纪要 MZ-2026-0918-05"],
});
const electroDecision = pf.approveMapping(proposalIds.get("BJ-E0401"), {
  proposal_event_id: proposalIds.get("BJ-E0401"),
  kind: "ONE_TO_MANY", effective_from: "2026-10-01", effective_to: null,
  links: [
    {
      provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-E0401" },
      national_ref: { catalog_id: "NAT-MSL-2026", code: "N340100007" }, share: 0.5,
      unit_conversion: { acknowledged: true, explanation: "省按“次”、国家按“穴位”；每次治疗按4个穴位折算，其中普通针刺占2穴" },
    },
    {
      provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-E0401" },
      national_ref: { catalog_id: "NAT-MSL-2026", code: "N340100008" }, share: 0.5,
      unit_conversion: { acknowledged: true, explanation: "加电针2穴；电针份额需理疗事前备案，缺备案不予支付" },
    },
  ],
  difference_note: "省项目一次打包针刺+电针且按次计价，国家目录分列普通针刺与电针且按穴位计价，内涵交叉但单位不同，按2:2穴位对半拆账并完成单位换算确认。",
  expert_review: [expert("赵启明", "中国针灸学会价格工作组", "内涵为两个国家项目的联合操作，按实际取穴数对半拆分，单位换算需人工确认")],
  mapping_basis: ["专家论证会纪要 MZ-2026-0918-07", "取穴操作规范 ZJ-2025-04"],
});
pf.approveMapping(proposalIds.get("BJ-F0501"), {
  proposal_event_id: proposalIds.get("BJ-F0501"),
  kind: "UNMAPPED", effective_from: "2026-10-01", effective_to: null,
  provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-F0501" },
  links: [],
  rationale: "蒙医传统整骨术为民族医特色项目，国家2026版目录无同内涵项目，名称近似的骨折闭合复位术在术式依据与操作内涵上均不同，经论证保持未映射，待国家目录增补后再行裁定，禁止就近落到任何复位类代码。",
  expert_review: [expert("巴特尔", "内蒙古国际蒙医医院", "民族医手法与现代闭合复位术理论体系不同，无对应国家项目")],
  mapping_basis: ["专家论证会纪要 MZ-2026-0918-09", "国家目录增补申请受理回执 YB-2026-0882"],
});
line("③ 六条人工映射裁定全部进入发布链：等价×2、部分重叠×1、一对多×2、保持未映射×1");

// 4. 参保地规则发布（参保地河北 130000，就医地北京）
pf.publishRules("RULES-HEB-2026", {
  province_code: "130000",
  version: "冀医保规〔2026〕4号",
  effective_from: "2026-10-01",
  rules: [
    { national_code: "N110100001", category: "甲", coinsurance_self_pay: 0, price_cap_yuan: null, prior_auth_required: false, self_pay_reasons: [] },
    { national_code: "N220300012", category: "乙", coinsurance_self_pay: 0.1, price_cap_yuan: 110, prior_auth_required: false, self_pay_reasons: [] },
    { national_code: "N250200018", category: "甲", coinsurance_self_pay: 0, price_cap_yuan: null, prior_auth_required: false, self_pay_reasons: [] },
    { national_code: "N250200019", category: "乙", coinsurance_self_pay: 0.15, price_cap_yuan: 30, prior_auth_required: false, self_pay_reasons: [] },
    { national_code: "N340100007", category: "甲", coinsurance_self_pay: 0, price_cap_yuan: null, prior_auth_required: false, self_pay_reasons: [] },
    { national_code: "N340100008", category: "乙", coinsurance_self_pay: 0.2, price_cap_yuan: null, prior_auth_required: true, self_pay_reasons: [] },
  ],
});
line("④ 参保地（河北 130000）支付规则已发布：甲乙丙分类、先行自付比例、限价、事前备案");

// 5. 医院预检：第一次提交故意有缺口
const badClaim = {
  claim_id: "CLAIM-20261105-007",
  institution_level: "三级",
  submitted_at: "2026-11-05T10:00:00+08:00",
  lines: [
    { line_id: "L1", province_code: "110000", insured_province_code: "130000", provincial_item_code: "BJ-C0203", service_date: "2026-11-03", quantity: 1, unit_price_yuan: 120, charged_unit: "次", materials: ["检查申请单"], auth_evidence: false },
    { line_id: "L2", province_code: "110000", insured_province_code: "130000", provincial_item_code: "BJ-E0401", service_date: "2026-11-03", quantity: 2, unit_price_yuan: 100, charged_unit: "次", materials: ["治疗知情同意书"], auth_evidence: false },
    { line_id: "L3", province_code: "110000", insured_province_code: "130000", provincial_item_code: "BJ-F0501", service_date: "2026-11-03", quantity: 1, unit_price_yuan: 800, charged_unit: "次", materials: ["民族医执业资质证明", "影像学资料"], auth_evidence: true },
  ],
};
const pre1 = pf.precheck(badClaim, { record: true });
line("⑤ 医院提交前预检（第一次：存在缺口，系统阻断）");
for (const b of pre1.blocking) console.log(`✗ ${b}`);

// 补齐：删除未映射项目、补材料与备案
const claim = {
  ...badClaim,
  lines: [
    badClaim.lines[0],
    { ...badClaim.lines[1], materials: ["治疗知情同意书", "理疗备案表"], auth_evidence: true },
    { line_id: "L4", province_code: "110000", insured_province_code: "130000", provincial_item_code: "BJ-D0301", service_date: "2026-11-03", quantity: 5, unit_price_yuan: 40, charged_unit: "日", materials: ["护理记录单"], auth_evidence: false },
    { line_id: "L5", province_code: "110000", insured_province_code: "130000", provincial_item_code: "BJ-B0101", service_date: "2026-11-03", quantity: 3, unit_price_yuan: 50, charged_unit: "日", materials: [], auth_evidence: false },
  ],
};
const pre2 = pf.precheck(claim);
line("⑤′ 补齐后预检");
console.log(pre2.ok ? "✓ 通过（仅有提示性信息）" : "仍有阻断项");
for (const w of pre2.warnings) console.log(`· ${w}`);

// 6. 结算并固化依据
const settled = pf.settle(claim);
line("⑥ 结算完成，每条费用固化当时有效的两级目录、映射决定与参保地规则");
for (const l of settled.payload.lines) {
  console.log(`${l.line_id} ${l.provincial_item_code}：应收 ${l.result.amounts.charged_yuan}，基金 ${l.result.amounts.fund_pay_yuan}，自付 ${l.result.amounts.self_pay_yuan}  [${l.status}]`);
}
console.log(`合计：`, settled.payload.totals);

line("⑦ 患者账单说明（示例：L2 一对多拆账 + 单位换算 + 乙类自付）");
console.log(explainSettledLine("L2", settled.payload));

// 7. L1 先行终结封存；L2 保持未终结
pf.finalizeLine(claim.claim_id, "L1");
line("⑧ L1 已终结封存（CLAIM_LINE_FINALIZED）");

// 8. 发布后更正：专家重新论证电针拆账比例 5:5 → 6:4（普通针刺0.6/电针0.4）
const correctionProposal = pf.recordProposal(proposals.find((p) => p.provincial_ref.code === "BJ-E0401"));
const correction = pf.approveMapping(correctionProposal, {
  proposal_event_id: correctionProposal,
  kind: "ONE_TO_MANY", effective_from: "2026-10-01", effective_to: null,
  correction_of: electroDecision.event_id,
  links: [
    { provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-E0401" }, national_ref: { catalog_id: "NAT-MSL-2026", code: "N340100007" }, share: 0.6,
      unit_conversion: { acknowledged: true, explanation: "复核取穴记录：每次4穴中普通针刺2~3穴，按均值2.4穴取0.6" } },
    { provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-E0401" }, national_ref: { catalog_id: "NAT-MSL-2026", code: "N340100008" }, share: 0.4,
      unit_conversion: { acknowledged: true, explanation: "电针1.6穴取0.4；仍须理疗事前备案" } },
  ],
  difference_note: "更正：经调取试运行实际取穴记录复核，普通针刺与电针工时比为6:4，原5:5拆账高估电针份额。原裁定事件保留可溯。",
  expert_review: [expert("赵启明", "中国针灸学会价格工作组", "复核327例取穴记录，修正拆账比例为6:4")],
  mapping_basis: ["更正论证纪要 MZ-2026-1120-02", "试运行取穴记录统计 TB-2026-11"],
});
const adjustment = pf.applyCorrections(claim.claim_id, {
  because_event_id: correction.event_id,
  reason: "BJ-E0401 映射拆账比例经专家复核更正，按新发布链口径重算未终结账单行",
});
line("⑨ 发布后更正：只对未终结账单行产生差额");
for (const a of adjustment.payload.adjustments) {
  console.log(`${a.line_id}：基金 ${a.before.fund_pay_yuan} → ${a.after.fund_pay_yuan}（差额 ${a.delta.fund_pay_yuan}）；自付 ${a.before.self_pay_yuan} → ${a.after.self_pay_yuan}（差额 ${a.delta.self_pay_yuan}）`);
}
const state = pf.claims.get(claim.claim_id);
const l1 = state.payload.lines.find((x) => x.line_id === "L1");
const l2 = state.payload.lines.find((x) => x.line_id === "L2");
console.log(`L1（已终结封存）仍为：基金 ${l1.result.amounts.fund_pay_yuan}，自付 ${l1.result.amounts.self_pay_yuan}——维持原口径，不产生差额`);
console.log(`L2（未终结）现为：基金 ${l2.result.amounts.fund_pay_yuan}，自付 ${l2.result.amounts.self_pay_yuan}`);
console.log(`L2 现行依据指向更正裁定：${l2.result.basis.decision.decision_event_id}（发布序号 #${l2.result.basis.decision.release_seq}）`);

// 9. 发布链与防篡改自检
const v = pf.store.verify();
line("⑩ 仓库自检：全局哈希链 + 正式发布链完整");
console.log(`事件总数 ${v.events}，正式发布 ${v.releases} 条，链头 ${v.head.slice(0, 16)}…`);
for (const r of pf.store.releases()) {
  console.log(`发布 #${String(r.release_seq).padStart(2, "0")} ${r.event_type.padEnd(22)} ${r.event_id}  ←上一发布 ${r.prev_release_hash.slice(0, 12)}…`);
}
