import { state } from '../../state/store.js';
import { escapeHtml, showToast, fecharModal } from '../../shared/dom.js';
import { inserirAluno } from '../../../backend/api/alunosRepo.js';
import { registrarMovimentacao } from '../../../backend/api/historicoRepo.js';
import { renderTabelaAlunos } from './alunosTable.js';
import { renderDash } from '../dashboard/dashboardView.js';
import { renderRel, popularFiltros } from '../relatorios/relatoriosView.js';

// A biblioteca xlsx é carregada via <script> global no index.html (sem passo
// de build neste projeto) — mesma dependência já usada em exportExcel.js,
// aqui só pra LER a planilha em vez de gerar uma.
let linhasImportacao = [];

function normalizarTexto(s) {
  return (s || '').toString().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function acharTurmaPorNome(nomeTurma) {
  const alvo = normalizarTexto(nomeTurma);
  if (!alvo) return null;
  return state.TURMAS.find(t => normalizarTexto(t.turma) === alvo) || null;
}

function alunoJaExiste(nome, turmaId) {
  const alvo = normalizarTexto(nome);
  return state.ALUNOS.some(a => a.turma_id === turmaId && normalizarTexto(a.nome) === alvo);
}

export function importarPlanilhaSelecionada(e) {
  const file = e.target.files[0];
  e.target.value = ''; // permite selecionar o mesmo arquivo de novo depois, se precisar

  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const data = new Uint8Array(evt.target.result);
      const wb = XLSX.read(data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const linhas = XLSX.utils.sheet_to_json(ws, { defval: '' });
      processarLinhasPlanilha(linhas);
    } catch (err) {
      console.error('Erro ao ler planilha:', err);
      showToast('Não foi possível ler essa planilha. Verifique o arquivo.', 'red');
    }
  };
  reader.onerror = () => showToast('Erro ao abrir o arquivo.', 'red');
  reader.readAsArrayBuffer(file);
}

function processarLinhasPlanilha(linhasBrutas) {
  if (!linhasBrutas.length) { showToast('Planilha vazia.', 'red'); return; }

  const headers = Object.keys(linhasBrutas[0]);
  const nomeKey = headers.find(h => h.toLowerCase().includes('nome'));
  const turmaKey = headers.find(h => h.toLowerCase().includes('turma'));
  if (!nomeKey || !turmaKey) {
    showToast('A planilha precisa ter colunas com "Nome" e "Turma" no cabeçalho.', 'red');
    return;
  }

  linhasImportacao = linhasBrutas
    .map(l => ({ nome: String(l[nomeKey] || '').trim(), turmaTexto: String(l[turmaKey] || '').trim() }))
    .filter(l => l.nome)
    .map(l => {
      const turmaEncontrada = acharTurmaPorNome(l.turmaTexto);
      return { ...l, turmaId: turmaEncontrada ? String(turmaEncontrada.id) : '' };
    });

  if (!linhasImportacao.length) { showToast('Nenhum aluno encontrado na planilha.', 'red'); return; }

  renderModalImportacao();
  document.getElementById('modal-importar-planilha').classList.add('open');
}

function renderModalImportacao() {
  const semTurma = linhasImportacao.filter(l => !l.turmaId).length;
  const duplicados = linhasImportacao.filter(l => l.turmaId && alunoJaExiste(l.nome, parseInt(l.turmaId))).length;

  document.getElementById('imp-resumo').textContent =
    `${linhasImportacao.length} aluno(s) lidos da planilha` +
    (semTurma ? ` · ${semTurma} sem turma reconhecida (selecione manualmente)` : '') +
    (duplicados ? ` · ${duplicados} possivelmente já cadastrado(s)` : '');

  const inputStyle = 'width:100%;padding:6px 8px;border:1px solid var(--border-input);border-radius:6px;font-size:12px;background:var(--surface);color:var(--text);';

  document.getElementById('imp-tbody').innerHTML = linhasImportacao.map((l, i) => {
    const duplicado = l.turmaId && alunoJaExiste(l.nome, parseInt(l.turmaId));
    const statusHtml = !l.turmaId
      ? '<span class="badge badge-red">Sem turma</span>'
      : duplicado
        ? '<span class="badge badge-amber">Já existe</span>'
        : '<span class="badge badge-green">OK</span>';
    return `<tr>
      <td>${i + 1}</td>
      <td><input type="text" value="${escapeHtml(l.nome)}" oninput="atualizarLinhaImportacao(${i},'nome',this.value)" style="${inputStyle}"/></td>
      <td>
        <select onchange="atualizarLinhaImportacao(${i},'turmaId',this.value)" style="${inputStyle}">
          <option value="">— selecione —</option>
          ${state.TURMAS.map(t => `<option value="${t.id}" ${String(t.id) === l.turmaId ? 'selected' : ''}>${escapeHtml(t.turma)} — ${escapeHtml(t.curso)}</option>`).join('')}
        </select>
        ${!l.turmaId && l.turmaTexto ? `<div style="font-size:10px;color:var(--text-faded);margin-top:3px;">Na planilha: "${escapeHtml(l.turmaTexto)}"</div>` : ''}
      </td>
      <td>${statusHtml}</td>
    </tr>`;
  }).join('');
}

export function atualizarLinhaImportacao(i, campo, valor) {
  linhasImportacao[i][campo] = valor;
  renderModalImportacao();
}

export function cancelarImportacaoPlanilha() {
  linhasImportacao = [];
  fecharModal('modal-importar-planilha');
}

export async function confirmarImportacaoPlanilha() {
  const validas = linhasImportacao.filter(l => l.nome && l.turmaId);
  if (!validas.length) { showToast('Selecione a turma de ao menos um aluno.', 'red'); return; }

  const btn = document.getElementById('imp-btn-confirmar');
  btn.disabled = true;
  btn.textContent = 'Importando…';

  let sucesso = 0, erro = 0;
  for (const l of validas) {
    const { data, error } = await inserirAluno({ nome: l.nome, turma_id: parseInt(l.turmaId), ativo: true, experimental: false });
    if (error || !data) { erro++; console.error('Erro ao importar aluno', l.nome, error); continue; }
    await registrarMovimentacao(data.id, 'Aluno importado por planilha');
    state.ALUNOS.push(data);
    sucesso++;
  }

  btn.disabled = false;
  btn.textContent = 'Importar alunos';

  linhasImportacao = [];
  fecharModal('modal-importar-planilha');
  showToast(erro ? `${sucesso} aluno(s) importado(s), ${erro} com erro.` : `${sucesso} aluno(s) importado(s) com sucesso!`, erro ? 'red' : 'green');
  renderTabelaAlunos(); renderDash(); renderRel(); popularFiltros();
}
