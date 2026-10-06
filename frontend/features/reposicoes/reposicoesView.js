import { state } from '../../state/store.js';
import { aulasDaTurma } from '../../../backend/domain/attendance.js';
import { opcaoEscolhida, turmaDaAulaPerdida, resultadoReposicao } from '../../../backend/domain/reposicoes.js';
import { escapeHtml, showToast } from '../../shared/dom.js';
import { confirmar } from '../../shared/confirm.js';
import { goTab } from '../../shared/navigation.js';
import { carregarReposicoes, cancelarReposicao, assinarMudancasReposicoes } from '../../../backend/api/reposicoesRepo.js';
import { buscarPresenca, salvarPresenca, gravarPresenca } from '../../../backend/api/presencasRepo.js';
import { abrirChamada, selecionarAula } from '../chamada/chamadaView.js';
import { atualizarTelas } from '../../shared/refresh.js';

const STATUS_INFO = {
  aberta: { label: 'Aguardando escolha', cls: 'rep-pill-aguardando' },
  agendada: { label: 'Agendada', cls: 'rep-pill-agendada' },
  concluida: { label: 'Concluída', cls: 'rep-pill-concluida' },
  cancelada: { label: 'Cancelada', cls: 'rep-pill-cancelada' },
};

// Reposição concluída = já marcada na chamada da turma escolhida; o que foi
// marcado lá aparece junto, já que "concluída" sozinho não diz se o aluno foi.
const RESULTADO_INFO = {
  P: { label: 'Concluída · Presente', cls: 'rep-pill-concluida' },
  R: { label: 'Concluída · Gravação', cls: 'rep-pill-concluida' },
  F: { label: 'Concluída · Faltou', cls: 'rep-pill-cancelada' },
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

// Relê só a presença da aula perdida de um aluno — quando outra pessoa marca
// a reposição na chamada, o lançamento vai para lá (ver marcarReposicao).
async function recarregarPresencaDaAulaPerdida(rep) {
  const aluno = state.ALUNOS.find(a => a.id === rep.aluno_id);
  if (!aluno) return;
  const turmaId = turmaDaAulaPerdida(rep, aluno);
  const { data, error } = await buscarPresenca(turmaId, aluno.id, rep.aula);
  if (error) return;
  const key = `${turmaId}_${rep.aula}`;
  if (!state.PRESENCAS[key]) state.PRESENCAS[key] = {};
  state.PRESENCAS[key][aluno.id] = data?.status || null;
}

// Mantém o painel em dia com as reposições sem recarregar a página: quando um
// aluno confirma um horário pelo link público (mostra um toast e ele já passa
// a aparecer na chamada da turma escolhida) e quando outra pessoa marca ou
// cancela uma reposição. Chamado uma vez, logo após o login.
export function iniciarNotificacoesReposicoes() {
  assinarMudancasReposicoes(async (nova) => {
    const anterior = state.REPOSICOES.find(r => r.id === nova.id);
    // Eco de uma mudança feita nesta mesma aba (marcar na chamada, cancelar):
    // o cache já foi atualizado na hora, não há o que refazer.
    if (anterior && anterior.status === nova.status && anterior.opcao_escolhida_id === nova.opcao_escolhida_id) return;

    // Recarrega a lista inteira em vez de remendar o cache: uma reposição
    // criada por outra pessoa depois do login nem estaria nele, e sem as
    // opções dela não dá pra saber em que turma o aluno vai repor.
    state.REPOSICOES = await carregarReposicoes();
    const rep = state.REPOSICOES.find(r => r.id === nova.id);
    if (rep) await recarregarPresencaDaAulaPerdida(rep);

    if (rep && rep.status === 'agendada' && (!anterior || anterior.status === 'aberta')) {
      const aluno = state.ALUNOS.find(a => a.id === rep.aluno_id);
      const opcao = opcaoEscolhida(rep);
      const turma = opcao ? state.TURMAS.find(t => t.id === opcao.turma_destino_id) : null;
      showToast(`${aluno?.nome || 'Um aluno'} marcou reposição: ${formatData(opcao?.data)}${turma ? ' — ' + turma.turma : ''}`, 'blue');
    }
    atualizarTelas();
  });
}

function pillReposicao(r) {
  const opcao = opcaoEscolhida(r);
  if (r.status === 'agendada' && opcao) {
    const turma = state.TURMAS.find(t => t.id === opcao.turma_destino_id);
    return `<span class="rep-pill ${STATUS_INFO.agendada.cls}">${formatData(opcao.data)} · ${escapeHtml(turma?.turma) || '?'}</span>`;
  }
  const info = (r.status === 'concluida' && RESULTADO_INFO[resultadoReposicao(r)]) || STATUS_INFO[r.status] || STATUS_INFO.aberta;
  return `<span class="rep-pill ${info.cls}">${info.label}</span>`;
}

export function aplicarFiltroReposicoes() {
  const tbody = document.getElementById('tbody-reposicoes');
  if (!tbody) return;
  const busca = (document.getElementById('busca-reposicoes') || {}).value?.toLowerCase() || '';
  const fStatus = document.getElementById('f-status-reposicoes')?.value || '';

  let lista = state.REPOSICOES;
  lista = lista.map(r => ({ ...r, aluno: state.ALUNOS.find(a => a.id === r.aluno_id) }));
  if (busca) lista = lista.filter(r => r.aluno?.nome?.toLowerCase().includes(busca));
  if (fStatus) lista = lista.filter(r => r.status === fStatus);

  tbody.innerHTML = lista.map(r => {
    const turmaOrigem = state.TURMAS.find(t => t.id === r.turma_origem_id);
    const opcoes = r.reposicao_opcoes || [];
    const turmaEscolhida = state.TURMAS.find(t => t.id === opcaoEscolhida(r)?.turma_destino_id);

    const opcoesTxt = opcoes.length ? opcoes.map(o => {
      const td = state.TURMAS.find(t => t.id === o.turma_destino_id);
      const marcada = o.id === r.opcao_escolhida_id;
      return `<div class="rep-opcao-item${marcada ? ' escolhida' : ''}">${formatData(o.data)} — ${escapeHtml(td?.turma) || '?'}${marcada ? ' ✓' : ''}</div>`;
    }).join('') : '<span class="muted">—</span>';

    // A informação mais importante (o que o aluno escolheu, ou se ainda não
    // escolheu) fica logo ao lado do nome — não escondida numa coluna à parte.
    return `<tr class="${r.aluno?.experimental ? 'row-experimental' : ''}">
      <td>
        <div class="rep-aluno-cell">
          <span class="rep-aluno-nome">${escapeHtml(r.aluno?.nome) || '—'}</span>
          ${pillReposicao(r)}
        </div>
      </td>
      <td style="color:var(--text-3);">${escapeHtml(turmaOrigem?.turma) || '—'} · ${escapeHtml(r.aula)}</td>
      <td style="font-size:11px;">${opcoesTxt}</td>
      <td style="font-size:11px;color:var(--text-3);">${new Date(r.created_at).toLocaleDateString('pt-BR')}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn-sec" onclick="copiarLinkReposicaoLista('${r.token}')" title="Copiar link de agendamento">Link</button>
          ${(r.status === 'agendada' || r.status === 'concluida') && turmaEscolhida ? `<button class="btn-sec" onclick="abrirChamadaReposicao(${r.id})" title="Abrir a chamada de ${escapeHtml(turmaEscolhida.turma)} na ${escapeHtml(r.aula)} — é lá que a reposição é marcada">Chamada</button>` : ''}
          ${r.status !== 'cancelada' ? `<button class="btn-danger" onclick="cancelarReposicaoAcao(event, ${r.id})">Cancelar</button>` : ''}
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

// Leva direto para a chamada da turma escolhida, já na aula a repor — é lá
// que o aluno aparece com o aviso "Reposição" e a presença é marcada.
export function abrirChamadaReposicao(id) {
  const r = state.REPOSICOES.find(x => x.id === id);
  const turma = r && state.TURMAS.find(t => t.id === opcaoEscolhida(r)?.turma_destino_id);
  if (!turma) return;
  goTab('turmas');
  abrirChamada(turma.id);
  if (aulasDaTurma(turma).includes(r.aula)) selecionarAula(r.aula);
  else showToast(`A turma ${turma.turma} não tem a ${r.aula}.`, 'red');
}

// Cancelada = o aluno não fez a reposição. Ele sai da chamada da turma em que
// ia repor e a aula perdida perde o aviso de reposição — as duas coisas só
// valem para reposições agendadas/concluídas (seção 8.3), e nada da reposição
// é gravado na turma destino. Se ela já tinha sido marcada na chamada, o
// lançamento (que foi para a aula perdida) é desfeito e a aula volta a ter a
// falta de antes do link; se não, a aula perdida nunca foi tocada pelo fluxo.
export async function cancelarReposicaoAcao(e, id) {
  const r = state.REPOSICOES.find(x => x.id === id);
  if (!r) return;
  // event.currentTarget só é válido durante o disparo síncrono do evento —
  // depois de um `await` (aqui, esperando a resposta do diálogo de
  // confirmação) o navegador já zerou essa referência, então o botão
  // precisa ser capturado ANTES do primeiro await.
  const btn = e.currentTarget;
  const desfazLancamento = r.status === 'concluida';
  const ok = await confirmar({
    titulo: 'Cancelar esta reposição?',
    mensagem: desfazLancamento
      ? `O aluno sai da chamada da turma em que fez a reposição, e o que foi marcado lá é desfeito: a ${r.aula} volta a ficar com falta na turma original.`
      : 'O link deixará de funcionar e, se o aluno já tinha escolhido um horário, ele sai da chamada daquela turma.',
    textoConfirmar: 'Cancelar reposição',
    perigo: true,
  });
  if (!ok) return;
  btn.disabled = true;
  btn.textContent = 'Cancelando…';

  const aluno = state.ALUNOS.find(a => a.id === r.aluno_id);
  const turmaId = turmaDaAulaPerdida(r, aluno);
  const key = `${turmaId}_${r.aula}`;
  if (!state.PRESENCAS[key]) state.PRESENCAS[key] = {};
  const anterior = { presenca: state.PRESENCAS[key][r.aluno_id] ?? null, status: r.status };

  // Atualiza o cache antes de gravar: assim o Realtime reconhece o eco desta
  // mudança (iniciarNotificacoesReposicoes) e não recarrega tudo à toa.
  r.status = 'cancelada';
  if (desfazLancamento) state.PRESENCAS[key][r.aluno_id] = 'F';

  // Presença antes do status, pelo mesmo motivo de marcarReposicao: a troca de
  // status é o que avisa as outras abas, e elas releem a presença nesse momento.
  let error = null;
  if (desfazLancamento) ({ error } = await salvarPresenca(turmaId, r.aluno_id, r.aula, 'F'));
  if (!error) {
    ({ error } = await cancelarReposicao(id));
    if (error && desfazLancamento) await gravarPresenca(turmaId, r.aluno_id, r.aula, anterior.presenca);
  }

  if (error) {
    console.error('Erro ao cancelar reposição:', error);
    r.status = anterior.status;
    state.PRESENCAS[key][r.aluno_id] = anterior.presenca;
    showToast('Erro ao cancelar.', 'red');
    btn.disabled = false; btn.textContent = 'Cancelar';
    return;
  }
  atualizarTelas();
  showToast('Reposição cancelada.', 'red');
}
