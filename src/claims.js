import { compareDate } from "./catalog.js";
import { digestJson } from "./hashing.js";

/**
 * 跨省结算引擎。
 *
 * 口径：一律以“服务发生日”有效的国家目录版本、就医地省级目录版本、
 * 参保地支付规则版本与映射决定为准，并在提交时把每个引用钉死在账单上。
 * - 预检只报告问题，不改账；材料缺口、机构不符、未映射等都是阻断项。
 * - 未映射就是未映射：没有生效的人工决定时直接阻断，绝不回退到最近似编码。
 * - 账单封存后口径冻结；更正发布后只重算未终结（open）账单并产生差额。
 */

const round2 = (value) => Math.round(value * 100) / 100;

export function draftHash(draft) {
  return digestJson({
    hospital_id: draft.hospital_id,
    facility_type: draft.facility_type,
    province_of_care: draft.province_of_care,
    insured_province: draft.insured_province,
    service_date: draft.service_date,
    lines: draft.lines,
  });
}

function missingDocuments(revisions, submitted) {
  const provided = new Set(submitted ?? []);
  const required = new Map();
  for (const revision of revisions) {
    for (const condition of revision.payment_conditions ?? []) {
      for (const doc of condition.required_documents ?? []) {
        required.set(doc, { doc, condition: condition.code, source: revision.item_code });
      }
    }
  }
  return [...required.values()].filter((entry) => !provided.has(entry.doc));
}

function ruleEntry(rules, insuredProvince, nationalCode, date) {
  const rule = rules.activeOn(insuredProvince, date);
  if (!rule) return { rule: null, entry: null };
  return { rule, entry: rule.entries[nationalCode] ?? { covered: false, missing_rule: true } };
}

/**
 * 查找服务日对该省项目版本生效的人工决定。
 * 省项目被更正（新版本沿更正链取代钉住版本）时，映射引用随之平移到后继版本；
 * 没有对应决定就是未映射。
 */
function findEffectiveDecision(mappings, catalog, draft, provincialRevision, date) {
  // 沿更正链逐代上溯：rev3 更正 rev2 更正 rev1 时，钉在 rev1 的决定仍然有效。
  let cursor = provincialRevision;
  const seen = new Set();
  while (cursor && !seen.has(cursor.revision)) {
    seen.add(cursor.revision);
    const decision = mappings.effectiveDecisionFor(draft.province_of_care, cursor.item_code, cursor.revision, date);
    if (decision) return decision;
    if (!cursor.correction_of_revision) break;
    cursor = catalog.getRevision("provincial", cursor.item_code, cursor.correction_of_revision, draft.province_of_care);
  }
  return null;
}

