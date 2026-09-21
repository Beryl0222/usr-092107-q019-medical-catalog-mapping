import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Catalog } from "../src/catalog.js";
import { EventStore } from "../src/events.js";
import { MappingRegistry } from "../src/mapping.js";
import { PaymentRules } from "../src/rules.js";
import {
  buildScenario,
  CARE_PROVINCE,
  CORRECTION_PUBLISHED,
  HOSPITAL,
  INSURED_PROVINCE,
  NATIONAL_ITEMS,
  N_MRI_CORRECTION,
  OPEN_CLAIM_DRAFT,
  PROBLEM_CLAIM_DRAFT,
  publishCorrections,
  RULE_REVISION_2,
  SEALED_CLAIM_DRAFT,
  SEALED_ON,
  SERVICE_DATE,
} from "../src/scenario.js";
import { ClaimService, explainClaim, precheck } from "../src/claims.js";

const HOSPITAL_ACTOR = { id: "H330001", name: "医院收费端", role: "hospital" };
const ADJUSTER = { id: "U-AUDIT-03", name: "追偿经办岗", role: "adjuster" };
const AUDITOR = { id: "U-AUDIT-02", name: "经办复核岗", role: "auditor" };

async function settledWorld() {
  const store = await EventStore.open(null);
  const world = await buildScenario(store);
  const service = new ClaimService(store, world);
  return { store, world, service };
}

function reproject(store) {
  return {
    catalog: Catalog.fromEvents(store.events),
    rules: PaymentRules.fromEvents(store.events),
    mappings: MappingRegistry.fromEvents(store.events),
  };
}

/* ── 发布链 ─────────────────────────────────────────────── */

test("事件编号按仓库顺序成链，聚合版本各自单调递增", async () => {
  const { store } = await settledWorld();
  const events = store.events;
  events.forEach((event, index) => {
    assert.equal(event.seq, index + 1);
    assert.equal(event.prev_event_id, index === 0 ? null : events[index - 1].event_id);
    assert.match(event.chain_hash, /^[0-9a-f]{64}$/);
  });
  const mriEvents = store.eventsOf("item:national:N-MRI-001");
  assert.deepEqual(mriEvents.map((event) => event.version), [1, 2]);
});

test("强行指定错误的聚合版本会被拒绝", async () => {
  const store = await EventStore.open(null);
  const actor = { id: "u", name: "u", role: "catalog_admin" };
  const item = NATIONAL_ITEMS[0];
  await store.append({
    event_type: "CATALOG_DRAFTED",
    aggregate_type: "national_item",
    aggregate_id: "item:national:T-001",
    summary: "v1",
    actor,
    payload: { scope: "national", ...item, item_code: "T-001", revision: 1, effective_from: null },
  });
  await assert.rejects(
    () => store.append({
      event_type: "CATALOG_DRAFTED",
      aggregate_type: "national_item",
      aggregate_id: "item:national:T-001",
      summary: "跳号",
      actor,
      version: 5,
      payload: {},
    }),
    /下一版本必须是 2/,
  );
});

test("事件只能随时间向后追加", async () => {
  const store = await EventStore.open(null);
  const actor = { id: "u", name: "u", role: "catalog_admin" };
  const item = { ...NATIONAL_ITEMS[0], item_code: "T-TIME-01" };
  const payload = { scope: "national", ...item, revision: 1, effective_from: null };
  await store.append({
    event_type: "CATALOG_DRAFTED",
    aggregate_type: "national_item",
    aggregate_id: "item:national:T-TIME-01",
    summary: "now",
    occurred_at: "2026-09-20T12:00:00+08:00",
    actor,
    payload,
  });
  await assert.rejects(
    () => store.append({
      event_type: "CATALOG_DRAFTED",
      aggregate_type: "national_item",
      aggregate_id: "item:national:T-TIME-02",
      summary: "past",
      occurred_at: "2026-09-19T12:00:00+08:00",
      actor,
      payload: { ...payload, item_code: "T-TIME-02" },
    }),
    /只能向后追加/,
  );
});

