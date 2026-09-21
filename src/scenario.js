/**
 * 试运行场景：名称相近、内涵不同的地方项目集中出现。
 * 由事件存储重放构建，供演示脚本与测试共用。
 *
 * 角色：
 * - 就医地 330000（浙江）医院 H001（三级医院）
 * - 参保地 110000（北京）规则 R-CROSS
 * - 服务日 2026-09-15；2026-10-02 发布目录更正与规则修订
 */

import { Catalog } from "./catalog.js";
import { PaymentRules } from "./rules.js";
import { MappingRegistry } from "./mapping.js";
import { detectManyToOne, proposeForProvincial } from "./matching.js";

export const CARE_PROVINCE = "330000";
export const INSURED_PROVINCE = "110000";
export const HOSPITAL = { hospital_id: "H330001", facility_type: "三级医院" };
export const SERVICE_DATE = "2026-09-15";
export const CORRECTION_PUBLISHED = "2026-10-02";
export const SEALED_ON = "2026-09-25";

const review = (committee, conclusion, refs = []) => ({ committee, conclusion, evidence_refs: refs });

export const NATIONAL_ITEMS = [
  {
    item_code: "N-MRI-001",
    name: "磁共振平扫",
    clinical_intent: "不使用对比剂的磁共振成像检查，用于颅脑、脊柱等部位的平扫诊断",
    exclusions: ["增强扫描", "术中磁共振"],
    pricing_unit: "次",
    eligible_facilities: ["三级医院", "二级医院"],
    payment_conditions: [{ code: "PC-INPATIENT", description: "限住院期间检查", required_documents: ["住院病案首页"] }],
    expert_review: review("国家医保医药服务管理司专家组", "同意纳入国家目录，内涵与计价单位明确", ["国卫医发〔2026〕论证-017"]),
  },
  {
    item_code: "N-BX-003",
    name: "CT引导下穿刺活检术",
    clinical_intent: "在CT定位引导下经皮穿刺取得病变组织进行病理检查的操作费",
    exclusions: ["一次性穿刺针等耗材", "病理诊断费"],
    pricing_unit: "次",
    eligible_facilities: ["三级医院"],
    payment_conditions: [{ code: "PC-CONSENT", description: "需有创操作知情同意", required_documents: ["手术知情同意书"] }],
    expert_review: review("国家医保医药服务管理司专家组", "操作费与耗材分列，耗材不得并入", ["国卫医发〔2026〕论证-041"]),
  },
  {
    item_code: "N-HX-006",
    name: "肺通气功能检查",
    clinical_intent: "床旁监测患者肺通气容量与流速指标的呼吸功能检查",
    exclusions: [],
    pricing_unit: "次",
    eligible_facilities: ["三级医院", "二级医院"],
    payment_conditions: [{ code: "PC-MONITOR", description: "需监护记录佐证", required_documents: ["监护记录单"] }],
    expert_review: review("国家呼吸类项目论证组", "通气功能单项计费", ["国卫医发〔2026〕论证-102"]),
  },
  {
    item_code: "N-HX-007",
    name: "呼吸肌疲劳监测",
    clinical_intent: "床旁持续监测呼吸肌肌力与疲劳程度的呼吸功能监测项目",
    exclusions: [],
    pricing_unit: "次",
    eligible_facilities: ["三级医院", "二级医院"],
    payment_conditions: [{ code: "PC-MONITOR", description: "需监护记录佐证", required_documents: ["监护记录单"] }],
    expert_review: review("国家呼吸类项目论证组", "呼吸肌监测单项计费", ["国卫医发〔2026〕论证-103"]),
  },
  {
    item_code: "N-NEU-008",
    name: "术中神经电生理监测",
    clinical_intent: "手术中综合运用脑电图、肌电图等手段对神经功能进行的连续监测，按台次整体计费",
    exclusions: ["术后神经功能评估"],
    pricing_unit: "台次",
    eligible_facilities: ["三级医院"],
    payment_conditions: [{ code: "PC-IOM", description: "需术中监测报告", required_documents: ["术中监测报告"] }],
    expert_review: review("国家神经外科项目论证组", "脑电图与肌电图为同一监测服务的组成部分，不得分列", ["国卫医发〔2026〕论证-211"]),
  },
  {
    item_code: "N-O2-004",
    name: "氧气吸入",
    clinical_intent: "按实际吸氧小时计收的氧气吸入治疗",
    exclusions: ["监护病房打包收费中的吸氧"],
    pricing_unit: "小时",
    eligible_facilities: ["三级医院", "二级医院", "一级医院"],
    payment_conditions: [],
    expert_review: review("国家护理类项目论证组", "必须按实际吸氧小时计费", ["国卫医发〔2026〕论证-305"]),
  },
];

