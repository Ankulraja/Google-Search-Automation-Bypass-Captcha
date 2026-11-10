// Theme: saved choice ("light"/"dark") wins; otherwise follow the OS setting.
(function () {
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem("gsa-theme"); } catch (e) {}
  var osDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", saved === "light" || saved === "dark" ? saved : osDark ? "dark" : "light");

  function label() {
    var btn = document.getElementById("themeBtn");
    if (!btn) return;
    var dark = root.getAttribute("data-theme") === "dark";
    btn.querySelector(".tl").textContent = dark ? "Light" : "Dark";
    btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    btn.title = btn.getAttribute("aria-label");
  }
  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("themeBtn");
    if (!btn) return;
    label();
    btn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("gsa-theme", next); } catch (e) {}
      label();
    });
  });
})();
