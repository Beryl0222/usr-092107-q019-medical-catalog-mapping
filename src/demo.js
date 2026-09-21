#!/usr/bin/env node
/**
 * 端到端演示（不落盘，纯内存事件链）：
 * 1. 发布两级目录、停用替代与参保地规则
 * 2. 机器给出候选，人工分别裁定 全等 / 部分重叠 / 一对多 / 多对一 / 拒绝
 * 3. 医院预检问题账单并看到全部阻断
 * 4. 提交合规账单与另一笔随即封存的账单
 * 5. 发布后更正（国家目录内涵更正 + 参保地规则修订，追溯生效）
 * 6. 更正只对未终结账单产生差额；封存账单拒绝调整、原口径冻结
 * 7. 打印患者账单说明：每个费项都能回到当时有效的两级目录与映射决定
 */

import { Catalog } from "./catalog.js";
import { EventStore } from "./events.js";
import { MappingRegistry } from "./mapping.js";
import { PaymentRules } from "./rules.js";
import {
  buildScenario,
  OPEN_CLAIM_DRAFT,
  PROBLEM_CLAIM_DRAFT,
  publishCorrections,
  SEALED_CLAIM_DRAFT,
  SEALED_ON,
} from "./scenario.js";
import { ClaimService, explainClaim, precheck } from "./claims.js";

const yuan = (value) => `¥${value.toFixed(2)}`;
const line = (title) => console.log(`\n${"═".repeat(72)}\n${title}\n${"═".repeat(72)}`);

const store = await EventStore.open(null);
const world = await buildScenario(store);

line("一、发布链：事件编号首尾相扣");
console.log(`链上事件 ${store.length} 条，链尾 ${store.headId()}`);
console.log(store.events.slice(0, 3).map((event) => `  ${event.seq}. ${event.event_id} ← ${event.prev_event_id ?? "∅"}  ${event.event_type}`).join("\n"));

line("二、机器候选（只给候选，不自动落码）");
for (const output of world.machineOutputs.filter((item) => !item.group)) {
  const code = output.provincial_ref.item_code;
  const kinds = output.candidates.map((candidate) =>
    candidate.match_kind === "NONE" ? "NONE" : `${candidate.match_kind}${candidate.national_ref ? `→${candidate.national_ref.item_code}` : `→[${(candidate.national_refs ?? []).map((ref) => ref.item_code).join("+")}]`}`);
  console.log(`  ${code}: ${kinds.join(" / ")}`);
}

line("三、医院预检：问题账单被逐项拦下");
{
  const report = precheck(PROBLEM_CLAIM_DRAFT, world);
  console.log(`预检结论：${report.ok ? "通过" : "不通过"}，共 ${report.blocking.length} 项阻断`);
  for (const problem of report.blocking) {
    console.log(`  [第${problem.line_no}行 ${problem.code}] ${problem.message}`);
  }
  const service = new ClaimService(store, world);
  await service.recordPrecheck(PROBLEM_CLAIM_DRAFT, { id: "H330001", name: "医院收费端", role: "hospital" });
}

line("四、合规账单提交（未终结）与另一笔账单封存");
{
  const service = new ClaimService(store, world);
  await service.recordPrecheck(OPEN_CLAIM_DRAFT, { id: "H330001", name: "医院收费端", role: "hospital" });
  await service.submit(OPEN_CLAIM_DRAFT, { id: "H330001", name: "医院收费端", role: "hospital" });

  await service.recordPrecheck(SEALED_CLAIM_DRAFT, { id: "H330001", name: "医院收费端", role: "hospital" });
  await service.submit(SEALED_CLAIM_DRAFT, { id: "H330001", name: "医院收费端", role: "hospital" });
  await service.seal(SEALED_CLAIM_DRAFT.claim_id, SEALED_ON, { id: "U-AUDIT-02", name: "经办复核岗", role: "auditor" });

  const open = service.ledger.get(OPEN_CLAIM_DRAFT.claim_id);
  console.log("未终结账单 C-2026-0915-01 提交时金额：");
  for (const row of open.resolved_lines) {
    console.log(`  第${row.line_no}行：总费 ${yuan(row.amounts.total_charge)}，基金 ${yuan(row.amounts.fund_paid)}，自付 ${yuan(row.amounts.self_pay)}`);
  }
}

