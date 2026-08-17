import { state } from '../../state/store.js';
import { calcAluno } from '../../../backend/domain/attendance.js';
import { statusInativo, corBadge, professorNome, temaCurso, FOCOS_METRICAS } from '../../../backend/domain/status.js';
import { escapeHtml } from '../../shared/dom.js';
import { lineChart, barChart, donutChart } from '../../shared/charts.js';

const DIAS_SEMANA = [
  { key: 'domingo', label: 'Dom' }, { key: 'segunda', label: 'Seg' }, { key: 'terca', label: 'Ter' },
  { key: 'quarta', label: 'Qua' }, { key: 'quinta', label: 'Qui' }, { key: 'sexta', label: 'Sex' },
  { key: 'sabado', label: 'Sáb' },
];

// ── HELPERS ─────────────────────────────────────────────────────
function fbar(val, color) {
  return `<div class="metr-bar-wrap"><div class="metr-bar"><div class="metr-bar-fill" style="width:${val || 0}%;background:${color};"></div></div><span style="font-weight:600;color:${color};font-size:11px;">${val !== null ? val + '%' : '—'}</span></div>`;
}

function numBadge(n, cls) {
  return n > 0 ? `<span class="badge ${cls}">${n}</span>` : '<span style="color:var(--text-very-faded);">—</span>';
}

function freqColor(freq) {
  return freq !== null ? (freq >= 75 ? 'var(--green)' : 'var(--amber)') : 'var(--text-faded)';
}

function capitalizar(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Últimos `n` meses (mais antigo primeiro), cada um com uma chave "AAAA-M"
// pra casar com created_at do histórico e um rótulo curto ("Mar", "Abr"...).
function ultimosMeses(n) {
  const hoje = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - (n - 1 - i), 1);
    return { chave: `${d.getFullYear()}-${d.getMonth()}`, label: capitalizar(d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')) };
  });
}

// Variação percentual mês atual vs anterior — sem inventar % quando a base é 0.
// `bomSeSubiu` separa o sinal numérico (sempre "subiu ou desceu") da cor do
// selo: pra cancelamentos, subir é ruim, então a mesma alta aparece em
// vermelho, não verde.
function deltaBadge(atual, anterior, bomSeSubiu = true) {
  if (anterior === 0) {
    if (atual === 0) return { dir: 'flat', text: '—' };
    return { dir: bomSeSubiu ? 'up' : 'down', text: 'novo' };
  }
  const pct = Math.round(((atual - anterior) / anterior) * 100);
  if (pct === 0) return { dir: 'flat', text: '0%' };
  const subiu = pct > 0;
  return { dir: subiu === bomSeSubiu ? 'up' : 'down', text: `${subiu ? '+' : ''}${pct}%` };
}

function kpiCardHtml({ value, label, badge }) {
  return `<div class="kpi-card">
    <div class="kpi-card-label">${label}</div>
    <div class="kpi-card-value">${value}</div>
    <div class="kpi-card-foot">
      <span class="delta-badge ${badge.dir}">${badge.text}</span>
      <span class="kpi-card-foot-text">este mês</span>
    </div>
  </div>`;
}

// ── SELETOR DE FOCO (Geral / Evolution / Master / Elas) ────────────
// Troca o "recorte" do dashboard inteiro: cada opção filtra turmas/alunos
// pela palavra-chave do curso, usando a mesma cor que o curso já tem em
// badges no resto do sistema (temaCurso, em backend/domain/status.js).
function focoSwitchHtml(focoAtual) {
  const geralAtivo = focoAtual === 'geral';
  const botoes = [
    `<button class="foco-btn ${geralAtivo ? 'active' : ''}" style="--foco-dot:var(--primary);" onclick="setFocoMetricas('geral')">
      <span class="foco-btn-dot"></span>Geral
    </button>`,
    ...FOCOS_METRICAS.map(t => `<button class="foco-btn ${focoAtual === t.chave ? 'active' : ''}" style="--foco-dot:${t.cor};" onclick="setFocoMetricas('${t.chave}')">
      <span class="foco-btn-dot"></span>${t.chave}
    </button>`),
  ];
  const corIndicador = geralAtivo ? 'var(--primary-soft)' : FOCOS_METRICAS.find(t => t.chave === focoAtual)?.corSoft;
  return `<div class="foco-indicator" id="metr-foco-indicator" style="background:${corIndicador};"></div>${botoes.join('')}`;
}

