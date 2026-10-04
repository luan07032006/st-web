"use strict";

const form = document.getElementById("loginForm");
const password = document.getElementById("password");
const toggle = document.getElementById("togglePassword");
const error = document.getElementById("loginError");

toggle.addEventListener("click", () => {
  const visible = password.type === "password";
  password.type = visible ? "text" : "password";
  toggle.setAttribute("aria-pressed", String(visible));
  toggle.setAttribute("aria-label", visible ? "Ẩn mật khẩu" : "Hiện mật khẩu");
});

form.addEventListener("input", () => { error.hidden = true; });
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const username = document.getElementById("username");
  if (username.value === "QuynhHuong" && password.value === "255205") {
    try {
      sessionStorage.setItem("qh-authenticated", "true");
      sessionStorage.setItem("qh-board-session", crypto.randomUUID());
      sessionStorage.removeItem("qh-board-started");
      sessionStorage.removeItem("bangtrang-session-v1");
      try { localStorage.removeItem("bangtrang-v1"); } catch { /* Legacy cache is no longer used. */ }
      window.location.replace("./index.html");
    } catch (_) {
      error.textContent = "Vui lòng cho phép lưu trữ trong trình duyệt để đăng nhập.";
      error.hidden = false;
    }
    return;
  }
  error.textContent = "Tên đăng nhập hoặc mật khẩu chưa đúng. Cô thử lại nhé!";
  error.hidden = false;
  password.value = "";
  password.focus();
});
