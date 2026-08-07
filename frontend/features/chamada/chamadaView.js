import { state } from '../../state/store.js';
import { aulasDaTurma, registroPorAulaDaTurma } from '../../../backend/domain/attendance.js';
import { escapeHtml, showToast } from '../../shared/dom.js';
import { salvarPresenca, removerPresenca } from '../../../backend/api/presencasRepo.js';
import { renderDash } from '../dashboard/dashboardView.js';
import { renderTabelaAlunos } from '../alunos/alunosTable.js';

export function abrirChamada(tId) {
  state.turmaAtual = state.TURMAS.find(t => t.id === tId);
  state.chamadaAlterada = {};
  document.getElementById('dash-view').style.display = 'none';
  document.getElementById('chamada-view').style.display = 'block';
  document.getElementById('ch-titulo').textContent = state.turmaAtual.turma + ' — ' + state.turmaAtual.curso;
  document.getElementById('ch-sub').textContent = 'Prof. ' + state.turmaAtual.professor;
  const sel = document.getElementById('aula-sel');
  sel.innerHTML = aulasDaTurma(state.turmaAtual).map(a => `<option>${a}</option>`).join('');
  renderChamada();
}

export function voltarDash() {
  document.getElementById('chamada-view').style.display = 'none';
  document.getElementById('dash-view').style.display = 'block';
}

export function renderChamada() {
  const aula = document.getElementById('aula-sel').value;
  const key = `${state.turmaAtual.id}_${aula}`;
  if (!state.PRESENCAS[key]) state.PRESENCAS[key] = {};

  const registroAulas = registroPorAulaDaTurma(state.turmaAtual);
  document.getElementById('ch-aulas-grid').innerHTML = aulasDaTurma(state.turmaAtual).map((au, i) => {
    const tem = registroAulas[i];
    const bg = tem ? 'var(--green-soft)' : 'var(--gray-soft)';
    const tc = tem ? 'var(--green-soft-text)' : 'var(--gray-soft-text)';
    return `<div class="aula-chip" style="background:${bg};color:${tc};" title="${au}${tem ? ': já tem registro' : ': sem registro'}">${i + 1}</div>`;
  }).join('');

  // Turma inativa: mostra todos os alunos dela (inclusive os inativados junto
  // com ela) para ainda dar pra ver/corrigir a presença. Turma ativa continua
  // só com alunos ativos, como antes.
  const turmaInativa = state.turmaAtual.ativa === false;
  const alunos = state.ALUNOS.filter(a => a.turma_id === state.turmaAtual.id && (turmaInativa || a.ativo));
  let p = 0, r = 0, f = 0, s = 0;
  alunos.forEach(a => {
    const v = state.PRESENCAS[key][a.id];
    if (v === 'P') p++; else if (v === 'R') r++; else if (v === 'F') f++; else s++;
  });
  document.getElementById('ch-counters').innerHTML =
    `<span style="color:var(--green);">✓ ${p} presentes</span><span style="color:var(--red);">✗ ${f} faltas</span><span style="color:var(--amber);">↺ ${r} gravações</span><span>○ ${s} sem registro</span>`;
  document.getElementById('alunos-list').innerHTML = alunos.map((a, i) => {
    const v = state.PRESENCAS[key][a.id] || '';
    return `<div class="aluno-row ${a.experimental ? 'experimental' : ''}">
      <div class="aluno-num">${i + 1}</div>
      <div class="aluno-nome">${escapeHtml(a.nome)}</div>
      <div class="pbtns">
        <button class="pbtn pbtn-p ${v === 'P' ? 'on' : ''}" onclick="marcar(${a.id},'P')">✓ Presente</button>
        <button class="pbtn pbtn-f ${v === 'F' ? 'on' : ''}" onclick="marcar(${a.id},'F')">✗ Falta</button>
        <button class="pbtn pbtn-r ${v === 'R' ? 'on' : ''}" onclick="marcar(${a.id},'R')">↺ Gravação</button>
      </div>
    </div>`;
  }).join('') || '<div class="empty">Nenhum aluno nesta turma.</div>';
}

export async function marcar(alunoId, val) {
  const aula = document.getElementById('aula-sel').value;
  const key = `${state.turmaAtual.id}_${aula}`;
  if (!state.PRESENCAS[key]) state.PRESENCAS[key] = {};
  const atual = state.PRESENCAS[key][alunoId];
  const novoVal = atual === val ? null : val;
  state.PRESENCAS[key][alunoId] = novoVal;
  renderChamada();

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
