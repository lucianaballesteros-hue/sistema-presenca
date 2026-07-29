import { state } from '../../state/store.js';
import { atualizarTurma, inserirTurma } from '../../api/turmasRepo.js';
import { atualizarAlunosEmLote } from '../../api/alunosRepo.js';
import { registrarMovimentacoesEmLote, carregarHistorico } from '../../api/historicoRepo.js';
import { showToast, fecharModal, escapeHtml } from '../../shared/dom.js';
import { confirmar } from '../../shared/confirm.js';
import { renderDash } from './dashboardView.js';
import { renderRel, popularFiltros } from '../relatorios/relatoriosView.js';
import { renderTabelaAlunos } from '../alunos/alunosTable.js';
import { AULAS } from '../../domain/attendance.js';

export const TURMA_CORES = ['#3b82f6', '#059669', '#7c3aed', '#db2777', '#d97706', '#0891b2', '#dc2626', '#65a30d'];

const MARCA_INATIVACAO_AUTO = 'Aluno inativado automaticamente (turma inativada)';
const MARCA_REATIVACAO_AUTO = 'Aluno reativado automaticamente (turma reativada)';

export async function toggleTurmaAtiva(e, tId) {
  const t = state.TURMAS.find(x => x.id === tId);
  if (!t) return;
  const estaAtiva = t.ativa !== false;
  if (estaAtiva) {
    const ok = await confirmar({
      titulo: `Inativar a turma "${t.turma}"?`,
      mensagem: 'Todos os alunos ativos dessa turma serão inativados automaticamente. Ao reativar a turma, esses mesmos alunos voltam a ficar ativos. Alunos já cancelados/inativados manualmente não são afetados. Dados de alunos e presença são mantidos.',
      textoConfirmar: 'Inativar',
    });
    if (!ok) return;
  }
  const novoStatus = !estaAtiva;
  const btn = e.currentTarget;
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = novoStatus ? 'Reativando…' : 'Inativando…';

  const { error } = await atualizarTurma(tId, { ativa: novoStatus });
  if (error) {
    showToast('Erro ao atualizar turma.', 'red'); console.error(error);
    btn.disabled = false; btn.textContent = textoOriginal;
    return;
  }
  t.ativa = novoStatus;

  if (!novoStatus) {
    // Inativando turma: inativa somente os alunos que estão ativos agora
    const afetados = state.ALUNOS.filter(a => a.turma_id === tId && a.ativo);
    if (afetados.length) {
      const ids = afetados.map(a => a.id);
      const { error: errAl } = await atualizarAlunosEmLote(ids, { ativo: false });
      if (errAl) {
        console.error(errAl);
        showToast('Turma inativada, mas houve erro ao inativar os alunos.', 'red');
      } else {
        await registrarMovimentacoesEmLote(ids.map(id => ({ aluno_id: id, descricao: MARCA_INATIVACAO_AUTO })));
        afetados.forEach(a => a.ativo = false);
      }
    }
  } else {
    // Reativando turma: reativa somente os alunos cuja última movimentação foi a inativação automática desta turma
    // (alunos cancelados/inativados manualmente antes disso permanecem inativos)
    const candidatos = state.ALUNOS.filter(a => a.turma_id === tId && !a.ativo).filter(a => {
      const ultimo = state.HISTORICO.find(h => h.aluno_id === a.id);
      return ultimo?.descricao === MARCA_INATIVACAO_AUTO;
    });
    if (candidatos.length) {
      const ids = candidatos.map(a => a.id);
      const { error: errAl } = await atualizarAlunosEmLote(ids, { ativo: true });
      if (errAl) {
        console.error(errAl);
        showToast('Turma reativada, mas houve erro ao reativar os alunos.', 'red');
      } else {
        await registrarMovimentacoesEmLote(ids.map(id => ({ aluno_id: id, descricao: MARCA_REATIVACAO_AUTO })));
        candidatos.forEach(a => a.ativo = true);
      }
    }
  }

  await carregarHistorico();
  showToast(novoStatus ? 'Turma reativada!' : 'Turma inativada.');
  renderDash(); renderRel();
}

// =============================================
// HELPERS DE HORÁRIO DE TURMA (usados na criação e edição)
// =============================================
function preencherSelectsHorario(prefix, horarioInicio) {
  const selHora = document.getElementById(prefix + '-hora');
  const selMin = document.getElementById(prefix + '-minuto');
  selHora.innerHTML = Array.from({ length: 24 }, (_, h) =>
    `<option value="${String(h).padStart(2, '0')}">${String(h).padStart(2, '0')}</option>`).join('');
  selMin.innerHTML = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55']
    .map(m => `<option value="${m}">${m}</option>`).join('');
  const [h, m] = (horarioInicio ? horarioInicio.slice(0, 5) : '19:00').split(':');
  selHora.value = h;
  selMin.value = m;
}

