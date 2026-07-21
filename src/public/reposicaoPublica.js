// Página pública de reposição — não faz parte do painel interno, não usa
// login/Auth nem o `state` do painel. É intencionalmente isolada: fala com o
// Supabase só através de duas funções (RPC) que validam o token do link,
// nunca lendo/escrevendo as tabelas diretamente (ver sql/reposicoes.sql).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config/env.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = document.getElementById('app');
const token = new URLSearchParams(window.location.search).get('token');

let dadosAtuais = null;
let opcaoSelecionadaId = null;

const ESCAPE_HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, c => ESCAPE_HTML_MAP[c]);
}

function formatData(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  const txt = dt.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

function formatHorario(h) {
  return h ? h.slice(0, 5) : '';
}

function renderLoading() {
  app.innerHTML = `<div class="card"><div class="spinner"></div><p class="muted">Carregando...</p></div>`;
}

function renderErro(msg) {
  app.innerHTML = `<div class="card"><div class="icone">⚠️</div><h1>Não foi possível abrir</h1><p>${msg}</p></div>`;
}

function opcaoCardHtml(o, { clicavel, marcada }) {
  return `<${clicavel ? 'button type="button"' : 'div'} class="opcao-card${marcada ? ' selecionada' : ''}"${clicavel ? ` data-id="${o.id}"` : ''}>
    <div class="opcao-data">${formatData(o.data)}</div>
    <div class="opcao-turma">${escapeHtml(o.turma)}${o.horario ? ' · ' + formatHorario(o.horario) : ''}</div>
    ${o.professor ? `<div class="opcao-prof">Prof. ${escapeHtml(o.professor)}</div>` : ''}
    ${o.observacao ? `<div class="opcao-obs">${escapeHtml(o.observacao)}</div>` : ''}
  </${clicavel ? 'button' : 'div'}>`;
}

function renderEstado() {
  const d = dadosAtuais;
  if (!d || d.erro === 'nao_encontrado') {
    renderErro('Este link não é válido. Confira se copiou o endereço completo ou fale com a equipe.');
    return;
  }

  if (d.status === 'cancelada') {
    renderErro('Esta reposição foi cancelada. Fale com a equipe para reagendar.');
    return;
  }

  if (d.status === 'concluida') {
    app.innerHTML = `<div class="card">
      <div class="icone">✅</div>
      <h1>Reposição já realizada</h1>
      <p>A reposição de <strong>${escapeHtml(d.aula)}</strong> de ${escapeHtml(d.aluno_nome)} já foi concluída.</p>
    </div>`;
    return;
  }

  if (d.status === 'agendada') {
    const opc = d.opcoes.find(o => o.id === d.opcao_escolhida_id);
    app.innerHTML = `<div class="card">
      <div class="icone">📅</div>
      <h1>Reposição confirmada</h1>
      <p class="sub">${escapeHtml(d.aluno_nome)} — ${escapeHtml(d.aula)} (${escapeHtml(d.turma_origem)})</p>
      ${opc ? opcaoCardHtml(opc, { clicavel: false, marcada: true }) : ''}
      <p class="muted">Já está anotado! Qualquer dúvida, fale com a equipe.</p>
    </div>`;
    return;
  }

  // status === 'aberta'
  app.innerHTML = `<div class="card">
    <div class="icone">📚</div>
    <h1>Marcar reposição</h1>
    <p class="sub">${escapeHtml(d.aluno_nome)} faltou em <strong>${escapeHtml(d.aula)}</strong>${d.curso ? ' · ' + escapeHtml(d.curso) : ''}</p>
    <p class="instrucao">Escolha um dos horários abaixo para repor essa aula:</p>
    <div class="opcoes">
      ${d.opcoes.map(o => opcaoCardHtml(o, { clicavel: true, marcada: o.id === opcaoSelecionadaId })).join('') || '<p class="muted">Nenhum horário disponível no momento — fale com a equipe.</p>'}
    </div>
    ${d.opcoes.length ? `<button type="button" class="btn-confirmar" id="btn-confirmar" ${opcaoSelecionadaId ? '' : 'disabled'}>Confirmar escolha</button>` : ''}
    <div class="erro" id="erro-confirmar"></div>
  </div>`;

  app.querySelectorAll('.opcao-card[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      opcaoSelecionadaId = parseInt(el.dataset.id, 10);
      renderEstado();
    });
  });
  const btnConfirmar = document.getElementById('btn-confirmar');
  if (btnConfirmar) btnConfirmar.addEventListener('click', confirmar);
}

async function carregar() {
  renderLoading();
  if (!token) { renderErro('Faltou o código de acesso no link.'); return; }

  const { data, error } = await sb.rpc('reposicao_publica_get', { p_token: token });
  if (error) { renderErro('Não foi possível carregar essa reposição agora. Tente novamente em instantes.'); return; }

  dadosAtuais = data;
  renderEstado();
}

async function confirmar() {
  if (!opcaoSelecionadaId) return;
  const btn = document.getElementById('btn-confirmar');
  const erroEl = document.getElementById('erro-confirmar');
  btn.disabled = true;
  btn.textContent = 'Confirmando...';
  erroEl.textContent = '';

  const { data, error } = await sb.rpc('reposicao_publica_confirmar', { p_token: token, p_opcao_id: opcaoSelecionadaId });
  if (error || data?.erro) {
    erroEl.textContent = 'Esse horário não está mais disponível. Atualizando as opções...';
    await carregar();
    return;
  }
  await carregar();
}

carregar();
