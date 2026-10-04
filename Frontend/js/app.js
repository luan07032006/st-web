"use strict";

// =====================================================
// 1. KHỞI TẠO
// =====================================================

const $ = (id) => document.getElementById(id);
const canvas = $("board");
const ctx = canvas.getContext("2d");
const paperSurround = getComputedStyle(document.documentElement).getPropertyValue("--paper-surround").trim();

const tools = [
  ["pen", "✎", "Bút vẽ", "B"],
  ["select", "↖", "Chọn / di chuyển đối tượng", "S"],
  ["moveLasso", "", "Lasso · Khoanh vùng di chuyển", "V"],
  ["hand", "✥", "Di chuyển bảng", "H"],
  ["eraser", "▱", "Tẩy đối tượng", "E"],
  ["highlight", "▰", "Bút tô sáng", "M"],
  ["text", "T", "Văn bản", "T"],
  ["lasso", "⌁", "Khoanh vùng nắn nét", "L"],
  ["aiRegion", "✧", "Khoanh vùng giải toán bằng AI", "A"],
];

let objects = [];
let undoStack = [];
let redoStack = [];

let view = { x: 0, y: 0, z: 1, fit: true };
// A4 at 96 dpi. Only visible pages are drawn; the canvas stays viewport-sized.
const paper = { w: 794, h: 794 * 297 / 210, top: 60, gap: 28, margin: 0 };
const paperTemplates = [
  { id: "plain", name: "Giấy trơn" },
  { id: "dots", name: "Giấy chấm" },
  { id: "lined", name: "Kẻ ngang hẹp" },
  { id: "wide", name: "Kẻ ngang rộng" },
  { id: "grid", name: "Ô vuông" },
  { id: "margin", name: "Kẻ ngang có lề" },
];
let paperColor = "#faf8e8";
let paperBackground = "grid";
let paperPageCount = 1;
let boardScrollDrag = null;
const touchPointers = new Map();
let paperGesture = null;

let tool = "pen";
let eraserMode = "stroke";
let color = "#245bea";
let width = 2;
let handwritingScale = 0.7;

let active = null;
let start = null;
let dragging = false;
let selection = null;
let selected = -1;
let lassoMode = "freeform";
let lassoPath = null;
let groupSelection = [];
let groupRegion = null;
let groupDetached = false;
let resizeHandle = null;
let space = false;
let eraserCursor = null;

let formulaMode = false;
let textAt = null;
let editingText = null;

let boardW = 0;
let boardH = 0;

let toastTimer;
let saveTimer;
let saveQueue = Promise.resolve();
let saveRevision = 0;
let restoringLesson = false;
let fileImportRevision = 0;
const sessionLessonKey = "bangtrang-session-v1";
let boardSessionId = crypto.randomUUID();
try {
  boardSessionId = sessionStorage.getItem("qh-board-session") || boardSessionId;
  sessionStorage.setItem("qh-board-session", boardSessionId);
} catch { /* Keep a fresh board when browser storage is unavailable. */ }

const images = new Map();
const expressionCache = new Map();

// =====================================================
// 2. THÔNG BÁO VÀ THANH CÔNG CỤ
// =====================================================

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    $("toast").classList.remove("show");
  }, 3200);
}

function chooseTool(value, { preserveSelection = false, preserveLassoMode = false } = {}) {
  const newLasso = value === "moveLasso" && !preserveSelection;
  if (tool === "moveLasso" && (value !== tool || newLasso)) {
    if (start?.groupMove) finishGroupMove(true);
    dragging = false;
    start = null;
    clearGroupSelection();
  }
  if (newLasso) {
    clearGroupSelection();
    if (!preserveLassoMode) lassoMode = "freeform";
    document.querySelectorAll("[data-lasso-mode]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.lassoMode === lassoMode));
    });
  }
  tool = value;
  if (value !== "eraser") eraserCursor = null;

  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === value);
    button.setAttribute("aria-pressed", String(button.dataset.tool === value));
  });

  const names = {
    ...Object.fromEntries(tools.map((item) => [item[0], item[2]])),
    line: "Đường thẳng",
    circle: "Đường tròn",
    rectangle: "Hình chữ nhật",
    square: "Hình vuông",
    rightTriangle: "Tam giác vuông",
    isoscelesTriangle: "Tam giác cân",
    equilateralTriangle: "Tam giác đều",
    trapezoid: "Hình thang",
    triangle: "Tam giác",
    cone: "Hình nón",
    tetrahedron: "Hình tứ diện đều",
    quadrilateralPyramid: "Chóp đáy tứ giác",
    cube: "Hình lập phương",
    cuboid: "Hình hộp chữ nhật",
    cylinder: "Hình trụ",
    ruler: "Thước thẳng",
    protractor: "Thước đo góc",
  };

  let instruction = "Kéo trên bảng để thao tác";

  if (value === "select") {
    instruction = "Kéo để di chuyển đối tượng";
  } else if (value === "moveLasso") {
    selected = -1;
    selection = null;
    instruction = lassoMode === "freeform"
      ? "Giữ chuột hoặc bút để tự vẽ đường khoanh · Thả để chọn, rồi kéo bên trong để di chuyển · V để khoanh vùng mới"
      : "Kéo tạo vùng chữ nhật · Thả để chọn, rồi kéo bên trong để di chuyển · V để khoanh tự do";
  } else if (value === "eraser") {
    instruction = eraserMode === "object"
      ? "Kéo qua đối tượng để xóa toàn bộ"
      : "Kéo qua nét để xóa một phần";
  } else if (value === "text") {
    instruction = "Nhấn vào bảng để chèn chữ";
  } else if (value === "aiRegion") {
    instruction = "Kéo khoanh bài toán rồi thả để AI giải vùng đã chọn";
  } else if (value === "lasso") {
    instruction = "Khoanh trọn các nét rồi thả để nắn đường thẳng, đường cong và đa giác";
  }

  $("toolStatus").textContent = `${names[value]} · ${instruction}`;
  $("eraserOptions").hidden = value !== "eraser";
  $("lassoOptions").hidden = value !== "moveLasso";

  canvas.style.cursor =
    value === "hand"
      ? "grab"
      : value === "select"
        ? "default"
        : value === "text"
          ? "text"
          : value === "eraser"
            ? "none"
          : "crosshair";
  if (boardW) draw();
}

for (const [value, icon, name, key] of tools) {
  const button = document.createElement("button");

  button.dataset.tool = value;
  button.title = `${name} (${key})`;
  button.setAttribute("aria-label", name);
  button.textContent = icon;
  button.setAttribute("aria-pressed", "false");
  if (value === "moveLasso") {
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 4C10 1 3 4 3 10s5 9 11 7c5-1 6-7 2-10" stroke-dasharray="3 3"/><path d="m12 11 9 4-4 2-2 4z"/></svg>';
  }

  $("toolButtons").append(button);
}

document.querySelectorAll("[data-tool]").forEach((button) => {
  button.onclick = () => chooseTool(button.dataset.tool);
});

document.querySelectorAll("[data-lasso-mode]").forEach(button => {
  button.onclick = () => {
    lassoMode = button.dataset.lassoMode;
    chooseTool("moveLasso", { preserveLassoMode: true });
  };
});

document.querySelectorAll("[data-eraser-mode]").forEach((button) => {
  button.onclick = () => {
    eraserMode = button.dataset.eraserMode;
    document.querySelectorAll("[data-eraser-mode]").forEach((option) => {
      option.setAttribute(
        "aria-pressed",
        String(option.dataset.eraserMode === eraserMode),
      );
    });
    chooseTool("eraser");
  };
});

const palette = [
  "#24304a",
  "#245bea",
  "#e65967",
  "#f0b43c",
  "#42a987",
];

for (const value of palette) {
  const button = document.createElement("button");

  button.style.background = value;
  button.dataset.color = value;
  button.setAttribute("aria-label", `Chọn màu ${value}`);
  button.onclick = () => setColor(value);

  $("colors").append(button);
}

function setColor(value) {
  color = value;
  $("customColor").value = value;

  document.querySelectorAll("[data-color]").forEach((button) => {
    button.classList.toggle("active", button.dataset.color === value);
  });
}

$("customColor").oninput = (event) => {
  setColor(event.target.value);
};

function updateStrokeWidth(value) {
  const slider = $("strokeWidth");
  width = Math.max(Number(slider.min), Math.min(Number(slider.max), Number(value)));
  slider.value = String(width);
  $("widthValue").textContent = `${width} px`;
  $("decreaseStrokeWidth").disabled = width <= Number(slider.min);
  $("increaseStrokeWidth").disabled = width >= Number(slider.max);
}

$("strokeWidth").oninput = (event) => updateStrokeWidth(event.target.value);
$("decreaseStrokeWidth").onclick = () => updateStrokeWidth(width - 1);
$("increaseStrokeWidth").onclick = () => updateStrokeWidth(width + 1);
updateStrokeWidth($("strokeWidth").value);

try {
  const saved = Number(localStorage.getItem("bangtrang-handwriting-scale"));
  if (saved >= 0.4 && saved <= 1) handwritingScale = saved;
} catch { /* Browser storage may be unavailable. */ }
$("handwritingScale").value = String(Math.round(handwritingScale * 100));
$("handwritingScale").onchange = (event) => {
  handwritingScale = Number(event.target.value) / 100;
  try {
    localStorage.setItem("bangtrang-handwriting-scale", String(handwritingScale));
  } catch { /* Keep the setting for this session. */ }
};

setColor(color);
chooseTool("pen");

// =====================================================
// 3. LƯU TRỮ VÀ HOÀN TÁC
// =====================================================

function snapshot() {
  undoStack.push(boardSnapshot());

  if (undoStack.length > 50) {
    undoStack.shift();
  }

  redoStack = [];
}

function boardSnapshot() {
  return JSON.stringify({ objects, paperPageCount, view,
    background: paperBackground, paperColor });
}

function restoreBoardSnapshot(serialized) {
  clearGroupSelection();
  const state = JSON.parse(serialized);
  objects = state.objects;
  paperPageCount = state.paperPageCount;
  view = state.view;
  if (state.background) paperBackground = state.background;
  if (state.paperColor) paperColor = state.paperColor;
}

function changed() {
  if (!pdfDocumentPages().length) objects.forEach(fitObjectOnPaper);
  draw();

  $("saveStatus").textContent = "Đang lưu trên máy chủ…";

  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLesson, 600);
}

function lessonData() {
  return {
      version: 1,
      sessionId: boardSessionId,
      objects,
      view,
      title: $("lessonName").value,
      background: paperBackground,
      theme: document.body.dataset.theme || "light",
      paper: { format: "a4", pages: paperPageCount, color: paperColor },
  };
}

async function saveLesson() {
  if (restoringLesson) return false;

  const revision = ++saveRevision;
  const serialized = JSON.stringify(lessonData());
  let cached = false;
  try {
    sessionStorage.setItem("qh-board-started", boardSessionId);
    sessionStorage.setItem(sessionLessonKey, serialized);
    cached = true;
  } catch {
    // A failed quota write must not leave an older session cache to restore.
    try { sessionStorage.removeItem(sessionLessonKey); } catch { /* Storage unavailable. */ }
  }
  saveQueue = saveQueue.catch(() => false).then(async () => {
    try {
      const response = await fetch("/api/lesson", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: serialized,
      });

      if (!response.ok) throw new Error("Server save failed");

      if (revision === saveRevision) {
        const time = new Date().toLocaleTimeString("vi-VN", {
          hour: "2-digit",
          minute: "2-digit",
        });
        $("saveStatus").textContent = `Đã lưu trên máy chủ · ${time}`;
      }
      return true;
    } catch {
      if (revision === saveRevision) {
        $("saveStatus").textContent = cached
          ? "Máy chủ chưa sẵn sàng · Đã lưu trong phiên đăng nhập này"
          : "Không thể lưu · Hãy tải bài giảng PDF về";
      }
      return false;
    }
  });

  return saveQueue;
}

function undo() {
  if (start?.groupMove) finishGroupMove(true);
  if (tool === "moveLasso") { dragging = false; start = null; }
  if (!undoStack.length) return;

  redoStack.push(boardSnapshot());
  restoreBoardSnapshot(undoStack.pop());

  selected = -1;
  changed();
}

function redo() {
  if (start?.groupMove) finishGroupMove(true);
  if (tool === "moveLasso") { dragging = false; start = null; }
  if (!redoStack.length) return;

  undoStack.push(boardSnapshot());
  restoreBoardSnapshot(redoStack.pop());

  selected = -1;
  changed();
}

$("undoBtn").onclick = undo;
$("redoBtn").onclick = redo;
$("lessonName").onchange = saveLesson;

// =====================================================
// 4. TỌA ĐỘ VÀ KÍCH THƯỚC CANVAS
// =====================================================

function screenPoint(event) {
  const rect = canvas.getBoundingClientRect();

  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function world(point) {
  return {
    x: (point.x - view.x) / view.z,
    y: (point.y - view.y) / view.z,
  };
}

function handwritingPoint(event) {
  const point = world(screenPoint(event));
  const scale = start.handwritingScale;

  // Shrink only this stroke's movement, anchored where the pen touched down.
  // Tool interactions and the starting position always use real coordinates.
  return clampToPage({
    x: start.x + (point.x - start.x) * scale,
    y: start.y + (point.y - start.y) * scale,
  });
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  boardW = rect.width;
  boardH = rect.height;

  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);

  draw();
}

new ResizeObserver(resize).observe($("workspace"));

// =====================================================
// 5. VẼ CÁC ĐỐI TƯỢNG
// =====================================================

function pathPolygon(context, points, close = true) {
  context.beginPath();

  points.forEach((point, index) => {
    if (index === 0) {
      context.moveTo(point.x, point.y);
    } else {
      context.lineTo(point.x, point.y);
    }
  });

  if (close) context.closePath();

  context.stroke();
}

