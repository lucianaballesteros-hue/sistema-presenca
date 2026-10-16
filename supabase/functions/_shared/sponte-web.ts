/**
 * Automação da interface web do Sponte.
 *
 * ⚠️ **Isto é uma muleta, não uma integração.** A geração do link de pagamento
 * é a única etapa do fluxo que o WSAPIEdu não expõe (ver `docs/API-SPONTE.md`
 * §9.9): das 138 operações, todas as que tocam fatura são de leitura. Enquanto
 * a Sponte não oferecer um endpoint, resta apertar o botão pela mesma porta
 * que uma pessoa apertaria.
 *
 * O que isso implica, e que precisa ficar visível para quem mantiver o código:
 *
 * - **Nada aqui é contrato.** São páginas ASP.NET WebForms; nomes de controle
 *   e `__VIEWSTATE` mudam quando a Sponte mexer na tela, sem aviso e sem
 *   versionamento. Por isso cada passo confere o que recebeu e falha alto em
 *   vez de seguir no escuro — um link que silenciosamente não é gerado é pior
 *   que um erro, porque o aluno fica esperando e ninguém percebe.
 *
 * - **Roda com credenciais de gente.** Tudo que for feito aqui aparece no
 *   Sponte como feito por esse usuário. Use uma conta de serviço dedicada,
 *   não a conta pessoal de quem administra a escola.
 *
 * - **2FA derruba.** A tela de login tem suporte a dois fatores. Se a escola
 *   ativar, isto para de funcionar no mesmo dia — e é melhor que pare mesmo,
 *   em vez de tentar contornar.
 */

const BASE = "https://www.sponteeducacional.net.br";

export class ErroSponteWeb extends Error {
  // Campo declarado à parte: o Node remove tipos sem transpilar, e
  // propriedade de parâmetro no construtor não passa.
  passo: string | undefined;

  constructor(message: string, passo?: string) {
    super(message);
    this.name = "ErroSponteWeb";
    this.passo = passo;
  }
}

export interface CredenciaisWeb {
  login: string;
  senha: string;
}

/** Lê as credenciais do ambiente, ou `null` se não estiverem completas. */
export function credenciaisWebDoAmbiente(
  env: { get(c: string): string | undefined },
): CredenciaisWeb | null {
  const login = env.get("SPONTE_WEB_LOGIN");
  const senha = env.get("SPONTE_WEB_SENHA");
  return login && senha ? { login, senha } : null;
}

/** Os campos ocultos que o ASP.NET exige de volta em todo postback. */
interface EstadoAsp {
  viewState: string;
  viewStateGenerator: string;
  eventValidation: string;
  viewStateKey: string;
}

const extrair = (html: string, id: string): string =>
  html.match(new RegExp(`<input[^>]*name="${id}"[^>]*value="([^"]*)"`, "i"))?.[1] ??
  html.match(new RegExp(`<input[^>]*value="([^"]*)"[^>]*name="${id}"`, "i"))?.[1] ??
  "";

function lerEstado(html: string): EstadoAsp {
  return {
    viewState: desescapar(extrair(html, "__VIEWSTATE")),
    viewStateGenerator: desescapar(extrair(html, "__VIEWSTATEGENERATOR")),
    eventValidation: desescapar(extrair(html, "__EVENTVALIDATION")),
    viewStateKey: desescapar(extrair(html, "__VIEWSTATE_KEY")),
  };
}

