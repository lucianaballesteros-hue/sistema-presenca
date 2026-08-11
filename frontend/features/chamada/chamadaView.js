import { state } from '../../state/store.js';
import { aulasDaTurma, registroPorAulaDaTurma } from '../../../backend/domain/attendance.js';
import { professorNome } from '../../../backend/domain/status.js';
import { escapeHtml, escapeAttr, showToast } from '../../shared/dom.js';
import { salvarPresenca, removerPresenca } from '../../../backend/api/presencasRepo.js';
import { renderDash } from '../dashboard/dashboardView.js';
import { renderTabelaAlunos } from '../alunos/alunosTable.js';

export function abrirChamada(tId) {
  state.turmaAtual = state.TURMAS.find(t => t.id === tId);
  state.chamadaAlterada = {};
  document.getElementById('dash-view').style.display = 'none';
  document.getElementById('chamada-view').style.display = 'block';
  document.getElementById('ch-titulo').textContent = state.turmaAtual.turma + ' — ' + state.turmaAtual.curso;
  document.getElementById('ch-sub').textContent = 'Prof. ' + professorNome(state.turmaAtual);
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

function alunosDaChamada() {
  const turmaInativa = state.turmaAtual.ativa === false;
  return state.ALUNOS.filter(a => a.turma_id === state.turmaAtual.id && (turmaInativa || a.ativo));
}

function atualizarContadores(key) {
  const alunos = alunosDaChamada();
  let p = 0, r = 0, f = 0, s = 0;
  alunos.forEach(a => {
    const v = state.PRESENCAS[key][a.id];
    if (v === 'P') p++; else if (v === 'R') r++; else if (v === 'F') f++; else s++;
  });
  document.getElementById('ch-counters').innerHTML =
    `<span style="color:var(--green);">✓ ${p} presentes</span><span style="color:var(--red);">✗ ${f} faltas</span><span style="color:var(--amber);">↺ ${r} gravações</span><span>○ ${s} sem registro</span>`;
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

  atualizarContadores(key);

  const alunos = alunosDaChamada();
  document.getElementById('alunos-list').innerHTML = alunos.map((a, i) => {
    return `<div class="aluno-row ${a.experimental ? 'experimental' : ''}" data-aluno-id="${a.id}">
      <div class="aluno-num">${i + 1}</div>
      <div class="aluno-nome">${escapeHtml(a.nome)}</div>
      <div class="pbtns">
        <div class="pbtn-indicator"></div>
        <button class="pbtn pbtn-p" data-val="P" onclick="marcar(${a.id},'P')">✓ Presente</button>
        <button class="pbtn pbtn-f" data-val="F" onclick="marcar(${a.id},'F')">✗ Falta</button>
        <button class="pbtn pbtn-r" data-val="R" onclick="marcar(${a.id},'R')">↺ Gravação</button>
      </div>
    </div>`;
  }).join('') || '<div class="empty">Nenhum aluno nesta turma.</div>';

  alunos.forEach(a => {
    const row = document.querySelector(`#alunos-list .aluno-row[data-aluno-id="${a.id}"]`);
    moverIndicadorPbtn(row?.querySelector('.pbtns'), state.PRESENCAS[key][a.id] || '');
  });
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

  const row = document.querySelector(`#alunos-list .aluno-row[data-aluno-id="${alunoId}"]`);
  row?.querySelectorAll('.pbtn').forEach(btn => btn.classList.toggle('on', btn.dataset.val === novoVal));
  moverIndicadorPbtn(row?.querySelector('.pbtns'), novoVal);
  atualizarContadores(key);

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
    renderDash();
    renderTabelaAlunos();
  } catch (err) {
    console.error('Erro ao salvar presença:', err);
    if (statusEl) statusEl.textContent = '';
    showToast('Erro ao salvar. Tente novamente.', 'red');
  }
}
