// Verifica periodicamente se o HTML publicado mudou de versão (comparando a
// meta tag "app-version") e mostra um banner convidando a recarregar. Simples
// e sem dependências — não há service worker nem processo de build neste
// projeto para fazer isso de outra forma.
export function startUpdateNotifier() {
  const currentVersion = document.querySelector('meta[name="app-version"]')?.content || '0';

  function showBanner() {
    document.getElementById('update-banner').classList.add('visible');
  }

  async function check() {
    try {
      const html = await fetch(location.href + '?_t=' + Date.now(), { cache: 'no-store' }).then(r => r.text());
      const match = html.match(/<meta name="app-version" content="([^"]+)"/);
      if (match && match[1] !== currentVersion) {
        showBanner();
        clearInterval(timer);
      }
    } catch (_) {}
  }

  const timer = setInterval(check, 30000);
}
