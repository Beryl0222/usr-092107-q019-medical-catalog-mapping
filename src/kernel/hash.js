import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";

// 参与哈希的信封字段。hash 本身与运行期索引不在其中。
export const HASH_FIELDS = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "payload",
  "chain_seq",
  "prev_hash",
  "released",
  "release_seq",
  "prev_release_hash",
];

export function hashEvent(event) {
  const body = {};
  for (const f of HASH_FIELDS) body[f] = event[f];
  return createHash("sha256").update(canonicalize(body), "utf8").digest("hex");
}