/** 逐行解析。返回 { problems, line }；problems 中分 blocking 与 warnings。 */
function resolveLine(line, index, context) {
  const { catalog, rules, mappings, draft } = context;
  const date = draft.service_date;
  const problems = [];
  const block = (code, message) => problems.push({ severity: "blocking", code, message });

  const provincial = catalog.activeOn("provincial", line.provincial_item_code, date, draft.province_of_care);
  if (!provincial) {
    const item = catalog.getItem("provincial", line.provincial_item_code, draft.province_of_care);
    const last = item?.revisions.filter((revision) => revision.discontinuance).at(-1);
    block("PROVINCIAL_ITEM_NOT_EFFECTIVE", last?.discontinuance?.replaced_by
      ? `省级项目 ${line.provincial_item_code} 在服务日 ${date} 无效，已停用并由 ${last.discontinuance.replaced_by.item_code}@${last.discontinuance.replaced_by.revision} 替代，不得按原编码计费`
      : `省级项目 ${line.provincial_item_code} 在服务日 ${date} 没有生效版本`);
    return { problems };
  }
  if (!provincial.eligible_facilities.includes(draft.facility_type)) {
    block("FACILITY_NOT_ELIGIBLE", `机构类型 ${draft.facility_type} 不属于 ${line.provincial_item_code} 的适用机构（${provincial.eligible_facilities.join("、")}）`);
  }
  if (line.measure_unit && line.measure_unit !== provincial.pricing_unit) {
    block("PRICING_UNIT_MISMATCH", `申报计量单位 ${line.measure_unit} 与目录计价单位「${provincial.pricing_unit}」不一致`);
  }

  const decision = findEffectiveDecision(mappings, catalog, draft, provincial, date);
  if (!decision) {
    // 核心红线：无人工生效决定 → 保持未映射，结算阻断。
    block("UNMAPPED", `省级项目 ${line.provincial_item_code}@${provincial.revision} 在服务日没有生效的人工映射决定，不得按近似编码结算`);
    return { problems };
  }

  const pinnedNationalRefs = decision.national_refs ?? [decision.national_ref];
  const nationalRefs = [];
  const nationals = [];
  for (const ref of pinnedNationalRefs) {
    // 沿更正链找到该引用在服务日真正有效的版本；映射本身仍保留对原决定版本的追溯。
    const national = catalog.effectiveRevisionFollowing("national", ref.item_code, ref.revision, date);
    if (!national) {
      block("NATIONAL_REF_NOT_EFFECTIVE", `映射 ${decision.decision_id} 指向的国家项目 ${ref.item_code}@${ref.revision} 在服务日 ${date} 无有效版本（且无后继更正）`);
    } else {
      nationals.push(national);
      nationalRefs.push({ item_code: national.item_code, revision: national.revision });
    }
  }
  if (problems.some((problem) => problem.severity === "blocking")) return { problems };

  const selfPayReasons = [];
  const allocations = [];
  let totalCharge = 0;
  let fundPaid = 0;

  if (decision.decision_type === "ONE_TO_MANY") {
    if (!Array.isArray(line.allocations) || line.allocations.length === 0) {
      block("ALLOCATION_REQUIRED", `一对多映射 ${decision.decision_id} 必须按国家项目分别申报数量与费用（allocations）`);
      return { problems };
    }
    const validCodes = new Set(nationals.map((item) => item.item_code));
    for (const allocation of line.allocations) {
      if (!validCodes.has(allocation.national_item_code)) {
        block("ALLOCATION_OUT_OF_DECISION", `拆分计费 ${allocation.national_item_code} 不在映射决定范围内`);
        continue;
      }
      const national = nationals.find((item) => item.item_code === allocation.national_item_code);
      if (allocation.measure_unit !== national.pricing_unit) {
        block("ALLOCATION_UNIT_MISMATCH", `${national.item_code} 的拆分申报单位必须是目录计价单位「${national.pricing_unit}」`);
      }
      allocations.push({ national, quantity: allocation.quantity, unit_price: allocation.unit_price });
    }
    if (problems.some((problem) => problem.severity === "blocking")) return { problems };
  } else if (decision.decision_type === "PARTIAL_OVERLAP") {
    if (typeof line.billable_portion !== "number" || line.billable_portion <= 0 || line.billable_portion > 1) {
      block("BILLABLE_PORTION_REQUIRED", "部分重叠映射必须申报与国家项目重叠的计费比例 billable_portion（0,1]");
      return { problems };
    }
  } else if (decision.decision_type === "MANY_TO_ONE") {
    if (!["primary", "component"].includes(line.group_role)) {
      block("GROUP_ROLE_REQUIRED", "多对一映射必须声明本行在组合中的角色 group_role：primary 或 component");
      return { problems };
    }
    const members = decision.provincial_refs;
    const presentCodes = new Set(draft.lines.map((entry) => entry.provincial_item_code));
    const missingMembers = members.filter((ref) => !presentCodes.has(ref.item_code)).map((ref) => ref.item_code);
    if (missingMembers.length) block("GROUP_INCOMPLETE", `多对一组合缺少同组项目：${missingMembers.join("、")}`);
    const groupLines = draft.lines.filter((entry) => members.some((ref) => ref.item_code === entry.provincial_item_code));
    const primaries = groupLines.filter((entry) => entry.group_role === "primary");
    if (primaries.length !== 1) block("GROUP_PRIMARY_NOT_UNIQUE", `多对一组合必须恰好有一行 primary 计费行（当前 ${primaries.length} 行）`);
  }

  // 组合中的非主计行：基金不重复支付。
  if (decision.decision_type === "MANY_TO_ONE" && line.group_role === "component") {
    totalCharge = round2((line.unit_price ?? 0) * line.quantity);
    selfPayReasons.push({
      code: "MANY_TO_ONE_COMPONENT",
      message: `本项目与同账其他项目共同构成国家项目 ${nationals[0].item_code}，基金按国家项目整体支付一次，本行费用由患者自付`,
    });
    const docs = missingDocuments([provincial, nationals[0]], line.documents);
    if (docs.length) block("MISSING_DOCUMENTS", docs.map((entry) => `${entry.doc}（条件 ${entry.condition}）`).join("；"));
    return finish();
  }

  const chargeItems = decision.decision_type === "ONE_TO_MANY"
    ? allocations.map((allocation) => ({
        national: allocation.national,
        charge: round2(allocation.quantity * allocation.unit_price),
        portion: 1,
      }))
    : nationals.map((national) => ({
        national,
        charge: round2((line.unit_price ?? 0) * line.quantity),
        portion: decision.decision_type === "PARTIAL_OVERLAP" ? line.billable_portion : 1,
      }));

  for (const { national, charge, portion } of chargeItems) {
    totalCharge += charge;
    const { rule, entry } = ruleEntry(rules, draft.insured_province, national.item_code, date);
    if (!rule) {
      block("RULE_NOT_FOUND", `参保地 ${draft.insured_province} 在服务日没有生效支付规则`);
      continue;
    }
    if (entry.missing_rule || !entry.covered) {
      selfPayReasons.push({
        code: "NOT_COVERED_BY_INSURED_PROVINCE",
        message: `参保地 ${draft.insured_province} 规则 ${rule.rule_code}@${rule.revision} 规定国家项目 ${national.item_code} 不予支付，费用全部自付`,
      });
      continue;
    }
    const payable = charge * portion;
    const copay = payable * (entry.copay_ratio ?? 0);
    if (copay > 0) {
      selfPayReasons.push({
        code: "COPAY",
        message: `参保地规则 ${rule.rule_code}@${rule.revision} 规定国家项目 ${national.item_code} 自付比例 ${(entry.copay_ratio * 100).toFixed(0)}%`,
      });
    }
    if (portion < 1) {
      selfPayReasons.push({
        code: "PARTIAL_OVERLAP_OUTSIDE_INTENT",
        message: `依据人工映射 ${decision.decision_id} 的差异说明，${((1 - portion) * 100).toFixed(0)}% 费用在国家项目临床内涵之外：${decision.difference_note}`,
      });
    }
    fundPaid += payable - copay;
  }

  const docs = missingDocuments([provincial, ...nationals], line.documents);
  if (docs.length) {
    block("MISSING_DOCUMENTS", `缺少材料：${docs.map((entry) => `${entry.doc}（条件 ${entry.condition}）`).join("；")}`);
  }

  function finish() {
    const activeRule = rules.activeOn(draft.insured_province, date);
    return {
      problems,
      resolved: {
        line_no: index + 1,
        provincial_ref: { province_code: draft.province_of_care, item_code: provincial.item_code, revision: provincial.revision },
        national_refs: nationalRefs,
        mapping_decision_id: decision.decision_id,
        decision_type: decision.decision_type,
        rule_ref: activeRule
          ? { province_code: draft.insured_province, rule_code: activeRule.rule_code, revision: activeRule.revision }
          : null,
        amounts: {
          total_charge: round2(totalCharge),
          fund_paid: round2(fundPaid),
          self_pay: round2(totalCharge - fundPaid),
        },
        self_pay_reasons: selfPayReasons,
      },
    };
  }

  return finish();
}

