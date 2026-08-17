import { state } from '../../state/store.js';
import { calcAluno, aulasDaTurma } from '../../../backend/domain/attendance.js';
import { statusInativo, freqBar, statusBadge, professorNome } from '../../../backend/domain/status.js';
import { escapeHtml, showToast } from '../../shared/dom.js';
import { salvarPresenca, removerPresenca } from '../../../backend/api/presencasRepo.js';
import { renderDash } from '../dashboard/dashboardView.js';
import { renderTabelaAlunos, atualizarTurmasAlunos } from '../alunos/alunosTable.js';

// =============================================
// FILTROS (selects simples + multi-select do relatório)
// =============================================
export function popularFiltros() {
  atualizarTurmasAlunos();
  const cursos = [...new Set(state.TURMAS.map(t => t.curso).filter(Boolean))].sort();
  const profs = [...new Set(state.TURMAS.map(t => professorNome(t)))].sort();

  const elCursoAlunos = document.getElementById('f-curso-alunos');
  if (elCursoAlunos) {
    elCursoAlunos.innerHTML = '<option value="">Todos</option>' + cursos.map(c => `<option>${escapeHtml(c)}</option>`).join('');
  }

  popularMultiPanel('curso-multi-panel', 'curso-multi-btn', 'curso-multi-label', cursos.map(c => ({ value: c, label: c })));
  popularMultiPanel('prof-multi-panel', 'prof-multi-btn', 'prof-multi-label', profs.map(p => ({ value: p, label: p })));
  popularMultiPanel('turma-rel-multi-panel', 'turma-rel-multi-btn', 'turma-rel-multi-label',
    state.TURMAS.map(t => ({ value: String(t.id), label: `${t.turma} (${t.curso || 'sem curso'})` }))
  );
}

function popularMultiPanel(panelId, btnId, labelId, options) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.innerHTML = options.map(o =>
    `<label class="multi-check"><input type="checkbox" value="${escapeHtml(o.value)}" onchange="onMultiCheck('${panelId}','${btnId}','${labelId}')">${escapeHtml(o.label)}</label>`
  ).join('');
}

export function getMultiSelecionados(panelId) {
  return [...document.querySelectorAll(`#${panelId} input:checked`)].map(i => i.value);
}

export function onMultiCheck(panelId, btnId, labelId) {
  const selecionados = getMultiSelecionados(panelId);
  const label = document.getElementById(labelId);
  const btn = document.getElementById(btnId);
  if (!label || !btn) return;
  if (selecionados.length === 0) {
    label.textContent = labelId.includes('turma') ? 'Todas' : 'Todos';
    btn.classList.remove('active');
  } else {
    const texts = [...document.querySelectorAll(`#${panelId} input:checked`)].map(i => i.closest('label')?.textContent?.trim() || i.value);
    label.textContent = texts.join(', ');
    btn.classList.add('active');
  }
  renderRel();
}

export function toggleMultiDropdown(e, panelId) {
  e.stopPropagation();
  document.querySelectorAll('.multi-select-panel.open').forEach(p => {
    if (p.id !== panelId) p.classList.remove('open');
  });
  document.getElementById(panelId)?.classList.toggle('open');
}