export const PROVINCIAL_ITEMS = [
  // 全等：名称、内涵、排除项、单位、机构完全一致
  {
    item_code: "P33-MRI-01",
    name: "磁共振平扫",
    clinical_intent: "不使用对比剂的磁共振成像检查，用于颅脑、脊柱等部位的平扫诊断",
    exclusions: ["增强扫描", "术中磁共振"],
    pricing_unit: "次",
    eligible_facilities: ["三级医院", "二级医院"],
    payment_conditions: [{ code: "PC-INPATIENT", description: "限住院期间检查", required_documents: ["住院病案首页"] }],
    expert_review: review("浙江省医疗服务价格项目论证委员会", "与国家项目内涵一致", ["浙医保论证〔2026〕-011"]),
  },
  // 陷阱：省项目把一次性穿刺针耗材包进操作费，国家项目明确排除耗材 → 部分重叠
  {
    item_code: "P33-BX-01",
    name: "CT引导下穿刺活检术",
    clinical_intent: "在CT定位引导下经皮穿刺取得病变组织进行病理检查，操作费中含一次性穿刺针耗材",
    exclusions: ["病理诊断费"],
    pricing_unit: "次",
    eligible_facilities: ["三级医院"],
    payment_conditions: [{ code: "PC-CONSENT", description: "需有创操作知情同意", required_documents: ["手术知情同意书"] }],
    expert_review: review("浙江省医疗服务价格项目论证委员会", "地方口径历史上含耗材，需拆分", ["浙医保论证〔2026〕-024"]),
  },
  // 陷阱：省“综合监测”按日打包，国家目录是两个单项 → 一对多
  {
    item_code: "P33-HX-01",
    name: "床旁呼吸功能综合监测",
    clinical_intent: "床旁持续监测患者肺通气容量与流速等肺通气功能检查，并监测呼吸肌肌力与疲劳程度，按日打包",
    exclusions: [],
    pricing_unit: "日",
    eligible_facilities: ["三级医院", "二级医院"],
    payment_conditions: [{ code: "PC-MONITOR", description: "需监护记录佐证", required_documents: ["监护记录单"] }],
    expert_review: review("浙江省医疗服务价格项目论证委员会", "地方打包项目，对应国家两个单项", ["浙医保论证〔2026〕-066"]),
  },
  // 陷阱：省目录把国家一个台次项目拆成脑电图、肌电图两行 → 多对一
  {
    item_code: "P33-NEU-01",
    name: "术中神经电生理监测（脑电图）",
    clinical_intent: "手术中运用脑电图手段对神经功能进行连续监测",
    exclusions: ["术后神经功能评估"],
    pricing_unit: "台次",
    eligible_facilities: ["三级医院"],
    payment_conditions: [{ code: "PC-IOM", description: "需术中监测报告", required_documents: ["术中监测报告"] }],
    expert_review: review("浙江省医疗服务价格项目论证委员会", "地方拆分项，组合后对应国家整体项目", ["浙医保论证〔2026〕-081"]),
  },
  {
    item_code: "P33-NEU-02",
    name: "术中神经电生理监测（肌电图）",
    clinical_intent: "手术中运用肌电图手段对神经功能进行连续监测",
    exclusions: ["术后神经功能评估"],
    pricing_unit: "台次",
    eligible_facilities: ["三级医院"],
    payment_conditions: [{ code: "PC-IOM", description: "需术中监测报告", required_documents: ["术中监测报告"] }],
    expert_review: review("浙江省医疗服务价格项目论证委员会", "地方拆分项，组合后对应国家整体项目", ["浙医保论证〔2026〕-081"]),
  },
  // 陷阱：名称像“氧气吸入”，但省项目按日打包，计价单位不同 → 机器只能给部分候选，人工拒绝后保持未映射
  {
    item_code: "P33-O2-01",
    name: "氧气吸入（日包）",
    clinical_intent: "按住院日打包计收的氧气吸入治疗，不区分实际吸氧小时",
    exclusions: [],
    pricing_unit: "日",
    eligible_facilities: ["三级医院", "二级医院", "一级医院"],
    payment_conditions: [],
    expert_review: review("浙江省医疗服务价格项目论证委员会", "计价单位与国家项目不一致，暂不对应", ["浙医保论证〔2026〕-092"]),
  },
  // 已停用：旧编码被 P33-BX-01 替代
  {
    item_code: "P33-OLD-09",
    name: "CT定位穿刺活检（旧）",
    clinical_intent: "旧版CT定位穿刺操作，已被新编码替代",
    exclusions: ["病理诊断费"],
    pricing_unit: "次",
    eligible_facilities: ["三级医院"],
    payment_conditions: [{ code: "PC-CONSENT", description: "需知情同意", required_documents: ["手术知情同意书"] }],
    expert_review: review("浙江省医疗服务价格项目论证委员会", "旧编码停用", ["浙医保论证〔2024〕-201"]),
  },
];

