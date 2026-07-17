// The Worker backend is publicly reachable, so we lock it with one password
// you set yourself (via `wrangler secret put APP_PASSWORD`). This just
// prompts for it once per browser session and attaches it to every request.

// Password entry lives entirely in Settings now - just one place to type it,
// no competing native popups.

window.addEventListener('DOMContentLoaded', () => {
  if (!localStorage.getItem('workspace_backend_url')) {
    setTimeout(() => {
      Toast.show('First time here? Open Settings to connect your backend.');
    }, 500);
  }
});
