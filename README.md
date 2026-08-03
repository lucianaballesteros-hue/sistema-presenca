# Sistema de Presença

Gestão de turmas, alunos e frequência (Financial Experts), com backend em [Supabase](https://supabase.com) (Postgres + Auth). É um front-end estático — sem framework, sem passo de build — organizado em módulos ES nativos do navegador.

Inclui também um **sistema de reposição de aulas**: a equipe gera um link (sem login) para o aluno/responsável escolher um horário de reposição, numa página separada do painel principal (`reposicao.html`).

> Para uma explicação detalhada de cada parte do sistema (o que cada arquivo faz, como os dados fluem, o modelo de dados inferido), veja [`ARQUITETURA.md`](ARQUITETURA.md).

## Estrutura

```
index.html              ponto de entrada do painel (equipe, autenticado)
reposicao.html          ponto de entrada da página pública de reposição (aluno/responsável, sem login)
styles/                 CSS organizado por base/ (reset, tema) → layout/ (header, nav, content) → components/
                        + public-reposicao.css (autocontido, só da página de reposição)
src/
  config/               credenciais do Supabase (env.js, não versionado — veja env.example.js)
  api/                  acesso a dados: um arquivo por tabela (turmasRepo, alunosRepo, presencasRepo, historicoRepo, professoresRepo, reposicoesRepo)
  state/                estado mutável central da aplicação (store.js)
  domain/               regras de negócio puras (cálculo de frequência/alerta, status)
  shared/               utilitários genéricos (escape de HTML, toasts, navegação entre abas)
  features/             uma pasta por área da tela (auth, dashboard, chamada, alunos, professores, relatorios, metricas, reposicoes)
  public/               código da página pública de reposição — isolado, não importa nada de state/features/api do painel
  main.js               bootstrap do painel: liga os módulos e expõe as funções que o HTML chama
sql/                    scripts para rodar manualmente no SQL Editor do Supabase (schema da reposição + verificação/reforço de RLS)
img/                    logos
```

Cada `feature` só conhece o `state` compartilhado e as funções de `api`/`domain`/`shared` de que precisa — não há um arquivo "faz tudo".

## Rodando localmente

1. Copie `src/config/env.example.js` para `src/config/env.js` e preencha com a URL e a chave **anon** do seu projeto Supabase (Project Settings → API). Esse arquivo já vem preenchido neste repositório com o projeto atual — só recrie se for apontar para outro projeto Supabase.
2. Rode uma vez, no SQL Editor do painel Supabase, o arquivo [`sql/reposicoes.sql`](sql/reposicoes.sql) — cria as tabelas/policies/funções do sistema de reposição (só precisa disso; o painel principal usa tabelas que já existiam antes). Veja [`sql/verificar_seguranca.sql`](sql/verificar_seguranca.sql) e [`sql/reforcar_rls.sql`](sql/reforcar_rls.sql) para conferir/fechar o acesso anônimo nas tabelas antigas — detalhes na seção de segurança abaixo.
3. Como o `index.html`/`reposicao.html` carregam módulos ES (`<script type="module">`), o navegador bloqueia isso se você abrir o arquivo direto (`file://...`) — é preciso servir por HTTP. Qualquer servidor estático simples resolve, por exemplo:
   - Extensão **Live Server** do VS Code (botão "Go Live"), ou
   - `python -m http.server` na pasta do projeto (se tiver Python), ou
   - qualquer outro servidor estático de sua preferência.
4. Não há build: para publicar, basta subir os arquivos deste diretório (menos `src/config/env.js`, que cada ambiente configura por conta própria, e a pasta `sql/`, que não é servida — só usada uma vez no Supabase) para o mesmo tipo de hospedagem estática já usada hoje. Não esqueça de incluir `reposicao.html`, `src/public/` e `styles/public-reposicao.css`/`styles/components/reposicoes.css` junto com o resto.

## Notas de segurança

- **Credenciais isoladas em `src/config/env.js`** (fora do controle de versão). Isso não torna a chave "anon" secreta — ela é pública por natureza em qualquer app Supabase, pois vai embutida no navegador. O ganho é não misturar configuração de ambiente com código-fonte e poder trocar/rotacionar a chave sem gerar diff no histórico.
- **A separação admin/professor na interface é conveniência, não segurança.** A aba "Professores" some da tela para quem não é admin, mas isso só esconde botões — qualquer usuário autenticado pode chamar as mesmas funções pelo console do navegador. A proteção real contra um professor comum criar/editar outros professores, ver turmas de outra pessoa, etc. precisa ser feita com **Row Level Security (RLS)** nas tabelas do Supabase (`turmas`, `alunos`, `presencas`, `professores`, `historico`), validando o papel do usuário no banco.
- **A página pública de reposição (`reposicao.html`) usa a mesma chave anon do painel** — isso é inevitável (é a mesma chave que qualquer visitante do `index.html` já carrega antes de logar). O que realmente impede um aluno de acessar dados de outros alunos/turmas é RLS: as tabelas `reposicoes`/`reposicao_opcoes` já nascem com RLS ligado e zero acesso para quem não está autenticado (só duas funções SQL estreitas, validadas por token). Já as tabelas antigas (`turmas`, `alunos`, `presencas`, `historico`, `professores`) tinham policies liberadas para **qualquer role** (`{public}`, o que inclui `anon`) — rode [`sql/verificar_seguranca.sql`](sql/verificar_seguranca.sql) para conferir o estado atual e [`sql/reforcar_rls.sql`](sql/reforcar_rls.sql) para restringi-las a `authenticated` sem alterar a lógica de quem vê o quê (ver `ARQUITETURA.md`, seção 15, ponto 5).
- **Trocar a senha de outra pessoa a partir do navegador não é possível** (e não deveria ser): isso exigiria a chave `service_role` do Supabase, que nunca pode existir no lado do cliente. O código anterior tentava isso com a chave pública e falhava silenciosamente às vezes; foi removido. O único fluxo válido é o botão "Enviar reset de senha", que manda um e-mail para o próprio professor escolher a senha nova.
- **Senha padrão de professores novos (`Teste1234`)** continua como está — é uma decisão de produto, não um bug de código. Recomendação para o futuro: forçar troca de senha no primeiro acesso.
