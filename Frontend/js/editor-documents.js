"use strict";
(() => {
  const metadata = new Map();
  const histories = new Map();
  let openIds = [], activeRecord = null, localSequence = 0, latestWrite = Promise.resolve(true);
  let navigation = Promise.resolve(), latestRevision = 0;
  const indicator = document.createElement("span");
  indicator.className = "document-save-indicator";indicator.setAttribute("role", "status");
  indicator.textContent = "Đang mở tài liệu…";$("workspace").append(indicator);

  function status(message) { $("saveStatus").textContent = indicator.textContent = message; }
  function rememberTabs() { return DocumentStore.setting("open-tabs", { ids: openIds, activeId: activeRecord?.documentId }); }
  function renderTabs() {
    $("documentTabs").replaceChildren();
    for (const id of openIds) {
      const item = metadata.get(id);if (!item) continue;
      const selected = id === activeRecord?.documentId;
      const tab = document.createElement("span");tab.className = "document-tab";tab.dataset.documentId = id;
      const button = document.createElement("button");button.type = "button";button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(selected));button.setAttribute("aria-controls", "workspace");
      button.setAttribute("aria-label", `${item.kind === "whiteboard" ? "Bảng viết" : "Sổ ghi chép"}: ${item.title}`);
      button.tabIndex = selected ? 0 : -1;button.title = item.title;
      button.innerHTML = `${DocumentUI.icon(item.kind === "whiteboard" ? "board" : "notebook")}<span></span>`;
      button.querySelector("span").textContent = item.title;button.onclick = () => navigate(id);
      const close = document.createElement("button");close.type = "button";close.className = "close-document-tab";
      close.setAttribute("aria-label", `Đóng tab ${item.title}`);close.title = "Đóng tab · Tài liệu vẫn được lưu";
      close.innerHTML = DocumentUI.icon("close");close.onclick = () => closeTab(id);
      tab.append(button, close);$("documentTabs").append(tab);
      if (selected) requestAnimationFrame(() => button.scrollIntoView({ block: "nearest", inline: "nearest" }));
    }
  }

  function captureThumbnail() {
    if (!boardW || !boardH) return activeRecord?.thumbnail || "";
    const image = document.createElement("canvas");
    const scale = Math.min(1, 520 / boardW, 360 / boardH);
    image.width = Math.max(1, Math.round(boardW * scale));image.height = Math.max(1, Math.round(boardH * scale));
    image.getContext("2d").drawImage(canvas, 0, 0, image.width, image.height);
    return image.toDataURL("image/jpeg", .6);
  }

  function save({ thumbnail = false } = {}) {
    if (!controller.ready || restoringLesson || !activeRecord) return Promise.resolve(false);
    const id = activeRecord.documentId;
    const sequence = ++localSequence;
    const data = { ...activeRecord, ...currentDocumentData(), documentId: id, kind: workspaceMode,
      workspaceMode, title: $("lessonName").value.trim().slice(0, 200) || (isWhiteboard() ? "Bảng viết chưa đặt tên" : "Sổ ghi chép chưa đặt tên"), updatedAt: Date.now() };
    if (thumbnail) data.thumbnail = captureThumbnail();
    const titleChanged = metadata.get(id)?.title !== data.title;
    metadata.set(id, data);
    if (titleChanged) renderTabs();
    status("Đang lưu tài liệu…");
    latestWrite = DocumentStore.save(data).then(record => {
      if (activeRecord?.documentId === id && sequence === localSequence) {
        activeRecord = record;latestRevision = record.revision;
        metadata.set(id, record);
        document.title = `${record.title} • Bảng Trắng`;
        status("Đã lưu trên thiết bị");
      }
      return true;
    }).catch(error => {
      if (activeRecord?.documentId === id) status(`Chưa lưu được · ${error.message}`);
      return false;
    });
    return latestWrite;
  }

  function finishEditing() {
    if (start?.groupMove) finishGroupMove();
    else if (dragging && start) finish();
    clearBoardInteraction();
  }
  async function flush() {
    if (!activeRecord || !controller.ready) return;
    finishEditing();clearTimeout(saveTimer);draw();
    if (!await save({ thumbnail: true })) throw new Error("Chưa lưu được tài liệu. Hãy giữ tab này mở và kiểm tra dung lượng thiết bị.");
    await rememberTabs();
    DocumentStore.sync(activeRecord.documentId).catch(() => {});
  }

  async function activate(id, { initial = false } = {}) {
    if (id === activeRecord?.documentId && controller.ready) return;
    if (!initial && activeRecord) {
      await flush();histories.set(activeRecord.documentId, { undo: undoStack, redo: redoStack });
    }
    const record = await DocumentStore.get(id);
    validateDoc(record);
    controller.ready = false;restoringLesson = true;$("workspace").setAttribute("aria-busy", "true");
    try {
      clearBoardInteraction();
      applyDoc(record);
      undoStack = histories.get(id)?.undo || [];redoStack = histories.get(id)?.redo || [];
      activeRecord = record;latestRevision = record.revision;
      metadata.set(id, record);
      if (!openIds.includes(id)) openIds.push(id);
      $("lessonName").value = record.title;
      document.title = `${record.title} • Bảng Trắng`;
      renderTabs();syncWorkspaceUI();resize();
    } finally { restoringLesson = false;controller.ready = true;$("workspace").setAttribute("aria-busy", "false"); }
    status(record.pendingSync ? "Đã lưu trên thiết bị · Chờ máy chủ local" : "Đã lưu trên thiết bị & máy chủ local");
    await rememberTabs();
    if (record.pendingSync) DocumentStore.sync(id).catch(() => {});
    const url = new URL(location.href);url.searchParams.set("document", id);history.replaceState(null, "", url);
  }
  function navigate(id) {
    navigation = navigation.catch(() => {}).then(() => activate(id)).catch(error => { toast(error.message);status(error.message); });
    return navigation;
  }
  async function closeTab(id) {
    navigation = navigation.catch(() => {}).then(async () => {
      if (id === activeRecord?.documentId) {
        await flush();
        const index = openIds.indexOf(id);
        const target = openIds[index + 1] || openIds[index - 1];
        if (!target) { await DocumentStore.setting("open-tabs", { ids: [], activeId: null });location.href = "./index.html";return; }
        await activate(target);
      }
      openIds = openIds.filter(item => item !== id);histories.delete(id);renderTabs();await rememberTabs();
    }).catch(error => toast(error.message));
    return navigation;
  }

  const controller = window.documentWorkspace = { ready: false, save, flush, open: navigate,
    get activeId() { return activeRecord?.documentId; },
    async openKind(kind) {
      if (!["notebook", "whiteboard"].includes(kind)) return;
      const existing = [...metadata.values()].filter(item => item.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const record = existing || await DocumentStore.create(kind);
      metadata.set(record.documentId, record);
      return navigate(record.documentId);
    } };
  const openNew = DocumentUI.setupNew(record => { metadata.set(record.documentId, record);return navigate(record.documentId); });
  $("newDocumentTab").onclick = openNew;
  $("libraryHome").onclick = async event => {
    event.preventDefault();
    try { await navigation;await flush();location.href = "./index.html"; }
    catch (error) { toast(error.message); }
  };
  $("documentTabs").onkeydown = event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !event.target.matches('[role="tab"]')) return;
    event.preventDefault();
    const index = openIds.indexOf(activeRecord?.documentId);
    const next = event.key === "Home" ? 0 : event.key === "End" ? openIds.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + openIds.length) % openIds.length;
    navigate(openIds[next]).then(() => $("documentTabs").querySelector('[aria-selected="true"]')?.focus());
  };
  window.addEventListener("document-storage", event => {
    const detail = event.detail;
    if (detail.id !== activeRecord?.documentId || detail.revision < latestRevision) return;
    if (detail.status === "server") { activeRecord.pendingSync = false;status("Đã lưu trên thiết bị & máy chủ local"); }
    else if (detail.status === "offline") status("Đã lưu trên thiết bị · Chờ máy chủ local");
  });
  const saveOnLeave = () => { if (controller.ready && activeRecord) { finishEditing();clearTimeout(saveTimer);save(); } };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveOnLeave(); });
  window.addEventListener("pagehide", saveOnLeave);
  window.addEventListener("pageshow", event => { if (event.persisted) { resize();DocumentStore.syncPending().catch(() => {}); } });

  window.documentReady = (async () => {
    try {
      await DocumentStore.open();
      for (const record of await DocumentStore.list()) metadata.set(record.documentId, record);
      const tabs = await DocumentStore.setting("open-tabs");
      openIds = Array.isArray(tabs?.ids) ? tabs.ids.filter(id => metadata.has(id)) : [];
      let id = new URLSearchParams(location.search).get("document");
      if (!id) { const record = await DocumentStore.create("notebook");id = record.documentId;metadata.set(id, record); }
      await activate(id, { initial: true });
      return true;
    } catch (error) {
      status(error.message);toast(`${error.message} · Nhấn biểu tượng B để về tài liệu.`);
      $("workspace").setAttribute("aria-busy", "false");
      $("libraryHome").onclick = () => {};
      return false;
    }
  })();
})();
