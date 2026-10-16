/**
 * Todo `/api/*` em produção, numa função só.
 *
 * Uma função de rota curinga, e não uma por endpoint, porque as rotas
 * compartilham tudo: os clientes das três plataformas, os caches do
 * catálogo, a sessão da interface web do Sponte e o porteiro de admin.
 * Espalhá-las em vinte arquivos multiplicaria esse custo de partida por
 * vinte, sem separar nada de verdade.
 *
 * A função não tem lógica própria: ela entrega o pedido ao mesmo `tratar`
 * que o servidor de desenvolvimento usa. É o que garante que o que foi
 * testado na máquina é o que roda aqui.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { tratar } from "../scripts/app.ts";

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await tratar(req, res);
}

export const config = {
  // O checkout encadeia várias chamadas SOAP ao Sponte, que é lento, e
  // ainda pode abrir a interface web para gerar o link de pagamento. O
  // padrão de 10 s cortaria a matrícula no meio — e no Sponte não há como
  // desfazer o que já entrou.
  maxDuration: 300,
};
