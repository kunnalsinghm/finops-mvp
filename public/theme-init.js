/* Runs in <head> before first paint so the saved theme never flashes.
   External file (not inline) because the CSP is script-src 'self'. */
try {
  var t = localStorage.getItem("finops_theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
