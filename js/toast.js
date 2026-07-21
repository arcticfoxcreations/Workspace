// Lightweight in-app notifications. Replaces every alert()/prompt() in the
// app so nothing ever interrupts you with a browser popup.

const Toast = {
  show(message, isError) {
    let host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      host.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:100;display:flex;flex-direction:column;gap:8px;align-items:center;';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.textContent = message;
    el.style.cssText = `
      background:${isError ? '#3a1f1a' : '#1a1a1c'};
      color:${isError ? '#d98a5f' : '#f2f2f0'};
      border:0.5px solid ${isError ? '#5a3a2a' : 'rgba(255,255,255,0.12)'};
      padding:9px 14px;border-radius:10px;font-size:13px;
      box-shadow:0 4px 16px rgba(0,0,0,0.35);
      max-width:320px;text-align:center;
    `;
    host.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 0.25s ease';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    }, 3200);
  }
};
