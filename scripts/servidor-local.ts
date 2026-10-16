/**
 * Servidor de desenvolvimento.
 *
 *     node --env-file=.env scripts/servidor-local.ts
 *
 * Serve as páginas da raiz do projeto e entrega todo `/api/*` ao
 * `tratar` de `app.ts` — o mesmo que a função da Vercel usa em produção.
 * Aqui dentro só existe o que **não** vai para produção: a porta, os
 * arquivos estáticos e os ciclos em `setInterval`, que em produção são
 * cron da Vercel.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

import {
  ciclos, codigoClienteSponte, escritaLiberada, modoTeste, tratar,
} from "./app.ts";

const PORTA = Number(process.env.PORTA ?? 5173);
const RAIZ = resolve(import.meta.dirname, "..");

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const servidor = createServer(async (req, res) => {
  const rota = new URL(req.url ?? "/", "http://interno").pathname;

  // Tudo que é do sistema vai para o mesmo tratador de produção.
  if (rota.startsWith("/api/")) return void tratar(req, res);

  /* --- Estáticos: só existem aqui; na Vercel quem serve é a plataforma --- */
  try {
    const pedido = rota === "/" ? "/admin-turmas.html" : rota;
    const alvo = resolve(join(RAIZ, normalize(decodeURIComponent(pedido))));
    // Sem isto, `/../../.env` serviria o arquivo de credenciais.
    if (!alvo.startsWith(RAIZ + sep) && alvo !== RAIZ) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Fora da raiz");
      return;
    }
    const conteudo = await readFile(alvo);
    res.writeHead(200, {
      "Content-Type": TIPOS[extname(alvo).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(conteudo);
  } catch (erro) {
    const faltou = (erro as NodeJS.ErrnoException)?.code === "ENOENT";
    res.writeHead(faltou ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" })
      .end(faltou ? "404" : "500");
  }
});

/**
 * Os ciclos periódicos, que em produção são cron da Vercel.
 *
 * `unref` para que não segurem o processo vivo sozinhos.
 */
for (const c of ciclos) {
  setInterval(() => {
    c.executar()
      .then((linha) => { if (linha) console.log(`  ${linha}`); })
      .catch((e) => console.error(`  [${c.nome}] falhou: ${e.message}`));
  }, c.intervaloMs).unref();
}

servidor.listen(PORTA, () => {
  console.log(`\n  Servidor de desenvolvimento no ar.\n`);
  console.log(`    Turmas   http://localhost:${PORTA}/admin-turmas.html`);
  console.log(`    Alunos   http://localhost:${PORTA}/admin-alunos.html`);
  console.log(`\n  Dados:   Supabase (${process.env.SUPABASE_URL})`);
  console.log(`  Sponte:  cliente ${codigoClienteSponte() ?? '(sem chave configurada)'}`);

  if (!escritaLiberada) {
    console.log(`\n  Escrita no Sponte DESLIGADA — o checkout roda em simulação.\n`);
    return;
  }
  const barra = "!".repeat(68);
  console.log(`\n  ${barra}`);
  console.log(`  ESCRITA NO SPONTE LIGADA — cliente ${codigoClienteSponte()} (PRODUÇÃO)`);
  console.log(modoTeste
    ? `  Registros nascem com o prefixo "TESTE-SISTEMA".`
    : `  *** SEM MARCAÇÃO *** os registros se misturam aos reais.`);
  console.log(`  Não há exclusão na API: o que for criado sai pela interface.`);
  console.log(`  Ao terminar:  node --env-file=.env scripts/limpar-testes.ts`);
  console.log(`  ${barra}\n`);
});
