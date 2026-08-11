import { sb } from '../../../backend/api/supabaseClient.js';
import { state } from '../../state/store.js';
import { estaEmRecuperacaoSenha } from './recovery.js';
import { moverIndicadorNav } from '../../shared/navigation.js';
import { carregarTurmas } from '../../../backend/api/turmasRepo.js';
import { carregarAlunos } from '../../../backend/api/alunosRepo.js';
import { carregarPresencas } from '../../../backend/api/presencasRepo.js';
import { carregarHistorico } from '../../../backend/api/historicoRepo.js';
import { carregarProfessores } from '../../../backend/api/professoresRepo.js';
import { carregarCursos, sincronizarCursosComTurmas } from '../../../backend/api/cursosRepo.js';
import { popularFiltros, renderRel } from '../relatorios/relatoriosView.js';
import { renderDash } from '../dashboard/dashboardView.js';
import { renderTabelaAlunos } from '../alunos/alunosTable.js';
import { iniciarNotificacoesReposicoes } from '../reposicoes/reposicoesView.js';

let autoLoginTimer = null;

// Login automático quando o navegador preenche e-mail/senha sozinho
// (autofill do gerenciador de senhas). Espera os campos ficarem estáveis por
// 400ms antes de logar — evita disparar no meio da digitação manual (ex.:
// com a senha ainda incompleta). Nunca dispara durante a tela de
// recuperação/troca de senha (estaEmRecuperacaoSenha()), mesmo que os campos
// escondidos do login ainda tenham valor — é o mesmo tipo de corrida que já
// causava as duas telas aparecerem juntas.
function agendarAutoLogin() {
  clearTimeout(autoLoginTimer);
  if (estaEmRecuperacaoSenha()) return;
  const email = document.getElementById('inp-email').value.trim();
  const senha = document.getElementById('inp-senha').value;
  if (!email || !senha) return;
  autoLoginTimer = setTimeout(() => {
    const aindaEmail = document.getElementById('inp-email').value.trim();
    const aindaSenha = document.getElementById('inp-senha').value;
    if (aindaEmail === email && aindaSenha === senha && !estaEmRecuperacaoSenha()) {
      doLogin();
    }
  }, 400);
}

export function wireAutoLogin() {
  document.getElementById('inp-email').addEventListener('input', agendarAutoLogin);
  document.getElementById('inp-senha').addEventListener('input', agendarAutoLogin);
}

export async function doLogin() {
  const email = document.getElementById('inp-email').value.trim();
  const senha = document.getElementById('inp-senha').value;
  const btn = document.getElementById('btn-login');
  btn.disabled = true; btn.textContent = 'Entrando...';
  document.getElementById('login-err').style.display = 'none';

  const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
  if (error) {
    document.getElementById('login-err').style.display = 'block';
    btn.disabled = false; btn.textContent = 'Entrar';
    return;
  }
  state.usuarioLogado = data.user;
  await carregarPerfil();
  await inicializarApp();
}

export async function carregarPerfil() {
  const { data } = await sb.from('professores').select('*').eq('user_id', state.usuarioLogado.id).single();
  state.perfilLogado = data;
}

export async function doLogout() {
  await sb.auth.signOut();
  state.usuarioLogado = null;
  state.perfilLogado = null;
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-page').style.display = 'flex';
  document.getElementById('inp-senha').value = '';
  const btn = document.getElementById('btn-login');
  btn.disabled = false; btn.textContent = 'Entrar';
}

export async function inicializarApp() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app-loading').classList.add('visible');
  const ini = state.perfilLogado?.nome ? state.perfilLogado.nome.substring(0, 2).toUpperCase() : '--';
  document.getElementById('av').textContent = ini;
  document.getElementById('hname').textContent = state.perfilLogado?.nome || state.usuarioLogado.email;

  // Mostrar aba Professores apenas para admins
  if (state.perfilLogado?.papel === 'admin') {
    document.getElementById('nav-prof').classList.remove('hidden');
  }

  try {
    await carregarTurmas();
    await carregarAlunos();
    await Promise.all([carregarPresencas(), carregarHistorico(), carregarProfessores(), carregarCursos()]);
    await sincronizarCursosComTurmas();

    popularFiltros();
    renderDash();
    renderTabelaAlunos();
    renderRel();
    iniciarNotificacoesReposicoes();
  } finally {
    document.getElementById('app-loading').classList.remove('visible');
    document.getElementById('app').classList.remove('hidden');
    moverIndicadorNav();
  }
}

// Retoma a sessão automaticamente se o navegador ainda tiver um token válido.
export function restoreSession() {
  sb.auth.getSession().then(async ({ data }) => {
    if (estaEmRecuperacaoSenha()) return; // já tratado pela tela de recuperação
    if (data.session) {
      state.usuarioLogado = data.session.user;
      await carregarPerfil();
      await inicializarApp();
    }
  });
}