export const RULE_REVISION_1 = {
  province_code: INSURED_PROVINCE,
  rule_code: "R-CROSS",
  revision: 1,
  effective_from: "2026-08-01",
  entries: {
    "N-MRI-001": { covered: true, copay_ratio: 0.2 },
    "N-BX-003": { covered: true, copay_ratio: 0.3 },
    "N-HX-006": { covered: true, copay_ratio: 0.1 },
    "N-HX-007": { covered: true, copay_ratio: 0.1 },
    "N-NEU-008": { covered: true, copay_ratio: 0.15 },
    "N-O2-004": { covered: false, note: "参保地规定按小时项目需单独备案，试运行期内不予支付" },
  },
};

// 10 月 2 日发布的规则修订：N-MRI-001 个人先行自付比例由 20% 调整为 10%，追溯至 9 月 1 日
export const RULE_REVISION_2 = {
  ...RULE_REVISION_1,
  revision: 2,
  effective_from: "2026-09-01",
  entries: { ...RULE_REVISION_1.entries, "N-MRI-001": { covered: true, copay_ratio: 0.1 } },
};

// 国家目录更正：N-MRI-001@2 更正 @1 的内涵表述（错别字与排除项措辞），追溯至 9 月 1 日
export const N_MRI_CORRECTION = {
  ...NATIONAL_ITEMS[0],
  revision: 2,
  correction_of_revision: 1,
  published_on: CORRECTION_PUBLISHED,
  effective_from: "2026-09-01",
  clinical_intent: "不使用对比剂的磁共振成像检查，用于颅脑、脊柱、关节等部位的平扫诊断",
  note: "更正内涵表述遗漏：适用部位补入“关节”；排除项与计价单位不变",
};

async function draftAndActivate(store, scope, item, provinceCode, actor, effectiveFrom = "2026-08-01") {
  const aggregateId = scope === "national" ? `item:national:${item.item_code}` : `item:provincial:${provinceCode}:${item.item_code}`;
  await store.append({
    event_type: "CATALOG_DRAFTED",
    aggregate_type: scope === "national" ? "national_item" : "provincial_item",
    aggregate_id: aggregateId,
    summary: `登记${scope === "national" ? "国家" : "省级"}项目 ${item.item_code} v1`,
    actor,
    payload: { scope, province_code: scope === "provincial" ? provinceCode : undefined, ...item, revision: 1, effective_from: null },
  });
  await store.append({
    event_type: "VERSION_ACTIVATED",
    aggregate_type: scope === "national" ? "national_item" : "provincial_item",
    aggregate_id: aggregateId,
    summary: `${item.item_code} v1 自 ${effectiveFrom} 生效`,
    actor,
    payload: { scope, province_code: scope === "provincial" ? provinceCode : undefined, item_code: item.item_code, revision: 1, effective_from: effectiveFrom },
  });
  return aggregateId;
}

/**
 * 构建试运行前的完整事件序列：目录发布 → 机器候选 → 人工裁定 → 停用替代 → 参保地规则。
 * 返回读写模型与关键决定编号。
 */
