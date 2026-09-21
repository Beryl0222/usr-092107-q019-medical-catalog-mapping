import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/kernel/store.js";
import { hashEvent } from "../src/kernel/hash.js";

function base(over = {}) {
  return {
    event_id: "e1",
    event_type: "CATALOG_DRAFTED",
    aggregate_type: "catalog_version",
    aggregate_id: "c1",
    occurred_at: "2026-10-01T00:00:00+08:00",
    version: 1,
    summary: "草稿",
    payload: { catalog_id: "c1" },
    ...over,
  };
}

test("事件连续编号且全局哈希链前后相接", () => {
  const s = new EventStore();
  const a = s.append(base());
  const b = s.append(base({ event_id: "e2", version: 2 }));
  assert.equal(a.chain_seq, 1);
  assert.equal(b.chain_seq, 2);
  assert.equal(b.prev_hash, a.hash);
  assert.equal(s.headHash(), b.hash);
  assert.deepEqual(s.verify(), { events: 2, releases: 0, head: b.hash });
});

test("发布事件独占连续发布序号并构成发布链", () => {
  const s = new EventStore();
  const draft = s.append(base());
  const release1 = s.append(base({ event_id: "r1", event_type: "VERSION_ACTIVATED", version: 2 }));
  s.append(base({ event_id: "p1", event_type: "MAPPING_PROPOSED",
    aggregate_type: "mapping_decision", aggregate_id: "m1" }));
  const release2 = s.append(base({ event_id: "r2", event_type: "MAPPING_APPROVED",
    aggregate_type: "mapping_decision", aggregate_id: "m1", version: 2 }));

  assert.equal(draft.released, false);
  assert.equal(draft.release_seq, null);
  assert.equal(release1.release_seq, 1);
  assert.equal(release1.prev_release_hash, "GENESIS");
  assert.equal(release2.release_seq, 2);
  assert.equal(release2.prev_release_hash, release1.hash);
  assert.deepEqual(s.releases().map((r) => r.release_seq), [1, 2]);
  assert.equal(s.verify().releases, 2);
});

test("同一聚合版本断号被拒绝", () => {
  const s = new EventStore();
  s.append(base());
  assert.throws(() => s.append(base({ event_id: "e3", version: 3 })), /版本断号/);
});

test("事件编号重复被拒绝", () => {
  const s = new EventStore();
  s.append(base());
  assert.throws(() => s.append(base({ aggregate_id: "c2" })), /事件编号重复/);
});

test("写入后事件深冻结，任何字段原地改写都会抛出（严格模式）", () => {
  const s = new EventStore();
  const e = s.append(base());
  assert.throws(() => { e.payload.catalog_id = "tampered"; }, TypeError);
  assert.throws(() => { e.hash = "x"; }, TypeError);
});

test("归档记录被篡改后无法装载：内容改写、断链、发布序号三类都被拒", () => {
  const s1 = new EventStore();
  s1.append(base());
  s1.append(base({ event_id: "r1", event_type: "VERSION_ACTIVATED", version: 2 }));
  const archive = structuredClone(s1.all());

  // 1) 只改载荷不重算哈希 → 哈希不符
  const tamperedContent = structuredClone(archive);
  tamperedContent[0].payload.catalog_id = "c9";
  assert.throws(() => new EventStore().load(tamperedContent), /内容与哈希不符/);

  // 2) 删掉一条事件 → 后续 chain_seq/prev_hash 全部对不上
  const deleted = structuredClone(archive).slice(1);
  assert.throws(() => new EventStore().load(deleted), /chain_seq/);

  // 3) 发布序号被改并重算哈希 → 哈希校验通过，但发布链序号校验失败
  const tamperedRelease = structuredClone(archive);
  tamperedRelease[1].release_seq = 9;
  tamperedRelease[1].hash = hashEvent(tamperedRelease[1]);
  assert.throws(() => new EventStore().load(tamperedRelease), /release_seq/);

  // 4) 原始归档可正常装载并得到完全一致的状态
  const s2 = new EventStore();
  s2.load(archive);
  assert.equal(s2.headHash(), s1.headHash());
  assert.deepEqual(s2.verify(), s1.verify());
});

test("装载后事件同样深冻结", () => {
  const s1 = new EventStore();
  s1.append(base());
  const s2 = new EventStore();
  s2.load(structuredClone(s1.all()));
  const e = s2.get("e1");
  assert.throws(() => { e.payload.catalog_id = "x"; }, TypeError);
});

test("规范化消除键序差异：同一内容不同键序哈希一致", async () => {
  const { canonicalize } = await import("../src/kernel/canonical.js");
  assert.equal(
    canonicalize({ a: 1, b: [1, 2], c: { x: "甲", y: "乙" } }),
    canonicalize({ c: { y: "乙", x: "甲" }, b: [1, 2], a: 1 }),
  );
});
