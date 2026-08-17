import { state } from '../../state/store.js';
import { calcAluno } from '../../../backend/domain/attendance.js';
import { corBadge, freqBar, statusInativo } from '../../../backend/domain/status.js';
import { escapeHtml } from '../../shared/dom.js';

export function renderTabelaAlunos() {
  const busca = (document.getElementById('busca-alunos') || {}).value?.toLowerCase() || '';
  const fCurso = document.getElementById('f-curso-alunos')?.value || '';
  const fStatus = document.getElementById('f-status-alunos')?.value || '';
  const fTurmaAlunos = document.getElementById('f-turma-alunos')?.value || '';
  let lista = state.ALUNOS.map(a => ({ ...a, ...calcAluno(a), turma: state.TURMAS.find(t => t.id === a.turma_id) }));
  if (busca) lista = lista.filter(a => a.nome.toLowerCase().includes(busca));
  if (fCurso) lista = lista.filter(a => a.turma?.curso === fCurso);
  if (fTurmaAlunos) lista = lista.filter(a => String(a.turma_id) === fTurmaAlunos);
  if (fStatus === 'ativo') lista = lista.filter(a => a.ativo);
  else if (fStatus === 'inativo') lista = lista.filter(a => !a.ativo);
  else if (fStatus === 'experimental') lista = lista.filter(a => a.experimental);
  else if (fStatus === 'cancelado') lista = lista.filter(a => !a.ativo && statusInativo(a.id) === 'cancelado');
  else if (fStatus === 'alerta') lista = lista.filter(a => a.ativo && a.emAlerta);
  else if (fStatus === 'irregular') lista = lista.filter(a => a.ativo && a.freq !== null && a.freq < 70);

  document.getElementById('tbody-alunos').innerHTML = lista.map(a => `
    <tr class="clickable ${a.emAlerta && a.ativo ? 'row-alerta' : ''} ${!a.ativo ? 'row-inativo' : ''} ${a.experimental ? 'row-experimental' : ''}" onclick="abrirModalAluno(${a.id})">
      <td>${escapeHtml(a.nome)}${!a.ativo ? ' <span class="badge badge-gray" style="font-size:10px;">Inativo</span>' : ''}</td>
      <td><span class="badge ${corBadge(a.turma?.curso)}" style="font-size:10px;">${escapeHtml(a.turma?.curso) || 'Sem curso'}</span></td>
      <td style="color:var(--text-3);">${escapeHtml(a.turma?.turma) || 'Sem turma'}</td>
      <td style="text-align:center;color:var(--green);font-weight:600;">${a.p - a.r}</td>
      <td style="text-align:center;color:var(--amber);font-weight:600;">${a.r > 0 ? a.r : '—'}</td>
      <td style="text-align:center;color:var(--red);font-weight:600;">${a.f}</td>
      <td style="text-align:center;">${a.maxConsec > 0 ? `<span class="badge ${a.emAlerta ? 'badge-red' : 'badge-gray'}">${a.maxConsec}</span>` : '—'}</td>
      <td>${freqBar(a.freq)}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">Nenhum aluno encontrado.</td></tr>';
  document.getElementById('alunos-count').textContent = `${lista.length} aluno${lista.length !== 1 ? 's' : ''} · Clique para ver detalhes, editar ou transferir`;
}

export function atualizarTurmasAlunos() {
  const fCurso = document.getElementById('f-curso-alunos')?.value || '';
  let turmasFilt = state.TURMAS;
  if (fCurso) turmasFilt = turmasFilt.filter(t => t.curso === fCurso);
  const ft = document.getElementById('f-turma-alunos');
  if (ft) ft.innerHTML = '<option value="">Todas</option>' + turmasFilt.map(t => '<option value="' + t.id + '">' + escapeHtml(t.turma) + ' - ' + (escapeHtml(t.curso) || 'sem curso') + '</option>').join('');
}
