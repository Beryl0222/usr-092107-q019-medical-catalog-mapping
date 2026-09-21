import { compareDate } from "./catalog.js";

/**
 * 参保地支付规则投影。规则按参保地发布、带版本号与半开生效区间，
 * 结算时以参保地（而非就医地）规则为准，且只取服务发生日有效的版本。
 */
export class PaymentRules {
  #rules = new Map();

  static fromEvents(events) {
    const rules = new PaymentRules();
    for (const event of events) rules.apply(event);
    return rules;
  }

  apply(event) {
    if (event.event_type !== "RULE_PUBLISHED") return;
    const p = event.payload;
    const versions = this.#rules.get(p.province_code) ?? [];
    if (versions.some((version) => version.rule_code === p.rule_code && version.revision === p.revision)) {
      throw new Error(`参保地 ${p.province_code} 规则 ${p.rule_code}@${p.revision} 已发布，禁止重复`);
    }
    const previous = versions.find((version) => version.rule_code === p.rule_code && !version.effective_to);
    if (previous && compareDate(previous.effective_from, p.effective_from) > 0) {
      throw new Error(`规则 ${p.rule_code} 新版本生效日不得早于在版规则`);
    }
    if (previous) previous.effective_to = p.effective_from;
    versions.push({
      province_code: p.province_code,
      rule_code: p.rule_code,
      revision: p.revision,
      effective_from: p.effective_from,
      effective_to: null,
      entries: p.entries,
    });
    this.#rules.set(p.province_code, versions);
  }

  activeOn(provinceCode, date, ruleCode = null) {
    const versions = this.#rules.get(provinceCode) ?? [];
    return (
      versions.find((version) => {
        if (ruleCode && version.rule_code !== ruleCode) return false;
        if (compareDate(date, version.effective_from) < 0) return false;
        if (version.effective_to && compareDate(date, version.effective_to) >= 0) return false;
        return true;
      }) ?? null
    );
  }

  entryOn(provinceCode, nationalItemCode, date) {
    const rule = this.activeOn(provinceCode, date);
    if (!rule) return { rule: null, entry: null };
    return { rule, entry: rule.entries[nationalItemCode] ?? null };
  }

  snapshot() {
    return structuredClone(this.#rules);
  }

  restore(snapshot) {
    this.#rules = snapshot;
  }
}
