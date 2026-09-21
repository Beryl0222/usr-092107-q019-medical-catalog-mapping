import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { EVENT_TYPES, AGGREGATE_TYPES } from "../src/kernel/events.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("未知事件类型与聚合类型被拒绝", () => {
  assert.ok(validateEvent({ event_type: "AUTO_MERGE" }).some((e) => e.includes("未知事件类型")));
  assert.ok(validateEvent({ event_type: "CATALOG_DRAFTED", aggregate_type: "robot" }).some((e) => e.includes("未知聚合类型")));
});

test("version、occurred_at、payload 类型错误被拒绝", () => {
  const ok = {
    event_id: "e1", event_type: "CATALOG_DRAFTED", aggregate_type: "catalog_version",
    aggregate_id: "c1", occurred_at: "2026-10-01T00:00:00+08:00", version: 1, payload: {},
  };
  assert.deepEqual(validateEvent(ok), []);
  assert.ok(validateEvent({ ...ok, version: 0 }).some((e) => e.includes("version")));
  assert.ok(validateEvent({ ...ok, occurred_at: "2026-10-01" }).some((e) => e.includes("RFC3339")));
  assert.ok(validateEvent({ ...ok, payload: null }).some((e) => e.includes("payload")));
});

test("发布事件的发布序号必须为正整数", () => {
  const errors = validateEvent({
    event_id: "r1", event_type: "MAPPING_APPROVED", aggregate_type: "mapping_decision",
    aggregate_id: "m1", occurred_at: "2026-10-01T00:00:00+08:00", version: 1,
    payload: {}, release_seq: 0, prev_release_hash: "GENESIS",
  });
  assert.ok(errors.some((e) => e.includes("release_seq")));
});

test("JSON Schema 可解析，且事件/聚合枚举与代码常量保持一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.event_type.enum.sort(), Object.values(EVENT_TYPES).sort());
  assert.deepEqual(schema.properties.aggregate_type.enum.sort(), Object.values(AGGREGATE_TYPES).sort());
});
