import { EVENT_TYPES, AGGREGATE_TYPES, RELEASE_TYPES } from "./kernel/events.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "payload"];

// 事件信封的基础校验（深层领域校验见 src/domain/validators.js）。
export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);

  if (record.event_type && !Object.values(EVENT_TYPES).includes(record.event_type)) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if (record.aggregate_type && !Object.values(AGGREGATE_TYPES).includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("occurred_at" in record && !DATE_TIME.test(record.occurred_at ?? "")) {
    errors.push("occurred_at 必须是 RFC3339 日期时间");
  }
  if (record.payload !== undefined && (record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload))) {
    errors.push("payload 必须是对象");
  }
  // 发布类事件必须携带发布链字段（由存储层赋值；外部构造的发布记录缺一不可）。
  if (record.event_type && RELEASE_TYPES.has(record.event_type)) {
    if (record.release_seq !== undefined && (!Number.isInteger(record.release_seq) || record.release_seq < 1)) {
      errors.push("发布事件的 release_seq 必须为正整数");
    }
    if (record.prev_release_hash !== undefined && typeof record.prev_release_hash !== "string") {
      errors.push("prev_release_hash 必须为字符串（首条为 GENESIS）");
    }
  }
  return errors;
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
