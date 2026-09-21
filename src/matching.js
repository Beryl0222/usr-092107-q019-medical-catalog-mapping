/**
 * 机器候选生成器。
 *
 * 铁律：机器只给候选和差异信号，绝不自动落码。名称相似只是其中一个信号，
 * 计价单位不一致、排除项不一致、适用机构收窄都会压低可信度或改变候选类型。
 * 所有阈值集中声明、确定性计算，便于专家复核与回放。
 */

export const MATCH_THRESHOLDS = {
  EXACT_INTENT: 0.85, // 临床内涵相似度达到此值且其余硬条件全等，才可把 EXACT 放进候选
  CANDIDATE_MIN: 0.45, // 低于此值不出具向候选，只保留 NONE
  SPLIT_COVERAGE: 0.5, // 一对多拆分中，每个国家项目至少要覆盖的内涵比例（打包文本会摊薄单项得分）
};

function bigrams(text) {
  const normalized = String(text).replace(/[\s，。、；：（）()【】\[\]""'']/g, "");
  const grams = new Set();
  for (let i = 0; i < normalized.length - 1; i += 1) grams.add(normalized.slice(i, i + 2));
  if (normalized.length === 1) grams.add(normalized);
  return grams;
}

export function similarity(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const gram of left) if (right.has(gram)) common += 1;
  return (2 * common) / (left.size + right.size);
}

function compareExclusions(provincial, national) {
  const left = new Set(provincial.exclusions ?? []);
  const right = new Set(national.exclusions ?? []);
  return {
    equal: left.size === right.size && [...left].every((item) => right.has(item)),
    onlyProvincial: [...left].filter((item) => !right.has(item)),
    onlyNational: [...right].filter((item) => !left.has(item)),
  };
}

function compareFacilities(provincial, national) {
  const left = new Set(provincial.eligible_facilities ?? []);
  const right = new Set(national.eligible_facilities ?? []);
  return {
    equal: left.size === right.size && [...left].every((item) => right.has(item)),
    narrower: [...left].filter((item) => !right.has(item)),
    broader: [...right].filter((item) => !left.has(item)),
  };
}

function scorePair(provincial, national) {
  const nameScore = similarity(provincial.name, national.name);
  const intentScore = similarity(
    `${provincial.name} ${provincial.clinical_intent}`,
    `${national.name} ${national.clinical_intent}`,
  );
  const unitMatch = provincial.pricing_unit === national.pricing_unit;
  const exclusionDiff = compareExclusions(provincial, national);
  const facilityDiff = compareFacilities(provincial, national);
  return { national, nameScore, intentScore, unitMatch, exclusionDiff, facilityDiff };
}

function describeSignals(provincial, signal) {
  const reasons = [
    `名称相似度 ${(signal.nameScore * 100).toFixed(0)}%`,
    `临床内涵相似度 ${(signal.intentScore * 100).toFixed(0)}%`,
    signal.unitMatch
      ? `计价单位一致（${signal.national.pricing_unit}）`
      : `计价单位不一致：省项目按「${provincial.pricing_unit}」、国家项目按「${signal.national.pricing_unit}」`,
  ];
  if (!signal.exclusionDiff.equal) {
    if (signal.exclusionDiff.onlyNational.length) reasons.push(`国家项目另有排除项 ${signal.exclusionDiff.onlyNational.length} 条`);
    if (signal.exclusionDiff.onlyProvincial.length) reasons.push(`省项目另有排除项 ${signal.exclusionDiff.onlyProvincial.length} 条`);
  }
  if (!signal.facilityDiff.equal) reasons.push("适用机构范围存在差异");
  return reasons;
}

function singleCandidates(provincial, activeNationals) {
  const scored = activeNationals
    .map((national) => scorePair(provincial, national))
    .sort((a, b) => b.intentScore - a.intentScore);

  const candidates = [];
  for (const signal of scored) {
    if (signal.intentScore < MATCH_THRESHOLDS.CANDIDATE_MIN) continue;
    const hardEqual = signal.unitMatch && signal.exclusionDiff.equal && signal.facilityDiff.equal;
    const matchKind = hardEqual && signal.intentScore >= MATCH_THRESHOLDS.EXACT_INTENT ? "EXACT" : "PARTIAL_OVERLAP";
    candidates.push({
      match_kind: matchKind,
      national_ref: { item_code: signal.national.item_code, revision: signal.national.revision },
      confidence: Number(signal.intentScore.toFixed(3)),
      signals: {
        name_similarity: Number(signal.nameScore.toFixed(3)),
        clinical_intent_similarity: Number(signal.intentScore.toFixed(3)),
        pricing_unit_match: signal.unitMatch,
        exclusion_differences: signal.exclusionDiff.equal ? [] : {
          only_provincial: signal.exclusionDiff.onlyProvincial,
          only_national: signal.exclusionDiff.onlyNational,
        },
        facility_differences: signal.facilityDiff.equal ? [] : {
          provincial_only: signal.facilityDiff.narrower,
          national_only: signal.facilityDiff.broader,
        },
      },
      rationale: describeSignals(provincial, signal).join("；"),
    });
  }
  return candidates;
}

