import { state } from '../../state/store.js';
import { aulasDaTurma, registroPorAulaDaTurma } from '../../../backend/domain/attendance.js';
import { professorNome, logoCurso } from '../../../backend/domain/status.js';
import {
  opcaoEscolhida, turmaDaAulaPerdida, resultadoReposicao, reposicoesNaAula, reposicaoDaAulaPerdida,
} from '../../../backend/domain/reposicoes.js';
import { escapeHtml, escapeAttr, showToast } from '../../shared/dom.js';
import { salvarPresenca, removerPresenca, gravarPresenca } from '../../../backend/api/presencasRepo.js';
import { atualizarStatusReposicao } from '../../../backend/api/reposicoesRepo.js';
import { atualizarTelas } from '../../shared/refresh.js';

export function abrirChamada(tId) {
  state.turmaAtual = state.TURMAS.find(t => t.id === tId);
  state.chamadaAlterada = {};
  document.getElementById('dash-view').style.display = 'none';
  document.getElementById('chamada-view').style.display = 'block';
  document.getElementById('ch-titulo').textContent = state.turmaAtual.turma + ' — ' + (state.turmaAtual.curso || 'sem curso');
  document.getElementById('ch-sub').textContent = 'Prof. ' + professorNome(state.turmaAtual);
  const logo = logoCurso(state.turmaAtual.curso);
  const logoEl = document.getElementById('ch-logo');
  logoEl.classList.toggle('visible', Boolean(logo));
  if (logo) logoEl.src = logo;
  const sel = document.getElementById('aula-sel');
  sel.innerHTML = aulasDaTurma(state.turmaAtual).map(a => `<option>${a}</option>`).join('');
  renderChamada();
}

export function selecionarAula(aula) {
  document.getElementById('aula-sel').value = aula;
  renderChamada();
}

export function voltarDash() {
  document.getElementById('chamada-view').style.display = 'none';
  document.getElementById('dash-view').style.display = 'block';
}

// Desliza o anel de seleção até o quadradinho da aula ativa, em vez de cada
// quadradinho ligar/desligar o próprio contorno — mesma ideia da pílula do
// nav. O indicador é um elemento fixo (nunca recriado pelo innerHTML da
// grade), então ele anima mesmo quando os quadradinhos em volta são
// redesenhados.
function moverIndicadorAula() {
  const grid = document.getElementById('ch-aulas-grid');
  const indicador = document.getElementById('aula-chip-indicator');
  const ativo = grid?.querySelector('.aula-chip.ativa');
  if (!indicador) return;
  if (!ativo) { indicador.style.opacity = '0'; return; }
  indicador.style.opacity = '1';
  indicador.style.setProperty('--cx', (ativo.offsetLeft - 3) + 'px');
  indicador.style.setProperty('--cy', (ativo.offsetTop - 3) + 'px');
  indicador.style.setProperty('--cw', (ativo.offsetWidth + 6) + 'px');
  indicador.style.setProperty('--ch', (ativo.offsetHeight + 6) + 'px');
}

// Mesma lógica para o grupo Presente/Falta/Gravação de uma linha: a pílula
// colorida desliza até o botão marcado (ou encolhe a zero quando nenhum está
// marcado), em vez do botão simplesmente ligar seu próprio fundo.
function corIndicadorPbtn(val) {
  return val === 'P' ? 'var(--green-soft)' : val === 'F' ? 'var(--red-soft)' : val === 'R' ? 'var(--amber-soft)' : 'transparent';
}

function moverIndicadorPbtn(pbtnsEl, val) {
  const indicador = pbtnsEl?.querySelector('.pbtn-indicator');
  if (!indicador) return;
  const ativo = val ? pbtnsEl.querySelector(`.pbtn[data-val="${val}"]`) : null;
  indicador.style.background = corIndicadorPbtn(val);
  indicador.style.setProperty('--px', (ativo ? ativo.offsetLeft : 0) + 'px');
  indicador.style.setProperty('--pw', (ativo ? ativo.offsetWidth : 0) + 'px');
}

