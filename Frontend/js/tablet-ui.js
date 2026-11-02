"use strict";

// Keep the existing controls and their handlers; only arrange their tablet presentation.
(() => {
  const paths = {
    board: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8m-4-3v3M7 9h10M7 13h6"/>',
    notebook: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 3v18M2 7h4m-4 5h4m-4 5h4m6-9h5m-5 4h5"/>',
    pen: '<path d="m14 4 6 6-9 9-7 1 1-7ZM13 5l6 6M5 14l5 5m-6 1 4-4M16 2l6 6"/>',
    select: '<path d="m5 3 14 10-7 1-3 7ZM13 15l5 6"/>',
    moveLasso: '<path d="M17 5C13 1 3 3 3 10s7 10 13 6c4-3 4-7 1-9" stroke-dasharray="3 3"/><path d="m13 12 8 4-4 1-2 4Z"/>',
    hand: '<path d="M7 12V7a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v7-5a2 2 0 0 1 4 0v6-2a2 2 0 0 1 4 0v6c0 4-3 6-7 6h-2c-2 0-3-1-4-2l-5-6a2 2 0 0 1 3-3l2 2" transform="translate(-2 -1)"/>',
    eraser: '<path d="m14 3 7 7-11 11H6l-4-4ZM8 11l7 7M10 21h11"/>',
    erase: '<path d="m14 3 7 7-11 11H6l-4-4ZM8 11l7 7M10 21h11"/>',
    highlight: '<path d="m14 3 7 7-9 9-7-7ZM5 12l-2 6 3 3 6-2M2 22h12"/>',
    text: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 8V6h10v2m-5-2v12m-3 0h6"/>',
    lasso: '<path d="M19 7C15 1 4 4 4 10s7 8 12 5c4-3 4-7 0-8-4-1-7 3-4 6 3 4-1 7-5 6"/><path d="m17 2 1-1m3 4h1m-1 4 1 1"/>',
    aiRegion: '<path d="M8 3H4a1 1 0 0 0-1 1v4m13-5h4a1 1 0 0 1 1 1v4M3 16v4a1 1 0 0 0 1 1h4m8 0h4a1 1 0 0 0 1-1v-4m-9-9 1.5 3.5L17 12l-3.5 1.5L12 17l-1.5-3.5L7 12l3.5-1.5Z"/>',
    sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4M3 18v4m-2-2h4"/>',
    export: '<path d="M12 15V2m-4 4 4-4 4 4M5 10H3v11h18V10h-2"/>',
    expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    fit: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><rect x="7" y="7" width="10" height="10" rx="1"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
    table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18m6-18v18"/>',
    shapes: '<path d="m7 2 5 8H2Z"/><rect x="3" y="14" width="8" height="8" rx="1"/><circle cx="18" cy="17" r="5"/><path d="M17 3h5v7h-5Z"/>',
    formula: '<path d="M19 4h-7l-3 16H4m2-10h10m-1 5 6 6m0-6-6 6"/>',
    'file-x': '<path d="M14 2H5v20h14V7ZM14 2v6h5M8 12l6 6m0-6-6 6"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    gesture: '<path d="m4 9-2-3 4-3m-4 3h7m11 9 2 3-4 3m4-3h-7M9 15V7a2 2 0 0 1 4 0v6l2-2 4 3-1 6h-7l-5-5a2 2 0 0 1 3-2"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    undo: '<path d="m8 4-5 5 5 5M3 9h10a6 6 0 0 1 0 12h-2"/>',
    redo: '<path d="m16 4 5 5-5 5m5-5H11a6 6 0 0 0 0 12h2"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    swap: '<path d="M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4"/>',
    'pencil-settings': '<path d="M4 7h8m4 0h4M4 17h3m4 0h9"/><circle cx="14" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    line: '<path d="M3 21 21 3"/>',
    circle: '<circle cx="12" cy="12" r="9"/>',
    rectangle: '<rect x="2" y="5" width="20" height="14" rx="1"/>',
    square: '<rect x="3" y="3" width="18" height="18" rx="1"/>',
    rightTriangle: '<path d="M3 3v18h18ZM3 17h4v4"/>',
    triangle: '<path d="M12 3 2 21h20Z"/>',
    trapezoid: '<path d="M7 5h10l5 14H2Z"/>',
    cone: '<path d="m3 18 9-16 9 16M3 18c0-5 18-5 18 0s-18 5-18 0Z"/>',
    tetrahedron: '<path d="m12 2 10 17-14 3-6-7ZM12 2 8 22m-6-7 20 4"/>',
    quadrilateralPyramid: '<path d="m12 2 10 15-9 5-11-5ZM12 2l1 20m-11-5 9-4 11 4m-10-15-1 11"/>',
    cube: '<path d="m12 2 10 5v10l-10 5-10-5V7ZM2 7l10 5 10-5M12 12v10M7 4l10 5v10"/>',
    cuboid: '<path d="m8 3 14 4v13l-14 1-6-5V7ZM2 7l6 4 14-4M8 11v10M8 3v8"/>',
    cylinder: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 4 18 4 18 0V5"/><path d="M3 18c0 4 18 4 18 0"/>',
    ruler: '<path d="m2 16 14-14 6 6-14 14Zm4-4 3 3m1-7 3 3m1-7 3 3"/>',
    protractor: '<path d="M2 20a10 10 0 0 1 20 0ZM12 10v3M5 13l2 2m12-2-2 2M2 20h20"/><path d="M8 20a4 4 0 0 1 8 0"/>',
  };
  paths.isoscelesTriangle = paths.equilateralTriangle = paths.triangle;
  const icon = name => `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.shapes}</svg>`;
  document.querySelectorAll("[data-icon]").forEach(element => { element.innerHTML = icon(element.dataset.icon); });
  const captions = { pen: "Bút viết", select: "Chọn", moveLasso: "Lasso", hand: "Di chuyển", eraser: "Tẩy",
    highlight: "Tô sáng", text: "Văn bản", lasso: "Nắn nét", aiRegion: "Khoanh AI" };
  document.querySelectorAll("#toolButtons button").forEach(button => {
    button.innerHTML = `${icon(button.dataset.tool)}<span class="tool-caption">${captions[button.dataset.tool]}</span>`;
  });
  $("historySlot").append(document.querySelector(".history"));
  $("undoBtn").innerHTML = icon("undo");
  $("redoBtn").innerHTML = icon("redo");
  $("penSlot").append(document.querySelector(".pen-options"));
  document.querySelector(".pen-settings").remove();
  $("pageSlot").append(document.querySelector(".paper-controls"));
  $("paperSettingsBtn").innerHTML = `${icon("notebook")}<span>Kiểu giấy</span>`;
  $("paperSettingsBtn").setAttribute("aria-label", "Chọn kiểu giấy và xem các trang");
  $("addPageBtn").innerHTML = `${icon("plus")}<span>Thêm trang</span>`;
  $("addPageBtn").setAttribute("aria-label", "Thêm trang A4");
  $("themeToggle").setAttribute("aria-label", "Giao diện sáng");
  document.querySelector(".header-actions").insertBefore($("themeToggle"), $("focusBtn"));

  document.querySelectorAll("#colors button").forEach(button => {
    button.style.setProperty("--swatch", button.dataset.color);
    button.style.background = "";
    const labels = { "#24304a": "Mực đen", "#245bea": "Mực xanh", "#e65967": "Mực đỏ", "#f0b43c": "Mực vàng", "#42a987": "Mực xanh lá" };
    button.setAttribute("aria-label", labels[button.dataset.color] || `Màu ${button.dataset.color}`);
    button.setAttribute("aria-pressed", String(button.classList.contains("active")));
  });
  document.querySelectorAll("[data-pen-size]").forEach(button => {
    button.onclick = () => {
      penSize = Number(button.dataset.penSize);
      document.querySelectorAll("[data-pen-size]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
    };
  });

  const geometry = document.querySelector(".geometry-grid");
  $("shapesContent").append(geometry);
  geometry.querySelectorAll("button").forEach(button => {
    button.querySelector("b").innerHTML = icon(button.dataset.tool);
    button.addEventListener("click", () => {
      $("shapesDialog").close();
      $("shapesBtn").setAttribute("aria-label", `Hình học: ${button.textContent.trim()}`);
    });
  });
  $("shapesBtn").onclick = () => $("shapesDialog").showModal();
  $("closeShapes").onclick = () => $("shapesDialog").close();
  $("shapesDialog").onclick = event => {
    if (event.target !== $("shapesDialog")) return;
    const rect = event.target.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
  };
  $("formulaQuickBtn").onclick = () => $("formulaBtn").click();
  $("closeSidebar").onclick = () => {
    if (!document.body.classList.contains("sidebar-collapsed")) $("toggleSidebar").click();
    $("toggleSidebar").focus();
  };
  document.querySelector(".workspace-tabs").onkeydown = event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const mode = event.key === "Home" ? "whiteboard" : event.key === "End" ? "notebook"
      : workspaceMode === "whiteboard" ? "notebook" : "whiteboard";
    setWorkspaceMode(mode);
    document.querySelector(`[data-workspace="${mode}"]`).focus();
  };
  // Moving controls changes the available height at compact widths.
  const chromeObserver = new ResizeObserver(() => resize());
  chromeObserver.observe(document.querySelector(".top-chrome"));
  syncWorkspaceUI();
  resize();
})();