function shapeVertices(object) {
  const left = Math.min(object.x, object.x + object.w);
  const top = Math.min(object.y, object.y + object.h);
  const right = Math.max(object.x, object.x + object.w);
  const bottom = Math.max(object.y, object.y + object.h);
  const width = right - left;
  const height = bottom - top;
  const middle = left + width / 2;

  switch (object.type) {
    case "line":
      return [
        { x: object.x, y: object.y },
        { x: object.x + object.w, y: object.y + object.h },
      ];
    case "circle":
      return [
        { x: middle, y: top },
        { x: right, y: top + height / 2 },
        { x: middle, y: bottom },
        { x: left, y: top + height / 2 },
      ];
    case "cone":
      return [
        { x: middle, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
      ];
    case "cylinder":
    case "ruler":
      return [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
      ];
    case "protractor":
      return null;
    case "rectangle":
      return [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
      ];
    case "square": {
      const side = Math.min(width, height);
      const squareLeft = left + (width - side) / 2;
      const squareTop = top + (height - side) / 2;
      return [
        { x: squareLeft, y: squareTop },
        { x: squareLeft + side, y: squareTop },
        { x: squareLeft + side, y: squareTop + side },
        { x: squareLeft, y: squareTop + side },
      ];
    }
    case "rightTriangle":
      return [
        { x: left, y: top },
        { x: right, y: top },
        { x: left, y: bottom },
      ];
    case "isoscelesTriangle":
    case "triangle":
      return [
        { x: middle, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
      ];
    case "equilateralTriangle": {
      const side = Math.min(width, height * 2 / Math.sqrt(3));
      const triangleHeight = side * Math.sqrt(3) / 2;
      const triangleLeft = middle - side / 2;
      const triangleTop = bottom - triangleHeight;
      return [
        { x: middle, y: triangleTop },
        { x: triangleLeft + side, y: bottom },
        { x: triangleLeft, y: bottom },
      ];
    }
    case "trapezoid":
      return [
        { x: left + width * 0.18, y: top },
        { x: left + width * 0.82, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
      ];
    case "tetrahedron":
      return [
        { x: middle, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
        { x: middle, y: top + height * 0.55 },
      ];
    case "quadrilateralPyramid":
      return [
        { x: middle, y: top + height * 0.04 },
        { x: middle, y: top + height * 0.4 },
        { x: left + width * 0.94, y: top + height * 0.58 },
        { x: middle, y: top + height * 0.82 },
        { x: left + width * 0.06, y: top + height * 0.58 },
      ];
    case "cube":
    case "cuboid": {
      const offset = Math.min(width, height) * 0.2;
      return [
        { x: left, y: top + offset },
        { x: right - offset, y: top + offset },
        { x: right - offset, y: bottom },
        { x: left, y: bottom },
        { x: left + offset, y: top },
        { x: right, y: top },
        { x: right, y: bottom - offset },
        { x: left + offset, y: bottom - offset },
      ];
    }
    default:
      return null;
  }
}

function paintCylinder(context, box) {
  const radiusX = Math.abs(box.w) / 2;
  const radiusY = Math.min(Math.abs(box.h) * 0.18, Math.abs(box.h) / 2);
  const centerX = box.x + box.w / 2;
  const upperRimY = box.y + radiusY;
  const lowerRimY = box.y + box.h - radiusY;

  context.beginPath();
  context.ellipse(centerX, upperRimY, radiusX, radiusY, 0, 0, Math.PI * 2);
  context.stroke();

  context.beginPath();
  context.moveTo(box.x, upperRimY);
  context.lineTo(box.x, lowerRimY);
  context.moveTo(box.x + box.w, upperRimY);
  context.lineTo(box.x + box.w, lowerRimY);
  context.stroke();

  context.save();
  context.setLineDash([6, 5]);
  context.beginPath();
  context.ellipse(centerX, lowerRimY, radiusX, radiusY, 0, Math.PI, Math.PI * 2);
  context.stroke();
  context.restore();

  context.beginPath();
  context.ellipse(centerX, lowerRimY, radiusX, radiusY, 0, 0, Math.PI);
  context.stroke();
}

function paintEditableGeometry(context, object) {
  const vertices = object.vertices;
  let edges;
  let hiddenEdges = [];

  if (object.type === "line") {
    pathPolygon(context, vertices, false);
    return;
  }

  if (object.type === "circle") {
    const box = bounds(object);
    context.beginPath();
    context.ellipse(
      box.x + box.w / 2,
      box.y + box.h / 2,
      box.w / 2,
      box.h / 2,
      0,
      0,
      Math.PI * 2,
    );
    context.stroke();
    return;
  }

  if (object.type === "cone") {
    const [apex, rightBase, leftBase] = vertices;
    const baseY = (rightBase.y + leftBase.y) / 2;
    const radiusY = Math.max(Math.abs(baseY - apex.y) * 0.16, 1);

    context.beginPath();
    context.moveTo(apex.x, apex.y);
    context.lineTo(rightBase.x, rightBase.y);
    context.moveTo(apex.x, apex.y);
    context.lineTo(leftBase.x, leftBase.y);
    context.stroke();

    context.save();
    context.setLineDash([6, 5]);
    context.beginPath();
    context.ellipse(
      (rightBase.x + leftBase.x) / 2,
      baseY,
      Math.abs(rightBase.x - leftBase.x) / 2,
      radiusY,
      0,
      Math.PI,
      Math.PI * 2,
    );
    context.stroke();
    context.restore();

    context.beginPath();
    context.ellipse(
      (rightBase.x + leftBase.x) / 2,
      baseY,
      Math.abs(rightBase.x - leftBase.x) / 2,
      radiusY,
      0,
      0,
      Math.PI,
    );
    context.stroke();
    return;
  }

  if (object.type === "cylinder") {
    paintCylinder(context, bounds(object));
    return;
  }

  if (object.type === "cube" || object.type === "cuboid") {
    edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    hiddenEdges = [[4, 7], [6, 7], [0, 4], [3, 7]];
  } else if (object.type === "quadrilateralPyramid") {
    edges = [
      [1, 2], [2, 3], [3, 4], [4, 1],
      [0, 1], [0, 2], [0, 3], [0, 4],
    ];
    hiddenEdges = [[0, 1], [1, 2], [4, 1]];
  } else if (object.type === "tetrahedron") {
    edges = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];
    hiddenEdges = [[0, 3], [1, 3], [2, 3]];
  }

  if (edges) {
    for (const [from, to] of edges) {
      const hidden = hiddenEdges.some(
        ([first, second]) =>
          (first === from && second === to) ||
          (first === to && second === from),
      );
      context.setLineDash(hidden ? [6, 5] : []);
      context.beginPath();
      context.moveTo(vertices[from].x, vertices[from].y);
      context.lineTo(vertices[to].x, vertices[to].y);
      context.stroke();
    }
    context.setLineDash([]);
  } else {
    pathPolygon(context, vertices);
  }
}

function paintObject(context, object) {
  context.save();
  for (const region of object.clipRegions || []) {
    traceLasso(context, region);
    context.clip("evenodd");
  }
  for (const region of object.cutouts || []) {
    context.beginPath();
    context.rect(-1e8, -1e8, 2e8, 2e8);
    traceLasso(context, region, false);
    context.clip("evenodd");
  }

  context.strokeStyle = object.color || "#245bea";
  context.fillStyle = object.color || "#24304a";
  context.lineWidth = object.width || 3;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (
    object.vertices &&
    object.type !== "ruler" &&
    object.type !== "protractor"
  ) {
    paintEditableGeometry(context, object);
    context.restore();
    return;
  }

  if (object.type === "pen" || object.type === "highlight") {
    context.globalAlpha = object.type === "highlight" ? 0.3 : 1;

    const points = object.points;

    if (points.length === 1) {
      context.beginPath();
      context.arc(
        points[0].x,
        points[0].y,
        object.width / 2,
        0,
        Math.PI * 2,
      );
      context.fill();
    }

    for (let i = 1; i < points.length; i++) {
      context.lineWidth =
        object.width *
        (object.type === "highlight" ? 6 : 1) *
        (points[i].p || 1);

      context.beginPath();
      context.moveTo(points[i - 1].x, points[i - 1].y);
      context.lineTo(points[i].x, points[i].y);
      context.stroke();
    }
  } else if (object.type === "line") {
    pathPolygon(
      context,
      [
        { x: object.x, y: object.y },
        {
          x: object.x + object.w,
          y: object.y + object.h,
        },
      ],
      false,
    );
  } else if (object.type === "rectangle") {
    context.strokeRect(object.x, object.y, object.w, object.h);
  } else if (object.type === "square") {
    const side = Math.min(Math.abs(object.w), Math.abs(object.h));
    const originX = object.x + (Math.abs(object.w) - side) / 2;
    const originY = object.y + (Math.abs(object.h) - side) / 2;
    context.strokeRect(originX, originY, side, side);
  } else if (object.type === "circle") {
    context.beginPath();

    context.ellipse(
      object.x + object.w / 2,
      object.y + object.h / 2,
      Math.abs(object.w / 2),
      Math.abs(object.h / 2),
      0,
      0,
      Math.PI * 2,
    );

    context.stroke();
  } else if (object.type === "triangle") {
    pathPolygon(context, [
      {
        x: object.x + object.w / 2,
        y: object.y,
      },
      {
        x: object.x + object.w,
        y: object.y + object.h,
      },
      {
        x: object.x,
        y: object.y + object.h,
      },
    ]);
  } else if (object.type === "rightTriangle") {
    pathPolygon(context, [
      { x: object.x, y: object.y },
      { x: object.x + object.w, y: object.y },
      { x: object.x, y: object.y + object.h },
    ]);
  } else if (object.type === "isoscelesTriangle") {
    pathPolygon(context, [
      { x: object.x + object.w / 2, y: object.y },
      { x: object.x + object.w, y: object.y + object.h },
      { x: object.x, y: object.y + object.h },
    ]);
  } else if (object.type === "equilateralTriangle") {
    const cx = object.x + object.w / 2;
    pathPolygon(context, [
      { x: cx, y: object.y },
      { x: object.x + object.w, y: object.y + object.h },
      { x: object.x, y: object.y + object.h },
    ]);
  } else if (object.type === "trapezoid") {
    pathPolygon(context, [
      { x: object.x + object.w * 0.18, y: object.y },
      { x: object.x + object.w * 0.82, y: object.y },
      { x: object.x + object.w, y: object.y + object.h },
      { x: object.x, y: object.y + object.h },
    ]);
  } else if (object.type === "cone") {
    context.beginPath();
    context.ellipse(
      object.x + object.w / 2,
      object.y + object.h,
      Math.abs(object.w / 2),
      Math.abs(object.h * 0.22),
      0,
      0,
      Math.PI * 2,
    );
    context.stroke();

    pathPolygon(context, [
      { x: object.x + object.w / 2, y: object.y },
      { x: object.x + object.w, y: object.y + object.h },
      { x: object.x, y: object.y + object.h },
    ]);
  } else if (object.type === "tetrahedron") {
    pathPolygon(context, [
      { x: object.x + object.w / 2, y: object.y },
      { x: object.x + object.w, y: object.y + object.h * 0.78 },
      { x: object.x + object.w / 2, y: object.y + object.h },
      { x: object.x, y: object.y + object.h * 0.78 },
    ]);

    context.beginPath();
    context.moveTo(object.x + object.w / 2, object.y);
    context.lineTo(object.x + object.w / 2, object.y + object.h);
    context.moveTo(object.x, object.y + object.h * 0.78);
    context.lineTo(object.x + object.w, object.y + object.h * 0.78);
    context.stroke();
  } else if (object.type === "cube") {
    const size = Math.min(Math.abs(object.w), Math.abs(object.h));
    const left = object.x + (Math.abs(object.w) - size) / 2;
    const top = object.y + (Math.abs(object.h) - size) / 2;
    const offset = Math.min(size * 0.28, 24);

    pathPolygon(context, [
      { x: left, y: top },
      { x: left + size, y: top },
      { x: left + size + offset, y: top + offset },
      { x: left + offset, y: top + offset },
    ]);

    pathPolygon(context, [
      { x: left + offset, y: top + offset },
      { x: left + size + offset, y: top + offset },
      { x: left + size + offset, y: top + size + offset },
      { x: left + offset, y: top + size + offset },
    ]);

    pathPolygon(context, [
      { x: left, y: top },
      { x: left + offset, y: top + offset },
      { x: left + offset, y: top + size + offset },
      { x: left, y: top + size },
    ]);

    context.beginPath();
    context.moveTo(left + size, top);
    context.lineTo(left + size + offset, top + offset);
    context.lineTo(left + size + offset, top + size + offset);
    context.lineTo(left + size, top + size);
    context.stroke();
  } else if (object.type === "cuboid") {
    const offset = Math.min(Math.abs(object.w) * 0.2, 26);
    const left = object.x;
    const top = object.y;

    pathPolygon(context, [
      { x: left, y: top },
      { x: left + object.w, y: top },
      { x: left + object.w + offset, y: top + offset },
      { x: left + offset, y: top + offset },
    ]);

    pathPolygon(context, [
      { x: left + offset, y: top + offset },
      { x: left + object.w + offset, y: top + offset },
      { x: left + object.w + offset, y: top + object.h + offset },
      { x: left + offset, y: top + object.h + offset },
    ]);

    pathPolygon(context, [
      { x: left, y: top },
      { x: left + offset, y: top + offset },
      { x: left + offset, y: top + object.h + offset },
      { x: left, y: top + object.h },
    ]);

    context.beginPath();
    context.moveTo(left + object.w, top);
    context.lineTo(left + object.w + offset, top + offset);
    context.lineTo(left + object.w + offset, top + object.h + offset);
    context.lineTo(left + object.w, top + object.h);
    context.stroke();
  } else if (object.type === "cylinder") {
    paintCylinder(context, bounds(object));
  } else if (object.type === "text") {
    const size = object.size || 24;
    const family = object.formula ? "Georgia" : "Segoe UI, Arial";

    context.font = `${size}px ${family}`;
    context.textBaseline = "top";

    object.text.split("\n").forEach((line, index) => {
      context.fillText(
        line,
        object.x,
        object.y + index * size * 1.4,
      );
    });
  } else if (object.type === "image") {
    let image = images.get(object.src);

    if (!image) {
      image = new Image();
      image.onload = () => draw();
      image.src = object.src;
      images.set(object.src, image);
    }

    if (image.complete && image.naturalWidth) {
      context.drawImage(
        image,
        object.x,
        object.y,
        object.w,
        object.h,
      );
    }
  } else if (object.type === "document") {
    context.fillStyle = "#f5f8ff";
    context.fillRect(object.x, object.y, object.w, object.h);
    context.strokeStyle = "#cfe0ff";
    context.lineWidth = 1.5;
    context.strokeRect(object.x, object.y, object.w, object.h);

    const label = (object.mime || "").includes("pdf") || /\.pdf$/i.test(object.name || "")
      ? "PDF"
      : /^text\//.test(object.mime || "") || /\.(txt|md|csv|json)$/i.test(object.name || "")
        ? "DOC"
        : "FILE";

    context.fillStyle = "#4d6bd8";
    context.fillRect(object.x + 12, object.y + 14, 34, 40);

    context.fillStyle = "#ffffff";
    context.font = "bold 12px Segoe UI";
    context.fillText(label, object.x + 18, object.y + 38);

    context.fillStyle = "#384c75";
    context.font = "600 12px Segoe UI";
    const safeName = (object.name || "Tài liệu").slice(0, 22);
    context.fillText(safeName, object.x + 58, object.y + 30);

    context.fillStyle = "#7d8aa5";
    context.font = "11px Segoe UI";
    context.fillText("Tài liệu được đính kèm", object.x + 58, object.y + 52);
  } else if (object.type === "graph") {
    paintGraph(context, object);
  } else if (object.type === "ruler") {
    const rulerHeight = Math.max(object.h || 45, 16);
    context.fillStyle = "#dce9ffbb";
    context.fillRect(object.x, object.y, object.w, rulerHeight);
    context.strokeRect(object.x, object.y, object.w, rulerHeight);

    context.font = "10px Arial";
    context.fillStyle = "#5873a0";
    context.lineWidth = 1;

    for (let n = 0; n <= object.w; n += 10) {
      context.beginPath();
      context.moveTo(object.x + n, object.y);

      context.lineTo(
        object.x + n,
        object.y + rulerHeight * (n % 50 === 0 ? 0.55 : 0.3),
      );

      context.stroke();

      if (n % 50 === 0) {
        context.fillText(
          n / 50,
          object.x + n + 2,
          object.y + rulerHeight * 0.82,
        );
      }
    }
  } else if (object.type === "protractor") {
    const radiusX = Math.abs(object.w / 2);
    const radiusY = radiusX;
    const centerX = object.x + object.w / 2;
    const centerY = object.y + radiusY;

    context.fillStyle = "#e9efffcc";

    context.beginPath();
    context.ellipse(centerX, centerY, radiusX, radiusY, 0, Math.PI, Math.PI * 2);
    context.closePath();
    context.fill();
    context.stroke();

    context.font = `${Math.max(6, Math.min(9, radiusX * 0.08))}px Arial`;
    context.fillStyle = "#5873a0";
    context.textAlign = "center";
    context.textBaseline = "middle";

    for (let degree = 0; degree <= 180; degree++) {
      const angle = Math.PI + (degree * Math.PI) / 180;
      const majorTick = degree % 10 === 0;
      const mediumTick = degree % 5 === 0;
      const tickLength = radiusX * (majorTick ? 0.16 : mediumTick ? 0.11 : 0.06);
      const innerRadius = Math.max(radiusX - tickLength, 0);

      context.beginPath();
      context.lineWidth = majorTick ? 1.15 : mediumTick ? 0.9 : 0.65;

      context.moveTo(
        centerX + radiusX * Math.cos(angle),
        centerY + radiusX * Math.sin(angle),
      );

      context.lineTo(
        centerX + innerRadius * Math.cos(angle),
        centerY + innerRadius * Math.sin(angle),
      );

      context.stroke();

      if (majorTick) {
        for (const [label, labelRadius] of [
          [degree, radiusX * 0.74],
          [180 - degree, radiusX * 0.52],
        ]) {
          context.fillText(
            label,
            centerX + labelRadius * Math.cos(angle),
            centerY + labelRadius * Math.sin(angle),
          );
        }
      }
    }
  }

  context.restore();
}

function pdfDocumentPages() {
  return objects.filter(object => object.pdfBackground);
}

function paperPage(index) {
  return { x: 0, y: paper.top + index * (paper.h + paper.gap), w: paper.w, h: paper.h };
}

function pageAt(point) {
  const pdfPages = pdfDocumentPages();
  const page = pdfPages.length
    ? pdfPages.find(item => point.x >= item.x && point.x <= item.x + item.w
      && point.y >= item.y && point.y <= item.y + item.h)
    : paperPage(Math.max(0, Math.floor((point.y - paper.top) / (paper.h + paper.gap))));
  return page && point.x >= page.x && point.x <= page.x + page.w
    && point.y >= page.y && point.y <= page.y + page.h ? page : null;
}

function clampToPage(point, page = start?.page) {
  if (!page) return point;
  const margin = paper.margin;
  return { ...point, x: Math.max(page.x + margin, Math.min(page.x + page.w - margin, point.x)),
    y: Math.max(page.y + margin, Math.min(page.y + page.h - margin, point.y)) };
}

// Keep objects on the sheet while allowing writing all the way to its edges.
function scalePaperObject(object, scale) {
  if (scale >= 1) return;
  const box = bounds(object);
  for (const points of [object.points, object.vertices]) points?.forEach(point => {
    point.x = box.x + (point.x - box.x) * scale;
    point.y = box.y + (point.y - box.y) * scale;
  });
  for (const region of [...(object.clipRegions || []), ...(object.cutouts || [])]) {
    region.forEach(point => {
      point.x = box.x + (point.x - box.x) * scale;
      point.y = box.y + (point.y - box.y) * scale;
    });
  }
  if (Number.isFinite(object.x)) object.x = box.x + (object.x - box.x) * scale;
  if (Number.isFinite(object.y)) object.y = box.y + (object.y - box.y) * scale;
  if (Number.isFinite(object.w)) object.w *= scale;
  if (Number.isFinite(object.h)) object.h *= scale;
  if (object.type === "text") object.size = (object.size || 24) * scale;
  if (object.width) object.width *= scale;
}

function fitObjectOnPaper(object) {
  if (object.freePosition) return;
  let box = bounds(object);
  const index = Math.max(0, Math.floor((box.y - paper.top) / (paper.h + paper.gap)));
  const page = paperPage(index);
  const inset = paper.margin;
  scalePaperObject(object, Math.min(1, (page.w - inset * 2) / (box.w || 1),
    (page.h - inset * 2) / (box.h || 1)));
  box = bounds(object);
  const x = Math.max(inset, Math.min(page.w - inset - box.w, box.x));
  const y = Math.max(page.y + inset, Math.min(page.y + page.h - inset - box.h, box.y));
  moveObject(object, x - box.x, y - box.y);
}

function migrateLegacyPaper() {
  if (!objects.length || pdfDocumentPages().length) return;
  const boxes = objects.map(bounds);
  const left = Math.min(...boxes.map(box => box.x));
  const top = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.x + box.w));
  const scale = Math.min(1, (paper.w - paper.margin * 2) / (right - left || 1));
  const contentHeight = paper.h - paper.margin * 2;
  for (const object of objects) {
    const box = bounds(object);
    scalePaperObject(object, scale);
    const offsetY = (box.y - top) * scale;
    const index = Math.floor(offsetY / contentHeight);
    const nextY = paperPage(index).y + paper.margin + offsetY % contentHeight;
    moveObject(object, paper.margin + (box.x - left) * scale - box.x, nextY - box.y);
    fitObjectOnPaper(object);
  }
  paperPageCount = contentPageCount();
  view.y = 0;
}

function contentPageCount(items = objects) {
  let bottom = paper.top;
  for (const item of items) {
    const box = bounds(item);
    bottom = Math.max(bottom, box.y + box.h + (item.width || 0) / 2);
  }
  return Math.max(1, Math.floor((bottom - paper.top) / (paper.h + paper.gap)) + 1);
}

function visiblePages() {
  const pdfPages = pdfDocumentPages();
  if (pdfPages.length) return pdfPages.filter(page =>
    page.y * view.z + view.y <= boardH && (page.y + page.h) * view.z + view.y >= 0);
  const first = Math.max(0, Math.floor((-view.y / view.z - paper.top) / (paper.h + paper.gap)));
  const last = Math.min(paperPageCount - 1,
    Math.floor(((boardH - view.y) / view.z - paper.top) / (paper.h + paper.gap)));
  const pages = [];
  for (let index = first; index <= last; index++) pages.push(paperPage(index));
  return pages;
}

function extendPaperForScroll() {
  if (pdfDocumentPages().length) return;
  const bottom = (boardH - view.y) / view.z;
  paperPageCount = Math.max(paperPageCount,
    Math.ceil((bottom + 120 - paper.top + paper.gap) / (paper.h + paper.gap)));
}

function scrollRange() {
  const pages = pdfDocumentPages();
  const bottom = pages.length ? Math.max(...pages.map(page => page.y + page.h))
    : paperPage(paperPageCount - 1).y + paper.h;
  return Math.max(0, bottom * view.z + 100 - boardH);
}

function paintPaper(context, page, guides = false, background = paperBackground,
  surfaceColor = paperColor) {
  context.save();
  context.fillStyle = page.pdfBackground ? "#fff" : surfaceColor;
  context.fillRect(page.x, page.y, page.w, page.h);
  context.beginPath();
  context.rect(page.x, page.y, page.w, page.h);
  context.clip();
  const left = page.x, right = page.x + page.w;
  const top = page.y, bottom = page.y + page.h;
  const rgb = surfaceColor.slice(1).match(/.{2}/g).map(value => parseInt(value, 16));
  const dark = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 < 128;
  if (background !== "plain" && !page.pdfBackground) {
    context.strokeStyle = dark ? "rgba(255,255,255,.18)" : "rgba(91,105,111,.2)";
    context.fillStyle = dark ? "rgba(255,255,255,.35)" : "rgba(91,105,111,.35)";
    context.lineWidth = 0.7;
    const step = background === "wide" ? 30 : background === "grid" ? 28 : 18;
    if (["grid", "lined", "wide", "margin"].includes(background)) {
      context.beginPath();
      for (let y = top + step; y < bottom; y += step) {
        context.moveTo(left, y); context.lineTo(right, y);
      }
      if (background === "grid") for (let x = left; x <= right; x += step) {
        context.moveTo(x, top); context.lineTo(x, bottom);
      }
      context.stroke();
      if (background === "margin") {
        context.strokeStyle = dark ? "rgba(255,161,161,.45)" : "rgba(207,104,104,.4)";
        context.beginPath();
        context.moveTo(left + 64, top); context.lineTo(left + 64, bottom);
        context.stroke();
      }
    } else if (background === "dots") {
      for (let x = left; x <= right; x += step) for (let y = top; y < bottom; y += step) {
        context.beginPath(); context.arc(x, y, 0.8, 0, Math.PI * 2); context.fill();
      }
    }
  }
  context.restore();
}

function draw() {
  if (!boardW) return;
  const pdfPages = pdfDocumentPages();
  const documentMode = pdfPages.length > 0;
  document.body.classList.toggle("pdf-document-mode", documentMode);
  document.body.classList.add("paper-mode");
  if (!documentMode) paperPageCount = Math.max(paperPageCount, contentPageCount());
  const pageWidth = documentMode ? Math.max(...pdfPages.map(page => page.x + page.w)) : paper.w;
  if (view.fit !== false) {
    const previousScale = view.z;
    view.z = Math.min(1, Math.max(0.1, (boardW - (boardW > 600 ? 180 : 40)) / pageWidth));
    view.y *= view.z / previousScale;
  } else {
    view.z = Math.max(0.1, Math.min(4, view.z));
  }
  if (view.fit !== false || pageWidth * view.z <= boardW - 48) {
    view.x = (boardW - pageWidth * view.z) / 2;
  } else {
    view.x = Math.max(boardW - pageWidth * view.z - 24, Math.min(24, view.x));
  }
  view.y = Math.max(-scrollRange(), Math.min(0, view.y));
  const pages = visiblePages();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = paperSurround;
  ctx.fillRect(0, 0, boardW, boardH);
  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.z, view.z);

  for (const page of pages) {
    ctx.save();
    ctx.shadowColor = "rgba(15,23,42,.16)";
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = page.pdfBackground ? "#fff" : paperColor;
    ctx.fillRect(page.x, page.y, page.w, page.h);
    ctx.restore();
    paintPaper(ctx, page, true);
    if (!documentMode) {
      ctx.fillStyle = "#64748b";
      ctx.font = "12px Segoe UI, Arial";
      const number = Math.round((page.y - paper.top) / (paper.h + paper.gap)) + 1;
      ctx.fillText(`A4 · Trang ${number}`, page.x + page.w - 96, page.y - 10);
    }
  }
  const pageClip = new Path2D();
  pages.forEach(page => pageClip.rect(page.x, page.y, page.w, page.h));
  objects.forEach(object => {
    const box = bounds(object);
    if ((box.y + box.h + 24) * view.z + view.y >= 0 && (box.y - 24) * view.z + view.y <= boardH) {
      ctx.save();
      if (!object.freePosition) ctx.clip(pageClip);
      paintObject(ctx, object);
      ctx.restore();
    }
  });
  ctx.save();
  ctx.clip(pageClip);
  if (active && tool !== "select") paintObject(ctx, active);
  ctx.restore();

  if (selected >= 0 && objects[selected]) {
    const box = bounds(objects[selected]);

    ctx.strokeStyle = "#245bea";
    ctx.lineWidth = 1 / view.z;
    ctx.setLineDash([5 / view.z, 4 / view.z]);

    ctx.strokeRect(
      box.x - 5,
      box.y - 5,
      box.w + 10,
      box.h + 10,
    );

    const masked = objects[selected].clipRegions?.length || objects[selected].cutouts?.length;
    const handles = masked ? [] : selectionHandles(box);
    ctx.setLineDash([]);
    ctx.fillStyle = "#245bea";

    for (const handle of handles) {
      ctx.fillRect(
        handle.x - 4 / view.z,
        handle.y - 4 / view.z,
        8 / view.z,
        8 / view.z,
      );
    }

    if (objects[selected].vertices && !masked) {
      ctx.lineWidth = 1.5 / view.z;

      for (const vertex of objects[selected].vertices) {
        ctx.beginPath();
        ctx.arc(vertex.x, vertex.y, 5 / view.z, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = "#245bea";
        ctx.stroke();
      }
    }
  }

  if (selection) {
    ctx.strokeStyle = "#245bea";
    ctx.fillStyle = "#245bea12";
    ctx.lineWidth = 1 / view.z;
    ctx.setLineDash([6, 4]);

    ctx.fillRect(
      selection.x,
      selection.y,
      selection.w,
      selection.h,
    );

    ctx.strokeRect(
      selection.x,
      selection.y,
      selection.w,
      selection.h,
    );
  }

  drawGroupSelection();

  ctx.restore();

  if (tool === "eraser" && eraserCursor) {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.arc(eraserCursor.x, eraserCursor.y, 12, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(225, 76, 92, 0.12)";
    ctx.strokeStyle = "rgba(196, 56, 72, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  $("welcome").hidden = objects.length > 0 || Boolean(active) || view.y < -100;
  const pageIndex = documentMode
    ? Math.max(0, pdfPages.findIndex(page => (page.y + page.h) * view.z + view.y > boardH / 2))
    : Math.max(0, Math.min(paperPageCount - 1,
      Math.floor(((boardH / 2 - view.y) / view.z - paper.top) / (paper.h + paper.gap))));
  $("pageStatus").textContent = `Trang ${pageIndex + 1} / ${documentMode ? pdfPages.length : paperPageCount}`;
  $("addPageBtn").hidden = documentMode;
  $("clearInkBtn").disabled = !objects.some(isInkObject);
  $("removeFilesBtn").disabled = !objects.some(isUploadedObject);
  $("clearBtn").disabled = !objects.length && paperPageCount === 1;
  $("objectCount").textContent = `${objects.length} đối tượng`;
  $("undoBtn").disabled = !undoStack.length;
  $("redoBtn").disabled = !redoStack.length;
  $("resetView").textContent = `${Math.round(view.z * 100)}%`;
  updateBoardScrollbar();
  if (tool === "moveLasso") {
    const button = document.querySelector('[data-tool="moveLasso"]').getBoundingClientRect();
    const workspace = $("workspace").getBoundingClientRect();
    $("lassoOptions").style.left = `${button.right - workspace.left + 12}px`;
    $("lassoOptions").style.top = `${button.top - workspace.top + button.height / 2}px`;
  }
}

// =====================================================
// 6. CHỌN VÀ DI CHUYỂN ĐỐI TƯỢNG
// =====================================================

function bounds(object) {
  const box = rawBounds(object);
  for (const region of object.clipRegions || []) {
    const clip = rawBounds({ points: region });
    const right = Math.min(box.x + box.w, clip.x + clip.w);
    const bottom = Math.min(box.y + box.h, clip.y + clip.h);
    box.x = Math.max(box.x, clip.x);
    box.y = Math.max(box.y, clip.y);
    box.w = Math.max(0, right - box.x);
    box.h = Math.max(0, bottom - box.y);
  }
  return box;
}

function rawBounds(object) {
  if (object.points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const point of object.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }

    return {
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
    };
  }

  if (object.vertices?.length) {
    const xs = object.vertices.map((point) => point.x);
    const ys = object.vertices.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  if (object.type === "text") {
    const lines = object.text.split("\n");
    const size = object.size || 24;
    ctx.save();
    ctx.font = `${size}px ${object.formula ? "Georgia" : "Segoe UI, Arial"}`;
    const textWidth = Math.max(1, ...lines.map(line => ctx.measureText(line).width));
    ctx.restore();

    return {
      x: object.x,
      y: object.y,
      w: textWidth,
      h: lines.length * size * 1.4,
    };
  }

  return {
    x: Math.min(object.x, object.x + (object.w || 0)),
    y: Math.min(object.y, object.y + (object.h || 0)),
    w: Math.abs(object.w || 0),
    h: Math.abs(object.h || 45),
  };
}

function syncGeometryBounds(object) {
  const box = bounds(object);
  object.x = box.x;
  object.y = box.y;
  object.w = box.w;
  object.h = box.h;
}

function hit(point) {
  for (let i = objects.length - 1; i >= 0; i--) {
    if (objects[i].pdfBackground) continue;
    if ((objects[i].clipRegions || []).some(region => !pointInLasso(point, region))
        || (objects[i].cutouts || []).some(region => pointInLasso(point, region))) continue;
    const box = bounds(objects[i]);
    const padding = 8 / view.z;

    if (
      point.x >= box.x - padding &&
      point.x <= box.x + box.w + padding &&
      point.y >= box.y - padding &&
      point.y <= box.y + box.h + padding
    ) {
      return i;
    }
  }

  return -1;
}

function pointSegmentDistance(point, startPoint, endPoint) {
  const dx = endPoint.x - startPoint.x;
  const dy = endPoint.y - startPoint.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(point.x - startPoint.x, point.y - startPoint.y);
  }

  const ratio = Math.max(
    0,
    Math.min(
      1,
      ((point.x - startPoint.x) * dx + (point.y - startPoint.y) * dy) /
        lengthSquared,
    ),
  );

  return Math.hypot(
    point.x - (startPoint.x + ratio * dx),
    point.y - (startPoint.y + ratio * dy),
  );
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const orientation = (a, b, c) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const onSegment = (startPoint, endPoint, point) =>
    point.x >= Math.min(startPoint.x, endPoint.x) - 1e-9 &&
    point.x <= Math.max(startPoint.x, endPoint.x) + 1e-9 &&
    point.y >= Math.min(startPoint.y, endPoint.y) - 1e-9 &&
    point.y <= Math.max(startPoint.y, endPoint.y) + 1e-9;
  const first = orientation(firstStart, firstEnd, secondStart);
  const second = orientation(firstStart, firstEnd, secondEnd);
  const third = orientation(secondStart, secondEnd, firstStart);
  const fourth = orientation(secondStart, secondEnd, firstEnd);

  if (
    ((first > 0 && second < 0) || (first < 0 && second > 0)) &&
    ((third > 0 && fourth < 0) || (third < 0 && fourth > 0))
  ) {
    return true;
  }

  return (
    (Math.abs(first) < 1e-9 && onSegment(firstStart, firstEnd, secondStart)) ||
    (Math.abs(second) < 1e-9 && onSegment(firstStart, firstEnd, secondEnd)) ||
    (Math.abs(third) < 1e-9 && onSegment(secondStart, secondEnd, firstStart)) ||
    (Math.abs(fourth) < 1e-9 && onSegment(secondStart, secondEnd, firstEnd))
  );
}

function segmentDistance(firstStart, firstEnd, secondStart, secondEnd) {
  if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return 0;

  return Math.min(
    pointSegmentDistance(firstStart, secondStart, secondEnd),
    pointSegmentDistance(firstEnd, secondStart, secondEnd),
    pointSegmentDistance(secondStart, firstStart, firstEnd),
    pointSegmentDistance(secondEnd, firstStart, firstEnd),
  );
}

function splitStrokeAtEraser(object, eraserStart, eraserEnd, radius) {
  const points = object.points;
  const touchesEraser = (point) =>
    pointSegmentDistance(point, eraserStart, eraserEnd) <= radius;

  if (points.length === 1) {
    return touchesEraser(points[0]) ? [] : [points];
  }

  const runs = [];
  let current = touchesEraser(points[0]) ? [] : [points[0]];

  for (let index = 0; index < points.length - 1; index++) {
    const first = points[index];
    const second = points[index + 1];
    const erased =
      segmentDistance(first, second, eraserStart, eraserEnd) <= radius;

    if (erased) {
      if (current.length) runs.push(current);
      current = touchesEraser(second) ? [] : [second];
    } else {
      if (!current.length) current.push(first);
      current.push(second);
    }
  }

  if (current.length) runs.push(current);

  return runs.filter(
    (run) => run.length > 1 || !touchesEraser(run[0]),
  );
}

function segmentTouchesBounds(startPoint, endPoint, box, radius) {
  return (
    Math.max(Math.min(startPoint.x, endPoint.x), box.x - radius) <=
      Math.min(Math.max(startPoint.x, endPoint.x), box.x + box.w + radius) &&
    Math.max(Math.min(startPoint.y, endPoint.y), box.y - radius) <=
      Math.min(Math.max(startPoint.y, endPoint.y), box.y + box.h + radius)
  );
}

function isUploadedObject(object) {
  return object.type === "image" || object.type === "document"
    || Boolean(object.pdfBackground || object.pdfPage);
}

function isInkObject(object) {
  return ["pen", "highlight"].includes(object.type) && !isUploadedObject(object);
}

function eraseAlong(eraserStart, eraserEnd) {
  const radius = 12 / view.z;
  const updatedObjects = [];
  let changedObjects = false;

  for (const object of objects) {
    if (isUploadedObject(object)) {
      updatedObjects.push(object);
    } else if (object.type === "pen" || object.type === "highlight") {
      const strokeRadius = radius + (object.width || 1) / 2;
      const remainingRuns = splitStrokeAtEraser(
        object,
        eraserStart,
        eraserEnd,
        strokeRadius,
      );

      if (
        remainingRuns.length === 1 &&
        remainingRuns[0].length === object.points.length
      ) {
        updatedObjects.push(object);
      } else {
        changedObjects = true;
        remainingRuns.forEach((points) => {
          updatedObjects.push({ ...object, points });
        });
      }
    } else if (
      segmentTouchesBounds(eraserStart, eraserEnd, bounds(object), radius)
    ) {
      changedObjects = true;
    } else {
      updatedObjects.push(object);
    }
  }

  if (!changedObjects) return false;

  if (!start.eraserSnapshot) {
    snapshot();
    start.eraserSnapshot = true;
  }

  objects = updatedObjects;
  draw();
  return true;
}

function eraseObjectAt(point) {
  const index = hit(point);

  if (index < 0) return false;
  if (isUploadedObject(objects[index])) return false;

  if (!start.eraserSnapshot) {
    snapshot();
    start.eraserSnapshot = true;
  }

  objects.splice(index, 1);
  selected = -1;
  return true;
}

function moveObject(object, dx, dy) {
  for (const region of [...(object.clipRegions || []), ...(object.cutouts || [])]) {
    region.forEach(point => { point.x += dx; point.y += dy; });
  }
  if (object.points) {
    object.points.forEach((point) => {
      point.x += dx;
      point.y += dy;
    });
  } else if (object.vertices) {
    object.vertices.forEach((point) => {
      point.x += dx;
      point.y += dy;
    });
    object.x += dx;
    object.y += dy;
  } else {
    object.x += dx;
    object.y += dy;
  }
}

// A lasso cuts visible content with vector masks; moving it never resamples it.
function clearGroupSelection() {
  groupSelection = [];
  groupRegion = null;
  groupDetached = false;
  lassoPath = null;
  $("selectionNote").hidden = true;
}

function groupBounds() {
  return groupRegion ? bounds({ points: groupRegion }) : null;
}

function insideGroup(point) {
  return groupRegion && pointInLasso(point, groupRegion);
}

function pointInLasso(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
    if (Math.abs(cross) < 1e-7 && point.x >= Math.min(a.x, b.x) - 1e-7
        && point.x <= Math.max(a.x, b.x) + 1e-7 && point.y >= Math.min(a.y, b.y) - 1e-7
        && point.y <= Math.max(a.y, b.y) + 1e-7) return true;
    if ((a.y > point.y) !== (b.y > point.y)
        && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function traceLasso(context, region, begin = true, close = true) {
  if (begin) context.beginPath();
  context.moveTo(region[0].x, region[0].y);
  for (let index = 1; index < region.length; index++) context.lineTo(region[index].x, region[index].y);
  if (close) context.closePath();
}

function visibleContentInLasso(object, polygon, area) {
  const box = bounds(object);
  // Include pen pressure, highlight width, and labels around geometry.
  const padding = Math.max(32, (object.width || 3) * 6);
  const x = Math.max(area.x, box.x - padding);
  const y = Math.max(area.y, box.y - padding);
  const right = Math.min(area.x + area.w, box.x + box.w + padding);
  const bottom = Math.min(area.y + area.h, box.y + box.h + padding);
  if (right <= x || bottom <= y) return false;
  // Rasterization is only a hit test. The stored content remains unchanged.
  const scale = Math.min(1, 192 / Math.max(right - x, bottom - y));
  const surface = document.createElement("canvas");
  surface.width = Math.max(1, Math.ceil((right - x) * scale));
  surface.height = Math.max(1, Math.ceil((bottom - y) * scale));
  const context = surface.getContext("2d", { willReadFrequently: true });
  context.scale(scale, scale);
  context.translate(-x, -y);
  traceLasso(context, polygon);
  context.clip("evenodd");
  paintObject(context, object);
  const pixels = context.getImageData(0, 0, surface.width, surface.height).data;
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) return true;
  return false;
}

function completeLasso() {
  if (!lassoPath || lassoPath.length < 3) { clearGroupSelection(); return; }
  const box = bounds({ points: lassoPath });
  if (box.w * view.z < 6 || box.h * view.z < 6) { clearGroupSelection(); return; }
  groupRegion = lassoPath.map(point => ({ ...point }));
  groupSelection = objects.filter(object => visibleContentInLasso(object, groupRegion, box));
  lassoPath = null;
  if (!groupSelection.length) {
    groupRegion = null;
    toast("Vùng khoanh chưa có nội dung. Hãy khoanh phần bạn muốn di chuyển.");
    return;
  }
  $("selectionNote").textContent = "Đã khoanh vùng · Kéo bên trong để di chuyển · V để tự khoanh vùng mới · Esc để bỏ chọn";
  $("selectionNote").hidden = false;
  canvas.style.cursor = "grab";
}

function drawGroupSelection() {
  if (tool !== "moveLasso") return;
  ctx.save();
  ctx.strokeStyle = "#245bea";
  ctx.fillStyle = "rgba(36, 91, 234, 0.08)";
  ctx.lineWidth = 1.5 / view.z;
  ctx.setLineDash([6 / view.z, 4 / view.z]);
  const region = lassoPath || groupRegion;
  if (region?.length) {
    const openFreeform = lassoPath && lassoMode === "freeform";
    traceLasso(ctx, region, true, !openFreeform);
    if (lassoPath && !openFreeform) ctx.fill("evenodd");
    ctx.stroke();
  }
  ctx.restore();
}

function moveLassoGroup(point) {
  const dx = point.x - start.x, dy = point.y - start.y;
  if (!start.groupSnapshot) {
    if (Math.hypot(dx, dy) * view.z < 2) return;
    start.previousRedo = redoStack;
    start.previousUndo = undoStack.slice();
    start.boardBeforeCut = boardSnapshot();
    start.sourceIndices = groupSelection.map(object => objects.indexOf(object));
    start.originalRegion = groupRegion.map(point => ({ ...point }));
    start.originalDetached = groupDetached;
    snapshot();
    start.groupSnapshot = true;
    if (!groupDetached) {
      const pieces = [];
      for (const object of groupSelection) {
        const piece = JSON.parse(JSON.stringify(object));
        piece.clipRegions = [...(piece.clipRegions || []), groupRegion.map(point => ({ ...point }))];
        piece.freePosition = true;
        delete piece.pdfBackground;
        delete piece.pdfPage;
        object.cutouts = [...(object.cutouts || []), groupRegion.map(point => ({ ...point }))];
        object.freePosition = true;
        pieces.push(piece);
      }
      objects.push(...pieces);
      groupSelection = pieces;
      groupDetached = true;
    }
  }
  groupSelection.forEach(object => moveObject(object, dx - start.groupDx, dy - start.groupDy));
  groupRegion.forEach(point => { point.x += dx - start.groupDx; point.y += dy - start.groupDy; });
  start.groupDx = dx;
  start.groupDy = dy;
}

function finishGroupMove(cancel = false) {
  if (!start?.groupMove) return;
  const moved = start.groupSnapshot && (start.groupDx !== 0 || start.groupDy !== 0);
  if (start.groupSnapshot && (cancel || !moved)) {
    const state = start;
    restoreBoardSnapshot(state.boardBeforeCut);
    groupSelection = state.sourceIndices.map(index => objects[index]);
    groupRegion = state.originalRegion;
    groupDetached = state.originalDetached;
    undoStack = state.previousUndo;
    redoStack = state.previousRedo;
    $("selectionNote").textContent = "Kéo trong vùng khoanh để di chuyển nguyên kích thước · Esc để bỏ chọn";
    $("selectionNote").hidden = false;
  }
  start = null;
  dragging = false;
  canvas.style.cursor = "grab";
  if (moved && !cancel) changed();
  else draw();
}

function resizeObject(object, handle, dx, dy) {
  if (object.points) return;
  if (object.type === "text") {
    const box = bounds(object);
    const size = object.size || 24;
    const horizontal = handle.includes("w") ? -dx : dx;
    const vertical = handle.includes("n") ? -dy : dy;
    // Project the drag onto the corner diagonal to keep glyph proportions.
    const scale = 1 + (horizontal * box.w + vertical * box.h)
      / (box.w * box.w + box.h * box.h || 1);
    const nextSize = Math.max(8, Math.min(200, size * scale));
    const ratio = nextSize / size;
    if (handle.includes("w")) object.x = box.x + box.w * (1 - ratio);
    if (handle.includes("n")) object.y = box.y + box.h * (1 - ratio);
    object.size = nextSize;
    return;
  }

  if (object.type === "protractor") {
    const box = {
      x: object.x,
      y: object.y,
      w: Math.abs(object.w || 0),
      h: Math.abs(object.w || 0) / 2,
    };
    const changesWidth = handle.includes("e") || handle.includes("w");
    const changesHeight = handle.includes("n") || handle.includes("s");
    const horizontalChange = handle.includes("w") ? -dx : dx;
    const verticalChange = handle.includes("n") ? -dy * 2 : dy * 2;
    const widthChange = changesWidth && changesHeight
      ? Math.abs(horizontalChange) >= Math.abs(verticalChange)
        ? horizontalChange
        : verticalChange
      : changesWidth
        ? horizontalChange
        : verticalChange;
    const nextWidth = Math.max(80, box.w + widthChange);
    const nextHeight = nextWidth / 2;
    const anchorX = handle.includes("w") ? box.x + box.w : box.x;
    const anchorY = handle.includes("n") ? box.y + box.h : box.y;

    object.x = handle.includes("w") ? anchorX - nextWidth : anchorX;
    object.y = handle.includes("n") ? anchorY - nextHeight : anchorY;
    object.w = nextWidth;
    object.h = nextHeight;
    object.vertices = null;
    return;
  }

  if (object.vertices) {
    const box = bounds(object);
    const next = { ...box };
    const minSize = 40;

    if (handle.includes("e")) next.w = Math.max(minSize, box.w + dx);
    if (handle.includes("s")) next.h = Math.max(minSize, box.h + dy);
    if (handle.includes("w")) {
      next.w = Math.max(minSize, box.w - dx);
      next.x = box.x + box.w - next.w;
    }
    if (handle.includes("n")) {
      next.h = Math.max(minSize, box.h - dy);
      next.y = box.y + box.h - next.h;
    }

    const scaleX = next.w / (box.w || 1);
    const scaleY = next.h / (box.h || 1);

    object.vertices.forEach((vertex) => {
      vertex.x = next.x + (vertex.x - box.x) * scaleX;
      vertex.y = next.y + (vertex.y - box.y) * scaleY;
    });
    object.x = next.x;
    object.y = next.y;
    object.w = next.w;
    object.h = next.h;
    return;
  }

  const box = {
    x: object.x,
    y: object.y,
    w: object.w || 0,
    h: object.h || 0,
  };

  const minSize = 40;

  if (handle.includes("e")) {
    object.w = Math.max(minSize, box.w + dx);
  }

  if (handle.includes("s")) {
    object.h = Math.max(minSize, box.h + dy);
  }

  if (handle.includes("w")) {
    const nextW = Math.max(minSize, box.w - dx);
    object.x = box.x + (box.w - nextW);
    object.w = nextW;
  }

  if (handle.includes("n")) {
    const nextH = Math.max(minSize, box.h - dy);
    object.y = box.y + (box.h - nextH);
    object.h = nextH;
  }
}

function selectionHandles(box) {
  const pad = 6 / view.z;

  return [
    { key: "nw", x: box.x, y: box.y },
    { key: "ne", x: box.x + box.w, y: box.y },
    { key: "sw", x: box.x, y: box.y + box.h },
    { key: "se", x: box.x + box.w, y: box.y + box.h },
  ].map((handle) => ({ ...handle, pad }));
}

function hitResizeHandle(point) {
  const index = selected;

  if (index < 0) return null;
  const box = bounds(objects[index]);
  const object = objects[index];
  if (object.clipRegions?.length || object.cutouts?.length) return null;

  if (object.vertices) {
    const vertexPadding = 10 / view.z;

    for (let vertexIndex = 0; vertexIndex < object.vertices.length; vertexIndex++) {
      const vertex = object.vertices[vertexIndex];

      if (
        Math.abs(point.x - vertex.x) <= vertexPadding &&
        Math.abs(point.y - vertex.y) <= vertexPadding
      ) {
        return `vertex:${vertexIndex}`;
      }
    }
  }

  for (const handle of selectionHandles(box)) {
    if (
      point.x >= handle.x - handle.pad &&
      point.x <= handle.x + handle.pad &&
      point.y >= handle.y - handle.pad &&
      point.y <= handle.y + handle.pad
    ) {
      return handle.key;
    }
  }

  return null;
}

// =====================================================
// 7. SỰ KIỆN VẼ BẰNG CHUỘT / BÚT
// =====================================================

canvas.onpointerdown = (event) => {
  if (event.pointerType === "touch") {
    touchPointers.set(event.pointerId, screenPoint(event));
    canvas.setPointerCapture(event.pointerId);
    if (touchPointers.size >= 2) {
      if (start?.groupMove) finishGroupMove(true);
      clearGroupSelection();
      const [a, b] = [...touchPointers.values()];
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      paperGesture = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        anchor: world(center), z: view.z };
      active = null;
      dragging = false;
      start = null;
      selection = null;
      draw();
      return;
    }
    if (paperGesture) return;
  }
  if (event.button !== 0 && event.button !== 1) return;
  if (tool === "moveLasso" && dragging) return;

  const screen = screenPoint(event);
  const rawPoint = world(screen);
  const page = pageAt(rawPoint);
  const pan = space || tool === "hand" || event.button === 1;
  if (!pan && !page && tool !== "moveLasso") return;
  const point = pan || tool === "select" || tool === "moveLasso" ? rawPoint : clampToPage(rawPoint, page);

  start = {
    pointerId: event.pointerId,
    page,
    ...point,
    sx: screen.x,
    sy: screen.y,
    vx: view.x,
    vy: view.y,
  };

  dragging = true;
  canvas.setPointerCapture(event.pointerId);

  if (space || tool === "hand" || event.button === 1) {
    start.pan = true;
    return;
  }

  if (tool === "text") {
    dragging = false;
    openText(point);
    return;
  }

  if (tool === "moveLasso") {
    selected = -1;
    selection = null;
    if (insideGroup(point)) {
      start.groupMove = true;
      start.groupBox = groupBounds();
      start.groupDx = 0;
      start.groupDy = 0;
      canvas.style.cursor = "grabbing";
    } else {
      clearGroupSelection();
      lassoPath = [{ x: point.x, y: point.y }];
      canvas.style.cursor = "crosshair";
    }
    draw();
    return;
  }

  selection = null;
  $("selectionNote").hidden = true;

  if (tool === "select") {
    const existingHandle = hitResizeHandle(point);
    if (!existingHandle) selected = hit(point);

    if (selected >= 0) {
      if (objects[selected].type === "protractor") {
        objects[selected].vertices = null;
      } else if (!objects[selected].vertices) {
        objects[selected].vertices = shapeVertices(objects[selected]);
      }

      if (objects[selected].vertices) {
        $("toolStatus").textContent =
          "Hình học · Kéo nút tròn để chỉnh từng đỉnh, kéo cạnh để di chuyển";
      }

      const box = bounds(objects[selected]);
      const handle = hitResizeHandle(point);

      if (handle) {
        resizeHandle = handle;
        snapshot();
        active = JSON.parse(JSON.stringify(objects[selected]));
        start.resize = true;
        start.handle = handle;
        start.box = box;
        start.origin = JSON.parse(JSON.stringify(objects[selected]));
        draw();
        return;
      }

      snapshot();
      active = JSON.parse(JSON.stringify(objects[selected]));
    }

    draw();
    return;
  }

  if (tool === "eraser") {
    selected = -1;
    eraserCursor = screen;
    start.eraserLast = point;
    start.eraserSnapshot = false;
    if (eraserMode === "object") {
      eraseObjectAt(point);
    } else {
      eraseAlong(point, point);
    }
    draw();
    return;
  }

  if (tool === "lasso" || tool === "aiRegion") {
    if (tool === "aiRegion" && window.boardAI?.busy) {
      dragging = false;
      toast("AI đang trả lời. Hãy đợi rồi khoanh lại.");
      return;
    }
    selected = -1;
    selection = {
      x: point.x,
      y: point.y,
      w: 0,
      h: 0,
    };

    return;
  }

  if (tool === "pen" || tool === "highlight") {
    start.handwritingScale = event.pointerType === "pen" ? handwritingScale : 1;
    active = {
      type: tool,
      color,
      width,
      points: [
        {
          ...point,
          p:
            event.pointerType === "pen"
              ? Math.max(0.2, event.pressure * 2)
              : 1,
        },
      ],
    };
  } else {
    active = {
      type: tool,
      color,
      width,
      x: point.x,
      y: point.y,
      w: 0,
      h: 0,
    };
  }

  draw();
};

canvas.onpointermove = (event) => {
  const screen = screenPoint(event);
  if (touchPointers.has(event.pointerId)) touchPointers.set(event.pointerId, screen);
  if (paperGesture) {
    if (touchPointers.size >= 2) {
      const [a, b] = [...touchPointers.values()];
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      view.fit = false;
      view.z = Math.max(0.1, Math.min(4,
        paperGesture.z * Math.pow(distance / paperGesture.distance, 0.5)));
      view.x = (a.x + b.x) / 2 - paperGesture.anchor.x * view.z;
      view.y = (a.y + b.y) / 2 - paperGesture.anchor.y * view.z;
      draw();
    }
    return;
  }
  const rawPoint = world(screen);
  const point = dragging && !start.pan && tool !== "select" && tool !== "moveLasso" ? clampToPage(rawPoint) : rawPoint;

  if (tool === "moveLasso") {
    if (!dragging) {
      canvas.style.cursor = space ? "grab" : insideGroup(point) ? "grab" : "crosshair";
      return;
    }
    if (event.pointerId !== start.pointerId) return;
    if (!start.pan) {
      if (start.groupMove) {
        moveLassoGroup(point);
      } else if (lassoMode === "rectangle") {
        lassoPath = [{ x: start.x, y: start.y }, { x: point.x, y: start.y },
          { x: point.x, y: point.y }, { x: start.x, y: point.y }];
      } else {
        const events = event.getCoalescedEvents?.();
        for (const item of events?.length ? events : [event]) {
          const next = world(screenPoint(item));
          const last = lassoPath[lassoPath.length - 1];
          if (Math.hypot(next.x - last.x, next.y - last.y) * view.z >= 1) {
            lassoPath.push({ x: next.x, y: next.y });
          }
        }
      }
      draw();
      return;
    }
  }

  if (!dragging) {
    if (tool === "eraser") {
      eraserCursor = screen;
      draw();
      return;
    }

    const index = hit(point);

    if (index >= 0 && objects[index].type === "graph"
        && !["oxy", "oxyz"].includes(objects[index].kind)) {
      const object = objects[index];
      const x = (point.x - object.x - object.w / 2) / 30;

      try {
        const y = compileExpression(object.expression)(x);

        $("toolStatus").textContent =
          `Đồ thị: x = ${x.toFixed(2)} · y = ${y.toFixed(2)}`;
      } catch {
        // Bỏ qua giá trị không tính được.
      }
    }

    return;
  }

  if (start.pan) {
    view.x = start.vx + screen.x - start.sx;
    view.y = Math.min(0, start.vy + screen.y - start.sy);
    extendPaperForScroll();
    draw();
    return;
  }

  if (tool === "eraser") {
    eraserCursor = screen;
    let events = event.getCoalescedEvents?.();

    if (!events || events.length === 0) events = [event];

    for (const item of events) {
      const nextPoint = clampToPage(world(screenPoint(item)));
      if (eraserMode === "object") {
        eraseObjectAt(nextPoint);
      } else {
        eraseAlong(start.eraserLast, nextPoint);
      }
      start.eraserLast = nextPoint;
    }

    draw();
    return;
  }

  if (tool === "select" && selected >= 0) {
    if (resizeHandle && start.resize) {
      const object = objects[selected];
      const dx = point.x - start.x;
      const dy = point.y - start.y;
      const original = JSON.parse(JSON.stringify(start.origin));

      object.x = original.x;
      object.y = original.y;
      if (original.type === "text") object.size = original.size;
      object.w = original.w || object.w || 0;
      object.h = original.h || object.h || 0;

      if (resizeHandle.startsWith("vertex:")) {
        const vertexIndex = Number(resizeHandle.slice("vertex:".length));
        object.vertices = original.vertices;
        object.vertices[vertexIndex] = { ...point };
        syncGeometryBounds(object);
      } else if (original.vertices) {
        object.vertices = original.vertices;
      }

      if (!resizeHandle.startsWith("vertex:")) {
        resizeObject(object, resizeHandle, dx, dy);
      }
    } else {
      objects[selected] = JSON.parse(JSON.stringify(active));

      moveObject(
        objects[selected],
        point.x - start.x,
        point.y - start.y,
      );
    }
  } else if (tool === "lasso" || tool === "aiRegion") {
    selection.w = point.x - start.x;
    selection.h = point.y - start.y;
  } else if (active) {
    if (active.points) {
      let events = event.getCoalescedEvents?.();

      if (!events || events.length === 0) {
        events = [event];
      }

      for (const item of events) {
        active.points.push({
          ...handwritingPoint(item),
          p:
            item.pointerType === "pen"
              ? Math.max(0.2, item.pressure * 2)
              : 1,
        });
      }
    } else {
      active.w = point.x - start.x;
      active.h = point.y - start.y;

      if (active.type === "ruler") {
        active.h = 45;
      }

      if (active.type === "protractor") {
        active.h = Math.abs(active.w / 2);
      }
    }
  }

  draw();
};

// Keep strokes as point paths so moving, erasing and saving still work normally.
function beautifyStroke(points) {
  if (points.length < 3) return points;
  const first = points[0];
  const last = points[points.length - 1];
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const span = distance(first, last);
  let length = 0;
  let deviation = 0;
  for (let i = 1; i < points.length; i++) {
    length += distance(points[i - 1], points[i]);
    if (span) deviation = Math.max(deviation,
      Math.abs((last.x - first.x) * (points[i].y - first.y)
        - (last.y - first.y) * (points[i].x - first.x)) / span);
  }
  if (length < 4) return points;
  if (span > 8 && length / span < 1.6 && deviation < Math.max(3, span * 0.08)) {
    return [{ ...first, p: 1 }, { ...last, p: 1 }];
  }

  const box = bounds({ points });
  const rx = box.w / 2;
  const ry = box.h / 2;
  const cx = box.x + rx;
  const cy = box.y + ry;
  const closed = distance(first, last) < Math.max(6, Math.hypot(box.w, box.h) * 0.15);
  const scale = Math.hypot(box.w, box.h);
  const segmentDistance = (point, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy)
      / (dx * dx + dy * dy || 1)));
    return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
  };
  const simplify = (path, tolerance) => {
    let maximum = tolerance, split = -1;
    for (let i = 1; i < path.length - 1; i++) {
      const error = segmentDistance(path[i], path[0], path[path.length - 1]);
      if (error > maximum) { maximum = error; split = i; }
    }
    if (split < 0) return [path[0], path[path.length - 1]];
    return [...simplify(path.slice(0, split + 1), tolerance).slice(0, -1),
      ...simplify(path.slice(split), tolerance)];
  };
  let polygon = simplify(closed ? [...points, first] : points, Math.max(3, scale * 0.045));
  if (closed) {
    polygon.pop();
    // A stroke can start halfway along an edge rather than at a vertex.
    for (let i = polygon.length - 1; i >= 0 && polygon.length > 3; i--) {
      if (segmentDistance(polygon[i], polygon[(i + polygon.length - 1) % polygon.length],
          polygon[(i + 1) % polygon.length]) < scale * 0.06) polygon.splice(i, 1);
    }
  }
  const corners = closed ? polygon : polygon.slice(1, -1);
  const sharpCorners = corners.every(vertex => {
    let index = 0;
    for (let i = 1; i < points.length; i++) {
      if (distance(points[i], vertex) < distance(points[index], vertex)) index = i;
    }
    const nearby = direction => {
      let i = index, traveled = 0;
      for (let count = 0; count < points.length - 1; count++) {
        const next = closed ? (i + direction + points.length) % points.length : i + direction;
        if (next < 0 || next >= points.length) break;
        traveled += distance(points[i], points[next]);
        i = next;
        if (traveled >= scale * 0.06) break;
      }
      return points[i];
    };
    const a = nearby(-1), b = nearby(1), center = points[index];
    const cosine = ((center.x - a.x) * (b.x - center.x) + (center.y - a.y) * (b.y - center.y))
      / (distance(center, a) * distance(center, b) || 1);
    return cosine < 0.8;
  });
  if (polygon.length >= (closed ? 3 : 2) && polygon.length <= 8 && sharpCorners) {
    const result = polygon.map(point => ({ ...point, p: 1 }));
    if (closed) result.push({ ...result[0] });
    return result;
  }
  if (closed && rx > 6 && ry > 6) {
    let error = 0;
    const sectors = new Set();
    for (const point of points) {
      const nx = (point.x - cx) / rx;
      const ny = (point.y - cy) / ry;
      error += Math.abs(Math.hypot(nx, ny) - 1);
      sectors.add(Math.floor((Math.atan2(ny, nx) + Math.PI) / (Math.PI * 2) * 12) % 12);
    }
    if (error / points.length < 0.1 && sectors.size >= 11) {
      const angle = Math.atan2((first.y - cy) / ry, (first.x - cx) / rx);
      return Array.from({ length: 129 }, (_, i) => ({
        x: cx + rx * Math.cos(angle + i * Math.PI * 2 / 128),
        y: cy + ry * Math.sin(angle + i * Math.PI * 2 / 128),
        p: 1,
      }));
    }
  }

  // Fit a mathematical cubic curve instead of retaining hand-drawn wobble.
  const step = Math.max(1, length / 500);
  let remaining = step;
  let sampled = [{ ...first, p: 1 }];
  for (let i = 1; i < points.length; i++) {
    let from = points[i - 1];
    const to = points[i];
    let segment = distance(from, to);
    while (segment >= remaining) {
      const ratio = remaining / segment;
      from = { x: from.x + (to.x - from.x) * ratio,
        y: from.y + (to.y - from.y) * ratio, p: 1 };
      sampled.push(from);
      segment = distance(from, to);
      remaining = step;
    }
    remaining -= segment;
  }
  sampled.push({ ...last, p: 1 });
  const fitCurve = (path, depth = 0) => {
    const a = path[0], b = path[path.length - 1];
    if (path.length < 4) return path;
    let aa = 0, ab = 0, bb = 0, ax = 0, ay = 0, bx = 0, by = 0;
    for (let i = 0; i < path.length; i++) {
      const t = i / (path.length - 1), u = 1 - t;
      const v = 3 * u * u * t, w = 3 * u * t * t;
      const x = path[i].x - u ** 3 * a.x - t ** 3 * b.x;
      const y = path[i].y - u ** 3 * a.y - t ** 3 * b.y;
      aa += v * v; ab += v * w; bb += w * w;
      ax += v * x; ay += v * y; bx += w * x; by += w * y;
    }
    const determinant = aa * bb - ab * ab;
    if (Math.abs(determinant) < 1e-9) return [a, b];
    const c = { x: (ax * bb - bx * ab) / determinant, y: (ay * bb - by * ab) / determinant };
    const d = { x: (bx * aa - ax * ab) / determinant, y: (by * aa - ay * ab) / determinant };
    const evaluate = t => {
      const u = 1 - t;
      return { x: u ** 3 * a.x + 3 * u * u * t * c.x + 3 * u * t * t * d.x + t ** 3 * b.x,
        y: u ** 3 * a.y + 3 * u * u * t * c.y + 3 * u * t * t * d.y + t ** 3 * b.y, p: 1 };
    };
    let error = 0;
    for (let i = 0; i < path.length; i++) error = Math.max(error,
      distance(path[i], evaluate(i / (path.length - 1))));
    if (error > Math.max(3, scale * 0.035) && depth < 4 && path.length > 12) {
      const middle = Math.floor(path.length / 2);
      return [...fitCurve(path.slice(0, middle + 1), depth + 1).slice(0, -1),
        ...fitCurve(path.slice(middle), depth + 1)];
    }
    return Array.from({ length: 65 }, (_, i) => evaluate(i / 64));
  };
  return fitCurve(sampled);
}

