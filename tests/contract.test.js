import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";

test("样例符合完整发布链信封约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
  assert.match(sample.chain_hash, /^[0-9a-f]{64}$/);
  assert.equal(sample.prev_event_id, null);
  assert.equal(sample.seq, 1);
});

test("未知事件类型与缺字段会被拦截", () => {
  assert.ok(validateEvent({}).length >= 3);
  const base = {
    event_id: "X",
    event_type: "NOT_A_TYPE",
    aggregate_type: "claim",
    aggregate_id: "claim:x",
    occurred_at: "2026-09-15T08:00:00+08:00",
    version: 1,
    seq: 1,
    prev_event_id: null,
    chain_hash: "a".repeat(64),
    summary: "x",
    payload: {},
  };
  assert.ok(validateEvent(base).some((error) => error.includes("未知事件类型")));
});