// A posição desses indicadores é medida em pixels (offsetLeft/offsetWidth) e
// fica "presa" no lugar antigo até alguém recalcular — sem isso, girar o
// celular (ou qualquer outro redimensionamento, já que os quadradinhos de
// aula e as linhas de aluno quebram de layout em pontos diferentes) deixava
// o anel/pílula flutuando fora do lugar certo até o próximo clique.
// Linha de aluno vindo repor aula (data-rep-id): o valor marcado não fica
// nesta turma, e sim na aula perdida da turma original (ver marcarReposicao).
function statusDaLinha(row, key) {
  if (row.dataset.repId) {
    const rep = state.REPOSICOES.find(r => r.id === Number(row.dataset.repId));
    return rep ? resultadoReposicao(rep) : '';
  }
  return state.PRESENCAS[key]?.[Number(row.dataset.alunoId)] || '';
}

function posicionarIndicadoresLinhas(key) {
  document.querySelectorAll('#alunos-list .aluno-row').forEach(row => {
    moverIndicadorPbtn(row.querySelector('.pbtns'), statusDaLinha(row, key));
  });
}

function reposicionarIndicadoresChamada() {
  if (!state.turmaAtual) return;
  moverIndicadorAula();
  const aula = document.getElementById('aula-sel')?.value;
  posicionarIndicadoresLinhas(`${state.turmaAtual.id}_${aula}`);
}

window.addEventListener('resize', reposicionarIndicadoresChamada);

function alunosDaChamada() {
  const turmaInativa = state.turmaAtual.ativa === false;
  return state.ALUNOS.filter(a => a.turma_id === state.turmaAtual.id && (turmaInativa || a.ativo));
}

// Quem veio repor a aula também está na sala — entra na contagem junto.
function atualizarContadores(aula) {
  const key = `${state.turmaAtual.id}_${aula}`;
  const valores = [
    ...alunosDaChamada().map(a => state.PRESENCAS[key]?.[a.id]),
    ...reposicoesNaAula(state.turmaAtual.id, aula).map(({ rep }) => resultadoReposicao(rep)),
  ];
  let p = 0, r = 0, f = 0, s = 0;
  valores.forEach(v => {
    if (v === 'P') p++; else if (v === 'R') r++; else if (v === 'F') f++; else s++;
  });
  document.getElementById('ch-counters').innerHTML =
    `<span style="color:var(--green);">✓ ${p} presentes</span><span style="color:var(--red);">✗ ${f} faltas</span><span style="color:var(--amber);">↺ ${r} gravações</span><span>○ ${s} sem registro</span>`;
}

function pbtnsHtml(acao) {
  return `<div class="pbtns">
        <div class="pbtn-indicator"></div>
        <button class="pbtn pbtn-p" data-val="P" onclick="${acao('P')}">✓ Presente</button>
        <button class="pbtn pbtn-f" data-val="F" onclick="${acao('F')}">✗ Falta</button>
        <button class="pbtn pbtn-r" data-val="R" onclick="${acao('R')}">↺ Gravação</button>
      </div>`;
}

function formatDataCurta(d) {
  return d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '';
}

// Na turma de origem: avisa que esta aula do aluno está sendo reposta em
// outra turma — e, depois de marcada lá, explica de onde veio o lançamento.
function avisoReposicaoForaHtml(alunoId, aula) {
  const rep = reposicaoDaAulaPerdida(alunoId, aula);
  const opcao = rep && opcaoEscolhida(rep);
  if (!opcao) return '';
  const destino = state.TURMAS.find(t => t.id === opcao.turma_destino_id);
  const titulo = `${rep.status === 'concluida' ? 'Reposta' : 'Vai repor'} na turma ${destino?.turma || '?'} em ${formatDataCurta(opcao.data)}`;
  return `<span class="aluno-status-reposicao" title="${escapeHtml(titulo)}"><span class="status-dot-rep"></span>Reposição em ${escapeHtml(destino?.turma) || '?'}</span>`;
}