// =============================================
// RELATÓRIO
// =============================================
export function renderRel() {
  const fCursos = getMultiSelecionados('curso-multi-panel');
  const fProfs = getMultiSelecionados('prof-multi-panel');
  const fTipos = getMultiSelecionados('tipo-multi-panel');
  const fTurmasRel = getMultiSelecionados('turma-rel-multi-panel');
  const fStatus = getMultiSelecionados('status-multi-panel');
  let turmas = state.TURMAS;
  if (fCursos.length > 0) turmas = turmas.filter(t => fCursos.includes(t.curso));
  if (fProfs.length > 0) turmas = turmas.filter(t => fProfs.includes(professorNome(t)));
  if (fTurmasRel.length > 0) turmas = turmas.filter(t => fTurmasRel.includes(String(t.id)));

  let html = '';
  turmas.forEach(t => {
    let lista = state.ALUNOS.filter(a => a.turma_id === t.id).map(a => ({ ...a, ...calcAluno(a) }));
    if (fTipos.length > 0) {
      lista = lista.filter(a =>
        (fTipos.includes('alerta') && a.ativo && a.emAlerta) ||
        (fTipos.includes('irregular') && a.ativo && a.freq !== null && a.freq < 70)
      );
    }
    if (fStatus.length > 0) {
      lista = lista.filter(a => {
        const isRegular = a.ativo && !a.emAlerta && a.freq !== null && a.freq >= 70;
        const isAtencao = a.ativo && !a.emAlerta && a.freq !== null && a.freq < 70;
        const isAlerta = a.ativo && a.emAlerta;
        const isCancelado = !a.ativo && statusInativo(a.id) === 'cancelado';
        return (fStatus.includes('regular') && isRegular) ||
               (fStatus.includes('atencao') && isAtencao) ||
               (fStatus.includes('alerta-status') && isAlerta) ||
               (fStatus.includes('cancelado') && isCancelado);
      });
    }
    if (!lista.length) return;
    const ativos = lista.filter(a => a.ativo);
    const totalP = ativos.reduce((s, a) => s + a.p, 0), totalF = ativos.reduce((s, a) => s + a.f, 0);
    const fMedia = totalP + totalF > 0 ? Math.round((totalP / (totalP + totalF)) * 100) : null;
    const at = ativos.filter(a => a.emAlerta).length;
    html += `<div style="margin-bottom:1.5rem;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:.75rem;flex-wrap:wrap;">
        <div style="width:9px;height:9px;border-radius:50%;background:${t.cor || '#3b82f6'};flex-shrink:0;"></div>
        <span style="font-size:14px;font-weight:600;color:var(--text);">${escapeHtml(t.turma)}</span>
        <span style="font-size:12px;color:var(--text-3);">· ${escapeHtml(t.curso) || 'Sem curso'} · Prof. ${escapeHtml(professorNome(t))} · ${ativos.length} ativos · freq. média ${fMedia !== null ? fMedia + '%' : '—'}${at > 0 ? ` · <span style="color:var(--red);font-weight:600;">${at} alerta${at > 1 ? 's' : ''}</span>` : ''}</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th style="width:32%;">Aluno</th>
          <th style="width:11%;">Histórico</th>
          <th style="width:6%;text-align:center;">P</th>
          <th style="width:6%;text-align:center;">R</th>
          <th style="width:6%;text-align:center;">F</th>
          <th style="width:10%;text-align:center;">Consec.</th>
          <th style="width:12%;">Freq.</th>
          <th style="width:12%;">Status</th>
        </tr></thead>
        <tbody>${lista.map(a => `<tr class="clickable ${a.emAlerta && a.ativo ? 'row-alerta' : ''} ${!a.ativo ? 'row-inativo' : ''} ${a.experimental ? 'row-experimental' : ''}" onclick="abrirModalAluno(${a.id})">
          <td>${escapeHtml(a.nome)}${!a.ativo ? ' <span class="badge badge-gray" style="font-size:10px;">Inativo</span>' : ''}</td>
          <td><div class="dots" style="cursor:pointer;">${(() => { const _c = a.seq.map((v, i) => ({ v, i })).filter(x => x.v !== 'N').slice(-8); return _c.map(({ v, i }) => `<div class="dot ${v === 'P' ? 'dot-p' : v === 'R' ? 'dot-r' : v === 'F' ? 'dot-f' : 'dot-n'}" style="cursor:pointer;transition:transform .1s;" onmouseenter="this.style.transform='scale(1.3)'" onmouseleave="this.style.transform='scale(1)'" onclick="event.stopPropagation();abrirDotMenu(event,${a.id},${t.id},${i})" title="Aula ${i + 1}: ${v === 'P' ? 'Presente' : v === 'R' ? 'Gravação' : v === 'F' ? 'Falta' : 'Sem registro'}"></div>`).join(''); })()}</div></td>
          <td style="text-align:center;color:var(--green);font-weight:600;">${a.p - a.r}</td>
          <td style="text-align:center;color:var(--amber);font-weight:600;">${a.r > 0 ? a.r : '—'}</td>
          <td style="text-align:center;color:var(--red);font-weight:600;">${a.f}</td>
          <td style="text-align:center;">${a.maxConsec > 0 ? `<span class="badge ${a.emAlerta ? 'badge-red' : 'badge-gray'}">${a.maxConsec}</span>` : '—'}</td>
          <td>${freqBar(a.freq)}</td>
          <td>${statusBadge(a.freq, a.emAlerta, a.ativo)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  });
  document.getElementById('rel-area').innerHTML = html || '<div class="empty">Nenhuma turma encontrada com os filtros selecionados.</div>';
}

// =============================================
// DOT MENU — EDIÇÃO DE PRESENÇA NO RELATÓRIO
// =============================================
export function abrirDotMenu(e, alunoId, turmaId, aulaIdx) {
  e.stopPropagation();
  const existing = document.getElementById('dot-menu');
  if (existing) {
    existing.remove();
    if (state.dotMenuContext?.alunoId === alunoId && state.dotMenuContext?.aulaIdx === aulaIdx) {
      state.dotMenuContext = null; return;
    }
  }
  const key = `${turmaId}_${aulasDaTurma(state.TURMAS.find(x => x.id === turmaId))[aulaIdx]}`;
  const atual = (state.PRESENCAS[key] && state.PRESENCAS[key][alunoId]) || null;
  state.dotMenuContext = { alunoId, turmaId, aulaIdx };
  const opcoes = [
    { val: 'P', label: '✓ Presente', cls: 'dot-menu-p' },
    { val: 'R', label: '↺ Gravação', cls: 'dot-menu-r' },
    { val: 'F', label: '✗ Falta', cls: 'dot-menu-f' },
    { val: null, label: '— Limpar', cls: 'dot-menu-n' },
  ];
  const menu = document.createElement('div');
  menu.id = 'dot-menu';
  menu.className = 'dot-menu';
  menu.innerHTML = opcoes.map(o =>
    `<div class="dot-menu-item ${o.cls} ${atual === o.val ? 'dot-menu-active' : ''}" onclick="event.stopPropagation();selecionarStatusDot(${o.val === null ? 'null' : "'" + o.val + "'"})">${o.label}${atual === o.val ? ' ✔' : ''}</div>`
  ).join('');
  document.body.appendChild(menu);
  const rect = e.target.getBoundingClientRect();
  let left = rect.left, top = rect.bottom + 4;
  if (left + 140 > window.innerWidth) left = window.innerWidth - 148;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

export async function selecionarStatusDot(novoVal) {
  const { alunoId, turmaId, aulaIdx } = state.dotMenuContext;
  const aula = aulasDaTurma(state.TURMAS.find(x => x.id === turmaId))[aulaIdx];
  const key = `${turmaId}_${aula}`;
  if (!state.PRESENCAS[key]) state.PRESENCAS[key] = {};
  const atual = state.PRESENCAS[key][alunoId] || null;

  const menu = document.getElementById('dot-menu');
  if (menu) menu.remove();
  state.dotMenuContext = null;

  if (novoVal === atual) return; // nada mudou

  state.PRESENCAS[key][alunoId] = novoVal;

  try {
    let saveError = null;
    if (novoVal) {
      const { error } = await salvarPresenca(turmaId, alunoId, aula, novoVal);
      saveError = error;
    } else {
      const { error } = await removerPresenca(turmaId, alunoId, aula);
      saveError = error;
    }
    if (saveError) throw saveError;
    showToast('Presença atualizada!', 'green');
    renderRel(); renderDash(); renderTabelaAlunos();
  } catch (err) {
    console.error('Erro ao salvar dot:', err);
    state.PRESENCAS[key][alunoId] = atual; // reverte
    renderRel();
    showToast('Erro ao salvar. Tente novamente.', 'red');
  }
}