/** 预检整份账单：汇总阻断项与警告，任何一行阻断都不能提交。 */
export function precheck(draft, context) {
  const lineContext = { ...context, draft };
  const lineReports = draft.lines.map((line, index) => {
    const { problems, resolved } = resolveLine(line, index, lineContext);
    return { line_no: index + 1, provincial_item_code: line.provincial_item_code, problems, resolved: resolved ?? null };
  });
  const blocking = lineReports.flatMap((report) =>
    report.problems.filter((problem) => problem.severity === "blocking").map((problem) => ({ line_no: report.line_no, ...problem })));
  const warnings = lineReports.flatMap((report) =>
    report.problems.filter((problem) => problem.severity === "warning").map((problem) => ({ line_no: report.line_no, ...problem })));
  return {
    draft_hash: draftHash(draft),
    service_date: draft.service_date,
    ok: blocking.length === 0,
    blocking,
    warnings,
    lines: lineReports,
  };
}

/** 从提交事件重建的账单投影。 */
export class ClaimLedger {
  #claims = new Map();

  static fromEvents(events) {
    const ledger = new ClaimLedger();
    for (const event of events) ledger.apply(event);
    return ledger;
  }

  apply(event) {
    const p = event.payload;
    switch (event.event_type) {
      case "CLAIM_PRECHECKED": {
        const claim = this.#ensure(p.claim_id);
        claim.prechecks.push({ recorded_event: event.event_id, at: event.occurred_at, draft_hash: p.draft_hash, report: p.report });
        break;
      }
      case "CLAIM_SUBMITTED": {
        if (this.#claims.has(p.claim_id) && this.#claims.get(p.claim_id).submitted) {
          throw new Error(`账单 ${p.claim_id} 已提交`);
        }
        const claim = this.#ensure(p.claim_id);
        claim.submitted = true;
        claim.status = "open";
        claim.draft = structuredClone({
          claim_id: p.claim_id,
          hospital_id: p.hospital_id,
          facility_type: p.facility_type,
          province_of_care: p.province_of_care,
          insured_province: p.insured_province,
          service_date: p.service_date,
          lines: p.lines,
        });
        claim.resolved_lines = structuredClone(p.resolved_lines);
        claim.submitted_event = event.event_id;
        break;
      }
      case "CLAIM_SEALED": {
        const claim = this.#require(p.claim_id);
        if (claim.status !== "open") throw new Error(`账单 ${p.claim_id} 状态为 ${claim.status}，不能封存`);
        claim.status = "sealed";
        claim.sealed_on = p.sealed_on;
        claim.sealed_event = event.event_id;
        break;
      }
      case "CLAIM_ADJUSTED": {
        const claim = this.#require(p.claim_id);
        if (claim.status !== "open") throw new Error(`账单 ${p.claim_id} 已封存/终结，更正不得改变其口径`);
        claim.adjustments.push({ event_id: event.event_id, at: event.occurred_at, reason: p.reason, corrections: p.corrections });
        for (const correction of p.corrections) {
          const line = claim.resolved_lines.find((entry) => entry.line_no === correction.line_no);
          if (!line) continue;
          if (correction.after_amounts) line.amounts = structuredClone(correction.after_amounts);
          if (correction.after_self_pay_reasons) line.self_pay_reasons = structuredClone(correction.after_self_pay_reasons);
          if (correction.after_ref) {
            line.provincial_ref = correction.after_ref.provincial_ref ?? line.provincial_ref;
            line.national_refs = correction.after_ref.national_refs ?? line.national_refs;
            line.mapping_decision_id = correction.after_ref.mapping_decision_id ?? line.mapping_decision_id;
            line.rule_ref = correction.after_ref.rule_ref ?? line.rule_ref;
          }
          line.adjusted = true;
        }
        break;
      }
    }
  }

