// storage.js — namespaced localStorage persistence + export/import.
const NS = "huskies-draft:";

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
export function save(key, value) {
  try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch {}
}
export function remove(key) { try { localStorage.removeItem(NS + key); } catch {} }

// Bundle all app state for the export/import feature.
export function exportState(keys) {
  const out = {};
  for (const k of keys) out[k] = load(k, null);
  return { app: "gorham-huskies-draft", exportedAt: new Date().toISOString(), state: out };
}
export function importState(bundle) {
  if (!bundle || !bundle.state) throw new Error("Invalid backup file");
  for (const k in bundle.state) if (bundle.state[k] != null) save(k, bundle.state[k]);
}