export async function buildScenario(store, { activateCorrections = false } = {}) {
  const actor = { id: "U-ADMIN-01", name: "目录管理经办", role: "catalog_admin" };
  const expert = { id: "U-EXPERT-07", name: "论证专家王医生", role: "mapping_expert" };

  // 注册为存储的实时投影：写入即做跨聚合业务校验，违规事件在落链前被拒绝。
  const catalog = new Catalog();
  const rules = new PaymentRules();
  const mappings = new MappingRegistry();
  store.addProjector(catalog);
  store.addProjector(rules);
  store.addProjector(mappings);

  for (const item of NATIONAL_ITEMS) await draftAndActivate(store, "national", item, null, actor);
  for (const item of PROVINCIAL_ITEMS) await draftAndActivate(store, "provincial", item, CARE_PROVINCE, actor);

  // 旧编码 2026-08-10 停用，指向新编码 P33-BX-01@1
  await store.append({
    event_type: "ITEM_DISCONTINUED",
    aggregate_type: "provincial_item",
    aggregate_id: `item:provincial:${CARE_PROVINCE}:P33-OLD-09`,
    summary: "旧穿刺活检编码停用，由 P33-BX-01 替代",
    actor,
    payload: {
      scope: "provincial",
      province_code: CARE_PROVINCE,
      item_code: "P33-OLD-09",
      revision: 1,
      effective_to: "2026-08-10",
      reason: "价格项目编码切换，旧名与新项目重复设立",
      replaced_by: { province_code: CARE_PROVINCE, item_code: "P33-BX-01", revision: 1 },
    },
  });

  await store.append({
    event_type: "RULE_PUBLISHED",
    aggregate_type: "payment_rule",
    aggregate_id: `rule:${INSURED_PROVINCE}:R-CROSS`,
    summary: `参保地 ${INSURED_PROVINCE} 跨省规则 R-CROSS v1 发布`,
    actor,
    payload: RULE_REVISION_1,
  });

  const catalogNow = catalog;
  const machineOutputs = proposeMappings(catalogNow);
  const decisionIds = await adjudicate(store, machineOutputs, expert, catalogNow);

  if (activateCorrections) await publishCorrections(store, actor);

  return {
    catalog,
    rules,
    mappings,
    decisionIds,
    machineOutputs,
  };
}

/** 对每个省项目运行机器候选，并额外跑一次跨项目多对一探测。 */
export function proposeMappings(catalog) {
  const outputs = [];
  for (const item of catalog.allItems("provincial", CARE_PROVINCE)) {
    const revision = item.revisions.find((candidate) => candidate.status !== "draft") ?? item.revisions[0];
    const candidates = proposeForProvincial(revision, catalog, { onDate: "2026-08-15" });
    outputs.push({ item: revision, provincial_ref: { province_code: CARE_PROVINCE, item_code: revision.item_code, revision: revision.revision }, candidates });
  }
  for (const candidate of detectManyToOne(outputs)) {
    outputs.push({ group: true, provincial_ref: candidate.peer_provincial_refs[0], candidates: [candidate, { match_kind: "NONE", rationale: "如人工不认可组合关系，两个省项目保持未映射" }] });
  }
  return outputs;
}

