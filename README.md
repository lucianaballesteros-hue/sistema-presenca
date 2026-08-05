# Sistema de Presença

Gestão de turmas, alunos e frequência (Financial Experts), com backend em [Supabase](https://supabase.com) (Postgres + Auth). É um front-end estático — sem framework, sem passo de build — organizado em módulos ES nativos do navegador.

Inclui também um **sistema de reposição de aulas**: a equipe gera um link (sem login) para o aluno/responsável escolher um horário de reposição, numa página separada do painel principal (`reposicao.html`).

> Para uma explicação detalhada de cada parte do sistema (o que cada arquivo faz, como os dados fluem, o modelo de dados inferido), veja [`ARQUITETURA.md`](ARQUITETURA.md).

## Estrutura de pastas

```
index.html              ponto de entrada do painel (equipe, autenticado)
reposicao.html          ponto de entrada da página pública de reposição (aluno/responsável, sem login)
.env                    referência local de credenciais/contexto do projeto (fora do git — veja .gitignore)
backend/                camada de dados: fala com o Supabase e concentra as regras de negócio
  config/               credenciais do Supabase (env.js — veja env.example.js)
  api/                  acesso a dados: um arquivo por tabela (turmasRepo, alunosRepo, presencasRepo, historicoRepo, professoresRepo, reposicoesRepo)
  domain/               regras de negócio puras (cálculo de frequência/alerta, status)
frontend/               camada de interface: telas, estado da UI, estilos e assets
  main.js               bootstrap do painel: liga os módulos e expõe as funções que o HTML chama
  features/             uma pasta por área da tela (auth, dashboard, chamada, alunos, professores, relatorios, metricas, reposicoes)
  state/                estado mutável central da aplicação (store.js)
  shared/                utilitários genéricos (escape de HTML, toasts, navegação entre abas)
  styles/                CSS organizado por base/ (reset, tema) → layout/ (header, nav, content) → components/
                         + public-reposicao.css (autocontido, só da página de reposição)
  public/                código da página pública de reposição — isolado, não importa nada de state/features do painel
  img/                   logos usadas pelo painel e pela página pública
```

**Por que só duas pastas na raiz (`backend/`/`frontend/`) e o que cada uma faz:**

- **`backend/`** — tudo que sabe *o que* fazer com os dados: como falar com cada tabela do Supabase (`api/`), quais credenciais usar (`config/`) e as regras de negócio que calculam frequência/alerta/status a partir dos dados (`domain/`). Um `feature` nunca fala com o Supabase direto — sempre passa por um arquivo de `backend/api/`.
- **`frontend/`** — tudo que sabe *como mostrar* isso na tela: cada área do painel (`features/`), o estado compartilhado que guarda o que já foi carregado (`state/`), utilitários de UI (`shared/`), o CSS (`styles/`) e as imagens (`img/`). `main.js` é a única ponte entre o HTML e os módulos — é ele que registra as funções em `window` para o `onclick="..."` do HTML conseguir chamá-las.

**Cuidado com o nome**: apesar de se chamarem "backend" e "frontend", **as duas pastas rodam no navegador** — não existe servidor Node/Python neste repositório. O back-end de verdade é o Supabase, hospedado fora deste repo (veja `ARQUITETURA.md`, seção 1). A divisão aqui é só organizacional (separar "fala com dados" de "mostra na tela"); as duas pastas precisam continuar sendo publicadas juntas, como um único site estático — não são dois deploys separados, e uma não funciona sem a outra.

`index.html` e `reposicao.html` ficam na **raiz** (fora de `frontend/`) de propósito: é onde a hospedagem atual (Vercel, sem `vercel.json`) espera encontrar os pontos de entrada.

> ⚠️ A pasta `sql/` citada na seção "Rodando localmente" abaixo (e no `ARQUITETURA.md`) **não existe neste repositório** — os scripts `.sql` mencionados nunca foram commitados. Se você tiver esses arquivos em outro lugar, adicione-os em `sql/` na raiz; senão, essas etapas de configuração do Supabase precisam ser refeitas a partir do zero olhando o modelo de dados no `ARQUITETURA.md`.

Cada `feature` só conhece o `state` compartilhado e as funções de `backend/api`/`backend/domain`/`shared` de que precisa — não há um arquivo "faz tudo".

## Rodando localmente

1. Copie `backend/config/env.example.js` para `backend/config/env.js` e preencha com a URL e a chave **anon** do seu projeto Supabase (Project Settings → API). Esse arquivo já vem preenchido neste repositório com o projeto atual — só recrie se for apontar para outro projeto Supabase.
2. Rode uma vez, no SQL Editor do painel Supabase, o arquivo [`sql/reposicoes.sql`](sql/reposicoes.sql) — cria as tabelas/policies/funções do sistema de reposição (só precisa disso; o painel principal usa tabelas que já existiam antes). Veja [`sql/verificar_seguranca.sql`](sql/verificar_seguranca.sql) e [`sql/reforcar_rls.sql`](sql/reforcar_rls.sql) para conferir/fechar o acesso anônimo nas tabelas antigas — detalhes na seção de segurança abaixo.
3. Como o `index.html`/`reposicao.html` carregam módulos ES (`<script type="module">`), o navegador bloqueia isso se você abrir o arquivo direto (`file://...`) — é preciso servir por HTTP. Qualquer servidor estático simples resolve, por exemplo:
   - Extensão **Live Server** do VS Code (botão "Go Live"), ou
   - `python -m http.server` na pasta do projeto (se tiver Python), ou
   - qualquer outro servidor estático de sua preferência.
4. Não há build: para publicar, basta subir os arquivos deste diretório (menos `backend/config/env.js`, que cada ambiente configura por conta própria, e a pasta `sql/`, que não é servida — só usada uma vez no Supabase) para o mesmo tipo de hospedagem estática já usada hoje. Não esqueça de incluir `reposicao.html`, `frontend/public/` e `frontend/styles/public-reposicao.css`/`frontend/styles/components/reposicoes.css` junto com o resto.

## Notas de segurança

- **Credenciais isoladas em `backend/config/env.js`** (fora do controle de versão). Isso não torna a chave "anon" secreta — ela é pública por natureza em qualquer app Supabase, pois vai embutida no navegador. O ganho é não misturar configuração de ambiente com código-fonte e poder trocar/rotacionar a chave sem gerar diff no histórico.
- **A separação admin/professor na interface é conveniência, não segurança.** A aba "Professores" some da tela para quem não é admin, mas isso só esconde botões — qualquer usuário autenticado pode chamar as mesmas funções pelo console do navegador. A proteção real contra um professor comum criar/editar outros professores, ver turmas de outra pessoa, etc. precisa ser feita com **Row Level Security (RLS)** nas tabelas do Supabase (`turmas`, `alunos`, `presencas`, `professores`, `historico`), validando o papel do usuário no banco.
- **A página pública de reposição (`reposicao.html`) usa a mesma chave anon do painel** — isso é inevitável (é a mesma chave que qualquer visitante do `index.html` já carrega antes de logar). O que realmente impede um aluno de acessar dados de outros alunos/turmas é RLS: as tabelas `reposicoes`/`reposicao_opcoes` já nascem com RLS ligado e zero acesso para quem não está autenticado (só duas funções SQL estreitas, validadas por token). Já as tabelas antigas (`turmas`, `alunos`, `presencas`, `historico`, `professores`) tinham policies liberadas para **qualquer role** (`{public}`, o que inclui `anon`) — rode [`sql/verificar_seguranca.sql`](sql/verificar_seguranca.sql) para conferir o estado atual e [`sql/reforcar_rls.sql`](sql/reforcar_rls.sql) para restringi-las a `authenticated` sem alterar a lógica de quem vê o quê (ver `ARQUITETURA.md`, seção 15, ponto 5).
- **Trocar a senha de outra pessoa a partir do navegador não é possível** (e não deveria ser): isso exigiria a chave `service_role` do Supabase, que nunca pode existir no lado do cliente. O código anterior tentava isso com a chave pública e falhava silenciosamente às vezes; foi removido. O único fluxo válido é o botão "Enviar reset de senha", que manda um e-mail para o próprio professor escolher a senha nova.
- **Senha padrão de professores novos (`Teste1234`)** continua como está — é uma decisão de produto, não um bug de código. Recomendação para o futuro: forçar troca de senha no primeiro acesso.