  #ensure(id) {
    if (!this.#claims.has(id)) this.#claims.set(id, { claim_id: id, prechecks: [], adjustments: [], submitted: false });
    return this.#claims.get(id);
  }

  #require(id) {
    const claim = this.#claims.get(id);
    if (!claim) throw new Error(`账单 ${id} 不存在`);
    return claim;
  }

  get(claimId) {
    return this.#claims.get(claimId) ?? null;
  }

  snapshot() {
    return structuredClone(this.#claims);
  }

  restore(snapshot) {
    this.#claims = snapshot;
  }
}

/**
 * 应用服务：把预检/提交/封存/更正挂到事件存储上。
 * 所有重算都以服务发生日为时点，而不是重算当天。
 */
export class ClaimService {
  constructor(store, { catalog, rules, mappings }) {
    this.store = store;
    this.catalog = catalog;
    this.rules = rules;
    this.mappings = mappings;
    // 账本作为存储的写前投影与实时跟随者：封存后再调整等状态机违规在落链前即被拒。
    this.ledger = new ClaimLedger();
    store.addProjector(this.ledger);
  }

  async recordPrecheck(draft, actor) {
    const report = precheck(draft, { catalog: this.catalog, rules: this.rules, mappings: this.mappings });
    const event = await this.store.append({
      event_type: "CLAIM_PRECHECKED",
      aggregate_type: "claim",
      aggregate_id: `claim:${draft.claim_id}`,
      summary: `医院提交前预检：${report.ok ? "通过" : `${report.blocking.length} 项阻断`}`,
      actor,
      payload: {
        claim_id: draft.claim_id,
        hospital_id: draft.hospital_id,
        facility_type: draft.facility_type,
        province_of_care: draft.province_of_care,
        insured_province: draft.insured_province,
        service_date: draft.service_date,
        lines: draft.lines,
        draft_hash: report.draft_hash,
        report: { ok: report.ok, blocking: report.blocking, warnings: report.warnings },
      },
    });
    return event;
  }

