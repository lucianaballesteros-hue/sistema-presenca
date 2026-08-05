import { state } from '../../state/store.js';
import { isEmailValido } from '../../shared/validators.js';
import { showToast, fecharModal } from '../../shared/dom.js';
import { criarContaAuth, criarPerfilProfessor, atualizarProfessor, enviarResetSenha as enviarResetSenhaRepo } from '../../../backend/api/professoresRepo.js';
import { renderProfessores } from './professoresView.js';
import { popularFiltros, renderRel } from '../relatorios/relatoriosView.js';
import { renderDash } from '../dashboard/dashboardView.js';
import { renderTabelaAlunos } from '../alunos/alunosTable.js';

export function abrirModalNovoProf() {
  document.getElementById('np-nome').value = '';
  document.getElementById('np-email').value = '';
  document.getElementById('np-senha').value = 'Teste1234';
  document.getElementById('np-papel').value = 'professor';
  document.getElementById('np-erro').style.display = 'none';
  document.getElementById('np-btn').disabled = false;
  document.getElementById('np-btn').textContent = 'Criar professor';
  document.getElementById('modal-novo-prof').classList.add('open');
}

export async function salvarNovoProf() {
  const nome = document.getElementById('np-nome').value.trim();
  const email = document.getElementById('np-email').value.trim();
  const senha = document.getElementById('np-senha').value;
  const papel = document.getElementById('np-papel').value;
  const erroEl = document.getElementById('np-erro');
  const btn = document.getElementById('np-btn');

  erroEl.style.display = 'none';
  if (!nome) { erroEl.textContent = 'Digite o nome.'; erroEl.style.display = 'block'; return; }
  if (!isEmailValido(email)) { erroEl.textContent = 'Digite um e-mail válido.'; erroEl.style.display = 'block'; return; }
  if (!senha || senha.length < 6) { erroEl.textContent = 'A senha deve ter pelo menos 6 caracteres.'; erroEl.style.display = 'block'; return; }

  btn.disabled = true;
  btn.textContent = 'Criando...';

  try {
    // Cria usuário via REST sem afetar a sessão atual
    const authData = await criarContaAuth(email, senha);

    if (authData.error || authData.msg) {
      const msg = authData.error?.message || authData.msg || 'Erro ao criar usuário.';
      erroEl.textContent = msg.includes('already registered') ? 'Este e-mail já está cadastrado.' : msg;
      erroEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Criar professor';
      return;
    }

    const newUserId = authData.user?.id || authData.id;
    if (!newUserId) {
      erroEl.textContent = 'Erro inesperado ao criar usuário. Tente novamente.';
      erroEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Criar professor';
      return;
    }

    const { data: profData, error: profError } = await criarPerfilProfessor({ nome, email, papel, user_id: newUserId });
    if (profError) {
      erroEl.textContent = 'Usuário criado, mas erro ao salvar perfil: ' + profError.message;
      erroEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Criar professor';
      return;
    }

    state.PROFESSORES.push(profData);
    fecharModal('modal-novo-prof');
    showToast(`Professor ${nome} criado com sucesso!`);
    renderProfessores();
    popularFiltros();

  } catch (err) {
    console.error('Erro ao criar professor:', err);
    erroEl.textContent = 'Erro de conexão. Tente novamente.';
    erroEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Criar professor';
  }
}

export function abrirModalEditarProf(id) {
  const p = state.PROFESSORES.find(x => x.id === id);
  if (!p) return;
  state.profSelecionadoId = id;
  document.getElementById('ep-nome').value = p.nome || '';
  document.getElementById('ep-email').value = p.email || '';
  document.getElementById('ep-papel').value = p.papel || 'professor';
  document.getElementById('ep-erro').style.display = 'none';
  const btnSalvar = document.getElementById('ep-btn-salvar');
  btnSalvar.disabled = false;
  btnSalvar.textContent = 'Salvar alterações';
  const btnReset = document.getElementById('ep-btn-reset');
  btnReset.disabled = false;
  btnReset.textContent = '✉ Enviar reset de senha';
  document.getElementById('modal-editar-prof').classList.add('open');
}

export async function salvarEdicaoProf() {
  const p = state.PROFESSORES.find(x => x.id === state.profSelecionadoId);
  if (!p) return;
  const novoNome = document.getElementById('ep-nome').value.trim();
  const novoEmail = document.getElementById('ep-email').value.trim();
  const novoPapel = document.getElementById('ep-papel').value;
  const erroEl = document.getElementById('ep-erro');
  erroEl.style.display = 'none';

  if (!novoNome) { erroEl.textContent = 'Digite o nome.'; erroEl.style.display = 'block'; return; }
  if (!isEmailValido(novoEmail)) { erroEl.textContent = 'Digite um e-mail válido.'; erroEl.style.display = 'block'; return; }

  const updates = { nome: novoNome, papel: novoPapel, email: novoEmail };
  const btnSalvar = document.getElementById('ep-btn-salvar');
  btnSalvar.disabled = true;
  btnSalvar.textContent = 'Salvando…';
  const { error } = await atualizarProfessor(p.id, updates);
  if (error) {
    erroEl.textContent = 'Erro ao salvar: ' + error.message; erroEl.style.display = 'block';
    btnSalvar.disabled = false; btnSalvar.textContent = 'Salvar alterações';
    return;
  }

  p.nome = novoNome;
  p.email = novoEmail;
  p.papel = novoPapel;

  fecharModal('modal-editar-prof');
  showToast('Professor atualizado!');
  renderProfessores(); renderDash(); renderTabelaAlunos(); renderRel();
}

export async function enviarResetSenha() {
  const p = state.PROFESSORES.find(x => x.id === state.profSelecionadoId);
  if (!p?.email) { showToast('E-mail do professor não encontrado.', 'red'); return; }
  const btn = document.getElementById('ep-btn-reset');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  const { error } = await enviarResetSenhaRepo(p.email);
  if (error) {
    showToast('Erro ao enviar e-mail de reset.', 'red');
  } else {
    showToast(`E-mail de redefinição enviado para ${p.email}!`, 'blue');
  }
  btn.disabled = false;
  btn.textContent = '✉ Enviar reset de senha';
}
