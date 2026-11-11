/**
 * "Pagar com cartão de crédito": leva o aluno à página onde o cartão
 * recorrente de fato se cadastra.
 *
 * O link que o aluno recebe é o da **parcela** (`SpontePay.aspx`). Ele
 * oferece Pix, boleto e cartão recorrente, mas o cartão recorrente não
 * grava por ali — o Sponte responde sucesso e descarta. Grava pela página
 * do **plano** (`DetalhePlano.aspx`), porque a recorrência vale para todas
 * as parcelas. Ver o bloco "Cartão recorrente" em `sponte-web.ts`.
 *
 * Então a tela de pagamento tem dois botões: Pix ou boleto, que segue para
 * o link da parcela como sempre; e cartão, que passa por aqui.
 */

import {
  escolherCartaoRecorrente,
  linkDoPlano,
  type SponteWeb,
} from "./sponte-web.ts";

export interface FichaParaCartao {
  id: number;
  status: string | null;
  pagamentoLink: string | null;
  contaReceberId: number | null;
}

export type ResultadoCartao =
  | { ok: true; link: string; jaEstava: boolean }
  | { ok: false; motivo: string; erro: string };

export async function prepararPagamentoCartao(
  f: FichaParaCartao,
  d: {
    web: SponteWeb | null;
    escritaLiberada: boolean;
    registrar: (e: Record<string, unknown>) => void;
  },
): Promise<ResultadoCartao> {
  const falha = (motivo: string, erro: string): ResultadoCartao => {
    d.registrar({
      tipo: "sponte", operacao: "pagar com cartão (falhou)", cadastroId: f.id,
      ok: false, erro, detalhe: { motivo, contaReceberId: f.contaReceberId },
    });
    return { ok: false, motivo, erro };
  };

  if (!f.pagamentoLink || !f.contaReceberId) {
    return falha("sem_link", "a matrícula ainda não tem link de pagamento");
  }
  // Sem escrita liberada, escolher a recorrência mudaria o plano no ERP de
  // verdade — exatamente o que a simulação promete não fazer.
  if (!d.escritaLiberada) {
    return falha("simulado", "escrita no Sponte desligada: nada a preparar");
  }
  if (!d.web) {
    return falha("sem_acesso_web", "credenciais da interface do Sponte não configuradas");
  }

  const t0 = Date.now();
  const escolha = await escolherCartaoRecorrente(f.pagamentoLink);
  if (escolha.ok === false) return falha(escolha.estado, escolha.motivo);

  const link = await linkDoPlano(d.web, f.contaReceberId);
  if (!link) {
    return falha("sem_link_plano",
      "o plano está em recorrência, mas o Sponte não gerou o link do plano");
  }

  d.registrar({
    tipo: "sponte", operacao: "pagar com cartão", cadastroId: f.id, ok: true,
    duracaoMs: Date.now() - t0,
    detalhe: { contaReceberId: f.contaReceberId, recorrenciaJaEstava: escolha.jaEstava },
  });
  return { ok: true, link, jaEstava: escolha.jaEstava };
}
