/**
 * Ativação do aluno no Presença e no LeagueInvest.
 *
 * Ordem: **Presença → LeagueInvest** (RN-30). As duas perdoam erro — dá para
 * repetir sem estragar nada — então vêm antes do Sponte, que não tem
 * exclusão. Aqui o Sponte já aconteceu; o que falta é espelhar o aluno nas
 * outras duas.
 *
 * Cada plataforma guarda o seu id para sempre (RN-32): com id, atualiza; sem
 * id, cria. É o que impede o mesmo aluno de virar três pessoas diferentes.
 *
 * Uma falha numa plataforma **não** impede a outra. O resultado é parcial e
 * fica visível na ficha, e repetir a ativação só tenta o que faltou.
 */

import { ClienteLeague, ErroLeague } from "./league.ts";
import { ClientePresenca, ErroPresenca } from "./presenca.ts";

export type Plataforma = "presenca" | "league";

export interface ResultadoPlataforma {
  plataforma: Plataforma;
  ok: boolean;
  mensagem: string;
  /** Campos a gravar no cadastro. Vazio quando nada mudou. */
  campos: Record<string, unknown>;
}

export interface ResultadoAtivacao {
  ok: boolean;
  resultados: ResultadoPlataforma[];
  campos: Record<string, unknown>;
}

/** O que a ativação precisa saber sobre o aluno. */
export interface AlunoParaAtivar {
  id: number;
  nome: string;
  email: string | null;
  turmaNome: string;
  sponteTurmaId: number;
  presencaAlunoId: number | null;
  leagueUserId: string | null;
}

/** Mapa da turma nas duas plataformas, vindo de `turmas_staging`. */
export interface TurmaMapeada {
  presencaTurmaId: number | null;
  leagueClassId: string | null;
}

/**
 * Descobre os ids da turma nas duas plataformas.
 *
 * Usa o que já estiver mapeado e só procura o que falta. O que for
 * encontrado volta em `aprender`, para o chamador gravar e não repetir a
 * busca na próxima ativação.
 */
export async function resolverTurma(
  turmaNome: string,
  conhecido: TurmaMapeada,
  clientes: { presenca: ClientePresenca; league: ClienteLeague | null },
): Promise<{ mapa: TurmaMapeada; aprender: TurmaMapeada; avisos: string[] }> {
  const mapa: TurmaMapeada = { ...conhecido };
  const aprender: TurmaMapeada = { presencaTurmaId: null, leagueClassId: null };
  const avisos: string[] = [];

  if (!mapa.presencaTurmaId) {
    const { turma, candidatos } = await clientes.presenca.acharTurma(turmaNome);
    if (turma) {
      mapa.presencaTurmaId = turma.id;
      aprender.presencaTurmaId = turma.id;
    } else if (candidatos.length) {
      avisos.push(
        `No Presença, "${turmaNome}" pode ser ${candidatos.join(" ou ")} — ` +
        `escolha uma e grave o id na turma.`);
    } else {
      avisos.push(`A turma "${turmaNome}" não existe no Presença — crie-a antes de ativar.`);
    }
  }

  if (!mapa.leagueClassId && clientes.league) {
    const { classId, candidatos } = await clientes.league.acharTurmaPorNome(turmaNome);
    if (classId) {
      mapa.leagueClassId = classId;
      aprender.leagueClassId = classId;
    } else if (candidatos.length) {
      avisos.push(
        `No LeagueInvest, "${turmaNome}" pode ser ${candidatos.join(" ou ")} — ` +
        `escolha uma e grave o id na turma.`);
    } else {
      avisos.push(`A turma "${turmaNome}" não existe no LeagueInvest.`);
    }
  }

  return { mapa, aprender, avisos };
}

/**
 * Ativa o aluno nas duas plataformas.
 *
 * `league` nulo significa que as credenciais não foram configuradas: o
 * Presença segue mesmo assim, e o LeagueInvest fica registrado como
 * pendente em vez de travar a ativação inteira.
 */