function beautifySelection() {
  const left = Math.min(selection.x, selection.x + selection.w);
  const right = Math.max(selection.x, selection.x + selection.w);
  const top = Math.min(selection.y, selection.y + selection.h);
  const bottom = Math.max(selection.y, selection.y + selection.h);
  const edits = [];
  if (right - left >= 4 && bottom - top >= 4) {
    for (const object of objects) {
      if (!["pen", "highlight"].includes(object.type) || !object.points?.length) continue;
      if (!object.points.every(point => point.x >= left && point.x <= right
          && point.y >= top && point.y <= bottom)) continue;
      const points = beautifyStroke(object.points);
      if (JSON.stringify(points) !== JSON.stringify(object.points)) edits.push({ object, points });
    }
  }
  if (edits.length) {
    // Join nearby endpoints when polygon edges were drawn as separate strokes.
    const endpoints = [];
    for (const edit of edits) {
      if (edit.points.length !== 2) continue;
      for (const point of edit.points) endpoints.push({ point, edit });
    }
    const used = new Set();
    for (let i = 0; i < endpoints.length; i++) {
      if (used.has(i)) continue;
      const group = [endpoints[i]];
      for (let j = i + 1; j < endpoints.length; j++) {
        if (used.has(j) || endpoints[j].edit === endpoints[i].edit) continue;
        const a = endpoints[i], b = endpoints[j];
        const edgeLength = edit => Math.hypot(edit.points[1].x - edit.points[0].x,
          edit.points[1].y - edit.points[0].y);
        const tolerance = Math.min(14, Math.min(edgeLength(a.edit), edgeLength(b.edit)) * 0.1);
        if (Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) <= tolerance) {
          group.push(b);
          used.add(j);
        }
      }
      if (group.length < 2) continue;
      const x = group.reduce((sum, entry) => sum + entry.point.x, 0) / group.length;
      const y = group.reduce((sum, entry) => sum + entry.point.y, 0) / group.length;
      for (const { point } of group) { point.x = x; point.y = y; }
    }
    snapshot();
    for (const { object, points } of edits) object.points = points;
    changed();
  }
  const message = edits.length
    ? `Đã nắn ${edits.length} nét vẽ trong vùng.`
    : "Kéo khoanh trọn nét bút cần nắn trên bảng.";
  $("selectionNote").textContent = message;
  $("selectionNote").hidden = false;
  toast(message);
}