line("五、发布后更正（2026-10-02 发布，追溯至 2026-09-01）");
await publishCorrections(store);
{
  const correctedWorld = {
    catalog: Catalog.fromEvents(store.events),
    rules: PaymentRules.fromEvents(store.events),
    mappings: MappingRegistry.fromEvents(store.events),
  };
  const service = new ClaimService(store, correctedWorld);

  // 封存账单：必须拒绝调整
  try {
    await service.applyCorrections(SEALED_CLAIM_DRAFT.claim_id, "N-MRI-001 内涵更正与规则修订", { id: "U-AUDIT-03", name: "追偿经办岗", role: "adjuster" });
    console.log("  错误：封存账单竟然被调整了");
  } catch (error) {
    console.log(`  封存账单 ${SEALED_CLAIM_DRAFT.claim_id}：${error.message}`);
  }

  // 未终结账单：产生差额
  const adjusted = await service.applyCorrections(OPEN_CLAIM_DRAFT.claim_id, "N-MRI-001 内涵更正与 R-CROSS v2 规则修订", { id: "U-AUDIT-03", name: "追偿经办岗", role: "adjuster" });
  console.log(`  未终结账单 ${OPEN_CLAIM_DRAFT.claim_id} 调整事件：${adjusted.event_id}`);
  for (const correction of adjusted.payload.corrections) {
    console.log(`  第${correction.line_no}行 [${correction.outcome}] 基金差额 ${yuan(correction.delta.fund_paid)}，自付差额 ${yuan(correction.delta.self_pay)}：${correction.reason}`);
  }
}

line("六、患者账单说明：费用来源与自付理由（封存账单保持原口径）");
{
  const correctedWorld = {
    catalog: Catalog.fromEvents(store.events),
    rules: PaymentRules.fromEvents(store.events),
    mappings: MappingRegistry.fromEvents(store.events),
  };
  const service = new ClaimService(store, correctedWorld);
  for (const claimId of [OPEN_CLAIM_DRAFT.claim_id, SEALED_CLAIM_DRAFT.claim_id]) {
    console.log(`\n  账单 ${claimId}（${service.ledger.get(claimId).status}）`);
    for (const row of explainClaim(service.ledger.get(claimId), correctedWorld)) {
      const provinceText = `${row.sources.provincial.code} v${row.sources.provincial.revision}「${row.sources.provincial.name}」按${row.sources.provincial.pricing_unit}`;
      const nationalText = row.sources.national.map((item) => `${item.code} v${item.revision}`).join("、");
      console.log(`    第${row.line_no}行 省:${provinceText} → 国:${nationalText}（映射 ${row.sources.mapping_decision.decision_id}/${row.sources.mapping_decision.decision_type}，规则 ${row.sources.payment_rule.rule_code} v${row.sources.payment_rule.revision}）`);
      console.log(`      总费 ${yuan(row.amounts.total_charge)} / 基金 ${yuan(row.amounts.fund_paid)} / 自付 ${yuan(row.amounts.self_pay)}${row.adjusted ? "（已按发布后更正重算）" : ""}${row.frozen ? "（封存冻结）" : ""}`);
      for (const reason of row.self_pay_reasons) console.log(`      自付理由 [${reason.code}] ${reason.message}`);
    }
  }
}

line("七、封存历史回放：仍可取出封存当时的旧口径");
{
  const sealed = ClaimLedgerSealedView(store.events, SEALED_CLAIM_DRAFT.claim_id);
  console.log(`  封存账单金额仍按提交时口径：基金 ${yuan(sealed.fundPaid)}，自付 ${yuan(sealed.selfPay)}（规则钉在 R-CROSS v1，国家目录钉在 N-MRI-001 v1）`);
  console.log(`\n链上共 ${store.length} 条事件，链尾 ${store.headId()}；任一条历史记录改动都会在重载时被哈希链识破。`);
}

// 直接从原始事件中取出封存账单提交时的金额，证明历史口径原样保留。
function ClaimLedgerSealedView(events, claimId) {
  const submitted = events.find((event) => event.event_type === "CLAIM_SUBMITTED" && event.payload.claim_id === claimId);
  const row = submitted.payload.resolved_lines[0];
  return { fundPaid: row.amounts.fund_paid, selfPay: row.amounts.self_pay };
}
