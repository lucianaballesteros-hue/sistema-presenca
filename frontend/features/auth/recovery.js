import { sb } from '../../api/supabaseClient.js';
import { showToast } from '../../shared/dom.js';
import { isEmailValido } from '../../shared/validators.js';
import { enviarResetSenha } from '../../api/professoresRepo.js';

let emFluxoRecuperacao = false;

// Registrado assim que este módulo é importado (por main.js, antes de
// restoreSession() rodar) para não perder o evento PASSWORD_RECOVERY, que o
// SDK do Supabase dispara ao detectar o token de recuperação no hash da URL
// durante a inicialização do client.
sb.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') {
    emFluxoRecuperacao = true;
    mostrarTelaNovaSenha();
  }
});

export function estaEmRecuperacaoSenha() {
  return emFluxoRecuperacao;
}

function mostrarTelaNovaSenha() {
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('recover-request-page').style.display = 'none';
  document.getElementById('recovery-page').style.display = 'flex';
  // Limpa o token do hash pra não reprocessar num refresh.
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

export function abrirRecuperarSenha() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('rec-email').value = document.getElementById('inp-email').value.trim();
  document.getElementById('rec-err').style.display = 'none';
  document.getElementById('recover-request-page').style.display = 'flex';
}

export function voltarParaLogin() {
  document.getElementById('recover-request-page').style.display = 'none';
  document.getElementById('login-page').style.display = 'flex';
}

export async function enviarLinkRecuperacao() {
  const email = document.getElementById('rec-email').value.trim();
  const errEl = document.getElementById('rec-err');
  const btn = document.getElementById('btn-rec-enviar');
  errEl.style.display = 'none';

  if (!isEmailValido(email)) {
    errEl.textContent = 'Digite um e-mail válido.';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Enviando...';
  const { error } = await enviarResetSenha(email);
  btn.disabled = false;
  btn.textContent = 'Enviar link de recuperação';

  if (error) {
    errEl.textContent = 'Não foi possível enviar o e-mail. Tente novamente.';
    errEl.style.display = 'block';
    return;
  }

  showToast(`Link de recuperação enviado para ${email}!`, 'blue');
  voltarParaLogin();
}

export async function salvarNovaSenhaRecuperacao() {
  const novaSenha = document.getElementById('rec-nova-senha').value;
  const confirmaSenha = document.getElementById('rec-confirma-senha').value;
  const errEl = document.getElementById('rec-nova-erro');
  const btn = document.getElementById('btn-rec-salvar');
  errEl.style.display = 'none';

  if (!novaSenha || novaSenha.length < 6) {
    errEl.textContent = 'A senha deve ter pelo menos 6 caracteres.';
    errEl.style.display = 'block';
    return;
  }
  if (novaSenha !== confirmaSenha) {
    errEl.textContent = 'As senhas não coincidem.';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Salvando...';
  const { error } = await sb.auth.updateUser({ password: novaSenha });

  if (error) {
    errEl.textContent = 'Erro ao salvar a nova senha. Tente novamente ou solicite um novo link.';
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Salvar nova senha';
    return;
  }

  emFluxoRecuperacao = false;
  await sb.auth.signOut(); // evita ficar autenticado por um token de recuperação temporário
  document.getElementById('rec-nova-senha').value = '';
  document.getElementById('rec-confirma-senha').value = '';
  document.getElementById('recovery-page').style.display = 'none';
  document.getElementById('login-page').style.display = 'flex';
  showToast('Senha alterada! Faça login com a nova senha.', 'green');
}
