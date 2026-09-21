// 结算纯逻辑：按“服务发生日”取当时有效的两级目录、映射裁定与参保地规则；
// 所有依据在结算时固化（事件编号 + 发布序号 + 哈希 + 内容快照）。
// 金额一律以“分”为整数单位，避免浮点误差。

export const yuan = (n) => Math.round(n * 100);
export const toYuan = (cents) => Math.round(cents) / 100;

function centsFromLine(line) {
  return { qty: line.quantity, chargedCents: yuan(line.quantity * line.unit_price_yuan) };
}

// 计算单条账单行；返回金额拆解、自付理由与完整依据快照。
export function computeLine({ line, serviceDate, provincialVersion, provincialItem, mapping, rules, nationalTargets = [] }) {
  const selfPayReasons = [];
  const basis = {
    service_date: serviceDate,
    provincial: provincialVersion
      ? {
          catalog_id: provincialVersion.catalog_id,
          activation_event_id: provincialVersion.activation_event_id,
          release_seq: provincialVersion.release_seq,
          release_hash: provincialVersion.release_hash,
          effective_from: provincialVersion.effective_from,
          effective_to: provincialVersion.effective_to,
          item_snapshot: snapshotItem(provincialItem),
        }
      : null,
    national: [],
    decision: mapping
      ? {
          decision_event_id: mapping.decision_event_id,
          release_seq: mapping.release_seq,
          release_hash: mapping.release_hash,
          kind: mapping.kind,
          difference_note: mapping.difference_note ?? null,
          mapping_basis: mapping.mapping_basis ?? [],
          expert_review: mapping.expert_review ?? [],
          effective_from: mapping.effective_from,
          effective_to: mapping.effective_to,
        }
      : null,
    rules: rules
      ? {
          province_code: rules.province_code,
          version_event_id: rules.version_event_id,
          release_seq: rules.release_seq,
          release_hash: rules.release_hash,
        }
      : null,
    rule_entries: [],
  };

  const { chargedCents, qty } = centsFromLine(line);
  let fundCents = 0;
  let selfPayCents = 0;

  // 情形一：省项目在服务日无有效目录或已停用且无替代——不得走基金。
  if (!provincialVersion || !provincialItem) {
    return finish(chargedCents, chargedCents, fundCents, ["服务日无有效省级项目可依，费用全额自付并退回医院核实"], basis, "NOT_IN_FORCE");
  }
  if (provincialItem.discontinued) {
    selfPayReasons.push(`该省项目已于 ${provincialItem.discontinued_from} 停用，替代项目：${provincialItem.replacements.join("、") || "无"}`);
    return finish(chargedCents, chargedCents, fundCents, selfPayReasons, basis, "DISCONTINUED");
  }
  // 情形二：无映射或人工裁定保持未映射——明确未映射，绝不就近落码。
  if (!mapping || mapping.kind === "UNMAPPED") {
    selfPayReasons.push(mapping?.rationale ?? "该省项目尚无人工确认的国家目录映射，基金不予支付");
    return finish(chargedCents, chargedCents, fundCents, selfPayReasons, basis, "UNMAPPED");
  }

  // 情形三：按裁定链接逐条计算（EQUIVALENT/PARTIAL 一条；ONE_TO_MANY 按 share 拆为多条）。
  const links = mapping.links ?? [];
  const targetsByKey = new Map((nationalTargets ?? []).map((t) => [keyOf(t.link), t]));
  const targets = mapping.kind === "ONE_TO_MANY"
    ? links.map((l) => ({ link: l, amountCents: Math.round(chargedCents * l.share) }))
    : links.map((l) => ({ link: l, amountCents: chargedCents }));

  let allocated = 0;
  for (const t of targets) {
    allocated += t.amountCents;
    const ref = t.link.national_ref;
    const resolvedTarget = targetsByKey.get(keyOf(t.link));
    const nationalVersion = resolvedTarget?.nationalVersion;
    const nationalItem = resolvedTarget?.nationalItem;
    if (!nationalVersion || !nationalItem) {
      selfPayCents += t.amountCents;
      selfPayReasons.push(`映射目标国家项目 ${ref.code} 在服务日无有效版本，对应份额自付`);
      continue;
    }
    basis.national.push({
      catalog_id: nationalVersion.catalog_id,
      activation_event_id: nationalVersion.activation_event_id,
      release_seq: nationalVersion.release_seq,
      release_hash: nationalVersion.release_hash,
      code: nationalItem.code,
      share: t.link.share ?? 1,
      item_snapshot: snapshotItem(nationalItem),
      unit_conversion: t.link.unit_conversion ?? null,
    });

    let share = t.amountCents;
    const rule = rules.ruleFor(nationalItem.code);
    basis.rule_entries.push({ national_code: nationalItem.code, ...rule });

    // 支付条件：国家项目要求事前备案而账单未提供材料——该份额不得支付。
    const authRequired = rule.prior_auth_required || nationalItem.payment_conditions?.prior_auth_required;
    const authOk = !authRequired || line.auth_evidence === true;
    if (authRequired && !authOk) {
      selfPayCents += share;
      selfPayReasons.push(`${nationalItem.code} 需事前备案/授权，账单未提供备案材料，按参保地规则该份额自付`);
      continue;
    }
    if (rule.category === "丙") {
      selfPayCents += share;
      selfPayReasons.push(`${nationalItem.code} 在参保地目录列为丙类（全自费）`);
      continue;
    }
    // 限价：超出部分由参保人承担。一对多拆账时限价份额按 share 折算。
    if (rule.price_cap_yuan != null) {
      const shareFactor = mapping.kind === "ONE_TO_MANY" ? t.link.share : 1;
      const allowedCents = Math.min(yuan(line.unit_price_yuan), yuan(rule.price_cap_yuan)) * qty * shareFactor;
      const overCents = Math.max(0, share - allowedCents);
      if (overCents > 0) {
        share -= overCents;
        selfPayCents += overCents;
        selfPayReasons.push(`${nationalItem.code} 超参保地限价 ${rule.price_cap_yuan} 元/${nationalItem.pricing_unit}，超出部分自付`);
      }
    }
    // 乙类先行自付比例。
    const coins = Number(rule.coinsurance_self_pay ?? 0);
    const coinsCents = Math.round(share * coins);
    selfPayCents += coinsCents;
    fundCents += share - coinsCents;
    if (coinsCents > 0) selfPayReasons.push(`${nationalItem.code} 为乙类，先行自付 ${(coins * 100).toFixed(0)}%`);
    for (const reason of rule.self_pay_reasons ?? []) selfPayReasons.push(`${nationalItem.code}：${reason}`);
  }
  // 一对多拆账的舍入尾差归入基金侧/自付侧平衡：尾差计入自付。
  const rounding = chargedCents - allocated;
  if (rounding > 0) selfPayCents += rounding;

  let status = "PAYABLE";
  if (mapping.kind === "PARTIAL_OVERLAP") status = "PAYABLE_WITH_DIFFERENCE_NOTE";
  return finish(chargedCents, selfPayCents, fundCents, selfPayReasons, basis, status);
}

