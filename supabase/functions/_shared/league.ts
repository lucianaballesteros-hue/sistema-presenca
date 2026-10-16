/**
 * LeagueInvest — criação e matrícula de alunos.
 *
 * Portado do `Alunos.gs` da planilha. O LeagueInvest é um Supabase de
 * terceiros: fala-se com ele por PostgREST (`/rest/v1`) e por três edge
 * functions (`search-user-by-email`, `link-existing-user`,
 * `admin-create-user`).
 *
 * Duas coisas que o script nos ensinou e valem repetir aqui:
 *
 * 1. **Não se cria usuário sem procurar antes.** O mesmo e-mail pode já ter
 *    conta em outra liga; criar de novo quebraria o acesso da pessoa.
 *
 * 2. **A RLS deles só deixa o próprio aluno editar o perfil.** Tentar
 *    corrigir nome pelo admin devolve zero linhas, sem erro. Por isso
 *    `atualizarNome` devolve um booleano em vez de lançar — não dá para
 *    distinguir "não permitido" de "nada mudou", e nenhum dos dois é falha.
 *
 * O acesso é feito com uma conta administrativa (e-mail e senha), porque a
 * chave anônima sozinha não enxerga as ligas.
 */

import { melhorCorrespondencia } from "./texto.ts";

/**
 * O que cada chamada ao LeagueInvest relatou.
 *
 * Granularidade por operação, não por ativação: quando algo falha no meio,
 * "ativar falhou" não diz se a conta chegou a ser criada, se foi só a
 * matrícula que não mudou, ou se o login é que expirou.
 */
export interface RegistroLeague {
  operacao: string;
  recurso: string;
  metodo: string;
  ok: boolean;
  duracaoMs: number;
  detalhe?: Record<string, unknown>;
  erro?: string;
}

export interface ConfigLeague {
  url: string;
  anonKey: string;
  email: string;
  senha: string;
  /**
   * Senha inicial de aluno novo. O aluno troca no primeiro acesso.
   *
   * Vem do ambiente (`LEAGUE_SENHA_PADRAO_ALUNO`) e **não tem padrão no
   * código**: este repositório é público, e um valor chumbado aqui seria a
   * senha inicial de toda conta de aluno, à vista de qualquer um.
   */
  senhaPadraoAluno?: string;
  /** Chamado a cada operação. Não pode lançar. */
  aoRegistrar?: (r: RegistroLeague) => void;
}

export class ErroLeague extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErroLeague";
  }
}

/** Lê a configuração do ambiente, ou `null` se ela não estiver completa. */
export function configDoAmbiente(
  env: { get(chave: string): string | undefined },
): ConfigLeague | null {
  const url = env.get("LEAGUE_URL");
  const anonKey = env.get("LEAGUE_ANON_KEY");
  const email = env.get("LEAGUE_EMAIL");
  const senha = env.get("LEAGUE_SENHA");
  if (!url || !anonKey || !email || !senha) return null;

  return {
    url, anonKey, email, senha,
    senhaPadraoAluno: env.get("LEAGUE_SENHA_PADRAO_ALUNO") || undefined,
  };
}

export interface MembroLeague {
  league_id: string;
  class_id: string | null;
  enrollment_status: string;
}

export class ClienteLeague {
  #cfg: ConfigLeague;
  #token: string | null = null;
  #expira = 0;
  /** class_id → league_id. A turma não muda de liga; vale guardar. */
  #ligaPorTurma = new Map<string, string>();

  constructor(cfg: ConfigLeague) {
    this.#cfg = { ...cfg, url: cfg.url.replace(/\/$/, "") };
  }

  /* ---------------------------------------------------------------- *
   * Acesso
   * ---------------------------------------------------------------- */

