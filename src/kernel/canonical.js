// 规范化 JSON：对象键按字典序排序，数组保持顺序。
// 事件内容哈希与链路校验都基于同一规范序列化，消除键序与空白差异。
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return canonicalScalar(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") +
    "}"
  );
}

function canonicalScalar(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number" || t === "boolean") return JSON.stringify(value);
  if (t === "string") return JSON.stringify(value);
  if (value === undefined) {
    throw new TypeError("规范化内容不允许 undefined");
  }
  throw new TypeError(`不支持的字段类型：${t}`);
}