function finish(chargedCents, selfPayCents, fundCents, reasons, basis, status) {
  return {
    status,
    amounts: {
      charged_yuan: toYuan(chargedCents),
      fund_pay_yuan: toYuan(fundCents),
      self_pay_yuan: toYuan(selfPayCents),
    },
    self_pay_reasons: reasons,
    basis,
  };
}

function snapshotItem(item) {
  if (!item) return null;
  return {
    code: item.code,
    name: item.name,
    clinical_content: item.clinical_content,
    exclusions: item.exclusions ?? [],
    pricing_unit: item.pricing_unit,
    applicable_institutions: item.applicable_institutions ?? [],
    payment_conditions: item.payment_conditions ?? null,
    required_materials: item.required_materials ?? null,
    required_combo: item.required_combo ?? null,
  };
}

// 在投影上解析账单行所需的全部口径对象。nationalTargets 与映射链接一一对应，
// 以旁路方式返回，不向冻结的事件载荷挂载任何字段。
export function resolveLine({ projection, nationalScope, line, serviceDate }) {
  const provincialVersion = projection.activeVersion("provincial", line.province_code, serviceDate);
  const provincialItem = provincialVersion
    ? projection.findItem(provincialVersion, line.provincial_item_code, serviceDate)
    : undefined;
  const mapping = provincialItem
    ? projection.mappingFor({ catalog_id: provincialVersion.catalog_id, code: provincialItem.code }, serviceDate)
    : undefined;
  const nationalVersion = projection.activeVersion("national", nationalScope, serviceDate);
  const nationalTargets = [];
  if (mapping) {
    for (const link of mapping.links ?? []) {
      const item = nationalVersion
        ? projection.findItem(nationalVersion, link.national_ref.code, serviceDate)
        : undefined;
      nationalTargets.push({ link, nationalVersion, nationalItem: item });
    }
  }
  const rules = projection.activeRules(line.insured_province_code, serviceDate);
  return { provincialVersion, provincialItem, mapping, rules, nationalTargets };
}