/**
 * 一对多探测：省项目内涵同时覆盖多个国家项目时，给出拆分候选。
 * 仅当每个国家项目都在省项目内涵中占有足够比例，且这些国家项目各自
 * 不是更优的一对一候选时才提出。
 */
function splitCandidates(provincial, activeNationals) {
  const covered = activeNationals
    .map((national) => {
      const coverage = similarity(`${provincial.name} ${provincial.clinical_intent}`, `${national.name} ${national.clinical_intent}`);
      return { national, coverage };
    })
    .filter((entry) => entry.coverage >= MATCH_THRESHOLDS.SPLIT_COVERAGE)
    .sort((a, b) => b.coverage - a.coverage);

  if (covered.length < 2) return [];
  const chosen = covered.slice(0, 3);
  // 若存在一个近乎全等的单点候选，拆分没有必要。
  if (chosen[0].coverage >= MATCH_THRESHOLDS.EXACT_INTENT) return [];
  return [{
    match_kind: "ONE_TO_MANY",
    national_refs: chosen.map((entry) => ({ item_code: entry.national.item_code, revision: entry.national.revision })),
    confidence: Number((chosen.reduce((sum, entry) => sum + entry.coverage, 0) / chosen.length).toFixed(3)),
    rationale: `省项目内涵同时覆盖 ${chosen.length} 个国家项目（${chosen
      .map((entry) => `${entry.national.item_code} 覆盖度 ${(entry.coverage * 100).toFixed(0)}%`)
      .join("，")}），需人工确认能否拆分计费及计价单位换算`,
  }];
}

/**
 * 为一个省项目版本生成全部机器候选。始终附带 NONE 候选，
 * 表示“没有可信对应”，人工可以据此让项目保持未映射。
 */
export function proposeForProvincial(provincialRevision, nationalCatalog, { onDate } = {}) {
  const activeNationals = nationalCatalog.allItems("national")
    .map((item) => (onDate ? item.revisions.find((revision) => {
      if (!revision.effective_from) return false;
      return revision.effective_from <= onDate && (!revision.effective_to || revision.effective_to > onDate);
    }) : item.revisions.find((revision) => revision.status === "active") ?? item.revisions[item.revisions.length - 1]))
    .filter(Boolean);

  const candidates = [...singleCandidates(provincialRevision, activeNationals), ...splitCandidates(provincialRevision, activeNationals)];
  candidates.push({
    match_kind: "NONE",
    confidence: null,
    rationale: candidates.length
      ? "存在近似候选但均未达到可自动建议全等的程度；若无人工确认，本项目保持未映射"
      : "国家目录中未发现内涵相近项目，建议保持未映射",
  });
  return candidates;
}

/**
 * 多对一探测：多个省项目的最佳单点候选指向同一个国家项目时，
 * 给出分组候选，由人工确认这些省项目是否只是国家项目的地方拆分。
 */
export function detectManyToOne(provincialProposals) {
  const groups = new Map();
  for (const { provincial_ref, revision, candidates } of provincialProposals) {
    const best = candidates.find((candidate) => candidate.match_kind === "PARTIAL_OVERLAP" || candidate.match_kind === "EXACT");
    if (!best?.national_ref) continue;
    const key = `${best.national_ref.item_code}@${best.national_ref.revision}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ provincial_ref, revision });
  }
  const proposals = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const [itemCode, revisionText] = key.split("@");
    proposals.push({
      match_kind: "MANY_TO_ONE",
      national_ref: { item_code: itemCode, revision: Number(revisionText) },
      peer_provincial_refs: members.map((member) => member.provincial_ref),
      rationale: `${members.length} 个省项目的最佳候选均指向国家项目 ${key}，可能是地方拆分计费，需人工确认`,
    });
  }
  return proposals;
}