function moverIndicadorFoco() {
  const wrap = document.getElementById('metr-foco');
  const indicador = document.getElementById('metr-foco-indicator');
  const ativo = wrap?.querySelector('.foco-btn.active');
  if (!wrap || !indicador || !ativo) return;
  indicador.style.setProperty('--foco-x', ativo.offsetLeft + 'px');
  indicador.style.setProperty('--foco-w', ativo.offsetWidth + 'px');
}

export function setFocoMetricas(foco) {
  state.metricasFoco = foco;
  renderMetricas();
}

export function renderMetricas() {
  const foco = state.metricasFoco || 'geral';
  // Cada foco de curso mostra só as turmas cujo tema bate com a chave
  // selecionada (mesma classificação usada nos badges — ver temaCurso) e os
  // alunos que estão nelas hoje. "geral" usa os arrays inteiros, sem filtro.
  const turmasFoco = foco === 'geral' ? state.TURMAS : state.TURMAS.filter(t => temaCurso(t.curso)?.chave === foco);
  const turmaIdsFoco = new Set(turmasFoco.map(t => t.id));
  const alunosFoco = foco === 'geral' ? state.ALUNOS : state.ALUNOS.filter(a => turmaIdsFoco.has(a.turma_id));
  const alunoIdsFoco = new Set(alunosFoco.map(a => a.id));
  const historicoFoco = foco === 'geral' ? state.HISTORICO : state.HISTORICO.filter(h => alunoIdsFoco.has(h.aluno_id));

  document.getElementById('metr-foco').innerHTML = focoSwitchHtml(foco);
  moverIndicadorFoco();
  document.getElementById('metr-page-sub').textContent = foco === 'geral'
    ? 'Visão geral do sistema, em tempo real'
    : `Visão geral de ${foco}, em tempo real`;

  const ativos = alunosFoco.filter(a => a.ativo);
  const inativos = alunosFoco.filter(a => !a.ativo);
  const turmasAtivas = turmasFoco.filter(t => t.ativa !== false);
  // Só cursos com pelo menos 1 turma ativa aparecem na comparação — um curso
  // 100% inativo não soma nada de útil pra visão "em tempo real" do dashboard.
  const cursos = [...new Set(turmasAtivas.map(t => t.curso).filter(Boolean))].sort();

  const cancelados = inativos.filter(a => statusInativo(a.id) === 'cancelado');
  const soInativos = inativos.filter(a => statusInativo(a.id) === 'inativo');

  const dadosAtivos = ativos.map(a => ({ ...a, ...calcAluno(a) }));
  const comFreq = dadosAtivos.filter(d => d.freq !== null);
  const freqMedia = comFreq.length > 0 ? Math.round(comFreq.reduce((s, d) => s + d.freq, 0) / comFreq.length) : null;
  const regulares = dadosAtivos.filter(d => !d.emAlerta && d.freq !== null && d.freq >= 70);
  const atencao = dadosAtivos.filter(d => !d.emAlerta && d.freq !== null && d.freq < 70);
  const emAlerta = dadosAtivos.filter(d => d.emAlerta);
  const semReg = dadosAtivos.filter(d => d.freq === null);

  // ── NOVAS MATRÍCULAS VS CANCELAMENTOS (últimos 6 meses) ────────
  // Calculado antes dos KPIs porque o mês atual/anterior também alimenta os
  // dois cards de variação na primeira linha do dashboard.
  const meses = ultimosMeses(6);
  const novosPorMes = meses.map(() => 0);
  const cancelPorMes = meses.map(() => 0);
  historicoFoco.forEach(h => {
    const d = new Date(h.created_at);
    const idx = meses.findIndex(m => m.chave === `${d.getFullYear()}-${d.getMonth()}`);
    if (idx === -1) return;
    if (h.descricao?.includes('adicionado ao sistema') || h.descricao?.includes('importado por planilha')) novosPorMes[idx]++;
    else if (h.descricao?.includes('Matrícula cancelada')) cancelPorMes[idx]++;
  });
  const novosMesAtual = novosPorMes[novosPorMes.length - 1], novosMesAnterior = novosPorMes[novosPorMes.length - 2] ?? 0;
  const cancelMesAtual = cancelPorMes[cancelPorMes.length - 1], cancelMesAnterior = cancelPorMes[cancelPorMes.length - 2] ?? 0;

  // ── LINHA 1: KPIs (2 heroes + 2 cards de variação do mês) ──────
  // Fora do foco "geral" os dois heroes assumem a cor do curso selecionado,
  // reforçando visualmente qual recorte está ativo; no "geral" mantêm o
  // azul/verde padrão do sistema.
  const temaFoco = FOCOS_METRICAS.find(t => t.chave === foco);
  const gradPrincipal = temaFoco?.grad || 'var(--grad-blue)';
  const gradSecundario = temaFoco?.grad || 'var(--grad-green)';
  document.getElementById('metr-heroes').innerHTML = `
    <div class="hero-card" style="background:${gradPrincipal};">
      <div class="hero-label">Frequência média</div>
      <div class="hero-value">${freqMedia !== null ? freqMedia : '—'}${freqMedia !== null ? '<small>%</small>' : ''}</div>
      <div class="hero-desc">Média geral (P+R) dos ativos com registro</div>
    </div>
    <div class="hero-card" style="background:${gradSecundario};">
      <div class="hero-label">Alunos ativos</div>
      <div class="hero-value">${ativos.length}</div>
      <div class="hero-desc">${turmasAtivas.length} turma${turmasAtivas.length !== 1 ? 's' : ''} em andamento</div>
    </div>
    ${kpiCardHtml({ value: novosMesAtual, label: 'Novas matrículas', badge: deltaBadge(novosMesAtual, novosMesAnterior) })}
    ${kpiCardHtml({ value: cancelMesAtual, label: 'Cancelamentos', badge: deltaBadge(cancelMesAtual, cancelMesAnterior, false) })}`;

  document.getElementById('metr-linha-matriculas').innerHTML = lineChart({
    labels: meses.map(m => m.label),
    series: [
      { label: 'Novas matrículas', color: 'var(--green)', data: novosPorMes },
      { label: 'Cancelamentos', color: 'var(--red)', data: cancelPorMes },
    ],
  });

  // ── TURMAS POR DIA DA SEMANA ───────────────────────────────────
  document.getElementById('metr-barras-dias').innerHTML = barChart({
    labels: DIAS_SEMANA.map(d => d.label),
    data: DIAS_SEMANA.map(d => turmasAtivas.filter(t => t.dias_semana?.includes(d.key)).length),
    color: 'var(--primary)',
    height: 240,
  });

  // ── DONUT: FREQUÊNCIA DOS ALUNOS ───────────────────────────────
  const segsFreq = [
    { label: 'Regular', value: regulares.length, color: 'var(--green)' },
    { label: 'Atenção', value: atencao.length, color: 'var(--amber)' },
    { label: 'Alerta', value: emAlerta.length, color: 'var(--red)' },
    { label: 'Sem registro', value: semReg.length, color: 'var(--text-very-faded)' },
  ];
  document.getElementById('metr-donut-frequencia').innerHTML =
    donutChart({ segments: segsFreq, size: 148, thickness: 20 }) +
    `<div class="donut-legend">${segsFreq.map(s => `<div class="donut-legend-item"><span class="donut-legend-dot" style="background:${s.color};"></span>${escapeHtml(s.label)}<b>${s.value}</b></div>`).join('')}</div>`;

  // ── DONUT: ATIVOS VS INATIVOS ───────────────────────────────────
  const segsAtivos = [
    { label: 'Ativos', value: ativos.length, color: 'var(--green)' },
    { label: 'Inativos/Cancelados', value: inativos.length, color: 'var(--text-very-faded)' },
  ];
  document.getElementById('metr-donut-ativos').innerHTML =
    donutChart({ segments: segsAtivos, size: 148, thickness: 20, centerLabel: 'Ativos', centerValue: ativos.length }) +
    `<div class="donut-legend">${segsAtivos.map(s => `<div class="donut-legend-item"><span class="donut-legend-dot" style="background:${s.color};"></span>${escapeHtml(s.label)}<b>${s.value}</b></div>`).join('')}</div>`;

  // ── AÇÃO NECESSÁRIA (alunos em alerta, acionável) ──────────────
  const emAlertaOrdenado = emAlerta.slice().sort((a, b) => b.maxConsec - a.maxConsec);
  document.getElementById('metr-alertas').innerHTML = emAlertaOrdenado.length > 0
    ? `<div class="alert-list">${emAlertaOrdenado.map(a => {
        const t = turmasFoco.find(tt => tt.id === a.turma_id);
        return `<div class="alert-row" onclick="abrirModalAluno(${a.id})">
          <div class="alert-row-dot"></div>
          <div class="alert-row-info">
            <div class="alert-row-nome">${escapeHtml(a.nome)}</div>
            <div class="alert-row-turma">${escapeHtml(t?.turma) || '—'}${t ? ' · ' + (escapeHtml(t.curso) || 'sem curso') : ''}</div>
          </div>
          <div class="alert-row-meta">
            <span class="badge badge-red">${a.maxConsec} faltas</span>
            <span style="font-size:10px;color:var(--text-faded);">freq ${a.freq !== null ? a.freq + '%' : '—'}</span>
          </div>
        </div>`;
      }).join('')}</div>`
    : `<div class="metr-empty">Nenhum aluno em alerta no momento.</div>`;

  // ── COMPARAÇÃO POR CURSO ──────────────────────────────────────
  document.getElementById('metr-tabela-curso').innerHTML = `
    <thead><tr>
      <th>Curso</th><th style="text-align:center;">Turmas</th><th style="text-align:center;">Alunos ativos</th>
      <th style="text-align:center;">Média / turma</th><th style="text-align:center;">Freq. média</th>
      <th style="text-align:center;">Regulares</th><th style="text-align:center;">Atenção</th>
      <th style="text-align:center;">Alerta</th><th style="text-align:center;">Cancelados</th><th style="text-align:center;">Inativos</th>
    </tr></thead>
    <tbody>${cursos.map(c => {
      // Só turmas ativas — mesmo critério da tabela "Carga por professor" logo
      // abaixo (que usa turmasAtivas) e do hero "X turmas em andamento". Usar
      // turmasFoco aqui contava turmas inativas sempre que alguém ainda ativo
      // estivesse matriculado nelas (ex.: transferido pra lá depois da turma
      // já ter sido inativada), fazendo o curso aparecer com mais turmas e
      // mais alunos ativos do que a soma das linhas de professor do mesmo
      // curso na tabela seguinte.
      const tC = turmasAtivas.filter(t => t.curso === c);
      const aC = alunosFoco.filter(a => a.ativo && tC.some(t => t.id === a.turma_id));
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
      return `<tr>
        <td><span class="badge ${corBadge(c)}">${escapeHtml(c)}</span></td>
        <td style="text-align:center;font-weight:600;">${tC.length}</td>
        <td style="text-align:center;font-weight:600;">${aC.length}</td>
        <td style="text-align:center;color:var(--text-3);">${media}</td>
        <td style="text-align:center;">${fbar(fM, freqColor(fM))}</td>
        <td style="text-align:center;">${numBadge(reg, 'badge-green')}</td>
        <td style="text-align:center;">${numBadge(at, 'badge-amber')}</td>
        <td style="text-align:center;">${numBadge(al, 'badge-red')}</td>
        <td style="text-align:center;">${numBadge(canC.length, 'badge-red')}</td>
        <td style="text-align:center;">${numBadge(inaC.length, 'badge-amber')}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="10" class="empty">Nenhum curso cadastrado.</td></tr>'}</tbody>`;

  // ── CARGA POR PROFESSOR ───────────────────────────────────────
  const porProfessor = new Map(); // professor_id (ou '—') -> turmas[]
  turmasAtivas.forEach(t => {
    const chave = t.professor_id ?? '—';
    if (!porProfessor.has(chave)) porProfessor.set(chave, []);
    porProfessor.get(chave).push(t);
  });
  const linhasProfessor = [...porProfessor.values()].map(tP => {
    const nome = professorNome(tP[0]);
    const aP = alunosFoco.filter(a => a.ativo && tP.some(t => t.id === a.turma_id));
    const dp = aP.map(a => calcAluno(a));
    const comF = dp.filter(d => d.freq !== null);
    const fM = comF.length > 0 ? Math.round(comF.reduce((s, d) => s + d.freq, 0) / comF.length) : null;
    const al = dp.filter(d => d.emAlerta).length;
    return { nome, turmas: tP.length, alunos: aP.length, freq: fM, alertas: al };
  }).sort((a, b) => b.alunos - a.alunos);

  document.getElementById('metr-tabela-professor').innerHTML = `
    <thead><tr>
      <th>Professor</th><th style="text-align:center;">Turmas</th><th style="text-align:center;">Alunos ativos</th>
      <th style="text-align:center;">Freq. média</th><th style="text-align:center;">Em alerta</th>
    </tr></thead>
    <tbody>${linhasProfessor.map(p => `<tr>
        <td style="font-weight:500;">${escapeHtml(p.nome)}</td>
        <td style="text-align:center;font-weight:600;">${p.turmas}</td>
        <td style="text-align:center;font-weight:600;">${p.alunos}</td>
        <td style="text-align:center;">${fbar(p.freq, freqColor(p.freq))}</td>
        <td style="text-align:center;">${numBadge(p.alertas, 'badge-red')}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum professor com turma ativa.</td></tr>'}</tbody>`;

  // ── ATIVIDADE RECENTE (feed) ──────────────────────────────────
  const eventos = historicoFoco.filter(h => h.tipo !== 'observacao').slice(0, 8);
  document.getElementById('metr-atividade').innerHTML = eventos.length > 0
    ? `<div class="activity-feed">${eventos.map(h => {
        const aluno = alunosFoco.find(a => a.id === h.aluno_id);
        const cor = h.descricao?.includes('adicionado ao sistema') || h.descricao?.includes('importado por planilha') ? 'var(--green)'
          : h.descricao?.includes('Transferido') ? 'var(--primary)'
          : h.descricao?.includes('Matrícula cancelada') ? 'var(--red)'
          : h.descricao?.includes('reativado') ? 'var(--green)'
          : h.descricao?.includes('inativado') ? 'var(--amber)'
          : 'var(--text-faded)';
        return `<div class="activity-row">
          <div class="activity-row-rail"><div class="activity-dot" style="background:${cor};"></div><div class="activity-line"></div></div>
          <div class="activity-body">
            <div class="activity-desc">${aluno ? `<b>${escapeHtml(aluno.nome)}</b> — ` : ''}${escapeHtml(h.descricao || '')}</div>
            <div class="activity-time">${new Date(h.created_at).toLocaleDateString('pt-BR')}</div>
          </div>
        </div>`;
      }).join('')}</div>`
    : `<div class="metr-empty">Nenhuma atividade registrada ainda.</div>`;
}

window.addEventListener('resize', moverIndicadorFoco);
