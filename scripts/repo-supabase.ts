/**
 * Persistência no Supabase.
 *
 * Substitui o repositório em arquivo que o servidor usava até aqui. A
 * interface é a mesma de propósito — nenhuma rota precisou mudar.
 *
 * -------------------------------------------------------------------
 * DUAS FORMAS DE FALAR COM O BANCO, E QUANDO USAR CADA UMA
 * -------------------------------------------------------------------
 * 1. **Funções `security definer`** (`cadastro_publico_*`) — tudo que vem do
 *    aluno. Elas validam o token antes de agir e são as únicas que `anon`
 *    pode chamar; as tabelas em si estão fechadas para ele.
 *
 * 2. **REST com a service role** — tudo que vem do painel interno. Ignora RLS,
 *    então só é usada no servidor, nunca exposta ao navegador.
 *
 * O consumo de uso do link mora na função SQL, não aqui: `UPDATE ... WHERE
 * usos < limite_usos` numa instrução só é o que impede duas abas do mesmo link
 * de passarem juntas. Reproduzir isso em JavaScript reintroduziria a corrida.
 */

import {
  corDaSituacao, PENDENTES, resumoCurto, situacaoFinanceira,
  type SituacaoFinanceira,
} from "../supabase/functions/_shared/financeiro.ts";

export interface ConfigSupabase {
  url: string;
  serviceKey: string;
}

/* ------------------------------------------------------------------ *
 * Ordenação e filtro financeiro da lista
 * ------------------------------------------------------------------ */

export type OrdemCadastros =
  | "recentes" | "antigos" | "nome" | "nome_desc" | "vencimento";

/**
 * As ordenações oferecidas, já no formato do PostgREST.
 *
 * Mapa fechado, e não o valor da tela concatenado na URL: `order=` aceita
 * qualquer coluna, e deixar o navegador escolher seria deixá-lo ordenar por
 * `cpf` ou por uma coluna que não deve nem aparecer.
 */
const ORDENS: Record<OrdemCadastros, string> = {
  recentes: "criado_em.desc",
  antigos: "criado_em.asc",
  nome: "nome.asc",
  nome_desc: "nome.desc",
  // Quem vence primeiro vem primeiro; sem data vai para o fim, porque não é
  // resposta para "quem eu cobro agora".
  vencimento: "pagamento_vencimento.asc.nullslast",
};

/**
 * As situações cujo cálculo depende da data de hoje.
 *
 * Só estas precisam do refino em memória; as outras são igualdade de coluna
 * e o banco resolve sozinho.
 */
const DEPENDEM_DA_DATA = new Set(["vencido", "a_vencer", "sem_link", "pendentes"]);

/**
 * As situações que a tela pode filtrar — as mesmas do `check` da tabela.
 *
 * Fechado de propósito: o valor vem da query string e é concatenado na
 * consulta. Fora desta lista, o filtro é ignorado em vez de ir para a URL.
 */
const STATUS_VALIDOS = new Set([
  "rascunho", "pendente", "aprovado", "rejeitado", "enviando", "enviado",
  "erro", "importado",
]);

function precisaRefinar(financeiro?: string | null): boolean {
  return !!financeiro && DEPENDEM_DA_DATA.has(financeiro);
}

/** O recorte que o banco faz antes de `situacaoFinanceira` decidir. */
function filtroFinanceiroSql(financeiro?: string | null): string {
  switch (financeiro) {
    case "pago": return "&pagamento_status=eq.pago";
    case "cancelado": return "&pagamento_status=eq.cancelado";
    case "falhou": return "&pagamento_status=eq.falhou";
    case "sem_cobranca": return "&pagamento_status=eq.nao_aplicavel";

    // Tudo que ainda não foi pago. Qual destes três é cada um, quem diz é
    // `situacaoFinanceira` — aqui só se corta o que não pode ser nenhum.
    case "vencido":
    case "a_vencer":
    case "sem_link":
      return "&pagamento_status=in.(aguardando,link_gerado)";

    // "Precisa de alguém": inclui `falhou`, que não depende de data.
    case "pendentes":
      return "&pagamento_status=in.(aguardando,link_gerado,falhou)";

    default: return "";
  }
}

function casaFinanceiro(situacao: SituacaoFinanceira, filtro: string): boolean {
  return filtro === "pendentes" ? PENDENTES.includes(situacao) : situacao === filtro;
}

/** A situação financeira pronta para a tela: estado, texto curto e cor. */
function derivarFinanceiro(c: any) {
  const e = situacaoFinanceira({
    pagamentoStatus: c.pagamento_status,
    pagamentoVencimento: c.pagamento_vencimento,
  });
  return {
    situacao: e.situacao,
    rotulo: e.rotulo,
    resumo: resumoCurto(e),
    cor: corDaSituacao(e.situacao),
    diasAtraso: e.diasAtraso,
    diasAteVencer: e.diasAteVencer,
    vencimento: e.vencimento,
    pendente: e.pendente,
  };
}

