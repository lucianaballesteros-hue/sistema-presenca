export function toggleTema() {
  const atual = document.documentElement.getAttribute('data-theme');
  if (atual === 'dark') {
    document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('tema', 'claro'); } catch (e) {}
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.setItem('tema', 'escuro'); } catch (e) {}
  }
}
