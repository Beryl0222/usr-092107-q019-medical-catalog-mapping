const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export const EVENT_TYPES = [
  "CATALOG_DRAFTED",
  "CATALOG_REVISED",
  "CATALOG_CORRECTED",
  "VERSION_ACTIVATED",
  "ITEM_DISCONTINUED",
  "RULE_PUBLISHED",
  "MAPPING_PROPOSED",
  "MAPPING_APPROVED",
  "MAPPING_REJECTED",
  "MAPPING_DEACTIVATED",
  "CLAIM_PRECHECKED",
  "CLAIM_SUBMITTED",
  "CLAIM_SEALED",
  "CLAIM_ADJUSTED",
];

export const AGGREGATE_TYPES = [
  "national_item",
  "provincial_item",
  "payment_rule",
  "mapping_decision",
  "claim",
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isDateString(value) {
  return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function compareDateString(a, b) {
  return Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
}

function failWhen(condition, message, errors) {
  if (condition) errors.push(message);
}

function validateRef(ref, errors, path) {
  if (!ref || typeof ref !== "object") {
    errors.push(`${path} 必须是对象引用`);
    return;
  }
  failWhen(!ref.item_code, `${path}.item_code 缺失`, errors);
  failWhen(!Number.isInteger(ref.revision) || ref.revision < 1, `${path}.revision 必须是正整数版本号`, errors);
}

function validateProvincialRef(ref, errors, path) {
  validateRef(ref, errors, path);
  if (ref) failWhen(!ref.province_code, `${path}.province_code 缺失（省级引用必须标明省份）`, errors);
}

function validateItemBody(payload, errors, path) {
  const textFields = ["item_code", "name", "clinical_intent", "pricing_unit"];
  for (const field of textFields) {
    failWhen(typeof payload[field] !== "string" || payload[field].trim() === "", `${path}.${field} 必须是非空文本`, errors);
  }
  failWhen(!Array.isArray(payload.exclusions), `${path}.exclusions 必须是数组（可为空数组）`, errors);
  failWhen(!Array.isArray(payload.eligible_facilities) || payload.eligible_facilities.length === 0, `${path}.eligible_facilities 必须是非空数组`, errors);
  failWhen(!Array.isArray(payload.payment_conditions), `${path}.payment_conditions 必须是数组`, errors);
  for (const condition of payload.payment_conditions ?? []) {
    failWhen(!condition.code || !condition.description, `${path}.payment_conditions 每项必须含 code 与 description`, errors);
    failWhen(condition.required_documents !== undefined && !Array.isArray(condition.required_documents), `${path}.payment_conditions[].required_documents 必须是数组`, errors);
  }
  const review = payload.expert_review;
  failWhen(!review || typeof review !== "object", `${path}.expert_review 缺失`, errors);
  if (review) {
    failWhen(!review.committee || !review.conclusion, `${path}.expert_review 必须含 committee 与 conclusion`, errors);
    failWhen(review.evidence_refs !== undefined && !Array.isArray(review.evidence_refs), `${path}.expert_review.evidence_refs 必须是数组`, errors);
  }
  failWhen(!Number.isInteger(payload.revision) || payload.revision < 1, `${path}.revision 必须是正整数版本号`, errors);
}

/**
 * 校验事件信封与各事件类型的载荷。
 * 只做单条记录的形态校验；跨记录约束（链、版本单调、生效区间不重叠）在事件存储中检查。
 */
export function validateEvent(record) {
  const errors = [];
  if (!record || typeof record !== "object") return ["事件必须是对象"];

  for (const name of required) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  if (errors.length) return errors;

  failWhen(!EVENT_TYPES.includes(record.event_type), `未知事件类型：${record.event_type}`, errors);
  failWhen(!AGGREGATE_TYPES.includes(record.aggregate_type), `未知聚合类型：${record.aggregate_type}`, errors);
  failWhen(!Number.isInteger(record.version) || record.version < 1, "version 必须是正整数", errors);
  failWhen(typeof record.occurred_at !== "string" || Number.isNaN(Date.parse(record.occurred_at)), "occurred_at 必须是合法时间", errors);
  failWhen(!Number.isInteger(record.seq) || record.seq < 1, "seq 必须是正整数（仓库发布序号）", errors);
  failWhen(typeof record.prev_event_id !== "string" && record.prev_event_id !== null, "prev_event_id 必须是字符串或 null", errors);
  failWhen(typeof record.chain_hash !== "string" || !/^[0-9a-f]{64}$/.test(record.chain_hash ?? ""), "chain_hash 必须是 64 位十六进制 SHA-256", errors);
  failWhen(!record.payload || typeof record.payload !== "object", "payload 必须是对象", errors);
  if (errors.length) return errors;

  const p = record.payload;
  switch (record.event_type) {
    case "CATALOG_DRAFTED":
    case "CATALOG_REVISED": {
      failWhen(!["national", "provincial"].includes(p.scope), "payload.scope 必须是 national 或 provincial", errors);
      if (p.scope === "provincial") failWhen(!p.province_code, "省级项目必须填写 province_code", errors);
      validateItemBody(p, errors, "payload");
      if (record.event_type === "CATALOG_REVISED") {
        failWhen(!Number.isInteger(p.supersedes_revision) || p.supersedes_revision < 1, "修订必须指明 supersedes_revision", errors);
      }
      failWhen(p.effective_from !== undefined && p.effective_from !== null && !isDateString(p.effective_from), "payload.effective_from 必须是 YYYY-MM-DD", errors);
      break;
    }
    case "CATALOG_CORRECTED": {
      failWhen(!["national", "provincial"].includes(p.scope), "payload.scope 必须是 national 或 provincial", errors);
      if (p.scope === "provincial") failWhen(!p.province_code, "省级更正必须填写 province_code", errors);
      failWhen(!p.item_code, "payload.item_code 缺失", errors);
      failWhen(!Number.isInteger(p.revision) || !Number.isInteger(p.correction_of_revision), "更正必须指明新版本号与被更正版本号", errors);
      failWhen(!isDateString(p.published_on), "payload.published_on 必须是 YYYY-MM-DD", errors);
      failWhen(!isDateString(p.effective_from), "payload.effective_from 必须是 YYYY-MM-DD（更正可追溯生效）", errors);
      failWhen(compareDateString(p.effective_from, p.published_on) > 0, "更正生效日不得晚于发布日", errors);
      failWhen(typeof p.note !== "string" || p.note.trim() === "", "更正必须说明 note", errors);
      validateItemBody(p, errors, "payload");
      break;
    }
    case "VERSION_ACTIVATED": {
      failWhen(!["national", "provincial"].includes(p.scope), "payload.scope 必须是 national 或 provincial", errors);
      if (p.scope === "provincial") failWhen(!p.province_code, "省级版本激活必须填写 province_code", errors);
      failWhen(!p.item_code, "payload.item_code 缺失", errors);
      failWhen(!Number.isInteger(p.revision) || p.revision < 1, "payload.revision 必须是正整数", errors);
      failWhen(!isDateString(p.effective_from), "payload.effective_from 必须是 YYYY-MM-DD", errors);
      break;
    }
    case "ITEM_DISCONTINUED": {
      failWhen(!["national", "provincial"].includes(p.scope), "payload.scope 必须是 national 或 provincial", errors);
      if (p.scope === "provincial") failWhen(!p.province_code, "省级停用必须填写 province_code", errors);
      failWhen(!p.item_code || !Number.isInteger(p.revision), "停用必须指明 item_code 与 revision", errors);
      failWhen(!isDateString(p.effective_to), "payload.effective_to 必须是 YYYY-MM-DD", errors);
      failWhen(typeof p.reason !== "string" || p.reason.trim() === "", "停用必须填写 reason", errors);
      if (p.replaced_by) validateRef(p.replaced_by, errors, "payload.replaced_by");
      break;
    }
    case "RULE_PUBLISHED": {
      failWhen(!p.province_code || !p.rule_code, "参保地规则必须含 province_code 与 rule_code", errors);
      failWhen(!Number.isInteger(p.revision) || p.revision < 1, "payload.revision 必须是正整数", errors);
      failWhen(!isDateString(p.effective_from), "payload.effective_from 必须是 YYYY-MM-DD", errors);
      failWhen(!p.entries || typeof p.entries !== "object", "payload.entries 必须是按项目编码组织的支付条件对象", errors);
      for (const [code, entry] of Object.entries(p.entries ?? {})) {
        failWhen(typeof entry.covered !== "boolean", `规则条目 ${code} 必须声明 covered 布尔值`, errors);
        failWhen(entry.covered && (typeof entry.copay_ratio !== "number" || entry.copay_ratio < 0 || entry.copay_ratio > 1), `规则条目 ${code} 的 copay_ratio 必须在 0 到 1 之间`, errors);
      }
      break;
    }
    case "MAPPING_PROPOSED": {
      failWhen(!p.proposal_id, "payload.proposal_id 缺失", errors);
      validateProvincialRef(p.provincial_ref, errors, "payload.provincial_ref");
      failWhen(!Array.isArray(p.candidates) || p.candidates.length === 0, "机器候选至少给出一条（可为 NONE）", errors);
      for (const [i, candidate] of (p.candidates ?? []).entries()) {
        const base = `payload.candidates[${i}]`;
        failWhen(!["EXACT", "PARTIAL_OVERLAP", "ONE_TO_MANY", "MANY_TO_ONE", "NONE"].includes(candidate.match_kind), `${base}.match_kind 非法`, errors);
        failWhen(!candidate.rationale, `${base} 必须给出机器判定依据 rationale`, errors);
        if (candidate.match_kind === "ONE_TO_MANY") {
          failWhen(!Array.isArray(candidate.national_refs) || candidate.national_refs.length < 2, `${base} 一对多至少列出两个国家项目`, errors);
          (candidate.national_refs ?? []).forEach((ref) => validateRef(ref, errors, `${base}.national_refs[]`));
        } else if (candidate.match_kind === "MANY_TO_ONE") {
          validateRef(candidate.national_ref, errors, `${base}.national_ref`);
          failWhen(!Array.isArray(candidate.peer_provincial_refs) || candidate.peer_provincial_refs.length < 1, `${base} 多对一必须列出同组省级项目`, errors);
          (candidate.peer_provincial_refs ?? []).forEach((ref) => validateProvincialRef(ref, errors, `${base}.peer_provincial_refs[]`));
        } else if (candidate.match_kind !== "NONE") {
          validateRef(candidate.national_ref, errors, `${base}.national_ref`);
        }
      }
      break;
    }
    case "MAPPING_APPROVED": {
      failWhen(!p.decision_id || !p.proposal_id, "人工裁定必须含 decision_id 与所依据的 proposal_id", errors);
      failWhen(!["EXACT", "PARTIAL_OVERLAP", "ONE_TO_MANY", "MANY_TO_ONE"].includes(p.decision_type), "payload.decision_type 非法", errors);
      failWhen(!isDateString(p.effective_from), "payload.effective_from 必须是 YYYY-MM-DD", errors);
      const basis = p.mapping_basis;
      failWhen(!basis || typeof basis !== "object", "payload.mapping_basis 缺失", errors);
      if (basis) {
        failWhen(!basis.decided_by, "mapping_basis.decided_by 缺失（人工责任人）", errors);
        failWhen(!Array.isArray(basis.documents) || basis.documents.length === 0, "mapping_basis.documents 至少保留一份依据文件", errors);
      }
      if (p.decision_type === "ONE_TO_MANY") {
        validateProvincialRef(p.provincial_ref, errors, "payload.provincial_ref");
        failWhen(!Array.isArray(p.national_refs) || p.national_refs.length < 2, "一对多至少需要两个国家项目", errors);
        (p.national_refs ?? []).forEach((ref) => validateRef(ref, errors, "payload.national_refs[]"));
      } else if (p.decision_type === "MANY_TO_ONE") {
        validateRef(p.national_ref, errors, "payload.national_ref");
        failWhen(!Array.isArray(p.provincial_refs) || p.provincial_refs.length < 2, "多对一至少需要两个省级项目", errors);
        (p.provincial_refs ?? []).forEach((ref) => validateProvincialRef(ref, errors, "payload.provincial_refs[]"));
      } else {
        validateProvincialRef(p.provincial_ref, errors, "payload.provincial_ref");
        validateRef(p.national_ref, errors, "payload.national_ref");
      }
      if (p.decision_type !== "EXACT") {
        failWhen(typeof p.difference_note !== "string" || p.difference_note.trim().length < 10, "非全等映射必须由人工写明不少于 10 字的差异说明", errors);
      }
      break;
    }
    case "MAPPING_REJECTED": {
      failWhen(!p.proposal_id, "payload.proposal_id 缺失", errors);
      failWhen(typeof p.reason !== "string" || p.reason.trim().length < 5, "拒绝候选必须写明理由", errors);
      break;
    }
    case "MAPPING_DEACTIVATED": {
      failWhen(!p.decision_id, "payload.decision_id 缺失", errors);
      failWhen(!isDateString(p.effective_to), "payload.effective_to 必须是 YYYY-MM-DD", errors);
      failWhen(typeof p.reason !== "string" || p.reason.trim() === "", "停用必须写明 reason", errors);
      break;
    }
    case "CLAIM_PRECHECKED": {
      validateClaimBody(p, errors);
      break;
    }
    case "CLAIM_SUBMITTED": {
      validateClaimBody(p, errors);
      failWhen(!Array.isArray(p.resolved_lines) || p.resolved_lines.length === 0, "提交时必须附逐行解析结果 resolved_lines", errors);
      for (const [i, line] of (p.resolved_lines ?? []).entries()) {
        const base = `payload.resolved_lines[${i}]`;
        failWhen(!Number.isInteger(line.line_no), `${base}.line_no 必须是整数`, errors);
        failWhen(!line.provincial_ref || !line.national_refs || !line.mapping_decision_id || !line.rule_ref, `${base} 必须钉住省项目、国家项目、映射决定与规则版本`, errors);
        failWhen(!Array.isArray(line.national_refs) || line.national_refs.length === 0, `${base}.national_refs 必须是非空数组`, errors);
        failWhen(!line.amounts || typeof line.amounts.self_pay !== "number", `${base}.amounts 必须给出费用拆分`, errors);
      }
      break;
    }
    case "CLAIM_SEALED": {
      failWhen(!p.claim_id, "payload.claim_id 缺失", errors);
      failWhen(!isDateString(p.sealed_on), "payload.sealed_on 必须是 YYYY-MM-DD", errors);
      break;
    }
    case "CLAIM_ADJUSTED": {
      failWhen(!p.claim_id || !p.reason, "更正差额必须指明 claim_id 与 reason", errors);
      failWhen(!Array.isArray(p.corrections) || p.corrections.length === 0, "payload.corrections 至少包含一行差额", errors);
      for (const [i, correction] of (p.corrections ?? []).entries()) {
        const base = `payload.corrections[${i}]`;
        failWhen(!Number.isInteger(correction.line_no), `${base}.line_no 必须是整数`, errors);
        failWhen(!correction.before_ref, `${base} 必须保留调整前引用 before_ref`, errors);
        if (correction.outcome !== "REVOKED") failWhen(!correction.after_ref, `${base} 非追回行必须保留调整后引用 after_ref`, errors);
        failWhen(!correction.delta || typeof correction.delta.fund_paid !== "number", `${base}.delta.fund_paid 必须是数值差额`, errors);
        failWhen(!correction.after_amounts || typeof correction.after_amounts.fund_paid !== "number", `${base}.after_amounts 必须给出重算后的金额`, errors);
      }
      break;
    }
  }
  return errors;
}

function validateClaimBody(p, errors) {
  failWhen(!p.claim_id, "payload.claim_id 缺失", errors);
  failWhen(!p.hospital_id || !p.facility_type, "payload 必须含 hospital_id 与 facility_type", errors);
  failWhen(!p.province_of_care || !p.insured_province, "payload 必须含就医地 province_of_care 与参保地 insured_province", errors);
  failWhen(!isDateString(p.service_date), "payload.service_date 必须是 YYYY-MM-DD", errors);
  failWhen(!Array.isArray(p.lines) || p.lines.length === 0, "payload.lines 不能为空", errors);
  for (const [i, line] of (p.lines ?? []).entries()) {
    const base = `payload.lines[${i}]`;
    failWhen(!line.provincial_item_code || typeof line.quantity !== "number", `${base} 必须含 provincial_item_code 与 quantity`, errors);
    failWhen(line.documents !== undefined && !Array.isArray(line.documents), `${base}.documents 必须是数组`, errors);
  }
}