function scratchPasses(points) {
  if (points.length < 12) return [];
  const box = bounds({ points });
  const axis = box.w >= box.h ? "x" : "y";
  const span = Math.max(box.w, box.h);
  if (span < 24) return [];
  const threshold = Math.max(10, span * 0.22);
  const passes = [];
  let direction = 0, peak = 0, begin = 0, length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    const change = points[i][axis] - points[peak][axis];
    if (!direction) {
      if (Math.abs(change) >= threshold) { direction = Math.sign(change); peak = i; }
    } else if (change * direction >= 0) {
      peak = i;
    } else if (Math.abs(change) >= threshold) {
      passes.push(points.slice(begin, peak + 1));
      begin = peak;
      direction *= -1;
      peak = i;
    }
  }
  if (direction && Math.abs(points[peak][axis] - points[begin][axis]) >= threshold) {
    passes.push(points.slice(begin, peak + 1));
  }
  return passes.length >= 5 && length >= span * 4 ? passes : [];
}

function eraseWithScratch(stroke) {
  const passes = scratchPasses(stroke.points);
  if (!passes.length) return false;
  const radius = Math.max(4, stroke.width || 3);
  const intersects = (pass, object) => {
    const box = bounds(object);
    for (let i = 1; i < pass.length; i++) {
      const a = pass[i - 1], b = pass[i];
      if (!segmentTouchesBounds(a, b, box, radius)) continue;
      if (object.points) {
        if (object.points.length === 1 && pointSegmentDistance(object.points[0], a, b) <= radius) return true;
        for (let j = 1; j < object.points.length; j++) {
          if (segmentDistance(a, b, object.points[j - 1], object.points[j])
              <= radius + (object.width || 3) / 2) return true;
        }
      } else {
        const inside = p => p.x >= box.x && p.x <= box.x + box.w
          && p.y >= box.y && p.y <= box.y + box.h;
        const corners = [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y },
          { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }];
        if (inside(a) || inside(b) || corners.some((corner, j) =>
          segmentsIntersect(a, b, corner, corners[(j + 1) % 4]))) return true;
      }
    }
    return false;
  };
  const targets = new Set();
  objects.forEach((object, index) => {
    if (!isInkObject(object)) return;
    let crossings = 0;
    for (const pass of passes) {
      if (intersects(pass, object)) crossings++;
      if (crossings >= 3) { targets.add(index); break; }
    }
  });
  if (!targets.size) {
    toast("Không có nét viết trong vùng gạch xóa.");
    return true;
  }
  snapshot();
  objects = objects.filter((_, index) => !targets.has(index));
  selected = -1;
  selection = null;
  toast(`Đã xóa ${targets.size} nét viết. Ctrl + Z để hoàn tác.`);
  return true;
}

