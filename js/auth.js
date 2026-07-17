// The Worker backend is publicly reachable, so we lock it with one password
// you set yourself (via `wrangler secret put APP_PASSWORD`). This just
// prompts for it once per browser session and attaches it to every request.

const Auth = {
  promptForPassword() {
    const pw = prompt('Wrong or missing password. Enter your workspace password:');
    if (pw) sessionStorage.setItem('workspace_password', pw);
  }
};

// First-run nudge: if no backend URL is configured yet, point the user to Settings.
window.addEventListener('DOMContentLoaded', () => {
  if (!localStorage.getItem('workspace_backend_url')) {
    setTimeout(() => {
      alert('First time setup: open Settings and enter your Worker URL + password to connect.');
    }, 300);
  }
});
