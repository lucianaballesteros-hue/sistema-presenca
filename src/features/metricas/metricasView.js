import { state } from '../../state/store.js';
import { calcAluno } from '../../domain/attendance.js';
import { statusInativo, corBadge } from '../../domain/status.js';

export function renderMetricas() {
  const ativos = state.ALUNOS.filter(a => a.ativo);
  const inativos = state.ALUNOS.filter(a => !a.ativo);
  const cursos = [...new Set(state.TURMAS.map(t => t.curso))].sort();
  const dash = '<span style="color:var(--text-very-faded);">—</span>';

  const cancelados = inativos.filter(a => statusInativo(a.id) === 'cancelado');
  const soInativos = inativos.filter(a => statusInativo(a.id) === 'inativo');

  const dadosAtivos = ativos.map(a => calcAluno(a));
  const comFreq = dadosAtivos.filter(d => d.freq !== null);
  const freqMedia = comFreq.length > 0 ? Math.round(comFreq.reduce((s, d) => s + d.freq, 0) / comFreq.length) : null;
  const regulares = dadosAtivos.filter(d => !d.emAlerta && d.freq !== null && d.freq >= 70).length;
  const atencao = dadosAtivos.filter(d => !d.emAlerta && d.freq !== null && d.freq < 70).length;
  const alertas = dadosAtivos.filter(d => d.emAlerta).length;
  const semReg = dadosAtivos.filter(d => d.freq === null).length;
  const totalRep = dadosAtivos.reduce((s, d) => s + d.r, 0);
  const alunosRep = dadosAtivos.filter(d => d.r > 0).length;

  const transferidos = state.HISTORICO.filter(h => h.descricao?.includes('Transferido')).length;
  const novos = state.HISTORICO.filter(h => h.descricao?.includes('adicionado ao sistema')).length;
  const reativacoes = state.HISTORICO.filter(h => h.descricao?.includes('reativado')).length;

  const total = ativos.length + inativos.length;
  const txEvasao = total > 0 ? ((inativos.length / total) * 100).toFixed(1) : '0';

  function pct(n) { return ativos.length > 0 ? Math.round((n / ativos.length) * 100) : 0; }
  function fbar(val, color) {
    return `<div class="metr-bar-wrap"><div class="metr-bar"><div class="metr-bar-fill" style="width:${val || 0}%;background:${color};"></div></div><span style="font-weight:600;color:${color};font-size:11px;">${val !== null ? val + '%' : '—'}</span></div>`;
  }
  function numBadge(n, cls) { return n > 0 ? `<span class="badge ${cls}">${n}</span>` : dash; }

  // ── VISÃO GERAL ──────────────────────────────────────────────
  const fColor = freqMedia !== null ? (freqMedia >= 75 ? 'var(--green)' : 'var(--amber)') : 'var(--text-faded)';
  document.getElementById('metr-visao-geral').innerHTML = `
    <thead><tr><th>Métrica</th><th style="text-align:center;">Valor</th><th>Descrição</th></tr></thead>
    <tbody>
      <tr><td style="font-weight:500;">🏫 Total de turmas</td><td style="text-align:center;font-weight:700;font-size:15px;">${state.TURMAS.length}</td><td style="color:var(--text-3);font-size:11px;">Turmas cadastradas no sistema</td></tr>
      <tr><td style="font-weight:500;">👥 Alunos ativos</td><td style="text-align:center;font-weight:700;font-size:15px;">${ativos.length}</td><td style="color:var(--text-3);font-size:11px;">Matrículas ativas no momento</td></tr>
      <tr><td style="font-weight:500;">📊 Frequência média</td><td style="text-align:center;">${fbar(freqMedia, fColor)}</td><td style="color:var(--text-3);font-size:11px;">Média geral de presença dos alunos ativos com registro</td></tr>
      <tr><td style="font-weight:500;">⚠️ Em alerta</td><td style="text-align:center;">${numBadge(alertas, 'badge-red')}</td><td style="color:var(--text-3);font-size:11px;">3 faltas seguidas nas últimas 8 aulas com registro (${pct(alertas)}% dos ativos)</td></tr>
      <tr><td style="font-weight:500;">❌ Matrículas canceladas</td><td style="text-align:center;">${numBadge(cancelados.length, 'badge-red')}</td><td style="color:var(--text-3);font-size:11px;">Alunos que encerraram o curso definitivamente</td></tr>
      <tr><td style="font-weight:500;">⏸ Inativos (temporários)</td><td style="text-align:center;">${numBadge(soInativos.length, 'badge-amber')}</td><td style="color:var(--text-3);font-size:11px;">Alunos afastados temporariamente, podem retornar</td></tr>
    </tbody>`;

  // ── DIMENSIONAMENTO POR CURSO ────────────────────────────────
  document.getElementById('metr-tabela-curso').innerHTML = `
    <thead><tr>
      <th>Curso</th><th style="text-align:center;">Turmas</th><th style="text-align:center;">Alunos ativos</th>
      <th style="text-align:center;">Média / turma</th><th style="text-align:center;">Freq. média</th>
      <th style="text-align:center;">Regulares</th><th style="text-align:center;">Atenção</th>
      <th style="text-align:center;">Alerta</th><th style="text-align:center;">Cancelados</th><th style="text-align:center;">Inativos</th>
    </tr></thead>
    <tbody>${cursos.map(c => {
      const tC = state.TURMAS.filter(t => t.curso === c);
      const aC = state.ALUNOS.filter(a => a.ativo && tC.some(t => t.id === a.turma_id));
      const iC = inativos.filter(a => tC.some(t => t.id === a.turma_id));
      const canC = iC.filter(a => statusInativo(a.id) === 'cancelado');
      const inaC = iC.filter(a => statusInativo(a.id) === 'inativo');
      const media = tC.length > 0 ? (aC.length / tC.length).toFixed(1) : '—';
      const dc = aC.map(a => calcAluno(a));
      const comF = dc.filter(d => d.freq !== null);
      const fM = comF.length > 0 ? Math.round(comF.reduce((s, d) => s + d.freq, 0) / comF.length) : null;
      const reg = dc.filter(d => !d.emAlerta && d.freq !== null && d.freq >= 70).length;
      const at = dc.filter(d => !d.emAlerta && d.freq !== null && d.freq < 70).length;
      const al = dc.filter(d => d.emAlerta).length;
      const fc = fM !== null ? (fM >= 75 ? 'var(--green)' : 'var(--amber)') : 'var(--text-faded)';
      return `<tr>
        <td><span class="badge ${corBadge(c)}">${c}</span></td>
        <td style="text-align:center;font-weight:600;">${tC.length}</td>
        <td style="text-align:center;font-weight:600;">${aC.length}</td>
        <td style="text-align:center;color:var(--text-3);">${media}</td>
        <td style="text-align:center;">${fbar(fM, fc)}</td>
        <td style="text-align:center;">${numBadge(reg, 'badge-green')}</td>
        <td style="text-align:center;">${numBadge(at, 'badge-amber')}</td>
        <td style="text-align:center;">${numBadge(al, 'badge-red')}</td>
        <td style="text-align:center;">${numBadge(canC.length, 'badge-red')}</td>
        <td style="text-align:center;">${numBadge(inaC.length, 'badge-amber')}</td>
      </tr>`;
    }).join('')}</tbody>`;

  // ── FREQUÊNCIA E DESEMPENHO ──────────────────────────────────
  document.getElementById('metr-frequencia').innerHTML = `
    <thead><tr><th>Status</th><th style="text-align:center;">Alunos</th><th style="text-align:center;">% dos ativos</th><th>Critério</th></tr></thead>
    <tbody>
      <tr><td style="font-weight:500;">✅ Presença física (P)</td><td style="text-align:center;">${numBadge(dadosAtivos.filter(d => d.p - d.r > 0 || d.r === 0 && d.p > 0).length, 'badge-green')}</td><td style="text-align:center;">${fbar(pct(regulares), 'var(--green)')}</td><td style="color:var(--text-3);font-size:11px;">Presença registrada normalmente na aula</td></tr>
      <tr><td style="font-weight:500;">🟡 Gravações (R)</td><td style="text-align:center;">${alunosRep > 0 ? `<span class="badge badge-amber">${alunosRep}</span>` : dash}</td><td style="text-align:center;">${fbar(pct(alunosRep), 'var(--amber)')}</td><td style="color:var(--text-3);font-size:11px;">Assistiram via plataforma · conta como presença · ${totalRep} registros no total</td></tr>
      <tr><td style="font-weight:500;">✅ Regulares (≥70%)</td><td style="text-align:center;">${numBadge(regulares, 'badge-green')}</td><td style="text-align:center;">${fbar(pct(regulares), 'var(--green)')}</td><td style="color:var(--text-3);font-size:11px;">freq ≥ 70% (P+R) e sem alerta</td></tr>
      <tr><td style="font-weight:500;">🟠 Atenção (&lt;70%)</td><td style="text-align:center;">${numBadge(atencao, 'badge-amber')}</td><td style="text-align:center;">${fbar(pct(atencao), 'var(--amber)')}</td><td style="color:var(--text-3);font-size:11px;">freq &lt; 70% e sem 3 faltas seguidas</td></tr>
      <tr><td style="font-weight:500;">🔴 Em alerta</td><td style="text-align:center;">${numBadge(alertas, 'badge-red')}</td><td style="text-align:center;">${fbar(pct(alertas), 'var(--red)')}</td><td style="color:var(--text-3);font-size:11px;">3 faltas seguidas nas últimas 8 aulas com registro</td></tr>
      <tr><td style="font-weight:500;">⬜ Sem registro</td><td style="text-align:center;">${semReg > 0 ? `<span class="badge badge-gray">${semReg}</span>` : dash}</td><td style="text-align:center;">${fbar(pct(semReg), 'var(--text-faded)')}</td><td style="color:var(--text-3);font-size:11px;">Nenhuma aula lançada ainda</td></tr>
    </tbody>`;

  // ── EVASÃO E MOVIMENTAÇÃO ────────────────────────────────────
  document.getElementById('metr-movimentacao').innerHTML = `
    <thead><tr><th>Evento</th><th style="text-align:center;">Quantidade</th><th>Descrição</th></tr></thead>
    <tbody>
      <tr><td style="font-weight:500;">➕ Novos alunos</td><td style="text-align:center;font-weight:700;font-size:15px;">${novos}</td><td style="color:var(--text-3);font-size:11px;">Total de alunos adicionados ao sistema</td></tr>
      <tr><td style="font-weight:500;">🔄 Transferências</td><td style="text-align:center;font-weight:700;font-size:15px;">${transferidos}</td><td style="color:var(--text-3);font-size:11px;">Movimentações internas entre turmas ou cursos</td></tr>
      <tr><td style="font-weight:500;">❌ Matrículas canceladas</td><td style="text-align:center;">${numBadge(cancelados.length, 'badge-red')}</td><td style="color:var(--text-3);font-size:11px;">Alunos que encerraram o curso · taxa de evasão: ${txEvasao}% do total</td></tr>
      <tr><td style="font-weight:500;">⏸ Inativos (temporários)</td><td style="text-align:center;">${numBadge(soInativos.length, 'badge-amber')}</td><td style="color:var(--text-3);font-size:11px;">Alunos afastados temporariamente, podem retornar</td></tr>
      <tr><td style="font-weight:500;">↩️ Reativações</td><td style="text-align:center;">${reativacoes > 0 ? `<span class="badge badge-green">${reativacoes}</span>` : dash}</td><td style="color:var(--text-3);font-size:11px;">Alunos que retornaram após afastamento ou cancelamento</td></tr>
    </tbody>`;
}
