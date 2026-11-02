/* Pointer input works on the web. Physical Pencil double-tap arrives only via the UIKit adapter. */
(() => {
  const isIPad = /iPad/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const settings = { pencilOnly: isIPad, curve: "balanced" };
  const exponents = { soft: .6, balanced: .85, firm: 1.3 };
  const ignoredTouches = new Set();
  let previousTool = "pen", beforeEraser = "pen", pendingAction = null;
  let revision = 0, saveQueue = Promise.resolve(), nativeAvailable = false;
  const pad = $("pencilTestPad");
  let testStroke = null, testInput = null, testPointer = null, testFrame = 0;
  let testPressure = 0;

  function inputOptions(event) {
    return { pressureResponse: event.pointerType === "pen", pressureExponent: exponents[settings.curve] };
  }

  function sync() {
    $("pencilOnly").checked = settings.pencilOnly;
    document.querySelectorAll("[data-pressure-curve]").forEach(button =>
      button.setAttribute("aria-pressed", String(button.dataset.pressureCurve === settings.curve)));
    $("pencilSwapBtn").setAttribute("aria-pressed", String(tool === "eraser"));
    $("pencilSwapBtn").title = tool === "eraser" ? "Quay lại công cụ trước" : "Đổi nhanh sang tẩy";
  }

  function persist() {
    revision++;
    const value = { ...settings };
    $("pencilSettingsStatus").textContent = "Đang lưu thiết lập…";
    saveQueue = saveQueue.catch(() => {}).then(() => DocumentStore.setting("pencil-input", value))
      .then(() => { $("pencilSettingsStatus").textContent = "Đã lưu trên thiết bị"; })
      .catch(error => { $("pencilSettingsStatus").textContent = `Chưa lưu được: ${error.message}`; });
    sync();
  }

  function resizeTestPad() {
    const rect = pad.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    pad.width = Math.max(1, Math.round(rect.width * dpr));
    pad.height = Math.max(1, Math.round(rect.height * dpr));
    testStroke = null;testInput = null;testPointer = null;
    $("pencilForce").value = "0%";
  }

  function openSettings() {
    if (document.querySelector("dialog[open]")) return;
    sync();$("pencilDialog").showModal();resizeTestPad();
  }

  function openPalette() {
    if ($("pencilPalette").open) { $("pencilPalette").close();return; }
    if (document.querySelector("dialog[open]")) return;
    document.querySelectorAll("[data-pencil-tool]").forEach(button =>
      button.setAttribute("aria-pressed", String(button.dataset.pencilTool === tool)));
    document.querySelector('[data-pencil-action="undo"]').disabled = !undoStack.length;
    document.querySelector('[data-pencil-action="redo"]').disabled = !redoStack.length;
    document.querySelectorAll("[data-pencil-color]").forEach(button =>
      button.setAttribute("aria-pressed", String(button.dataset.pencilColor === color)));
    $("pencilPalette").showModal();
  }

  function perform(action) {
    if (!["switchEraser", "previous", "palette", "colors", "attributes", "undo", "redo", "pen", "highlight", "eraser"].includes(action)
        || !window.documentWorkspace?.ready) return false;
    // Never split a live stroke or turn an unfinished stroke into an eraser gesture.
    if (dragging || paperGesture) { pendingAction = action;return true; }
    if (action === "palette" || action === "colors") { openPalette();return true; }
    if (action === "attributes") { openSettings();return true; }
    if (document.querySelector("dialog[open]")) return false;
    if (action === "switchEraser") chooseTool(tool === "eraser" ? beforeEraser : "eraser");
    else if (action === "previous") chooseTool(previousTool);
    else if (action === "undo") undo();
    else if (action === "redo") redo();
    else chooseTool(action);
    sync();
    return true;
  }

  function flushAction() {
    if (!pendingAction || dragging || paperGesture) return;
    const action = pendingAction;pendingAction = null;perform(action);
  }

  const controller = window.PencilControls = {
    get pencilOnly() { return settings.pencilOnly; },
    inputOptions, perform,
    toolChanged(from, to) {
      if (from !== to) {
        previousTool = from;
        if (to === "eraser") beforeEraser = from;
      }
      // chooseTool invokes this before assigning the new global tool.
      $("pencilSwapBtn").setAttribute("aria-pressed", String(to === "eraser"));
    },
    ignorePointer(event) {
      if (event.pointerType !== "touch") return false;
      const penDown = dragging && start?.pointerType === "pen";
      const palm = settings.pencilOnly && Math.max(event.width || 0, event.height || 0) >= 32;
      if (penDown || palm) { ignoredTouches.add(event.pointerId);return true; }
      return ignoredTouches.has(event.pointerId);
    },
    endPen() { requestAnimationFrame(flushAction); },
    endPointer(event) {
      const ignored = ignoredTouches.delete(event.pointerId);
      requestAnimationFrame(flushAction);
      return ignored;
    },
    nativeReady() {
      nativeAvailable = true;
      $("pencilShortcutStatus").textContent = "Đã kết nối thao tác trên thân Apple Pencil. Chạm hai lần thực hiện hành động bạn chọn trong Cài đặt iPad.";
    },
    get nativeAvailable() { return nativeAvailable; },
  };
  controller.ready = DocumentStore.setting("pencil-input").then(saved => {
    if (!revision && saved) {
      if (typeof saved.pencilOnly === "boolean") settings.pencilOnly = saved.pencilOnly;
      if (Object.hasOwn(exponents, saved.curve)) settings.curve = saved.curve;
    }
    sync();
  }).catch(() => { sync(); });

  $("pencilOnly").onchange = () => { settings.pencilOnly = $("pencilOnly").checked;persist(); };
  document.querySelectorAll("[data-pressure-curve]").forEach(button => {
    button.onclick = () => { settings.curve = button.dataset.pressureCurve;persist(); };
  });
  $("pencilSettingsBtn").onclick = openSettings;
  $("closePencil").onclick = () => $("pencilDialog").close();
  $("pencilSwapBtn").onclick = () => perform("switchEraser");
  $("closePencilPalette").onclick = () => $("pencilPalette").close();
  $("clearPencilTest").onclick = resizeTestPad;
  canvas.addEventListener("lostpointercapture", () => requestAnimationFrame(flushAction));
  window.addEventListener("pointerup", event => { if (!canvas.contains(event.target)) ignoredTouches.delete(event.pointerId); });
  window.addEventListener("pointercancel", event => ignoredTouches.delete(event.pointerId));
  document.querySelectorAll("[data-pencil-tool], [data-pencil-action]").forEach(button => {
    button.onclick = () => { $("pencilPalette").close();perform(button.dataset.pencilTool || button.dataset.pencilAction); };
  });
  const names = ["Đen", "Xanh dương", "Đỏ", "Vàng", "Xanh lá"];
  palette.forEach((value, index) => {
    const button = document.createElement("button");button.type = "button";
    button.dataset.pencilColor = value;button.style.setProperty("--pencil-color", value);
    button.setAttribute("aria-label", `Mực ${names[index]}`);
    button.onclick = () => { setColor(value);$("pencilPalette").close(); };
    $("pencilQuickColors").append(button);
  });

  function testSample(event, endpoint = false) {
    const rect = pad.getBoundingClientRect();
    const pressure = event.pressure > 0 ? event.pressure : testPressure || .5;
    if (!endpoint) testPressure = pressure;
    const point = testInput.sample({ x: event.clientX - rect.left, y: event.clientY - rect.top,
      time: event.timeStamp, pressure }, endpoint);
    testStroke.points.push(point);
    if (!testFrame) testFrame = requestAnimationFrame(() => {
      testFrame = 0;
      if (!testStroke) return;
      const context = pad.getContext("2d"), dpr = window.devicePixelRatio || 1;
      context.setTransform(1, 0, 0, 1, 0, 0);context.clearRect(0, 0, pad.width, pad.height);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle = "#24304a";InkEngine.paint(context, testStroke);
      $("pencilForce").value = `${Math.round(testPressure * 100)}%`;
    });
  }
  pad.onpointerdown = event => {
    if (event.pointerType !== "pen" || testPointer !== null) return;
    testPointer = event.pointerId;testPressure = event.pressure > 0 ? event.pressure : .5;
    pad.setPointerCapture(event.pointerId);
    testInput = InkEngine.createInput({ pointerType: "pen", positionMode: "adaptive", ...inputOptions(event) });
    testStroke = { type: "pen", width: 5, inkVersion: InkEngine.profile.version, points: [] };
    testSample(event);
  };
  pad.onpointermove = event => {
    if (event.pointerId !== testPointer || !testInput) return;
    let samples;
    try { samples = event.getCoalescedEvents?.(); } catch { /* Use the dispatched sample. */ }
    for (const sample of samples?.length ? samples : [event]) testSample(sample);
  };
  pad.onpointerup = event => {
    if (event.pointerId !== testPointer || !testInput) return;
    testSample(event, true);testPointer = null;testInput = null;
  };
  pad.onpointercancel = pad.onlostpointercapture = () => { testPointer = null;testInput = null; };
  $("pencilDialog").addEventListener("close", () => {
    testPointer = null;testInput = null;
    if (testFrame) { cancelAnimationFrame(testFrame);testFrame = 0; }
  });
  new ResizeObserver(() => {
    if (!$("pencilDialog").open) return;
    const rect = pad.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (pad.width !== Math.round(rect.width * dpr) || pad.height !== Math.round(rect.height * dpr)) resizeTestPad();
  }).observe(pad);
  window.addEventListener("pagehide", () => { pendingAction = null;ignoredTouches.clear(); });
  sync();
})();
