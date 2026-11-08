/* NEXT-RA startup guard. This file has no external dependencies. */
(() => {
  window.__NEXT_RA_APP_READY = false;

  // ES modules imported from a file:// page are blocked by browser origin rules.
  // Tell the user exactly how to start the included local HTTP server.
  if (window.location.protocol === 'file:') {
    window.addEventListener('DOMContentLoaded', () => {
      message('NEXT-RA was opened directly as a file. Close this tab, extract the ZIP, then double-click START-NEXT-RA.bat. Do not open index.html directly.');
    }, { once: true });
  }
  const message = (text) => {
    const node = document.getElementById('auth-message');
    if (!node) return;
    node.className = 'auth-message error';
    node.textContent = text;
    node.classList.remove('hidden');
  };

  // Prevent a silent native form reload if the application module did not load.
  document.addEventListener('submit', (event) => {
    if (event.target && event.target.id === 'auth-form' && !window.__NEXT_RA_APP_READY) {
      event.preventDefault();
      message('NEXT-RA is still loading its secure services. Please wait a moment and try again. If this message remains, refresh the page and check your internet connection.');
    }
  }, true);

  window.addEventListener('error', (event) => {
    if (event.target && event.target.tagName === 'SCRIPT') {
      message('A required NEXT-RA application script could not be loaded. Check your internet connection, then refresh the page.');
    }
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    console.error('NEXT-RA startup rejection:', event.reason);
    if (!window.__NEXT_RA_APP_READY) {
      const detail = event.reason?.message || String(event.reason || 'Unknown startup error');
      message(`NEXT-RA could not start: ${detail}. Check your internet connection and refresh the page.`);
    }
  });

  window.addEventListener('error', (event) => {
    if (!window.__NEXT_RA_APP_READY && event.message) {
      console.error('NEXT-RA startup error:', event.message, event.filename, event.lineno);
      message(`NEXT-RA startup error: ${event.message}. Please refresh the page. If this continues, share this exact message.`);
    }
  });

  window.setTimeout(() => {
    if (!window.__NEXT_RA_APP_READY && window.location.protocol !== 'file:') {
      message('NEXT-RA is taking too long to start. The Supabase account library may be blocked or unreachable. Check that this page is served from http://localhost or a deployed HTTPS site, and that your internet connection allows jsDelivr or esm.sh.');
    }
  }, 12000);
})();
