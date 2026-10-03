// Chat uses text nodes so generated content cannot insert HTML into the page.
(() => {
  const messagesElement = document.getElementById("aiChatMessages");
  const form = document.getElementById("aiChatForm");
  const input = document.getElementById("aiChatInput");
  const send = document.getElementById("sendChatBtn");
  const status = document.getElementById("aiChatStatus");
  let history = [];
  let busy = false;
  let region = null;

  function captureBoard(area = null) {
    if (!objects.length || !boardW || !boardH) return null;
    const crop = area ? { x: Math.min(area.x, area.x + area.w),
      y: Math.min(area.y, area.y + area.h), w: Math.abs(area.w), h: Math.abs(area.h) } : null;
    if (crop && !objects.some(object => {
      const box = bounds(object);
      return box.x <= crop.x + crop.w && box.x + box.w >= crop.x
        && box.y <= crop.y + crop.h && box.y + box.h >= crop.y;
    })) return null;
    const captureWidth = crop ? crop.w : boardW;
    const captureHeight = crop ? crop.h : boardH;
    const scale = Math.min(crop ? 3 : 2, 2048 / Math.max(captureWidth, captureHeight));
    const image = document.createElement("canvas");
    image.width = Math.max(1, Math.ceil(captureWidth * scale));
    image.height = Math.max(1, Math.ceil(captureHeight * scale));
    const context = image.getContext("2d");
    context.fillStyle = document.body.dataset.theme === "dark" ? "#0d1320" : "#ffffff";
    context.fillRect(0, 0, image.width, image.height);
    context.scale(scale, scale);
    if (crop) {
      context.translate(-crop.x, -crop.y);
    } else {
      context.translate(view.x, view.y);
      context.scale(view.z, view.z);
    }
    objects.forEach((object) => paintObject(context, object));
    return image.toDataURL("image/png");
  }

  function readableText(text) {
    return text
      .replace(/\r\n/g, "\n")
      .replace(/\\(?:begin|end)\{(?:cases|aligned|align\*?|equation\*?)\}/g, "")
      .replace(/\\\[|\\\]|\\\(|\\\)|\${1,2}/g, "")
      .replace(/\\\\/g, "\n")
      .replace(/\\(?:left|right)\s*[{}]/g, "")
      .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)")
      .replace(/\\sqrt\{([^{}]+)\}/g, "√($1)")
      .replace(/\\(?:text|mathrm)\{([^{}]+)\}/g, "$1")
      .replace(/\\(?:leq|le)\b/g, "≤")
      .replace(/\\(?:geq|ge)\b/g, "≥")
      .replace(/\\times\b/g, "×")
      .replace(/\\cdot\b/g, "·")
      .replace(/\\neq\b/g, "≠")
      .replace(/\^(?:\{2\}|2(?!\d))/g, "²")
      .replace(/\^(?:\{3\}|3(?!\d))/g, "³")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*[-*_]{3,}\s*$/gm, "")
      .replace(/^\s*\*\s+/gm, "• ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function appendMessage(role, text) {
    const bubble = document.createElement("div");
    bubble.className = `ai-chat-message ${role}`;
    const label = document.createElement("strong");
    label.textContent = role === "user" ? "Bạn" : "Trợ lý AI";
    const content = document.createElement("div");
    content.textContent = role === "user" ? text : readableText(text);
    bubble.append(label, content);
    messagesElement.append(bubble);
    messagesElement.scrollTop = messagesElement.scrollHeight;
    return bubble;
  }

  async function sendMessage(text, area = region, fromRegion = false) {
    if (busy || !text) return;
    let image;
    try {
      image = captureBoard(area);
      if (area && !image) throw new Error("Vùng khoanh chưa có nội dung. Hãy khoanh trọn bài toán.");
    } catch (error) {
      status.textContent = error.message;
      return;
    }
    const messages = [...history.slice(-20), { role: "user", text }];
    // Keep complete exchanges within the backend request limit.
    while (messages.length > 1 && new TextEncoder().encode(JSON.stringify({ messages })).length > 120000) {
      messages.splice(0, 2);
    }
    const bubble = appendMessage("user", text);
    if (area && image) {
      const preview = document.createElement("img");
      preview.src = image;
      preview.alt = "Vùng bài toán gửi cho AI";
      preview.className = "ai-region-preview";
      bubble.append(preview);
    }
    busy = true;
    send.disabled = true;
    input.disabled = true;
    messagesElement.setAttribute("aria-busy", "true");
    status.textContent = "Đang trả lời…";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 75000);
    try {
      status.textContent = area ? "Đang giải bài toán trong vùng đã khoanh…"
        : image ? "Đang đọc bảng và trả lời…" : "Đang trả lời…";
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, ...(image ? { image } : {}) }),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => {
        throw new Error("Không đọc được phản hồi. Hãy khởi động lại máy chủ rồi thử lại.");
      });
      if (!response.ok) throw new Error(result.error || "Không gửi được tin nhắn. Hãy thử lại.");
      if (typeof result.text !== "string" || !result.text.trim()) throw new Error("Chưa nhận được câu trả lời. Hãy thử lại.");
      appendMessage("assistant", result.text);
      history = [...messages, { role: "assistant", text: readableText(result.text).slice(0, 20000) }].slice(-20);
      if (!fromRegion) input.value = "";
      status.textContent = "";
    } catch (error) {
      bubble.remove();
      status.textContent = error.name === "AbortError"
        ? "Phản hồi hơi lâu. Bạn hãy gửi lại câu hỏi."
        : error.message || "Không kết nối được. Hãy thử lại.";
    } finally {
      clearTimeout(timeout);
      busy = false;
      send.disabled = false;
      input.disabled = false;
      messagesElement.setAttribute("aria-busy", "false");
      input.focus({ preventScroll: true });
    }
  }

  form.onsubmit = event => {
    event.preventDefault();
    sendMessage(input.value.trim());
  };
  document.getElementById("aiRegionBtn").onclick = () => {
    chooseTool("aiRegion");
    toast("Kéo khoanh trọn đề bài trên bảng, rồi thả để AI giải.");
  };
  document.getElementById("clearAIRegion").onclick = () => {
    region = null;
    document.getElementById("aiRegionNote").hidden = true;
    selection = null;
    draw();
  };
  window.boardAI = {
    get busy() { return busy; },
    solveRegion(area) {
      if (busy) { toast("AI đang trả lời. Hãy đợi rồi khoanh lại."); return; }
      region = { ...area };
      document.body.classList.remove("sidebar-collapsed");
      document.getElementById("toggleSidebar").setAttribute("aria-expanded", "true");
      resize();
      document.querySelector('[data-tab="ai"]').click();
      document.getElementById("aiRegionNote").hidden = false;
      return sendMessage("Hãy giải bài toán trong ảnh vùng tôi vừa khoanh. Chỉ xét đề bài trong ảnh này; trình bày lời giải từng bước và kết quả. Nếu đề thiếu hoặc chữ không rõ, hãy nói rõ phần cần bổ sung, không đoán.", region, true);
    },
  };

  input.onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  };
})();