const desescapar = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export class SponteWeb {
  #cred: CredenciaisWeb;
  /** Cookies de sessão, acumulados entre as requisições. */
  #cookies = new Map<string, string>();
  #logado = false;
  /** Fim da última operação enfileirada. Ver `emFila`. */
  #fila: Promise<unknown> = Promise.resolve();

  constructor(cred: CredenciaisWeb) {
    this.#cred = cred;
  }

  /**
   * Roda a operação sozinha, esperando as anteriores terminarem.
   *
   * **A sessão do Sponte é uma só.** Gerar um link não é uma requisição: é
   * filtrar a grade e depois postar nela, e o segundo passo depende do estado
   * que o primeiro deixou no servidor — `__EVENTVALIDATION` e a lista de
   * linhas vivem na sessão, não no nosso lado.
   *
   * Dois alunos terminando o cadastro no mesmo minuto bastariam para
   * intercalar essas sequências: o filtro de um sobrescreve o do outro e o
   * postback chega com um token que já não corresponde. Na melhor hipótese
   * falha; na pior, gera o link da parcela errada.
   *
   * Não é um semáforo de verdade (não há timeout nem reentrância) porque não
   * precisa ser: só existe um recurso, e o processo é um só. Se um dia houver
   * mais de uma instância do servidor, isto aqui não basta — aí a trava tem de
   * sair do processo.
   */
  async emFila<T>(fn: () => Promise<T>): Promise<T> {
    const minhaVez = this.#fila.then(fn, fn);
    // A fila continua mesmo se esta operação falhar: um erro não pode
    // travar quem vem depois.
    this.#fila = minhaVez.catch(() => {});
    return minhaVez;
  }

  get autenticado(): boolean {
    return this.#logado;
  }

  #guardarCookies(r: Response): void {
    // `getSetCookie` existe desde o Node 20 e devolve os Set-Cookie separados;
    // juntá-los num header só perderia os que têm vírgula na data.
    for (const linha of r.headers.getSetCookie?.() ?? []) {
      const [par] = linha.split(";");
      const i = par.indexOf("=");
      if (i > 0) this.#cookies.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
    }
  }

  get #cabecalhoCookie(): string {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async #pedir(caminho: string, init: RequestInit = {}): Promise<{ html: string; url: string }> {
    const r = await fetch(caminho.startsWith("http") ? caminho : `${BASE}/${caminho}`, {
      ...init,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept-Language": "pt-BR,pt;q=0.9",
        ...(this.#cookies.size ? { Cookie: this.#cabecalhoCookie } : {}),
        ...init.headers,
      },
    });
    this.#guardarCookies(r);
    return { html: await r.text(), url: r.url };
  }

  /* ---------------------------------------------------------------- *
   * Login
   * ---------------------------------------------------------------- */

  /**
   * Entra no Sponte e guarda a sessão.
   *
   * Sucesso é reconhecido por **sair** da página de login, não por um texto
   * específico: a mensagem de boas-vindas muda, a ausência do formulário não.
   */
  async entrar(): Promise<void> {
    const { html } = await this.#pedir("default.aspx");
    const estado = lerEstado(html);

    // ⚠️ Nesta instalação `__VIEWSTATE` e `__VIEWSTATE_KEY` vêm **vazios** — o
    // estado fica na sessão do servidor. Quem precisa voltar íntegro é o
    // `__EVENTVALIDATION`; exigir viewstate aqui recusaria um login válido.
    if (!estado.eventValidation) {
      throw new ErroSponteWeb(
        "a página de login não trouxe __EVENTVALIDATION — o formulário mudou",
        "login",
      );
    }

    if (/twofa-digit/.test(html) && /hdnfldi2fa"[^>]*value="(1|true)"/i.test(html)) {
      throw new ErroSponteWeb(
        "a conta exige autenticação em dois fatores — a automação não tem como passar por ela",
        "login",
      );
    }

    const corpo = new URLSearchParams({
      __VIEWSTATE: estado.viewState,
      __VIEWSTATEGENERATOR: estado.viewStateGenerator,
      __EVENTVALIDATION: estado.eventValidation,
      __VIEWSTATE_KEY: estado.viewStateKey,
      __EVENTTARGET: "",
      __EVENTARGUMENT: "",
      txtLogin: this.#cred.login,
      txtSenha: this.#cred.senha,
      hdnenc: "",
    });

    // O botão é um `<input type="submit">` de verdade (não um LinkButton),
    // então vai como campo comum, com o rótulo que a própria página traz.
    const botao = html.match(/<input[^>]*type="submit"[^>]*>/i)?.[0] ?? "";
    const nome = botao.match(/name="([^"]+)"/)?.[1];
    const valor = botao.match(/value="([^"]*)"/)?.[1] ?? "Acessar";
    if (!nome) {
      throw new ErroSponteWeb("não achei o botão de entrar na página de login", "login");
    }
    corpo.set(nome, valor);

    const r = await this.#pedir("default.aspx", {
      method: "POST",
      body: corpo,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${BASE}/default.aspx`,
      },
    });

    const aindaNoLogin = /name="txtSenha"/i.test(r.html);
    if (aindaNoLogin) {
      const aviso = r.html.match(/(?:lblMensagem|lblErro)[^>]*>([^<]{3,160})</i)?.[1]?.trim();
      throw new ErroSponteWeb(
        `o Sponte recusou o login${aviso ? `: ${aviso}` : " (confira SPONTE_WEB_LOGIN e SPONTE_WEB_SENHA)"}`,
        "login",
      );
    }

    this.#logado = true;
  }

  /** Busca uma página já autenticado, entrando antes se preciso. */
  async pagina(caminho: string): Promise<{ html: string; url: string }> {
    if (!this.#logado) await this.entrar();
    const r = await this.#pedir(caminho);

    // Sessão expirada devolve a tela de login no lugar do conteúdo.
    if (/name="txtSenha"/i.test(r.html)) {
      this.#logado = false;
      await this.entrar();
      return this.#pedir(caminho);
    }
    return r;
  }

  /**
   * Todos os campos do formulário, com os valores que estão na página.
   *
   * O WebForms espera o formulário **inteiro** de volta a cada postback: o
   * que não voltar, ele considera apagado. Mandar só os campos que mudaram
   * limpa filtros e seleções sem erro nenhum — some em silêncio.
   */
  static camposDoFormulario(html: string): URLSearchParams {
    const campos = new URLSearchParams();

    for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
      const tag = m[0];
      const nome = tag.match(/name="([^"]+)"/)?.[1];
      if (!nome) continue;

      const tipo = (tag.match(/type="([^"]+)"/)?.[1] ?? "text").toLowerCase();
      // Botão só entra quando é ele que está sendo clicado, e aí quem põe é
      // o chamador; marcável só entra quando marcado — é assim que o
      // navegador faz, e o servidor conta com isso.
      if (tipo === "submit" || tipo === "button" || tipo === "image") continue;
      if ((tipo === "checkbox" || tipo === "radio") && !/\bchecked\b/i.test(tag)) continue;

      campos.set(nome, desescapar(tag.match(/value="([^"]*)"/)?.[1] ?? ""));
    }

    for (const m of html.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)) {
      const sel = m[2].match(/<option[^>]*\bselected\b[^>]*value="([^"]*)"/i)
        ?? m[2].match(/<option[^>]*value="([^"]*)"[^>]*\bselected\b/i);
      // Sem nenhuma marcada, o navegador manda a primeira.
      const primeira = m[2].match(/<option[^>]*value="([^"]*)"/i);
      campos.set(m[1], desescapar(sel?.[1] ?? primeira?.[1] ?? ""));
    }

    for (const m of html.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/gi)) {
      campos.set(m[1], desescapar(m[2]));
    }

    return campos;
  }

  /** Dispara um `__doPostBack` numa página já carregada. */
  async postBack(
    caminho: string, html: string, alvo: string,
    argumento = "", extras: Record<string, string> = {},
  ): Promise<{ html: string; url: string }> {
    const estado = lerEstado(html);
    const corpo = SponteWeb.camposDoFormulario(html);

    corpo.set("__EVENTTARGET", alvo);
    corpo.set("__EVENTARGUMENT", argumento);
    corpo.set("__VIEWSTATE", estado.viewState);
    corpo.set("__VIEWSTATEGENERATOR", estado.viewStateGenerator);
    corpo.set("__EVENTVALIDATION", estado.eventValidation);
    corpo.set("__VIEWSTATE_KEY", estado.viewStateKey);
    for (const [k, v] of Object.entries(extras)) corpo.set(k, v);

    return this.#pedir(caminho, {
      method: "POST",
      body: corpo,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${BASE}/${caminho}`,
      },
    });
  }
}