function linhaReposicaoHtml({ rep, aluno }, num) {
  const origem = state.TURMAS.find(t => t.id === rep.turma_origem_id);
  const titulo = `Repondo ${rep.aula}${origem ? ' da turma ' + origem.turma : ''} — o lançamento vai para a turma original do aluno`;
  return `<div class="aluno-row reposicao" data-aluno-id="${aluno.id}" data-rep-id="${rep.id}">
      <div class="aluno-num">${num}</div>
      <div class="aluno-nome" style="cursor:pointer;" onclick="abrirModalAluno(${aluno.id})" title="${escapeHtml(titulo)}">${escapeHtml(aluno.nome)}<span class="aluno-status-reposicao"><span class="status-dot-rep"></span>Reposição</span>${origem ? `<span class="aluno-reposicao-origem">${escapeHtml(origem.turma)}</span>` : ''}</div>
      ${pbtnsHtml(v => `marcarReposicao(${rep.id},'${v}')`)}
    </div>`;
}

export function renderChamada() {
  const aula = document.getElementById('aula-sel').value;
  const key = `${state.turmaAtual.id}_${aula}`;
  if (!state.PRESENCAS[key]) state.PRESENCAS[key] = {};

  const registroAulas = registroPorAulaDaTurma(state.turmaAtual);
  document.getElementById('ch-aulas-grid').innerHTML = aulasDaTurma(state.turmaAtual).map((au, i) => {
    const tem = registroAulas[i];
    const ativa = au === aula;
    const bg = tem ? 'var(--green-soft)' : 'var(--gray-soft)';
    const tc = tem ? 'var(--green-soft-text)' : 'var(--gray-soft-text)';
    return `<div class="aula-chip ${ativa ? 'ativa' : ''}" style="background:${bg};color:${tc};cursor:pointer;" title="Ir para ${au}${tem ? ' (já tem registro)' : ' (sem registro)'}" onclick="selecionarAula('${escapeAttr(au)}')">${i + 1}</div>`;
  }).join('');
  moverIndicadorAula();

  atualizarContadores(aula);

  const alunos = alunosDaChamada();
  const reposicoes = reposicoesNaAula(state.turmaAtual.id, aula);
  const linhasAlunos = alunos.map((a, i) => {
    return `<div class="aluno-row ${a.experimental ? 'experimental' : ''}" data-aluno-id="${a.id}">
      <div class="aluno-num">${i + 1}</div>
      <div class="aluno-nome" style="cursor:pointer;" onclick="abrirModalAluno(${a.id})" title="Ver detalhes do aluno">${escapeHtml(a.nome)}${a.experimental ? '<span class="aluno-status-experimental"><span class="status-dot-exp"></span>Experimental</span>' : ''}${avisoReposicaoForaHtml(a.id, aula)}</div>
      ${pbtnsHtml(v => `marcar(${a.id},'${v}')`)}
    </div>`;
  });
  const linhasReposicao = reposicoes.map((item, i) => linhaReposicaoHtml(item, alunos.length + i + 1));
  document.getElementById('alunos-list').innerHTML =
    [...linhasAlunos, ...linhasReposicao].join('') || '<div class="empty">Nenhum aluno nesta turma.</div>';

  posicionarIndicadoresLinhas(key);
}

function atualizarLinha(row, val) {
  row?.querySelectorAll('.pbtn').forEach(btn => btn.classList.toggle('on', btn.dataset.val === val));
  moverIndicadorPbtn(row?.querySelector('.pbtns'), val);
}