async function adjudicate(store, machineOutputs, expert) {
  const ids = {};
  const findProposal = (code) => machineOutputs.find((output) => !output.group && output.provincial_ref.item_code === code);

  async function propose(aggregateId, proposalId, provincialRef, candidates, summary) {
    await store.append({
      event_type: "MAPPING_PROPOSED",
      aggregate_type: "mapping_decision",
      aggregate_id: aggregateId,
      summary,
      actor: { id: "machine-matcher", name: "机器候选服务", role: "system" },
      payload: { proposal_id: proposalId, provincial_ref: provincialRef, candidates },
    });
  }

  const exactOutput = findProposal("P33-MRI-01");
  await propose("mapping:D-MRI", "PR-MRI", exactOutput.provincial_ref, exactOutput.candidates, "机器候选：P33-MRI-01 与国家项目比对");
  await store.append({
    event_type: "MAPPING_APPROVED",
    aggregate_type: "mapping_decision",
    aggregate_id: "mapping:D-MRI",
    summary: "人工确认 P33-MRI-01 与 N-MRI-001 全等",
    actor: expert,
    payload: {
      decision_id: "D-MRI",
      proposal_id: "PR-MRI",
      decision_type: "EXACT",
      provincial_ref: exactOutput.provincial_ref,
      national_ref: { item_code: "N-MRI-001", revision: 1 },
      effective_from: "2026-08-15",
      mapping_basis: { decided_by: expert.name, decided_at: "2026-08-12", documents: ["浙医保论证〔2026〕-011", "国卫医发〔2026〕论证-017", "比对工作底稿-MRI-01"] },
    },
  });
  ids.mri = "D-MRI";

  const partialOutput = findProposal("P33-BX-01");
  await propose("mapping:D-BX", "PR-BX", partialOutput.provincial_ref, partialOutput.candidates, "机器候选：穿刺活检名称高度相似但排除项不同");
  await store.append({
    event_type: "MAPPING_APPROVED",
    aggregate_type: "mapping_decision",
    aggregate_id: "mapping:D-BX",
    summary: "人工确认 P33-BX-01 与 N-BX-003 部分重叠",
    actor: expert,
    payload: {
      decision_id: "D-BX",
      proposal_id: "PR-BX",
      decision_type: "PARTIAL_OVERLAP",
      provincial_ref: partialOutput.provincial_ref,
      national_ref: { item_code: "N-BX-003", revision: 1 },
      effective_from: "2026-08-15",
      difference_note: "省项目将一次性穿刺针耗材并入操作费，国家项目 N-BX-003 明确排除耗材；仅操作费部分重叠，耗材部分不得由基金支付，需按比例拆分申报。",
      mapping_basis: { decided_by: expert.name, decided_at: "2026-08-13", documents: ["浙医保论证〔2026〕-024", "国卫医发〔2026〕论证-041", "耗材剔除测算表-BX-01"] },
    },
  });
  ids.bx = "D-BX";

  const oneToManyOutput = findProposal("P33-HX-01");
  await propose("mapping:D-HX", "PR-HX", oneToManyOutput.provincial_ref, oneToManyOutput.candidates, "机器候选：呼吸综合监测可能对应两个国家单项");
  await store.append({
    event_type: "MAPPING_APPROVED",
    aggregate_type: "mapping_decision",
    aggregate_id: "mapping:D-HX",
    summary: "人工确认 P33-HX-01 一对多拆分为 N-HX-006 与 N-HX-007",
    actor: expert,
    payload: {
      decision_id: "D-HX",
      proposal_id: "PR-HX",
      decision_type: "ONE_TO_MANY",
      provincial_ref: oneToManyOutput.provincial_ref,
      national_refs: [
        { item_code: "N-HX-006", revision: 1 },
        { item_code: "N-HX-007", revision: 1 },
      ],
      effective_from: "2026-08-15",
      difference_note: "省项目按日打包，国家目录按两个单项分别计费；结算时必须分别申报两个单项的数量与单价，不得按日一口价。",
      mapping_basis: { decided_by: expert.name, decided_at: "2026-08-13", documents: ["浙医保论证〔2026〕-066", "国卫医发〔2026〕论证-102", "国卫医发〔2026〕论证-103"] },
    },
  });
  ids.hx = "D-HX";

  const groupOutput = machineOutputs.find((output) => output.group);
  if (!groupOutput) throw new Error("机器未探测到多对一候选，请检查场景数据");
  await propose("mapping:D-NEU", "PR-NEU", groupOutput.provincial_ref, groupOutput.candidates, "机器候选：两个省项目可能同属一个国家台次项目");
  await store.append({
    event_type: "MAPPING_APPROVED",
    aggregate_type: "mapping_decision",
    aggregate_id: "mapping:D-NEU",
    summary: "人工确认 P33-NEU-01/02 多对一合并为 N-NEU-008",
    actor: expert,
    payload: {
      decision_id: "D-NEU",
      proposal_id: "PR-NEU",
      decision_type: "MANY_TO_ONE",
      provincial_refs: [
        { province_code: CARE_PROVINCE, item_code: "P33-NEU-01", revision: 1 },
        { province_code: CARE_PROVINCE, item_code: "P33-NEU-02", revision: 1 },
      ],
      national_ref: { item_code: "N-NEU-008", revision: 1 },
      effective_from: "2026-08-15",
      difference_note: "省目录把同一台次术中神经电生理监测拆成脑电图、肌电图两行；国家项目按台次整体支付一次，必须组合申报且只有一行可作为主计行。",
      mapping_basis: { decided_by: expert.name, decided_at: "2026-08-14", documents: ["浙医保论证〔2026〕-081", "国卫医发〔2026〕论证-211"] },
    },
  });
  ids.neu = "D-NEU";

  const oxygenOutput = findProposal("P33-O2-01");
  await propose("mapping:PR-O2", "PR-O2", oxygenOutput.provincial_ref, oxygenOutput.candidates, "机器候选：吸氧日包名称近似但计价单位不一致");
  await store.append({
    event_type: "MAPPING_REJECTED",
    aggregate_type: "mapping_decision",
    aggregate_id: "mapping:PR-O2",
    summary: "人工拒绝吸氧日包的近似候选，项目保持未映射",
    actor: expert,
    payload: {
      proposal_id: "PR-O2",
      reason: "省项目按住院日打包，国家项目按实际吸氧小时计费，计量基础不同无法换算，不得按名称相似落码",
    },
  });

  return ids;
}

