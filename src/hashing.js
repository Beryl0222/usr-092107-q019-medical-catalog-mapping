import { createHash } from "node:crypto";

/**
 * 事件链哈希：对事件的规范表示做 SHA-256。
 * 链上每一条事件都提交前一条的哈希，历史任一字节被改动都会在续链时暴露。
 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
  return `{${entries.join(",")}}`;
}

export function hashEvent(event) {
  const basis = {
    event_id: event.event_id,
    event_type: event.event_type,
    aggregate_type: event.aggregate_type,
    aggregate_id: event.aggregate_id,
    occurred_at: event.occurred_at,
    version: event.version,
    seq: event.seq,
    prev_event_id: event.prev_event_id,
    payload: event.payload ?? {},
    actor: event.actor ?? null,
  };
  return createHash("sha256").update(canonicalize(basis), "utf8").digest("hex");
}

export function digestJson(value) {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}