/* ------------------------------------------------------------------ *
 * Geração do link de pagamento
 * ------------------------------------------------------------------ */

const PAGINA_FATURAS = "SpFin/FaturasSpontePay.aspx";
const ABA = "ctl00$ContentPlaceHolder1$tab$tabGeracao";

/**
 * Uma linha da grade de faturas.
 *
 * Os valores saem do atributo `keys` do `<tr>`, separados por `|`. É de lá que
 * o próprio JavaScript da página lê — e por isso é a fonte confiável, não o
 * texto das células, que muda com formatação e idioma.
 *
 * A ordem foi lida da página em 09/10/2026:
 *
 *     0 nº do link   1 ContaReceberID   2 NumeroParcela   3 e-mail
 *     4 CPF          5 nascimento       6 país            7 SacadoID
 *     8 tipo         9 já gerado (0/1)  10 URL            11 nome do sacado
 */
/**
 * Situação da linha, no índice 9 da chave.
 *
 * Levantado da grade comparando com a coluna "Situação": 0 = Não Gerado,
 * 1 = Link Gerado, 3 = **Erro ao gerar Link**. O 2 não apareceu até agora.
 *
 * O 3 é o que mais importa e foi o que me enganou: a linha ganha número de
 * link, mas sem URL. Tratar "não é 1" como "ainda não geraram" fazia o
 * sistema relatar que a tela tinha mudado, quando na verdade o Sponte Pay
 * tinha recusado o pedido.
 */