function finish() {
  if (!dragging) return;

  dragging = false;
  let createdGeometry = false;

  if (start.pan) {
    saveLesson();
    return;
  }

  if (tool === "moveLasso") {
    if (start.groupMove) finishGroupMove();
    else {
      completeLasso();
      start = null;
      draw();
    }
    return;
  }

  if (tool === "eraser") {
    resizeHandle = null;
    active = null;

    if (start.eraserSnapshot) {
      changed();
    } else {
      draw();
    }

    start = null;
    return;
  }

  if (tool === "lasso" || tool === "aiRegion") {
    if (tool === "aiRegion") {
      if (Math.abs(selection.w) * view.z < 12 || Math.abs(selection.h) * view.z < 12) {
        selection = null;
        toast("Hãy khoanh vùng đủ lớn để chứa trọn đề bài.");
      } else if (window.boardAI) {
        window.boardAI.solveRegion({ ...selection });
      } else {
        toast("Công cụ AI chưa tải xong. Hãy tải lại trang.");
      }
    } else {
      beautifySelection();
    }
    active = null;
    start = null;
    draw();
    return;
  }

  if (active && tool !== "select") {
    if (tool === "pen" && active.points && eraseWithScratch(active)) {
      active = null;
      resizeHandle = null;
      start = null;
      changed();
      return;
    }
    if (!active.points && Math.abs(active.w) < 3) {
      active.w = 180;
      active.h = active.type === "ruler"
        ? 45
        : active.type === "protractor"
          ? 90
          : 120;
    }

    if (active.type === "protractor") {
      if (active.w < 0) active.x += active.w;
      active.w = Math.abs(active.w);
      active.h = active.w / 2;
      active.vertices = null;
      createdGeometry = true;
    }

    const vertices = active.type === "protractor"
      ? null
      : shapeVertices(active);

    if (vertices) {
      active.vertices = vertices;
      createdGeometry = true;
    }

    snapshot();
    objects.push(active);
  }

  resizeHandle = null;
  active = null;

  if (createdGeometry) {
    selected = objects.length - 1;
    chooseTool("select");
    $("toolStatus").textContent =
      "Hình học · Đã chọn hình, kéo các nút để tinh chỉnh";
  }

  changed();
}

function finishPointer(event) {
  touchPointers.delete(event.pointerId);
  if (paperGesture) {
    if (!touchPointers.size) {
      paperGesture = null;
      saveLesson();
    }
    return;
  }
  if (tool === "moveLasso" && dragging) {
    if (event.pointerId !== start.pointerId) return;
    if (event.type === "pointercancel") {
      if (start.groupMove) finishGroupMove(true);
      else {
        clearGroupSelection();
        start = null;
        dragging = false;
        draw();
      }
      return;
    }
    canvas.onpointermove(event);
  }
  finish();
}
canvas.onpointerup = finishPointer;
canvas.onpointercancel = finishPointer;
canvas.onpointerleave = () => {
  if (dragging || tool !== "eraser") return;

  eraserCursor = null;
  draw();
};

// =====================================================
// 8. ZOOM, NỀN BẢNG VÀ XÓA BẢNG
// =====================================================

function zoom(
  factor,
  point = { x: boardW / 2, y: boardH / 2 },
) {
  const anchor = world(point);
  view.fit = false;
  view.z = Math.max(0.1, Math.min(4, view.z * factor));
  view.x = point.x - anchor.x * view.z;
  view.y = point.y - anchor.y * view.z;
  draw();
}

function updateBoardScrollbar() {
  const rail = $("boardScroll");
  const thumb = $("boardScrollThumb");

  if (!rail || !thumb) return;

  const trackHeight = rail.firstElementChild.clientHeight;
  const worldOffset = -view.y;
  const range = scrollRange();
  thumb.style.height = `${Math.min(trackHeight, Math.max(32, trackHeight * boardH / (boardH + range)))}px`;
  const travel = Math.max(0, trackHeight - thumb.offsetHeight);
  const ratio = Math.max(
    0,
    Math.min(1, worldOffset / (range || 1)),
  );

  thumb.style.top = `${travel * ratio}px`;
  rail.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  rail.setAttribute(
    "aria-valuetext",
    $("pageStatus").textContent,
  );
}

$("boardScroll").onpointerdown = (event) => {
  const rail = event.currentTarget;
  const track = rail.firstElementChild;
  const thumb = $("boardScrollThumb");
  const trackRect = track.getBoundingClientRect();
  const travel = Math.max(1, trackRect.height - thumb.offsetHeight);

  if (event.target !== thumb) {
    const thumbTop = Math.max(
      0,
      Math.min(travel, event.clientY - trackRect.top - thumb.offsetHeight / 2),
    );
    const ratio = thumbTop / travel;
    view.y = -ratio * scrollRange();
    extendPaperForScroll();
    draw();
  }

  boardScrollDrag = {
    pointerId: event.pointerId,
    startY: event.clientY,
    startViewY: view.y,
    travel,
    range: scrollRange(),
  };

  rail.setPointerCapture(event.pointerId);
  event.preventDefault();
};

$("boardScroll").onpointermove = (event) => {
  if (!boardScrollDrag || event.pointerId !== boardScrollDrag.pointerId) return;

  const scale = boardScrollDrag.range / boardScrollDrag.travel;
  view.y = boardScrollDrag.startViewY -
    (event.clientY - boardScrollDrag.startY) * scale;
  extendPaperForScroll();
  draw();
};

function finishBoardScroll(event) {
  if (!boardScrollDrag || event.pointerId !== boardScrollDrag.pointerId) return;

  boardScrollDrag = null;
  saveLesson();
}

$("boardScroll").onpointerup = finishBoardScroll;
$("boardScroll").onpointercancel = finishBoardScroll;

$("boardScroll").onkeydown = (event) => {
  const direction = {
    ArrowDown: -1,
    PageDown: -1,
    ArrowUp: 1,
    PageUp: 1,
  }[event.key];

  if (!direction) return;

  event.preventDefault();
  view.y += direction * (event.key.startsWith("Page") ? boardH * 0.85 : 120);
  extendPaperForScroll();
  draw();
  saveLesson();
};

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();

    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? boardH : 1;
    if (event.ctrlKey || event.metaKey) {
      // Cap each wheel event and use a gentle curve for controllable zoom.
      const delta = Math.max(-80, Math.min(80, event.deltaY * unit));
      zoom(Math.exp(-delta * 0.001), screenPoint(event));
    } else {
      view.x -= (event.shiftKey ? event.deltaY : event.deltaX) * unit;
      if (!event.shiftKey) {
        view.y = Math.min(0, view.y - event.deltaY * unit);
        extendPaperForScroll();
      }
      draw();
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveLesson, 600);
  },
  { passive: false },
);

$("toggleSidebar").onclick = () => {
  const collapsed = document.body.classList.toggle("sidebar-collapsed");
  $("toggleSidebar").setAttribute("aria-expanded", String(!collapsed));
  resize();
};

$("resetView").onclick = () => {
  view = { x: 0, y: 0, z: 1, fit: true };
  draw();
  saveLesson();
};

$("zoomIn").onclick = () => { zoom(1.05); saveLesson(); };
$("zoomOut").onclick = () => { zoom(1 / 1.05); saveLesson(); };

$("addPageBtn").onclick = () => {
  if (pdfDocumentPages().length) return;
  snapshot();
  paperPageCount++;
  view.y = -paperPage(paperPageCount - 1).y * view.z + 60;
  changed();
  toast(`Đã thêm trang A4 số ${paperPageCount}.`);
};

// Template previews use the same painter as the board, AI captures and exports.
let paperDraft = null;
function renderPaperTemplates() {
  const grid = $("paperTemplateGrid");
  if (!grid.children.length) {
    for (const template of paperTemplates) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "paper-template";
      button.dataset.template = template.id;
      const preview = document.createElement("canvas");
      preview.width = 210;
      preview.height = 297;
      preview.setAttribute("aria-hidden", "true");
      const label = document.createElement("strong");
      label.textContent = template.name;
      button.append(preview, label);
      button.onclick = () => { paperDraft.background = template.id; renderPaperTemplates(); };
      grid.append(button);
    }
  }
  for (const button of grid.children) {
    button.setAttribute("aria-pressed", String(button.dataset.template === paperDraft.background));
    const context = button.firstElementChild.getContext("2d");
    context.save();
    context.scale(210 / paper.w, 297 / paper.h);
    paintPaper(context, { x: 0, y: 0, w: paper.w, h: paper.h }, false,
      button.dataset.template, paperDraft.color);
    context.restore();
  }
}

function renderPaperGallery() {
  const grid = $("paperPageGrid");
  grid.replaceChildren();
  const pdfPages = pdfDocumentPages();
  const count = pdfPages.length || paperPageCount;
  const current = Number($("pageStatus").textContent.match(/\d+/)?.[0]) - 1;
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const index = Number(entry.target.dataset.page);
      const page = pdfPages.length ? pdfPages[index] : paperPage(index);
      const preview = entry.target.querySelector("canvas");
      const context = preview.getContext("2d");
      context.scale(preview.width / page.w, preview.height / page.h);
      context.translate(-page.x, -page.y);
      paintPaper(context, page);
      context.beginPath();
      context.rect(page.x, page.y, page.w, page.h);
      context.clip();
      for (const object of objects) {
        const box = bounds(object);
        if (box.y + box.h + 24 >= page.y && box.y - 24 <= page.y + page.h) paintObject(context, object);
      }
      observer.unobserve(entry.target);
    }
  }, { root: $("paperPagesPanel"), rootMargin: "160px" });
  // Disconnect when the dialog closes or the gallery is rebuilt.
  paperGalleryObserver?.disconnect();
  paperGalleryObserver = observer;
  for (let index = 0; index < count; index++) {
    const page = pdfPages.length ? pdfPages[index] : paperPage(index);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "paper-page-card";
    button.dataset.page = String(index);
    button.setAttribute("aria-label", `Chuyển đến trang ${index + 1}`);
    if (index === current) button.setAttribute("aria-current", "page");
    const preview = document.createElement("canvas");
    preview.width = 180;
    preview.height = Math.round(180 * page.h / page.w);
    preview.setAttribute("aria-hidden", "true");
    preview.style.background = page.pdfBackground ? "#fff" : paperColor;
    const label = document.createElement("strong");
    label.textContent = `Trang ${index + 1}`;
    button.append(preview, label);
    button.onclick = () => {
      view.y = 60 - page.y * view.z;
      $("paperDialog").close();
      draw();
      saveLesson();
    };
    grid.append(button);
    observer.observe(button);
  }
  $("galleryAddPage").hidden = Boolean(pdfPages.length);
}
let paperGalleryObserver = null;

function selectPaperTab(pages) {
  $("paperTemplatesPanel").hidden = pages;
  $("paperPagesPanel").hidden = !pages;
  $("paperTemplatesTab").setAttribute("aria-selected", String(!pages));
  $("paperPagesTab").setAttribute("aria-selected", String(pages));
  $("paperTemplatesTab").tabIndex = pages ? -1 : 0;
  $("paperPagesTab").tabIndex = pages ? 0 : -1;
  $("applyPaperSettings").hidden = pages;
  $("cancelPaperSettings").textContent = pages ? "Đóng" : "Hủy";
  if (pages) renderPaperGallery();
}
$("paperSettingsBtn").onclick = () => {
  paperDraft = { background: paperBackground, color: paperColor };
  $("paperCustomColor").value = paperColor;
  $("paperColorPreset").value = [...$("paperColorPreset").options].some(option => option.value === paperColor)
    ? paperColor : "custom";
  renderPaperTemplates();
  selectPaperTab(Boolean(pdfDocumentPages().length));
  $("paperTemplatesTab").disabled = Boolean(pdfDocumentPages().length);
  $("paperDialog").showModal();
};
$("paperTemplatesTab").onclick = () => selectPaperTab(false);
$("paperPagesTab").onclick = () => selectPaperTab(true);
document.querySelector(".paper-tabs").onkeydown = event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  if ($("paperTemplatesTab").disabled) return;
  const pages = event.key === "End" || (event.key !== "Home" && $("paperPagesPanel").hidden);
  selectPaperTab(pages);
  $(pages ? "paperPagesTab" : "paperTemplatesTab").focus();
};
$("paperColorPreset").onchange = event => {
  if (event.target.value === "custom") { $("paperCustomColor").focus(); return; }
  paperDraft.color = event.target.value;
  $("paperCustomColor").value = paperDraft.color;
  renderPaperTemplates();
};
$("paperCustomColor").oninput = event => {
  paperDraft.color = event.target.value;
  $("paperColorPreset").value = "custom";
  renderPaperTemplates();
};
$("applyPaperSettings").onclick = () => {
  if (paperDraft.background !== paperBackground || paperDraft.color !== paperColor) {
    snapshot();
    paperBackground = paperDraft.background;
    paperColor = paperDraft.color;
    changed();
  }
  $("paperDialog").close();
};
$("closePaperDialog").onclick = $("cancelPaperSettings").onclick = () => $("paperDialog").close();
$("paperDialog").onclose = () => { paperGalleryObserver?.disconnect(); paperDraft = null; };
$("galleryAddPage").onclick = () => { $("addPageBtn").click(); renderPaperGallery(); };

function clearBoardInteraction() {
  clearGroupSelection();
  selected = -1;
  selection = null;
  active = null;
  start = null;
  dragging = false;
  resizeHandle = null;
  eraserCursor = null;
  $("selectionNote").hidden = true;
  window.boardAI?.clearRegion();
}

$("clearBtn").onclick = () => {
  if (!objects.length && paperPageCount === 1) return;
  if (!confirm("Xóa tất cả nét viết, ảnh và tài liệu trên bảng? Bạn có thể nhấn Hoàn tác để khôi phục.")) return;
  snapshot();
  fileImportRevision++;
  objects = [];
  paperPageCount = 1;
  view = { x: 0, y: 0, z: 1, fit: true };
  images.clear();
  clearBoardInteraction();
  changed();
  toast("Đã xóa tất cả. Bảng trở về một trang A4 trống.");
};

$("clearInkBtn").onclick = () => {
  if (!objects.some(isInkObject)) return;
  snapshot();
  objects = objects.filter(object => !isInkObject(object));
  clearBoardInteraction();
  changed();
  toast("Đã xóa toàn bộ nét viết và nét tô sáng. Ảnh và tài liệu được giữ nguyên.");
};

$("removeFilesBtn").onclick = () => {
  if (!objects.some(isUploadedObject)) return;
  snapshot();
  fileImportRevision++;
  objects = objects.filter(object => !isUploadedObject(object));
  images.clear();
  paperPageCount = contentPageCount();
  view = { x: 0, y: 0, z: 1, fit: true };
  clearBoardInteraction();
  changed();
  toast("Đã gỡ toàn bộ ảnh và file khỏi bảng. Ctrl + Z để hoàn tác.");
};

// =====================================================
// 9. CHÈN VĂN BẢN VÀ CÔNG THỨC
// =====================================================

function openText(point, formula = false, existing = null) {
  textAt = point;
  formulaMode = formula;
  editingText = existing;

  $("textTitle").textContent = existing ? "Sửa văn bản" : formula
    ? "Chèn công thức toán học"
    : "Chèn văn bản";

  $("textHelp").textContent = formula
    ? "Dùng các ký hiệu bên dưới để soạn công thức Unicode."
    : "Nhập nội dung bài giảng của bạn.";

  $("symbols").hidden = !formula;
  $("textValue").value = existing?.text || "";
  $("textSize").value = existing?.size || (formula ? 30 : 24);
  $("textColor").value = existing?.color || color;
  $("insertText").textContent = existing ? "Lưu thay đổi" : "Chèn lên bảng";
  updateTextPreview();

  $("textDialog").showModal();

  setTimeout(() => $("textValue").focus(), 20);
}

$("insertText").onclick = (event) => {
  event.preventDefault();

  const text = $("textValue").value.trim();

  if (!text) return;
  if (!$("textSize").reportValidity()) return;
  const size = Number($("textSize").value);

  snapshot();

  const properties = {
    type: "text",
    text,
    x: textAt.x,
    y: textAt.y,
    color: $("textColor").value,
    size,
    formula: formulaMode,
  };
  if (editingText && objects.includes(editingText)) {
    Object.assign(editingText, properties);
    selected = objects.indexOf(editingText);
  } else {
    objects.push(properties);
    selected = objects.length - 1;
  }
  selection = null;
  active = null;
  chooseTool("select");

  $("textDialog").close();
  changed();
  toast("Kéo văn bản đến vị trí mong muốn. Nhấp đúp để sửa chữ, cỡ và màu.");
};

function updateTextPreview() {
  const size = Number($("textSize").value);
  $("textValue").style.fontSize = `${Math.max(8, Math.min(200, size || 24))}px`;
  $("textValue").style.color = $("textColor").value;
  $("textValue").style.fontFamily = formulaMode ? "Cambria Math, Times New Roman, serif" : "Segoe UI, sans-serif";
}

