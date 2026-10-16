/**
 * `sponte-turmas` — lista as turmas do Sponte para o painel administrativo.
 *
 * É a primeira função da integração e é **somente leitura**: usa `GetTurmas`,
 * que não cria nem altera nada no ERP. Serve à tela em que a coordenação
 * escolhe a turma ao gerar um link de cadastro.
 *
 * Esta função existe por um motivo estrutural, não de conveniência: o
 * `SPONTE_KEY` não pode chegar ao navegador (`docs/API-SPONTE.md` §9.1). Ela é
 * a fronteira onde o segredo para.
 *
 * Contrato:
 *
 *   POST /functions/v1/sponte-turmas
 *   Authorization: Bearer <jwt do usuário logado>
 *   { "anoLetivo": 2026, "apenasMatriculaveis": true, "busca": "Avançado" }
 *
 *   200 → { turmas: TurmaSponte[], total: number }
 *   401 → sem sessão válida
 *   403 → sessão válida, mas sem papel de admin
 *   502 → o Sponte recusou ou não respondeu
 */

import {
  AutorizacaoError,
  cabecalhosCors,
  configDoAmbiente,
  exigirPapel,
  origensDoAmbiente,
  respostaJson,
} from "../_shared/auth.ts";
import { credenciaisDoAmbiente, SponteError } from "../_shared/soap.ts";
import { filtrarMatriculaveis, type FiltroTurmas, getTurmas } from "../_shared/turmas.ts";

interface CorpoRequisicao {
  /** Restringe ao ano letivo. Sem isso, vêm as 174 turmas históricas. */
  anoLetivo?: number;
  /** Texto para busca parcial no nome da turma. */
  busca?: string;
  /** Só turmas não encerradas e com vaga. Padrão: `true`. */
  apenasMatriculaveis?: boolean;
  /** Restringe a um curso específico. */
  cursoId?: number;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origensPermitidas = origensDoAmbiente(Deno.env);
  const cors = cabecalhosCors(req.headers.get("Origin"), origensPermitidas);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== "POST") {
    return respostaJson({ erro: "Método não permitido." }, 405, cors);
  }

  try {
    const cfg = configDoAmbiente(Deno.env);

    // Autorização antes de qualquer outra coisa — inclusive antes de ler o
    // corpo. Nada de trabalho é feito para quem não pode pedir.
    const usuario = await exigirPapel(req, cfg, ["admin"]);

    let corpo: CorpoRequisicao = {};
    if (req.headers.get("Content-Type")?.includes("application/json")) {
      corpo = await req.json().catch(() => ({}));
    }

    const cred = credenciaisDoAmbiente(Deno.env);

    const filtro: FiltroTurmas = {};
    if (typeof corpo.anoLetivo === "number") filtro.AnoLetivo = corpo.anoLetivo;
    if (typeof corpo.cursoId === "number") filtro.CursoID = corpo.cursoId;
    if (typeof corpo.busca === "string" && corpo.busca.trim() !== "") {
      filtro.Nome = corpo.busca.trim();
    }

    const todas = await getTurmas(cred, filtro, { timeoutMs: 45_000 });

    const turmas = corpo.apenasMatriculaveis === false
      ? todas
      : filtrarMatriculaveis(todas, { anoLetivo: corpo.anoLetivo });

    console.log(
      JSON.stringify({
        evento: "sponte-turmas",
        usuario: usuario.userId,
        filtro,
        recebidas: todas.length,
        devolvidas: turmas.length,
      }),
    );

    return respostaJson({ turmas, total: turmas.length }, 200, cors);
  } catch (erro) {
    if (erro instanceof AutorizacaoError) {
      return respostaJson({ erro: erro.message }, erro.status, cors);
    }

    if (erro instanceof SponteError) {
      // O detalhe carrega XML de resposta do ERP e fica só no log da função.
      // Para o cliente vai uma mensagem sem eco da origem.
      console.error(
        JSON.stringify({
          evento: "sponte-erro",
          operacao: erro.operacao,
          tipo: erro.tipo,
          codigo: erro.codigo,
          mensagem: erro.message,
          detalhe: erro.detalhe?.slice(0, 1000),
        }),
      );

      const mensagem = erro.tipo === "timeout"
        ? "O Sponte demorou demais para responder. Tente novamente."
        : "Não foi possível consultar as turmas no Sponte.";

      return respostaJson({ erro: mensagem }, 502, cors);
    }

    // Configuração ausente e defeito de código caem aqui. A mensagem real vai
    // para o log; o cliente recebe algo genérico.
    console.error(
      JSON.stringify({
        evento: "erro-inesperado",
        mensagem: erro instanceof Error ? erro.message : String(erro),
      }),
    );
    return respostaJson({ erro: "Erro interno." }, 500, cors);
  }
});
