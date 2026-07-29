// Diálogo de confirmação no próprio layout do sistema, substituindo o
// confirm() nativo do navegador. Uso: `if (!await confirmar({...})) return;`

import { fecharModal } from './dom.js';

let resolverAtual = null;

export function confirmar({ titulo, mensagem, textoConfirmar = 'Confirmar', textoCancelar = 'Cancelar', perigo = false }) {
  return new Promise(resolve => {
    if (resolverAtual) responderConfirm(false);
    resolverAtual = resolve;
    document.getElementById('confirm-titulo').textContent = titulo;
    document.getElementById('confirm-mensagem').textContent = mensagem;
    document.getElementById('confirm-btn-cancelar').textContent = textoCancelar;
    const btnOk = document.getElementById('confirm-btn-ok');
    btnOk.textContent = textoConfirmar;
    btnOk.className = perigo ? 'btn-danger-solid' : 'btn-save';
    document.getElementById('modal-confirm').classList.add('open');
  });
}

// Chamada pelos botões do modal (Confirmar/Cancelar) e pelo clique no fundo.
export function responderConfirm(valor) {
  fecharModal('modal-confirm');
  const resolve = resolverAtual;
  resolverAtual = null;
  if (resolve) resolve(valor);
}

// Clicar fora do card cancela (resolve false) sem alterar nada, igual aos demais modais.
document.getElementById('modal-confirm').addEventListener('mousedown', e => {
  if (e.target === e.currentTarget) responderConfirm(false);
});
