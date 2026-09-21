import { MappingPlatform } from "../src/platform.js";
import { proposeForItem } from "../src/domain/matcher.js";
import { nationalCatalog, provincialCatalog } from "../data/sample-catalogs.js";

export const expert = (who = "张敏", org = "国家医保研究院", conclusion = "论证通过") => ({
  expert: who, organization: org, conclusion, reviewed_at: "2026-09-18",
});

export function bootCatalogs(pf, { nationalFrom = "2026-10-01", provincialFrom = "2026-10-01" } = {}) {
  pf.draftCatalog(nationalCatalog);
  pf.activateCatalog("NAT-MSL-2026", { effective_from: nationalFrom });
  pf.draftCatalog(provincialCatalog);
  pf.activateCatalog("BJ-MSL-2026", { effective_from: provincialFrom });
}

export function publishHebeiRules(pf, { from = "2026-10-01", rules } = {}) {
  pf.publishRules("RULES-HEB-2026", {
    province_code: "130000",
    version: "冀医保规〔2026〕4号",
    effective_from: from,
    rules: rules ?? [
      { national_code: "N110100001", category: "甲", coinsurance_self_pay: 0, price_cap_yuan: null, prior_auth_required: false, self_pay_reasons: [] },
      { national_code: "N220300012", category: "乙", coinsurance_self_pay: 0.1, price_cap_yuan: 110, prior_auth_required: false, self_pay_reasons: [] },
      { national_code: "N250200018", category: "甲", coinsurance_self_pay: 0, price_cap_yuan: null, prior_auth_required: false, self_pay_reasons: [] },
      { national_code: "N250200019", category: "乙", coinsurance_self_pay: 0.15, price_cap_yuan: 30, prior_auth_required: false, self_pay_reasons: [] },
      { national_code: "N340100007", category: "甲", coinsurance_self_pay: 0, price_cap_yuan: null, prior_auth_required: false, self_pay_reasons: [] },
      { national_code: "N340100008", category: "乙", coinsurance_self_pay: 0.2, price_cap_yuan: null, prior_auth_required: true, self_pay_reasons: [] },
    ],
  });
}

export function proposalIdFor(pf, provincialCode) {
  const item = provincialCatalog.items.find((i) => i.code === provincialCode);
  const proposal = proposeForItem(
    { ...item, catalog_id: "BJ-MSL-2026" },
    nationalCatalog.items.map((n) => ({ ...n, catalog_id: "NAT-MSL-2026" })),
  );
  return pf.recordProposal(proposal);
}

export function newPlatform() {
  return new MappingPlatform("CN");
}

// 按省目录自动带出计价单位；显式传入 charged_unit 时以传入值为准（用于测单位不符阻断）。
export const claimLine = (overrides = {}) => {
  const code = overrides.provincial_item_code ?? "BJ-B0101";
  const item = provincialCatalog.items.find((i) => i.code === code);
  return {
    line_id: "L1",
    province_code: "110000",
    insured_province_code: "130000",
    provincial_item_code: "BJ-B0101",
    service_date: "2026-11-03",
    quantity: 1,
    unit_price_yuan: 50,
    charged_unit: item?.pricing_unit ?? "日",
    materials: [],
    auth_evidence: false,
    ...overrides,
  };
};

export const claim = (lines, overrides = {}) => ({
  claim_id: "CLAIM-T-001",
  institution_level: "三级",
  submitted_at: "2026-11-05T10:00:00+08:00",
  lines,
  ...overrides,
});

// 常用裁定：等价床位费
export function approveBedEquivalent(pf) {
  const id = proposalIdFor(pf, "BJ-B0101");
  return pf.approveMapping(id, {
    proposal_event_id: id,
    kind: "EQUIVALENT", effective_from: "2026-10-01", effective_to: null,
    links: [{
      provincial_ref: { catalog_id: "BJ-MSL-2026", code: "BJ-B0101" },
      national_ref: { catalog_id: "NAT-MSL-2026", code: "N110100001" },
    }],
    expert_review: [expert()],
    mapping_basis: ["国家2026年第3号公告附件2"],
  });
}
