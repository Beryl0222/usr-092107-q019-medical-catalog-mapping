// 读模型：把仅追加事件流折叠为“在某个服务日有效”的目录、映射与规则视图。
// 所有 asOf 查询都只基于已发布（released）事件；草拟与候选不会影响结算。
export function buildProjection(events) {
  // 草稿（CATALOG_DRAFTED）不进入结算口径；生效内容以 VERSION_ACTIVATED 中固化的快照为准。
  const activations = []; // {payload, event}
  const discontinued = new Map(); // `${catalog_id}|${code}` -> 停用事件
  const proposals = new Map(); // mapping_decision id -> 候选事件
  const decisions = []; // 人工裁定事件（按写入顺序）
  const rulePublishes = []; // 参保地规则发布

  for (const event of events) {
    switch (event.event_type) {
      case "VERSION_ACTIVATED":
        activations.push({ payload: event.payload, event });
        break;
      case "ITEM_DISCONTINUED": {
        const key = `${event.payload.catalog_id}|${event.payload.code}`;
        discontinued.set(key, { payload: event.payload, event });
        break;
      }
      case "MAPPING_PROPOSED":
        proposals.set(event.aggregate_id, event);
        break;
      case "MAPPING_APPROVED":
        decisions.push(event);
        break;
      case "LOCAL_RULES_PUBLISHED":
        rulePublishes.push(event);
        break;
      default:
        break;
    }
  }

  // 同一层级/适用范围的后继版本生效时，自动关闭前一版本的开放区间。
  const versionsByScope = new Map();
  for (const a of activations) {
    const key = `${a.payload.level}|${a.payload.scope}`;
    const list = versionsByScope.get(key) ?? [];
    list.push(a);
    versionsByScope.set(key, list);
  }
  for (const list of versionsByScope.values()) {
    for (let i = 0; i < list.length - 1; i += 1) {
      if (list[i].payload.effective_to === null) {
        list[i].payload = { ...list[i].payload, effective_to: list[i + 1].payload.effective_from };
      }
    }
  }

  // 人工裁定按“同一省项目指向”接续：后裁定生效时关闭前裁定的开放区间。
  // 更正性裁定（correction_of）可向前覆盖，asOf 自然取到最新口径。
  const decisionViews = decisions.map((event) => ({
    event,
    payload: event.payload,
    effective_from: event.payload.effective_from,
    effective_to: event.payload.effective_to,
  }));
  const decisionsByProvincial = new Map();
  for (const view of decisionViews) {
    // UNMAPPED 裁定无国家链接，用载荷上的 provincial_ref 登记；
    // 其余裁定按链接中的省项目登记，一对多的重复省项目只登记一次。
    if (view.payload.kind === "UNMAPPED") {
      const key = refKey(view.payload.provincial_ref);
      const list = decisionsByProvincial.get(key) ?? [];
      list.push(view);
      decisionsByProvincial.set(key, list);
      continue;
    }
    const seen = new Set();
    for (const link of view.payload.links ?? []) {
      const key = refKey(link.provincial_ref);
      // 一对多裁定会有多条链接指向同一省项目，按省项目只登记一次。
      if (seen.has(key)) continue;
      seen.add(key);
      const list = decisionsByProvincial.get(key) ?? [];
      list.push(view);
      decisionsByProvincial.set(key, list);
    }
  }
  for (const list of decisionsByProvincial.values()) {
    list.sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    for (let i = 0; i < list.length - 1; i += 1) {
      if (list[i].effective_to === null) list[i].effective_to = list[i + 1].effective_from;
    }
  }

  // 参保地规则同样按生效区间接续。
  const rulesByProvince = new Map();
  for (const event of rulePublishes) {
    const list = rulesByProvince.get(event.payload.province_code) ?? [];
    list.push({ event, payload: event.payload });
    rulesByProvince.set(event.payload.province_code, list);
  }
  for (const list of rulesByProvince.values()) {
    list.sort((a, b) => a.payload.effective_from.localeCompare(b.payload.effective_from));
    for (let i = 0; i < list.length - 1; i += 1) {
      if (list[i].payload.effective_to === null) {
        list[i].payload = { ...list[i].payload, effective_to: list[i + 1].payload.effective_from };
      }
    }
  }

  function activeVersion(level, scope, date) {
    const list = versionsByScope.get(`${level}|${scope}`) ?? [];
    const hit = list
      .filter((a) => a.payload.effective_from <= date && (a.payload.effective_to === null || date < a.payload.effective_to))
      .sort((a, b) => b.payload.effective_from.localeCompare(a.payload.effective_from))[0];
    if (!hit) return undefined;
    return {
      catalog_id: hit.event.aggregate_id,
      name: hit.payload.name,
      level,
      scope,
      effective_from: hit.payload.effective_from,
      effective_to: hit.payload.effective_to,
      // 项目来自激活时固化的快照，不随后续草稿变化。
      items: hit.payload.items ?? [],
      activation_event_id: hit.event.event_id,
      release_seq: hit.event.release_seq,
      release_hash: hit.event.hash,
    };
  }

  function findItem(version, code, date) {
    const item = version?.items.find((it) => it.code === code);
    if (!version || !item) return undefined;
    const stop = discontinued.get(`${version.catalog_id}|${code}`);
    const isStopped = Boolean(stop && stop.payload.discontinued_from <= date);
    return {
      ...item,
      catalog_id: version.catalog_id,
      discontinued: isStopped,
      discontinued_from: isStopped ? stop.payload.discontinued_from : null,
      replacements: isStopped ? stop.payload.replacements : [],
      discontinue_event_id: isStopped ? stop.event.event_id : null,
    };
  }

  function mappingFor(provincialRef, date) {
    const list = decisionsByProvincial.get(refKey(provincialRef)) ?? [];
    const covering = list.filter(
      (v) => v.effective_from <= date && (v.effective_to === null || date < v.effective_to),
    );
    // 同一服务日若有多条覆盖（如更正裁定 effective_from 与原裁定相同），
    // 取写入顺序最后一条——即最新人工口径；旧裁定仍在事件链中可追溯。
    covering.sort((a, b) => a.event.chain_seq - b.event.chain_seq);
    const view = covering[covering.length - 1];
    if (!view) return undefined;
    const link = (view.payload.links ?? []).find((l) => refKey(l.provincial_ref) === refKey(provincialRef));
    return { decision_event_id: view.event.event_id, release_seq: view.event.release_seq,
      release_hash: view.event.hash, ...view.payload, link };
  }

  function activeRules(provinceCode, date) {
    const list = rulesByProvince.get(provinceCode) ?? [];
    const hit = list
      .filter((r) => r.payload.effective_from <= date && (r.payload.effective_to === null || date < r.payload.effective_to))
      .sort((a, b) => b.payload.effective_from.localeCompare(a.payload.effective_from))[0];
    if (!hit) return undefined;
    const byCode = new Map((hit.payload.rules ?? []).map((r) => [r.national_code, r]));
    return {
      province_code: provinceCode,
      version_event_id: hit.event.event_id,
      release_seq: hit.event.release_seq,
      release_hash: hit.event.hash,
      ruleFor(nationalCode) {
        return byCode.get(nationalCode) ?? { national_code: nationalCode, category: "甲", coinsurance_self_pay: 0, price_cap: null, prior_auth_required: false, self_pay_reasons: [] };
      },
    };
  }

  return { activeVersion, findItem, mappingFor, activeRules, proposals, decisions };
}

function refKey(ref) {
  return ref ? `${ref.catalog_id}|${ref.code}` : "";
}