export class RepoSupabase {
  #url: string;
  #key: string;

  constructor(cfg: ConfigSupabase) {
    this.#url = cfg.url.replace(/\/$/, "");
    this.#key = cfg.serviceKey;
  }

  /* ---------------------------------------------------------------- *
   * Transporte
   * ---------------------------------------------------------------- */

  async #rest<T = unknown>(
    caminho: string,
    init: RequestInit & { prefer?: string } = {},
  ): Promise<T> {
    const { prefer, ...resto } = init;
    const r = await fetch(`${this.#url}/rest/v1/${caminho}`, {
      ...resto,
      headers: {
        apikey: this.#key,
        Authorization: `Bearer ${this.#key}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
        ...resto.headers,
      },
    });

    const texto = await r.text();
    if (!r.ok) {
      // A mensagem do PostgREST é específica (viola constraint, coluna
      // inexistente); repassá-la inteira poupa adivinhação no diagnóstico.
      throw new Error(`Supabase ${caminho} HTTP ${r.status}: ${texto.slice(0, 400)}`);
    }
    return texto ? JSON.parse(texto) as T : (null as T);
  }

  /** Chama uma função `security definer` como o público a chamaria. */
  async #rpc<T = unknown>(nome: string, args: Record<string, unknown>): Promise<T> {
    return this.#rest<T>(`rpc/${nome}`, { method: "POST", body: JSON.stringify(args) });
  }

  /* ---------------------------------------------------------------- *
   * Links
   * ---------------------------------------------------------------- */

  async criarLink(e: {
    turmaId: number; cursoId: number; turmaNome: string; cursoNome: string;
    turmaTurno: string; limiteUsos: number; diasValidade: number;
    condicao: Record<string, unknown>;
  }) {
    const [link] = await this.#rest<any[]>("links_cadastro", {
      method: "POST",
      prefer: "return=representation",
      body: JSON.stringify({
        turma_id: e.turmaId, curso_id: e.cursoId,
        turma_nome: e.turmaNome, curso_nome: e.cursoNome, turma_turno: e.turmaTurno,
        limite_usos: e.limiteUsos,
        expira_em: e.diasValidade > 0
          ? new Date(Date.now() + e.diasValidade * 86400_000).toISOString()
          : null,
        plano_curso_id: e.condicao.planoCursoId ?? null,
        plano_descricao: e.condicao.planoDescricao ?? null,
        bolsa_id: e.condicao.bolsaId ?? null,
        bolsa_descricao: e.condicao.bolsaDescricao ?? null,
        valor_parcela: e.condicao.valorParcela ?? null,
        parcelas: e.condicao.parcelas ?? null,
        valor_total: e.condicao.valorTotal ?? null,
        valor_parcela_cheia: e.condicao.valorParcelaCheia ?? null,
      }),
    });
    return paraLink(link);
  }

  async listarLinks() {
    const linhas = await this.#rest<any[]>(
      "links_cadastro?select=*,alunos_staging(count)&order=criado_em.desc");
    return linhas.map((l) => ({
      ...paraLink(l),
      cadastros: l.alunos_staging?.[0]?.count ?? 0,
    }));
  }

  async revogarLink(id: number) {
    const r = await this.#rest<any[]>(
      `links_cadastro?id=eq.${id}&revogado_em=is.null`,
      { method: "PATCH", prefer: "return=representation",
        body: JSON.stringify({ revogado_em: new Date().toISOString() }) });
    return r.length > 0;
  }

  /**
   * Tudo que o nosso lado sabe sobre uma turma do Sponte.
   *
   * Junta os links gerados com os cadastros que vieram deles. São duas
   * perguntas que só fazem sentido juntas: um link com 3 usos e nenhum
   * cadastro significa que as pessoas abriram e desistiram — e isso não
   * aparece olhando só a contagem de usos.
   */
  async detalheTurma(sponteTurmaId: number) {
    const [links, cadastros] = await Promise.all([
      this.#rest<any[]>(
        `links_cadastro?turma_id=eq.${sponteTurmaId}&select=*&order=criado_em.desc`),
      this.#rest<any[]>(
        `alunos_staging?sponte_turma_id=eq.${sponteTurmaId}` +
        `&select=id,link_id,nome,cpf,email,celular,status,etapa_atual,pagamento_status,` +
        `pagamento_link,sponte_aluno_id,presenca_aluno_id,league_user_id,parcelas,` +
        `valor_parcela,valor_total,criado_em,origem` +
        `&order=criado_em.desc`),
    ]);

    const porLink = new Map<number, number>();
    for (const c of cadastros ?? []) {
      // Rascunho não conta como resposta: a pessoa abriu e não terminou.
      if (c.status === "rascunho" || !c.link_id) continue;
      porLink.set(c.link_id, (porLink.get(c.link_id) ?? 0) + 1);
    }

    const contar = (p: (c: any) => boolean) => (cadastros ?? []).filter(p).length;

    return {
      links: (links ?? []).map((l) => ({
        ...paraLink(l),
        // Quantos chegaram ao fim por este link, e quantos pararam no meio.
        responderam: porLink.get(l.id) ?? 0,
        rascunhos: (cadastros ?? [])
          .filter((c) => c.link_id === l.id && c.status === "rascunho").length,
      })),
      cadastros: (cadastros ?? []).map(paraCadastro),
      resumo: {
        total: cadastros?.length ?? 0,
        rascunhos: contar((c) => c.status === "rascunho"),
        concluidos: contar((c) => c.status !== "rascunho"),
        noSponte: contar((c) => !!c.sponte_aluno_id),
        noPresenca: contar((c) => !!c.presenca_aluno_id),
        noLeague: contar((c) => !!c.league_user_id),
        comLink: contar((c) => !!c.pagamento_link),
        pagos: contar((c) => c.pagamento_status === "pago"),
      },
    };
  }

  /** Quantos links ativos cada turma tem — evita gerar duplicado sem perceber. */
  async linksPorTurma(): Promise<Record<number, number>> {
    const linhas = await this.#rest<any[]>(
      "links_cadastro?select=turma_id,usos,limite_usos&revogado_em=is.null");
    const mapa: Record<number, number> = {};
    for (const l of linhas) {
      if (l.usos >= l.limite_usos) continue;
      mapa[l.turma_id] = (mapa[l.turma_id] ?? 0) + 1;
    }
    return mapa;
  }

  /* ---------------------------------------------------------------- *
   * Lado público — sempre pelas funções, nunca pelas tabelas
   * ---------------------------------------------------------------- */

  lerLinkPorToken(token: string) {
    return this.#rpc<Record<string, unknown>>("cadastro_publico_get", { p_token: token });
  }

  salvarRascunho(token: string, rascunhoId: number | null, dados: Record<string, unknown>) {
    return this.#rpc<{ ok: boolean; rascunhoId?: number; motivo?: string }>(
      "cadastro_publico_rascunho",
      { p_token: token, p_rascunho_id: rascunhoId, p_dados: dados });
  }

  receberCadastro(
    token: string, rascunhoId: number | null,
    dados: Record<string, unknown>, ip: string | null = null,
  ) {
    return this.#rpc<{
      ok: boolean; duplicado?: boolean; id?: number;
      turmaNome?: string; precisaPagar?: boolean; motivo?: string;
      /**
       * O segredo desta ficha, entregue **uma vez** a este navegador.
       *
       * É o que autoriza o checkout em seguida: o id é sequencial e não
       * prova nada. Só sai daqui — nenhuma outra rota o devolve.
       */
      tokenAcesso?: string;
    }>("cadastro_publico_enviar",
      { p_token: token, p_rascunho_id: rascunhoId, p_dados: dados, p_ip: ip });
  }

  /* ---------------------------------------------------------------- *
   * Fila interna
   * ---------------------------------------------------------------- */

  /**
   * Página da fila, mais recentes primeiro.
   *
   * O limite existe desde que a planilha entrou: sem ele a tela baixa 500
   * cadastros com todas as colunas — perto de 800 KB — a cada abertura. A
   * contagem por situação continua sobre o total, então os números do topo
   * não mentem.
   */
  /**
   * A fila de cadastros, filtrada e ordenada no banco.
   *
   * O filtro financeiro é o único que não vira condição de SQL direta: a
   * regra de "vencido" depende da data de hoje e mora em `financeiro.ts`.
   * Traduzi-la para PostgREST criaria uma segunda cópia da regra, que
   * divergiria da primeira na primeira vez que alguém mexesse numa delas.
   *
   * Em vez disso o banco faz o recorte grosseiro — só os `pagamento_status`
   * que podem resultar naquela situação, que é o que o índice parcial já
   * cobre — e `situacaoFinanceira` decide um a um. São poucas linhas: só
   * quem passou pelo checkout deste sistema tem cobrança.
   */
  async listarCadastros(opcoes: {
    status?: string;
    /** `sponte_turma_id`. */
    turmaId?: number | null;
    /** Uma `SituacaoFinanceira`, ou `"pendentes"` para tudo que pede ação. */
    financeiro?: string | null;
    ordem?: OrdemCadastros;
    busca?: string;
    limite?: number;
  } = {}) {
    const { status, turmaId, financeiro, busca } = opcoes;
    const limite = opcoes.limite ?? 200;

    // Conjunto fechado, e não o texto da tela direto na URL: `status` é
    // interpolado na consulta, e um `&` cru remontaria os parâmetros que
    // o PostgREST recebe — com a chave de serviço, que ignora RLS.
    const situacao = status && status !== "todos" && STATUS_VALIDOS.has(status)
      ? status : null;

    const filtro = (situacao ? `&status=eq.${situacao}` : "")
      + (turmaId ? `&sponte_turma_id=eq.${turmaId}` : "")
      + filtroFinanceiroSql(financeiro);

    // A busca roda no banco, não sobre a página já baixada. Filtrar no
    // navegador só acharia quem estivesse dentro do limite — e quem procura
    // um aluno específico normalmente procura justamente o que não está à
    // vista.
    const termo = (busca ?? "").trim();
    let procura = "";
    if (termo) {
      // Os separadores do PostgREST saem; o resto é codificado. Os dois
      // passos são necessários: `,()*` têm significado na sintaxe do filtro
      // e sobreviveriam à codificação, e `&=` quebrariam a query string.
      // É o que `presenca.ts` e `league.ts` já faziam.
      const escapado = encodeURIComponent(termo.replace(/[,()*]/g, " ").trim());
      const digitos = termo.replace(/\D/g, "");
      const alvos = [
        `nome.ilike.*${escapado}*`,
        `turma_nome.ilike.*${escapado}*`,
        `email.ilike.*${escapado}*`,
        ...(digitos.length >= 3 ? [`cpf.ilike.*${digitos}*`, `celular.ilike.*${digitos}*`] : []),
      ];
      procura = `&or=(${alvos.join(",")})`;
    }

    // Quando o filtro financeiro depende da data, o banco devolve o recorte
    // inteiro: refinar depois sobre uma página de 200 acharia só os vencidos
    // que por acaso estivessem nela.
    const refina = precisaRefinar(financeiro);
    const ordem = ORDENS[opcoes.ordem ?? "recentes"] ?? ORDENS.recentes;
    const teto = refina ? 10_000 : limite;

    const linhas = await this.#rest<any[]>(
      `alunos_staging?select=*${filtro}${procura}&order=${ordem}&limit=${teto}`);

    let cadastros = linhas.map(paraCadastro);
    if (refina) {
      const hoje = new Date();
      cadastros = cadastros
        .filter((c) => casaFinanceiro(situacaoFinanceira(c, hoje).situacao, financeiro!))
        .slice(0, limite);
    }

    /* --- Os números do topo e as opções dos filtros --- *
     *
     * Uma varredura só, de cinco colunas, serve a três coisas: a contagem
     * por situação, a lista de turmas do dropdown e a contagem financeira.
     * Três consultas separadas leriam a mesma tabela três vezes.
     */
    const todos = await this.#rest<Array<{
      status: string;
      turma_nome: string | null;
      sponte_turma_id: number | null;
      pagamento_status: string | null;
      pagamento_vencimento: string | null;
    }>>(
      "alunos_staging?select=status,turma_nome,sponte_turma_id," +
      "pagamento_status,pagamento_vencimento&limit=100000");

    const contagem: Record<string, number> = {
      rascunho: 0, pendente: 0, aprovado: 0, rejeitado: 0, enviado: 0, erro: 0,
      importado: 0,
    };
    const financeiroContagem: Record<string, number> = {};
    const turmas = new Map<number, { id: number; nome: string; total: number }>();
    const hoje = new Date();

    for (const c of todos) {
      contagem[c.status] = (contagem[c.status] ?? 0) + 1;

      const s = situacaoFinanceira({
        pagamentoStatus: c.pagamento_status,
        pagamentoVencimento: c.pagamento_vencimento,
      }, hoje).situacao;
      financeiroContagem[s] = (financeiroContagem[s] ?? 0) + 1;

      // Turma sem id do Sponte não dá para filtrar, então fica fora da
      // lista — aparecer uma opção que não filtra nada é pior que não ter.
      if (c.sponte_turma_id) {
        const t = turmas.get(c.sponte_turma_id)
          ?? { id: c.sponte_turma_id, nome: c.turma_nome ?? `Turma ${c.sponte_turma_id}`, total: 0 };
        t.total++;
        turmas.set(c.sponte_turma_id, t);
      }
    }
    financeiroContagem.pendentes = PENDENTES
      .reduce((n, s) => n + (financeiroContagem[s] ?? 0), 0);

    // `exibidos` x `total`: a tela precisa saber que está vendo um recorte.
    return {
      cadastros, contagem, financeiro: financeiroContagem,
      turmas: [...turmas.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")),
      total: todos.length, exibidos: cadastros.length, limite,
    };
  }

  /**
   * Cria uma ficha a partir do painel, sem link público.
   *
   * É o caminho de quem se matricula presencialmente ou por telefone. Nasce
   * já como `pendente`, não `rascunho`: quem está digitando é alguém da
   * escola com o aluno na frente, não uma pessoa que pode desistir no meio.
   *
   * O preço **não** vem de quem preencheu — o chamador resolve a condição a
   * partir do plano, como na criação do link. Campo de valor editável na tela
   * seria um desconto sem registro.
   */
  async criarCadastroManual(e: {
    nome: string;
    cpf: string;
    dataNascimento: string | null;
    email: string | null;
    celular: string | null;
    cep?: string | null;
    endereco?: string | null;
    numeroEndereco?: string | null;
    complemento?: string | null;
    bairro?: string | null;
    cidade?: string | null;
    uf?: string | null;
    origemVenda?: string | null;
    observacao?: string | null;
    turmaId: number;
    cursoId: number;
    turmaNome: string;
    cursoNome: string;
    condicao: Record<string, unknown>;
    parcelas: number;
  }) {
    const [linha] = await this.#rest<any[]>("alunos_staging", {
      method: "POST",
      prefer: "return=representation",
      body: JSON.stringify({
        origem: "manual",
        status: "pendente",
        nome: e.nome.trim(),
        cpf: e.cpf.replace(/\D/g, ""),
        data_nascimento: e.dataNascimento,
        email: e.email?.trim().toLowerCase() || null,
        celular: e.celular?.replace(/\D/g, "") || null,
        cep: e.cep?.replace(/\D/g, "") || null,
        endereco: e.endereco?.trim() || null,
        numero_endereco: e.numeroEndereco?.trim() || null,
        complemento: e.complemento?.trim() || null,
        bairro: e.bairro?.trim() || null,
        cidade: e.cidade?.trim() || null,
        uf: e.uf?.trim().toUpperCase().slice(0, 2) || null,
        origem_venda: e.origemVenda?.trim() || null,
        observacao: e.observacao?.trim() || null,

        sponte_turma_id: e.turmaId,
        sponte_curso_id: e.cursoId,
        turma_nome: e.turmaNome,
        curso_nome: e.cursoNome,

        plano_curso_id: e.condicao.planoCursoId ?? null,
        plano_descricao: e.condicao.planoDescricao ?? null,
        bolsa_id: e.condicao.bolsaId ?? null,
        bolsa_descricao: e.condicao.bolsaDescricao ?? null,
        valor_total: e.condicao.valorTotal ?? null,
        parcelas: e.parcelas,
        valor_parcela: e.condicao.valorTotal
          ? Number((Number(e.condicao.valorTotal) / Math.max(e.parcelas, 1)).toFixed(2))
          : null,

        pagamento_status: "aguardando",
      }),
    });
    return linha ? paraCadastro(linha) : null;
  }

  /** Já existe alguém com este CPF nesta turma? */
  async cpfJaNaTurma(cpf: string, turmaId: number) {
    const linhas = await this.#rest<any[]>(
      `alunos_staging?select=id,nome,status&cpf=eq.${cpf.replace(/\D/g, "")}` +
      `&sponte_turma_id=eq.${turmaId}` +
      `&status=in.(pendente,aprovado,enviando,enviado)&limit=1`);
    return linhas?.[0] ? paraCadastro(linhas[0]) : null;
  }

  async buscarCadastro(id: number) {
    const [linha] = await this.#rest<any[]>(`alunos_staging?id=eq.${id}&select=*&limit=1`);
    return linha ? paraCadastro(linha) : null;
  }

  async atualizarCadastro(id: number, campos: Record<string, unknown>) {
    const [linha] = await this.#rest<any[]>(`alunos_staging?id=eq.${id}`, {
      method: "PATCH", prefer: "return=representation", body: JSON.stringify(campos),
    });
    return linha ? paraCadastro(linha) : null;
  }

  async mudarStatus(id: number, status: string, observacao?: string) {
    const campos: Record<string, unknown> = {
      status,
      validado_em: status === "pendente" ? null : new Date().toISOString(),
    };
    if (observacao !== undefined) campos.observacao = observacao || null;
    const c = await this.atualizarCadastro(id, campos);
    return { ok: !!c, cadastro: c };
  }

  /** Cadastros com cobrança em aberto — a lista que o vigia percorre. */
  async cobrancasEmAberto() {
    const linhas = await this.#rest<any[]>(
      "alunos_staging?select=*" +
      "&sponte_conta_receber_id=not.is.null" +
      "&pagamento_status=neq.pago" +
      "&order=criado_em");
    return linhas.map(paraCadastro);
  }

  /* ---------------------------------------------------------------- *
   * Mapa da turma entre as três plataformas
   *
   * O Sponte identifica a turma por um inteiro, o Presença por outro, e o
   * LeagueInvest por um uuid. `turmas_staging` é onde os três se encontram —
   * descoberto uma vez por casamento de nome, gravado para sempre.
   * ---------------------------------------------------------------- */

  async mapaTurma(sponteTurmaId: number) {
    const [t] = await this.#rest<any[]>(
      `turmas_staging?sponte_turma_id=eq.${sponteTurmaId}` +
      `&select=id,presenca_turma_id,league_class_id&limit=1`);
    return {
      id: t?.id ?? null,
      presencaTurmaId: t?.presenca_turma_id ?? null,
      leagueClassId: t?.league_class_id ?? null,
    };
  }

  /**
   * Grava o que foi descoberto sobre a turma, criando a linha se preciso.
   *
   * `onConflict` em vez de "ler e decidir": duas ativações simultâneas da
   * mesma turma chegariam juntas aqui e uma delas violaria o índice único.
   */
  async gravarMapaTurma(
    sponteTurmaId: number,
    descoberto: { presencaTurmaId?: number | null; leagueClassId?: string | null },
    contexto: { turmaNome: string; cursoNome?: string | null; sponteCursoId?: number | null },
  ) {
    const campos: Record<string, unknown> = {};
    if (descoberto.presencaTurmaId) campos.presenca_turma_id = descoberto.presencaTurmaId;
    if (descoberto.leagueClassId) campos.league_class_id = descoberto.leagueClassId;
    await this.gravarTurma(sponteTurmaId, campos, contexto);
  }

  /**
   * O que sabemos de cada turma, por `sponte_turma_id`.
   *
   * A tela precisa disto para a lista inteira de uma vez: perguntar turma
   * por turma seriam 49 idas ao banco para desenhar uma página.
   */
  async mapaTurmas(): Promise<Record<number, {
    presencaTurmaId: number | null;
    leagueClassId: string | null;
    leagueId: string | null;
    presencaErro: string | null;
    leagueErro: string | null;
    atualizadoEm: string | null;
  }>> {
    const linhas = await this.#rest<any[]>(
      "turmas_staging?select=sponte_turma_id,presenca_turma_id,league_class_id," +
      "league_id,presenca_erro,league_erro,atualizado_em");

    const mapa: Record<number, any> = {};
    for (const t of linhas ?? []) {
      mapa[t.sponte_turma_id] = {
        presencaTurmaId: t.presenca_turma_id ?? null,
        leagueClassId: t.league_class_id ?? null,
        leagueId: t.league_id ?? null,
        presencaErro: t.presenca_erro ?? null,
        leagueErro: t.league_erro ?? null,
        atualizadoEm: t.atualizado_em ?? null,
      };
    }
    return mapa;
  }

  /**
   * Grava colunas de `turmas_staging`, criando a linha se preciso.
   *
   * Recebe os nomes de coluna como vêm da orquestração (`presenca_turma_id`,
   * `league_erro`, …) para não ter que traduzir duas vezes o mesmo campo.
   *
   * `null` é gravado de propósito: é assim que `presenca_erro` é limpo
   * quando a operação que havia falhado passa a dar certo.
   */
  async gravarTurma(
    sponteTurmaId: number,
    campos: Record<string, unknown>,
    contexto: { turmaNome: string; cursoNome?: string | null; sponteCursoId?: number | null },
  ) {
    if (!Object.keys(campos).length) return;

    await this.#rest("turmas_staging?on_conflict=sponte_turma_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: JSON.stringify({
        sponte_turma_id: sponteTurmaId,
        sponte_curso_id: contexto.sponteCursoId ?? null,
        turma_nome: contexto.turmaNome,
        curso_nome: contexto.cursoNome ?? null,
        atualizado_em: new Date().toISOString(),
        ...campos,
      }),
    });
  }

  /**
   * Os alunos de uma turma, para a cascata de ativar/desativar.
   *
   * **Aqui mora a regra de quem pode ser ativado em massa.** Na planilha
   * ativar a turma forçava "Ativo" em todos, porque lá só existia
   * Ativo/Desativado. Aqui há rascunho, pendente e rejeitado — gente que
   * não concluiu ou não pagou —, e incluí-los daria acesso de graça por um
   * clique na turma.
   *
   * Então `paraAtivar` só traz quem chegou ao fim (`aprovado`/`enviado`).
   * Desativar é o contrário: pega **todo mundo** que tem id em alguma
   * plataforma, porque o que precisa sair é o que entrou, não importa como.
   */
  async alunosDaTurma(sponteTurmaId: number, modo: "ativar" | "desativar") {
    const filtro = modo === "ativar"
      ? "&status=in.(aprovado,enviado)"
      // Sem id em plataforma nenhuma não há nada a desligar.
      : "&or=(presenca_aluno_id.not.is.null,league_user_id.not.is.null)";

    const linhas = await this.#rest<any[]>(
      `alunos_staging?sponte_turma_id=eq.${sponteTurmaId}` +
      `&select=id,nome,email,turma_nome,sponte_turma_id,presenca_aluno_id,` +
      `league_user_id,status` +
      filtro +
      `&order=nome`);

    return (linhas ?? []).map((a) => ({
      id: a.id,
      nome: a.nome,
      email: a.email ?? null,
      turmaNome: a.turma_nome ?? "",
      sponteTurmaId: a.sponte_turma_id,
      presencaAlunoId: a.presenca_aluno_id ?? null,
      leagueUserId: a.league_user_id ?? null,
      status: a.status,
    }));
  }

  /**
   * Guarda o que a cascata fez com cada aluno e devolve o resumo.
   *
   * Sem isto os ids aprendidos na cascata se perdiam: o aluno teria sido
   * criado no Presença e, na próxima ativação, seria criado **de novo** —
   * duas fichas para a mesma pessoa, cada uma com metade das presenças.
   *
   * As gravações vão juntas, mas uma falha não derruba as outras: perder o
   * id de um aluno é ruim; perder o dos outros 30 por causa dele é pior.
   */
  async registrarCascata<T extends {
    alunos: Array<{ id: number; campos: Record<string, unknown> }>;
  }>(resultado: T): Promise<T> {
    await Promise.allSettled(
      resultado.alunos
        .filter((a) => Object.keys(a.campos).length)
        .map((a) => this.atualizarCadastro(a.id, a.campos)),
    );
    return resultado;
  }

  /**
   * De qual ficha é este segredo? `null` se não for de nenhuma.
   *
   * Consulta pelo token, nunca pelo id: é o token que prova a posse. O
   * valor é interpolado depois de passar por `encodeURIComponent`, porque
   * ele vem do navegador — e um `&` cru aqui remontaria a consulta.
   */
  async cadastroDoToken(token: string): Promise<number | null> {
    // Os tokens têm 32 caracteres hexadecimais. Recusar o resto antes de
    // ir ao banco evita uma ida por tentativa de palpite malformado.
    if (!/^[0-9a-f]{32}$/.test(token)) return null;

    const [c] = await this.#rest<Array<{ id: number }>>(
      `alunos_staging?select=id&token_acesso=eq.${encodeURIComponent(token)}&limit=1`);
    return c?.id ?? null;
  }

  /* ---------------------------------------------------------------- *
   * Auditoria
   * ---------------------------------------------------------------- */

  /**
   * Registra o que foi feito. **Nunca lança e nunca espera.**
   *
   * Auditoria que derruba a operação auditada é pior que auditoria nenhuma:
   * o aluno perderia a matrícula porque o log falhou. E esperar a gravação
   * somaria uma ida ao banco em cada passo de um fluxo que já leva segundos.
   *
   * O preço é conhecido e aceito: se o Supabase estiver fora no instante
   * exato, aquele registro se perde. Para reconstruir o que aconteceu com um
   * aluno isso basta; para contabilidade, não serviria.
   */
  registrar(e: {
    tipo: "http" | "sponte" | "link" | "presenca" | "league" | "vigia" | "importacao";
    operacao: string;
    cadastroId?: number | null;
    ok?: boolean | null;
    duracaoMs?: number | null;
    ip?: string | null;
    detalhe?: Record<string, unknown>;
    erro?: string | null;
  }): void {
    this.#rest("auditoria", {
      method: "POST",
      prefer: "return=minimal",
      body: JSON.stringify({
        tipo: e.tipo,
        operacao: e.operacao.slice(0, 200),
        cadastro_id: e.cadastroId ?? null,
        ok: e.ok ?? null,
        duracao_ms: e.duracaoMs ?? null,
        ip: e.ip || null,
        detalhe: e.detalhe ?? {},
        // Mensagem longa de SOAP entope a tabela sem acrescentar nada.
        erro: e.erro ? String(e.erro).slice(0, 1000) : null,
      }),
    }).catch((erro) => {
      // Só o console: insistir aqui arriscaria um laço de falha.
      console.error(`  ✖ auditoria (${e.tipo}/${e.operacao}): ${(erro as Error).message}`);
    });
  }

  async alertasAbertos() {
    const linhas = await this.#rest<any[]>("v_alertas_abertos?select=*");
    return linhas.map((a) => ({
      id: a.id, nome: a.nome, turmaNome: a.turma_nome, criadoEm: a.criado_em,
      sponteAlunoId: a.sponte_aluno_id, contaReceberId: a.sponte_conta_receber_id,
      alerta: {
        motivo: a.alerta_motivo, urgente: a.alerta_urgente,
        titulo: a.alerta_titulo, descricao: a.alerta_descricao, acao: a.alerta_acao,
      },
    }));
  }
}

/* ------------------------------------------------------------------ *
 * Tradução
 *
 * O banco usa snake_case (convenção do Postgres) e o JavaScript, camelCase.
 * A conversão fica nestas duas funções em vez de espalhada pelas rotas.
 * ------------------------------------------------------------------ */

function paraLink(l: any) {
  return {
    id: l.id, token: l.token,
    turmaId: l.turma_id, cursoId: l.curso_id,
    turmaNome: l.turma_nome, cursoNome: l.curso_nome, turmaTurno: l.turma_turno,
    expiraEm: l.expira_em, limiteUsos: l.limite_usos, usos: l.usos,
    criadoEm: l.criado_em, revogadoEm: l.revogado_em,
    planoCursoId: l.plano_curso_id, planoDescricao: l.plano_descricao,
    bolsaId: l.bolsa_id, bolsaDescricao: l.bolsa_descricao,
    valorParcela: num(l.valor_parcela), parcelas: l.parcelas,
    valorTotal: num(l.valor_total), valorParcelaCheia: num(l.valor_parcela_cheia),
  };
}

function paraCadastro(c: any) {
  return {
    id: c.id, linkId: c.link_id, origem: c.origem,
    turmaId: c.sponte_turma_id, cursoId: c.sponte_curso_id,
    turmaNome: c.turma_nome, cursoNome: c.curso_nome,

    nome: c.nome, cpf: c.cpf, dataNascimento: c.data_nascimento,
    email: c.email, celular: c.celular, sexo: c.sexo,
    rg: c.rg, rgOrgaoExpedidor: c.rg_orgao_expedidor,
    estadoCivil: c.estado_civil, nacionalidade: c.nacionalidade,
    cidadeNatal: c.cidade_natal, profissao: c.profissao,
    empresaTrabalho: c.empresa_trabalho, telefone: c.telefone,
    telefoneComercial: c.telefone_comercial, operadoraCelular: c.operadora_celular,
    contatoWhatsapp: c.contato_whatsapp,

    cep: c.cep, endereco: c.endereco, numeroEndereco: c.numero_endereco,
    complemento: c.complemento, bairro: c.bairro, cidade: c.cidade, uf: c.uf,

    responsavelNome: c.responsavel_nome, responsavelCpf: c.responsavel_cpf,
    responsavelParentesco: c.responsavel_parentesco,
    responsavelCelular: c.responsavel_celular, responsavelEmail: c.responsavel_email,

    origemVenda: c.origem_venda,
    planoCursoId: c.plano_curso_id, planoDescricao: c.plano_descricao,
    bolsaId: c.bolsa_id, bolsaDescricao: c.bolsa_descricao,
    valorParcela: num(c.valor_parcela), parcelas: c.parcelas,
    valorTotal: num(c.valor_total), valorParcelaCheia: num(c.valor_parcela_cheia),

    meioPagamento: c.meio_pagamento, formaCobrancaId: c.forma_cobranca_id,
    formaCobrancaNome: c.forma_cobranca_nome, parcelasCartao: c.parcelas_cartao,
    pagamentoStatus: c.pagamento_status, pagamentoLink: c.pagamento_link,
    pagamentoConfirmadoEm: c.pagamento_confirmado_em,
    cobrancaVerificadaEm: c.cobranca_verificada_em ?? null,
    // O vencimento é o que transforma "não pagou" em "está vencido".
    pagamentoVencimento: c.pagamento_vencimento ?? null,
    pagamentoValorPago: num(c.pagamento_valor_pago),

    // Derivado aqui, e não na tela, porque depende da data de hoje e a
    // regra é uma só. Copiá-la para o navegador criaria duas versões de
    // "está vencido" para divergirem na primeira mudança.
    financeiro: derivarFinanceiro(c),

    status: c.status, etapaAtual: c.etapa_atual,
    observacao: c.observacao, erroMensagem: c.sponte_erro,
    aceiteTermos: c.aceite_termos, aceiteEm: c.aceite_em,

    // O progresso é remontado dos campos soltos: guardá-lo como JSON tiraria
    // a possibilidade de filtrar e indexar por id do Sponte.
    progresso: c.sponte_aluno_id || c.sponte_contrato_id ? {
      sponteAlunoId: c.sponte_aluno_id,
      responsavelId: c.sponte_responsavel_id,
      contratoId: c.sponte_contrato_id,
      contaReceberId: c.sponte_conta_receber_id,
      numeroParcela: c.sponte_numero_parcela,
      linkPagamento: c.pagamento_link,
      alunoJaExistia: false, planoCriado: !!c.sponte_conta_receber_id,
      // Não é persistido: numa retomada o UpdateAlunos3 roda de novo, o que é
      // inofensivo (grava o mesmo conteúdo) e mais seguro que supor que já foi.
      dadosAtualizados: false,
      aguardandoFatura: c.pagamento_status === "aguardando",
      ultimoPasso: null, erro: c.sponte_erro, erroPasso: null,
    } : null,

    sponteAlunoId: c.sponte_aluno_id,
    presencaAlunoId: c.presenca_aluno_id,
    leagueUserId: c.league_user_id,

    // Vindos da planilha: quando a turma já é conhecida, a ativação usa estes
    // ids direto, sem casar nome — é mais confiável que qualquer comparação.
    presencaTurmaId: c.presenca_turma_id ?? null,
    leagueClassId: c.league_class_id ?? null,
    situacaoPlanilha: c.situacao_planilha ?? null,
    sponteErro: c.sponte_erro, presencaErro: c.presenca_erro, leagueErro: c.league_erro,

    alerta: c.alerta_motivo ? {
      motivo: c.alerta_motivo, urgente: c.alerta_urgente,
      titulo: c.alerta_titulo, descricao: c.alerta_descricao, acao: c.alerta_acao,
    } : null,

    criadoEm: c.criado_em, validadoEm: c.validado_em, enviadoEm: c.sponte_enviado_em,
  };
}

/** `numeric` do Postgres chega como string no JSON — converte sem perder null. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
