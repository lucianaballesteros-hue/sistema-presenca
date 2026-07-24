import { state } from '../../state/store.js';
import { aulasDaTurma, calcAluno, ultimaAulaRegistrada } from '../../domain/attendance.js';
import { escapeHtml, escapeAttr, showToast, fecharModal } from '../../shared/dom.js';
import { criarReposicao } from '../../api/reposicoesRepo.js';
import { renderReposicoes } from './reposicoesView.js';

const MAX_OPCOES = 4;
let opcoesTemp = [];
let ultimoLinkGerado = '';

export function abrirModalReposicao() {
  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  const t = state.TURMAS.find(x => x.id === a.turma_id);
  const c = calcAluno(a);
  const aulasTurma = aulasDaTurma(t);
  const faltas = aulasTurma.filter((_, i) => c.seq[i] === 'F');

  document.getElementById('rep-aluno-nome').textContent = a.nome;
  document.getElementById('rep-aluno-info').textContent = `${t?.turma || '—'} · ${t?.curso || '—'}`;

  const selAula = document.getElementById('rep-aula-sel');
  selAula.innerHTML = aulasTurma.map(au =>
    `<option value="${au}">${au}${faltas.includes(au) ? ' — falta' : ''}</option>`
  ).join('');
  if (faltas.length) selAula.value = faltas[0];

  document.getElementById('rep-erro').textContent = '';
  opcoesTemp = [{ turmaDestinoId: '', data: '', observacao: '' }];
  renderOpcoesReposicao();

  fecharModal('modal-aluno');
  document.getElementById('modal-reposicao').classList.add('open');
}

function turmaOptionsHtml(selectedId) {
  return state.TURMAS.map(t =>
    `<option value="${t.id}" ${String(t.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(t.turma)} — ${escapeHtml(t.curso)} (Prof. ${escapeHtml(t.professor)})</option>`
  ).join('');
}

export function renderOpcoesReposicao() {
  const wrap = document.getElementById('rep-opcoes-list');
  wrap.innerHTML = opcoesTemp.map((o, i) => {
    const turmaDestino = o.turmaDestinoId ? state.TURMAS.find(t => t.id === parseInt(o.turmaDestinoId)) : null;
    const dica = turmaDestino ? ultimaAulaRegistrada(turmaDestino) : null;
    return `<div class="rep-opcao-row">
      <div class="rep-opcao-header">
        <span class="rep-opcao-badge">${i + 1}</span>
        <select onchange="atualizarOpcaoReposicao(${i},'turmaDestinoId',this.value)">
          <option value="">Selecione a turma...</option>
          ${turmaOptionsHtml(o.turmaDestinoId)}
        </select>
        ${opcoesTemp.length > 1 ? `<button type="button" class="rep-opcao-remove" onclick="removerOpcaoReposicao(${i})" aria-label="Remover opção">×</button>` : ''}
      </div>
      <div class="rep-opcao-body">
        <input type="date" value="${o.data}" onchange="atualizarOpcaoReposicao(${i},'data',this.value)"/>
        <input type="text" class="rep-opcao-obs" placeholder="Observação (opcional, ex: chegar 10 min antes)" value="${escapeAttr(o.observacao)}" onchange="atualizarOpcaoReposicao(${i},'observacao',this.value)"/>
      </div>
      ${dica ? `<div class="rep-opcao-dica">💡 Essa turma já registrou presença até <strong>${dica}</strong></div>` : ''}
    </div>`;
  }).join('');
}

export function atualizarOpcaoReposicao(i, campo, valor) {
  opcoesTemp[i][campo] = valor;
  if (campo === 'turmaDestinoId') renderOpcoesReposicao();
}

export function adicionarOpcaoReposicao() {
  if (opcoesTemp.length >= MAX_OPCOES) { showToast(`Máximo de ${MAX_OPCOES} opções por reposição.`, 'red'); return; }
  opcoesTemp.push({ turmaDestinoId: '', data: '', observacao: '' });
  renderOpcoesReposicao();
}

export function removerOpcaoReposicao(i) {
  opcoesTemp.splice(i, 1);
  renderOpcoesReposicao();
}

export async function salvarReposicao() {
  const a = state.ALUNOS.find(x => x.id === state.alunoSelecionadoId);
  const aula = document.getElementById('rep-aula-sel').value;
  const erroEl = document.getElementById('rep-erro');

  const opcoesValidas = opcoesTemp.filter(o => o.turmaDestinoId && o.data);
  if (!opcoesValidas.length) { erroEl.textContent = 'Adicione ao menos uma opção com turma e data preenchidas.'; return; }

  // Abre a aba já aqui, ainda dentro do clique do usuário — se esperarmos a
  // resposta do Supabase para chamar window.open, a maioria dos navegadores
  // trata como pop-up não solicitado e bloqueia.
  const abaPreview = window.open('', '_blank');

  const btn = document.getElementById('rep-btn-salvar');
  btn.disabled = true;
  const { data, error } = await criarReposicao({
    alunoId: a.id,
    turmaOrigemId: a.turma_id,
    aula,
    criadoPor: state.perfilLogado?.id,
    opcoes: opcoesValidas.map(o => ({
      turmaDestinoId: parseInt(o.turmaDestinoId),
      data: o.data,
      observacao: o.observacao,
    })),
  });
  btn.disabled = false;

  if (error) {
    console.error(error);
    erroEl.textContent = 'Erro ao criar reposição. Tente novamente.';
    if (abaPreview) abaPreview.close();
    return;
  }

  const link = new URL(`reposicao.html?token=${data.token}`, window.location.href).href;
  if (abaPreview) abaPreview.location.href = link; else window.open(link, '_blank');

  fecharModal('modal-reposicao');
  mostrarLinkReposicao(link, a.nome);
  renderReposicoes();
}

function mostrarLinkReposicao(link, nomeAluno) {
  ultimoLinkGerado = link;
  document.getElementById('rep-link-desc').textContent = `A página já abriu numa nova aba. Envie este link para ${nomeAluno} (ou responsável) marcar a reposição:`;
  document.getElementById('rep-link-input').value = link;
  document.getElementById('modal-reposicao-link').classList.add('open');
  navigator.clipboard?.writeText(link).then(() => showToast('Link copiado!')).catch(() => {});
}

export function copiarLinkReposicao() {
  const inp = document.getElementById('rep-link-input');
  inp.select();
  navigator.clipboard?.writeText(inp.value)
    .then(() => showToast('Link copiado!'))
    .catch(() => {});
}

export function abrirPaginaReposicaoGerada() {
  if (ultimoLinkGerado) window.open(ultimoLinkGerado, '_blank');
}
