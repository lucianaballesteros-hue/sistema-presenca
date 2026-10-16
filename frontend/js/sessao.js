/**
 * Login do painel.
 *
 * Reaproveita o Supabase Auth que o sistema de presença já usa — mesmos
 * usuários, mesma senha. Quem não for `admin` na tabela `professores` é
 * recusado pelo servidor, não por aqui: esconder o botão não protege nada,
 * e a decisão precisa estar do lado que guarda os dados.
 *
 * Como usar na página:
 *
 *     <script src="frontend/js/sessao.js"></script>
 *     await Sessao.exigirAdmin();      // mostra o login e só volta logado
 *     fetch('/api/…', { headers: Sessao.cabecalho() })
 */
(function () {
  const CHAVE = 'cadastro-online:sessao';

  let cfg = null;      // { url, publishableKey } — vem do servidor
  let sessao = null;   // { access_token, refresh_token, expires_at, usuario }

  /* ---------------------------------------------------------------- *
   * Armazenamento — a MESMA sessão do sistema de presença
   *
   * O sistema usa o SDK do Supabase, que guarda a sessão em
   * `sb-<ref>-auth-token`. Antes eu mantinha uma chave própria aqui, e o
   * resultado era pedir login de novo a quem tinha acabado de entrar: dois
   * cofres para a mesma credencial.
   *
   * Lendo e escrevendo na chave do SDK, o login vale nos dois sentidos —
   * entrar por aqui também entra lá, e sair de um sai dos dois.
   * ---------------------------------------------------------------- */

  /** A chave do SDK. Procurada no armazenamento para não fixar o projeto. */
  function chaveSupabase() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && /^sb-.+-auth-token$/.test(k)) return k;
      }
    } catch { /* sem localStorage: cai no derivado abaixo */ }

    // Nada guardado ainda (primeiro acesso): deriva da URL do projeto, que é
    // como o próprio SDK monta a chave.
    const ref = (cfg?.url || '').replace(/^https?:\/\//, '').split('.')[0];
    return ref ? `sb-${ref}-auth-token` : null;
  }

  function carregar() {
    for (const k of [chaveSupabase(), CHAVE]) {
      if (!k) continue;
      try {
        const bruto = localStorage.getItem(k);
        if (!bruto) continue;
        const s = JSON.parse(bruto);
        if (s?.access_token) return s;
      } catch { /* conteúdo estranho: tenta o próximo */ }
    }
    return null;
  }

  function guardar(s) {
    sessao = s;
    const k = chaveSupabase();
    try {
      if (s) { if (k) localStorage.setItem(k, JSON.stringify(s)); }
      else {
        if (k) localStorage.removeItem(k);
        localStorage.removeItem(CHAVE);   // resquício da versão anterior
      }
    } catch { /* modo anônimo: a sessão vale só enquanto a aba viver */ }
  }

  /**
   * Renova o token com o `refresh_token`, quando o de acesso venceu.
   *
   * Sem isto, o painel pediria login a cada hora mesmo com o sistema aberto
   * ao lado — o SDK renova sozinho lá, e aqui a sessão parecia ter morrido.
   */
  async function renovar(s) {
    if (!s?.refresh_token) return null;
    const c = await configuracao();
    try {
      const r = await fetch(`${c.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: c.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: s.refresh_token }),
      });
      if (!r.ok) return null;
      const novo = await r.json();
      if (!novo?.access_token) return null;
      guardar(novo);
      return novo;
    } catch { return null; }
  }

  /* ---------------------------------------------------------------- *
   * Tela
   * ---------------------------------------------------------------- */

  function tela() {
    const d = document.createElement('div');
    d.id = 'sessao-bg';
    d.innerHTML = `
      <style>
        #sessao-bg{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;
          justify-content:center;padding:20px;background:var(--bg,#0e1525);}
        #sessao-cartao{width:100%;max-width:360px;border:1px solid var(--borda,#2a3654);
          border-radius:16px;padding:26px;background:var(--surface,#161f33);}
        #sessao-cartao h1{font-size:18px;margin:0 0 4px;}
        #sessao-cartao p{font-size:13px;color:var(--text-muted,#8b96ad);margin:0 0 18px;}
        #sessao-cartao label{display:block;font-size:12px;font-weight:600;margin:12px 0 5px;}
        #sessao-cartao input{width:100%;padding:10px 12px;border-radius:10px;font-size:14px;
          border:1px solid var(--borda,#2a3654);background:transparent;color:inherit;
          font-family:inherit;outline:none;box-sizing:border-box;}
        #sessao-cartao input:focus{border-color:var(--primary,#3b82f6);}
        #sessao-entrar{width:100%;margin-top:18px;padding:11px;border:0;border-radius:10px;
          background:var(--primary,#3b82f6);color:#fff;font-size:14px;font-weight:600;
          font-family:inherit;cursor:pointer;}
        #sessao-entrar:disabled{opacity:.6;cursor:default;}
        #sessao-erro{display:none;margin-top:12px;font-size:12.5px;line-height:1.5;
          color:#fca5a5;background:rgba(220,38,38,.12);border:1px solid rgba(220,38,38,.35);
          border-radius:9px;padding:9px 11px;}
      </style>
      <form id="sessao-cartao">
        <h1>Cadastro online</h1>
        <p>Área restrita a administradores.</p>
        <label for="sessao-email">E-mail</label>
        <input type="email" id="sessao-email" autocomplete="username" required>
        <label for="sessao-senha">Senha</label>
        <input type="password" id="sessao-senha" autocomplete="current-password" required>
        <button type="submit" id="sessao-entrar">Entrar</button>
        <div id="sessao-erro"></div>
      </form>`;
    document.body.appendChild(d);
    return d;
  }

  async function configuracao() {
    if (cfg) return cfg;
    const r = await fetch('/api/config-auth');
    if (!r.ok) throw new Error('não consegui falar com o servidor');
    cfg = await r.json();
    return cfg;
  }

  async function entrar(email, senha) {
    const c = await configuracao();
    const r = await fetch(`${c.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: c.publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: senha }),
    });
    const d = await r.json();
    if (!r.ok) {
      // A mensagem deles é em inglês e genérica; traduzir ajuda mais que
      // repassar "Invalid login credentials".
      throw new Error(/invalid/i.test(d.error_description || d.msg || '')
        ? 'E-mail ou senha incorretos.'
        : (d.error_description || d.msg || 'Não foi possível entrar.'));
    }

    // A resposta do endpoint de token **é** o formato que o SDK guarda
    // (access_token, refresh_token, expires_at, expires_in, token_type,
    // user). Gravar o objeto inteiro é o que faz o sistema de presença
    // reconhecer esta sessão — um recorte dele não seria restaurado lá.
    guardar({ ...d, usuario: d.user?.email ?? email });

    // O servidor é quem diz se este usuário pode. Sem esta conferência, um
    // professor entraria e só descobriria no primeiro botão que clicasse.
    const eu = await fetch('/api/eu', { headers: cabecalho() });
    if (eu.status === 403) {
      guardar(null);
      const c403 = await eu.json();
      throw new Error(`Seu usuário é "${c403.papel || 'sem papel'}". `
        + 'Esta área é só para administradores.');
    }
    if (!eu.ok) { guardar(null); throw new Error('Não consegui confirmar seu acesso.'); }
    return eu.json();
  }

  function cabecalho(extras) {
    return sessao?.access_token
      ? { ...(extras || {}), Authorization: `Bearer ${sessao.access_token}` }
      : { ...(extras || {}) };
  }

  /**
   * Quem está logado mas não é admin.
   *
   * Pedir a senha de novo seria enganoso: a credencial está certa, o que
   * falta é permissão. A pessoa tentaria outras senhas sem nunca entrar.
   */
  function semPermissao(papel) {
    const d = document.createElement('div');
    d.id = 'sessao-bg';
    d.innerHTML = `
      <style>
        #sessao-bg{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;
          justify-content:center;padding:20px;background:var(--bg,#0e1525);}
        #sessao-cartao{width:100%;max-width:380px;border:1px solid var(--borda,#2a3654);
          border-radius:16px;padding:26px;background:var(--surface,#161f33);text-align:center;}
        #sessao-cartao h1{font-size:18px;margin:0 0 8px;}
        #sessao-cartao p{font-size:13.5px;line-height:1.6;color:var(--text-muted,#8b96ad);margin:0 0 20px;}
        #sessao-cartao a{display:inline-block;padding:10px 18px;border-radius:10px;
          background:var(--primary,#3b82f6);color:#fff;text-decoration:none;
          font-size:14px;font-weight:600;}
      </style>
      <div id="sessao-cartao">
        <h1>Área restrita</h1>
        <p>Seu usuário é <strong>${papel || 'sem papel definido'}</strong>, e o cadastro
        online é só para administradores.<br>Peça a quem administra o sistema.</p>
        <a href="index.html">Voltar ao sistema</a>
      </div>`;
    document.body.appendChild(d);
    // Nunca resolve: a página não deve montar atrás desta tela.
    return new Promise(() => {});
  }

  /** Mostra o login e só devolve quando houver um admin autenticado. */
  async function exigirAdmin() {
    await configuracao();          // precisa da URL para achar a chave do SDK
    sessao = carregar();

    if (sessao) {
      let eu = await fetch('/api/eu', { headers: cabecalho() });

      // 401 pode ser token vencido, não falta de permissão: tenta renovar
      // antes de mandar a pessoa digitar a senha de novo.
      if (eu.status === 401 && await renovar(sessao)) {
        eu = await fetch('/api/eu', { headers: cabecalho() });
      }

      if (eu.ok) return eu.json();

      // 403 é outra conversa: o usuário existe, mas não é admin. Apagar a
      // sessão aqui deslogaria ele do sistema de presença também, onde ele
      // tem acesso legítimo.
      if (eu.status === 403) {
        const d = await eu.json().catch(() => ({}));
        return semPermissao(d.papel);
      }
      guardar(null);
    }

    const fundo = tela();
    const erro = document.getElementById('sessao-erro');
    const botao = document.getElementById('sessao-entrar');
    document.getElementById('sessao-email').focus();

    // A mensagem fala da tentativa anterior: some assim que a pessoa mexe
    // em algo. Mantê-la faz parecer que o valor novo também está errado,
    // antes mesmo de ter sido enviado.
    for (const id of ['sessao-email', 'sessao-senha']) {
      document.getElementById(id).addEventListener('input', () => {
        erro.style.display = 'none';
      });
    }

    return new Promise((resolve) => {
      document.getElementById('sessao-cartao').addEventListener('submit', async (e) => {
        e.preventDefault();
        erro.style.display = 'none';
        botao.disabled = true;
        botao.textContent = 'Entrando…';
        try {
          const quem = await entrar(
            document.getElementById('sessao-email').value.trim(),
            document.getElementById('sessao-senha').value);
          fundo.remove();
          resolve(quem);
        } catch (e2) {
          erro.textContent = e2.message;
          erro.style.display = 'block';
          botao.disabled = false;
          botao.textContent = 'Entrar';
        }
      });
    });
  }

  function sair() {
    guardar(null);
    location.reload();
  }

  window.Sessao = { exigirAdmin, cabecalho, sair, get usuario() { return sessao?.usuario ?? null; } };
})();
