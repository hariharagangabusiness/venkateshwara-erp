// app.js - entrypoint only. Every page/helper lives in the scripts loaded before this one. Keep it LAST
// so every PAGES entry exists before boot() runs.

// ===================== Boot on load if token exists =====================
// loadBranding() runs alongside checkForResetToken() (independent reads) and
// populates the login screen's logo - the sidebar always shows the plain
// text wordmark regardless, so there's no ordering dependency against
// boot()/renderSidebar() here; both are just batched together as the two
// independent startup reads this page needs before it can show anything.
Promise.all([checkForResetToken(), loadBranding()]).then(([hadResetToken]) => {
  if (!hadResetToken && TOKEN) boot();
});
