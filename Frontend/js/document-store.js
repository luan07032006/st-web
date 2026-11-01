"use strict";

// Durable document storage. Session storage is never the source of truth.
window.DocumentStore = (() => {
  const databaseName = "bangtrang-documents";
  let databasePromise;
  const syncTimers = new Map();
  const syncQueues = new Map();
  function newId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    // iPads opening a local HTTP address still have getRandomValues.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  const validId = id => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
  const event = detail => window.dispatchEvent(new CustomEvent("document-storage", { detail }));
  const metadata = record => Object.fromEntries(["documentId", "kind", "title", "createdAt", "updatedAt",
    "revision", "favorite", "thumbnail", "pendingSync"].map(key => [key, record[key]]));

  function open() {
    databasePromise ||= new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error("Trình duyệt chưa cho phép lưu tài liệu trên thiết bị.")); return; }
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("documents", { keyPath: "documentId" });
        db.createObjectStore("summaries", { keyPath: "documentId" });
        db.createObjectStore("settings");
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Hãy đóng tab Bảng Trắng cũ rồi mở lại để cập nhật lưu trữ."));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
    return databasePromise;
  }

  function transaction(db, names, mode) {
    try { return db.transaction(names, mode, { durability: "strict" }); }
    catch { return db.transaction(names, mode); }
  }

  async function read(store, key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store)[key === undefined ? "getAll" : "get"](key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function setting(key, value) {
    if (arguments.length === 1) return read("settings", key);
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = transaction(db, "settings", "readwrite");
      tx.objectStore("settings").put(value, key);
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("Không lưu được thiết lập."));
    });
  }

  function check(record) {
    if (!record || !validId(record.documentId) || record.version !== 1 || !Array.isArray(record.objects)
      || record.objects.length > 5000 || !["notebook", "whiteboard"].includes(record.kind)
      || typeof record.title !== "string" || record.title.length > 200
      || !Number.isSafeInteger(record.revision) || record.revision < 1
      || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) {
      throw new Error("Tài liệu không đúng định dạng.");
    }
    return record;
  }

  async function install(record) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = transaction(db, ["documents", "summaries"], "readwrite");
      tx.objectStore("documents").put(record);
      tx.objectStore("summaries").put(metadata(record));
      tx.oncomplete = () => resolve(record);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("Không lưu được tài liệu."));
    });
  }

  async function save(input) {
    // Capture before awaiting: a later stroke/tab switch cannot mutate this write.
    const record = structuredClone(input);
    check({ ...record, revision: Math.max(1, record.revision || 0) });
    const db = await open();
    const saved = await new Promise((resolve, reject) => {
      let failure;
      const tx = transaction(db, ["documents", "summaries"], "readwrite");
      const documents = tx.objectStore("documents");
      const request = documents.get(record.documentId);
      request.onsuccess = () => {
        try {
          record.revision = Math.max(request.result?.revision || 0, record.revision || 0) + 1;
          record.pendingSync = true;
          record.workspaceMode = record.kind;
          delete record.alternateWorkspace;
          delete record.sessionId;
          check(record);
          documents.put(record);
          tx.objectStore("summaries").put(metadata(record));
        } catch (error) { failure = error;tx.abort(); }
      };
      tx.oncomplete = () => resolve(record);
      tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error("Không lưu được tài liệu. Hãy sao lưu trước khi đóng app."));
    });
    event({ id: saved.documentId, revision: saved.revision, status: "local" });
    scheduleSync(saved.documentId);
    return saved;
  }

  async function fetchJSON(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let response;
    try { response = await fetch(url, { cache: "no-store", signal: controller.signal, ...options }); }
    finally { clearTimeout(timeout); }
    if (!response.ok) {
      const error = new Error(response.status === 409 ? "Có bản lưu mới hơn trên máy chủ. Bản thiết bị vẫn được giữ nguyên." : "Chưa kết nối được máy chủ local.");
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  function scheduleSync(id) {
    clearTimeout(syncTimers.get(id));
    syncTimers.set(id, setTimeout(() => {
      syncTimers.delete(id);
      sync(id).catch(() => {});
    }, 300));
  }

  function sync(id) {
    clearTimeout(syncTimers.get(id));
    syncTimers.delete(id);
    const queue = (syncQueues.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      const record = await read("documents", id);
      if (!record?.pendingSync) return true;
      const { pendingSync, ...payload } = record;
      try {
        await fetchJSON(`/api/documents/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const db = await open();
        await new Promise((resolve, reject) => {
          const tx = transaction(db, ["documents", "summaries"], "readwrite");
          const request = tx.objectStore("documents").get(id);
          request.onsuccess = () => {
            const current = request.result;
            if (current?.revision === record.revision) {
              current.pendingSync = false;
              tx.objectStore("documents").put(current);
              tx.objectStore("summaries").put(metadata(current));
            }
          };
          tx.oncomplete = resolve;
          tx.onabort = tx.onerror = () => reject(tx.error);
        });
        event({ id, revision: record.revision, status: "server" });
        return true;
      } catch (error) {
        event({ id, revision: record.revision, status: "offline", message: error.message });
        return false;
      }
    });
    syncQueues.set(id, queue);
    queue.finally(() => { if (syncQueues.get(id) === queue) syncQueues.delete(id); }).catch(() => {});
    return queue;
  }

  async function get(id) {
    if (!validId(id)) throw new Error("Mã tài liệu không hợp lệ.");
    const [record, summary] = await Promise.all([read("documents", id), read("summaries", id)]);
    if (record && (record.pendingSync || record.revision >= (summary?.revision || 0))) return record;
    try {
      const remote = check(await fetchJSON(`/api/documents/${id}`));
      remote.pendingSync = false;
      return await install(remote);
    } catch (error) {
      if (record) return record;
      throw new Error(error.status === 404 ? "Tài liệu này không còn tồn tại." : "Cần kết nối máy chủ local để tải tài liệu này lần đầu.");
    }
  }

  async function refresh() {
    const remote = await fetchJSON("/api/documents");
    if (!Array.isArray(remote)) throw new Error("Máy chủ chưa hỗ trợ thư viện tài liệu. Bản thiết bị vẫn được lưu.");
    const local = new Map((await read("summaries")).map(item => [item.documentId, item]));
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = transaction(db, "summaries", "readwrite");
      for (const summary of remote) {
        if (!validId(summary.documentId) || !["notebook", "whiteboard"].includes(summary.kind)) continue;
        const current = local.get(summary.documentId);
        if (!current || (!current.pendingSync && summary.revision > current.revision)) {
          tx.objectStore("summaries").put({ ...metadata(summary), pendingSync: false });
        }
      }
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    return read("summaries");
  }

  function blank(kind, title) {
    const now = Date.now();
    return { version: 1, documentId: newId(), kind, workspaceMode: kind,
      title: title?.trim().slice(0, 200) || (kind === "whiteboard" ? "Bảng viết chưa đặt tên" : "Sổ ghi chép chưa đặt tên"),
      objects: [], view: { x: 0, y: 0, z: 1, fit: kind === "notebook" },
      background: kind === "whiteboard" ? "dots" : "grid", theme: "light",
      paper: { format: kind === "whiteboard" ? "infinite" : "a4", pages: 1, color: kind === "whiteboard" ? "#ffffff" : "#faf8e8" },
      createdAt: now, updatedAt: now, revision: 0, favorite: false, thumbnail: "" };
  }

  async function create(kind, title) {
    if (!["notebook", "whiteboard"].includes(kind)) throw new Error("Chọn bảng viết hoặc sổ ghi chép.");
    navigator.storage?.persist?.().catch(() => {});
    return save(blank(kind, title));
  }

  async function migrate() {
    if (await setting("legacy-imported")) return;
    let legacy;
    for (const [storage, key] of [[sessionStorage, "bangtrang-session-v1"], [localStorage, "bangtrang-v1"]]) {
      try { const data = JSON.parse(storage.getItem(key)); if (data?.version === 1 && data.objects?.length) { legacy = data; break; } } catch { /* Try the server copy. */ }
    }
    if (!legacy) {
      try { legacy = await fetchJSON("/api/lesson"); }
      catch (error) { if (error.status === 404) await setting("legacy-imported", true); return; }
    }
    if (legacy?.version !== 1 || !Array.isArray(legacy.objects)) return;
    const mode = legacy.workspaceMode === "whiteboard" ? "whiteboard" : "notebook";
    const candidates = [{ mode, document: legacy }, legacy.alternateWorkspace];
    for (const item of candidates) {
      if (!item?.document?.objects?.length || !["notebook", "whiteboard"].includes(item.mode)) continue;
      const record = { ...blank(item.mode, item.document.title), ...item.document, kind: item.mode, revision: 0 };
      const source = JSON.stringify({ mode: item.mode, objects: item.document.objects,
        title: item.document.title, paper: item.document.paper, background: item.document.background });
      // Stable migration identity, including on local HTTP without SubtleCrypto.
      const hashes = [2166136261, 2246822507, 3266489909, 668265263];
      for (let i = 0; i < source.length; i++) {
        for (let index = 0; index < hashes.length; index++) hashes[index] = Math.imul(hashes[index] ^ source.charCodeAt(i), 16777619 + index * 2);
      }
      const hex = hashes.map(value => (value >>> 0).toString(16).padStart(8, "0")).join("");
      record.documentId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      // A second browser can find the same migration instead of duplicating old lessons.
      try { await get(record.documentId);continue; } catch { /* Import the available legacy copy. */ }
      await save(record);
    }
    await setting("legacy-imported", true);
  }

  async function syncPending() {
    const records = await read("summaries");
    await Promise.allSettled(records.filter(record => record.pendingSync).map(record => sync(record.documentId)));
  }
  window.addEventListener("online", () => { syncPending().catch(() => {}); });
  return { open, get, save, create, list: () => read("summaries"), setting, refresh, migrate, sync, syncPending, check,
    async patch(id, fields) { return save({ ...await get(id), ...fields, documentId: id, updatedAt: Date.now() }); },
    async delete(id) {
      if (!validId(id)) throw new Error("Mã tài liệu không hợp lệ.");
      const db = await open();
      await new Promise((resolve, reject) => {
        const tx = transaction(db, ["documents", "summaries"], "readwrite");
        tx.objectStore("documents").delete(id);
        tx.objectStore("summaries").delete(id);
        tx.oncomplete = resolve;
        tx.onabort = tx.onerror = () => reject(tx.error || new Error("Không xóa được tài liệu."));
      });
      try {
        const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE", cache: "no-store" });
        if (!response.ok && response.status !== 404) {
          // Ignore server-side delete errors; the local deletion already succeeded.
        }
      } catch {
        // Ignore server availability issues. The document stays deleted locally.
      }
      event({ id, status: "deleted" });
      return true;
    },
    async backup() {
      const documents = await Promise.all((await read("summaries")).map(item => get(item.documentId)));
      return { format: "bangtrang-library", version: 1, exportedAt: Date.now(), documents };
    },
    async restore(archive) {
      if (archive?.format !== "bangtrang-library" || archive.version !== 1 || !Array.isArray(archive.documents) || archive.documents.length > 5000) throw new Error("Bản sao lưu không hợp lệ.");
      archive.documents.forEach(check);
      // Restore as new documents so existing edits are never overwritten.
      for (const record of archive.documents) await save({ ...record, documentId: newId(), revision: 0, createdAt: Date.now(), updatedAt: Date.now() });
      return archive.documents.length;
    } };
})();
