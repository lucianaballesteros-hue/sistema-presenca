import { state } from '../../state/store.js';
import { escapeHtml, fecharModal } from '../../shared/dom.js';
import { inserirCurso } from '../../../backend/api/cursosRepo.js';

let prefixoOrigem = 'nt';

// Popula o <select> de curso do prefixo dado (nt = nova turma, et = editar
// turma) a partir de state.CURSOS. Quando valorAtual é passado, garante que
// esse valor exista como opção (mesmo que não esteja na lista curada — turma
// antiga com curso digitado livremente antes dessa tabela existir) e o
// seleciona; sem valorAtual, mostra um placeholder para forçar escolha
// explícita em vez de cair silenciosamente no primeiro curso da lista.
export function renderOpcoesCurso(prefix, valorAtual) {
  const sel = document.getElementById(prefix + '-curso');
  if (!sel) return;
  const nomes = state.CURSOS.map(c => c.nome);
  if (valorAtual && !nomes.includes(valorAtual)) nomes.push(valorAtual);
  nomes.sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const placeholder = valorAtual ? '' : '<option value="" disabled selected>Selecione um curso</option>';
  sel.innerHTML = placeholder + nomes.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  if (valorAtual) sel.value = valorAtual;
}

export function abrirModalNovoCurso(prefix) {
  prefixoOrigem = prefix;
  document.getElementById('nc-nome').value = '';
  document.getElementById('nc-erro').style.display = 'none';
  const btn = document.getElementById('nc-btn-salvar');
  btn.disabled = false;
  btn.textContent = 'Criar curso';
  document.getElementById('modal-novo-curso').classList.add('open');
}

export async function salvarNovoCurso() {
  const nome = document.getElementById('nc-nome').value.trim();
  const erroEl = document.getElementById('nc-erro');
  erroEl.style.display = 'none';

  if (!nome) { erroEl.textContent = 'Digite o nome do curso.'; erroEl.style.display = 'block'; return; }
  if (state.CURSOS.some(c => c.nome.toLowerCase() === nome.toLowerCase())) {
    erroEl.textContent = 'Já existe um curso com esse nome.'; erroEl.style.display = 'block'; return;
  }

  const btn = document.getElementById('nc-btn-salvar');
  btn.disabled = true;
  btn.textContent = 'Criando…';

  const { data, error } = await inserirCurso(nome);
  if (error) {
    erroEl.textContent = 'Erro ao criar curso: ' + error.message; erroEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Criar curso';
    return;
  }

  state.CURSOS.push(data);
  state.CURSOS.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  fecharModal('modal-novo-curso');
  renderOpcoesCurso(prefixoOrigem, data.nome);
}
