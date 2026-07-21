import { state } from '../../state/store.js';
import { escapeHtml, showToast } from '../../shared/dom.js';
import {
  carregarReposicoes, cancelarReposicao, concluirReposicao,
  assinarMudancasReposicoes, buscarOpcaoReposicao,
} from '../../api/reposicoesRepo.js';
import { salvarPresenca } from '../../api/presencasRepo.js';
import { renderDash } from '../dashboard/dashboardView.js';
import { renderTabelaAlunos } from '../alunos/alunosTable.js';
import { renderRel } from '../relatorios/relatoriosView.js';

const STATUS_INFO = {
  aberta: { label: 'Aguardando escolha', cls: 'rep-pill-aguardando' },
  agendada: { label: 'Agendada', cls: 'rep-pill-agendada' },
  concluida: { label: 'Concluída', cls: 'rep-pill-concluida' },
  cancelada: { label: 'Cancelada', cls: 'rep-pill-cancelada' },
};

function linkReposicao(token) {
  return new URL(`reposicao.html?token=${token}`, window.location.href).href;
}

function formatData(d) {
  return d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '—';
}

export async function renderReposicoes() {
  const tbody = document.getElementById('tbody-reposicoes');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" class="empty">Carregando...</td></tr>';

  state.REPOSICOES = await carregarReposicoes();
  aplicarFiltroReposicoes();
}

// Aviso em tempo real: assim que um aluno confirma um horário pelo link
// público, mostra um toast e já atualiza a aba (se estiver aberta) sem
// precisar recarregar a página. Chamado uma vez, logo após o login.
export function iniciarNotificacoesReposicoes() {
  assinarMudancasReposicoes(async (repAtualizada) => {
    const aluno = state.ALUNOS.find(a => a.id === repAtualizada.aluno_id);
    const opcao = repAtualizada.opcao_escolhida_id ? await buscarOpcaoReposicao(repAtualizada.opcao_escolhida_id) : null;
    const turma = opcao ? state.TURMAS.find(t => t.id === opcao.turma_destino_id) : null;

    showToast(`📅 ${aluno?.nome || 'Um aluno'} marcou reposição: ${formatData(opcao?.data)}${turma ? ' — ' + turma.turma : ''}`, 'blue');

    const cache = (state.REPOSICOES || []).find(r => r.id === repAtualizada.id);
    if (cache) {
      cache.status = repAtualizada.status;
      cache.opcao_escolhida_id = repAtualizada.opcao_escolhida_id;
      cache.confirmado_em = repAtualizada.confirmado_em;
    }
    aplicarFiltroReposicoes();
  });
}

export function aplicarFiltroReposicoes() {
  const tbody = document.getElementById('tbody-reposicoes');
  if (!tbody) return;
  const busca = (document.getElementById('busca-reposicoes') || {}).value?.toLowerCase() || '';
  const fStatus = document.getElementById('f-status-reposicoes')?.value || '';

  let lista = state.REPOSICOES || [];
  lista = lista.map(r => ({ ...r, aluno: state.ALUNOS.find(a => a.id === r.aluno_id) }));
  if (busca) lista = lista.filter(r => r.aluno?.nome?.toLowerCase().includes(busca));
  if (fStatus) lista = lista.filter(r => r.status === fStatus);

  tbody.innerHTML = lista.map(r => {
    const turmaOrigem = state.TURMAS.find(t => t.id === r.turma_origem_id);
    const st = STATUS_INFO[r.status] || STATUS_INFO.aberta;
    const opcoes = r.reposicao_opcoes || [];
    const opcaoEscolhida = opcoes.find(o => o.id === r.opcao_escolhida_id);
    const turmaEscolhida = opcaoEscolhida ? state.TURMAS.find(t => t.id === opcaoEscolhida.turma_destino_id) : null;

    // A informação mais importante (o que o aluno escolheu, ou se ainda não
    // escolheu) fica logo ao lado do nome — não escondida numa coluna à parte.
    const pill = r.status === 'agendada' && opcaoEscolhida
      ? `<span class="rep-pill ${st.cls}">📅 ${formatData(opcaoEscolhida.data)} · ${escapeHtml(turmaEscolhida?.turma) || '?'}</span>`
      : `<span class="rep-pill ${st.cls}">${st.label}</span>`;

    const opcoesTxt = opcoes.length ? opcoes.map(o => {
      const td = state.TURMAS.find(t => t.id === o.turma_destino_id);
      const marcada = o.id === r.opcao_escolhida_id;
      return `<div class="rep-opcao-item${marcada ? ' escolhida' : ''}">${formatData(o.data)} — ${escapeHtml(td?.turma) || '?'}${marcada ? ' ✓' : ''}</div>`;
    }).join('') : '<span class="muted">—</span>';

    return `<tr>
      <td>
        <div class="rep-aluno-cell">
          <span class="rep-aluno-nome">${escapeHtml(r.aluno?.nome) || '—'}</span>
          ${pill}
        </div>
      </td>
      <td style="color:var(--text-3);">${escapeHtml(turmaOrigem?.turma) || '—'} · ${escapeHtml(r.aula)}</td>
      <td style="font-size:11px;">${opcoesTxt}</td>
      <td style="font-size:11px;color:var(--text-3);">${new Date(r.created_at).toLocaleDateString('pt-BR')}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn-sec" onclick="copiarLinkReposicaoLista('${r.token}')" title="Copiar link de agendamento">🔗 Link</button>
          ${r.status === 'agendada' ? `<button class="btn-save" onclick="concluirReposicaoAcao(${r.id})" title="Marcar a aula de origem como reposição (R) feita">Concluir</button>` : ''}
          ${(r.status === 'aberta' || r.status === 'agendada') ? `<button class="btn-danger" onclick="cancelarReposicaoAcao(${r.id})">Cancelar</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">Nenhuma reposição encontrada.</td></tr>';
}

export function copiarLinkReposicaoLista(token) {
  const link = linkReposicao(token);
  navigator.clipboard?.writeText(link)
    .then(() => showToast('Link copiado!'))
    .catch(() => showToast(link, 'blue'));
}

export async function cancelarReposicaoAcao(id) {
  if (!confirm('Cancelar esta reposição? O link deixará de funcionar.')) return;
  const { error } = await cancelarReposicao(id);
  if (error) { showToast('Erro ao cancelar.', 'red'); return; }
  const r = state.REPOSICOES.find(x => x.id === id);
  if (r) r.status = 'cancelada';
  aplicarFiltroReposicoes();
  showToast('Reposição cancelada.', 'red');
}

export async function concluirReposicaoAcao(id) {
  const r = state.REPOSICOES.find(x => x.id === id);
  if (!r) return;
  if (!confirm('Marcar esta reposição como concluída?\n\nIsso vai registrar "Gravação (R)" na aula de origem do aluno.')) return;

  const { error } = await salvarPresenca(r.turma_origem_id, r.aluno_id, r.aula, 'R');
  if (error) { showToast('Erro ao registrar a presença de reposição.', 'red'); return; }

  const key = `${r.turma_origem_id}_${r.aula}`;
  if (!state.PRESENCAS[key]) state.PRESENCAS[key] = {};
  state.PRESENCAS[key][r.aluno_id] = 'R';

  const { error: errStatus } = await concluirReposicao(id);
  if (errStatus) { showToast('Presença gravada, mas houve erro ao marcar o caso como concluído.', 'red'); }
  r.status = 'concluida';

  aplicarFiltroReposicoes();
  renderDash();
  renderTabelaAlunos();
  renderRel();
  showToast('Reposição concluída!');
}
