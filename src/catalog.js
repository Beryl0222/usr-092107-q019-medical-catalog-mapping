/**
 * 两级目录投影：把目录事件折叠为“项目 → 版本链”。
 * 每个版本保留完整的临床内涵、排除项、计价单位、适用机构、支付条件与专家论证，
 * 以及半开生效区间 [effective_from, effective_to)；停用可携带替代项目。
 *
 * 生效规则：
 * - 新版本激活时自动把前一版本的区间收口到生效日前一天（修订即替代）；
 * - 任何两个版本的生效区间不得重叠，激活历史版本导致重叠将被拒绝；
 * - 更正不是原地改字：被更正版本原样保留，更正以新版本进入版本链。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date, days) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export function compareDate(a, b) {
  return Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
}

function inHalfOpenRange(date, from, to) {
  if (!from) return false;
  if (compareDate(date, from) < 0) return false;
  if (to && compareDate(date, to) >= 0) return false;
  return true;
}

function itemKey(scope, provinceCode, itemCode) {
  return `${scope}:${scope === "provincial" ? provinceCode : "NATIONAL"}:${itemCode}`;
}

function bodyFromPayload(p) {
  return {
    item_code: p.item_code,
    name: p.name,
    clinical_intent: p.clinical_intent,
    exclusions: p.exclusions,
    pricing_unit: p.pricing_unit,
    eligible_facilities: p.eligible_facilities,
    payment_conditions: p.payment_conditions,
    expert_review: p.expert_review,
  };
}

export class Catalog {
  #items = new Map();

  static fromEvents(events) {
    const catalog = new Catalog();
    for (const event of events) catalog.apply(event);
    return catalog;
  }

  #locate(scope, provinceCode, itemCode) {
    const key = itemKey(scope, provinceCode, itemCode);
    if (!this.#items.has(key)) {
      this.#items.set(key, { scope, province_code: scope === "provincial" ? provinceCode : null, item_code: itemCode, revisions: [] });
    }
    return this.#items.get(key);
  }

  apply(event) {
    const p = event.payload;
    switch (event.event_type) {
      case "CATALOG_DRAFTED":
      case "CATALOG_REVISED": {
        const item = this.#locate(p.scope, p.province_code ?? null, p.item_code);
        if (item.revisions.some((revision) => revision.revision === p.revision)) {
          throw new Error(`${p.scope} 项目 ${p.item_code} 版本 ${p.revision} 已存在，禁止重复登记`);
        }
        if (event.event_type === "CATALOG_REVISED") {
          const previous = item.revisions.find((revision) => revision.revision === p.supersedes_revision);
          if (!previous) throw new Error(`${p.item_code} 修订所替代的版本 ${p.supersedes_revision} 不存在`);
          if (p.revision !== p.supersedes_revision + 1) throw new Error(`${p.item_code} 新版本号必须接续为 ${p.supersedes_revision + 1}`);
        }
        item.revisions.push({
          revision: p.revision,
          status: "draft",
          effective_from: p.effective_from ?? null,
          effective_to: null,
          supersedes_revision: p.supersedes_revision ?? null,
          correction_of_revision: null,
          discontinuance: null,
          ...bodyFromPayload(p),
        });
        item.revisions.sort((a, b) => a.revision - b.revision);
        break;
      }
      case "CATALOG_CORRECTED": {
        const item = this.#locate(p.scope, p.province_code ?? null, p.item_code);
        const old = item.revisions.find((revision) => revision.revision === p.correction_of_revision);
        if (!old) throw new Error(`${p.item_code} 被更正版本 ${p.correction_of_revision} 不存在`);
        if (item.revisions.some((revision) => revision.revision === p.revision)) {
          throw new Error(`${p.item_code} 更正版本号 ${p.revision} 已占用`);
        }
        if (!old.effective_from || compareDate(p.effective_from, old.effective_from) < 0) {
          throw new Error(`更正追溯日 ${p.effective_from} 不得早于被更正版本的生效日 ${old.effective_from ?? "（未生效）"}`);
        }
        if (old.effective_to && compareDate(p.effective_from, old.effective_to) >= 0) {
          throw new Error(`更正追溯日 ${p.effective_from} 已超出被更正版本的生效区间`);
        }
        // 被更正版本原样保留（内容、区间标记与更正指针），只是不再是该时段的有效口径。
        item.revisions.push({
          revision: p.revision,
          status: "draft",
          effective_from: null,
          effective_to: null,
          supersedes_revision: null,
          correction_of_revision: p.correction_of_revision,
          correction_note: p.note,
          discontinuance: null,
          ...bodyFromPayload(p),
        });
        item.revisions.sort((a, b) => a.revision - b.revision);
        const corrected = item.revisions.find((revision) => revision.revision === p.revision);
        if (old.effective_to) {
          // 错误版本已被正常修订收口：更正版本只填补原来的错误窗口。
          corrected.effective_from = p.effective_from;
          corrected.effective_to = old.effective_to;
          corrected.status = "superseded";
        } else {
          corrected.effective_from = p.effective_from;
          corrected.status = "active";
          old.effective_to = p.effective_from;
        }
        old.status = "corrected";
        old.corrected_by = p.revision;
        break;
      }
      case "VERSION_ACTIVATED": {
        const item = this.#locate(p.scope, p.province_code ?? null, p.item_code);
        this.#activateRevision(item, p.revision, p.effective_from);
        break;
      }
      case "ITEM_DISCONTINUED": {
        const item = this.#locate(p.scope, p.province_code ?? null, p.item_code);
        const revision = item.revisions.find((candidate) => candidate.revision === p.revision);
        if (!revision) throw new Error(`停用目标 ${p.item_code}@${p.revision} 不存在`);
        if (!revision.effective_from) throw new Error(`${p.item_code}@${p.revision} 尚未生效，不能停用`);
        if (compareDate(p.effective_to, revision.effective_from) < 0) {
          throw new Error(`停用日 ${p.effective_to} 早于版本生效日 ${revision.effective_from}`);
        }
        revision.effective_to = addDays(p.effective_to, 1); // 停用日为最后一个有效日
        revision.status = "discontinued";
        revision.discontinuance = { effective_to: p.effective_to, reason: p.reason, replaced_by: p.replaced_by ?? null };
        break;
      }
    }
  }

  #activateRevision(item, revisionNumber, effectiveFrom, { extra = {} } = {}) {
    const revision = item.revisions.find((candidate) => candidate.revision === revisionNumber);
    if (!revision) throw new Error(`激活目标 ${item.item_code}@${revisionNumber} 不存在`);
    if (revision.effective_from && revision.status !== "draft") {
      throw new Error(`${item.item_code}@${revisionNumber} 已有生效区间，不能重复激活`);
    }
    for (const other of item.revisions) {
      if (other === revision || !other.effective_from) continue;
      // 在版新版本的生效日之后补激活更旧版本，一律构成区间重叠（更正追溯走 CATALOG_CORRECTED）。
      if (!other.effective_to && compareDate(other.effective_from, effectiveFrom) > 0) {
        throw new Error(`${item.item_code}@${revisionNumber} 生效日 ${effectiveFrom} 早于在版版本 ${other.revision} 的生效日 ${other.effective_from}，生效区间重叠`);
      }
      // 正常修订：新版本自在版前序版本之后接续（in-half-range 属预期，由下方收口关闭旧区间）。
      const normalSuccession = revision.supersedes_revision === other.revision && !other.effective_to;
      if (!normalSuccession && inHalfOpenRange(effectiveFrom, other.effective_from, other.effective_to)) {
        throw new Error(`${item.item_code}@${revisionNumber} 生效日 ${effectiveFrom} 与版本 ${other.revision} 的生效区间重叠`);
      }
    }
    // 修订替代：把生效区间仍开放的旧版本收口到新版本生效日前一天。
    for (const other of item.revisions) {
      if (other === revision || !other.effective_from || other.effective_to) continue;
      if (compareDate(other.effective_from, effectiveFrom) <= 0) {
        other.effective_to = effectiveFrom;
        other.status = other.discontinuance ? "discontinued" : "superseded";
      }
    }
    revision.effective_from = effectiveFrom;
    revision.status = "active";
    Object.assign(revision, extra);
  }

  getItem(scope, itemCode, provinceCode = null) {
    return this.#items.get(itemKey(scope, provinceCode, itemCode)) ?? null;
  }

  getRevision(scope, itemCode, revision, provinceCode = null) {
    const item = this.getItem(scope, itemCode, provinceCode);
    return item?.revisions.find((candidate) => candidate.revision === revision) ?? null;
  }

  /** 服务发生日时点查询：只返回该日处于生效区间内的版本，封存与重算都以它为准。 */
  activeOn(scope, itemCode, date, provinceCode = null) {
    const item = this.getItem(scope, itemCode, provinceCode);
    if (!item) return null;
    return item.revisions.find((revision) => inHalfOpenRange(date, revision.effective_from, revision.effective_to)) ?? null;
  }

  /**
   * 从被钉住的版本出发，沿更正链找到服务日真正有效的版本。
   * 映射决定钉住 N001@1、后来 N001@2 更正了 @1 时，未终结账单按 @2 重算；
   * 若当日有效版本不是该版本本身、也不是其后继更正，则返回 null（引用失效）。
   */
  effectiveRevisionFollowing(scope, itemCode, wantedRevision, date, provinceCode = null) {
    const active = this.activeOn(scope, itemCode, date, provinceCode);
    if (!active) return null;
    if (active.revision === wantedRevision) return active;
    const seen = new Set();
    let cursor = active;
    while (cursor && !seen.has(cursor.revision)) {
      seen.add(cursor.revision);
      if (cursor.correction_of_revision === wantedRevision) return active;
      cursor = cursor.correction_of_revision
        ? this.getRevision(scope, itemCode, cursor.correction_of_revision, provinceCode)
        : null;
    }
    return null;
  }

  allItems(scope, provinceCode = null) {
    return [...this.#items.values()].filter(
      (item) => item.scope === scope && (scope === "national" || item.province_code === provinceCode),
    );
  }

  // 事件存储执行“投影校验失败即回滚”时使用的状态快照。
  snapshot() {
    return structuredClone(this.#items);
  }

  restore(snapshot) {
    this.#items = snapshot;
  }
}