$("textSize").oninput = updateTextPreview;
$("textColor").oninput = updateTextPreview;
canvas.ondblclick = event => {
  if (!["select", "text"].includes(tool)) return;
  const index = hit(world(screenPoint(event)));
  const object = objects[index];
  if (object?.type === "text") openText({ x: object.x, y: object.y }, object.formula, object);
};

const mathSymbols = [
  "x²", "x³", "√", "∑", "∫", "π",
  "α", "β", "θ", "≤", "≥", "≠",
  "∞", "±", "÷", "×", "→",
];

for (const symbol of mathSymbols) {
  const button = document.createElement("button");

  button.type = "button";
  button.textContent = symbol;

  button.onclick = () => {
    const input = $("textValue");

    input.setRangeText(
      symbol,
      input.selectionStart,
      input.selectionEnd,
      "end",
    );

    input.focus();
  };

  $("symbols").append(button);
}

$("formulaBtn").onclick = () => {
  openText(
    world({
      x: boardW * 0.35,
      y: boardH * 0.3,
    }),
    true,
  );
};

// =====================================================
// 10. PHÂN TÍCH BIỂU THỨC TOÁN HỌC
// Không dùng eval().
// =====================================================

function compileExpression(source) {
  if (typeof source !== "string" || source.length > 1000) {
    throw new Error("Biểu thức không hợp lệ.");
  }

  const normalized = source
    .trim()
    .replace(/^\s*(?:y|f\s*\(\s*x\s*\))\s*=\s*/i, "")
    .replace(/\s+/g, "")
    .toLowerCase();

  if (expressionCache.has(normalized)) {
    return expressionCache.get(normalized);
  }

  const tokens =
    normalized.match(
      /(?:\d*\.\d+|\d+\.?\d*)|(?:sin|cos|tan|sqrt|abs|log|exp|min|max)|[a-z]|[+\-*/^()]/g,
    ) || [];

  if (
    tokens.join("") !== normalized ||
    !tokens.length ||
    tokens.length > 200
  ) {
    throw new Error("Biểu thức không hợp lệ.");
  }

  let position = 0;

  const take = () => tokens[position++];
  const peek = () => tokens[position];

  function atom() {
    const token = take();

    if (token === "(") {
      const result = sum();

      if (take() !== ")") {
        throw new Error("Thiếu dấu đóng ngoặc.");
      }

      return result;
    }

    if (token === "x") {
      return (x, y) => x;
    }

    if (token === "y") {
      return (x, y) => y;
    }

    if (token === "pi") {
      return () => Math.PI;
    }

    if (token === "e") {
      return () => Math.E;
    }

    if (/^(sin|cos|tan|sqrt|abs|log|exp|min|max)$/.test(token || "")) {
      if (take() !== "(") {
        throw new Error("Hàm cần dấu ngoặc.");
      }

      const argument = sum();

      if (take() !== ")") {
        throw new Error("Thiếu dấu đóng ngoặc.");
      }

      return (x, y) => Math[token](argument(x, y));
    }

    if (
      token !== undefined &&
      /^(?:\d+\.?\d*|\.\d+)$/.test(token)
    ) {
      return () => Number(token);
    }

    throw new Error(
      "Kiểm tra biểu thức. Ví dụ: x^2 - 3*x + 2",
    );
  }

  function power() {
    const left = atom();

    if (peek() === "^") {
      take();

      const right = unary();

      return (x, y) => left(x, y) ** right(x, y);
    }

    return left;
  }

  function unary() {
    if (peek() === "+") {
      take();
      return unary();
    }

    if (peek() === "-") {
      take();

      const operand = unary();

      return (x, y) => -operand(x, y);
    }

    return power();
  }

  function product() {
    let result = unary();

    while (peek() === "*" || peek() === "/") {
      const operator = take();
      const left = result;
      const right = unary();

      result = (x, y) =>
        operator === "*"
          ? left(x, y) * right(x, y)
          : left(x, y) / right(x, y);
    }

    return result;
  }

  function sum() {
    let result = product();

    while (peek() === "+" || peek() === "-") {
      const operator = take();
      const left = result;
      const right = product();

      result = (x, y) =>
        operator === "+"
          ? left(x, y) + right(x, y)
          : left(x, y) - right(x, y);
    }

    return result;
  }

  const compiled = sum();

  if (position !== tokens.length) {
    throw new Error("Dùng dấu * khi nhân, ví dụ 3*x.");
  }

  expressionCache.set(normalized, compiled);

  return compiled;
}

function compileInequality(source) {
  const text = String(source || "").trim();
  const conditions = text.split(/[\n;]+/).map(value => value.trim()).filter(Boolean);
  if (conditions.length > 12) throw new Error("Nhập tối đa 12 bất phương trình trong một hệ.");
  if (conditions.length > 1) {
    const tests = conditions.map(compileInequality);
    return (x, y) => tests.every(test => test(x, y));
  }

  if (!text) {
    throw new Error("Nhập bất phương trình để vẽ miền nghiệm.");
  }

  const normalized = text
    .replace(/\s+/g, "")
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .toLowerCase();
  const match = normalized.match(/^(.+?)(>=|<=|>|<|==)(.+)$/);

  if (!match) {
    const fn = compileExpression(text);
    return (x, y) => y >= fn(x, y);
  }

  const [, leftText, operator, rightText] = match;
  const leftFn = compileExpression(leftText);
  const rightFn = compileExpression(rightText);

  return (x, y) => {
    const left = leftFn(x, y);
    const right = rightFn(x, y);

    switch (operator) {
      case ">=": return left >= right;
      case "<=": return left <= right;
      case ">": return left > right;
      case "<": return left < right;
      case "==": return Math.abs(left - right) < 1e-6;
      default: return false;
    }
  };
}

// =====================================================
// 11. VẼ ĐỒ THỊ HÀM SỐ
// =====================================================

function estimateVariationLimit(fn, direction) {
  const magnitudes = [100, 1000, 10000];
  const values = magnitudes.map((magnitude) =>
    fn(direction * magnitude, 0),
  );

  if (values.some(Number.isNaN)) {
    return { value: NaN, label: "không xác định" };
  }

  const finiteValues = values.filter(Number.isFinite);
  const latest = values[values.length - 1];

  if (!Number.isFinite(latest)) {
    const signSource = finiteValues[finiteValues.length - 1];
    const value = Math.sign(signSource || latest) * Infinity;
    return {
      value,
      label: value < 0 ? "−∞" : "+∞",
    };
  }

  const magnitudesOfValues = values.map(Math.abs);
  const sameSign = values.every(
    (value) => Math.sign(value) === Math.sign(latest),
  );
  const growsByScale =
    magnitudesOfValues[1] >= magnitudesOfValues[0] * 1.2 &&
    magnitudesOfValues[2] >= magnitudesOfValues[1] * 1.2 &&
    magnitudesOfValues[2] > 10;
  const growsSlowly =
    sameSign &&
    magnitudesOfValues[2] - magnitudesOfValues[1] > 0.15 &&
    magnitudesOfValues[1] - magnitudesOfValues[0] > 0.15 &&
    Math.abs(latest) > 2;

  if (growsByScale || growsSlowly) {
    const value = Math.sign(latest) * Infinity;
    return { value, label: value < 0 ? "−∞" : "+∞" };
  }

  const firstChange = Math.abs(values[1] - values[0]);
  const lastChange = Math.abs(values[2] - values[1]);
  const convergenceThreshold = Math.max(1e-3, Math.abs(latest) * 1e-3);
  const convergesToZero =
    magnitudesOfValues[2] < magnitudesOfValues[1] &&
    magnitudesOfValues[1] < magnitudesOfValues[0] &&
    magnitudesOfValues[2] < 0.5;

  if (
    convergesToZero ||
    (lastChange <= convergenceThreshold &&
      (firstChange === 0 || lastChange <= firstChange * 0.35))
  ) {
    const value = Math.abs(latest) < 1e-3 ? 0 : latest;
    return { value, label: formatVariationValue(value) };
  }

  return { value: NaN, label: "không có giới hạn" };
}

function analyzeVariation(expression) {
  const fn = compileExpression(expression);
  const derivative = (x) => {
    const delta = Math.max(1e-5, Math.abs(x) * 1e-5);
    const left = fn(x - delta, 0);
    const right = fn(x + delta, 0);

    if (!Number.isFinite(left) || !Number.isFinite(right)) return NaN;

    const slope = (right - left) / (2 * delta);
    return Number.isFinite(slope) ? slope : NaN;
  };
  const leftLimit = estimateVariationLimit(fn, -1);
  const rightLimit = estimateVariationLimit(fn, 1);

  if (Number.isNaN(leftLimit.value)) {
    throw new Error(`Giới hạn khi x → -∞ ${leftLimit.label}.`);
  }

  if (Number.isNaN(rightLimit.value)) {
    throw new Error(`Giới hạn khi x → +∞ ${rightLimit.label}.`);
  }

  const samplePoints = [];
  const linearSamples = 800;

  for (let sample = 0; sample <= linearSamples; sample++) {
    samplePoints.push(-100 + (200 * sample) / linearSamples);
  }

  for (let sample = 1; sample <= 400; sample++) {
    const magnitude = 100 * 100 ** (sample / 400);
    samplePoints.push(-magnitude, magnitude);
  }

  samplePoints.sort((left, right) => left - right);

  if (
    samplePoints.some(
      (point) =>
        Math.abs(point) <= 100 &&
        !Number.isFinite(fn(point, 0)),
    )
  ) {
    throw new Error("Hàm không xác định trên toàn trục số thực.");
  }

  const criticalPoints = [];
  let previousX = samplePoints[0];
  let previousSlope = derivative(previousX);

  for (let index = 1; index < samplePoints.length; index++) {
    const currentX = samplePoints[index];
    const currentSlope = derivative(currentX);

    if (
      Number.isFinite(currentSlope) &&
      Math.abs(currentSlope) < 1e-8 &&
      Number.isFinite(previousSlope) &&
      Math.abs(previousSlope) >= 1e-8
    ) {
      criticalPoints.push(currentX);
    } else if (
      Number.isFinite(previousSlope) &&
      Number.isFinite(currentSlope) &&
      previousSlope * currentSlope < 0
    ) {
      let low = previousX;
      let high = currentX;
      let lowSlope = previousSlope;

      for (let iteration = 0; iteration < 40; iteration++) {
        const middle = (low + high) / 2;
        const middleSlope = derivative(middle);

        if (!Number.isFinite(middleSlope)) break;

        if (Math.abs(middleSlope) < 1e-9) {
          low = middle;
          high = middle;
          break;
        }

        if (lowSlope * middleSlope <= 0) {
          high = middle;
        } else {
          low = middle;
          lowSlope = middleSlope;
        }
      }

      criticalPoints.push((low + high) / 2);
    }

    previousX = currentX;
    previousSlope = currentSlope;
  }

  const distinctCriticalPoints = criticalPoints
    .sort((left, right) => left - right)
    .filter((point, index, points) =>
      index === 0 || Math.abs(point - points[index - 1]) > 1e-3,
    );

  if (
    distinctCriticalPoints.some((point) => !Number.isFinite(fn(point, 0)))
  ) {
    throw new Error("Hàm không xác định tại một điểm tới hạn trong miền số thực.");
  }

  if (distinctCriticalPoints.length > 12) {
    throw new Error("Hàm có quá nhiều điểm cực trị để lập bảng gọn.");
  }

  const directions = [];

  for (let index = 0; index <= distinctCriticalPoints.length; index++) {
    const current = distinctCriticalPoints[index];
    const previous = distinctCriticalPoints[index - 1];
    const sampleX = distinctCriticalPoints.length === 0
      ? 0
      : current === undefined
        ? previous + Math.max(1, Math.abs(previous) * 0.1)
        : previous === undefined
          ? current - Math.max(1, Math.abs(current) * 0.1)
          : (previous + current) / 2;
    const slope = derivative(sampleX);

    if (!Number.isFinite(slope)) {
      throw new Error("Không xác định được dấu đạo hàm trên một khoảng.");
    }

    directions.push(Math.abs(slope) < 1e-8 ? "0" : slope > 0 ? "+" : "-");
  }

  return {
    valuesX: [-Infinity, ...distinctCriticalPoints, Infinity],
    valuesY: [
      leftLimit.label,
      ...distinctCriticalPoints.map((point) => fn(point, 0)),
      rightLimit.label,
    ],
    directions,
  };
}

function formatVariationValue(value) {
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(3)));
}

