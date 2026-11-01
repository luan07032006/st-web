"use strict";
window.DocumentUI = (() => {
  const paths = {
    library: '<path d="M4 3v18M8 4h5v16H8Zm8-1 5 1-3 16-5-1Z"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    list: '<path d="M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01"/>',
    sort: '<path d="M3 6h16M3 12h11M3 18h6m9-7v10m-3-3 3 3 3-3"/>',
    pen: '<path d="m15 3 6 6-10 10-8 2 2-8ZM13 5l6 6M3 21l5-5"/>',
    plus: '<path d="M12 4v16M4 12h16"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>', arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
    settings: '<path d="m9 3 1-2h4l1 2 3 2 3 1v4l-2 2v3l2 2-2 4h-4l-2 2h-3l-2-2H4l-2-4 2-2v-3l-2-2V6l3-1Z" transform="translate(1 1) scale(.9)"/><circle cx="12" cy="12" r="3"/>',
    star: '<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3L2.8 9.7l6.4-.9Z"/>',
    notebook: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 3v18M2 7h4m-4 5h4m-4 5h4m6-9h5m-5 4h5"/>',
    board: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8m-4-3v3M7 9h10M7 13h6"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M3 16v5h18v-5"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M3 16v5h18v-5"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2m-8 0 1 12h8l1-12"/>',
    check: '<path d="m5 12 4 4L19 6"/>', more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    home: '<path d="m3 10 9-7 9 7v11h-7v-7h-4v7H3Z"/>',
    rename: '<path d="m14 3 7 7-10 10-8 1 1-8ZM12 5l7 7M3 21l5-5"/>',
  };
  const icon = name => `<svg class="library-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.notebook}</svg>`;
  function decorate(root = document) {
    root.querySelectorAll("[data-library-icon]").forEach(node => { node.innerHTML = icon(node.dataset.libraryIcon); });
    root.querySelectorAll("[data-close-dialog]").forEach(button => { button.onclick = () => button.closest("dialog").close(); });
  }
  function downloadJSON(data, name) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    const link = document.createElement("a");link.href = url;link.download = name;link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function setupNew(onCreate) {
    if (!document.getElementById("newDocumentDialog")) {
      const dialog = document.createElement("dialog");
      dialog.id = "newDocumentDialog";dialog.className = "library-dialog";
      dialog.setAttribute("aria-labelledby", "newDocumentTitle");
      dialog.innerHTML = '<div class="library-dialog-heading"><h2 id="newDocumentTitle">Bạn muốn tạo gì?</h2><button type="button" class="icon-button" data-close-dialog aria-label="Đóng"><span data-library-icon="close"></span></button></div><label class="document-name-label" for="newDocumentName">Tên tài liệu</label><input class="document-name-input" id="newDocumentName" maxlength="200" placeholder="Đặt tên hoặc để trống…"><div class="new-document-choices"><button type="button" data-create-kind="notebook"><span class="choice-art choice-notebook" data-library-icon="notebook"></span><strong>Sổ ghi chép</strong><span>Trang A4, có lề và nhiều kiểu giấy.</span><span class="choice-link">Tạo sổ <span data-library-icon="arrow"></span></span></button><button type="button" data-create-kind="whiteboard"><span class="choice-art choice-board" data-library-icon="board"></span><strong>Bảng viết</strong><span>Không gian rộng mở, thu phóng tự do.</span><span class="choice-link">Tạo bảng <span data-library-icon="arrow"></span></span></button></div><p id="newDocumentStatus" class="dialog-status" role="status"></p>';
      document.body.append(dialog);
    }
    const dialog = document.getElementById("newDocumentDialog");
    const status = document.getElementById("newDocumentStatus");
    decorate(dialog);
    dialog.querySelectorAll("[data-create-kind]").forEach(button => {
      button.onclick = async () => {
        dialog.querySelectorAll("button").forEach(item => { item.disabled = true; });
        status.textContent = "Đang tạo tài liệu…";
        try {
          const record = await DocumentStore.create(button.dataset.createKind, document.getElementById("newDocumentName").value);
          dialog.close();
          await onCreate(record);
        } catch (error) { status.textContent = error.message || "Không tạo được tài liệu."; }
        finally { dialog.querySelectorAll("button").forEach(item => { item.disabled = false; }); }
      };
    });
    return () => { document.getElementById("newDocumentName").value = "";status.textContent = "";dialog.showModal(); };
  }
  return { icon, decorate, setupNew, downloadJSON };
})();
