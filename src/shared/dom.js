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

export function toggleSenha(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (inp.type === 'password') { inp.type = 'text'; btn.textContent = '🙈'; }
  else { inp.type = 'password'; btn.textContent = '👁'; }
}

// Fecha o modal ao clicar no fundo escuro (fora do card).
export function wireModalBackdrops() {
  document.querySelectorAll('.modal-bg').forEach(bg => {
    bg.addEventListener('mousedown', e => {
      if (e.target === bg) fecharModal(bg.id);
    });
  });
}