/** 发布后更正：国家目录出更正版本，参保地规则出新修订，均追溯到 2026-09-01。 */
export async function publishCorrections(store, actor = { id: "U-ADMIN-01", name: "目录管理经办", role: "catalog_admin" }) {
  await store.append({
    event_type: "CATALOG_CORRECTED",
    aggregate_type: "national_item",
    aggregate_id: "item:national:N-MRI-001",
    summary: "N-MRI-001 发布后更正 v2：补正内涵表述，追溯至 2026-09-01",
    actor,
    payload: { scope: "national", ...N_MRI_CORRECTION },
  });
  await store.append({
    event_type: "RULE_PUBLISHED",
    aggregate_type: "payment_rule",
    aggregate_id: `rule:${INSURED_PROVINCE}:R-CROSS`,
    summary: "参保地规则 R-CROSS v2：N-MRI-001 自付比例调整，追溯至 2026-09-01",
    actor,
    payload: RULE_REVISION_2,
  });
}

/** 一笔合规的跨省账单（未终结），更正发布后将产生差额。 */
export const OPEN_CLAIM_DRAFT = {
  claim_id: "C-2026-0915-01",
  hospital_id: HOSPITAL.hospital_id,
  facility_type: HOSPITAL.facility_type,
  province_of_care: CARE_PROVINCE,
  insured_province: INSURED_PROVINCE,
  service_date: SERVICE_DATE,
  lines: [
    { provincial_item_code: "P33-MRI-01", quantity: 1, unit_price: 600, measure_unit: "次", documents: ["住院病案首页"] },
    { provincial_item_code: "P33-BX-01", quantity: 1, unit_price: 1000, measure_unit: "次", billable_portion: 0.8, documents: ["手术知情同意书"] },
    {
      provincial_item_code: "P33-HX-01",
      quantity: 1,
      measure_unit: "日",
      documents: ["监护记录单"],
      allocations: [
        { national_item_code: "N-HX-006", quantity: 1, unit_price: 200, measure_unit: "次" },
        { national_item_code: "N-HX-007", quantity: 1, unit_price: 150, measure_unit: "次" },
      ],
    },
    { provincial_item_code: "P33-NEU-01", quantity: 1, unit_price: 800, measure_unit: "台次", group_role: "primary", documents: ["术中监测报告"] },
    { provincial_item_code: "P33-NEU-02", quantity: 1, unit_price: 100, measure_unit: "台次", group_role: "component", documents: ["术中监测报告"] },
  ],
};

/** 一笔在更正发布前已封存的账单，历史口径必须冻结。 */
export const SEALED_CLAIM_DRAFT = {
  claim_id: "C-2026-0915-02",
  hospital_id: HOSPITAL.hospital_id,
  facility_type: HOSPITAL.facility_type,
  province_of_care: CARE_PROVINCE,
  insured_province: INSURED_PROVINCE,
  service_date: SERVICE_DATE,
  lines: [
    { provincial_item_code: "P33-MRI-01", quantity: 1, unit_price: 600, measure_unit: "次", documents: ["住院病案首页"] },
  ],
};

/** 医院预检用的“问题账单”：停用编码、未映射项目、缺材料、机构不符、单位不符。 */
export const PROBLEM_CLAIM_DRAFT = {
  claim_id: "C-PRECHECK-01",
  hospital_id: HOSPITAL.hospital_id,
  facility_type: HOSPITAL.facility_type,
  province_of_care: CARE_PROVINCE,
  insured_province: INSURED_PROVINCE,
  service_date: SERVICE_DATE,
  lines: [
    { provincial_item_code: "P33-OLD-09", quantity: 1, unit_price: 900, measure_unit: "次", documents: ["手术知情同意书"] },
    { provincial_item_code: "P33-O2-01", quantity: 2, unit_price: 80, measure_unit: "日" },
    { provincial_item_code: "P33-MRI-01", quantity: 1, unit_price: 600, measure_unit: "次", documents: [] },
    { provincial_item_code: "P33-BX-01", quantity: 1, unit_price: 1000, measure_unit: "例", billable_portion: 0.8, documents: ["手术知情同意书"] },
  ],
};