export const SITUACAO_LINHA = { NAO_GERADO: "0", GERADO: "1", ERRO: "3" } as const;

export interface LinhaFatura {
  numeroLink: string;
  contaReceberId: string;
  numeroParcela: string;
  email: string;
  cpf: string;
  jaGerado: boolean;
  /** O Sponte Pay recusou a geração para esta linha. */
  erroAoGerar: boolean;
  url: string;
  sacado: string;
  /** A chave crua, do jeito que a página precisa de volta. */
  chave: string[];
}

function lerLinhas(html: string): LinhaFatura[] {
  return [...html.matchAll(/<tr[^>]*\bkeys="([^"]*)"[^>]*>/g)].map((m) => {
    const p = desescapar(m[1]).split("|");
    return {
      numeroLink: p[0] ?? "", contaReceberId: p[1] ?? "", numeroParcela: p[2] ?? "",
      email: p[3] ?? "", cpf: p[4] ?? "",
      jaGerado: p[9] === SITUACAO_LINHA.GERADO,
      erroAoGerar: p[9] === SITUACAO_LINHA.ERRO,
      url: p[10] ?? "", sacado: p[11] ?? "",
      chave: p,
    };
  });
}

export interface ResultadoGeracao {
  ok: boolean;
  url: string | null;
  numeroLink: string | null;
  /** `true` quando o link já existia e nada foi gerado. */
  jaExistia: boolean;
  motivo?: string;
}

/**
 * Gera o link de pagamento de uma parcela.
 *
 * `vencimento` em dd/mm/aaaa é obrigatório porque a grade é paginada — 20
 * linhas por vez, 245 no dia em que isto foi escrito. Sem estreitar por data,
 * a parcela procurada simplesmente não estaria na página.
 *
 * A seleção **não** vai pelos checkboxes: o servidor lê o campo oculto
 * `hdnRowIndex`, que o JavaScript da página preenche com as chaves das linhas
 * marcadas — cada chave com as partes unidas por `¦` e as linhas por `;`.
 * Marcar o checkbox e não preencher esse campo faz o postback passar sem
 * efeito e sem erro, que foi exatamente o que aconteceu na primeira tentativa.
 */