test("JSONL 重载逐环复核：改动任一历史字节都会被哈希链识破", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chain-"));
  const file = path.join(dir, "events.jsonl");
  try {
    {
      const store = await EventStore.open(file);
      await buildScenario(store);
    }
    // 正常重载
    const reopened = await EventStore.open(file);
    assert.ok(reopened.length > 30);

    // 篡改第 2 行的负载
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    const tampered = JSON.parse(lines[1]);
    tampered.payload.name = "被篡改的项目名";
    lines[1] = JSON.stringify(tampered);
    await writeFile(file, `${lines.join("\n")}\n`, "utf8");
    await assert.rejects(() => EventStore.open(file), /哈希不吻合/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── 目录版本、生效区间、停用替代 ───────────────────────── */

test("新版本生效自动收口旧版本区间，重叠区间被拒绝", async () => {
  const store = await EventStore.open(null);
  const catalogProjector = new Catalog();
  store.addProjector(catalogProjector);
  const actor = { id: "u", name: "u", role: "catalog_admin" };
  const base = { ...NATIONAL_ITEMS[0], item_code: "T-REV-01" };
  const id = "item:national:T-REV-01";
  await store.append({ event_type: "CATALOG_DRAFTED", aggregate_type: "national_item", aggregate_id: id, summary: "v1", actor, payload: { scope: "national", ...base, revision: 1, effective_from: null } });
  await store.append({ event_type: "VERSION_ACTIVATED", aggregate_type: "national_item", aggregate_id: id, summary: "v1 on", actor, payload: { scope: "national", item_code: "T-REV-01", revision: 1, effective_from: "2026-08-01" } });
  await store.append({ event_type: "CATALOG_REVISED", aggregate_type: "national_item", aggregate_id: id, summary: "v2", actor, payload: { scope: "national", ...base, revision: 2, supersedes_revision: 1, effective_from: null } });

  await assert.rejects(
    () => store.append({ event_type: "VERSION_ACTIVATED", aggregate_type: "national_item", aggregate_id: id, summary: "重叠激活", actor, payload: { scope: "national", item_code: "T-REV-01", revision: 2, effective_from: "2026-07-15" } }),
    /生效区间重叠/,
  );

  await store.append({ event_type: "VERSION_ACTIVATED", aggregate_type: "national_item", aggregate_id: id, summary: "v2 on", actor, payload: { scope: "national", item_code: "T-REV-01", revision: 2, effective_from: "2026-09-01" } });
  const catalog = Catalog.fromEvents(store.events);
  assert.equal(catalog.activeOn("national", "T-REV-01", "2026-08-31").revision, 1);
  assert.equal(catalog.activeOn("national", "T-REV-01", "2026-09-01").revision, 2);
  assert.equal(catalog.getRevision("national", "T-REV-01", 1).effective_to, "2026-09-01");
});

test("停用事件保留停用日有效，并记录替代关系；停用后按旧码计费被阻断", async () => {
  const { world } = await settledWorld();
  const lastDay = world.catalog.activeOn("provincial", "P33-OLD-09", "2026-08-10", CARE_PROVINCE);
  assert.ok(lastDay, "停用日当天仍有效（半开区间）");
  assert.equal(world.catalog.activeOn("provincial", "P33-OLD-09", "2026-08-11", CARE_PROVINCE), null);
  assert.equal(lastDay.discontinuance.replaced_by.item_code, "P33-BX-01");

  const report = precheck(PROBLEM_CLAIM_DRAFT, world);
  assert.ok(report.blocking.some((problem) => problem.code === "PROVINCIAL_ITEM_NOT_EFFECTIVE" && problem.message.includes("替代")));
});

test("更正产生新版本并追溯生效，被更正版本原样保留", async () => {
  const store = await EventStore.open(null);
  await buildScenario(store);
  await publishCorrections(store);
  const catalog = Catalog.fromEvents(store.events);
  assert.equal(catalog.activeOn("national", "N-MRI-001", SERVICE_DATE).revision, 2);
  assert.equal(catalog.activeOn("national", "N-MRI-001", "2026-08-20").revision, 1);
  const old = catalog.getRevision("national", "N-MRI-001", 1);
  assert.equal(old.status, "corrected");
  assert.equal(old.corrected_by, 2);
  // 原内容未被原地改写
  assert.equal(old.clinical_intent, NATIONAL_ITEMS[0].clinical_intent);
  assert.equal(catalog.getRevision("national", "N-MRI-001", 2).correction_of_revision, 1);
  assert.equal(N_MRI_CORRECTION.published_on, CORRECTION_PUBLISHED);
});

/* ── 机器候选与人工裁定 ─────────────────────────────────── */

test("机器候选包含差异信号且始终保留 NONE", async () => {
  const { world } = await settledWorld();
  const oxygen = world.catalog.getItem("provincial", "P33-O2-01", CARE_PROVINCE).revisions[0];
  const { proposeForProvincial } = await import("../src/matching.js");
  const candidates = proposeForProvincial(oxygen, world.catalog, { onDate: SERVICE_DATE });
  assert.ok(candidates.some((candidate) => candidate.match_kind === "NONE"));
  assert.ok(!candidates.some((candidate) => candidate.match_kind === "EXACT"), "按日/按小时的项目不得被机器判为全等");
  const partial = candidates.find((candidate) => candidate.national_ref?.item_code === "N-O2-004");
  assert.ok(partial);
  assert.equal(partial.signals.pricing_unit_match, false);
});

test("非全等人工裁定必须写差异说明与依据，且只能在机器候选范围内选择", async () => {
  const store = await EventStore.open(null);
  await buildScenario(store);
  const expert = { id: "x", name: "专家", role: "mapping_expert" };
  const provincialRef = { province_code: CARE_PROVINCE, item_code: "P33-BX-01", revision: 1 };

  // 再造一份候选事件（新的提案号），随后尝试越权选择候选外项目
  await store.append({
    event_type: "MAPPING_PROPOSED",
    aggregate_type: "mapping_decision",
    aggregate_id: "mapping:D-BX-2",
    summary: "候选",
    actor: { id: "m", name: "机器", role: "system" },
    payload: {
      proposal_id: "PR-BX-2",
      provincial_ref: provincialRef,
      candidates: [{ match_kind: "PARTIAL_OVERLAP", national_ref: { item_code: "N-BX-003", revision: 1 }, rationale: "近似", confidence: 0.8 }],
    },
  });
  await assert.rejects(
    () => store.append({
      event_type: "MAPPING_APPROVED",
      aggregate_type: "mapping_decision",
      aggregate_id: "mapping:D-BX-2",
      summary: "越权选择",
      actor: expert,
      payload: {
        decision_id: "D-BX-2", proposal_id: "PR-BX-2", decision_type: "PARTIAL_OVERLAP",
        provincial_ref: provincialRef, national_ref: { item_code: "N-HX-006", revision: 1 },
        effective_from: "2026-08-15",
        difference_note: "这条说明足够长但选择了候选之外的项目",
        mapping_basis: { decided_by: "专家", documents: ["d1"] },
      },
    }),
    /候选之外/,
  );

  await assert.rejects(
    () => store.append({
      event_type: "MAPPING_APPROVED",
      aggregate_type: "mapping_decision",
      aggregate_id: "mapping:D-BX-3",
      summary: "缺差异说明",
      actor: expert,
      payload: {
        decision_id: "D-BX-3", proposal_id: "PR-BX-2", decision_type: "PARTIAL_OVERLAP",
        provincial_ref: provincialRef, national_ref: { item_code: "N-BX-003", revision: 1 },
        effective_from: "2026-08-15",
        difference_note: "太短",
        mapping_basis: { decided_by: "专家", documents: ["d1"] },
      },
    }),
    /差异说明/,
  );
});

test("被拒绝的候选保持未映射，结算直接阻断且不落到近似编码", async () => {
  const { world } = await settledWorld();
  const draft = {
    ...OPEN_CLAIM_DRAFT,
    claim_id: "C-UNMAPPED",
    lines: [{ provincial_item_code: "P33-O2-01", quantity: 2, unit_price: 80, measure_unit: "日" }],
  };
  const report = precheck(draft, world);
  assert.equal(report.ok, false);
  const blocking = report.blocking.filter((problem) => problem.line_no === 1);
  assert.deepEqual(blocking.map((problem) => problem.code), ["UNMAPPED"]);
});

/* ── 参保地规则 ─────────────────────────────────────────── */

test("结算用参保地规则而非就医地规则，并按服务发生日选版本", async () => {
  const { world } = await settledWorld();
  // 服务日规则 v1：MRI 自付 20%
  const { rule, entry } = world.rules.entryOn(INSURED_PROVINCE, "N-MRI-001", SERVICE_DATE);
  assert.equal(rule.revision, 1);
  assert.equal(entry.copay_ratio, 0.2);
  assert.notEqual(INSURED_PROVINCE, CARE_PROVINCE, "场景本身是跨省：参保地与就医地不同");
});

/* ── 预检与提交 ─────────────────────────────────────────── */

test("预检逐项报告：未映射、缺材料、单位不符、停用替代", async () => {
  const { world } = await settledWorld();
  const report = precheck(PROBLEM_CLAIM_DRAFT, world);
  assert.equal(report.ok, false);
  const codes = report.blocking.map((problem) => `${problem.line_no}:${problem.code}`);
  assert.ok(codes.includes("1:PROVINCIAL_ITEM_NOT_EFFECTIVE"));
  assert.ok(codes.includes("2:UNMAPPED"));
  assert.ok(codes.includes("3:MISSING_DOCUMENTS"));
  assert.ok(codes.includes("4:PRICING_UNIT_MISMATCH"));
});

test("适用机构不符会被拦下", async () => {
  const { world } = await settledWorld();
  const draft = {
    ...OPEN_CLAIM_DRAFT,
    claim_id: "C-FACILITY",
    facility_type: "一级医院",
    lines: [{ provincial_item_code: "P33-NEU-01", quantity: 1, unit_price: 800, measure_unit: "台次", group_role: "primary", documents: ["术中监测报告"] }],
  };
  const report = precheck(draft, world);
  assert.ok(report.blocking.some((problem) => problem.code === "FACILITY_NOT_ELIGIBLE"));
});

test("提交前必须预检，预检后改动内容需要重新预检", async () => {
  const { store, service } = await settledWorld();
  await assert.rejects(() => service.submit(OPEN_CLAIM_DRAFT, HOSPITAL_ACTOR), /必须先记录一次预检/);
  await service.recordPrecheck(OPEN_CLAIM_DRAFT, HOSPITAL_ACTOR);
  const tampered = structuredClone(OPEN_CLAIM_DRAFT);
  tampered.lines[0].unit_price = 999;
  await assert.rejects(() => service.submit(tampered, HOSPITAL_ACTOR), /不一致/);
  await service.submit(OPEN_CLAIM_DRAFT, HOSPITAL_ACTOR);
  assert.equal(service.ledger.get(OPEN_CLAIM_DRAFT.claim_id).status, "open");
});

test("一对多必须逐单项拆分申报，多对一必须恰好一个主计行", async () => {
  const { world } = await settledWorld();
  // 一对多缺 allocations
  const noSplit = {
    ...OPEN_CLAIM_DRAFT,
    claim_id: "C-SPLIT",
    lines: [{ provincial_item_code: "P33-HX-01", quantity: 1, measure_unit: "日", documents: ["监护记录单"] }],
  };
  let report = precheck(noSplit, world);
  assert.ok(report.blocking.some((problem) => problem.code === "ALLOCATION_REQUIRED"));

  // 多对一组合里两个主计行
  const twoPrimaries = {
    ...OPEN_CLAIM_DRAFT,
    claim_id: "C-GROUP",
    lines: [
      { provincial_item_code: "P33-NEU-01", quantity: 1, unit_price: 800, measure_unit: "台次", group_role: "primary", documents: ["术中监测报告"] },
      { provincial_item_code: "P33-NEU-02", quantity: 1, unit_price: 100, measure_unit: "台次", group_role: "primary", documents: ["术中监测报告"] },
    ],
  };
  report = precheck(twoPrimaries, world);
  assert.ok(report.blocking.some((problem) => problem.code === "GROUP_PRIMARY_NOT_UNIQUE"));

  // 合规组合：component 行基金不支付
  report = precheck(OPEN_CLAIM_DRAFT, world);
  assert.equal(report.ok, true);
  const component = report.lines.find((line) => line.line_no === 5).resolved;
  assert.equal(component.amounts.fund_paid, 0);
  assert.equal(component.amounts.self_pay, 100);
});

/* ── 更正差额与封存 ─────────────────────────────────────── */

test("发布后更正：未终结账单按服务日产生差额，自付理由同步换口径", async () => {
  const { store, service } = await settledWorld();
  await service.recordPrecheck(OPEN_CLAIM_DRAFT, HOSPITAL_ACTOR);
  await service.submit(OPEN_CLAIM_DRAFT, HOSPITAL_ACTOR);
  const before = service.ledger.get(OPEN_CLAIM_DRAFT.claim_id).resolved_lines[0];
  assert.deepEqual(before.amounts, { total_charge: 600, fund_paid: 480, self_pay: 120 });

  await publishCorrections(store);
  const service2 = new ClaimService(store, reproject(store));
  const adjusted = await service2.applyCorrections(OPEN_CLAIM_DRAFT.claim_id, "目录与规则更正", ADJUSTER);
  assert.equal(adjusted.event_type, "CLAIM_ADJUSTED");
  const line1 = adjusted.payload.corrections.find((correction) => correction.line_no === 1);
  assert.equal(line1.delta.fund_paid, 60);
  assert.equal(line1.delta.self_pay, -60);
  assert.equal(line1.before_ref.national_refs[0].revision, 1);
  assert.equal(line1.after_ref.national_refs[0].revision, 2);
  assert.equal(line1.after_ref.rule_ref.revision, 2);
  assert.deepEqual(line1.after_amounts, { total_charge: 600, fund_paid: 540, self_pay: 60 });

  const after = service2.ledger.get(OPEN_CLAIM_DRAFT.claim_id).resolved_lines[0];
  assert.deepEqual(after.amounts, { total_charge: 600, fund_paid: 540, self_pay: 60 });
  assert.ok(after.self_pay_reasons.some((reason) => reason.message.includes("R-CROSS@2") && reason.message.includes("10%")));
  // 重放链历史不应让差额被二次累加
  const replayed = new ClaimService(store, reproject(store));
  assert.deepEqual(replayed.ledger.get(OPEN_CLAIM_DRAFT.claim_id).resolved_lines[0].amounts, { total_charge: 600, fund_paid: 540, self_pay: 60 });
});

test("封存账单拒绝任何更正调整，提交时钉住的口径原样可查", async () => {
  const { store, service } = await settledWorld();
  await service.recordPrecheck(SEALED_CLAIM_DRAFT, HOSPITAL_ACTOR);
  await service.submit(SEALED_CLAIM_DRAFT, HOSPITAL_ACTOR);
  await service.seal(SEALED_CLAIM_DRAFT.claim_id, SEALED_ON, AUDITOR);

  await publishCorrections(store);
  const service2 = new ClaimService(store, reproject(store));
  await assert.rejects(
    () => service2.applyCorrections(SEALED_CLAIM_DRAFT.claim_id, "目录与规则更正", ADJUSTER),
    /封存/,
  );
  const sealed = service2.ledger.get(SEALED_CLAIM_DRAFT.claim_id);
  assert.deepEqual(sealed.resolved_lines[0].amounts, { total_charge: 600, fund_paid: 480, self_pay: 120 });
  assert.equal(sealed.resolved_lines[0].national_refs[0].revision, 1);
  assert.equal(sealed.resolved_lines[0].rule_ref.revision, 1);
});

test("映射停用后重算：未终结账单的已付基金被全额追回", async () => {
  const { store, service } = await settledWorld();
  await service.recordPrecheck(OPEN_CLAIM_DRAFT, HOSPITAL_ACTOR);
  await service.submit(OPEN_CLAIM_DRAFT, HOSPITAL_ACTOR);

  await store.append({
    event_type: "MAPPING_DEACTIVATED",
    aggregate_type: "mapping_decision",
    aggregate_id: "mapping:D-MRI",
    summary: "D-MRI 停用待重新论证",
    actor: { id: "u", name: "u", role: "mapping_expert" },
    payload: { decision_id: "D-MRI", effective_to: "2026-09-10", reason: "论证依据复核发现问题" },
  });
  const service2 = new ClaimService(store, reproject(store));
  const adjusted = await service2.applyCorrections(OPEN_CLAIM_DRAFT.claim_id, "映射停用", ADJUSTER);
  const revoked = adjusted.payload.corrections.find((correction) => correction.line_no === 1);
  assert.equal(revoked.outcome, "REVOKED");
  assert.equal(revoked.delta.fund_paid, -480);
  assert.equal(revoked.after_ref, null);
  assert.deepEqual(revoked.after_amounts, { total_charge: 600, fund_paid: 0, self_pay: 600 });
});

/* ── 账单说明与追偿 ─────────────────────────────────────── */

test("患者账单说明逐费给出两级目录版本、映射依据与自付理由", async () => {
  const { store, service } = await settledWorld();
  await service.recordPrecheck(OPEN_CLAIM_DRAFT, HOSPITAL_ACTOR);
  await service.submit(OPEN_CLAIM_DRAFT, HOSPITAL_ACTOR);
  const rows = explainClaim(service.ledger.get(OPEN_CLAIM_DRAFT.claim_id), {
    catalog: service.catalog,
    mappings: service.mappings,
  });
  assert.equal(rows.length, 5);
  const partial = rows.find((row) => row.line_no === 2);
  assert.equal(partial.sources.provincial.pricing_unit, "次");
  assert.equal(partial.sources.mapping_decision.decision_type, "PARTIAL_OVERLAP");
  assert.ok(partial.sources.mapping_decision.difference_note.includes("耗材"));
  assert.ok(partial.sources.mapping_decision.basis.documents.length >= 1);
  assert.ok(partial.self_pay_reasons.some((reason) => reason.code === "PARTIAL_OVERLAP_OUTSIDE_INTENT"));

  const split = rows.find((row) => row.line_no === 3);
  assert.deepEqual(split.sources.national.map((item) => item.code), ["N-HX-006", "N-HX-007"]);
  assert.equal(split.sources.payment_rule.rule_code, "R-CROSS");
});

test("场景常量自检：更正发布日晚于服务日、规则为追溯生效", () => {
  assert.equal(RULE_REVISION_2.effective_from, "2026-09-01");
  assert.ok(CORRECTION_PUBLISHED > SERVICE_DATE);
  assert.equal(HOSPITAL.hospital_id, "H330001");
});
