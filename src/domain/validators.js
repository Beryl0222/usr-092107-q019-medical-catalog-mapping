// 领域字段校验：目录项目与映射裁定在入事件流前必须满足的硬性约束。
function fail(errors, cond, msg) {
  if (!cond) errors.push(msg);
}

export function validateItem(item, level) {
  const errors = [];
  fail(errors, item && typeof item.code === "string" && item.code.length > 0, "项目缺少 code");
  fail(errors, item && typeof item.name === "string" && item.name.length > 0, "项目缺少名称");
  fail(errors, item && typeof item.clinical_content === "string" && item.clinical_content.length > 0,
    "项目缺少临床内涵说明（clinical_content）");
  fail(errors, item && typeof item.pricing_unit === "string" && item.pricing_unit.length > 0,
    "项目缺少计价单位（pricing_unit）");
  if (item) {
    fail(errors, Array.isArray(item.exclusions), "排除项必须为数组（可为空）");
    fail(errors, Array.isArray(item.applicable_institutions) && item.applicable_institutions.length > 0,
      "适用机构缺失或为空");
    fail(errors, item.payment_conditions && typeof item.payment_conditions === "object",
      "支付条件（payment_conditions）缺失");
    if (item.payment_conditions) {
      fail(errors, typeof item.payment_conditions.prior_auth_required === "boolean",
        "支付条件须注明是否需要事前备案/授权");
    }
  }
  if (level === "provincial" && item) {
    fail(errors, Array.isArray(item.required_materials), "省项目须列明必备材料清单 required_materials");
    fail(errors, Array.isArray(item.required_combo), "省项目须列明组合要求 required_combo（无则空数组）");
  }
  return errors;
}

export function validateCatalogDraft(payload) {
  const errors = [];
  fail(errors, ["national", "provincial"].includes(payload.level), "目录层级必须为 national/provincial");
  fail(errors, typeof payload.scope === "string" && payload.scope.length > 0, "目录适用范围缺失（国家填 CN，省级填省码）");
  fail(errors, Array.isArray(payload.items), "目录缺少项目数组");
  for (const item of payload.items ?? []) {
    for (const e of validateItem(item, payload.level)) errors.push(`${item?.code ?? "?"}: ${e}`);
  }
  return errors;
}

const VALID_KINDS = new Set(["EQUIVALENT", "ONE_TO_MANY", "MANY_TO_ONE", "PARTIAL_OVERLAP", "UNMAPPED"]);

export function validateDecision(payload) {
  const errors = [];
  fail(errors, VALID_KINDS.has(payload.kind), `裁定类型非法：${payload.kind}`);
  fail(errors, typeof payload.proposal_event_id === "string", "人工裁定必须基于一条机器候选事件");
  fail(errors, typeof payload.effective_from === "string", "裁定缺少生效日期");
  fail(errors, payload.expert_review !== undefined, "裁定缺少专家论证记录");
  fail(errors, Array.isArray(payload.expert_review) && payload.expert_review.length > 0,
    "映射裁定必须附至少一条专家论证意见");
  for (const r of payload.expert_review ?? []) {
    fail(errors, r && r.expert && r.organization && r.conclusion && r.reviewed_at,
      "专家论证须含专家、机构、结论、论证日期");
  }
  fail(errors, Array.isArray(payload.mapping_basis) && payload.mapping_basis.length > 0,
    "映射依据（mapping_basis：文件/条款/对比表）缺失");

  if (payload.kind === "UNMAPPED") {
    fail(errors, (payload.links ?? []).length === 0, "未映射裁定不得附带国家项目链接");
    fail(errors, payload.provincial_ref?.catalog_id && payload.provincial_ref?.code,
      "未映射裁定必须指明省项目引用 provincial_ref");
    fail(errors, typeof payload.rationale === "string" && payload.rationale.length >= 10,
      "未映射必须书面说明理由，且禁止就近落到任何代码");
  } else {
    fail(errors, Array.isArray(payload.links) && payload.links.length > 0, "映射裁定缺少省-国家项目对应链接");
    for (const link of payload.links ?? []) {
      fail(errors, link.provincial_ref?.catalog_id && link.provincial_ref?.code, "链接缺少省项目引用");
      fail(errors, link.national_ref?.catalog_id && link.national_ref?.code, "链接缺少国家项目引用");
      if (link.unit_conversion) {
        fail(errors, link.unit_conversion.acknowledged === true,
          "计价单位换算须经人工明确确认 acknowledged=true");
        fail(errors, typeof link.unit_conversion.explanation === "string" && link.unit_conversion.explanation.length > 0,
          "计价单位换算须书面说明换算规则");
      }
      if (payload.kind === "ONE_TO_MANY") {
        fail(errors, Number.isFinite(link.share) && link.share > 0 && link.share <= 1,
          "一对多拆账链接须给出 0~1 的 share 分摊比例");
      }
    }
    if (payload.kind === "ONE_TO_MANY") {
      const sum = (payload.links ?? []).reduce((s, l) => s + (l.share ?? 0), 0);
      fail(errors, Math.abs(sum - 1) < 1e-9, `一对多各国家项目分摊比例之和必须为 1（当前 ${sum}）`);
    }
    if (payload.kind !== "EQUIVALENT") {
      fail(errors, typeof payload.difference_note === "string" && payload.difference_note.length >= 10,
        "非等价映射必须书面说明内涵/单位/范围差异（difference_note）");
    }
  }
  return errors;
}

export function validateRules(payload) {
  const errors = [];
  fail(errors, /^[0-9]{6}$/.test(payload.province_code ?? ""), "参保地规则须带 6 位行政区划代码");
  fail(errors, typeof payload.effective_from === "string", "规则缺少生效日期");
  fail(errors, Array.isArray(payload.rules), "规则条目必须为数组");
  for (const r of payload.rules ?? []) {
    fail(errors, ["甲", "乙", "丙"].includes(r.category), `规则 ${r.national_code}: 类别必须为 甲/乙/丙`);
    fail(errors, Number.isFinite(r.coinsurance_self_pay) && r.coinsurance_self_pay >= 0 && r.coinsurance_self_pay < 1,
      `规则 ${r.national_code}: 自付比例必须在 [0,1)`);
  }
  return errors;
}