export function gerarLinkPagamento(
  web: SponteWeb,
  alvo: { contaReceberId: number; numeroParcela: string | number; vencimento: string },
): Promise<ResultadoGeracao> {
  // Filtrar e gerar são um par indivisível: entram na fila juntos.
  return web.emFila(async () => {
  const filtro = {
    [`${ABA}$wcdVencimentoInicial$txtData`]: alvo.vencimento,
    [`${ABA}$wcdVencimentoFinal$txtData`]: alvo.vencimento,
  };

  const inicial = await web.pagina(PAGINA_FATURAS);
  const filtrada = await web.postBack(PAGINA_FATURAS, inicial.html, `${ABA}$lnkFiltrar`, "", filtro);

  const conta = String(alvo.contaReceberId);
  const parcela = String(alvo.numeroParcela);
  const linha = lerLinhas(filtrada.html)
    .find((l) => l.contaReceberId === conta && l.numeroParcela === parcela);

  if (!linha) {
    return {
      ok: false, url: null, numeroLink: null, jaExistia: false,
      motivo: `a parcela ${parcela} da conta ${conta} não aparece entre as que ` +
              `vencem em ${alvo.vencimento} — confira a data`,
    };
  }

  // Já gerado: devolve o que existe. Gerar de novo criaria uma segunda
  // cobrança para a mesma parcela.
  if (linha.jaGerado && linha.url) {
    return { ok: true, url: linha.url, numeroLink: linha.numeroLink, jaExistia: true };
  }

  // Sem e-mail o Sponte não tem para onde enviar, e a própria tela recusa
  // antes de postar. Melhor dizer isso do que deixar o postback passar em
  // branco.
  if (!linha.email.trim()) {
    return {
      ok: false, url: null, numeroLink: null, jaExistia: false,
      motivo: `o sacado "${linha.sacado}" está sem e-mail no Sponte`,
    };
  }

  const hdnRowIndex = linha.chave.join("¦");
  const r = await web.postBack(PAGINA_FATURAS, filtrada.html, `${ABA}$lnkGerarFatura`, "", {
    ...filtro,
    // O `name` é o longo; o `id` que o JavaScript usa é só "hdnRowIndex".
    // Mandar os dois evita depender de qual deles o servidor lê.
    [`${ABA}$hdnRowIndex`]: hdnRowIndex,
    hdnRowIndex,
  });

  const depois = lerLinhas(r.html)
    .find((l) => l.contaReceberId === conta && l.numeroParcela === parcela);

  // O Sponte Pay recusou. Acontece com dado que ele não aceita — nome com
  // caractere estranho é o caso conhecido. A linha fica com número de link e
  // sem URL, então é preciso olhar a situação, não só a ausência de URL.
  if (depois?.erroAoGerar) {
    return {
      ok: false, url: null, numeroLink: depois.numeroLink, jaExistia: false,
      motivo: `o Sponte Pay recusou gerar o link para "${depois.sacado.slice(0, 60)}" ` +
              `("Erro ao gerar Link" na tela) — costuma ser caractere inválido ` +
              `no nome ou no cadastro do sacado`,
    };
  }

  if (!depois?.jaGerado || !depois.url) {
    return {
      ok: false, url: null, numeroLink: null, jaExistia: false,
      motivo: "o Sponte aceitou o pedido mas a linha continua sem link — " +
              "a tela pode ter mudado; confira em Financeiro → Geração de Link",
    };
  }

  return { ok: true, url: depois.url, numeroLink: depois.numeroLink, jaExistia: false };
  });
}

/**
 * Cancela o link de pagamento de uma parcela.
 *
 * Necessário quando o valor da cobrança muda depois de o link existir: a
 * fatura congela o valor do momento em que foi gerada. Verificado em
 * 09/10/2026 — a parcela passou de R$ 637,56 para R$ 3.825,36 e a página de
 * pagamento continuou cobrando R$ 637,56, com o valor novo aparecendo só na
 * descrição. Quem olhasse rápido pagaria menos de um sexto do curso.
 */
