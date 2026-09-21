import { hashEvent } from "./hash.js";
import { RELEASE_TYPES } from "./events.js";

// 仅追加事件存储：
// - chain_seq 为全仓库连续编号，prev_hash 串起全部事件；
// - 发布类事件另取 release_seq，prev_release_hash 构成正式发布链；
// - 同一聚合的 version 必须连续递增；
// - 写入后只允许追加，任何字段改写都会在 verify() 暴露。
export class EventStore {
  #events = [];
  #byId = new Map();
  #chainHead = "GENESIS";
  #releaseHead = "GENESIS";
  #releaseSeq = 0;
  #nextSeq = 1;

  append(input) {
    const event = { ...input, hash: undefined };
    if (!event.event_id || typeof event.event_id !== "string") {
      throw new Error("事件必须包含 event_id");
    }
    if (this.#byId.has(event.event_id)) {
      throw new Error(`事件编号重复：${event.event_id}`);
    }
    if (!Number.isInteger(event.version) || event.version < 1) {
      throw new Error("version 必须为正整数");
    }
    this.#checkAggregateVersion(event);

    event.chain_seq = this.#nextSeq;
    event.prev_hash = this.#chainHead;
    const isRelease = RELEASE_TYPES.has(event.event_type);
    event.released = isRelease;
    if (isRelease) {
      this.#releaseSeq += 1;
      event.release_seq = this.#releaseSeq;
      event.prev_release_hash = this.#releaseHead;
    } else {
      event.release_seq = null;
      event.prev_release_hash = null;
    }
    event.hash = hashEvent(event);

    deepFreeze(event);
    this.#events.push(event);
    this.#byId.set(event.event_id, event);
    this.#nextSeq += 1;
    this.#chainHead = event.hash;
    if (isRelease) this.#releaseHead = event.hash;
    return event;
  }

  #checkAggregateVersion(event) {
    const expected = this.currentVersion(event.aggregate_type, event.aggregate_id) + 1;
    if (event.version !== expected) {
      throw new Error(
        `${event.aggregate_type}/${event.aggregate_id} 版本断号：收到 ${event.version}，应为 ${expected}`,
      );
    }
  }

  currentVersion(aggregateType, aggregateId) {
    let v = 0;
    for (const e of this.#events) {
      if (e.aggregate_type === aggregateType && e.aggregate_id === aggregateId) v = e.version;
    }
    return v;
  }

  all() {
    return this.#events.map(freeze);
  }

  get(eventId) {
    const e = this.#byId.get(eventId);
    return e ? freeze(e) : undefined;
  }

  stream(aggregateType, aggregateId) {
    return this.#events
      .filter((e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId)
      .map(freeze);
  }

  releases() {
    return this.#events.filter((e) => e.released).map(freeze);
  }

  headHash() {
    return this.#chainHead;
  }

  // 从外部记录（如归档文件）装载：逐条复核哈希与双链后重建索引。
  // 任何字段被改动、链断裂或序号异常都会被拒绝，装载结果与原生追加完全等价。
  load(records) {
    for (const record of records) {
      const { hash, ...rest } = record;
      if (hashEvent(rest) !== hash) throw new Error(`装载失败，事件内容与哈希不符：${record.event_id}`);
      if (record.chain_seq !== this.#nextSeq) throw new Error(`装载失败，chain_seq 不连续：${record.event_id}`);
      if (record.prev_hash !== this.#chainHead) throw new Error(`装载失败，全局链断裂：${record.event_id}`);
      if (this.#byId.has(record.event_id)) throw new Error(`装载失败，事件编号重复：${record.event_id}`);
      if (record.version !== this.currentVersion(record.aggregate_type, record.aggregate_id) + 1) {
        throw new Error(`装载失败，聚合版本断号：${record.event_id}`);
      }
      if (record.released) {
        if (record.release_seq !== this.#releaseSeq + 1) throw new Error(`装载失败，release_seq 断号：${record.event_id}`);
        if (record.prev_release_hash !== this.#releaseHead) throw new Error(`装载失败，发布链断裂：${record.event_id}`);
        this.#releaseSeq += 1;
        this.#releaseHead = record.hash;
      }
      const frozen = structuredClone(record);
      deepFreeze(frozen);
      this.#events.push(frozen);
      this.#byId.set(frozen.event_id, frozen);
      this.#nextSeq += 1;
      this.#chainHead = frozen.hash;
    }
  }

  toJSON() {
    return this.#events;
  }

  // 全量复核：字段哈希、全局链与发布链的连续性。任何历史被改动都会在此报错。
  verify() {
    let chainHead = "GENESIS";
    let releaseHead = "GENESIS";
    let releaseSeq = 0;
    let seq = 0;
    for (const stored of this.#events) {
      seq += 1;
      if (stored.chain_seq !== seq) throw new Error(`chain_seq 断号：${stored.event_id}`);
      if (stored.prev_hash !== chainHead) throw new Error(`全局链断裂：${stored.event_id}`);
      const recomputed = hashEvent(stored);
      if (recomputed !== stored.hash) {
        throw new Error(`事件内容被改动：${stored.event_id}`);
      }
      if (stored.released) {
        releaseSeq += 1;
        if (stored.release_seq !== releaseSeq) {
          throw new Error(`release_seq 断号：${stored.event_id}`);
        }
        if (stored.prev_release_hash !== releaseHead) {
          throw new Error(`发布链断裂：${stored.event_id}`);
        }
        releaseHead = stored.hash;
      } else if (stored.release_seq !== null || stored.prev_release_hash !== null) {
        throw new Error(`非发布事件不得占用发布序号：${stored.event_id}`);
      }
      chainHead = stored.hash;
    }
    return { events: seq, releases: releaseSeq, head: chainHead };
  }
}

function freeze(event) {
  return Object.freeze({ ...event });
}

// 写入即深冻结：任何代码都无法原地改写历史事件（含嵌套 payload）。
function deepFreeze(value) {
  if (value === null || typeof value !== "object") return;
  Object.freeze(value);
  for (const k of Object.keys(value)) deepFreeze(value[k]);
}
