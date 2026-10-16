/**
 * Sistema de Presença — gravação de alunos, turmas e histórico.
 *
 * O Presença é **este mesmo banco** (tabelas `alunos`, `turmas`, `presencas`,
 * `historico`), então não há API no meio: fala-se com o PostgREST usando a
 * service role. Por isso este módulo só roda no servidor.
 *
 * Portado do `Alunos.gs` da planilha, inclusive as decisões que não são
 * óbvias — a migração do histórico de presença na troca de turma é a
 * principal delas.
 */

import { chaveTurma, melhorCorrespondencia } from "./texto.ts";

/**
 * O que cada ida ao banco do Presença relatou.
 *
 * Existe para a auditoria enxergar a operação **por tabela**, não só o
 * resultado final da ativação. A diferença aparece quando algo dá errado no
 * meio: "ativar falhou" não diz se o aluno chegou a ser criado, se o
 * histórico foi gravado ou se foram as presenças que não migraram.
 */
export interface RegistroPresenca {
  operacao: string;
  tabela: string;
  metodo: string;
  ok: boolean;
  duracaoMs: number;
  detalhe?: Record<string, unknown>;
  erro?: string;
}

export interface ConfigPostgrest {
  url: string;
  serviceKey: string;
  /** Chamado a cada operação. Não pode lançar — ver `#rest`. */
  aoRegistrar?: (r: RegistroPresenca) => void;
}

export interface AlunoPresenca {
  id: number;
  nome: string;
  turma_id: number | null;
  ativo: boolean;
}

export interface TurmaPresenca {
  id: number;
  turma: string;
  curso: string;
  ativa: boolean;
}

export class ErroPresenca extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErroPresenca";
  }
}

export class ClientePresenca {
  #url: string;
  #key: string;
  #aoRegistrar: ((r: RegistroPresenca) => void) | undefined;

  constructor(cfg: ConfigPostgrest) {
    // `?? ""`: ver a nota em `repo-supabase.ts`. Construtor no topo do
    // módulo não pode lançar por configuração faltando.
    this.#url = (cfg.url ?? "").replace(/\/$/, "");
    this.#key = cfg.serviceKey;
    this.#aoRegistrar = cfg.aoRegistrar;
  }

