"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const { icon, downloadJSON } = DocumentUI;
  let documents = [], filter = "all", kindFilter = "all", renameId = null, toastTimer, serverAvailable = false, lastActiveId = null;
  DocumentUI.decorate();
  function toast(message) { $("libraryToast").textContent = message;$("libraryToast").classList.add("show");clearTimeout(toastTimer);toastTimer = setTimeout(() => $("libraryToast").classList.remove("show"), 3500); }
  const open = id => { window.location.href = `./editor.html?document=${encodeURIComponent(id)}`; };
  const openNew = DocumentUI.setupNew(record => open(record.documentId));
  function showNew(kind = null) {
    openNew();
    document.querySelectorAll("[data-create-kind]").forEach(button => button.classList.toggle("is-suggested", button.dataset.createKind === kind));
    if (kind) document.querySelector(`[data-create-kind="${kind}"]`).focus();
  }
  $("newDocument").onclick = $("createFirst").onclick = () => showNew();
  document.querySelectorAll("[data-quick-kind]").forEach(button => { button.onclick = () => showNew(button.dataset.quickKind); });

  function closeMenus() { document.querySelectorAll(".document-menu").forEach(menu => { menu.hidden = true;menu.previousElementSibling?.setAttribute("aria-expanded", "false"); }); }
  document.addEventListener("click", event => { if (!event.target.closest(".document-menu-button,.document-menu")) closeMenus(); });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      const expanded = document.querySelector('.document-menu-button[aria-expanded="true"]');
      closeMenus();expanded?.focus();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !document.querySelector("dialog[open]")) {
      event.preventDefault();$("searchDocuments").focus();
    }
  });

  function shortDate(value) {
    const date = new Date(value), now = new Date(), yesterday = new Date();
    yesterday.setDate(now.getDate() - 1);
    const time = date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    if (date.toDateString() === now.toDateString()) return `Hôm nay, ${time}`;
    if (date.toDateString() === yesterday.toDateString()) return `Hôm qua, ${time}`;
    return date.toLocaleDateString("vi-VN", { day: "numeric", month: "short", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
  }

  function render() {
    const query = $("searchDocuments").value.trim().toLocaleLowerCase("vi");
    const visible = documents.filter(record => (filter !== "favorite" || record.favorite)
      && (kindFilter === "all" || record.kind === kindFilter) && record.title.toLocaleLowerCase("vi").includes(query));
    const sort = $("sortDocuments").value;
    visible.sort((a, b) => sort === "title" ? a.title.localeCompare(b.title, "vi") : b[sort === "created" ? "createdAt" : "updatedAt"] - a[sort === "created" ? "createdAt" : "updatedAt"]);
    $("documentCount").textContent = documents.length;
    $("sidebarDocumentCount").textContent = documents.length;
    $("favoriteCount").textContent = documents.filter(record => record.favorite).length;
    $("sectionDocumentCount").textContent = visible.length;
    $("librarySectionTitle").firstChild.textContent = filter === "favorite" ? "Tài liệu yêu thích " : "Tất cả tài liệu ";
    $("libraryResultLabel").textContent = `${visible.length} tài liệu`;
    $("libraryEmpty").hidden = documents.length !== 0;
    $("noSearchResults").hidden = documents.length === 0 || visible.length > 0;
    $("noSearchResults").textContent = filter === "favorite" && !query ? "Đánh dấu sao trên bìa để giữ những tài liệu yêu thích ở đây." : "Không tìm thấy tài liệu phù hợp.";
    $("closeSearch").disabled = !query;
    const recent = documents.find(record => record.documentId === lastActiveId)
      || documents.reduce((latest, record) => !latest || record.updatedAt > latest.updatedAt ? record : latest, null);
    $("resumeDocument").hidden = !recent || filter !== "all" || kindFilter !== "all" || Boolean(query);
    if (recent) {
      $("resumeDocumentTitle").textContent = recent.title;
      $("resumeIcon").innerHTML = icon(recent.kind === "whiteboard" ? "board" : "notebook");
      $("resumeDocument").onclick = () => open(recent.documentId);
      $("resumeDocument").setAttribute("aria-label", `Tiếp tục viết: ${recent.title}`);
    }
    $("documentGrid").replaceChildren();
    const palettes = [
      { cover: "#49685b", surface: "#e9efe5", ink: "#f6f8ef" },
      { cover: "#596b83", surface: "#eaf0f3", ink: "#fafbf5" },
      { cover: "#d8c7a5", surface: "#f2efe5", ink: "#524834" },
      { cover: "#826779", surface: "#f0eaf0", ink: "#fbf6f4" },
      { cover: "#986454", surface: "#f4ede6", ink: "#fff9f3" },
      { cover: "#5c7273", surface: "#e8efeb", ink: "#f5f9f4" },
    ];
    for (const record of visible) {
      const card = document.createElement("article");card.className = `document-card${record.kind === "whiteboard" ? " is-whiteboard" : ""}`;card.dataset.documentId = record.documentId;
      const button = document.createElement("button");button.type = "button";button.className = "document-open";button.setAttribute("aria-label", `Mở ${record.title}`);
      const board = record.kind === "whiteboard";
      const typeName = board ? "Bảng viết" : "Sổ ghi chép";
      button.title = record.title;
      button.innerHTML = `<span class="cover-stage" aria-hidden="true"><span class="cover-category">${icon(board ? "board" : "notebook")}${typeName}</span><span class="document-cover ${board ? "whiteboard-cover" : "notebook-cover"}"><span class="cover-type">${board ? "BẢNG VIẾT" : "SỔ GHI CHÉP"}</span>${board ? "" : '<span class="cover-rule"></span>'}<span class="cover-name"></span><span class="cover-stamp">B.</span><span class="cover-art"></span></span></span><span class="document-info"><span class="document-kind">${icon(board ? "board" : "notebook")}<span>${typeName}</span></span><span class="document-title"></span><span class="document-date"></span></span>`;
      const palette = palettes[parseInt(record.documentId.slice(0, 4), 16) % palettes.length];
      card.style.setProperty("--cover-color", palette.cover);
      card.style.setProperty("--cover-surface", board ? "#eef1e6" : palette.surface);
      card.style.setProperty("--cover-ink", palette.ink);
      button.querySelector(".cover-name").textContent = record.title;
      button.querySelector(".document-title").textContent = record.title;
      button.querySelector(".document-date").textContent = shortDate(record.updatedAt);
      button.querySelector(".document-date").title = new Date(record.updatedAt).toLocaleString("vi-VN");
      if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(record.thumbnail || "")) {
        const image = document.createElement("img");image.className = "cover-thumbnail";image.src = record.thumbnail;image.alt = "";image.loading = "lazy";
        button.querySelector(".document-cover").append(image);
      }
      button.onclick = () => open(record.documentId);
      const favorite = document.createElement("button");favorite.type = "button";favorite.className = "favorite-button";
      favorite.innerHTML = icon("star");favorite.setAttribute("aria-label", `${record.favorite ? "Bỏ yêu thích" : "Yêu thích"}: ${record.title}`);favorite.setAttribute("aria-pressed", String(Boolean(record.favorite)));
      favorite.onclick = async () => {
        favorite.disabled = true;
        try { await DocumentStore.patch(record.documentId, { favorite: !record.favorite });await reload(); }
        catch (error) { toast(error.message);favorite.disabled = false; }
      };
      const menuButton = document.createElement("button");menuButton.type = "button";menuButton.className = "document-menu-button";menuButton.innerHTML = icon("more");menuButton.setAttribute("aria-label", `Tùy chọn: ${record.title}`);menuButton.setAttribute("aria-expanded", "false");
      const menu = document.createElement("div");menu.className = "document-menu";menu.hidden = true;
      const rename = document.createElement("button");rename.type = "button";rename.innerHTML = `${icon("rename")}Đổi tên`;
      rename.onclick = () => { closeMenus();renameId = record.documentId;$("renameInput").value = record.title;$("renameStatus").textContent = "";$("renameDialog").showModal();$("renameInput").select(); };
      const backup = document.createElement("button");backup.type = "button";backup.innerHTML = `${icon("download")}Sao lưu tài liệu`;
      backup.onclick = async () => { closeMenus();try { downloadJSON({ format: "bangtrang-library", version: 1, exportedAt: Date.now(), documents: [await DocumentStore.get(record.documentId)] }, "bang-trang-tai-lieu.json"); } catch (error) { toast(error.message); } };
      const remove = document.createElement("button");remove.type = "button";remove.innerHTML = `${icon("trash")}Xóa tài liệu`;
      remove.onclick = async () => {
        closeMenus();
        if (!window.confirm(`Bạn có chắc muốn xóa tài liệu "${record.title}"?`)) return;
        try {
          await DocumentStore.delete(record.documentId);
          await reload();
          toast("Đã xóa tài liệu.");
        } catch (error) {
          toast(error.message);
        }
      };
      menu.append(rename, backup, remove);
      menuButton.onclick = () => {
        const show = menu.hidden;closeMenus();
        const left = card.getBoundingClientRect().left < innerWidth / 2;
        menu.style.left = left ? "8px" : "auto";menu.style.right = left ? "auto" : "8px";
        menu.hidden = !show;menuButton.setAttribute("aria-expanded", String(show));if (show) rename.focus();
      };
      card.append(button, favorite, menuButton, menu);$("documentGrid").append(card);
    }
  }
  async function reload() {
    const [records, tabs] = await Promise.all([DocumentStore.list(), DocumentStore.setting("open-tabs")]);
    documents = records;lastActiveId = tabs?.activeId || null;render();
  }
  $("sortDocuments").onchange = render;
  document.querySelectorAll("[data-filter]").forEach(button => { button.onclick = () => {
    filter = button.dataset.filter;kindFilter = "all";
    document.querySelectorAll("[data-filter]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
    document.querySelectorAll("[data-kind-filter]").forEach(item => item.setAttribute("aria-pressed", String(item.dataset.kindFilter === "all")));
    render();
  }; });
  document.querySelectorAll("[data-kind-filter]").forEach(button => { button.onclick = () => {
    kindFilter = button.dataset.kindFilter;
    document.querySelectorAll("[data-kind-filter]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
    render();
  }; });
  document.querySelectorAll("[data-library-view]").forEach(button => { button.onclick = () => {
    $("libraryMain").dataset.view = button.dataset.libraryView;
    document.querySelectorAll("[data-library-view]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
  }; });
  $("searchDocuments").oninput = render;
  $("closeSearch").onclick = () => { $("searchDocuments").value = "";render();$("searchDocuments").focus(); };
  $("renameForm").onsubmit = async event => {
    event.preventDefault();const title = $("renameInput").value.trim();if (!title) return;
    try { await DocumentStore.patch(renameId, { title });$("renameDialog").close();await reload(); }
    catch (error) { $("renameStatus").textContent = error.message; }
  };
  $("storageSettings").onclick = () => $("storageDialog").showModal();
  $("backupLibrary").onclick = async () => { $("backupLibrary").disabled = true;$("storageStatus").textContent = "Đang chuẩn bị bản sao lưu…";try { downloadJSON(await DocumentStore.backup(), `bang-trang-sao-luu-${new Date().toISOString().slice(0, 10)}.json`);$("storageStatus").textContent = "Đã tải bản sao lưu. Tệp này giữ được nét viết để chỉnh sửa tiếp."; } catch (error) { $("storageStatus").textContent = error.message; } finally { $("backupLibrary").disabled = false; } };
  $("restoreLibrary").onclick = () => $("restoreLibraryInput").click();
  $("restoreLibraryInput").onchange = async event => {
    const file = event.target.files[0];if (!file) return;
    try { if (file.size > 256 * 1024 * 1024) throw new Error("Hãy chọn bản sao lưu nhỏ hơn 256 MB.");const count = await DocumentStore.restore(JSON.parse(await file.text()));await reload();$("storageStatus").textContent = `Đã khôi phục ${count} tài liệu thành bản mới.`; }
    catch (error) { $("storageStatus").textContent = error.message; }
    finally { event.target.value = ""; }
  };
  async function updateStorageStatus() {
    const pending = (await DocumentStore.list()).some(record => record.pendingSync);
    $("libraryStatus").textContent = pending ? "Đã lưu trên thiết bị · Chờ máy chủ local"
      : serverAvailable ? "Đã lưu trên thiết bị & máy chủ local" : "Đã lưu trên thiết bị";
  }
  window.addEventListener("document-storage", event => {
    if (event.detail.status === "server") serverAvailable = true;
    updateStorageStatus().catch(() => {});
  });
  window.addEventListener("pageshow", () => { reload().catch(() => {}); });
  (async () => {
    try {
      await DocumentStore.open();await reload();
      $("libraryStatus").textContent = "Đã lưu trên thiết bị";
      await DocumentStore.migrate();await reload();
      try { await DocumentStore.refresh();await reload();serverAvailable = true;await updateStorageStatus(); }
      catch { $("libraryStatus").textContent = "Đã lưu trên thiết bị · Chờ máy chủ local"; }
      DocumentStore.syncPending().catch(() => {});
    } catch (error) { $("libraryStatus").textContent = error.message;$("newDocument").disabled = $("createFirst").disabled = true; }
  })();
})();