export function cancelarLinkPagamento(
  web: SponteWeb,
  alvo: { contaReceberId: number; numeroParcela: string | number; vencimento: string },
): Promise<{ ok: boolean; motivo?: string }> {
  return web.emFila(async () => {
  const filtro = {
    [`${ABA}$wcdVencimentoInicial$txtData`]: alvo.vencimento,
    [`${ABA}$wcdVencimentoFinal$txtData`]: alvo.vencimento,
  };

  const inicial = await web.pagina(PAGINA_FATURAS);
  const filtrada = await web.postBack(PAGINA_FATURAS, inicial.html, `${ABA}$lnkFiltrar`, "", filtro);

  const conta = String(alvo.contaReceberId);
  const parcela = String(alvo.numeroParcela);
  const linha = lerLinhas(filtrada.html)
    .find((l) => l.contaReceberId === conta && l.numeroParcela === parcela);

  if (!linha) return { ok: false, motivo: "parcela não encontrada na grade" };
  if (!linha.jaGerado) return { ok: true };   // nada a cancelar

  const hdnRowIndex = linha.chave.join("¦");
  const r = await web.postBack(PAGINA_FATURAS, filtrada.html, `${ABA}$lnkCancelarFatura`, "", {
    ...filtro,
    [`${ABA}$hdnRowIndex`]: hdnRowIndex,
    hdnRowIndex,
  });

  const depois = lerLinhas(r.html)
    .find((l) => l.contaReceberId === conta && l.numeroParcela === parcela);

  return depois?.jaGerado
    ? { ok: false, motivo: "o Sponte não cancelou o link" }
    : { ok: true };
  });
}

/* ------------------------------------------------------------------ *
 * Exploração
 *
 * Os nomes dos controles da tela de Geração de Link não dá para adivinhar:
 * só aparecem depois de autenticar. Este modo entra, baixa a página e lista
 * o que encontrou, para o próximo passo ser escrito em cima do que existe e
 * não de suposição.
 *
 *     node --env-file=.env supabase/functions/_shared/sponte-web.ts
 * ------------------------------------------------------------------ */

if (import.meta.filename === process.argv[1]) {
  const cred = credenciaisWebDoAmbiente({ get: (c) => process.env[c] });
  if (!cred) {
    console.error(`
  Faltam as credenciais. No .env:

    SPONTE_WEB_LOGIN=usuario
    SPONTE_WEB_SENHA=senha

  Use uma conta de serviço, não a conta pessoal: tudo que a automação fizer
  fica registrado no Sponte como feito por esse usuário.
`);
    process.exit(1);
  }

  const web = new SponteWeb(cred);
  console.log(`\n  entrando como ${cred.login}…`);
  await web.entrar();
  console.log("  ✔ autenticado\n");

  for (const caminho of ["SPPed/SpontePay.aspx", "SPPed/Contratos.aspx"]) {
    try {
      const { html, url } = await web.pagina(caminho);
      console.log(`### ${caminho}  →  ${url}  (${html.length} bytes)`);
      console.log(`   título: ${html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim()}`);

      const alvos = [...new Set(
        [...html.matchAll(/__doPostBack\('([^']+)'/g)].map((m) => m[1]),
      )];
      console.log(`   postbacks (${alvos.length}):`);
      alvos.slice(0, 25).forEach((a) => console.log(`      ${a}`));

      const campos = [...new Set(
        [...html.matchAll(/<(?:input|select)[^>]*name="([^"]+)"/g)].map((m) => m[1]),
      )].filter((n) => !n.startsWith("__"));
      console.log(`   campos (${campos.length}):`);
      campos.slice(0, 25).forEach((c) => console.log(`      ${c}`));
      console.log();
    } catch (e) {
      console.log(`### ${caminho}: ✖ ${(e as Error).message}\n`);
    }
  }
}