  async #rest<T = any>(
    caminho: string,
    init: { method?: string; body?: unknown; prefer?: string; operacao?: string } = {},
  ): Promise<T> {
    const metodo = init.method ?? "GET";
    const comecou = Date.now();
    // A tabela é o começo do caminho, antes do "?".
    const tabela = caminho.split("?")[0];

    const relatar = (ok: boolean, detalhe?: Record<string, unknown>, erro?: string) => {
      if (!this.#aoRegistrar) return;
      try {
        this.#aoRegistrar({
          operacao: init.operacao ?? `${metodo} ${tabela}`,
          tabela, metodo, ok, duracaoMs: Date.now() - comecou, detalhe, erro,
        });
      } catch { /* registro não pode derrubar a gravação que ele observa */ }
    };

    let r: Response;
    try {
      r = await fetch(`${this.#url}/rest/v1/${caminho}`, {
        method: metodo,
        headers: {
          apikey: this.#key,
          Authorization: `Bearer ${this.#key}`,
          "Content-Type": "application/json",
          ...(init.prefer ? { Prefer: init.prefer } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (e) {
      relatar(false, undefined, (e as Error).message);
      throw e;
    }

    const texto = await r.text();
    if (!r.ok) {
      const msg = `Presença ${caminho} HTTP ${r.status}: ${texto.slice(0, 300)}`;
      relatar(false, { status: r.status }, msg);
      throw new ErroPresenca(msg);
    }

    const dados = texto ? JSON.parse(texto) as T : (null as T);
    relatar(true, {
      status: r.status,
      ...(Array.isArray(dados) ? { linhas: dados.length } : {}),
      // O corpo enviado, que é o que diz **o que mudou** — sem isso o
      // registro só prova que alguém chamou, não o que gravou.
      ...(init.body !== undefined ? { enviado: init.body } : {}),
    });
    return dados;
  }

  /* ---------------------------------------------------------------- *
   * Turmas
   * ---------------------------------------------------------------- */

  listarTurmas(): Promise<TurmaPresenca[]> {
    return this.#rest<TurmaPresenca[]>("turmas?select=id,turma,curso,ativa");
  }

  /**
   * Turma do Presença que corresponde a um nome vindo do Sponte.
   *
   * Casamento tolerante porque os nomes divergem de propósito nas duas bases
   * ("2/26" × "2/2026"). Ambiguidade devolve `null` com os candidatos: entre
   * mandar o aluno para a turma errada e pedir conferência, pedir conferência.
   */
  async acharTurma(nomeSponte: string): Promise<
    { turma: TurmaPresenca | null; candidatos: string[] }
  > {
    const turmas = await this.listarTurmas();
    const ativas = turmas.filter((t) => t.ativa);

    // Procura primeiro entre as ativas: turma encerrada com nome parecido é
    // ruído, e matricular alguém nela deixaria o aluno invisível na chamada.
    for (const conjunto of [ativas, turmas]) {
      const { escolhido, ambiguos } = melhorCorrespondencia(
        conjunto, nomeSponte, (t) => t.turma);
      if (escolhido) return { turma: escolhido, candidatos: [] };
      if (ambiguos.length) {
        return {
          turma: null,
          candidatos: ambiguos.map((c) => `${c.item.turma} (#${c.item.id})`),
        };
      }
    }
    return { turma: null, candidatos: [] };
  }

  /* ---------------------------------------------------------------- *
   * Alunos
   * ---------------------------------------------------------------- */

  async buscarAluno(id: number): Promise<AlunoPresenca | null> {
    const [a] = await this.#rest<AlunoPresenca[]>(
      `alunos?select=id,nome,turma_id,ativo&id=eq.${id}&limit=1`);
    return a ?? null;
  }

  /**
   * Turmas cujo nome contém o termo, para alguém escolher o vínculo à mão.
   *
   * Inclui as inativas: turma de semestre passado é justamente a que
   * costuma precisar de vínculo conferido.
   */
  async procurarTurmas(termo: string, limite = 20): Promise<TurmaPresenca[]> {
    const q = termo.trim().replace(/[,()*]/g, " ").trim();
    if (q.length < 2) return [];

    return await this.#rest<TurmaPresenca[]>(
      `turmas?select=id,turma,curso,ativa` +
      `&turma=ilike.${encodeURIComponent(`*${q}*`)}` +
      `&order=ativa.desc,turma&limit=${limite}`,
      { operacao: "procurarTurmas" });
  }

  /** Uma turma pelo id. `null` quando não existe. */
  async buscarTurma(id: number): Promise<TurmaPresenca | null> {
    const [t] = await this.#rest<TurmaPresenca[]>(
      `turmas?id=eq.${id}&select=id,turma,curso,ativa&limit=1`,
      { operacao: "buscarTurma" });
    return t ?? null;
  }

  /**
   * Cria a turma no Presença.
   *
   * `professor` é texto obrigatório na tabela, mas no Sponte muitas turmas
   * têm `ProfessorRegenteID = 0`. Quando não houver, grava "A definir" em
   * vez de recusar: a turma precisa existir para a chamada funcionar, e o
   * nome do professor é corrigível depois sem estragar nada.
   *
   * Nasce **desativada**, como no LeagueInvest: criar e ativar são dois
   * passos na tela, e turma que aparece na chamada antes de alguém conferir
   * horário e professor só gera engano no dia da aula.
   */
  async criarTurma(t: {
    nome: string;
    curso: string;
    professor?: string | null;
    horarioInicio?: string | null;
    diasSemana?: number[] | null;
    totalAulas?: number | null;
    cor?: string | null;
    ativa?: boolean;
  }): Promise<TurmaPresenca> {
    const [criada] = await this.#rest<TurmaPresenca[]>("turmas", {
      method: "POST",
      prefer: "return=representation",
      operacao: "criarTurma",
      body: {
        turma: t.nome,
        curso: t.curso || "A definir",
        professor: t.professor?.trim() || "A definir",
        ativa: t.ativa ?? false,
        total_aulas: t.totalAulas ?? 20,
        ...(t.horarioInicio ? { horario_inicio: t.horarioInicio } : {}),
        ...(t.diasSemana?.length ? { dias_semana: t.diasSemana } : {}),
        ...(t.cor ? { cor: t.cor } : {}),
      },
    });
    if (!criada?.id) throw new ErroPresenca("o Presença não devolveu o id da turma criada");
    return criada;
  }

  /**
   * Atualiza a turma. Só o que vier preenchido.
   *
   * Campo ausente é "não mexa", não "apague" — quem edita o horário pela
   * nossa tela não está pedindo para zerar o professor.
   */
  async atualizarTurma(id: number, t: {
    nome?: string;
    curso?: string;
    professor?: string | null;
    horarioInicio?: string | null;
    diasSemana?: number[] | null;
    totalAulas?: number | null;
    ativa?: boolean;
  }): Promise<void> {
    const campos: Record<string, unknown> = {};
    if (t.nome?.trim()) campos.turma = t.nome.trim();
    if (t.curso?.trim()) campos.curso = t.curso.trim();
    if (t.professor?.trim()) campos.professor = t.professor.trim();
    if (t.horarioInicio) campos.horario_inicio = t.horarioInicio;
    if (t.diasSemana?.length) campos.dias_semana = t.diasSemana;
    if (typeof t.totalAulas === "number") campos.total_aulas = t.totalAulas;
    if (typeof t.ativa === "boolean") campos.ativa = t.ativa;

    if (!Object.keys(campos).length) return;
    await this.#rest(`turmas?id=eq.${id}`, {
      method: "PATCH", body: campos, operacao: "atualizarTurma",
    });
  }

  /**
   * Procura alunos pelo nome, para alguém escolher à mão.
   *
   * Existe porque o casamento automático é por nome **dentro da turma**, e
   * isso erra em dois casos reais: o aluno que mudou de turma e o homônimo —
   * há 8 nomes repetidos entre os 411 alunos. Quando o vínculo sai errado,
   * é por aqui que se acha o certo.
   *
   * Devolve a turma junto porque é ela que distingue dois "Henrique".
   */
  async procurarAlunos(termo: string, limite = 20): Promise<
    Array<AlunoPresenca & { turmaNome: string | null }>
  > {
    const q = termo.trim();
    if (q.length < 2) return [];

    // `*` é o coringa do PostgREST; vírgula e parêntese quebram o filtro.
    const seguro = q.replace(/[,()*]/g, " ").trim();
    const alunos = await this.#rest<AlunoPresenca[]>(
      `alunos?select=id,nome,turma_id,ativo&nome=ilike.*${encodeURIComponent(seguro)}*` +
      `&order=ativo.desc,nome&limit=${limite}`,
      { operacao: "procurarAlunos" },
    );
    if (!alunos?.length) return [];

    const turmas = await this.listarTurmas();
    const porId = new Map(turmas.map((t) => [t.id, t.turma]));
    return alunos.map((a) => ({
      ...a,
      turmaNome: a.turma_id ? porId.get(a.turma_id) ?? null : null,
    }));
  }

  /** Aluno com esse nome naquela turma — a chave que a planilha usava. */
  async acharAlunoPorNome(nome: string, turmaId: number): Promise<AlunoPresenca | null> {
    const daTurma = await this.#rest<AlunoPresenca[]>(
      `alunos?select=id,nome,turma_id,ativo&turma_id=eq.${turmaId}`);
    const { escolhido } = melhorCorrespondencia(daTurma, nome, (a) => a.nome);
    return escolhido ?? null;
  }

  /**
   * Cria, atualiza ou reativa o aluno — sempre deixando-o ativo na turma.
   *
   * Com `existingId`, atualiza aquele registro; sem ele, procura pelo nome na
   * turma antes de criar, para não gerar um segundo "João Silva" na mesma
   * chamada.
   */
  async garantirAluno(dados: {
    nome: string;
    turmaId: number;
    existingId?: number | null;
  }): Promise<{ id: number; criado: boolean; turmaAnterior: number | null }> {
    const { nome, turmaId } = dados;

    if (dados.existingId) {
      const atual = await this.buscarAluno(dados.existingId);
      if (!atual) {
        throw new ErroPresenca(
          `o aluno #${dados.existingId} não existe mais no Presença — ` +
          `apague o id na ficha para que ele seja criado de novo`);
      }

      await this.#rest(`alunos?id=eq.${dados.existingId}`, {
        method: "PATCH",
        body: { nome, ativo: true, turma_id: turmaId },
      });

      // Trocou de turma: leva o histórico junto. Cada linha de `presencas`
      // carrega o turma_id, então sem isto as presenças ficam presas na turma
      // antiga e o aluno aparece zerado na nova.
      if (atual.turma_id !== null && atual.turma_id !== turmaId) {
        await this.migrarPresencas(dados.existingId, atual.turma_id, turmaId);
      }

      return { id: dados.existingId, criado: false, turmaAnterior: atual.turma_id };
    }

    const achado = await this.acharAlunoPorNome(nome, turmaId);
    if (achado) {
      await this.#rest(`alunos?id=eq.${achado.id}`, {
        method: "PATCH",
        body: { nome, ativo: true, turma_id: turmaId },
      });
      return { id: achado.id, criado: false, turmaAnterior: achado.turma_id };
    }

    const [criado] = await this.#rest<AlunoPresenca[]>("alunos", {
      method: "POST",
      prefer: "return=representation",
      body: { nome, turma_id: turmaId, ativo: true, experimental: false },
    });
    if (!criado?.id) throw new ErroPresenca("o Presença não devolveu o id do aluno criado");

    return { id: criado.id, criado: true, turmaAnterior: null };
  }

  /** Inativa sem apagar: o histórico de presença continua valendo. */
  async desativarAluno(id: number): Promise<void> {
    await this.#rest(`alunos?id=eq.${id}`, { method: "PATCH", body: { ativo: false } });
  }

  /**
   * Move o histórico de presença de uma turma para outra.
   *
   * Devolve quantos registros mudaram — número que vale a pena registrar,
   * porque é a única pista de que o histórico foi mesmo junto.
   */
  async migrarPresencas(alunoId: number, de: number, para: number): Promise<number> {
    const movidos = await this.#rest<{ id: number }[]>(
      `presencas?aluno_id=eq.${alunoId}&turma_id=eq.${de}`,
      { method: "PATCH", prefer: "return=representation", body: { turma_id: para } },
    );
    return movidos?.length ?? 0;
  }

  /* ---------------------------------------------------------------- *
   * Histórico
   * ---------------------------------------------------------------- */

  /** Registra uma linha no histórico do aluno (movimentação ou observação). */
  async registrarHistorico(e: {
    alunoId: number;
    descricao: string;
    tipo?: string;
    categoria?: string | null;
    usuarioNome?: string | null;
  }): Promise<void> {
    await this.#rest("historico", {
      method: "POST",
      body: {
        aluno_id: e.alunoId,
        descricao: e.descricao,
        tipo: e.tipo ?? "movimentacao",
        data_obs: new Date().toISOString().slice(0, 10),
        ...(e.categoria ? { categoria: e.categoria } : {}),
        ...(e.usuarioNome ? { usuario_nome: e.usuarioNome } : {}),
      },
    });
  }

  /**
   * Última aula em que o aluno esteve presente (P) ou repôs (R).
   *
   * Usado no pedido de cancelamento: saber até onde a pessoa acompanhou muda
   * a conversa de retenção.
   */
  async ultimaAulaPresente(alunoId: number): Promise<string> {
    const linhas = await this.#rest<{ aula: string; status: string }[]>(
      `presencas?select=aula,status&aluno_id=eq.${alunoId}&status=in.(P,R)`);
    if (!linhas?.length) return "sem registro de presença";

    let maior = -1, statusMaior = "P";
    for (const r of linhas) {
      const n = Number(String(r.aula ?? "").match(/(\d+)/)?.[1] ?? 0);
      if (n > maior) { maior = n; statusMaior = r.status; }
    }
    return maior < 0
      ? "sem registro de presença"
      : `Aula ${maior}${statusMaior === "R" ? " (reposição)" : ""}`;
  }
}

/** Reexportado por conveniência de quem só precisa comparar nomes de turma. */
export { chaveTurma };
