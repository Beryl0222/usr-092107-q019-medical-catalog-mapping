// 机器候选引擎：只给候选与差异线索，绝不产出映射决定。
// 裁定权在人工：一对多、多对一、部分重叠都必须由 MAPPING_APPROVED 明确确认。

const PUNCT = /[\s，。、；：（）()【】\[\]“”"'‘’/／与和及]+/g;

function normalize(text) {
  return String(text ?? "").replace(PUNCT, "");
}

function bigrams(text) {
  const s = typeof text === "string" ? normalize(text) : "";
  if (s.length <= 1) return new Set(s ? [s] : []);
  const set = new Set();
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

export function jaccard(a, b) {
  const sa = bigrams(a);
  const sb = bigrams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let hit = 0;
  for (const g of sa) if (sb.has(g)) hit += 1;
  return hit / (sa.size + sb.size - hit);
}

// 剥除“不含/不包括/排除……”引导的排除内容，避免把国家项目排除内容误判为内涵。
function stripExclusionClauses(text) {
  return String(text ?? "")
    .split(/[。；，,]/)
    .filter((clause) => !/不含|不包括|另行收取|不得|不另/.test(clause))
    .join("");
}

function setCoverage(aGrams, bGrams) {
  // a 中落在 b 内的比例
  if (aGrams.size === 0) return 0;
  let hit = 0;
  for (const g of aGrams) if (bGrams.has(g)) hit += 1;
  return hit / aGrams.size;
}

function termListedIn(term, list) {
  const t = normalize(term);
  return (list ?? []).some((x) => {
    const y = normalize(x);
    return y.includes(t) || t.includes(y);
  });
}

function exclusionConflicts(provincial, national) {
  // 国家项目“排除不单独收费”的内容，若省项目把它写进内涵，就是实质差异；
  // 若省项目同样把它列为排除项，则不构成差异。
  const flags = [];
  const pContent = normalize(stripExclusionClauses(provincial.clinical_content));
  const nContent = normalize(stripExclusionClauses(national.clinical_content));
  for (const ex of national.exclusions ?? []) {
    const e = normalize(ex);
    const core = e.replace(/(工本)?费$/, "");
    if (e.length >= 2 && (pContent.includes(e) || (core.length >= 4 && pContent.includes(core))) &&
        !termListedIn(ex, provincial.exclusions)) {
      flags.push(`省项目内涵含国家明确排除项：${ex}`);
    }
  }
  for (const ex of provincial.exclusions ?? []) {
    const e = normalize(ex);
    if (e.length >= 2 && nContent.includes(e) && !termListedIn(ex, national.exclusions)) {
      flags.push(`省项目排除“${ex}”，但该项属于国家项目内涵`);
    }
  }
  return flags;
}

function institutionConflict(provincial, national) {
  const p = new Set(provincial.applicable_institutions ?? []);
  const n = new Set(national.applicable_institutions ?? []);
  if (p.size === 0 || n.size === 0) return [];
  const diff = [...p].filter((x) => !n.has(x));
  return diff.length ? [`适用机构差异：省限定 ${[...p].join("/")}，国家为 ${[...n].join("/")}`] : [];
}

export function scoreCandidate(provincial, national) {
  const nameScore = jaccard(provincial.name, national.name);
  const pContent = stripExclusionClauses(provincial.clinical_content);
  const nContent = stripExclusionClauses(national.clinical_content);
  const contentScore = jaccard(pContent, nContent);
  const pGrams = bigrams(pContent);
  const nGrams = bigrams(nContent);
  const cover = setCoverage(nGrams, pGrams); // 国家内涵被省项目覆盖的比例
  const extra = setCoverage(pGrams, nGrams) === 0 ? 0 : 1 - setCoverage(pGrams, nGrams); // 省项目外延多出比例
  const score = Math.round((nameScore * 0.45 + contentScore * 0.35 + cover * 0.2) * 100) / 100;

  const reasons = [];
  const riskFlags = [];
  const unitCompatible = provincial.pricing_unit === national.pricing_unit;
  if (!unitCompatible) {
    riskFlags.push(`计价单位不一致：省“${provincial.pricing_unit}” vs 国家“${national.pricing_unit}”，禁止直接合并`);
  }
  let coverageHint = "PARTIAL";
  if ((cover >= 0.8 && extra <= 0.35) || (nameScore >= 0.9 && unitCompatible && cover >= 0.45 && extra <= 0.5)) {
    coverageHint = "FULL";
  } else if (extra > 0.45 && cover >= 0.3) coverageHint = "BROADER";
  if (coverageHint !== "FULL") reasons.push(`内涵覆盖估计 ${(cover * 100).toFixed(0)}%，外延多出 ${(extra * 100).toFixed(0)}%`);
  riskFlags.push(...exclusionConflicts(provincial, national));
  riskFlags.push(...institutionConflict(provincial, national));

  return {
    national_catalog_id: national.catalog_id,
    national_code: national.code,
    national_name: national.name,
    score,
    unit_compatible: unitCompatible,
    coverage_hint: coverageHint,
    reasons,
    risk_flags: riskFlags,
  };
}

// 为单个省项目生成候选清单（按得分降序）。低分即列出但标注为弱线索，
// 机器从不自动删改候选；是否成立一律由人工裁定，UNMAPPED 也由人工明确作出。
export function proposeForItem(provincial, nationalItems, options = {}) {
  const threshold = options.threshold ?? 0.1;
  const ranked = nationalItems
    .map((n) => scoreCandidate(provincial, n))
    .sort((a, b) => b.score - a.score);

  // 一对多判据（启发式，仅作线索）：前两名都不构成单独等价项，
  // 且二者内涵并集对省项目的覆盖比任一单项高出一截（≥15 个百分点）。
  const pGrams = bigrams(stripExclusionClauses(provincial.clinical_content));
  const contentGrams = (code) => {
    const n = nationalItems.find((x) => x.code === code);
    return n ? bigrams(stripExclusionClauses(n.clinical_content)) : new Set();
  };
  const unionCover = (codes) => {
    const u = new Set();
    for (const c of codes) for (const g of contentGrams(c)) u.add(g);
    return setCoverage(pGrams, u);
  };
  const first = ranked.find((c) => c.score >= threshold);
  const second = ranked.find((c) => c !== first && c.score >= threshold);
  const aloneEquivalent = first && first.score >= 0.7 && first.unit_compatible &&
    first.coverage_hint === "FULL" && first.risk_flags.length === 0;
  let combined = null;
  if (!aloneEquivalent && first && second) {
    const single = unionCover([first.national_code]);
    const together = unionCover([first.national_code, second.national_code]);
    if (single < 0.8 && together - single >= 0.1) {
      combined = {
        national_codes: [first, second].map((c) => c.national_code),
        relation_hint: "ONE_TO_MANY",
        reasons: [
          `两候选内涵并集覆盖 ${(together * 100).toFixed(0)}%，高于单项 ${(single * 100).toFixed(0)}%，疑似一对多，需人工确认拆账`,
        ],
      };
    }
  }
  const visible = ranked.filter((c) => c.score >= threshold).slice(0, options.topN ?? 5);
  const suggestedKind = visible.length === 0
    ? "UNMAPPED"
    : combined
      ? "ONE_TO_MANY"
      : aloneEquivalent
        ? "EQUIVALENT_CANDIDATE"
        : "PARTIAL_CANDIDATE";

  return {
    provincial_ref: { catalog_id: provincial.catalog_id, code: provincial.code },
    suggested_kind: suggestedKind,
    candidates: visible,
    combined,
  };
}

// 跨省项目扫描：两个及以上省项目的最高分都指向同一国家项目时，提示多对一风险。
export function detectManyToOne(proposals) {
  const winners = new Map();
  for (const p of proposals) {
    const top = p.candidates[0];
    if (top && top.score >= 0.3) {
      const list = winners.get(top.national_code) ?? [];
      list.push(p.provincial_ref.code);
      winners.set(top.national_code, list);
    }
  }
  return [...winners.entries()]
    .filter(([, codes]) => new Set(codes).size >= 2)
    .map(([nationalCode, codes]) => ({
      national_code: nationalCode,
      provincial_codes: [...new Set(codes)],
      relation_hint: "MANY_TO_ONE",
      reasons: ["多个省项目同时近似同一国家项目，需人工区分内涵边界"],
    }));
}
