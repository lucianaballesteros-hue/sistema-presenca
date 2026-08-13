// Motor de gráficos SVG do dashboard de Métricas. O projeto não usa nenhuma
// biblioteca de gráficos (sem passo de build, só HTML/CSS/JS puro), então os
// gráficos são montados na mão: cada função devolve uma string HTML pronta
// pra innerHTML, e registra os dados num mapa em memória (`registry`) que os
// handlers de hover (expostos globalmente via main.js) consultam depois de
// inseridos no DOM — mesmo padrão de "renderiza string, liga comportamento
// depois" já usado no resto do app.
import { escapeHtml } from './dom.js';

const registry = new Map();
let uid = 0;

function fmtNum(n) {
  return new Intl.NumberFormat('pt-BR').format(n);
}

// Arredonda o teto do eixo Y pra um número "redondo" (1/2/5 × 10^n).
function niceCeil(max) {
  if (max <= 0) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const n = max / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

// ── TOOLTIP COMPARTILHADO (um único elemento fixo, reposicionado) ──
// Nomes de série/categoria podem vir de dados cadastrados pelo usuário
// (curso, turma, professor) — nunca via innerHTML com string interpolada,
// sempre textContent.
function tooltipEl() {
  return document.getElementById('chart-tooltip');
}

export function hideChartTooltip() {
  const el = tooltipEl();
  if (el) el.style.display = 'none';
}

function showChartTooltip(clientX, clientY, title, rows) {
  const el = tooltipEl();
  if (!el) return;
  el.innerHTML = '';
  if (title) {
    const t = document.createElement('div');
    t.className = 'chart-tooltip-title';
    t.textContent = title;
    el.appendChild(t);
  }
  rows.forEach(r => {
    const row = document.createElement('div');
    row.className = 'chart-tooltip-row';
    const key = document.createElement('span');
    key.className = 'chart-tooltip-key';
    key.style.background = r.color;
    const label = document.createElement('span');
    label.className = 'chart-tooltip-label';
    label.textContent = r.label;
    const val = document.createElement('span');
    val.className = 'chart-tooltip-val';
    val.textContent = r.value;
    row.append(key, label, val);
    el.appendChild(row);
  });
  el.style.display = 'block';
  const pad = 14;
  let left = clientX + pad;
  let top = clientY - el.offsetHeight - pad;
  if (left + el.offsetWidth > window.innerWidth - 8) left = clientX - el.offsetWidth - pad;
  if (top < 8) top = clientY + pad;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

// ── GRÁFICO DE LINHA — múltiplas séries por categoria (ex.: mês) ───
// opts: { labels:['Mar',...], series:[{label,color,data:[n,...]}], height }
export function lineChart(opts) {
  const id = `chart-${++uid}`;
  const { labels, series, height = 220 } = opts;
  const W = 640, H = height, mL = 34, mR = 12, mT = 16, mB = 26;
  const plotW = W - mL - mR, plotH = H - mT - mB;
  const yMax = niceCeil(Math.max(1, ...series.flatMap(s => s.data)));
  const n = labels.length;
  const xAt = i => mL + (n > 1 ? (plotW / (n - 1)) * i : plotW / 2);
  const yAt = v => mT + plotH - (v / yMax) * plotH;

  registry.set(id, { labels, series, W, mL, plotW, xAt });

  // Com yMax bem pequeno (gráfico quase todo zerado), frações diferentes de
  // yMax podem arredondar pro mesmo valor — mostra o número só na 1ª vez que
  // aparece, pra não empilhar "1/1/1" repetido no eixo.
  let ultimoLabel = null;
  const gridLines = [0, .25, .5, .75, 1].map(f => {
    const y = mT + plotH * (1 - f);
    const val = Math.round(yMax * f);
    const mostrarLabel = val !== ultimoLabel;
    ultimoLabel = val;
    return `<line x1="${mL}" y1="${y}" x2="${W - mR}" y2="${y}" class="chart-grid"/>
      ${mostrarLabel ? `<text x="${mL - 8}" y="${y + 3}" class="chart-axis-label" text-anchor="end">${fmtNum(val)}</text>` : ''}`;
  }).join('');

  const xLabels = labels.map((lb, i) => `<text x="${xAt(i)}" y="${H - 6}" class="chart-axis-label" text-anchor="middle">${escapeHtml(lb)}</text>`).join('');

  const baseline = (mT + plotH).toFixed(1);
  const seriesSvg = series.map(s => {
    const pts = s.data.map((v, i) => [xAt(i), yAt(v)]);
    const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const area = `${path} L${pts[pts.length - 1][0].toFixed(1)},${baseline} L${pts[0][0].toFixed(1)},${baseline} Z`;
    const dots = pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`).join('');
    const last = pts[pts.length - 1];
    return `<path d="${area}" fill="${s.color}" opacity=".1"/>
      <path d="${path}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
      <text x="${(last[0] + 8).toFixed(1)}" y="${(last[1] - 8).toFixed(1)}" class="chart-point-label" fill="${s.color}" text-anchor="start">${fmtNum(s.data[s.data.length - 1])}</text>`;
  }).join('');

  const legend = series.map(s => `<span class="chart-legend-item"><span class="chart-legend-key" style="background:${s.color};"></span>${escapeHtml(s.label)}</span>`).join('');

  return `<div class="chart-legend">${legend}</div>
    <div class="chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" class="chart-svg" id="${id}"
        onmousemove="onLineChartMove(event,'${id}')" onmouseleave="onLineChartLeave('${id}')">
        ${gridLines}${seriesSvg}${xLabels}
        <line id="${id}-cross" x1="${mL}" y1="${mT}" x2="${mL}" y2="${mT + plotH}" class="chart-crosshair" style="opacity:0;"/>
      </svg>
    </div>`;
}

export function onLineChartMove(e, id) {
  const chart = registry.get(id);
  const svg = document.getElementById(id);
  if (!chart || !svg) return;
  const rect = svg.getBoundingClientRect();
  const xSvg = (e.clientX - rect.left) * (chart.W / rect.width);
  const n = chart.labels.length;
  const step = n > 1 ? chart.plotW / (n - 1) : chart.plotW;
  let idx = Math.round((xSvg - chart.mL) / step);
  idx = Math.max(0, Math.min(n - 1, idx));
  const x = chart.xAt(idx);
  const cross = document.getElementById(`${id}-cross`);
  if (cross) { cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.opacity = '1'; }
  const rows = chart.series.map(s => ({ color: s.color, label: s.label, value: fmtNum(s.data[idx]) }));
  showChartTooltip(e.clientX, e.clientY, chart.labels[idx], rows);
}

export function onLineChartLeave(id) {
  const cross = document.getElementById(`${id}-cross`);
  if (cross) cross.style.opacity = '0';
  hideChartTooltip();
}

// ── GRÁFICO DE BARRAS — uma série por categoria ─────────────────
// opts: { labels:[...], data:[...], color, height }
export function barChart(opts) {
  const id = `chart-${++uid}`;
  const { labels, data, color = 'var(--primary)', height = 200 } = opts;
  const W = 320, H = height, mL = 8, mR = 8, mT = 24, mB = 22;
  const plotW = W - mL - mR, plotH = H - mT - mB;
  const n = labels.length;
  const slot = plotW / n;
  const barW = Math.min(24, slot * 0.5);
  const yMax = niceCeil(Math.max(1, ...data));

  registry.set(id, { labels, data, color });

  const bars = data.map((v, i) => {
    const h = Math.max(0, (v / yMax) * plotH);
    const x = mL + slot * i + (slot - barW) / 2;
    const y = mT + plotH - h;
    const r = Math.min(4, h / 2);
    const d = h <= 0 ? '' : `M${x.toFixed(1)},${(y + r).toFixed(1)}
      a${r},${r} 0 0 1 ${r.toFixed(1)},-${r.toFixed(1)}
      h${(barW - 2 * r).toFixed(1)}
      a${r},${r} 0 0 1 ${r.toFixed(1)},${r.toFixed(1)}
      v${(h - r).toFixed(1)} h-${barW.toFixed(1)} Z`;
    return `<path d="${d}" fill="${color}" class="chart-bar"
        onmouseenter="onBarHover(event,'${id}',${i})" onmouseleave="hideChartTooltip()"/>
      <rect x="${x.toFixed(1)}" y="${mT}" width="${barW.toFixed(1)}" height="${plotH}" fill="transparent"
        onmouseenter="onBarHover(event,'${id}',${i})" onmouseleave="hideChartTooltip()"/>
      <text x="${(x + barW / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" class="chart-bar-label" text-anchor="middle">${fmtNum(v)}</text>
      <text x="${(x + barW / 2).toFixed(1)}" y="${H - 6}" class="chart-axis-label" text-anchor="middle">${escapeHtml(labels[i])}</text>`;
  }).join('');

  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" class="chart-svg">${bars}</svg></div>`;
}

export function onBarHover(e, id, i) {
  const chart = registry.get(id);
  if (!chart) return;
  showChartTooltip(e.clientX, e.clientY, null, [{ color: chart.color, label: chart.labels[i], value: fmtNum(chart.data[i]) }]);
}

// ── DONUT — parte-todo, poucos segmentos ────────────────────────
// opts: { segments:[{label,value,color}], size, thickness, centerLabel, centerValue }
export function donutChart(opts) {
  const id = `chart-${++uid}`;
  const { segments, size = 160, thickness = 22, centerLabel = '', centerValue = '' } = opts;
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  const gap = 3;
  const withValue = segments.filter(s => s.value > 0);

  registry.set(id, { segments: withValue, total });

  let acc = 0;
  const arcs = total > 0 ? withValue.map((seg, i) => {
    const full = (seg.value / total) * circumference;
    const dash = Math.max(0, full - gap);
    const offset = -acc;
    acc += full;
    return `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="${thickness}"
      stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
      class="chart-donut-seg" onmouseenter="onDonutHover(event,'${id}',${i})" onmouseleave="hideChartTooltip()"/>`;
  }).join('') : `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--bar-track)" stroke-width="${thickness}"/>`;

  const center = centerLabel ? `<div class="donut-center">
      <div class="donut-center-val">${escapeHtml(String(centerValue))}</div>
      <div class="donut-center-label">${escapeHtml(centerLabel)}</div>
    </div>` : '';

  return `<div class="donut-wrap" style="width:${size}px;height:${size}px;">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="transform:rotate(-90deg);">${arcs}</svg>
    ${center}
  </div>`;
}

export function onDonutHover(e, id, i) {
  const chart = registry.get(id);
  const seg = chart?.segments[i];
  if (!seg) return;
  const pct = chart.total > 0 ? Math.round((seg.value / chart.total) * 100) : 0;
  showChartTooltip(e.clientX, e.clientY, null, [{ color: seg.color, label: seg.label, value: `${fmtNum(seg.value)} (${pct}%)` }]);
}
