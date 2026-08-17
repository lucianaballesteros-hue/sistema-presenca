import { state } from '../../state/store.js';
import { escapeHtml, showToast, fecharModal } from '../../shared/dom.js';
import { confirmar } from '../../shared/confirm.js';
import { alunoJaExiste, normalizarNome as normalizarTexto } from '../../shared/duplicados.js';
import { inserirAluno } from '../../../backend/api/alunosRepo.js';
import { registrarMovimentacao } from '../../../backend/api/historicoRepo.js';
import { renderTabelaAlunos } from './alunosTable.js';
import { renderDash } from '../dashboard/dashboardView.js';
import { renderRel, popularFiltros } from '../relatorios/relatoriosView.js';

// A biblioteca xlsx é carregada via <script> global no index.html (sem passo
// de build neste projeto) — mesma dependência já usada em exportExcel.js,
// aqui só pra LER a planilha em vez de gerar uma.
let linhasImportacao = [];

// Palavras que aparecem no nome da aba/curso mas não ajudam a identificar
// qual curso é (ex: aba "Alunos Master" — "alunos" não diz nada).
const PALAVRAS_GENERICAS = ['alunos', 'aluno', 'turma', 'turmas', 'planilha', 'lista', 'curso', 'pagina'];

function turmasAtivas() {
  return state.TURMAS.filter(t => t.ativa !== false);
}

// Cursos disponíveis pro filtro — só os que têm ao menos uma turma ativa.
function cursosDisponiveis() {
  return [...new Set(turmasAtivas().map(t => t.curso).filter(Boolean))].sort();
}

// O curso pode vir de duas formas na planilha: uma coluna com "curso" no
// cabeçalho (valor por linha, mais preciso) ou o nome da aba (ex: "Alunos
// Master"). Aqui tenta achar, entre as turmas ativas, um curso que bata com
// esse texto — exato primeiro, senão por palavra-chave em comum.
function resolverCursoUnico(cursoTexto) {
  const alvo = normalizarTexto(cursoTexto);
  if (!alvo) return '';
  const cursos = cursosDisponiveis();

  const exato = cursos.find(c => normalizarTexto(c) === alvo);
  if (exato) return exato;

  const palavras = alvo.split(' ').filter(p => p.length > 2 && !PALAVRAS_GENERICAS.includes(p));
  if (!palavras.length) return '';
  const candidatos = cursos.filter(c => palavras.some(p => normalizarTexto(c).includes(p)));
  // Só assume automaticamente quando não há ambiguidade (ex: "Master" batendo
  // em "Master 1/2026" E "Master 2/2026" ao mesmo tempo fica em aberto pro
  // usuário escolher no filtro).
  return candidatos.length === 1 ? candidatos[0] : '';
}

// Turmas ativas candidatas pra um texto de curso — mais permissivo que
// resolverCursoUnico: usa TODOS os cursos que batem por palavra-chave (não
// só quando é único), pra não perder opções na hora de achar o horário.
function turmasCandidatas(cursoTexto) {
  const ativas = turmasAtivas();
  const alvo = normalizarTexto(cursoTexto);
  if (!alvo) return ativas;

  const exatas = ativas.filter(t => normalizarTexto(t.curso) === alvo);
  if (exatas.length) return exatas;

  const palavras = alvo.split(' ').filter(p => p.length > 2 && !PALAVRAS_GENERICAS.includes(p));
  if (!palavras.length) return ativas;
  const candidatas = ativas.filter(t => palavras.some(p => normalizarTexto(t.curso).includes(p)));
  return candidatas.length ? candidatas : ativas;
}

// A coluna "Turma" na planilha traz só o horário (ex: "Segunda 14:00"), e o
// nome completo da turma no sistema pode ter texto no meio (ex: "Segunda Sta
// Dorotéia 14:00") — por isso não basta um substring contíguo: cada palavra
// do horário (dia, hora) precisa aparecer em algum lugar do nome da turma.
function turmaContemHorario(nomeTurma, horarioTexto) {
  const turmaNorm = normalizarTexto(nomeTurma);
  const tokens = normalizarTexto(horarioTexto).split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every(tok => turmaNorm.includes(tok));
}

function acharTurma(candidatas, horarioTexto) {
  const alvo = normalizarTexto(horarioTexto);
  if (!alvo) return null;
  return candidatas.find(t => normalizarTexto(t.turma) === alvo)
    || candidatas.find(t => turmaContemHorario(t.turma, horarioTexto))
    || null;
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
      processarPastaDeTrabalho(wb);
    } catch (err) {
      console.error('Erro ao ler planilha:', err);
      showToast('Não foi possível ler essa planilha. Verifique o arquivo.', 'red');
    }
  };
  reader.onerror = () => showToast('Erro ao abrir o arquivo.', 'red');
  reader.readAsArrayBuffer(file);
}

