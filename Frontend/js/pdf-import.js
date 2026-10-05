// Render PDF pages into the board so its drawing and lesson-saving tools apply.
(() => {
  const libraryRoot = new URL("./vendor/pdfjs/", document.currentScript.src);
  let libraryPromise;
  let importing = false;

  const dialog = document.createElement("dialog");
  dialog.className = "pdf-import-dialog";
  dialog.innerHTML = '<h2>Mở tài liệu PDF</h2><p role="status" aria-live="polite"></p><progress max="1" value="0" aria-label="Tiến độ mở PDF"></progress><button type="button">Hủy</button>';
  document.body.append(dialog);
  const status = dialog.querySelector("p");
  const progress = dialog.querySelector("progress");

  async function open(file) {
    if (importing) { toast("Đang mở một PDF. Hãy đợi hoặc nhấn Hủy."); return; }
    if (file.size > 50 * 1024 * 1024) { toast("Chọn PDF không quá 50 MB."); return; }
    importing = true;
    const importRevision = fileImportRevision;
    let cancelled = false;
    let loadingTask;
    let renderTask;
    const cancel = () => {
      cancelled = true;
      renderTask?.cancel();
      loadingTask?.destroy().catch(() => {});
      dialog.close();
    };
    dialog.querySelector("button").onclick = cancel;
    dialog.oncancel = event => { event.preventDefault(); cancel(); };
    status.textContent = "Đang đọc PDF…";
    progress.value = 0;
    dialog.showModal();
    try {
      libraryPromise ||= import(new URL("build/pdf.js", libraryRoot).href).catch(error => {
        libraryPromise = null;
        console.error("Không tải được thư viện PDF.js", error);
        throw new Error("Không tải được bộ đọc PDF. Hãy tải lại trang bằng Ctrl + F5 rồi thử lại.");
      });
      const pdfjs = await libraryPromise;
      if (cancelled) return;
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("build/pdf.worker.js", libraryRoot).href;
      const data = new Uint8Array(await file.arrayBuffer());
      if (cancelled) return;
      loadingTask = pdfjs.getDocument({
        data,
        cMapUrl: new URL("cmaps/", libraryRoot).href,
        cMapPacked: true,
        standardFontDataUrl: new URL("standard_fonts/", libraryRoot).href,
        wasmUrl: new URL("wasm/", libraryRoot).href,
        isEvalSupported: false,
      });
      if (cancelled) return;
      const pdf = await loadingTask.promise;
      if (pdf.numPages > 50) throw new Error("PDF tối đa 50 trang. Hãy tách tài liệu thành các phần nhỏ hơn.");
      if (objects.length + pdf.numPages > 5000) throw new Error("Bảng đã có quá nhiều đối tượng. Hãy mở PDF trên bảng mới.");
      const origin = { x: 0, y: 16 };
      const pageWidth = 1000;
      const pages = [];
      let y = origin.y;
      let bytes = 1024;
      for (let number = 1; number <= pdf.numPages; number++) {
        if (cancelled) return;
        status.textContent = `${file.name} · Đang mở trang ${number}/${pdf.numPages}`;
        const page = await pdf.getPage(number);
        const size = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 1800 / Math.max(size.width, size.height)) });
        const surface = document.createElement("canvas");
        surface.width = Math.ceil(viewport.width);
        surface.height = Math.ceil(viewport.height);
        renderTask = page.render({ canvasContext: surface.getContext("2d"), viewport, background: "rgb(255,255,255)" });
        await renderTask.promise;
        renderTask = null;
        if (cancelled) return;
        const src = surface.toDataURL("image/jpeg", 0.94);
        bytes += src.length + 512;
        if (bytes > 24 * 1024 * 1024) throw new Error("PDF sau khi mở quá lớn để lưu. Hãy tách tài liệu thành các phần nhỏ hơn.");
        const height = pageWidth * size.height / size.width;
        pages.push({ type: "image", src, x: origin.x, y, w: pageWidth, h: height,
          pdfPage: number, pdfBackground: true, name: file.name });
        y += height + 28;
        surface.width = surface.height = 0;
        page.cleanup();
        progress.value = number / pdf.numPages;
      }
      if (cancelled) return;
      // Commit only after every page succeeds and the board has not been cleared.
      if (importRevision !== fileImportRevision) return;
      snapshot();
      fileImportRevision++;
      objects = pages;
      view = { x: 0, y: 0, z: 1, fit: false };
      selected = -1;
      selection = null;
      changed();
      chooseTool("pen");
      toast(`Đã mở ${pages.length} trang PDF. Dùng bút để chữa bài, cuộn chuột để xem các trang tiếp theo. Hoàn tác để trở về bảng trước đó.`);
    } catch (error) {
      if (!cancelled) toast(error.name === "PasswordException"
        ? "PDF được bảo vệ bằng mật khẩu. Hãy mở khóa tài liệu trước khi chèn."
        : error.name === "InvalidPDFException" ? "PDF bị hỏng hoặc không đúng định dạng."
        : error.message || "Không mở được PDF. Hãy thử lại.");
    } finally {
      if (loadingTask) await loadingTask.destroy().catch(() => {});
      dialog.close();
      importing = false;
    }
  }

  window.boardPDF = { open };
})();
