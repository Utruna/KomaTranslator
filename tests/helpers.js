// chrome.storage.local en mémoire (get(null), get(clé), set, remove)
function fakeStorage(init) {
  const data = { ...init };
  globalThis.chrome = { storage: { local: {
    get: async (k) => (k == null ? { ...data } : typeof k === "string" ? (k in data ? { [k]: data[k] } : {}) : {}),
    set: async (o) => { Object.assign(data, o); },
    remove: async (k) => { delete data[k]; },
  } } };
  return data;
}
module.exports = { fakeStorage };
