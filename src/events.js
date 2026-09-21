import { appendFile, readFile } from "node:fs/promises";

import { hashEvent } from "./hashing.js";
import { validateEvent } from "./validator.js";

/**
 * 追加式事件存储（发布链）。
 *
 * seq 是仓库全局发布序号；事件编号 event_id 配合 prev_event_id 首尾相扣，
 * chain_hash 提交除自身哈希外的全部规范字段。载入历史时逐环复核：
 * 序号断裂、前指错误、聚合版本回退或内容被改，都会直接抛出异常。
 */
export class EventStore {
  #events = [];
  #aggregateVersions = new Map();
  #file = null;
  #projectors = [];
  #projectorSet = new Set();

  /**
   * 注册写前投影：事件通过链与契约校验后、落库前，依次交给投影器做业务校验。
   * 任一投影器抛错则整条事件被拒绝（不进入链、不落盘）。按实例去重。
   */
  addProjector(projector) {
    if (this.#projectorSet.has(projector)) return;
    this.#projectorSet.add(projector);
    this.#projectors.push(projector);
    // 存储可能已从日志载入历史：让新投影器补放到当前链尾。
    for (const event of this.#events) {
      try {
        projector.apply(event);
      } catch (error) {
        this.#projectors.pop();
        this.#projectorSet.delete(projector);
        throw error;
      }
    }
  }

  static async open(file = null) {
    const store = new EventStore();
    store.#file = file;
    if (!file) return store;
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return store;
      throw error;
    }
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error(`事件日志第 ${index + 1} 行不是合法 JSON：${error.message}`);
      }
      store.#ingest(event, { fromLog: true });
    }
    return store;
  }

  get events() {
    return this.#events.slice();
  }

  get length() {
    return this.#events.length;
  }

  headId() {
    return this.#events.length ? this.#events[this.#events.length - 1].event_id : null;
  }

  eventsOf(aggregateId) {
    return this.#events.filter((event) => event.aggregate_id === aggregateId);
  }

  /**
   * 追加一条事件。seq / prev_event_id / chain_hash 与未显式给出的 event_id、
   * 聚合版本号由仓库统一编定，调用方不得自行指定链位。
   */
  async append(input = {}) {
    const seq = this.#events.length + 1;
    const prevEventId = this.headId();
    const aggregateId = input.aggregate_id;
    if (!aggregateId) throw new Error("缺少 aggregate_id，无法编入发布链");

    const nextVersion = (this.#aggregateVersions.get(aggregateId) ?? 0) + 1;
    if (input.version !== undefined && input.version !== nextVersion) {
      throw new Error(`聚合 ${aggregateId} 的下一版本必须是 ${nextVersion}（收到 ${input.version}），事件链不允许跳号或回退`);
    }

    const occurredAt = input.occurred_at ?? new Date().toISOString();
    const last = this.#events[this.#events.length - 1];
    if (last && Date.parse(occurredAt) < Date.parse(last.occurred_at)) {
      throw new Error(`发生时间 ${occurredAt} 早于链尾 ${last.occurred_at}，发布链只能向后追加`);
    }

    const event = {
      event_id: input.event_id ?? `E${String(seq).padStart(6, "0")}`,
      event_type: input.event_type,
      aggregate_type: input.aggregate_type,
      aggregate_id: aggregateId,
      occurred_at: occurredAt,
      version: nextVersion,
      seq,
      prev_event_id: prevEventId,
      summary: input.summary,
      // JSON 归一化：剔除值为 undefined 的键，保证内存对象、落盘文本与重载哈希基完全一致。
      payload: JSON.parse(JSON.stringify(input.payload ?? {})),
      chain_hash: "",
    };
    if (input.actor) event.actor = input.actor;
    event.chain_hash = hashEvent(event);

    const errors = validateEvent(event);
    if (errors.length) throw new Error(`事件未通过契约校验：\n- ${errors.join("\n- ")}`);

    this.#validateAgainstProjectors(event);
    this.#ingest(event, { fromLog: false });
    if (this.#file) {
      await appendFile(this.#file, `${JSON.stringify(event)}\n`, "utf8");
    }
    return event;
  }

  // 投影器做业务规则校验：试探性应用新事件，任一失败则全部回滚；
  // 全部通过则保留状态——投影器自此成为存储的实时跟随者。
  #validateAgainstProjectors(event) {
    const snapshots = this.#projectors.map((projector) => projector.snapshot());
    try {
      for (const projector of this.#projectors) projector.apply(event);
    } catch (error) {
      this.#projectors.forEach((projector, index) => projector.restore(snapshots[index]));
      throw error;
    }
  }

  #ingest(event, { fromLog }) {
    const seqExpected = this.#events.length + 1;
    if (event.seq !== seqExpected) {
      throw new Error(`事件 ${event.event_id} 序号 ${event.seq} 与发布位 ${seqExpected} 不一致（链断裂或缺环）`);
    }
    const prevExpected = this.headId();
    if ((event.prev_event_id ?? null) !== prevExpected) {
      throw new Error(`事件 ${event.event_id} 的 prev_event_id 未指向链尾 ${prevExpected ?? "（空链）"}`);
    }
    const versionExpected = (this.#aggregateVersions.get(event.aggregate_id) ?? 0) + 1;
    if (event.version !== versionExpected) {
      throw new Error(`聚合 ${event.aggregate_id} 版本从 ${versionExpected - 1} 跳到 ${event.version}，必须连续递增`);
    }
    const errors = validateEvent(event);
    if (errors.length) throw new Error(`事件 ${event.event_id} 未通过契约校验：\n- ${errors.join("\n- ")}`);

    if (fromLog) {
      const recomputed = hashEvent(event);
      if (recomputed !== event.chain_hash) {
        throw new Error(`事件 ${event.event_id} 内容哈希不吻合，历史记录已被改动或损坏`);
      }
    } else if (hashEvent(event) !== event.chain_hash) {
      throw new Error(`事件 ${event.event_id} 哈希重算失败`);
    }

    this.#events.push(event);
    this.#aggregateVersions.set(event.aggregate_id, event.version);
  }
}