function paintVariationTable(context, object) {
  const { valuesX, valuesY, directions } = analyzeVariation(object.expression);
  const width = 540;
  const height = 210;
  const separator = 52;
  const firstX = 84;
  const lastX = width - 28;
  const columnWidth = (lastX - firstX) / (valuesX.length - 1);
  const xPosition = (index) => firstX + index * columnWidth;
  const xLabels = valuesX.map((value, index) => index === 0
    ? "−∞" : index === valuesX.length - 1 ? "+∞" : formatVariationValue(value));
  const yLabels = valuesY.map((value) => typeof value === "number" ? formatVariationValue(value) : value);
  const longestLabel = Math.max(...xLabels.map((v) => v.length), ...yLabels.map((v) => v.length));
  const fontSize = Math.max(10, Math.min(18, columnWidth / (longestLabel * 0.65)));
  // Place extrema high/low according to the derivative signs, not at one baseline.
  const valueHeight = (index) => {
    const before = directions[index - 1];
    const after = directions[index];
    if (index === 0) return after === "+" ? 192 : after === "-" ? 122 : 157;
    if (index === valuesY.length - 1) return before === "+" ? 122 : before === "-" ? 192 : 157;
    if (before === "+" && after === "-") return 122;
    if (before === "-" && after === "+") return 192;
    return 157;
  };

  context.save();
  context.translate(object.x, object.y);
  context.scale(object.w / width, object.h / height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#111111";
  context.fillStyle = "#111111";
  context.lineWidth = 1;
  context.setLineDash([]);
  context.strokeRect(3, 3, width - 6, height - 6);
  context.beginPath();
  context.moveTo(separator, 3);
  context.lineTo(separator, height - 3);
  for (const y of [54, 105]) {
    context.moveTo(3, y);
    context.lineTo(width - 3, y);
  }
  context.stroke();
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = 'italic 19px "Times New Roman", serif';
  context.fillText("x", separator / 2, 29);
  context.fillText("y′", separator / 2, 80);
  context.fillText("y", separator / 2, 157);
  context.font = `${fontSize}px "Times New Roman", serif`;

  for (let index = 0; index < valuesX.length; index++) {
    const x = xPosition(index);
    context.fillText(xLabels[index], x, 29);
    context.fillText(yLabels[index], x, valueHeight(index));
    if (index > 0 && index < valuesX.length - 1) context.fillText("0", x, 80);
    if (index >= directions.length) continue;
    const nextX = xPosition(index + 1);
    context.fillText(directions[index] === "-" ? "−" : directions[index], (x + nextX) / 2, 80);
    const y = valueHeight(index);
    const nextY = valueHeight(index + 1);
    const dx = nextX - x;
    const dy = nextY - y;
    const length = Math.hypot(dx, dy);
    const startGap = Math.min(length * 0.3, context.measureText(yLabels[index]).width / 2 + 12);
    const endGap = Math.min(length * 0.3, context.measureText(yLabels[index + 1]).width / 2 + 12);
    const startX = x + dx * startGap / length;
    const startY = y + dy * startGap / length;
    const endX = nextX - dx * endGap / length;
    const endY = nextY - dy * endGap / length;
    context.beginPath();
    context.moveTo(startX, startY);
    context.lineTo(endX, endY);
    context.stroke();
    const angle = Math.atan2(dy, dx);
    context.beginPath();
    context.moveTo(endX, endY);
    context.lineTo(endX - 6 * Math.cos(angle - 0.35), endY - 6 * Math.sin(angle - 0.35));
    context.lineTo(endX - 6 * Math.cos(angle + 0.35), endY - 6 * Math.sin(angle + 0.35));
    context.closePath();
    context.fill();
  }
  context.restore();
}
function paintInequalityRegion(context, object, test, color) {
  const cellSize = 2;
  const unit = 50;
  context.save();
  context.beginPath();
  let hasRegion = false;
  for (let py = 0; py < object.h; py += cellSize) {
    let runStart = null;
    for (let px = 0; px <= object.w; px += cellSize) {
      const inside = px < object.w && !test((px + 1 - object.w / 2) / unit,
        (object.h / 2 - py - 1) / unit);
      if (inside && runStart === null) runStart = px;
      if (!inside && runStart !== null) {
        context.rect(object.x + runStart, object.y + py, px - runStart, cellSize);
        runStart = null;
        hasRegion = true;
      }
    }
    if (runStart !== null) {
      context.rect(object.x + runStart, object.y + py, object.w - runStart, cellSize);
      hasRegion = true;
    }
  }
  context.clip();
  context.strokeStyle = "#000000";
  context.lineWidth = 0.8;
  context.setLineDash([]);
  context.beginPath();
  for (let offset = -object.h; offset < object.w; offset += 10) {
    context.moveTo(object.x + offset, object.y + object.h);
    context.lineTo(object.x + offset + object.h, object.y);
  }
  context.stroke();
  context.restore();
  const conditions = object.expression.split(/[\n;]+/).map(value => value.trim()).filter(Boolean);
  conditions.forEach((condition, index) => {
    const boundaryTest = compileInequality(condition);
    const strict = /(?:^|[^<>=])(?:<|>)(?!=)/.test(condition);
    context.strokeStyle = "#000000";
    context.lineWidth = 2;
    context.lineCap = 'round';
    context.setLineDash(strict ? [8, 5] : []);
    // Marching squares follows vertical, horizontal and curved boundaries alike.
    const step = 5;
    const inside = point => boundaryTest((point.x - object.w / 2) / unit,
      (object.h / 2 - point.y) / unit);
    const segments = [];
    context.beginPath();
    for (let y = 0; y < object.h; y += step) {
      for (let x = 0; x < object.w; x += step) {
        const corners = [{x,y}, {x:Math.min(x+step,object.w),y},
          {x:Math.min(x+step,object.w),y:Math.min(y+step,object.h)},
          {x,y:Math.min(y+step,object.h)}];
        const values = corners.map(inside);
        const crossings = [];
        for (let edge = 0; edge < 4; edge++) {
          const next = (edge + 1) % 4;
          if (values[edge] === values[next]) continue;
          let a = corners[edge], b = corners[next];
          for (let iteration = 0; iteration < 8; iteration++) {
            const midpoint = {x:(a.x+b.x)/2,y:(a.y+b.y)/2};
            if (inside(midpoint) === values[edge]) a = midpoint;
            else b = midpoint;
          }
          crossings.push({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
        }
        for (let i = 0; i + 1 < crossings.length; i += 2) {
          segments.push([crossings[i], crossings[i + 1]]);
        }
      }
    }
    // Connect cell segments so dash lengths continue along the entire contour.
    const key = point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    const links = new Map();
    segments.forEach((segment, id) => segment.forEach(point => {
      const location = key(point);
      if (!links.has(location)) links.set(location, []);
      links.get(location).push(id);
    }));
    const visited = new Set();
    const trace = (id, from) => {
      context.moveTo(object.x + from.x, object.y + from.y);
      while (!visited.has(id)) {
        visited.add(id);
        const segment = segments[id];
        const to = key(segment[0]) === key(from) ? segment[1] : segment[0];
        context.lineTo(object.x + to.x, object.y + to.y);
        const next = links.get(key(to)).find(candidate => !visited.has(candidate));
        if (next === undefined) break;
        id = next;
        from = to;
      }
    };
    segments.forEach((segment, id) => {
      if (visited.has(id)) return;
      const endpoint = segment.find(point => links.get(key(point)).length === 1);
      if (endpoint) trace(id, endpoint);
    });
    segments.forEach((segment, id) => { if (!visited.has(id)) trace(id, segment[0]); });
    context.stroke();
    context.setLineDash([]);
  });
  return hasRegion;
}

function paintInequalityAxes(context, object) {
  const unit = 50;
  const cx = object.x + object.w / 2;
  const cy = object.y + object.h / 2;
  context.save();
  context.setLineDash([]);
  context.strokeStyle = "#000000";
  context.fillStyle = "#000000";
  context.lineWidth = 2.4;
  context.beginPath();
  context.moveTo(object.x + 8, cy);
  context.lineTo(object.x + object.w - 10, cy);
  context.moveTo(cx, object.y + object.h - 8);
  context.lineTo(cx, object.y + 10);
  context.stroke();
  context.beginPath();
  context.moveTo(object.x + object.w - 8, cy);
  context.lineTo(object.x + object.w - 18, cy - 5);
  context.lineTo(object.x + object.w - 18, cy + 5);
  context.closePath();
  context.moveTo(cx, object.y + 8);
  context.lineTo(cx - 5, object.y + 18);
  context.lineTo(cx + 5, object.y + 18);
  context.closePath();
  context.fill();
  context.font = "600 12px Segoe UI";
  const label = (text, x, y) => {
    context.strokeStyle = "#ffffff";
    context.lineWidth = 4;
    context.strokeText(text, x, y);
    context.fillText(text, x, y);
  };
  context.textAlign = "center";
  for (let n = Math.ceil(-object.w / (2 * unit)); n <= Math.floor(object.w / (2 * unit)); n++) {
    const x = cx + n * unit;
    if (!n || x < object.x + 22 || x > object.x + object.w - 28) continue;
    context.strokeStyle = "#000000";
    context.lineWidth = 1.5;
    context.beginPath(); context.moveTo(x, cy - 4); context.lineTo(x, cy + 4); context.stroke();
    label(String(n), x, cy + 19);
  }
  context.textAlign = "right";
  for (let n = Math.ceil(-object.h / (2 * unit)); n <= Math.floor(object.h / (2 * unit)); n++) {
    const y = cy - n * unit;
    if (!n || y < object.y + 28 || y > object.y + object.h - 18) continue;
    context.strokeStyle = "#000000";
    context.lineWidth = 1.5;
    context.beginPath(); context.moveTo(cx - 4, y); context.lineTo(cx + 4, y); context.stroke();
    label(String(n), cx - 9, y + 4);
  }
  label("0", cx - 9, cy + 19);
  context.textAlign = "left";
  label("x", object.x + object.w - 19, cy - 10);
  label("y", cx + 10, object.y + 18);
  context.restore();
}

function paintCoordinateAxes(context, object) {
  const is3D = object.kind === "oxyz";
  const dark = document.body.dataset.theme === "dark";
  context.save();
  context.translate(object.x, object.y);
  context.fillStyle = dark ? "#111b2c" : "#ffffff";
  context.fillRect(0, 0, object.w, object.h);
  context.strokeStyle = dark ? "#334155" : "#dce7fd";
  context.lineWidth = 1;
  context.strokeRect(0, 0, object.w, object.h);
  const origin = { x: object.w * (is3D ? 0.47 : 0.5), y: object.h * (is3D ? 0.62 : 0.5) };
  const unit = Math.min(object.w, object.h) / 12;
  if (!is3D) {
    context.strokeStyle = dark ? "#25354a" : "#edf1f8";
    context.beginPath();
    for (let n = -5; n <= 5; n++) {
      context.moveTo(origin.x + n * unit, 25);
      context.lineTo(origin.x + n * unit, object.h - 25);
      context.moveTo(25, origin.y + n * unit);
      context.lineTo(object.w - 25, origin.y + n * unit);
    }
    context.stroke();
  }
  const axes = is3D
    ? [{ label: "x", dx: -0.8, dy: 0.58, length: 4, color: "#e66772" },
       { label: "y", dx: 1, dy: 0, length: 5, color: "#42ab83" },
       { label: "z", dx: 0, dy: -1, length: 6, color: "#668dff" }]
    : [{ label: "x", dx: 1, dy: 0, length: 6, color: dark ? "#b5c8eb" : "#384c75" },
       { label: "y", dx: 0, dy: -1, length: 5, color: dark ? "#b5c8eb" : "#384c75" }];
  context.font = is3D ? "600 14px Segoe UI" : "13px Segoe UI";
  for (const axis of axes) {
    const endX = origin.x + axis.dx * unit * axis.length;
    const endY = origin.y + axis.dy * unit * axis.length;
    context.strokeStyle = axis.color;
    context.fillStyle = axis.color;
    context.lineWidth = is3D ? 3 : 1.6;
    context.setLineDash(is3D ? [4, 4] : []);
    context.beginPath();
    context.moveTo(origin.x - axis.dx * unit * (is3D ? 2 : axis.length), origin.y - axis.dy * unit * (is3D ? 2 : axis.length));
    context.lineTo(origin.x, origin.y);
    context.stroke();
    context.setLineDash([]);
    context.beginPath();
    context.moveTo(origin.x, origin.y);
    context.lineTo(endX, endY);
    context.stroke();
    const angle = Math.atan2(axis.dy, axis.dx);
    context.beginPath();
    context.moveTo(endX, endY);
    context.lineTo(endX - 10 * Math.cos(angle - 0.4), endY - 10 * Math.sin(angle - 0.4));
    context.lineTo(endX - 10 * Math.cos(angle + 0.4), endY - 10 * Math.sin(angle + 0.4));
    context.closePath();
    context.fill();
    context.fillText(axis.label, endX + 8, endY + 4);
    for (let n = is3D ? 1 : -axis.length + 1; n < axis.length; n++) {
      if (!n) continue;
      const x = origin.x + axis.dx * unit * n;
      const y = origin.y + axis.dy * unit * n;
      context.beginPath();
      context.moveTo(x - axis.dy * 3, y + axis.dx * 3);
      context.lineTo(x + axis.dy * 3, y - axis.dx * 3);
      context.stroke();
      context.fillText(String(n), x + 5, y + 15);
    }
  }
  context.fillStyle = dark ? "#dbe6fa" : "#384c75";
  context.fillText("O", origin.x - 15, origin.y + 17);
  context.font = "600 14px Segoe UI";
  context.fillText(is3D ? "Hệ trục Oxyz" : "Hệ trục Oxy", 14, 20);
  context.restore();
}

function paintGraph(context, object) {
  if (object.kind === "oxy" || object.kind === "oxyz") {
    paintCoordinateAxes(context, object);
    return;
  }
  if (object.kind === "variation") {
    paintVariationTable(context, object);
    return;
  }

  const color = object.color || "#245bea";
  const fn = object.kind === "inequality"
    ? compileInequality(object.expression)
    : compileExpression(object.expression);

  context.fillStyle = "white";
  context.fillRect(object.x, object.y, object.w, object.h);

  context.strokeStyle = "#dce5f6";
  context.lineWidth = 1;
  context.strokeRect(object.x, object.y, object.w, object.h);

  context.save();
  context.beginPath();
  context.rect(object.x + 1, object.y + 1, object.w - 2, object.h - 2);
  context.clip();

  const centerX = object.x + object.w / 2;
  const centerY = object.y + object.h / 2;
  const gridUnit = object.kind === "inequality" ? 50 : 30;

  for (let i = -10; i <= 10; i++) {
    if (object.kind === "inequality") continue;
    context.strokeStyle = object.kind === "inequality" ? "rgba(0, 0, 0, 0.12)" : i === 0 ? "#8798b3" : "#edf0f7";
    context.beginPath();

    context.moveTo(centerX + i * gridUnit, object.y);
    context.lineTo(centerX + i * gridUnit, object.y + object.h);

    context.moveTo(object.x, centerY + i * gridUnit);
    context.lineTo(object.x + object.w, centerY + i * gridUnit);

    context.stroke();

    if (object.kind !== "inequality" && i !== 0 && i % 2 === 0) {
      context.fillStyle = "#94a2b8";
      context.font = "10px Arial";
      context.fillText(i, centerX + i * 30 + 3, centerY + 13);
      context.fillText(-i, centerX + 5, centerY + i * 30);
    }
  }

  if (object.kind === "inequality") {
    paintInequalityRegion(context, object, fn, color);
    paintInequalityAxes(context, object);
  } else {
    context.strokeStyle = color;
    context.lineWidth = 2.5;
    context.beginPath();

    let lastY = null;

    for (let pixelX = 0; pixelX <= object.w; pixelX++) {
      const value = fn((pixelX - object.w / 2) / 30, 0);
      const y = centerY - value * 30;

      if (
        !Number.isFinite(y) ||
        Math.abs(y - centerY) > object.h * 5
      ) {
        lastY = null;
        continue;
      }

      if (lastY === null || Math.abs(y - lastY) > object.h) {
        context.moveTo(object.x + pixelX, y);
      } else {
        context.lineTo(object.x + pixelX, y);
      }

      lastY = y;
    }

    context.stroke();
  }

  context.font = "15px Segoe UI";

  const conditions = object.expression.split(/[\n;]+/).map(value => value.trim()).filter(Boolean);
  const labels = object.kind === "inequality"
    ? conditions.map(condition => condition.replace(/>=/g, "≥").replace(/<=/g, "≤").replace(/\*/g, "·"))
    : [`y = ${object.expression}`];
  const label = labels[0];
  let labelX = object.x + 18;
  let labelY = object.y + 28;
  if (object.kind === "inequality") {
    context.font = 'italic 16px "Times New Roman", serif';
    const width = Math.min(object.w - 36, Math.max(...labels.map(text => context.measureText(text).width)) + 12);
    const height = labels.length * 20 + 8;
    // Put the annotation in the unhatched solution area, away from the axes.
    findLabel: for (let y = 40; y < object.h - height - 12; y += 20) {
      for (let x = 20; x < object.w - width - 12; x += 20) {
        if (x < object.w / 2 + 16 && x + width > object.w / 2 - 16) continue;
        if (y < object.h / 2 + 20 && y + height > object.h / 2 - 12) continue;
        let fits = true;
        for (const dx of [0, width / 2, width]) {
          for (const dy of [0, height / 2, height]) {
            if (!fn((x + dx - object.w / 2) / 50, (object.h / 2 - y - dy) / 50)) fits = false;
          }
        }
        if (fits) { labelX = object.x + x; labelY = object.y + y + 16; break findLabel; }
      }
    }
  }

  if (object.kind === "inequality") {
    context.lineJoin = "round";
    context.lineWidth = 4;
    context.strokeStyle = "rgba(255, 255, 255, 0.95)";
    labels.forEach((text, index) => context.strokeText(text, labelX, labelY + index * 20));
  } else {
    context.fillStyle = "white";
    context.fillRect(
      object.x + 10,
      object.y + 9,
      object.w - 20,
      27,
    );
  }

  context.fillStyle = color;
  labels.forEach((text, index) => {
    context.fillStyle = object.kind === "inequality"
      ? "#000000" : color;
    context.fillText(text, labelX, labelY + index * 20);
  });

  context.restore();
}

function addGraph(expression, kind = $("graphType").value) {
  if (kind === "inequalitySystem") kind = "inequality";
  const rawExpression = String(expression || "").trim();
  const normalizedExpression = ["oxy", "oxyz"].includes(kind)
    ? ""
    : kind === "inequality"
    ? rawExpression
    : rawExpression.replace(/^\s*(?:y|f\s*\(\s*x\s*\))\s*=\s*/i, "");

  if (kind === "oxy" || kind === "oxyz") {
    // Coordinate systems do not require an expression.
  } else if (kind === "inequality") {
    compileInequality(normalizedExpression);
  } else if (kind === "variation") {
    analyzeVariation(normalizedExpression);
  } else {
    compileExpression(normalizedExpression);
  }

  const point = world({
    x: boardW * 0.25,
    y: boardH * 0.18,
  });

  snapshot();

  objects.push({
    type: "graph",
    kind,
    expression: normalizedExpression,
    x: point.x,
    y: point.y,
    w: kind === "variation" ? 540 : kind === "inequality" ? 560 : 420,
    h: kind === "variation" ? 210 : kind === "inequality" ? 420 : 320,
    color,
  });

  changed();
  chooseTool("select");

  toast(
    ["oxy", "oxyz"].includes(kind)
      ? `Đã chèn hệ trục ${kind === "oxyz" ? "Oxyz" : "Oxy"}. Kéo để di chuyển.`
      : kind === "inequality"
      ? "Đã chèn bất phương trình và miền nghiệm."
      : kind === "variation"
        ? "Đã chèn bảng biến thiên từ -∞ đến +∞."
        : "Đã chèn đồ thị. Kéo để di chuyển; rê chuột để xem tọa độ.",
  );

  return objects.length;
}

function syncGraphInputs() {
  const isAxes = ["oxy", "oxyz"].includes($("graphType").value);
  const isSystem = $("graphType").value === "inequalitySystem";
  const isInequality = $("graphType").value === "inequality" || isSystem;
  const isVariation = $("graphType").value === "variation";

  $("graphInputLabel").textContent = isSystem ? "Hệ bất phương trình (mỗi dòng một điều kiện)" : isInequality
    ? "Bất phương trình"
    : isVariation
      ? "Hàm số f(x)"
      : "Hàm số";
  $("graphPrefix").textContent = isInequality
    ? "⇢"
    : isVariation
      ? "f(x) ="
      : "y =";
  $("graphInputLabel").hidden = isAxes;
  $("functionInput").parentElement.hidden = isInequality || isAxes;
  $("inequalityInput").parentElement.hidden = !isInequality || isSystem;
  $("inequalitySystemWrap").hidden = !isSystem;
  $("graphPresets").hidden = isInequality || isAxes;
  $("inequalityPresets").hidden = !isInequality || isSystem;
  $("graphBtn").textContent = isAxes
    ? `+ Chèn hệ trục ${$("graphType").value === "oxyz" ? "Oxyz" : "Oxy"}`
    : isSystem ? "+ Chèn miền nghiệm của hệ" : isVariation
    ? "+ Chèn bảng biến thiên"
    : "+ Chèn đồ thị";

  if (isAxes) {
    $("graphHint").textContent = $("graphType").value === "oxyz"
      ? "Hệ trục không gian x, y, z được minh họa trên bảng 2D. Kéo để di chuyển hoặc thay đổi kích thước."
      : "Chèn hệ trục x, y có lưới và vạch chia để vẽ, ghi chú lên bảng.";
  } else if (isSystem) {
    $("graphHint").textContent = "Mỗi dòng một bất phương trình, tối đa 12 điều kiện. Phần trắng là miền nghiệm chung, phần bị loại được gạch chéo. Biên nét liền cho ≤, ≥, nét đứt cho <, >. Mỗi vạch bằng 1 đơn vị.";
  } else if (isInequality) {
    $("graphHint").textContent = "Ví dụ: x + 2*y < 4. Phần trắng là miền nghiệm, phần bị loại được gạch chéo; mỗi vạch trục bằng 1 đơn vị.";
  } else if (isVariation) {
    $("graphHint").textContent = "Xét giới hạn tại ±∞, điểm cực trị và chiều biến thiên của hàm số.";
  } else {
    $("graphHint").textContent = "Hỗ trợ x, + − * / ^, sin, cos, tan, sqrt, abs.";
  }
}

$("graphType").onchange = syncGraphInputs;

$("graphBtn").onclick = () => {
  const kind = $("graphType").value;
  const expression = kind === "inequalitySystem" ? $("inequalitySystemInput").value : kind === "inequality"
    ? $("inequalityInput").value
    : $("functionInput").value;

  try {
    addGraph(expression, kind);

    $("graphHint").textContent =
      kind === "inequality"
        ? "Đã chèn miền nghiệm. Chọn công cụ mũi tên để di chuyển."
        : kind === "variation"
          ? "Đã chèn bảng biến thiên từ -∞ đến +∞. Chọn công cụ mũi tên để di chuyển."
          : "Đã chèn. Chọn công cụ mũi tên để di chuyển.";

    $("graphHint").style.color = "";
  } catch (error) {
    $("graphHint").textContent = error.message;
    $("graphHint").style.color = "#d45563";
  }
};

document.querySelectorAll("[data-formula]").forEach((button) => {
  button.onclick = () => {
    $("functionInput").value = button.dataset.formula;
  };
});

document.querySelectorAll("[data-inequality]").forEach((button) => {
  button.onclick = () => {
    $("inequalityInput").value = button.dataset.inequality;
  };
});

syncGraphInputs();

// =====================================================
// 12. CHÈN HÌNH ẢNH
// =====================================================

$("imageBtn").onclick = () => $("imageInput").click();

function insertImageFile(file) {
  const isImage = file.type.startsWith("image/");

  if (!isImage) {
    insertDocumentFile(file);
    return;
  }

  const importRevision = fileImportRevision;
  const reader = new FileReader();

  reader.onload = () => {
    if (importRevision !== fileImportRevision) return;
    const image = new Image();

    image.onload = () => {
      if (importRevision !== fileImportRevision) return;
      const scale = Math.min(
        1,
        1200 / image.width,
        1200 / image.height,
      );

      const temporaryCanvas = document.createElement("canvas");

      temporaryCanvas.width = Math.max(
        1,
        Math.round(image.width * scale),
      );

      temporaryCanvas.height = Math.max(
        1,
        Math.round(image.height * scale),
      );

      temporaryCanvas.getContext("2d").drawImage(
        image,
        0,
        0,
        temporaryCanvas.width,
        temporaryCanvas.height,
      );

      const src = temporaryCanvas.toDataURL("image/png");
      const size = Math.min(450, temporaryCanvas.width);

      const point = world({
        x: boardW * 0.3,
        y: boardH * 0.2,
      });

      snapshot();

      objects.push({
        type: "image",
        src,
        x: point.x,
        y: point.y,
        w: size,
        h: (size * temporaryCanvas.height) / temporaryCanvas.width,
      });

      changed();
      chooseTool("select");
    };

    image.onerror = () => {
      toast("Không đọc được hình ảnh này.");
    };

    image.src = reader.result;
  };

  reader.onerror = () => toast("Không đọc được tệp ảnh.");
  reader.readAsDataURL(file);
}

function insertDocumentFile(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    window.boardPDF.open(file);
    return;
  }
  const point = world({
    x: boardW * 0.3,
    y: boardH * 0.2,
  });

  snapshot();

  objects.push({
    type: "document",
    name: file.name,
    mime: file.type || "application/octet-stream",
    src: file.type === "application/pdf" ? URL.createObjectURL(file) : "",
    x: point.x,
    y: point.y,
    w: 240,
    h: 160,
  });

  changed();
  chooseTool("select");
  toast("Đã chèn tài liệu lên bảng.");
}

$("imageInput").onchange = (event) => {
  const file = event.target.files[0];

  if (!file) return;

  const isImage = file.type.startsWith("image/");
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);

  const fileLimitMB = isPdf ? 50 : 8;
  if (file.size > fileLimitMB * 1024 * 1024 && (isImage || isPdf)) {
    toast(`Chọn ${isPdf ? "PDF" : "ảnh"} không quá ${fileLimitMB} MB.`);
    event.target.value = "";
    return;
  }

  if (isPdf || (!isImage && !isPdf)) {
    insertDocumentFile(file);
    event.target.value = "";
    return;
  }

  insertImageFile(file);
  event.target.value = "";
};

window.addEventListener("paste", (event) => {
  const target = event.target;

  if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) {
    return;
  }

  const clipboardItems = event.clipboardData?.items || [];

  for (const item of clipboardItems) {
    if (item.kind !== "file") continue;

    const file = item.getAsFile();

    if (!file) continue;

    event.preventDefault();

    if (file.type.startsWith("image/")) {
      insertImageFile(file);
      toast("Đã dán ảnh từ clipboard lên bảng.");
    } else if (
      file.type === "application/pdf" ||
      /\.(pdf|txt|md|csv|json|doc|docx|ppt|pptx)$/i.test(file.name)
    ) {
      insertDocumentFile(file);
      toast("Đã dán tài liệu từ clipboard lên bảng.");
    }

    return;
  }

  const fileList = event.clipboardData?.files;

  if (!fileList || !fileList.length) return;

  const file = fileList[0];

  if (!file) return;

  event.preventDefault();

  if (file.type.startsWith("image/")) {
    insertImageFile(file);
    toast("Đã dán ảnh từ clipboard lên bảng.");
  } else if (
    file.type === "application/pdf" ||
    /\.(pdf|txt|md|csv|json|doc|docx|ppt|pptx)$/i.test(file.name)
  ) {
    insertDocumentFile(file);
    toast("Đã dán tài liệu từ clipboard lên bảng.");
  }
});

// =====================================================
// 13. XUẤT ẢNH VÀ TẢI BÀI GIẢNG
// =====================================================