// Atualização de uma marcação sem redesenhar a lista inteira — só assim o
// indicador da linha (e o do quadradinho da aula) tem um elemento estável
// para animar a transição. Antes disso, cada clique chamava renderChamada()
// inteiro e recriava tudo, o que "matava" qualquer animação em andamento.
export async function marcar(alunoId, val) {
  const aula = document.getElementById('aula-sel').value;
  const key = `${state.turmaAtual.id}_${aula}`;
  if (!state.PRESENCAS[key]) state.PRESENCAS[key] = {};
  const atual = state.PRESENCAS[key][alunoId];
  const novoVal = atual === val ? null : val;
  state.PRESENCAS[key][alunoId] = novoVal;

  atualizarLinha(document.querySelector(`#alunos-list .aluno-row[data-aluno-id="${alunoId}"]:not([data-rep-id])`), novoVal);
  atualizarContadores(aula);

  const aulas = aulasDaTurma(state.turmaAtual);
  const idx = aulas.indexOf(aula);
  const chip = document.querySelectorAll('#ch-aulas-grid .aula-chip')[idx];
  if (chip) {
    const tem = registroPorAulaDaTurma(state.turmaAtual)[idx];
    chip.style.background = tem ? 'var(--green-soft)' : 'var(--gray-soft)';
    chip.style.color = tem ? 'var(--green-soft-text)' : 'var(--gray-soft-text)';
  }

  const statusEl = document.getElementById('chamada-status');
  if (statusEl) statusEl.textContent = 'Salvando...';

  try {
    if (novoVal) {
      await salvarPresenca(state.turmaAtual.id, alunoId, aula, novoVal);
    } else {
      await removerPresenca(state.turmaAtual.id, alunoId, aula);
    }
    if (statusEl) { statusEl.textContent = '✓ Salvo'; setTimeout(() => { statusEl.textContent = ''; }, 1500); }
    // A própria lista da chamada já foi atualizada linha a linha acima (sem
    // redesenhar, pra preservar a animação do indicador) — por isso chamada:false.
    atualizarTelas({ chamada: false });
  } catch (err) {
    console.error('Erro ao salvar presença:', err);
    if (statusEl) statusEl.textContent = '';
    showToast('Erro ao salvar. Tente novamente.', 'red');
  }
}

// Marcação de um aluno que veio repor aula nesta turma. O lançamento não fica
// nesta turma: vai direto para a aula perdida, na turma original do aluno — é
// lá que conta na frequência dele, e é lá que ele continua a partir da próxima
// aula. Marcar conclui a reposição; desmarcar volta ela para 'agendada' e
// devolve a falta à aula perdida (a reposição só existe porque ele faltou).
export async function marcarReposicao(repId, val) {
  const rep = state.REPOSICOES.find(r => r.id === repId);
  const aluno = rep && state.ALUNOS.find(a => a.id === rep.aluno_id);
  if (!aluno) return;

  const turmaId = turmaDaAulaPerdida(rep, aluno);
  const key = `${turmaId}_${rep.aula}`;
  const novoVal = resultadoReposicao(rep) === val ? null : val;
  const novaPresenca = novoVal || 'F';
  const novoStatus = novoVal ? 'concluida' : 'agendada';
  if (!state.PRESENCAS[key]) state.PRESENCAS[key] = {};
  const anterior = { presenca: state.PRESENCAS[key][aluno.id] ?? null, status: rep.status };

  state.PRESENCAS[key][aluno.id] = novaPresenca;
  rep.status = novoStatus;
  atualizarLinha(document.querySelector(`#alunos-list .aluno-row[data-rep-id="${repId}"]`), novoVal);
  atualizarContadores(document.getElementById('aula-sel').value);

  const statusEl = document.getElementById('chamada-status');
  if (statusEl) statusEl.textContent = 'Salvando...';

  // Presença antes do status: a troca de status é o que avisa as outras abas
  // abertas (Realtime), e elas releem essa presença nesse momento.
  let { error } = await salvarPresenca(turmaId, aluno.id, rep.aula, novaPresenca);
  if (!error && novoStatus !== anterior.status) {
    ({ error } = await atualizarStatusReposicao(repId, novoStatus));
    // A presença já foi gravada — tenta devolver o valor antigo para o banco
    // não ficar com o lançamento sem a reposição marcada como concluída.
    if (error) await gravarPresenca(turmaId, aluno.id, rep.aula, anterior.presenca);
  }

  if (error) {
    console.error('Erro ao salvar reposição:', error);
    state.PRESENCAS[key][aluno.id] = anterior.presenca;
    rep.status = anterior.status;
    if (statusEl) statusEl.textContent = '';
    renderChamada();
    // 42501 = bloqueado pelas permissões do banco (RLS) — o lançamento vai para
    // a turma original do aluno, que pode não ser de quem está fazendo a chamada.
    showToast(error.code === '42501'
      ? 'Sem permissão para lançar na turma original do aluno.'
      : 'Erro ao salvar a reposição. Tente novamente.', 'red');
    return;
  }

  if (statusEl) { statusEl.textContent = '✓ Salvo'; setTimeout(() => { statusEl.textContent = ''; }, 1500); }
  atualizarTelas({ chamada: false });
}
