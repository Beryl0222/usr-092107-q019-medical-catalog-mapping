// 领域事件与聚合类型清单。事件一经写入即不可变；任何更正都是后继新事件。
export const EVENT_TYPES = Object.freeze({
  CATALOG_DRAFTED: "CATALOG_DRAFTED",                 // 目录版本草拟（可不发布）
  VERSION_ACTIVATED: "VERSION_ACTIVATED",             // 目录版本生效，给出生效区间
  ITEM_DISCONTINUED: "ITEM_DISCONTINUED",             // 项目停用与替代关系
  MAPPING_PROPOSED: "MAPPING_PROPOSED",               // 机器给出候选映射
  MAPPING_APPROVED: "MAPPING_APPROVED",               // 人工裁定（含“保持未映射”）
  LOCAL_RULES_PUBLISHED: "LOCAL_RULES_PUBLISHED",     // 参保地支付规则版本发布
  CLAIM_PRECHECKED: "CLAIM_PRECHECKED",               // 医院提交前预检
  CLAIM_SETTLED: "CLAIM_SETTLED",                     // 结算并固化两级目录/映射/规则依据
  CLAIM_LINE_FINALIZED: "CLAIM_LINE_FINALIZED",       // 账单行终结（封存）
  CLAIM_ADJUSTED: "CLAIM_ADJUSTED",                   // 发布后更正，仅作用于未终结账单行
});

export const AGGREGATE_TYPES = Object.freeze({
  CATALOG_VERSION: "catalog_version",
  NATIONAL_ITEM: "national_item",
  PROVINCIAL_ITEM: "provincial_item",
  MAPPING_DECISION: "mapping_decision",
  RULE_SET: "rule_set",
  CLAIM: "claim",
});

// 正式发布链只收录权威口径发布：目录版本、停用替代、人工映射裁定、参保地规则。
// 结算类事件在全局哈希链上留痕，但不占用发布序号。
export const RELEASE_TYPES = new Set([
  EVENT_TYPES.VERSION_ACTIVATED,
  EVENT_TYPES.ITEM_DISCONTINUED,
  EVENT_TYPES.MAPPING_APPROVED,
  EVENT_TYPES.LOCAL_RULES_PUBLISHED,
]);