function keyOf(link) {
  return `${link.provincial_ref.catalog_id}|${link.provincial_ref.code}>${link.national_ref.catalog_id}|${link.national_ref.code}`;
}

// 医院提交前预检：材料、组合、映射、停用、机构、重复收费等缺口一次列清。
export function precheckClaim({ projection, nationalScope, claim }) {
  const blocking = [];
  const warnings = [];
  const nationalTargetsSeen = new Map();

  for (const line of claim.lines) {
    const where = `行 ${line.provincial_item_code}（${line.service_date}）`;
    const pv = projection.activeVersion("provincial", line.province_code, line.service_date);
    if (!pv) {
      blocking.push(`${where}: 服务日无有效省级目录版本`);
      continue;
    }
    const item = projection.findItem(pv, line.provincial_item_code, line.service_date);
    if (!item) {
      blocking.push(`${where}: 省目录中不存在该项目`);
      continue;
    }
    if (item.discontinued) {
      blocking.push(`${where}: 项目已停用，应改按替代项目 ${item.replacements.join("、") || "（无替代）"} 申报`);
    }
    const institutions = new Set(item.applicable_institutions);
    if (claim.institution_level && institutions.size > 0 && !institutions.has(claim.institution_level)) {
      blocking.push(`${where}: 适用机构为 ${[...institutions].join("/")}，本机构（${claim.institution_level}）不在其列`);
    }
    if (line.charged_unit && line.charged_unit !== item.pricing_unit) {
      blocking.push(`${where}: 计价单位申报为“${line.charged_unit}”，目录单位为“${item.pricing_unit}”`);
    }

    // 材料缺口
    const provided = new Set(line.materials ?? []);
    for (const m of item.required_materials ?? []) {
      if (!provided.has(m)) blocking.push(`${where}: 缺少必备材料“${m}”`);
    }

    const mapping = projection.mappingFor({ catalog_id: pv.catalog_id, code: item.code }, line.service_date);
    if (!mapping) {
      blocking.push(`${where}: 尚无人工确认映射，不能提交基金结算（机器候选不等于映射决定）`);
    } else if (mapping.kind === "UNMAPPED") {
      blocking.push(`${where}: 经专家论证保持未映射——${mapping.rationale}`);
    } else {
      // 组合缺口：省项目要求同次申报的配套项目
      const codesInClaim = new Set(claim.lines.map((l) => l.provincial_item_code));
      for (const combo of item.required_combo ?? []) {
        if (!codesInClaim.has(combo)) warnings.push(`${where}: 目录提示应与 ${combo} 组合申报，请确认是否漏项`);
      }
      for (const link of mapping.links ?? []) {
        const nv = projection.activeVersion("national", nationalScope, line.service_date);
        const ni = nv && projection.findItem(nv, link.national_ref.code, line.service_date);
        if (!ni) {
          blocking.push(`${where}: 映射目标 ${link.national_ref.code} 在服务日无有效国家版本`);
          continue;
        }
        if (ni.discontinued) warnings.push(`${where}: 国家项目 ${ni.code} 已停用，替代 ${ni.replacements.join("、") || "无"}`);
        // 国家项目排除项不得借省项目收费
        for (const ex of ni.exclusions ?? []) {
          if (codesInClaim.has(ex) || (item.clinical_content ?? "").includes(ex)) {
            blocking.push(`${where}: “${ex}”属国家项目 ${ni.code} 明确排除、不得另行收费的内容`);
          }
        }
        const seen = nationalTargetsSeen.get(ni.code) ?? [];
        seen.push(line.provincial_item_code);
        nationalTargetsSeen.set(ni.code, seen);
      }
      if (mapping.kind === "PARTIAL_OVERLAP") {
        warnings.push(`${where}: 部分重叠映射，差异说明已存档：${mapping.difference_note}`);
      }
      if (mapping.kind === "ONE_TO_MANY") {
        warnings.push(`${where}: 一对多拆账映射，将按专家确认比例 ${mapping.links.map((l) => `${l.national_ref.code}:${l.share}`).join(" ")} 分别计费`);
      }
    }

    // 参保地规则提示的支付条件
    const rules = projection.activeRules(line.insured_province_code, line.service_date);
    if (rules && mapping && mapping.kind !== "UNMAPPED") {
      for (const link of mapping.links ?? []) {
        const r = rules.ruleFor(link.national_ref.code);
        if (r.prior_auth_required && line.auth_evidence !== true) {
          blocking.push(`${where}: 参保地规则要求 ${link.national_ref.code} 事前备案，缺少备案材料`);
        }
        if (r.category === "丙") warnings.push(`${where}: ${link.national_ref.code} 参保地列为丙类，将全额自付`);
      }
    }
  }

  // 多对一重复收费提示
  for (const [nationalCode, provCodes] of nationalTargetsSeen) {
    const uniq = [...new Set(provCodes)];
    if (uniq.length >= 2) {
      blocking.push(`省项目 ${uniq.join("、")} 在同一次申报中均映射到国家项目 ${nationalCode}，须人工核实是否重复收费`);
    }
  }

  return { ok: blocking.length === 0, blocking, warnings };
}

