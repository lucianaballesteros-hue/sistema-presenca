// Um <select> nativo não pode ter sua lista aberta estilizada (o navegador
// desenha esse popup com o próprio chrome do SO, ignorando o CSS do site) —
// por isso os selects usados como filtro ficavam com a lista deslocada do
// visual "liquid glass" do resto do sistema. Este módulo troca só a
// APRESENTAÇÃO por um botão + painel no mesmo estilo do multi-select já
// usado nos filtros de Relatórios, mantendo o <select> real (escondido) como
// única fonte da verdade: nada que leia/escreva `.value` ou escute 'change'
// nesses elementos precisa mudar.
import { escapeHtml } from './dom.js';

export function enhanceSelect(select) {
  if (!select || select.dataset.enhanced) return;
  select.dataset.enhanced = '1';

  const wrap = document.createElement('div');
  wrap.className = 'multi-select-wrap';
  select.parentNode.insertBefore(wrap, select);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'multi-select-btn';
  btn.innerHTML = `<span class="cs-label"></span><span class="hint-text">▾</span>`;

  const panel = document.createElement('div');
  panel.className = 'multi-select-panel';

  wrap.append(btn, panel, select);
  Object.assign(select.style, { display: 'none' });

  function refresh() {
    const opts = [...select.options];
    const atual = opts.find(o => o.value === select.value) || opts[0];
    btn.querySelector('.cs-label').textContent = atual ? atual.textContent : '';
    panel.innerHTML = opts.map(o =>
      `<div class="multi-check cs-option${o.value === select.value ? ' cs-selected' : ''}" data-value="${escapeHtml(o.value)}">${escapeHtml(o.textContent)}</div>`
    ).join('');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.multi-select-panel.open').forEach(p => { if (p !== panel) p.classList.remove('open'); });
    panel.classList.toggle('open');
  });

  panel.addEventListener('click', (e) => {
    const opt = e.target.closest('.cs-option');
    if (!opt) return;
    select.value = opt.dataset.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    panel.classList.remove('open');
  });

  // Outro código do app às vezes define select.value direto (ex.: ao navegar
  // do dashboard pra Alunos já filtrado). Sobrescrever o acessor faz o botão
  // acompanhar essa mudança sem precisar tocar em nenhum desses lugares.
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    get() { return nativeValue.get.call(select); },
    set(v) { nativeValue.set.call(select, v); refresh(); },
    configurable: true,
  });

  // E o <select> às vezes tem suas <option> inteiras recriadas via innerHTML
  // (turmas/cursos carregados depois do login) — reflete isso no painel.
  new MutationObserver(refresh).observe(select, { childList: true });

  refresh();
}