  async submit(draft, actor) {
    const claim = this.ledger.get(draft.claim_id);
    const latest = claim?.prechecks.at(-1);
    if (!latest) throw new Error("提交前必须先记录一次预检（CLAIM_PRECHECKED）");
    if (latest.draft_hash !== draftHash(draft)) throw new Error("账单内容与最近一次预检不一致，请重新预检");
    if (!latest.report.ok) {
      throw new Error(`预检仍有 ${latest.report.blocking.length} 项阻断，不能提交：\n- ${latest.report.blocking.map((item) => `[第${item.line_no}行 ${item.code}] ${item.message}`).join("\n- ")}`);
    }
    const report = precheck(draft, { catalog: this.catalog, rules: this.rules, mappings: this.mappings });
    if (!report.ok) throw new Error("目录状态已变化，预检结论失效，请重新预检");

    const event = await this.store.append({
      event_type: "CLAIM_SUBMITTED",
      aggregate_type: "claim",
      aggregate_id: `claim:${draft.claim_id}`,
      summary: `跨省账单提交：${draft.lines.length} 行，服务日 ${draft.service_date}`,
      actor,
      payload: {
        ...stripReport(draft),
        resolved_lines: report.lines.map((line) => line.resolved),
      },
    });
    return event;
  }

  async seal(claimId, sealedOn, actor) {
    const claim = this.ledger.get(claimId);
    if (!claim?.submitted) throw new Error(`账单 ${claimId} 不存在或未提交`);
    if (compareDate(sealedOn, claim.draft.service_date) < 0) throw new Error("封存日不得早于服务日");
    const event = await this.store.append({
      event_type: "CLAIM_SEALED",
      aggregate_type: "claim",
      aggregate_id: `claim:${claimId}`,
      summary: `账单 ${claimId} 封存，历史口径冻结`,
      actor,
      payload: { claim_id: claimId, sealed_on: sealedOn },
    });
    return event;
  }

