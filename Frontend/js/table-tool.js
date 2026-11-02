/* Editable canvas tables share the document's history, exports and durable storage. */
(() => {
  const dialog = $("tableDialog");
  const rowsInput = $("tableRows");
  const columnsInput = $("tableColumns");
  const headerInput = $("tableHeader");
  let editing = null;
  let draft = [];

  function dimensions() {
    return rowsInput.validity.valid && columnsInput.validity.valid
      ? { rows: Number(rowsInput.value), columns: Number(columnsInput.value) } : null;
  }

  function preview() {
    const size = dimensions();
    if (!size) return;
    const body = document.createElement("tbody");
    for (let row = 0; row < size.rows; row++) {
      const tr = document.createElement("tr");
      if (row === 0 && headerInput.checked) tr.className = "table-header-row";
      for (let column = 0; column < size.columns; column++) {
        const td = document.createElement("td");
        const input = document.createElement("textarea");
        input.rows = 1;
        input.maxLength = 2000;
        input.value = draft[row]?.[column] || "";
        input.setAttribute("aria-label", `Hàng ${row + 1}, cột ${column + 1}`);
        input.placeholder = row === 0 && headerInput.checked ? `Tiêu đề ${column + 1}` : "";
        input.oninput = () => { (draft[row] ||= [])[column] = input.value; };
        td.append(input);
        tr.append(td);
      }
      body.append(tr);
    }
    $("tablePreview").replaceChildren(body);
    $("tablePreview").style.minWidth = `${size.columns * 120}px`;
    $("tableSummary").textContent = `${size.rows} hàng × ${size.columns} cột`;
  }

  function open(existing = null) {
    if (!window.documentWorkspace?.ready || dragging) return;
    editing = existing && objects.includes(existing) ? existing : null;
    draft = editing ? structuredClone(editing.cells) : [];
    rowsInput.value = editing?.rows || 4;
    columnsInput.value = editing?.columns || 3;
    headerInput.checked = editing?.header ?? true;
    $("tableTitle").textContent = editing ? "Sửa bảng" : "Tạo bảng";
    $("insertTable").textContent = editing ? "Lưu thay đổi" : "Chèn bảng";
    preview();
    dialog.showModal();
    rowsInput.focus();
    rowsInput.select();
  }

  function syncSelection() {
    $("editTableBtn").hidden = tool !== "select" || objects[selected]?.type !== "table";
  }

  $("tableBtn").onclick = () => open();
  $("editTableBtn").onclick = () => open(objects[selected]);
  $("closeTable").onclick = $("cancelTable").onclick = () => dialog.close();
  dialog.addEventListener("close", () => { editing = null;draft = []; });
  rowsInput.oninput = columnsInput.oninput = headerInput.onchange = preview;
  $("tableForm").onsubmit = event => {
    event.preventDefault();
    if (!$("tableForm").reportValidity()) return;
    const { rows, columns } = dimensions();
    const cells = Array.from({ length: rows }, (_, r) =>
      Array.from({ length: columns }, (_, c) => draft[r]?.[c] || ""));
    snapshot();
    if (editing && objects.includes(editing)) {
      // Resizing the grid preserves existing outer dimensions and cell contents.
      Object.assign(editing, { rows, columns, cells, header: headerInput.checked });
      selected = objects.indexOf(editing);
    } else {
      const w = Math.min(648, Math.max(240, columns * 108));
      const h = rows * 48;
      const center = world({ x: boardW / 2, y: boardH / 2 });
      const page = pageAt(center) || visiblePages()[0];
      let x = center.x - w / 2, y = center.y - h / 2;
      if (page && !page.infinite) {
        x = Math.max(page.x + 16, Math.min(page.x + page.w - w - 16, x));
        y = Math.max(page.y + 16, Math.min(page.y + page.h - h - 16, y));
      }
      objects.push({ type: "table", x, y, w, h, rows, columns, cells,
        header: headerInput.checked, color: "#344a60", width: 1 });
      selected = objects.length - 1;
    }
    selection = null;
    active = null;
    chooseTool("select");
    dialog.close();
    changed();
    toast("Đã lưu bảng. Kéo để di chuyển, kéo góc để đổi kích thước; chọn Sửa bảng để nhập nội dung.");
  };

  function paint(context, object) {
    const { x, y, w, h, rows, columns, cells, header } = object;
    const cw = w / columns, ch = h / rows;
    const fontSize = Math.min(18, ch * .38, cw * .25);
    const padding = Math.min(10, cw * .12, ch * .18);
    context.fillStyle = "#ffffff";
    context.fillRect(x, y, w, h);
    if (header) {
      context.fillStyle = "#e8f0f8";
      context.fillRect(x, y, w, ch);
    }
    context.strokeStyle = object.color || "#344a60";
    context.lineWidth = Math.min(object.width || 1, cw * .05, ch * .05);
    context.lineCap = "butt";
    context.beginPath();
    for (let r = 0; r <= rows; r++) {
      context.moveTo(x, y + r * ch);context.lineTo(x + w, y + r * ch);
    }
    for (let c = 0; c <= columns; c++) {
      context.moveTo(x + c * cw, y);context.lineTo(x + c * cw, y + h);
    }
    context.stroke();
    context.textBaseline = "top";
    context.fillStyle = object.color || "#344a60";
    const lineHeight = fontSize * 1.35;
    const maxLines = Math.max(1, Math.floor((ch - padding * 2) / lineHeight));
    for (let r = 0; r < rows; r++) {
      context.font = `${header && r === 0 ? "600 " : ""}${fontSize}px -apple-system, Segoe UI, Arial, sans-serif`;
      for (let c = 0; c < columns; c++) {
        const text = cells[r][c];
        if (!text) continue;
        const left = x + c * cw + padding, top = y + r * ch + padding;
        context.save();
        context.beginPath();context.rect(left, top, cw - padding * 2, ch - padding * 2);context.clip();
        // Wrap by code point, including scripts without spaces, and stop below the cell.
        let line = "", lineIndex = 0;
        for (const char of text.replace(/\r/g, "")) {
          if (char === "\n" || (line && context.measureText(line + char).width > cw - padding * 2)) {
            context.fillText(line, left, top + lineIndex * lineHeight);
            line = "";
            if (++lineIndex >= maxLines) break;
          }
          if (char !== "\n") line += char;
        }
        if (lineIndex < maxLines) context.fillText(line, left, top + lineIndex * lineHeight);
        context.restore();
      }
    }
  }

  window.BoardTables = { open, paint, syncSelection };
})();
