import { state } from '../../state/store.js';
import { escapeHtml } from '../../shared/dom.js';

const PROF_COLORS = ['#1d4ed8', '#059669', '#7c3aed', '#db2777', '#d97706', '#0891b2', '#dc2626', '#65a30d'];

export function profColor(id) {
  return PROF_COLORS[(id || 0) % PROF_COLORS.length];
}

export function profIniciais(nome) {
  if (!nome) return '??';
  const parts = nome.trim().split(' ').filter(Boolean);
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function renderProfessores() {
  const busca = (document.getElementById('busca-prof')?.value || '').toLowerCase();
  let lista = state.PROFESSORES;
  if (busca) lista = lista.filter(p => p.nome?.toLowerCase().includes(busca) || p.email?.toLowerCase().includes(busca));

  const admins = state.PROFESSORES.filter(p => p.papel === 'admin').length;
  const profs = state.PROFESSORES.filter(p => p.papel !== 'admin').length;

  document.getElementById('prof-stats').innerHTML = `
    <div class="stat-card"><div class="stat-label">Total de usuários</div><div class="stat-val">${state.PROFESSORES.length}</div></div>
    <div class="stat-card"><div class="stat-label">Admins</div><div class="stat-val">${admins}</div></div>
    <div class="stat-card"><div class="stat-label">Professores</div><div class="stat-val">${profs}</div></div>`;

  if (!lista.length) {
    document.getElementById('prof-grid').innerHTML = '<div class="empty">Nenhum professor encontrado.</div>';
    return;
  }

  document.getElementById('prof-grid').innerHTML = lista.map(p => {
    const turmasDoProf = state.TURMAS.filter(t => t.professor_id === p.id);
    const cor = profColor(p.id);
    const ini = profIniciais(p.nome);
    const papelBadge = p.papel === 'admin'
      ? '<span class="badge badge-blue">Admin</span>'
      : '<span class="badge badge-gray">Professor</span>';
    const euBadge = p.user_id === state.usuarioLogado?.id
      ? '<span class="badge badge-green">Você</span>'
      : '';
    return `
      <div class="prof-card">
        <div class="prof-av" style="background:${cor};">${escapeHtml(ini)}</div>
        <div class="prof-info">
          <div class="prof-nome">${escapeHtml(p.nome) || '—'}</div>
          <div class="prof-email">${escapeHtml(p.email) || '—'}</div>
          <div class="prof-meta">
            ${papelBadge}
            ${euBadge}
            <span style="font-size:11px;color:var(--text-faded);">${turmasDoProf.length} turma${turmasDoProf.length !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <div class="prof-actions">
          <button class="btn-edit-prof" onclick="abrirModalEditarProf(${p.id})" aria-label="Editar professor"><span class="icon-mask icon-editar"></span> Editar</button>
        </div>
      </div>`;
  }).join('');
}