  /**
   * 目录/规则/映射更正发布后调用：仅重算未终结账单。
   * 封存账单直接拒绝；仍无有效映射的行，基金差额追回至 0。
   */
  async applyCorrections(claimId, reason, actor) {
    const claim = this.ledger.get(claimId);
    if (!claim?.submitted) throw new Error(`账单 ${claimId} 不存在或未提交`);
    if (claim.status !== "open") {
      throw new Error(`账单 ${claimId} 已于 ${claim.sealed_on} 封存，更正发布不改变其原口径`);
    }
    const draft = claim.draft;
    const report = precheck(draft, { catalog: this.catalog, rules: this.rules, mappings: this.mappings });
    const currentByLine = new Map(report.lines.map((line) => [line.line_no, line]));

    const corrections = [];
    for (const before of claim.resolved_lines) {
      const now = currentByLine.get(before.line_no);
      const beforeFund = before.amounts.fund_paid;
      if (!now.resolved) {
        // 更正后该行在服务日已无法合规解析（如映射被停用）：基金已付部分全额追回。
        if (beforeFund > 0) {
          corrections.push({
            line_no: before.line_no,
            outcome: "REVOKED",
            before_ref: snapshotRef(before),
            after_ref: null,
            delta: { fund_paid: round2(-beforeFund), self_pay: round2(beforeFund) },
            after_amounts: { total_charge: before.amounts.total_charge, fund_paid: 0, self_pay: before.amounts.total_charge },
            after_self_pay_reasons: [
              ...(before.self_pay_reasons ?? []),
              { code: "PAYMENT_REVOKED", message: now.problems.find((problem) => problem.severity === "blocking")?.message ?? "更正后该费项不再符合支付条件，基金支付全额追回" },
            ],
            reason: now.problems.find((problem) => problem.severity === "blocking")?.message ?? "更正后该费项不再符合支付条件，基金支付全额追回",
          });
        }
        continue;
      }
      const after = now.resolved;
      const deltaFund = round2(after.amounts.fund_paid - beforeFund);
      const refChanged =
        JSON.stringify(snapshotRef(after)) !== JSON.stringify(snapshotRef(before));
      if (deltaFund !== 0 || refChanged) {
        corrections.push({
          line_no: before.line_no,
          outcome: deltaFund === 0 ? "REBASED" : "DELTA",
          before_ref: snapshotRef(before),
          after_ref: snapshotRef(after),
          delta: { fund_paid: deltaFund, self_pay: round2(-deltaFund) },
          after_amounts: structuredClone(after.amounts),
          after_self_pay_reasons: structuredClone(after.self_pay_reasons),
          reason: refChanged ? "发布后更正：按服务日时点重算，适用版本或映射决定发生变化" : "发布后更正：按服务日时点重算金额",
        });
      }
    }

    if (!corrections.length) return null;
    const event = await this.store.append({
      event_type: "CLAIM_ADJUSTED",
      aggregate_type: "claim",
      aggregate_id: `claim:${claimId}`,
      summary: `未终结账单 ${claimId} 产生 ${corrections.length} 行差额`,
      actor,
      payload: { claim_id: claimId, reason, corrections },
    });
    return event;
  }
}

function stripReport(draft) {
  const { claim_id, hospital_id, facility_type, province_of_care, insured_province, service_date, lines } = draft;
  return { claim_id, hospital_id, facility_type, province_of_care, insured_province, service_date, lines };
}

function snapshotRef(resolved) {
  return {
    provincial_ref: resolved.provincial_ref,
    national_refs: resolved.national_refs,
    mapping_decision_id: resolved.mapping_decision_id,
    rule_ref: resolved.rule_ref,
  };
}

/**
 * 患者账单说明与逐费追偿：任何一行费用都能回到当时有效的两级目录版本、
 * 映射决定（含人工依据）与参保地规则版本。
 */
export function explainClaim(claim, context, { asOf = null } = {}) {
  const { catalog, mappings } = context;
  return claim.resolved_lines.map((line) => {
    const provincial = catalog.getRevision("provincial", line.provincial_ref.item_code, line.provincial_ref.revision, line.provincial_ref.province_code);
    const decision = mappings.getDecision(line.mapping_decision_id);
    return {
      line_no: line.line_no,
      amounts: line.amounts,
      sources: {
        provincial: provincial && {
          scope: "就医地省级目录",
          code: provincial.item_code,
          name: provincial.name,
          revision: provincial.revision,
          effective_from: provincial.effective_from,
          effective_to: provincial.effective_to,
          pricing_unit: provincial.pricing_unit,
          clinical_intent: provincial.clinical_intent,
        },
        national: line.national_refs.map((ref) => {
          const national = catalog.getRevision("national", ref.item_code, ref.revision);
          return national && {
            scope: "国家目录",
            code: national.item_code,
            name: national.name,
            revision: national.revision,
            effective_from: national.effective_from,
            effective_to: national.effective_to,
            pricing_unit: national.pricing_unit,
          };
        }),
        mapping_decision: decision && {
          decision_id: decision.decision_id,
          decision_type: decision.decision_type,
          effective_from: decision.effective_from,
          effective_to: decision.effective_to,
          difference_note: decision.difference_note,
          basis: decision.mapping_basis,
        },
        payment_rule: line.rule_ref,
      },
      self_pay_reasons: line.self_pay_reasons,
      adjusted: line.adjusted === true,
      frozen: claim.status === "sealed",
      as_of: asOf ?? claim.sealed_on ?? "open",
    };
  });
}
