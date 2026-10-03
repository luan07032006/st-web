"use strict";

(() => {
  let authenticated = false;
  try {
    authenticated = sessionStorage.getItem("qh-authenticated") === "true";
  } catch (_) { /* Storage unavailable: return to login. */ }
  if (!authenticated) {
    document.documentElement.style.display = "none";
    window.location.replace("./login.html");
  }
  window.addEventListener("pageshow", () => {
    try {
      if (sessionStorage.getItem("qh-authenticated") !== "true") window.location.replace("./login.html");
    } catch (_) { window.location.replace("./login.html"); }
  });
})();