export async function ativarAluno(
  aluno: AlunoParaAtivar,
  turma: TurmaMapeada,
  clientes: { presenca: ClientePresenca; league: ClienteLeague | null },
): Promise<ResultadoAtivacao> {
  const resultados: ResultadoPlataforma[] = [];

  /* ---- Presença ---- */
  if (!turma.presencaTurmaId) {
    resultados.push({
      plataforma: "presenca", ok: false,
      mensagem: `sem turma correspondente no Presença para "${aluno.turmaNome}"`,
      campos: { presenca_erro: `turma "${aluno.turmaNome}" não encontrada no Presença` },
    });
  } else {
    try {
      const r = await clientes.presenca.garantirAluno({
        nome: aluno.nome,
        turmaId: turma.presencaTurmaId,
        existingId: aluno.presencaAlunoId,
      });

      // O histórico explica, na ficha do aluno, de onde ele veio. Sem isto a
      // linha aparece do nada para quem faz a chamada.
      await clientes.presenca.registrarHistorico({
        alunoId: r.id,
        descricao: r.criado
          ? `Aluno criado pelo cadastro online (${aluno.turmaNome}).`
          : `Aluno reativado pelo cadastro online (${aluno.turmaNome}).`,
        tipo: "movimentacao",
      }).catch(() => { /* histórico é registro, não pode derrubar a ativação */ });

      resultados.push({
        plataforma: "presenca", ok: true,
        mensagem: r.criado ? "aluno criado" : "aluno reativado",
        campos: {
          presenca_aluno_id: r.id,
          presenca_enviado_em: new Date().toISOString(),
          presenca_erro: null,
        },
      });
    } catch (e) {
      resultados.push({
        plataforma: "presenca", ok: false,
        mensagem: mensagemDeErro(e),
        campos: { presenca_erro: mensagemDeErro(e) },
      });
    }
  }

  /* ---- LeagueInvest ---- */
  if (!clientes.league) {
    resultados.push({
      plataforma: "league", ok: false,
      mensagem: "credenciais do LeagueInvest não configuradas",
      campos: { league_erro: "credenciais do LeagueInvest não configuradas no servidor" },
    });
  } else if (!turma.leagueClassId) {
    resultados.push({
      plataforma: "league", ok: false,
      mensagem: `sem turma correspondente no LeagueInvest para "${aluno.turmaNome}"`,
      campos: { league_erro: `turma "${aluno.turmaNome}" não encontrada no LeagueInvest` },
    });
  } else if (!aluno.email && !aluno.leagueUserId) {
    // RN-34: sem e-mail não há como criar conta. É bloqueio de dado, não falha
    // técnica, e a mensagem precisa dizer isso.
    resultados.push({
      plataforma: "league", ok: false,
      mensagem: "o aluno não tem e-mail — sem ele não dá para criar a conta",
      campos: { league_erro: "aluno sem e-mail: conta não pode ser criada" },
    });
  } else {
    try {
      const r = await clientes.league.garantirAluno({
        email: aluno.email ?? "",
        nome: aluno.nome,
        classId: turma.leagueClassId,
        existingId: aluno.leagueUserId,
      });

      resultados.push({
        plataforma: "league", ok: true,
        mensagem: r.criado ? "conta criada e matriculada" : "matrícula ativada",
        campos: {
          league_user_id: r.userId,
          league_enviado_em: new Date().toISOString(),
          league_erro: null,
        },
      });
    } catch (e) {
      resultados.push({
        plataforma: "league", ok: false,
        mensagem: mensagemDeErro(e),
        campos: { league_erro: mensagemDeErro(e) },
      });
    }
  }

  return montar(resultados);
}

/**
 * Desativa o aluno nas duas plataformas.
 *
 * No Presença, `ativo = false`; no LeagueInvest, matrícula cancelada e turma
 * esvaziada (RN-37). **A turma em si nunca é tocada** — desativar um aluno
 * não pode afetar os colegas.
 */
export async function desativarAluno(
  aluno: AlunoParaAtivar,
  clientes: { presenca: ClientePresenca; league: ClienteLeague | null },
  motivo?: string,
): Promise<ResultadoAtivacao> {
  const resultados: ResultadoPlataforma[] = [];

  if (aluno.presencaAlunoId) {
    try {
      await clientes.presenca.desativarAluno(aluno.presencaAlunoId);
      await clientes.presenca.registrarHistorico({
        alunoId: aluno.presencaAlunoId,
        descricao: motivo ? `Aluno inativado: ${motivo}` : "Aluno inativado pelo painel.",
        tipo: "movimentacao",
      }).catch(() => {});

      resultados.push({
        plataforma: "presenca", ok: true, mensagem: "aluno inativado",
        campos: { presenca_erro: null },
      });
    } catch (e) {
      resultados.push({
        plataforma: "presenca", ok: false, mensagem: mensagemDeErro(e),
        campos: { presenca_erro: mensagemDeErro(e) },
      });
    }
  }

  if (aluno.leagueUserId && clientes.league) {
    try {
      const vinculo = await clientes.league.ligaDoAluno(aluno.leagueUserId);
      if (!vinculo) throw new ErroLeague("não encontrei a liga do aluno");

      await clientes.league.cancelarAluno(aluno.leagueUserId, vinculo.league_id, motivo);
      resultados.push({
        plataforma: "league", ok: true, mensagem: "matrícula cancelada",
        campos: { league_erro: null },
      });
    } catch (e) {
      resultados.push({
        plataforma: "league", ok: false, mensagem: mensagemDeErro(e),
        campos: { league_erro: mensagemDeErro(e) },
      });
    }
  }

  return montar(resultados);
}

/* ------------------------------------------------------------------ *
 * Auxiliares
 * ------------------------------------------------------------------ */

function montar(resultados: ResultadoPlataforma[]): ResultadoAtivacao {
  const campos: Record<string, unknown> = {};
  for (const r of resultados) Object.assign(campos, r.campos);
  return {
    // Só é sucesso quando nenhuma plataforma falhou: um "ok" com metade
    // feita esconderia o aluno que ficou sem acesso ao conteúdo.
    ok: resultados.length > 0 && resultados.every((r) => r.ok),
    resultados,
    campos,
  };
}

function mensagemDeErro(e: unknown): string {
  if (e instanceof ErroLeague || e instanceof ErroPresenca) return e.message;
  return String((e as Error)?.message ?? e);
}