  /** Token da conta administrativa, renovado um minuto antes de vencer. */
  async token(): Promise<string> {
    if (this.#token && Date.now() < this.#expira) return this.#token;

    const r = await fetch(`${this.#cfg.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: this.#cfg.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.#cfg.email, password: this.#cfg.senha }),
    });

    const texto = await r.text();
    if (!r.ok) {
      throw new ErroLeague(
        `não consegui entrar no LeagueInvest (HTTP ${r.status}) — confira ` +
        `LEAGUE_EMAIL e LEAGUE_SENHA: ${texto.slice(0, 200)}`);
    }

    const j = JSON.parse(texto);
    if (!j.access_token) throw new ErroLeague("o LeagueInvest não devolveu token de acesso");

    this.#token = j.access_token as string;
    this.#expira = Date.now() + Math.max((Number(j.expires_in) || 3600) - 60, 60) * 1000;
    return this.#token;
  }

  /** Relata uma operação, sem deixar o relato atrapalhar a operação. */
  #relatar(r: RegistroLeague): void {
    if (!this.#cfg.aoRegistrar) return;
    try { this.#cfg.aoRegistrar(r); } catch { /* nunca propaga */ }
  }

  async #rest<T = any>(
    metodo: string, caminho: string, corpo?: unknown,
  ): Promise<T> {
    const comecou = Date.now();
    const recurso = caminho.split("?")[0];
    const base = { operacao: `${metodo.toUpperCase()} ${recurso}`, recurso,
                   metodo: metodo.toUpperCase() };

    let r: Response;
    try {
      r = await fetch(`${this.#cfg.url}/rest/v1/${caminho}`, {
        method: metodo.toUpperCase(),
        headers: {
          apikey: this.#cfg.anonKey,
          Authorization: `Bearer ${await this.token()}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
      });
    } catch (e) {
      this.#relatar({ ...base, ok: false, duracaoMs: Date.now() - comecou,
                      erro: (e as Error).message });
      throw e;
    }

    const texto = await r.text();
    if (!r.ok) {
      const msg = traduzir(r.status, caminho, texto);
      this.#relatar({ ...base, ok: false, duracaoMs: Date.now() - comecou,
                      detalhe: { status: r.status }, erro: msg });
      throw new ErroLeague(msg);
    }

    const dados = texto ? JSON.parse(texto) as T : (null as T);
    this.#relatar({ ...base, ok: true, duracaoMs: Date.now() - comecou,
                    detalhe: {
                      status: r.status,
                      ...(Array.isArray(dados) ? { linhas: dados.length } : {}),
                      ...(corpo !== undefined ? { enviado: corpo } : {}),
                    } });
    return dados;
  }

  async #invocar<T = any>(funcao: string, corpo: unknown): Promise<T> {
    const comecou = Date.now();
    const base = { operacao: funcao, recurso: `functions/${funcao}`, metodo: "POST" };

    // A senha de aluno novo não entra no registro: auditoria não é lugar de
    // credencial, nem a de outra pessoa.
    const seguro = corpo && typeof corpo === "object"
      ? Object.fromEntries(Object.entries(corpo as Record<string, unknown>)
          .filter(([k]) => !/password|senha/i.test(k)))
      : corpo;

    const r = await fetch(`${this.#cfg.url}/functions/v1/${funcao}`, {
      method: "POST",
      headers: {
        apikey: this.#cfg.anonKey,
        Authorization: `Bearer ${await this.token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(corpo),
    });

    const texto = await r.text();
    let j: any = {};
    try { j = JSON.parse(texto); } catch { /* resposta não-JSON cai no erro abaixo */ }

    if (!r.ok) {
      const msg = traduzir(r.status, funcao, j.error ?? texto);
      this.#relatar({ ...base, ok: false, duracaoMs: Date.now() - comecou,
                      detalhe: { status: r.status, enviado: seguro }, erro: msg });
      throw new ErroLeague(msg);
    }

    this.#relatar({ ...base, ok: true, duracaoMs: Date.now() - comecou,
                    detalhe: { enviado: seguro, achou: j.found ?? null,
                               jaMembro: j.isAlreadyMember ?? null } });
    return j as T;
  }

  /* ---------------------------------------------------------------- *
   * Consultas
   * ---------------------------------------------------------------- */

  async ligaDaTurma(classId: string): Promise<string> {
    const guardado = this.#ligaPorTurma.get(classId);
    if (guardado) return guardado;

    const r = await this.#rest<{ league_id: string }[]>(
      "GET", `league_classes?select=league_id&id=eq.${encodeURIComponent(classId)}`);
    if (!r?.length) throw new ErroLeague(`a turma ${classId} não existe no LeagueInvest`);

    this.#ligaPorTurma.set(classId, r[0].league_id);
    return r[0].league_id;
  }

  /* ---------------------------------------------------------------- *
   * Turmas (league_classes)
   * ---------------------------------------------------------------- */

  /** As ligas que esta conta enxerga. */
  async ligas(): Promise<Array<{ id: string; nome: string }>> {
    const r = await this.#rest<Array<{ id: string; name: string }>>(
      "GET", "leagues?select=id,name&order=name");
    return (r ?? []).map((l) => ({ id: l.id, nome: l.name }));
  }

  /**
   * A liga onde uma turma deste programa deve nascer.
   *
   * O LeagueInvest não tem campo de programa: o que separa EVOL de ELAS é
   * **a liga**. ELAS vive em "Finanças para Elas", EVOL em "Evolution",
   * MAST em "Financial Master" — e essa regra não está escrita em lugar
   * nenhum, só nos dados.
   *
   * Então é de lá que ela é lida: a liga das turmas que já existem com o
   * mesmo programa no começo do nome. Chumbar o mapa aqui envelheceria no
   * dia em que a escola criasse a quarta liga.
   *
   * `null` quando o programa é novo — nenhuma turma dele existe ainda. Aí
   * só quem conhece a escola decide, e a tela pergunta em vez de adivinhar:
   * turma na liga errada some para o aluno certo.
   */
  async ligaDoPrograma(programa: string): Promise<
    { id: string; nome: string; turmasVistas: number } | null
  > {
    const alvo = programa.trim().toUpperCase();
    if (!alvo) return null;

    const turmas = await this.#rest<Array<{ league_id: string; name: string }>>(
      "GET", "league_classes?select=league_id,name&limit=10000");

    const votos = new Map<string, number>();
    for (const t of turmas ?? []) {
      // O programa é o começo do nome: "ELAS Quarta 14:00 PR 2/26".
      if (!String(t.name).trim().toUpperCase().startsWith(alvo)) continue;
      votos.set(t.league_id, (votos.get(t.league_id) ?? 0) + 1);
    }
    if (!votos.size) return null;

    // A mais usada. Turma solta numa liga de teste não deve mandar no resto.
    const [ligaId, turmasVistas] = [...votos].sort((a, b) => b[1] - a[1])[0];
    const nome = (await this.ligas()).find((l) => l.id === ligaId)?.nome ?? "";
    return { id: ligaId, nome, turmasVistas };
  }

  /**
   * Cria a turma no LeagueInvest e devolve o `class_id`.
   *
   * O nome tem de ser **o mesmo do Sponte**. É ele que casa as três
   * plataformas, e divergir aqui é como as 32 turmas de 2026 que hoje não
   * se encontram nasceram.
   *
   * Nasce **desativada** quando `ativa` não vem: criar e ativar são passos
   * separados na tela, e turma ativa aparece para o aluno antes de a escola
   * ter conferido horário e professor.
   */
  async criarTurma(t: {
    nome: string;
    ligaId: string;
    inicio?: string | null;
    fim?: string | null;
    tipo?: string;
    imersao?: boolean;
    ativa?: boolean;
  }): Promise<string> {
    const [criada] = await this.#rest<Array<{ id: string }>>(
      "POST", "league_classes", {
        league_id: t.ligaId,
        name: t.nome,
        class_type: t.tipo ?? "regular",
        is_immersion: t.imersao ?? false,
        is_active: t.ativa ?? false,
        display_order: 0,
        ...(t.inicio ? { start_date: t.inicio } : {}),
        ...(t.fim ? { end_date: t.fim } : {}),
      });
    if (!criada?.id) throw new ErroLeague("o LeagueInvest não devolveu o id da turma criada");

    this.#ligaPorTurma.set(criada.id, t.ligaId);
    return criada.id;
  }

  /**
   * Atualiza a turma. Só o que vier preenchido.
   *
   * Campo ausente é "não mexa": quem corrige a data de término pela nossa
   * tela não está pedindo para apagar o nome.
   */
  async atualizarTurma(classId: string, t: {
    nome?: string;
    inicio?: string | null;
    fim?: string | null;
    ativa?: boolean;
  }): Promise<void> {
    const campos: Record<string, unknown> = {};
    if (t.nome?.trim()) campos.name = t.nome.trim();
    if (t.inicio) campos.start_date = t.inicio;
    if (t.fim) campos.end_date = t.fim;
    if (typeof t.ativa === "boolean") campos.is_active = t.ativa;

    if (!Object.keys(campos).length) return;
    await this.#rest(
      "PATCH", `league_classes?id=eq.${encodeURIComponent(classId)}`, campos);
  }

  /**
   * Uma turma pelo `class_id`, com o nome da liga.
   *
   * A liga aparece junto porque é ela que define o programa: "ELAS Quarta"
   * na liga Evolution seria o conteúdo errado, e sem mostrar a liga ninguém
   * perceberia.
   */
  async buscarTurma(classId: string): Promise<
    { id: string; nome: string; ativa: boolean; ligaNome: string | null } | null
  > {
    const [t] = await this.#rest<Array<{
      id: string; name: string; is_active: boolean;
      leagues: { name: string } | null;
    }>>(
      "GET",
      `league_classes?select=id,name,is_active,leagues(name)` +
      `&id=eq.${encodeURIComponent(classId)}&limit=1`);
    if (!t) return null;

    return {
      id: t.id, nome: t.name, ativa: !!t.is_active,
      ligaNome: t.leagues?.name ?? null,
    };
  }

  /** Turmas cujo nome contém o termo, para escolher o vínculo à mão. */
  async procurarTurmas(termo: string, limite = 20): Promise<
    Array<{ id: string; nome: string; ativa: boolean; ligaNome: string | null }>
  > {
    const q = termo.trim().replace(/[,()*]/g, " ").trim();
    if (q.length < 2) return [];

    const r = await this.#rest<Array<{
      id: string; name: string; is_active: boolean; leagues: { name: string } | null;
    }>>(
      "GET",
      `league_classes?select=id,name,is_active,leagues(name)` +
      `&name=ilike.${encodeURIComponent(`*${q}*`)}` +
      `&order=is_active.desc,name&limit=${limite}`);

    return (r ?? []).map((t) => ({
      id: t.id, nome: t.name, ativa: !!t.is_active,
      ligaNome: t.leagues?.name ?? null,
    }));
  }

  /**
   * Quem está matriculado na turma — para a cascata de ativar/desativar.
   *
   * Só os ativos: cancelado já está onde deveria, e reprocessá-lo seria
   * gastar chamada para não mudar nada.
   */
  async membrosDaTurma(classId: string): Promise<
    Array<{ userId: string; leagueId: string }>
  > {
    const r = await this.#rest<Array<{ user_id: string; league_id: string }>>(
      "GET",
      `league_members?select=user_id,league_id` +
      `&class_id=eq.${encodeURIComponent(classId)}` +
      `&enrollment_status=eq.ativa&limit=10000`,
    );
    return (r ?? []).map((m) => ({ userId: m.user_id, leagueId: m.league_id }));
  }

  /**
   * Turma do LeagueInvest correspondente a um nome vindo do Sponte.
   *
   * Existe porque o `class_id` é um uuid: não há como deduzi-lo, só
   * encontrá-lo. Na planilha esse vínculo era mantido à mão na aba de
   * Parâmetros; aqui ele é descoberto uma vez e gravado em `turmas_staging`.
   *
   * Ambiguidade devolve `null` com os candidatos, pelo mesmo motivo do
   * Presença: turma errada mistura o conteúdo de duas turmas.
   */
  async acharTurmaPorNome(nomeSponte: string): Promise<
    { classId: string | null; nome: string | null; candidatos: string[] }
  > {
    const turmas = await this.#rest<
      { id: string; name: string; is_active: boolean }[]
    >("GET", "league_classes?select=id,name,is_active&limit=10000");

    const ativas = (turmas ?? []).filter((t) => t.is_active);
    for (const conjunto of [ativas, turmas ?? []]) {
      const { escolhido, ambiguos } = melhorCorrespondencia(
        conjunto, nomeSponte, (t) => t.name);
      if (escolhido) return { classId: escolhido.id, nome: escolhido.name, candidatos: [] };
      if (ambiguos.length) {
        return { classId: null, nome: null, candidatos: ambiguos.map((c) => c.item.name) };
      }
    }
    return { classId: null, nome: null, candidatos: [] };
  }

  /**
   * Procura perfis por nome ou e-mail, para alguém escolher à mão.
   *
   * O casamento automático é só por e-mail exato. Isso erra quando o aluno
   * se cadastrou no LeagueInvest com outro endereço — e aí a busca por nome
   * é a única saída.
   *
   * ⚠️ O que aparece aqui depende da conta usada: a RLS deles limita os
   * perfis visíveis por liga. Um resultado vazio pode significar "não existe"
   * ou "esta conta não enxerga", e não há como distinguir daqui.
   */
  async procurarPerfis(termo: string, limite = 20): Promise<
    Array<{ id: string; nome: string | null; email: string | null }>
  > {
    const q = termo.trim().replace(/[,()*]/g, " ").trim();
    if (q.length < 2) return [];

    const alvo = encodeURIComponent(`*${q}*`);
    const r = await this.#rest<Array<{ id: string; full_name: string; email: string }>>(
      "GET",
      `profiles?select=id,full_name,email` +
      `&or=(full_name.ilike.${alvo},email.ilike.${alvo})` +
      `&order=full_name&limit=${limite}`,
    );

    return (r ?? []).map((p) => ({
      id: p.id, nome: p.full_name ?? null, email: p.email ?? null,
    }));
  }

  /**
   * Vínculo de liga do aluno, preferindo o que tem turma.
   *
   * Serve para reativar ou cancelar sem depender da turma informada na ficha
   * — útil quando o aluno foi matriculado fora deste sistema.
   */
  async ligaDoAluno(userId: string): Promise<MembroLeague | null> {
    const r = await this.#rest<MembroLeague[]>(
      "GET",
      `league_members?select=league_id,class_id,enrollment_status&user_id=eq.${encodeURIComponent(userId)}`,
    );
    if (!r?.length) return null;
    return r.find((m) => m.class_id) ?? r[0];
  }

  /* ---------------------------------------------------------------- *
   * Escrita
   * ---------------------------------------------------------------- */

  /**
   * Garante o aluno ativo na turma e devolve o `user_id`.
   *
   * Três caminhos, nesta ordem: id conhecido → só ajusta a matrícula;
   * e-mail já cadastrado → vincula à liga; ninguém → cria a conta.
   */
  async garantirAluno(dados: {
    email: string;
    nome: string;
    classId: string;
    existingId?: string | null;
  }): Promise<{ userId: string; criado: boolean }> {
    const leagueId = await this.ligaDaTurma(dados.classId);

    if (dados.existingId) {
      await this.#rest(
        "PATCH",
        `league_members?league_id=eq.${leagueId}&user_id=eq.${encodeURIComponent(dados.existingId)}`,
        { class_id: dados.classId, enrollment_status: "ativa" },
      );
      return { userId: dados.existingId, criado: false };
    }

    if (!dados.email) {
      throw new ErroLeague("falta o e-mail do aluno para criar a conta no LeagueInvest");
    }

    const achado = await this.#invocar<{
      found?: boolean; isAlreadyMember?: boolean; user?: { id: string };
    }>("search-user-by-email", { email: dados.email, leagueId });

    if (achado.found && achado.user?.id) {
      const uid = achado.user.id;
      if (achado.isAlreadyMember) {
        await this.#rest(
          "PATCH",
          `league_members?league_id=eq.${leagueId}&user_id=eq.${encodeURIComponent(uid)}`,
          { class_id: dados.classId, enrollment_status: "ativa" },
        );
      } else {
        await this.#invocar("link-existing-user", {
          userId: uid, leagueId, classId: dados.classId,
        });
      }
      return { userId: uid, criado: false };
    }

    // Recusar é melhor que inventar: sem a senha configurada, criar a conta
    // com um valor conhecido deixaria a conta do aluno aberta a quem leia o
    // código. Falhar aqui custa um aviso na tela; a outra opção custa a conta.
    if (!this.#cfg.senhaPadraoAluno) {
      throw new ErroLeague(
        "falta LEAGUE_SENHA_PADRAO_ALUNO no ambiente — sem ela não dá para " +
        "criar a conta do aluno com uma senha inicial segura");
    }

    const r = await this.#invocar<{ userId?: string; user?: { id: string } }>(
      "admin-create-user",
      {
        email: dados.email,
        password: this.#cfg.senhaPadraoAluno,
        fullName: dados.nome,
        leagueId,
        classId: dados.classId,
      },
    );

    const uid = r.userId ?? r.user?.id;
    if (!uid) throw new ErroLeague("o LeagueInvest não devolveu o id do usuário criado");
    return { userId: uid, criado: true };
  }

  /** Reativa a matrícula atual sem mexer na turma. */
  async reativarMatriculaAtual(userId: string): Promise<void> {
    const m = await this.ligaDoAluno(userId);
    if (!m) throw new ErroLeague("o aluno não tem vínculo de liga no LeagueInvest");

    await this.#rest(
      "PATCH",
      `league_members?league_id=eq.${m.league_id}&user_id=eq.${encodeURIComponent(userId)}`,
      { enrollment_status: "ativa" },
    );
  }

  /**
   * Cancela a matrícula e tira o aluno da turma.
   *
   * `class_id = null` é o que faz a pessoa sumir da lista da turma;
   * `garantirAluno` recoloca quando ela voltar.
   */
  async cancelarAluno(userId: string, leagueId: string, motivo?: string): Promise<void> {
    await this.#rest(
      "PATCH",
      `league_members?league_id=eq.${leagueId}&user_id=eq.${encodeURIComponent(userId)}`,
      {
        enrollment_status: "cancelada",
        enrollment_status_reason: motivo ?? "Cancelado pelo painel de cadastros",
        enrollment_status_changed_at: new Date().toISOString(),
        class_id: null,
      },
    );
  }

  /**
   * Tenta corrigir o nome no perfil. `false` quando a RLS não deixou.
   *
   * Não é erro: hoje só o próprio aluno edita o perfil dele no site deles.
   */
  async atualizarNome(userId: string, nome: string): Promise<boolean> {
    try {
      const r = await this.#rest<unknown[]>(
        "PATCH", `profiles?id=eq.${encodeURIComponent(userId)}`, { full_name: nome });
      return Array.isArray(r) && r.length > 0;
    } catch {
      return false;
    }
  }
}

/**
 * Transforma o erro técnico em algo acionável.
 *
 * Mantive os casos que o `msgErro` da planilha já tratava: quem lê o painel
 * precisa saber se o problema é permissão, login ou instabilidade.
 */
function traduzir(status: number, onde: string, detalhe: string): string {
  const d = String(detalhe).slice(0, 200);
  if (status === 403) {
    return `sem permissão nessa liga (${onde}) — a conta configurada precisa ser admin dela`;
  }
  if (status === 401) {
    return `o LeagueInvest recusou o acesso (${onde}) — confira LEAGUE_EMAIL e LEAGUE_SENHA`;
  }
  if (status >= 500) {
    return `o LeagueInvest está instável (${onde}, HTTP ${status}) — tente de novo em instantes`;
  }
  return `${onde} devolveu HTTP ${status}: ${d}`;
}