function preencherDiasGrid(prefix, diasSalvos) {
  document.querySelectorAll('#' + prefix + '-dias-grid .dia-check').forEach(label => {
    const val = label.dataset.dia;
    const check = label.querySelector('input');
    const selecionado = (diasSalvos || []).includes(val);
    check.checked = selecionado;
    label.classList.toggle('selecionado', selecionado);
    label.onclick = function () {
      const c = this.querySelector('input');
      c.checked = !c.checked;
      this.classList.toggle('selecionado', c.checked);
    };
  });
}

function lerDiasSelecionados(prefix) {
  return [...document.querySelectorAll('#' + prefix + '-dias-grid .dia-check input:checked')].map(i => i.value);
}

function preencherSelectTotalAulas(prefix, valorAtual) {
  const sel = document.getElementById(prefix + '-total-aulas');
  sel.innerHTML = AULAS.map((_, i) => i + 1).map(n => `<option value="${n}">${n} aula${n > 1 ? 's' : ''}</option>`).join('');
  sel.value = valorAtual || AULAS.length;
}

function lerTotalAulas(prefix) {
  return parseInt(document.getElementById(prefix + '-total-aulas').value) || AULAS.length;
}

function lerHorarioSelecionado(prefix) {
  return document.getElementById(prefix + '-hora').value + ':' + document.getElementById(prefix + '-minuto').value;
}

export function aplicarPreset(prefix, horario) {
  const [h, m] = horario.split(':');
  document.getElementById(prefix + '-hora').value = h;
  document.getElementById(prefix + '-minuto').value = m;
  marcarPresetAtivo(prefix);
}

export function marcarPresetAtivo(prefix) {
  const atual = lerHorarioSelecionado(prefix);
  document.querySelectorAll('#' + prefix + '-presets .preset-btn').forEach(b => {
    b.classList.toggle('ativo', b.textContent === atual);
  });
}

export function limparHorario(prefix) {
  document.querySelectorAll('#' + prefix + '-dias-grid .dia-check').forEach(label => {
    label.querySelector('input').checked = false;
    label.classList.remove('selecionado');
  });
  document.getElementById(prefix + '-hora').value = '19';
  document.getElementById(prefix + '-minuto').value = '00';
  marcarPresetAtivo(prefix);
}

