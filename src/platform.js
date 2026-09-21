import { EventStore } from "./kernel/store.js";
import { buildProjection } from "./domain/projection.js";
import { computeLine, precheckClaim, resolveLine } from "./domain/settlement.js";
import { validateCatalogDraft, validateDecision, validateRules } from "./domain/validators.js";

let seq = 0;
function newId(prefix) {
  seq += 1;
  return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${String(seq).padStart(3, "0")}`;
}

export class MappingPlatform {
  constructor(nationalScope = "CN") {
    this.store = new EventStore();
    this.nationalScope = nationalScope;
    this.#rebuildClaims();
  }

  projection() {
    return buildProjection(this.store.all());
  }

  // ---------- 目录 ----------
  draftCatalog(payload) {
    const errors = validateCatalogDraft(payload);
    if (errors.length) throw new Error(`目录草稿校验失败：\n- ${errors.join("\n- ")}`);
    return this.#append({
      event_type: "CATALOG_DRAFTED",
      aggregate_type: "catalog_version",
      aggregate_id: payload.catalog_id,
      payload,
    });
  }

  activateCatalog(catalogId, { effective_from, announced_at = null, notice = "" }) {
    const draft = this.store.stream("catalog_version", catalogId)
      .filter((e) => e.event_type === "CATALOG_DRAFTED")
      .at(-1);
    if (!draft) throw new Error(`目录不存在或未草拟：${catalogId}`);
    return this.#append({
      event_type: "VERSION_ACTIVATED",
      aggregate_type: "catalog_version",
      aggregate_id: catalogId,
      payload: {
        catalog_id: catalogId,
        level: draft.payload.level,
        scope: draft.payload.scope,
        name: draft.payload.name,
        // 生效即固化项目快照：日后草稿更新不改变本次发布的历史口径。
        items: structuredClone(draft.payload.items),
        effective_from,
        effective_to: null,
        announced_at,
        notice,
      },
    });
  }

  discontinueItem({ catalog_id, code, discontinued_from, replacements, reason }) {
    return this.#append({
      event_type: "ITEM_DISCONTINUED",
      aggregate_type: "catalog_version",
      aggregate_id: catalog_id,
      payload: { catalog_id, code, discontinued_from, replacements, reason, effective_to: null },
    });
  }

  // ---------- 映射：机器候选 → 人工裁定 ----------
  recordProposal(proposal) {
    const id = newId("md");
    this.#append({
      event_type: "MAPPING_PROPOSED",
      aggregate_type: "mapping_decision",
      aggregate_id: id,
      payload: proposal,
    });
    return id;
  }

  approveMapping(decisionId, payload) {
    const proposal = this.store.stream("mapping_decision", decisionId)
      .find((e) => e.event_type === "MAPPING_PROPOSED");
    if (!proposal) throw new Error(`裁定必须基于已登记的机器候选：${decisionId}`);
    const errors = validateDecision(payload);
    if (errors.length) throw new Error(`映射裁定被驳回：\n- ${errors.join("\n- ")}`);
    if (payload.correction_of) {
      const prior = this.store.get(payload.correction_of);
      if (!prior || prior.event_type !== "MAPPING_APPROVED") {
        throw new Error("correction_of 必须指向一条已发布的映射裁定事件");
      }
    }
    return this.#append({
      event_type: "MAPPING_APPROVED",
      aggregate_type: "mapping_decision",
      aggregate_id: decisionId,
      payload,
    });
  }

  // ---------- 参保地规则 ----------
  publishRules(ruleSetId, payload) {
    const errors = validateRules(payload);
    if (errors.length) throw new Error(`参保地规则校验失败：\n- ${errors.join("\n- ")}`);
    return this.#append({
      event_type: "LOCAL_RULES_PUBLISHED",
      aggregate_type: "rule_set",
      aggregate_id: ruleSetId,
      payload: { ...payload, effective_to: null },
    });
  }

  // ---------- 医院预检与结算 ----------
  precheck(claim, { record = false } = {}) {
    const result = precheckClaim({ projection: this.projection(), nationalScope: this.nationalScope, claim });
    if (record) {
      this.#append({
        event_type: "CLAIM_PRECHECKED",
        aggregate_type: "claim",
        aggregate_id: claim.claim_id,
        payload: {
          claim_id: claim.claim_id,
          checked_at: claim.submitted_at ?? new Date().toISOString(),
          ok: result.ok,
          blocking: result.blocking,
          warnings: result.warnings,
        },
      });
    }
    return result;
  }

  settle(claim) {
    const projection = this.projection();
    const pre = precheckClaim({ projection, nationalScope: this.nationalScope, claim });
    if (!pre.ok) throw new Error(`预检存在阻断项，不能结算：\n- ${pre.blocking.join("\n- ")}`);

    const lines = claim.lines.map((line) => {
      const resolved = resolveLine({ projection, nationalScope: this.nationalScope, line,
        serviceDate: line.service_date });
      const result = computeLine({ line, serviceDate: line.service_date, ...resolved });
      return { line_id: line.line_id, status: "OPEN", ...line, result };
    });
    const totals = sumAmounts(lines);
    const event = this.#append({
      event_type: "CLAIM_SETTLED",
      aggregate_type: "claim",
      aggregate_id: claim.claim_id,
      payload: {
        claim_id: claim.claim_id,
        institution_level: claim.institution_level,
        settled_at: claim.submitted_at,
        totals,
        lines: lines.map((l) => ({
          line_id: l.line_id,
          status: l.status,
          province_code: l.province_code,
          insured_province_code: l.insured_province_code,
          provincial_item_code: l.provincial_item_code,
          service_date: l.service_date,
          quantity: l.quantity,
          unit_price_yuan: l.unit_price_yuan,
          auth_evidence: l.auth_evidence === true,
          result: l.result,
        })),
      },
    });
    this.#rebuildClaims();
    return event;
  }

  finalizeLine(claimId, lineId) {
    const claim = this.claims.get(claimId);
    const line = claim?.payload.lines.find((l) => l.line_id === lineId);
    if (!line) throw new Error(`账单行不存在：${claimId}/${lineId}`);
    if (line.status === "FINALIZED") throw new Error("账单行已终结封存，不得重复操作");
    const event = this.#append({
      event_type: "CLAIM_LINE_FINALIZED",
      aggregate_type: "claim",
      aggregate_id: claimId,
      payload: { claim_id: claimId, line_id: lineId, finalized_at: today() },
    });
    this.#rebuildClaims();
    return event;
  }

  // 发布后更正：用最新发布链口径重算所有“未终结”账单行；
  // 已终结（FINALIZED）的封存历史保持原口径，不产生差额。
  applyCorrections(claimId, { because_event_id, reason }) {
    const settled = this.claims.get(claimId);
    if (!settled) throw new Error(`账单不存在：${claimId}`);
    const projection = this.projection();

    // 从 CLAIM_SETTLED 重建账单行输入（结算时固化的数量/单价）。
    const adjustments = [];
    for (const line of settled.payload.lines) {
      if (line.status === "FINALIZED") continue;
      const input = {
        line_id: line.line_id,
        province_code: line.province_code,
        insured_province_code: line.insured_province_code,
        provincial_item_code: line.provincial_item_code,
        service_date: line.service_date,
        quantity: line.quantity,
        unit_price_yuan: line.unit_price_yuan,
        auth_evidence: line.auth_evidence === true,
      };
      const resolved = resolveLine({ projection, nationalScope: this.nationalScope, line: input,
        serviceDate: input.service_date });
      const fresh = computeLine({ line: input, serviceDate: input.service_date, ...resolved });
      const delta = yuanDiff(fresh.amounts, line.result.amounts);
      if (delta.fund_pay_yuan !== 0 || delta.self_pay_yuan !== 0) {
        adjustments.push({
          line_id: line.line_id,
          before: line.result.amounts,
          after: fresh.amounts,
          delta,
          fresh_self_pay_reasons: fresh.self_pay_reasons,
          fresh_basis: fresh.basis,
        });
      }
    }
    if (adjustments.length === 0) return null;

    const event = this.#append({
      event_type: "CLAIM_ADJUSTED",
      aggregate_type: "claim",
      aggregate_id: claimId,
      payload: {
        claim_id: claimId,
        because_event_id,
        reason,
        adjusted_at: today(),
        adjustments,
        note: "差额仅对未终结账单行生效；已终结账单行维持原封存口径",
      },
    });
    this.#rebuildClaims();
    return event;
  }

  claims = new Map();

  #rebuildClaims() {
    this.claims = new Map();
    for (const e of this.store.all()) {
      if (e.aggregate_type !== "claim") continue;
      if (e.event_type === "CLAIM_SETTLED") {
        this.claims.set(e.aggregate_id, structuredClone(e));
      } else if (e.event_type === "CLAIM_LINE_FINALIZED") {
        const c = this.claims.get(e.aggregate_id);
        const line = c?.payload.lines.find((l) => l.line_id === e.payload.line_id);
        if (line) line.status = "FINALIZED";
      } else if (e.event_type === "CLAIM_ADJUSTED") {
        const c = this.claims.get(e.aggregate_id);
        if (!c) continue;
        for (const a of e.payload.adjustments) {
          const line = c.payload.lines.find((l) => l.line_id === a.line_id);
          if (line && line.status !== "FINALIZED") {
            line.result.amounts = a.after;
            line.result.self_pay_reasons = a.fresh_self_pay_reasons;
            line.result.basis = a.fresh_basis;
          }
        }
      }
    }
  }

  #append({ event_type, aggregate_type, aggregate_id, payload, summary }) {
    const version = this.store.currentVersion(aggregate_type, aggregate_id) + 1;
    return this.store.append({
      event_id: newId("evt"),
      event_type,
      aggregate_type,
      aggregate_id,
      occurred_at: new Date().toISOString(),
      version,
      summary: summary ?? event_type,
      payload,
    });
  }
}

function sumAmounts(lines) {
  const t = { charged_yuan: 0, fund_pay_yuan: 0, self_pay_yuan: 0 };
  for (const l of lines) for (const k of Object.keys(t)) t[k] = round2(t[k] + l.result.amounts[k]);
  return t;
}
function round2(n) { return Math.round(n * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }

function yuanDiff(a, b) {
  return {
    charged_yuan: round2(a.charged_yuan - b.charged_yuan),
    fund_pay_yuan: round2(a.fund_pay_yuan - b.fund_pay_yuan),
    self_pay_yuan: round2(a.self_pay_yuan - b.self_pay_yuan),
  };
}

// 结算时已把数量、单价、备案证据固化进账单事件，供日后更正重算未终结账单行。