// 面向患者的账单说明：项目从哪里来、为什么自付，全部可回溯到发布记录。
export function explainSettledLine(lineId, settled) {
  const line = settled.lines.find((l) => l.line_id === lineId);
  if (!line) throw new Error(`账单无此行：${lineId}`);
  const b = line.result.basis;
  const out = [];
  out.push(`【${line.provincial_item_code}】服务日期 ${b.service_date}`);
  if (b.provincial) {
    const p = b.provincial.item_snapshot;
    out.push(`项目来源：${b.provincial.catalog_id} 省级目录（生效 ${b.provincial.effective_from}，发布事件 ${b.provincial.activation_event_id} #${b.provincial.release_seq}）`);
    out.push(`项目名称：${p.name}，计价单位：${p.pricing_unit}`);
    out.push(`临床内涵：${p.clinical_content}`);
    if (p.exclusions.length) out.push(`不含：${p.exclusions.join("；")}`);
  } else {
    out.push("项目来源：服务日无有效省级目录记录");
  }
  if (b.decision) {
    out.push(`映射决定：${b.decision.decision_event_id}（发布序号 #${b.decision.release_seq}），类型 ${b.decision.kind}`);
    if (b.decision.difference_note) out.push(`差异说明：${b.decision.difference_note}`);
    if (b.decision.mapping_basis.length) out.push(`映射依据：${b.decision.mapping_basis.join("；")}`);
  }
  for (const n of b.national) {
    out.push(`对应国家项目：${n.code} ${n.item_snapshot.name}（${n.catalog_id}，发布事件 ${n.activation_event_id} #${n.release_seq}）`);
    if (n.unit_conversion) out.push(`单位换算：${n.unit_conversion.explanation}`);
  }
  if (b.rules) {
    out.push(`参保地规则：${b.rules.province_code}，发布事件 ${b.rules.version_event_id} #${b.rules.release_seq}`);
  }
  out.push(`费用合计 ${line.result.amounts.charged_yuan} 元；基金支付 ${line.result.amounts.fund_pay_yuan} 元；个人自付 ${line.result.amounts.self_pay_yuan} 元`);
  if (line.result.self_pay_reasons.length) {
    out.push("自付理由：");
    for (const r of line.result.self_pay_reasons) out.push(`  - ${r}`);
  }
  return out.join("\n");
}
