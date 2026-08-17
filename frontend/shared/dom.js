const ESCAPE_HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escapa texto para uso seguro como CONTEÚDO HTML (entre tags).
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, c => ESCAPE_HTML_MAP[c]);
}

// Escapa texto para uso seguro DENTRO de um atributo inline tipo
// onclick="funcao('VALOR')" — ou seja, um valor que primeiro vira um literal
// de string JS entre aspas simples, e esse literal por sua vez fica dentro de
// um atributo HTML delimitado por aspas duplas. É preciso neutralizar os dois
// níveis: escapar aspa simples/barra invertida para não fechar a string JS, e
// escapar aspa dupla/&/<> para não fechar o atributo HTML. Sem isso, um nome
// de turma/curso/professor contendo aspas poderia injetar HTML/JS (XSS).
export function escapeAttr(str) {
  if (str === null || str === undefined) return '';
  const paraStringJs = String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return escapeHtml(paraStringJs);
}

export function showToast(msg, type = 'green') {
  const container = document.getElementById('toast');
  const item = document.createElement('div');
  item.className = `toast-item ${type}`;
  item.textContent = msg;
  const remover = () => item.remove();
  item.addEventListener('click', remover); // clique fecha na hora
  container.appendChild(item);
  setTimeout(remover, 2800);
}

export function fecharModal(id) {
  document.getElementById(id).classList.remove('open');
}

const ICONE_OLHO_ABERTO = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICONE_OLHO_FECHADO = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.6 21.6 0 0 1 5.06-6.06M9.9 4.24A10.4 10.4 0 0 1 12 4c7 0 11 8 11 8a21.6 21.6 0 0 1-3.06 4.24M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

export function toggleSenha(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (inp.type === 'password') { inp.type = 'text'; btn.innerHTML = ICONE_OLHO_FECHADO; btn.setAttribute('aria-label', 'Ocultar senha'); }
  else { inp.type = 'password'; btn.innerHTML = ICONE_OLHO_ABERTO; btn.setAttribute('aria-label', 'Mostrar senha'); }
}

// Fecha o modal ao clicar no fundo escuro (fora do card).
export function wireModalBackdrops() {
  document.querySelectorAll('.modal-bg').forEach(bg => {
    bg.addEventListener('mousedown', e => {
      if (e.target === bg) fecharModal(bg.id);
    });
  });
}