// =============================================
// NOVA TURMA
// =============================================
export function abrirModalNovaTurma() {
  document.getElementById('nt-nome').value = '';
  document.getElementById('nt-curso').value = '';
  document.getElementById('nt-erro').style.display = 'none';
  const btnSalvar = document.getElementById('nt-btn-salvar');
  btnSalvar.disabled = false;
  btnSalvar.textContent = 'Criar turma';
  document.getElementById('nt-cor').value = TURMA_CORES[0];
  document.getElementById('nt-cor-picker').innerHTML = TURMA_CORES.map((cor, i) =>
    `<button type="button" class="cor-swatch ${i === 0 ? 'selected' : ''}" style="background:${cor};" title="${cor}" aria-label="Cor ${cor}" onclick="selecionarCorNovaTurma('${cor}', this)"></button>`
  ).join('');
  const cursos = [...new Set(state.TURMAS.map(t => t.curso))].sort();
  document.getElementById('nt-curso-list').innerHTML = cursos.map(c => `<option value="${escapeHtml(c)}">`).join('');
  document.getElementById('nt-professor').innerHTML = state.PROFESSORES.map(p => `<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('');
  preencherSelectTotalAulas('nt', 20);
  preencherSelectsHorario('nt', null);
  preencherDiasGrid('nt', []);
  marcarPresetAtivo('nt');
  document.getElementById('modal-nova-turma').classList.add('open');
}

export function selecionarCorNovaTurma(cor, btn) {
  document.getElementById('nt-cor').value = cor;
  btn.parentElement.querySelectorAll('.cor-swatch').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

export async function salvarNovaTurma() {
  const nome = document.getElementById('nt-nome').value.trim();
  const curso = document.getElementById('nt-curso').value.trim();
  const profId = parseInt(document.getElementById('nt-professor').value);
  const cor = document.getElementById('nt-cor').value || TURMA_CORES[0];
  const erroEl = document.getElementById('nt-erro');
  erroEl.style.display = 'none';

  if (!nome) { erroEl.textContent = 'Digite o nome da turma.'; erroEl.style.display = 'block'; return; }
  if (!curso) { erroEl.textContent = 'Digite o curso.'; erroEl.style.display = 'block'; return; }
  const prof = state.PROFESSORES.find(p => p.id === profId);
  if (!prof) { erroEl.textContent = 'Selecione um professor.'; erroEl.style.display = 'block'; return; }

  const diasSelecionados = lerDiasSelecionados('nt');
  const horario = lerHorarioSelecionado('nt');
  const totalAulas = lerTotalAulas('nt');

  const btnSalvar = document.getElementById('nt-btn-salvar');
  btnSalvar.disabled = true;
  btnSalvar.textContent = 'Criando…';

  const { data, error } = await inserirTurma({
    turma: nome, curso, professor: prof.nome, professor_id: prof.id, ativa: true, cor,
    total_aulas: totalAulas,
    horario_inicio: diasSelecionados.length ? horario + ':00' : null,
    dias_semana: diasSelecionados.length ? diasSelecionados : null,
  });
  if (error) {
    erroEl.textContent = 'Erro ao criar turma: ' + error.message; erroEl.style.display = 'block';
    btnSalvar.disabled = false; btnSalvar.textContent = 'Criar turma';
    return;
  }

  state.TURMAS.push(data);
  fecharModal('modal-nova-turma');
  showToast(`Turma "${nome}" criada com sucesso!`);
  popularFiltros();
  renderDash();
}

// =============================================
// EDITAR TURMA (nome, curso, professor, cor, horário)
// =============================================
export function abrirModalEditarTurma(tId) {
  const t = state.TURMAS.find(x => x.id === tId);
  if (!t) return;
  state.turmaEmEdicaoId = tId;

  document.getElementById('et-nome').value = t.turma;
  document.getElementById('et-curso').value = t.curso;
  document.getElementById('et-professor').value = t.professor;
  document.getElementById('et-erro').style.display = 'none';
  const btnSalvarEt = document.getElementById('et-btn-salvar');
  btnSalvarEt.disabled = false;
  btnSalvarEt.textContent = 'Salvar';

  const cursos = [...new Set(state.TURMAS.map(x => x.curso))].sort();
  document.getElementById('et-curso-list').innerHTML = cursos.map(c => `<option value="${escapeHtml(c)}">`).join('');

  const corAtual = t.cor || TURMA_CORES[0];
  document.getElementById('et-cor').value = corAtual;
  document.getElementById('et-cor-picker').innerHTML = TURMA_CORES.map(cor =>
    `<button type="button" class="cor-swatch ${cor === corAtual ? 'selected' : ''}" style="background:${cor};" title="${cor}" aria-label="Cor ${cor}" onclick="selecionarCorEditarTurma('${cor}', this)"></button>`
  ).join('');

  preencherSelectTotalAulas('et', t.total_aulas);
  preencherSelectsHorario('et', t.horario_inicio);
  preencherDiasGrid('et', t.dias_semana);
  marcarPresetAtivo('et');
  document.getElementById('modal-editar-turma').classList.add('open');
}

export function selecionarCorEditarTurma(cor, btn) {
  document.getElementById('et-cor').value = cor;
  btn.parentElement.querySelectorAll('.cor-swatch').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

export async function salvarEditarTurma() {
  const t = state.TURMAS.find(x => x.id === state.turmaEmEdicaoId);
  if (!t) return;

  const nome = document.getElementById('et-nome').value.trim();
  const curso = document.getElementById('et-curso').value.trim();
  const professor = document.getElementById('et-professor').value.trim();
  const cor = document.getElementById('et-cor').value || TURMA_CORES[0];
  const erroEl = document.getElementById('et-erro');
  erroEl.style.display = 'none';

  if (!nome) { erroEl.textContent = 'Digite o nome da turma.'; erroEl.style.display = 'block'; return; }
  if (!curso) { erroEl.textContent = 'Digite o curso.'; erroEl.style.display = 'block'; return; }
  if (!professor) { erroEl.textContent = 'Digite o professor.'; erroEl.style.display = 'block'; return; }

  const diasSelecionados = lerDiasSelecionados('et');
  const horario = lerHorarioSelecionado('et');
  const totalAulas = lerTotalAulas('et');
  const updates = {
    turma: nome,
    curso,
    professor,
    cor,
    total_aulas: totalAulas,
    horario_inicio: diasSelecionados.length ? horario + ':00' : null,
    dias_semana: diasSelecionados.length ? diasSelecionados : null,
  };

  const btnSalvar = document.getElementById('et-btn-salvar');
  btnSalvar.disabled = true;
  btnSalvar.textContent = 'Salvando…';

  const { error } = await atualizarTurma(t.id, updates);
  if (error) {
    erroEl.textContent = 'Erro ao salvar: ' + error.message; erroEl.style.display = 'block';
    btnSalvar.disabled = false; btnSalvar.textContent = 'Salvar';
    return;
  }

  Object.assign(t, updates);

  fecharModal('modal-editar-turma');
  showToast('Turma atualizada!');
  popularFiltros();
  renderDash(); renderTabelaAlunos(); renderRel();
}