function download(data, name) {
  const link = document.createElement("a");

  link.href = data;
  link.download = name;

  document.body.append(link);
  link.click();
  link.remove();
}

async function prepareLessonImages(items) {
  for (const item of items) {
    if (item.type !== "image") continue;
    let image = images.get(item.src);
    if (!image) { image = new Image(); image.src = item.src; images.set(item.src, image); }
    await image.decode();
  }
}

function renderPaperPage(page, items = objects, background = paperBackground,
  surfaceColor = paperColor) {
  const output = document.createElement("canvas");
  const scale = Math.min(2, 4096 / Math.max(page.w, page.h));
  output.width = Math.ceil(page.w * scale);
  output.height = Math.ceil(page.h * scale);
  const context = output.getContext("2d");
  context.scale(output.width / page.w, output.height / page.h);
  context.translate(-page.x, -page.y);
  paintPaper(context, page, false, background, surfaceColor);
  context.beginPath();
  context.rect(page.x, page.y, page.w, page.h);
  context.clip();
  items.forEach(item => {
    const box = bounds(item);
    const padding = (item.width || 0) * 6;
    if (box.y + box.h + padding >= page.y && box.y - padding <= page.y + page.h
      && box.x + box.w + padding >= page.x && box.x - padding <= page.x + page.w) {
      paintObject(context, item);
    }
  });
  return output;
}

$("exportBtn").onclick = async () => {
  const button = $("exportBtn");
  if (button.disabled) return;
  button.disabled = true;
  const items = JSON.parse(JSON.stringify(objects));
  const background = paperBackground;
  const surfaceColor = paperColor;
  const pdfPages = items.filter(item => item.pdfBackground);
  const centerY = (boardH / 2 - view.y) / view.z;
  const index = pdfPages.length
    ? Math.max(0, pdfPages.findIndex(page => page.y + page.h > centerY))
    : Math.max(0, Math.min(paperPageCount - 1,
      Math.floor((centerY - paper.top) / (paper.h + paper.gap))));
  const page = pdfPages.length ? pdfPages[index] : paperPage(index);
  try {
    await prepareLessonImages(items);
    const output = renderPaperPage(page, items, background, surfaceColor);
    download(output.toDataURL("image/png"), `bai-giang-trang-${index + 1}.png`);
    toast(`Đã xuất ảnh toàn bộ trang ${index + 1}.`);
  } catch (error) {
    toast(`Không xuất được ảnh: ${error.message}`);
  } finally {
    button.disabled = false;
  }
};

function buildLessonPDF(pages) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [0];
  let position = 0;
  const append = value => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    chunks.push(bytes);
    position += bytes.length;
  };
  const object = (id, body, stream = null) => {
    offsets[id] = position;
    append(`${id} 0 obj\n${body}\n`);
    if (stream) { append("stream\n"); append(stream); append("\nendstream\n"); }
    append("endobj\n");
  };
  append("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] >>`);
  pages.forEach((page, i) => {
    const id = 3 + i * 3;
    const jpeg = Uint8Array.from(atob(page.data.split(",")[1]), character => character.charCodeAt(0));
    const scale = Math.min(595.28 / page.width, 841.89 / page.height);
    const width = page.width * scale, height = page.height * scale;
    const content = encoder.encode(`q\n${width} 0 0 ${height} ${(595.28 - width) / 2} ${(841.89 - height) / 2} cm\n/Board Do\nQ\n`);
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Board ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`);
    object(id + 1, `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
    object(id + 2, `<< /Length ${content.length} >>`, content);
  });
  const xref = position;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (let i = 1; i < offsets.length; i++) append(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: "application/pdf" });
}

async function exportLessonPDF() {
  const lessonObjects = JSON.parse(JSON.stringify(objects));
  const background = paperBackground;
  const surfaceColor = paperColor;
  if (!lessonObjects.length) throw new Error("Tài liệu chưa có nội dung để lưu PDF.");
  const pdfPages = lessonObjects.filter(item => item.pdfBackground);
  // Ignore trailing blank pages created while scrolling. Preserve blank pages between content.
  const count = pdfPages.length || contentPageCount(lessonObjects);
  await prepareLessonImages(lessonObjects);
  const pages = [];
  for (let index = 0; index < count; index++) {
    const page = pdfPages.length ? pdfPages[index] : paperPage(index);
    const output = renderPaperPage(page, lessonObjects, background, surfaceColor);
    pages.push({ data: output.toDataURL("image/jpeg", 0.95), width: output.width, height: output.height });
    output.width = output.height = 0;
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  return buildLessonPDF(pages);
}

$("saveBtn").onclick = async () => {
  const button = $("saveBtn");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "Đang tạo PDF…";
  try {
    const blob = await exportLessonPDF();
    const url = URL.createObjectURL(blob);
    const name = ($("lessonName").value.trim() || "bai-giang").replace(/[<>:"/\\|?*\x00-\x1F]/g, "-");
    download(url, `${name}.pdf`);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    saveLesson();
    toast("Đã tải bài giảng PDF về máy.");
  } catch (error) {
    toast(`Không tạo được PDF: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Lưu PDF";
  }
};

// =====================================================
// 14. MỞ BÀI GIẢNG TỪ FILE JSON
// =====================================================

function validateDoc(data) {
  if (
    !data ||
    data.version !== 1 ||
    !Array.isArray(data.objects) ||
    data.objects.length > 5000
  ) {
    throw new Error("Tệp không đúng định dạng bài giảng.");
  }

  const allowedTypes = [
    "pen",
    "highlight",
    "text",
    "image",
    "document",
    "graph",
    "line",
    "circle",
    "rectangle",
    "square",
    "rightTriangle",
    "isoscelesTriangle",
    "equilateralTriangle",
    "trapezoid",
    "triangle",
    "cone",
    "tetrahedron",
    "quadrilateralPyramid",
    "cube",
    "cuboid",
    "cylinder",
    "ruler",
    "protractor",
  ];

  for (const object of data.objects) {
    if (!object || !allowedTypes.includes(object.type)) {
      throw new Error("Đối tượng không hợp lệ.");
    }

    if (object.points) {
      if (
        !Array.isArray(object.points) ||
        object.points.length > 100000 ||
        object.points.some(
          (point) =>
            !point ||
            !Number.isFinite(point.x) ||
            !Number.isFinite(point.y),
        )
      ) {
        throw new Error("Nét vẽ không hợp lệ.");
      }
    } else if (
      !Number.isFinite(object.x) ||
      !Number.isFinite(object.y)
    ) {
      throw new Error("Tọa độ không hợp lệ.");
    }

    if (object.vertices) {
      const vertexCounts = {
        line: 2,
        circle: 4,
        cone: 3,
        cylinder: 4,
        ruler: 4,
        protractor: 4,
        rectangle: 4,
        square: 4,
        rightTriangle: 3,
        isoscelesTriangle: 3,
        equilateralTriangle: 3,
        trapezoid: 4,
        triangle: 3,
        tetrahedron: 4,
        quadrilateralPyramid: 5,
        cube: 8,
        cuboid: 8,
      };
      const expectedCount = vertexCounts[object.type];

      if (
        !expectedCount ||
        !Array.isArray(object.vertices) ||
        object.vertices.length !== expectedCount ||
        object.vertices.some(
          (vertex) =>
            !vertex ||
            !Number.isFinite(vertex.x) ||
            !Number.isFinite(vertex.y),
        )
      ) {
        throw new Error("Các đỉnh hình học không hợp lệ.");
      }
    }

    for (const key of ["clipRegions", "cutouts"]) {
      if (object[key] !== undefined && (!Array.isArray(object[key]) || object[key].length > 1000
          || object[key].some(region => !Array.isArray(region) || region.length < 3 || region.length > 100000
            || region.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))))) {
        throw new Error("Vùng cắt không hợp lệ.");
      }
    }
    if (object.freePosition !== undefined && typeof object.freePosition !== "boolean") {
      throw new Error("Vị trí vùng cắt không hợp lệ.");
    }

    if (
      ["pen", "highlight"].includes(object.type) &&
      !object.points?.length
    ) {
      throw new Error("Nét vẽ trống.");
    }

    if (
      object.type === "text" &&
      (
        typeof object.text !== "string" ||
        object.text.length > 20000
      )
    ) {
      throw new Error("Văn bản không hợp lệ.");
    }

    if (object.type === "graph") {
      if (object.kind === "oxy" || object.kind === "oxyz") {
        // Empty coordinate systems have no function to compile.
      } else if (object.kind === "inequality") {
        compileInequality(object.expression);
      } else if (object.kind === "variation") {
        analyzeVariation(object.expression);
      } else {
        compileExpression(object.expression);
      }
    }

    if (
      object.type === "image" &&
      (
        typeof object.src !== "string" ||
        !/^data:image\/(png|jpeg|webp|gif);base64,/.test(object.src)
      )
    ) {
      throw new Error("Ảnh không hợp lệ.");
    }

    if (
      object.type === "document" &&
      (
        typeof object.name !== "string" ||
        object.name.length === 0
      )
    ) {
      throw new Error("Tài liệu không hợp lệ.");
    }

    if (
      !object.points &&
      object.type !== "text" &&
      (
        !Number.isFinite(object.w) ||
        !Number.isFinite(object.h)
      )
    ) {
      throw new Error("Kích thước không hợp lệ.");
    }
  }

  return data;
}

function applyDoc(data) {
  fileImportRevision++;
  objects = data.objects;
  paperPageCount = Number.isSafeInteger(data.paper?.pages) && data.paper.pages > 0
    ? data.paper.pages : 1;
  paperColor = typeof data.paper?.color === "string" && /^#[0-9a-f]{6}$/i.test(data.paper.color)
    ? data.paper.color : "#faf8e8";

  for (const object of objects) {
    if (object.type === "protractor") {
      const width = Math.abs(object.w || 0);
      const oldBaseY = object.y + (object.h || width / 2);

      if (object.w < 0) object.x += object.w;
      object.w = width;
      object.h = width / 2;
      object.y = oldBaseY - object.h;
      object.vertices = null;
    }

    if (
      object.type !== "quadrilateralPyramid" ||
      !Array.isArray(object.vertices) ||
      object.vertices.length !== 5
    ) {
      continue;
    }

    const left = Math.min(object.x, object.x + object.w);
    const top = Math.min(object.y, object.y + object.h);
    const width = Math.abs(object.w);
    const height = Math.abs(object.h);
    const middle = left + width / 2;
    const oldLayout = [
      { x: middle, y: top },
      { x: left + width * 0.82, y: top + height * 0.38 },
      { x: middle, y: top + height },
      { x: left + width * 0.18, y: top + height * 0.38 },
      { x: middle, y: top + height * 0.66 },
    ];
    const matchesOldLayout = oldLayout.every(
      (point, index) =>
        Math.abs(point.x - object.vertices[index].x) < 0.05 &&
        Math.abs(point.y - object.vertices[index].y) < 0.05,
    );

    if (matchesOldLayout) {
      object.vertices = shapeVertices(object);
      syncGeometryBounds(object);
    }
  }

  $("lessonName").value =
    typeof data.title === "string"
      ? data.title
      : "Bài giảng chưa đặt tên";

  if (
    data.view &&
    [data.view.x, data.view.y, data.view.z].every(Number.isFinite) &&
    data.view.z >= 0.1 &&
    data.view.z <= 4
  ) {
    view = { x: data.view.x, y: data.view.y, z: data.view.z, fit: data.view.fit !== false };
  }

  if (paperTemplates.some(template => template.id === data.background)) {
    paperBackground = data.background;
  }

  if (["light", "dark"].includes(data.theme)) {
    applyTheme(data.theme);
  }

  if (data.paper?.format !== "a4") migrateLegacyPaper();
  clearGroupSelection();
  selected = -1;
  selection = null;
}

$("importInput").onchange = async (event) => {
  const file = event.target.files[0];

  if (!file) return;

  try {
    if (file.size > 20 * 1024 * 1024) {
      throw new Error("Tệp quá lớn (tối đa 20 MB).");
    }

    const data = validateDoc(
      JSON.parse(await file.text()),
    );

    if (
      objects.length &&
      !confirm("Thay nội dung hiện tại bằng bài giảng này?")
    ) {
      return;
    }

    snapshot();
    applyDoc(data);
    changed();


    toast("Đã mở bài giảng.");
  } catch (error) {
    toast(error.message || "Không thể đọc tệp.");
  } finally {
    event.target.value = "";
  }
};

// =====================================================
// 16. CHUYỂN TAB TOÁN HỌC / AI
// =====================================================

function applyTheme(theme) {
  const value = theme === "dark" ? "dark" : "light";
  document.body.dataset.theme = value;
  const light = value === "light";
  $("themeToggle").setAttribute("aria-checked", String(light));
  $("themeToggle").title = light
    ? "Tắt đèn · Chuyển sang giao diện tối"
    : "Bật đèn · Chuyển sang giao diện sáng";
  draw();
  saveLesson();
}

$("themeToggle").onclick = () => {
  applyTheme(document.body.dataset.theme === "dark" ? "light" : "dark");
};

document.querySelectorAll("[data-tab]").forEach((button) => {
  button.onclick = () => {
    document.querySelectorAll("[data-tab]").forEach((item) => {
      item.classList.toggle("active", item === button);
    });

    $("mathPanel").hidden = button.dataset.tab !== "math";
    $("aiPanel").hidden = button.dataset.tab !== "ai";
  };
});

// =====================================================
// 18. CHẾ ĐỘ TẬP TRUNG VÀ THANH CÔNG CỤ NỔI
// =====================================================

$("focusBtn").onclick = () => {
  document.body.classList.toggle("focus");

  $("focusBtn").querySelector("span").textContent =
    document.body.classList.contains("focus")
      ? "Thoát toàn màn hình"
      : "Toàn màn hình";
  resize();
};

$("collapseTools").onclick = () => {
  $("toolbar").classList.toggle("collapsed");

  $("collapseTools").textContent =
    $("toolbar").classList.contains("collapsed")
      ? "›"
      : "‹";
};

let toolDrag = null;

$("toolHandle").onpointerdown = (event) => {
  const toolbar = $("toolbar");
  const rect = toolbar.getBoundingClientRect();
  const workspaceRect = $("workspace").getBoundingClientRect();

  toolDrag = {
    dx: event.clientX - rect.left,
    dy: event.clientY - rect.top,
    rect: workspaceRect,
  };

  toolbar.style.transform = "none";
  toolbar.style.top = `${rect.top - workspaceRect.top}px`;

  event.target.setPointerCapture(event.pointerId);
};

$("toolHandle").onpointermove = (event) => {
  if (!toolDrag) return;

  const toolbar = $("toolbar");
  const rect = toolDrag.rect;

  const x = Math.max(
    0,
    Math.min(
      rect.width - toolbar.offsetWidth,
      event.clientX - rect.left - toolDrag.dx,
    ),
  );

  const y = Math.max(
    0,
    Math.min(
      rect.height - toolbar.offsetHeight,
      event.clientY - rect.top - toolDrag.dy,
    ),
  );

  toolbar.style.left = `${x}px`;
  toolbar.style.top = `${y}px`;
};

$("toolHandle").onpointerup = () => {
  toolDrag = null;
};

$("toolHandle").onpointercancel = () => {
  toolDrag = null;
};

// =====================================================
// 19. BÀI GIẢNG MẪU
// =====================================================

$("exampleBtn").onclick = () => {
  snapshot();

  objects.push(
    {
      type: "text",
      text: "HÀM SỐ BẬC HAI",
      x: 140,
      y: 80,
      size: 26,
      color: "#24304a",
    },
    {
      type: "text",
      text:
        "y = x² − 3x + 2\n\n" +
        "Nghiệm: x = 1 và x = 2\n" +
        "Đỉnh I (1,5; −0,25)",
      x: 140,
      y: 135,
      size: 20,
      color: "#526b99",
    },
    {
      type: "graph",
      expression: "x^2 - 3*x + 2",
      x: 140,
      y: 290,
      w: 420,
      h: 300,
      color: "#245bea",
    },
  );

  changed();
  chooseTool("select");
};

// =====================================================
// 20. PHÍM TẮT
// =====================================================

window.addEventListener("keydown", (event) => {
  if (
    /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) ||
    (event.target.closest("#themeToggle") && ["Space", "Enter"].includes(event.code)) ||
    document.querySelector("dialog[open]")
  ) {
    return;
  }

  const key = event.key.toLowerCase();
  const modifier = event.ctrlKey || event.metaKey;

  if (event.code === "Space") {
    event.preventDefault();

    space = true;
    canvas.style.cursor = "grab";
  }

  if (modifier && key === "z") {
    event.preventDefault();

    if (event.shiftKey) {
      redo();
    } else {
      undo();
    }

    return;
  }

  if (modifier && key === "y") {
    event.preventDefault();
    redo();
    return;
  }

  if (modifier && key === "s") {
    event.preventDefault();
    $("saveBtn").click();
    return;
  }

  if (event.key === "Escape") {
    if (start?.groupMove) finishGroupMove(true);
    if (tool === "moveLasso") { dragging = false; start = null; }
    clearGroupSelection();
    if (tool === "moveLasso") canvas.style.cursor = "crosshair";
    selection = null;
    selected = -1;

    $("selectionNote").hidden = true;
    document.body.classList.remove("focus");

    $("focusBtn").querySelector("span").textContent =
      "Toàn màn hình";

    draw();
  }

  if (
    (event.key === "Delete" || event.key === "Backspace") &&
    selected >= 0
  ) {
    event.preventDefault();

    snapshot();
    objects.splice(selected, 1);

    selected = -1;
    changed();
  }

  const matchedTool = tools.find(
    (item) => item[3].toLowerCase() === key,
  );

  if (matchedTool && !modifier) {
    chooseTool(matchedTool[0]);
  }
});

window.addEventListener("keyup", (event) => {
  if (event.code === "Space") {
    space = false;
    chooseTool(tool, { preserveSelection: true, preserveLassoMode: true });
  }
});

window.addEventListener("blur", () => {
  space = false;
});

// =====================================================
// 21. KHÔI PHỤC BÀI GIẢNG ĐÃ LƯU
// =====================================================

async function initializeLesson() {
  let loaded = false;
  let resumeSession = false;
  try {
    resumeSession = sessionStorage.getItem("qh-board-started") === boardSessionId;
    const cached = sessionStorage.getItem(sessionLessonKey);
    if (resumeSession && cached) {
      const data = validateDoc(JSON.parse(cached));
      if (data.sessionId === boardSessionId) {
        restoringLesson = true;
        applyDoc(data);
        loaded = true;
      }
    }
  } catch { /* Try the server copy belonging to this login session. */ }
  finally { restoringLesson = false; }

  if (resumeSession && !loaded) {
    try {
      const response = await fetch("/api/lesson", { cache: "no-store" });
      if (response.ok) {
        const data = validateDoc(await response.json());
        // A new login must never restore a previous login's shared server lesson.
        if (data.sessionId === boardSessionId) {
          restoringLesson = true;
          applyDoc(data);
          loaded = true;
        }
      }
    } catch { /* Start blank if this session has no usable saved copy. */ }
    finally { restoringLesson = false; }
  }

  resize();
  draw();
  $("saveStatus").textContent = loaded
    ? "Đã khôi phục bảng trong phiên đăng nhập này"
    : "Phiên đăng nhập mới · Bảng trống";
  saveLesson();
}

initializeLesson();

// =====================================================
// 22. WEBMCP — CHỈ ĐĂNG KÝ NẾU TRÌNH DUYỆT HỖ TRỢ
// =====================================================

if (document.modelContext?.registerTool) {
  try {
    Promise.resolve(
      document.modelContext.registerTool({
        name: "insert_graph",
        description:
          "Insert a function graph on the teaching whiteboard.",

        inputSchema: {
          type: "object",
          properties: {
            expression: {
              type: "string",
            },
          },
          required: ["expression"],
          additionalProperties: false,
        },

        annotations: {
          readOnlyHint: false,
        },

        execute(input) {
          if (
            typeof input?.expression !== "string" ||
            input.expression.length > 200
          ) {
            throw new Error("Invalid expression");
          }

          const count = addGraph(input.expression);

          return {
            objectCount: count,
            expression: input.expression,
          };
        },
      }),
    ).catch(() => {
      // Không ảnh hưởng chức năng bảng trắng.
    });
  } catch {
    // Trình duyệt không hỗ trợ thì bỏ qua.
  }
}
