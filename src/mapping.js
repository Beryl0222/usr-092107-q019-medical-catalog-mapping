import { compareDate } from "./catalog.js";

/**
 * 映射裁定投影。
 *
 * 候选（MAPPING_PROPOSED）只代表机器意见；只有 MAPPING_APPROVED 携带人工责任、
 * 差异说明与映射依据，才构成可用于结算的决定。一个省项目版本同时刻至多有一条
 * 生效决定；新决定生效会把旧决定收口。被拒绝或没有决定的项目保持“未映射”，
 * 结算时直接阻断，绝不回退到最近代码。
 */
export class MappingRegistry {
  #proposals = new Map();
  #decisions = new Map();

  static fromEvents(events) {
    const registry = new MappingRegistry();
    for (const event of events) registry.apply(event);
    return registry;
  }

  apply(event) {
    const p = event.payload;
    switch (event.event_type) {
      case "MAPPING_PROPOSED": {
        if (this.#proposals.has(p.proposal_id)) throw new Error(`候选 ${p.proposal_id} 已存在`);
        this.#proposals.set(p.proposal_id, {
          proposal_id: p.proposal_id,
          provincial_ref: p.provincial_ref,
          candidates: p.candidates,
          status: "pending",
          decision_id: null,
        });
        break;
      }
      case "MAPPING_APPROVED": {
        const proposal = this.#proposals.get(p.proposal_id);
        if (!proposal) throw new Error(`人工裁定 ${p.decision_id} 所依据的候选 ${p.proposal_id} 不存在`);
        if (proposal.status !== "pending") throw new Error(`候选 ${p.proposal_id} 已有结论，不能重复裁定`);
        const candidateKinds = new Set(proposal.candidates.map((candidate) => candidate.match_kind));
        if (!candidateKinds.has(p.decision_type)) {
          throw new Error(`裁定类型 ${p.decision_type} 不在候选 ${p.proposal_id} 的机器意见范围内`);
        }
        // 人工可以升级/降级候选类型，但所选国家项目必须出自候选，防止脱离机器证据拍脑袋。
        const candidateTargets = new Set(
          proposal.candidates.flatMap((candidate) =>
            candidate.national_ref ? [`${candidate.national_ref.item_code}@${candidate.national_ref.revision}`]
              : (candidate.national_refs ?? []).map((ref) => `${ref.item_code}@${ref.revision}`),
          ),
        );
        const chosen = p.decision_type === "ONE_TO_MANY"
          ? p.national_refs.map((ref) => `${ref.item_code}@${ref.revision}`)
          : [`${p.national_ref.item_code}@${p.national_ref.revision}`];
        for (const target of chosen) {
          if (!candidateTargets.has(target)) {
            throw new Error(`裁定 ${p.decision_id} 选择了候选之外的国家项目 ${target}，请先生成对应候选`);
          }
        }
        const decision = {
          decision_id: p.decision_id,
          proposal_id: p.proposal_id,
          decision_type: p.decision_type,
          provincial_ref: p.provincial_ref ?? null,
          provincial_refs: p.provincial_refs ?? null,
          national_ref: p.national_ref ?? null,
          national_refs: p.national_refs ?? null,
          difference_note: p.difference_note ?? null,
          mapping_basis: p.mapping_basis,
          effective_from: p.effective_from,
          effective_to: null,
          status: "active",
        };
        this.#decisions.set(p.decision_id, decision);
        proposal.status = "approved";
        proposal.decision_id = p.decision_id;

        // 同一省项目版本若已有生效决定，把旧决定收口到新决定生效日。
        for (const other of this.#decisions.values()) {
          if (other === decision || other.effective_to) continue;
          if (this.#sameProvincialTarget(other, decision)) other.effective_to = p.effective_from;
        }
        break;
      }
      case "MAPPING_REJECTED": {
        const proposal = this.#proposals.get(p.proposal_id);
        if (!proposal) throw new Error(`拒绝的候选 ${p.proposal_id} 不存在`);
        if (proposal.status !== "pending") throw new Error(`候选 ${p.proposal_id} 已有结论`);
        proposal.status = "rejected";
        proposal.reject_reason = p.reason;
        break;
      }
      case "MAPPING_DEACTIVATED": {
        const decision = this.#decisions.get(p.decision_id);
        if (!decision) throw new Error(`待停用决定 ${p.decision_id} 不存在`);
        if (!decision.effective_from || decision.effective_to) throw new Error(`决定 ${p.decision_id} 不在生效中`);
        if (compareDate(p.effective_to, decision.effective_from) < 0) throw new Error("停用日早于决定生效日");
        decision.effective_to = addOneDay(p.effective_to);
        decision.status = "deactivated";
        decision.deactivate_reason = p.reason;
        break;
      }
    }
  }

  #sameProvincialTarget(a, b) {
    const single = (x) => x.provincial_ref && `${x.provincial_ref.item_code}@${x.provincial_ref.revision}`;
    const multi = (x) => (x.provincial_refs ?? []).map((ref) => `${ref.item_code}@${ref.revision}`).sort().join(",");
    const keyOf = (x) => (x.provincial_ref ? `s:${single(x)}` : `m:${multi(x)}`);
    return keyOf(a) === keyOf(b);
  }

  getProposal(proposalId) {
    return this.#proposals.get(proposalId) ?? null;
  }

  getDecision(decisionId) {
    return this.#decisions.get(decisionId) ?? null;
  }

  /** 时点查询：返回某省项目版本在指定日期有效的人工决定；没有就是 null（未映射）。 */
  effectiveDecisionFor(provinceCode, provincialItemCode, revision, date) {
    for (const decision of this.#decisions.values()) {
      const refs = decision.provincial_ref ? [decision.provincial_ref] : decision.provincial_refs;
      const hit = refs.some((ref) => ref.province_code === provinceCode && ref.item_code === provincialItemCode && ref.revision === revision);
      if (!hit) continue;
      if (compareDate(date, decision.effective_from) < 0) continue;
      if (decision.effective_to && compareDate(date, decision.effective_to) >= 0) continue;
      return decision;
    }
    return null;
  }

  snapshot() {
    return { proposals: structuredClone(this.#proposals), decisions: structuredClone(this.#decisions) };
  }

  restore(snapshot) {
    this.#proposals = snapshot.proposals;
    this.#decisions = snapshot.decisions;
  }
}

function addOneDay(date) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