// Percorre TODAS as abas da planilha (cada uma pode representar um curso
// diferente, ex: "Alunos Master", "Alunos Evolution"). Abas sem colunas de
// Nome/Turma são ignoradas silenciosamente (ex: uma aba de resumo/instruções).
function processarPastaDeTrabalho(wb) {
  linhasImportacao = [];
  let abasComDados = 0;

  wb.SheetNames.forEach(nomeAba => {
    const ws = wb.Sheets[nomeAba];
    const linhasBrutas = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!linhasBrutas.length) return;

    const headers = Object.keys(linhasBrutas[0]);
    const nomeKey = headers.find(h => h.toLowerCase().includes('nome'));
    const turmaKey = headers.find(h => h.toLowerCase().includes('turma'));
    const cursoKey = headers.find(h => h.toLowerCase().includes('curso'));
    if (!nomeKey || !turmaKey) return;

    abasComDados++;
    linhasBrutas.forEach(l => {
      const nome = String(l[nomeKey] || '').trim();
      const horarioTexto = String(l[turmaKey] || '').trim();
      if (!nome) return;

      // Coluna "Curso" no cabeçalho tem prioridade (é por linha, mais
      // preciso); sem ela, usa o nome da aba como pista do curso.
      const cursoTexto = (cursoKey && String(l[cursoKey] || '').trim()) || nomeAba;
      const cursoFiltro = resolverCursoUnico(cursoTexto);
      const candidatas = turmasCandidatas(cursoFiltro || cursoTexto);
      const turmaEncontrada = acharTurma(candidatas, horarioTexto);

      linhasImportacao.push({
        nome,
        horarioTexto,
        cursoTexto,
        cursoFiltro,
        turmaId: turmaEncontrada ? String(turmaEncontrada.id) : '',
      });
    });
  });

  if (!abasComDados) {
    showToast('Nenhuma aba com colunas "Nome" e "Turma" foi encontrada na planilha.', 'red');
    return;
  }
  if (!linhasImportacao.length) { showToast('Nenhum aluno encontrado na planilha.', 'red'); return; }

  renderModalImportacao();
  document.getElementById('modal-importar-planilha').classList.add('open');
}

function renderModalImportacao() {
  const semTurma = linhasImportacao.filter(l => !l.turmaId).length;
  const duplicados = linhasImportacao.filter(l => alunoJaExiste(l.nome)).length;

  document.getElementById('imp-resumo').textContent =
    `${linhasImportacao.length} aluno(s) lidos da planilha` +
    (semTurma ? ` · ${semTurma} sem turma reconhecida (selecione manualmente)` : '') +
    (duplicados ? ` · ${duplicados} possivelmente já cadastrado(s)` : '');

  const selectStyle = 'width:100%;padding:6px 8px;border:1px solid var(--border-input);border-radius:6px;font-size:12px;background:var(--surface);color:var(--text);';
  const cursos = cursosDisponiveis();

  document.getElementById('imp-tbody').innerHTML = linhasImportacao.map((l, i) => {
    const duplicado = l.turmaId && alunoJaExiste(l.nome);
    const statusHtml = !l.turmaId
      ? '<span class="badge badge-red">Sem turma</span>'
      : duplicado
        ? '<span class="badge badge-amber">Já existe</span>'
        : '<span class="badge badge-green">OK</span>';

    const turmasDaLinha = turmasAtivas().filter(t => !l.cursoFiltro || t.curso === l.cursoFiltro);

    return `<tr>
      <td>${i + 1}</td>
      <td><input type="text" value="${escapeHtml(l.nome)}" oninput="atualizarLinhaImportacao(${i},'nome',this.value)" style="${selectStyle}"/></td>
      <td>
        <select onchange="atualizarFiltroCursoImportacao(${i},this.value)" style="${selectStyle}margin-bottom:5px;">
          <option value="">Todos os cursos</option>
          ${cursos.map(c => `<option value="${escapeHtml(c)}" ${c === l.cursoFiltro ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
        </select>
        <select onchange="atualizarLinhaImportacao(${i},'turmaId',this.value)" style="${selectStyle}">
          <option value="">— selecione a turma —</option>
          ${turmasDaLinha.map(t => `<option value="${t.id}" ${String(t.id) === l.turmaId ? 'selected' : ''}>${escapeHtml(t.turma)} — ${escapeHtml(t.curso) || 'sem curso'}</option>`).join('')}
        </select>
        <div style="font-size:10px;color:var(--text-faded);margin-top:3px;">Na planilha: ${escapeHtml(l.cursoTexto)}${l.horarioTexto ? ` · "${escapeHtml(l.horarioTexto)}"` : ''}</div>
      </td>
      <td>${statusHtml}</td>
    </tr>`;
  }).join('');
}

export function atualizarLinhaImportacao(i, campo, valor) {
  linhasImportacao[i][campo] = valor;
  renderModalImportacao();
}

// Ao trocar o filtro de curso de uma linha, se a turma já selecionada não
// pertencer mais ao curso escolhido, limpa a seleção pra evitar ficar com
// aluno-turma-curso incoerentes.
export function atualizarFiltroCursoImportacao(i, cursoFiltro) {
  const l = linhasImportacao[i];
  l.cursoFiltro = cursoFiltro;
  if (l.turmaId) {
    const turmaAtual = state.TURMAS.find(t => String(t.id) === l.turmaId);
    if (!turmaAtual || (cursoFiltro && turmaAtual.curso !== cursoFiltro)) l.turmaId = '';
  }
  renderModalImportacao();
}

export function cancelarImportacaoPlanilha() {
  linhasImportacao = [];
  fecharModal('modal-importar-planilha');
}

export async function confirmarImportacaoPlanilha() {
  const validas = linhasImportacao.filter(l => l.nome && l.turmaId);
  if (!validas.length) { showToast('Selecione a turma de ao menos um aluno.', 'red'); return; }

  const duplicadas = validas.filter(l => alunoJaExiste(l.nome));
  if (duplicadas.length) {
    const nomes = duplicadas.map(l => l.nome);
    const lista = nomes.length <= 5 ? nomes.join(', ') : `${nomes.slice(0, 5).join(', ')} e mais ${nomes.length - 5}`;
    const ok = await confirmar({
      titulo: duplicadas.length === 1 ? 'Aluno(a) já cadastrado(a)' : `${duplicadas.length} alunos já cadastrados`,
      mensagem: `${lista} já ${duplicadas.length === 1 ? 'está cadastrado(a)' : 'estão cadastrados(as)'} no sistema. Deseja importar mesmo assim?`,
      textoConfirmar: 'Importar mesmo assim',
      perigo: true,
    });
    if (!ok) return;
  }

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
