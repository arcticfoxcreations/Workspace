// The Worker backend is publicly reachable, so we lock it with one password
// you set yourself (via `wrangler secret put APP_PASSWORD`). This just
// prompts for it once per browser session and attaches it to every request.

// Password entry lives entirely in Settings now - just one place to type it,
// no competing native popups.

// If this page was opened via a setup link (?pin=...), auto-fill the PIN
// so a new device only needs one tap instead of manual typing.
(function applySetupLinkIfPresent() {
  const params = new URLSearchParams(window.location.search);
  const pin = params.get('pin');
  if (pin) {
    localStorage.setItem('workspace_pin', pin);
    // scrub the URL so the PIN doesn't sit in browser history/address bar
    window.history.replaceState({}, '', window.location.pathname);
  }
})();

window.addEventListener('DOMContentLoaded', () => {
  if (!localStorage.getItem('workspace_pin')) {
    setTimeout(() => {
      Toast.show('First time here? Open Settings and enter your PIN.');
    }, 500);
  }
});
