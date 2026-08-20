# Arquitetura do Sistema de Presença

Este documento explica, em detalhe, o que cada parte do código faz e como elas se conectam. É o complemento "por dentro" do `README.md` (que foca em como rodar o projeto).

## Índice

1. [Visão geral](#1-visão-geral)
2. [Como tudo se conecta](#2-como-tudo-se-conecta)
3. [`index.html`](#3-indexhtml)
4. [`frontend/styles/`](#4-frontendstyles)
5. [`backend/config/`](#5-backendconfig)
6. [`frontend/state/store.js`](#6-frontendstatestorejs)
7. [`backend/api/`](#7-backendapi--repositórios)
8. [`backend/domain/`](#8-backenddomain--regras-de-negócio)
9. [`frontend/shared/`](#9-frontendshared--utilitários)
10. [`frontend/features/`](#10-frontendfeatures)
11. [`frontend/main.js`](#11-frontendmainjs--a-raiz-de-composição)
12. [Modelo de dados (inferido)](#12-modelo-de-dados-inferido)
13. [Fluxos completos, passo a passo](#13-fluxos-completos-passo-a-passo)
14. [O que existe fora deste código](#14-o-que-existe-fora-deste-código)
15. [Segurança — resumo](#15-segurança--resumo)
16. [Sistema de Reposição de Aulas](#16-sistema-de-reposição-de-aulas)

---

## 1. Visão geral

O sistema é um painel para a equipe da Financial Experts controlar **cursos**, **turmas**, **alunos** e **presença** (chamada), gerar **relatórios** e **métricas** de frequência/evasão/conversão, e administrar **professores** (usuários do sistema) e a **exclusão permanente** de registros.

- **Front-end**: HTML + CSS + JavaScript puro, sem framework (nada de React/Vue) e sem passo de build (nada de Vite/webpack). Os módulos JS usam `import`/`export` nativos do navegador.
- **Back-end**: [Supabase](https://supabase.com) — um Postgres hospedado com API REST automática e autenticação prontas. O front-end fala diretamente com o Supabase pelo SDK `@supabase/supabase-js` (carregado via CDN no `index.html`).
- **Exportação**: a biblioteca `xlsx` (SheetJS, também via CDN) tanto gera o `.xlsx` do relatório quanto **lê** planilhas na importação em massa de alunos.
- **Sem servidor próprio**: não há backend Node/Python neste repositório. Tudo que hoje é "lógica de servidor" (autenticação, permissões, e-mails automáticos) é responsabilidade do próprio Supabase ou de algo fora deste código (veja [seção 14](#14-o-que-existe-fora-deste-código)).
- **Sem passo de build ⇒ `backend/config/env.js` vai commitado.** Isso é abordado com detalhe no `README.md`, mas vale repetir aqui porque contraria a intuição: normalmente um arquivo de configuração de ambiente fica fora do controle de versão, mas como não existe injeção de variáveis em tempo de deploy (Vercel serve os arquivos do repositório como estão), `env.js` precisa estar commitado para a aplicação funcionar em produção. Um commit anterior já tentou removê-lo do versionamento e isso quebrou o deploy.

---

## 2. Como tudo se conecta

Fluxo de uma tela típica, do clique até a tela atualizar:

```
usuário clica um botão (onclick="marcar(...)")
        │
        ▼
função da feature (ex.: features/chamada/chamadaView.js → marcar())
        │  atualiza o cache local (state.PRESENCAS) e re-renderiza na hora,
        │  para a tela responder instantaneamente
        ▼
chama o repositório (ex.: api/presencasRepo.js → salvarPresenca())
        │
        ▼
repositório fala com o Supabase (sb.from('presencas').upsert(...))
        │
        ▼
se der erro, a feature desfaz a mudança local e avisa com um toast
```

Duas ideias seguram esse fluxo:

- **`state` central** (`frontend/state/store.js`): um objeto só, importado por quase todo mundo, com os dados carregados (turmas, alunos, presenças, cursos...) e o "estado da tela" (qual aluno está selecionado, qual filtro está ativo etc.). Não existe estado duplicado escondido em variáveis locais de cada arquivo.
- **Ponte para o HTML** (`frontend/main.js`): como o HTML chama funções por nome (`onclick="abrirChamada(5)"`), e módulos ES não criam variáveis globais automaticamente, o `main.js` importa a função de cada feature e a registra explicitamente em `window`. É a única parte do código onde isso acontece — todo o resto é import/export normal.

---

## 3. `index.html`

Um único HTML com todas as telas dentro (nenhuma navegação de página — é uma SPA "manual"). Principais blocos, na ordem:

| Bloco | O que é |
|---|---|
| `<head>` | Ícone, `<meta name="app-version">` (lido por `updateNotifier.js`), os dois `<script>` de CDN (Supabase e xlsx), um script inline que aplica o tema salvo **antes** do CSS carregar (evita flash de tela clara ao abrir no escuro), e as 18 `<link rel="stylesheet">` de `frontend/styles/`. |
| `#login-page` | Formulário de e-mail/senha. |
| `#recover-request-page` | Passo 1 da recuperação de senha: pedir o e-mail (escondido por padrão). |
| `#recovery-page` | Passo 2 da recuperação de senha: definir a nova senha, aberto pelo link recebido por e-mail (escondido por padrão). |
| `#app` | A aplicação depois de logado: `#chart-tooltip` (tooltip único e compartilhado de todos os gráficos de Métricas), cabeçalho (`.header`), menu de abas (`.nav`) e o conteúdo (`.content`). |
| `#tab-turmas` | Contém **duas visões que se alternam**: `#dash-view` (grade de turmas) e `#chamada-view` (fazer chamada de uma turma). Só uma fica visível por vez. |
| `#tab-alunos` | Tabela de alunos com filtros + botões "+ Novo aluno" e "Adicionar planilha" (importação em massa). |
| `#tab-relatorio` | Filtros (multi-select) + tabelas de frequência por turma + botão de exportar Excel. |
| `#tab-metricas` | Dashboard com seletor de foco (Geral / por curso), KPIs, gráficos SVG e tabelas comparativas. |
| `#tab-reposicoes` | Tabela de reposições já criadas, com busca e filtro por status. |
| `#tab-professores` | Grade de cartões de professores (só admin — mas **não fica no menu principal**, veja abaixo). |
| `#tab-configuracoes` | Zona de exclusão permanente de curso/turma/aluno (só admin — também fora do menu principal). |
| `.modal-bg#modal-*` | **Quinze modais**: aluno, criar reposição, link da reposição gerado, editar aluno, transferir aluno, novo aluno, conferência de importação de planilha, novo professor, editar professor, nova turma, editar turma, novo curso, editar curso, confirmar exclusão permanente, e o modal de confirmação genérico (substitui o `confirm()` nativo). Todos escondidos por padrão, abrem recebendo a classe `.open`. |
| `#toast`, `#app-loading`, `#update-banner` | Elementos de feedback global (aviso rápido, tela de carregamento, banner de "nova versão disponível"). |
| `<script type="module" src="frontend/main.js">` | Carrega a aplicação. Fica no fim do `<body>` para simplicidade, mas como é `type="module"`, o navegador já executa de forma adiada (equivalente a `defer`) — ou seja, roda depois que todo o HTML acima foi criado. |

**A barra de navegação (`.nav`) só tem 5 botões: Turmas, Alunos, Relatórios, Métricas, Reposições.** "Professores" e "Configurações" não estão lá — só são alcançáveis pelo ícone de engrenagem (`#btn-config`) no cabeçalho, visível apenas para admins, que abre um menu pequeno com as duas opções (ver [seção 10.8](#108-configuracoes--zona-de-exclusão-permanente-admin)). Consequência prática: `goTab()` (seção 9) só sabe destacar visualmente um dos 5 botões da `.nav` — ao navegar para "professores" ou "configuracoes", a tela troca normalmente, mas nenhum botão da barra fica marcado como ativo (não há um botão correspondente a apontar).

Quase todo elemento interativo tem um atributo inline (`onclick`, `onchange`, `oninput`, `onkeydown`) chamando uma função pelo nome — essas funções são exatamente as que o `main.js` registra em `window` (seção 11).

---

## 4. `frontend/styles/`

O CSS é dividido por responsabilidade. A ordem de carregamento no `<head>` importa (CSS depois sobrescreve CSS de antes):

```
base/reset.css          reset básico (*, body, a)
base/theme-tokens.css   TODAS as variáveis de cor (:root = tema claro, [data-theme="dark"] = escuro)
base/liquid-glass.css   camada transversal: transição/resposta tátil (:active{scale}) em qualquer elemento
                         clicável do sistema inteiro, aplicada uma única vez em vez de repetida por componente;
                         respeita prefers-reduced-motion
layout/header.css       cabeçalho fixo no topo (logo, ícone de tema, ícone de configurações, avatar, botão sair)
layout/nav.css          menu de abas (5 botões + pílula deslizante)
layout/content.css      container central + containers específicos da tela de chamada
components/login.css    card de login + as duas telas de recuperação de senha
components/buttons.css  TODOS os botões do sistema (primário, salvar, cancelar, perigo, aviso,
                         toggle de tema, presença P/F/R, presets de horário, categorias de observação...)
components/badges.css   selos coloridos (badge-verde/âmbar/vermelho/...) e as pills de filtro por curso
components/forms.css    campos de formulário, seletor de horário, seletor de dias, seletor de cor,
                         indicador "mostrar senha", classes .search-input e .field-error
components/cards.css    cards de estatística, turma, professor e as seções de métricas
components/tables.css   tabela padrão, barra de frequência, tabela de métricas
components/modals.css   estrutura dos modais + caixas de aviso/informação/perigo (.danger-box)
components/dots.css     os "pontinhos" de histórico no relatório + o menu que abre ao clicar neles
components/multiselect.css  barra de filtros + os dropdowns de múltipla escolha (relatório e o
                         componente genérico de "select estilizado" de customSelect.js)
components/metricas.css estilos do dashboard de Métricas: seletor de foco, KPIs, cards de gráfico,
                         donuts, tabelas comparativas, feed de atividade — o único conteúdo do
                         sistema que usa uma largura máxima maior que o padrão (@1680px em vez de @1200px)
components/toast.css    toast, tela de carregamento, banner de atualização, estado vazio
components/reposicoes.css  tabela/pills de status da aba Reposições + o card de sugestões automáticas
```

**Como funciona o tema escuro**: todas as cores usadas nos outros arquivos são `var(--nome)`. `theme-tokens.css` define esses nomes duas vezes — uma vez dentro de `:root` (valores claros) e outra dentro de `[data-theme="dark"]` (valores escuros). Quando `toggleTema()` (seção 10.1) adiciona `data-theme="dark"` na tag `<html>`, todas as variáveis trocam de valor de uma vez, sem tocar em nenhum outro CSS.

`frontend/styles/public-reposicao.css` é um arquivo **à parte**, carregado só por `reposicao.html` — não faz parte dessa cadeia (ver [seção 16.3](#163-lado-público-sem-login--reposicaohtml)).

---

## 5. `backend/config/`

- **`env.js`** (versionado, de propósito — ver [seção 1](#1-visão-geral) e o `README.md`): exporta `SUPABASE_URL` e `SUPABASE_ANON_KEY`, os únicos dois valores que mudam entre "ambientes" (ex.: se um dia existir um projeto Supabase de teste separado do de produção).
- **`env.example.js`**: o mesmo arquivo com valores de exemplo, para quem for apontar o projeto para um Supabase diferente saber o formato esperado.

Nenhum outro arquivo tem uma credencial hardcoded — todos importam de `config/env.js` (direto, ou indiretamente via `api/supabaseClient.js`).

---

## 6. `frontend/state/store.js`

Um único objeto exportado, `state`, com dezessete campos declarados explicitamente (mais um, `REPOSICOES`, que é criado dinamicamente na primeira vez que a aba Reposições carrega — ver abaixo). É o "banco de dados na memória" da aba aberta no navegador:

| Campo | Tipo | Para que serve |
|---|---|---|
| `TURMAS` | array | Todas as turmas visíveis para quem está logado (admin vê todas; professor só as suas). |
| `ALUNOS` | array | Todos os alunos das turmas acima. |
| `PRESENCAS` | objeto | Cache de presença, indexado por `"turmaId_NomeDaAula"` → `{ alunoId: 'P'|'R'|'F' }`. |
| `HISTORICO` | array | Toda movimentação (inativação, transferência, observação, exclusão de matrícula...) de todos os alunos carregados. |
| `PROFESSORES` | array | Todos os usuários do sistema (admins e professores). |
| `CURSOS` | array | Linhas da tabela `cursos` — a lista curada de nomes de curso oferecida nos `<select>` (ver [seção 7](#7-backendapi--repositórios) e [12](#12-modelo-de-dados-inferido) sobre por que isso não é uma FK). |
| `usuarioLogado` | objeto/null | O usuário do Supabase Auth (tem `.id`, `.email`). |
| `perfilLogado` | objeto/null | A linha correspondente na tabela `professores` (tem `.nome`, `.papel`). |
| `turmaAtual` | objeto/null | Turma aberta na tela de chamada. |
| `turmaEmEdicaoId` | number/null | Turma sendo editada no modal "Editar turma". |
| `filtroCurso` | string | Filtro ativo nas pills de curso do dashboard (`''`, um nome de curso, `'__minhas__'` ou `'__inativas__'`). |
| `metricasFoco` | string | Recorte ativo no seletor de foco da aba Métricas (`'geral'` ou a chave de um curso — `'Elas'`, `'Master'`, `'Evolution'`). |
| `alunoSelecionadoId` / `profSelecionadoId` | number/null | Quem está aberto no modal de detalhes. |
| `chamadaAlterada` | objeto | Reservado para marcar alterações não salvas na chamada — existe desde o código original, mas nada hoje lê esse valor (é reiniciado a cada `abrirChamada`, e não influencia o comportamento atual). |
| `dotMenuContext` | objeto/null | Qual aluno/turma/aula o menu de edição rápida (clique no pontinho) está editando. |
| `obsCategoriaSelecionada` | string/null | Categoria escolhida ao adicionar uma observação. |
| `REPOSICOES` *(não declarado)* | array | Criado em tempo de execução por `renderReposicoes()` (`reposicoesView.js`) na primeira vez que a aba Reposições é aberta/recarregada. Está listado aqui porque o resto do módulo de reposições lê/escreve `state.REPOSICOES` como se fosse um campo normal — só não aparece no objeto inicial de `store.js`. |

Qualquer módulo pode ler `state.TURMAS`, por exemplo; para **alterar**, também se mexe direto no objeto (`state.TURMAS.push(...)`, `state.filtroCurso = 'x'`) — não existem "actions" ou um padrão Redux aqui, é deliberadamente simples.

---

## 7. `backend/api/` — repositórios

Cada arquivo corresponde a uma tabela do Supabase e é o **único lugar** que fala com `sb` (o cliente Supabase) para aquela tabela. As features nunca chamam `sb` diretamente (exceto `auth.js`/`recovery.js`, que tratam login/logout/sessão/senha — ver seção 10.2).

| Arquivo | Tabela | Funções |
|---|---|---|
| `supabaseClient.js` | — | Cria e exporta `sb = supabase.createClient(...)`. |
| `turmasRepo.js` | `turmas` | `carregarTurmas()` (preenche `state.TURMAS`, filtrando por `professor_id` se não for admin), `inserirTurma()`, `atualizarTurma()`, `excluirTurma()` (DELETE de verdade, com `.select()` para detectar bloqueio por RLS), `desvincularAlunosDaTurma()` (`alunos.turma_id = null` em massa — chamado antes de excluir uma turma que ainda tem alunos). |
| `alunosRepo.js` | `alunos` | `carregarAlunos()` (pagina de 1000 em 1000 linhas — ver abaixo — e é resiliente a chamadas concorrentes, ver 10.2), `inserirAluno()`, `atualizarAluno()`, `atualizarAlunosEmLote()` (usado para inativar/reativar em massa quando uma turma é inativada), `excluirAluno()` (DELETE de verdade, com `.select()`). |
| `presencasRepo.js` | `presencas` | `carregarPresencas()` (também paginado), `salvarPresenca()` (upsert por `turma_id+aluno_id+aula`), `removerPresenca()`, `moverPresencasDeTurma()` (usado na transferência de turma), `excluirPresencasDeAluno()` (usado na exclusão permanente do aluno). |
| `historicoRepo.js` | `historico` | `carregarHistorico()`, `registrarMovimentacao()`, `registrarMovimentacoesEmLote()`, `carregarObservacoes()` / `registrarObservacao()` (mesma tabela, filtrando por `tipo = 'observacao'`), `excluirHistoricoDeAluno()` (exclusão permanente do aluno). |
| `professoresRepo.js` | `professores` + Auth | `carregarProfessores()`, `criarContaAuth()` (chama o endpoint público de signup do Supabase Auth via `fetch`, sem afetar a sessão do admin logado), `criarPerfilProfessor()`, `atualizarProfessor()`, `enviarResetSenha()` (usado tanto pelo modal de editar professor quanto pela tela pública "Esqueci minha senha", ver 10.2b). |
| `cursosRepo.js` | `cursos` | `carregarCursos()`, `inserirCurso()`, `atualizarCurso()`, `excluirCurso()` (DELETE de verdade), `renomearTurmasDoCurso()` (propaga um rename para todas as `turmas.curso` com o nome antigo — ver por quê abaixo), `desvincularTurmasDoCurso()` (`turmas.curso = null` em massa, antes de excluir um curso ainda em uso), `sincronizarCursosComTurmas()` (cadastra em `cursos` qualquer nome presente em `turmas.curso` que ainda não exista lá, rodado uma vez a cada login — ver [seção 10.2](#102-authauthjs--login-logout-boot-da-aplicação)). |
| `reposicoesRepo.js` | `reposicoes` + `reposicao_opcoes` | `carregarReposicoes()` (duas consultas simples + junção no JS — de propósito não usa o "embedded select" do PostgREST `select('*, reposicao_opcoes(*)')`, que depende do cache de schema já reconhecer a FK entre as tabelas e pode falhar silenciosamente logo após a migração), `criarReposicao()`, `excluirReposicoesDeAluno()` (exclusão permanente do aluno — precisa apagar `reposicao_opcoes` antes, já que essa tabela não tem `aluno_id` direto), `cancelarReposicao()`, `concluirReposicao()`, `buscarOpcaoReposicao()`, `assinarMudancasReposicoes()` (Realtime — ver 10.9). Usado só pelo painel autenticado; a página pública (seção 16) não usa este arquivo, fala com o Supabase por duas funções SQL separadas. |

**`cursos` não é uma FK de `turmas.curso`.** A tabela `cursos` foi criada bem depois de `turmas.curso` já existir como texto livre (o mesmo texto livre interpretado por `corBadge`/`temaCurso`, ver seção 8.2) — então hoje ela funciona como uma **lista curada de sugestões** para os `<select>` de curso, não como fonte de verdade. Isso tem duas consequências que aparecem espalhadas pelo código:
1. **Renomear um curso precisa reescrever toda `turmas.curso` que usava o nome antigo** (`renomearTurmasDoCurso`, chamado antes de `atualizarCurso` em `configuracoesView.js`) — senão as turmas "antigas" ficam presas a um nome que já não existe na lista e `sincronizarCursosComTurmas()` recriaria esse nome como um curso órfão no próximo login.
2. Turmas cadastradas antes da tabela `cursos` existir (ou cujo nome de curso foi digitado livremente) podem citar um curso sem linha correspondente — `sincronizarCursosComTurmas()` cobre essa lacuna automaticamente a cada login.

**Por que paginar `alunos` e `presencas` manualmente**: o Supabase/PostgREST limita cada resposta a um número máximo de linhas. Essas duas funções fazem um laço `while (true)` pedindo 1000 linhas por vez (`.range(from, from+999)`) até a resposta vir vazia ou menor que 1000 — sinal de que acabou. `carregarAlunos()` também é escrita para tolerar duas chamadas concorrentes (monta a lista numa variável local e só escreve em `state.ALUNOS` no final) — ver [seção 10.2](#102-authauthjs--login-logout-boot-da-aplicação) para o motivo.

**Padrão `.select()` + checagem de `data.length` nos DELETEs.** O Supabase/PostgREST não retorna erro quando uma policy de RLS impede um `DELETE` de casar com nenhuma linha — a resposta vem "bem-sucedida" com `data: []` mesmo sem apagar nada. Por isso `excluirAluno`, `excluirTurma` e `excluirCurso` sempre encadeiam `.select()` no fim da query: sem os dados retornados, quem chama não teria como diferenciar "apaguei" de "RLS bloqueou silenciosamente". Quem realmente confere isso é `erroSeNadaApagado()` em `configuracoesView.js` (seção 10.8) — o único lugar do sistema que faz `DELETE` de verdade.

---

## 8. `backend/domain/` — regras de negócio

Funções puras (sem tocar no DOM nem no Supabase) que calculam coisas a partir do `state`.

### 8.1 `attendance.js`

- **`AULAS`**: lista fixa `['Aula 1', ..., 'Aula 32']` — o sistema suporta turmas de até 32 aulas.
- **`aulasDaTurma(turma)`**: recorta `AULAS` no `total_aulas` configurado da turma (ou usa as 32 se não configurado).
- **`ultimaAulaRegistrada(turma)`**: última aula da turma que já tem algum registro de presença (olha só `state.PRESENCAS`, nenhuma consulta nova). Usado no cartão de turma do dashboard (10.3, badge "Última Aula: N") e na dica visual do modal de reposição.
- **`registroPorAulaDaTurma(turma)`**: array de booleanos (um por aula da turma) dizendo se já existe algum registro de presença naquela aula — usado pelos "quadradinhos" clicáveis da tela de chamada (10.4) para colorir de verde as aulas já lançadas.
- **`proximaAula(turma)`**: a aula seguinte à última já registrada (`ultimaAulaRegistrada` + 1). Usada só para sugerir automaticamente outras turmas do mesmo curso "no ponto certo" para receber um aluno em reposição (10.9).
- **`proximaDataTurma(turma, agora)`**: data (`YYYY-MM-DD`) da próxima ocorrência do horário fixo da turma (`dias_semana` + `horario_inicio`) a partir de agora, olhando até 14 dias à frente. Não existe uma coluna no banco dizendo em que data exata cada "Aula N" aconteceu — por isso essa sugestão de data é sempre "a próxima vez que essa turma se encontra", nunca uma data retroativa. Usada junto com `proximaAula` nas sugestões automáticas de reposição.
- **`calcAluno(aluno)`** — a função mais importante do sistema. Para um aluno, percorre todas as aulas da turma dele e devolve:
  - `seq`: a sequência de status (`'P'|'R'|'F'|'N'`, sendo `'N'` = não registrado) aula a aula. **Quando a turma do aluno não existe mais** (foi excluída permanentemente pela aba Configurações — seção 10.8), não há como enumerar "as aulas da turma"; nesse caso `seq` é montada varrendo `state.PRESENCAS` inteiro atrás de qualquer chave com registro desse aluno (de qualquer turma, mesmo já excluída), ordenada por id de turma e depois pela posição da aula na lista fixa `AULAS` (não pela ordem alfabética da chave, onde "Aula 10" viria antes de "Aula 2"). O histórico de presença pertence ao aluno, não à turma — continua existindo mesmo depois que a turma "dona" das aulas deixa de existir.
  - `p`: total de presenças, **contando `P` e `R` juntos** (gravação conta como presença).
  - `r`: quantas dessas foram especificamente gravação (`R`), separado, só para exibir.
  - `f`: total de faltas.
  - `freq`: `p / (p + f)` em porcentagem arredondada — ou `null` se não há nenhuma aula com `P`/`F` registrada ainda (não penaliza quem ainda não teve nenhuma aula lançada).
  - `maxConsec`: maior sequência de faltas seguidas em toda a turma.
  - `emAlerta`: **regra de alerta** — olha só as **últimas 8 aulas que têm algum registro** (ignora as sem registro) e verifica se há 3 ou mais faltas seguidas dentro delas. Isso é o que pinta o aluno de vermelho no sistema inteiro.

### 8.2 `status.js`

- **`freqBar(freq)`**: HTML de uma barrinha colorida (verde ≥70%, âmbar ≥50%, vermelho abaixo) + o número.
- **`statusBadge(freq, emAlerta, ativo)`**: decide o selo textual — nessa ordem de prioridade: Inativo → ⚠ Alerta → Sem registro → Regular (≥70%) → Atenção (<70%).
- **`TEMAS_CURSO` / `temaCurso(curso)`**: fonte única de identidade visual por curso — cor de badge, cor "cheia", cor suave, gradiente (só nos cursos com dashboard de foco dedicado) e logo, tudo mapeado a partir de uma palavra-chave no **nome** do curso ("Elas", "Master", "Evolution", "Clube"; qualquer outro nome cai no cinza). É baseado em texto, não em um ID de curso — mesmo com a tabela `cursos` existindo hoje (seção 7), o campo `turmas.curso` continua sendo texto livre.
- **`corBadge(curso)`**: `temaCurso(curso)?.badge`, usado nas tabelas e cards.
- **`logoCurso(curso)`**: `temaCurso(curso)?.logo` — caminho do arquivo em `frontend/img/`, usado no cabeçalho da tela de chamada (10.4) para identificar visualmente a turma.
- **`FOCOS_METRICAS`**: os itens de `TEMAS_CURSO` que têm gradiente definido — são os cursos que ganham um botão dedicado no seletor de foco da aba Métricas (10.10).
- **`statusInativo(alunoId)`**: um aluno inativo é "cancelado" ou só "inativo" (temporário)? A função olha a movimentação mais recente do histórico desse aluno que contenha "inativad" ou "cancelad" no texto e decide por aí — não existe uma coluna de status separada, é inferido do texto do histórico.
- **`ordemDia(nomeTurma)`**: para ordenar as turmas por dia da semana (dashboard e o seletor de turma do modal "Novo aluno"), procura "Segunda", "Terça" etc. **no nome da turma** (de novo, texto livre, não uma coluna estruturada).
- **`professorNome(turma)`**: nome do professor de uma turma, sempre resolvido pelo vínculo real (`turma.professor_id` → `professores.id`); só cai no texto solto `turma.professor` como fallback se o vínculo estiver ausente. É usado em toda a interface para exibição — **nunca** para decidir permissão/posse (isso é sempre por `professor_id`, ver `carregarTurmas()` na seção 7).

---

## 9. `frontend/shared/` — utilitários

- **`dom.js`**: `escapeHtml` (escapa `&<>"'` para exibir texto com segurança dentro de HTML), `escapeAttr` (mais forte — para quando o valor vai dentro de um `onclick="fn('valor')"`, precisa neutralizar dois níveis: o literal JS de aspas simples e o atributo HTML de aspas duplas ao mesmo tempo), `showToast`, `fecharModal`, `toggleSenha` (mostra/oculta senha nos campos de senha), `wireModalBackdrops` (fecha modal ao clicar fora dele).
- **`validators.js`**: `isEmailValido` — checagem simples de formato de e-mail.
- **`navigation.js`**: `goTab(tab)` — troca qual aba está visível e, se a aba for relatório/métricas/professores/reposições/configurações, manda ela se redesenhar (essas telas são recalculadas na hora de entrar, não ficam atualizando sozinhas em segundo plano). Também expõe `moverIndicadorNav()` (desliza a pílula do menu até o botão ativo, medindo a posição real do botão em vez de recalcular por índice — continua certo mesmo com "Professores"/"Configurações" fora da barra).
- **`updateNotifier.js`**: a cada 30 segundos, busca o próprio `index.html` de novo e compara a tag `<meta name="app-version">` com a que já está carregada; se mudou, mostra o banner "Atualização disponível". É a forma (simples, sem service worker) de avisar quem está com a aba aberta que subiu uma versão nova.
- **`confirm.js`**: `confirmar({ titulo, mensagem, textoConfirmar, textoCancelar, perigo })` — diálogo de confirmação no próprio layout do sistema (modal `#modal-confirm`), substituindo o `confirm()` nativo do navegador em todo o app. Retorna uma Promise (`if (!await confirmar({...})) return;`); `responderConfirm(valor)` é chamada pelos botões do modal e resolve essa Promise.
- **`customSelect.js`**: `enhanceSelect(select)` — um `<select>` nativo não pode ter sua lista aberta estilizada (o navegador desenha esse popup com o chrome do próprio SO). Esta função troca só a **apresentação** de um `<select>` marcado com `data-custom-select` por um botão + painel no estilo "liquid glass" do resto do sistema, mantendo o `<select>` real (escondido) como única fonte da verdade — nada que leia/escreva `.value` ou escute `change` nesses elementos precisa mudar. Ligado automaticamente em `main.js` para todo `select[data-custom-select]` presente no HTML estático no momento do boot.
- **`duplicados.js`**: `normalizarNome(s)` (remove acentos, minúsculas, espaços duplicados) e `alunoJaExiste(nome)` (compara com todo `state.ALUNOS`, não só a turma selecionada) — checagem de aluno duplicado reaproveitada tanto no modal "Novo aluno" quanto na importação por planilha, para as duas telas usarem a mesma regra de comparação.
- **`charts.js`**: motor de gráficos SVG do dashboard de Métricas — o projeto não usa nenhuma biblioteca de gráficos, então `lineChart()`, `barChart()` e `donutChart()` montam a própria marcação SVG na mão e registram os dados num mapa em memória (`registry`) que os handlers de hover (`onLineChartMove/Leave`, `onBarHover`, `onDonutHover`, expostos globalmente via `main.js`) consultam depois de inseridos no DOM, para mostrar o tooltip compartilhado (`#chart-tooltip` em `index.html`).

---

## 10. `frontend/features/`

Cada pasta é uma área da tela. Nenhuma feature acessa `sb` diretamente — sempre passa por `api/`.

### 10.1 `theme/` — troca de tema

Um arquivo, uma função: `toggleTema()` alterna o atributo `data-theme` da tag `<html>` e salva a escolha no `localStorage` (`'tema': 'claro'|'escuro'`). O script inline no `<head>` do `index.html` lê esse mesmo valor **antes** do CSS carregar, para não piscar claro por uma fração de segundo ao abrir no tema escuro.

### 10.2 `auth/auth.js` — login, logout, boot da aplicação

- **`doLogin()`**: lê e-mail/senha da tela, chama `sb.auth.signInWithPassword`. Se der certo, guarda o usuário em `state.usuarioLogado`, busca o perfil (`carregarPerfil`) e chama `inicializarApp()`.
- **`carregarPerfil()`**: busca a linha de `professores` cujo `user_id` bate com o usuário autenticado — é daqui que vem `state.perfilLogado.papel` (`admin`/`professor`) e `.nome`.
- **`inicializarApp()` / `executarCargaInicial()`**: mostra a tela de carregamento, preenche o avatar/nome no cabeçalho, mostra o ícone de Configurações (`#btn-config`) só se for admin, e dispara o carregamento de tudo — turmas → alunos → (em paralelo) presenças/histórico/professores/**cursos** → **`sincronizarCursosComTurmas()`** — antes de popular filtros e desenhar o dashboard, a tabela de alunos e o relatório pela primeira vez, e então ligar as notificações de reposição em tempo real (`iniciarNotificacoesReposicoes()`, seção 10.9).
  - **Guarda contra corrida (`cargaEmAndamento`)**: `inicializarApp()` reaproveita a Promise de uma carga já em andamento em vez de rodar tudo de novo se for chamada duas vezes antes da primeira terminar. Isso existe porque `restoreSession()` (abaixo) pode ainda estar esperando `getSession()` responder quando o gerenciador de senhas do navegador preenche os campos escondidos do login e `agendarAutoLogin()` (abaixo) dispara `doLogin()` sozinho — sem essa guarda, duas cargas paralelas duplicavam alunos (e arriscavam duplicar turmas/cursos) na tela, às vezes de forma permanente se a corrida alcançasse um `INSERT` em `sincronizarCursosComTurmas()`. `carregarAlunos()` (seção 7) também foi endurecida por conta própria, como segunda linha de defesa.
- **`wireAutoLogin()` / `agendarAutoLogin()`**: login automático quando o navegador preenche e-mail/senha sozinho (autofill do gerenciador de senhas). Espera os campos ficarem estáveis por 400ms antes de logar (evita disparar no meio da digitação manual) e nunca dispara durante o fluxo de recuperação de senha (`estaEmRecuperacaoSenha()`, ver 10.2b) nem depois que a tela de login já não está mais visível — os campos continuam no DOM (só escondidos) depois do login, e sem essa segunda checagem o autofill do navegador podia disparar `doLogin()` no meio do uso normal do app.
- **`doLogout()`**: `sb.auth.signOut()` e volta para a tela de login.
- **`restoreSession()`**: ao abrir a página, pergunta ao Supabase se já existe uma sessão válida (token salvo no navegador) e, se sim, faz login automático sem pedir e-mail/senha de novo — a menos que a página tenha sido aberta a partir de um link de recuperação de senha (`estaEmRecuperacaoSenha()`).

### 10.2b `auth/recovery.js` — recuperação de senha

Duas telas extras (`#recover-request-page`, `#recovery-page`) somadas à de login:

- **Checagem síncrona do hash da URL**, feita na hora em que este módulo é importado (antes de `restoreSession()` rodar): `window.location.hash.includes('type=recovery')`. É síncrona de propósito — o evento `PASSWORD_RECOVERY` do SDK do Supabase é assíncrono e pode disparar depois que `restoreSession()` já resolveu `getSession()` e decidiu mostrar o app, o que causava as telas de app e de troca de senha aparecerem juntas. O listener `sb.auth.onAuthStateChange` para `PASSWORD_RECOVERY` continua existindo como reforço, mas é a checagem síncrona do hash que garante a ordem certa.
- **`abrirRecuperarSenha()` / `voltarParaLogin()` / `enviarLinkRecuperacao()`**: passo 1 — troca para `#recover-request-page`, valida o e-mail (`isEmailValido`) e chama `enviarResetSenha()` (mesma função de `professoresRepo.js` usada no modal de editar professor).
- **`salvarNovaSenhaRecuperacao()`**: passo 2 — valida tamanho mínimo (6) e confirmação, chama `sb.auth.updateUser({ password })`, e desloga em seguida (`sb.auth.signOut()`) para não deixar a pessoa autenticada com o token temporário de recuperação — ela precisa logar de novo com a senha nova.
- **`estaEmRecuperacaoSenha()`**: exportada para `auth.js` consultar antes de auto-logar ou restaurar sessão, evitando as corridas descritas acima.

### 10.3 `dashboard/` — aba "Turmas"

- **`dashboardView.js`**:
  - `renderDash()`: desenha os 4 cartões de estatística (turmas, alunos ativos, irregulares, alertas), as "pills" de filtro por curso e a grade de cartões de turma — cada cartão mostra curso, professor, quantidade de alunos, quantos estão em alerta (clicável, ver `irParaAlertas`), um badge com `ultimaAulaRegistrada()` ("Última Aula: N", ou "Sem aulas registradas") para acompanhar o andamento da turma em tempo real, e o horário configurado. Um campo de busca (`#busca-turmas`) filtra a grade por nome da turma ou do professor.
  - A pill **"Suas Turmas"** aparece para qualquer usuário logado (admin ou professor) que tenha ao menos uma turma com `professor_id` igual ao seu perfil — não é exclusiva de professores.
  - A pill/atalho **"Turmas inativas"** só é desenhada e só fica navegável quando `state.perfilLogado?.papel === 'admin'` — professor não precisa (nem consegue pela interface) olhar turmas encerradas. Se o estado guardar `filtroCurso === '__inativas__'` para um professor (ex.: sessão antiga), `renderDash()` reseta para `''` antes de desenhar.
  - `setCurso(c)`: troca `state.filtroCurso` e redesenha.
  - `irParaAlertas(turmaId)`: atalho que muda para a aba Alunos já filtrando por aquela turma + status "Alerta".
- **`turmaModals.js`** (o arquivo mais longo do projeto): tudo que envolve criar/editar uma turma —
  - `TURMA_CORES`: paleta fixa de 8 cores para o "pontinho" de cada turma.
  - Um conjunto de helpers de horário/dias reaproveitados tanto no modal de criar quanto no de editar (por isso recebem um `prefix`, `'nt'` ou `'et'`, para saber em qual conjunto de campos mexer): preencher os `<select>` de hora/minuto, marcar os dias da semana, aplicar um horário "preset" (08:00, 14:00...), limpar horário.
  - O `<select>` de curso de ambos os modais é populado por `renderOpcoesCurso()` (`cursoModals.js`, seção 10.3b) a partir de `state.CURSOS`, com um botão "+" ao lado que abre o modal de criar curso sem sair do modal de turma.
  - `verificarTurmaDuplicada()`: aviso não-bloqueante (não impede salvar) se já existir uma turma com o mesmo nome no mesmo curso — mesmo raciocínio de `verificarAlunoDuplicado()` (10.5): pega o erro humano de recriar sem perceber, sem travar um caso legítimo de nome repetido.
  - `abrirModalNovaTurma` / `salvarNovaTurma` e `abrirModalEditarTurma` / `salvarEditarTurma` (esta última também chama `renderConfiguracoes()` ao terminar, para a tabela de exclusão permanente refletir nome/curso atualizados).
  - `toggleTurmaAtiva(e, tId)`: a função com mais efeito colateral do sistema — inativar uma turma **inativa em cascata todos os alunos ativos dela**, gravando no histórico a frase exata `"Aluno inativado automaticamente (turma inativada)"`. Reativar a turma **só reativa quem foi inativado por essa cascata** (compara com essa mesma frase no histórico) — um aluno que alguém cancelou manualmente antes não volta sozinho. Usa o diálogo de confirmação compartilhado (`confirmar()`, seção 9) em vez do `confirm()` nativo; recebe o evento do clique (`e`) para capturar `e.currentTarget` **antes** do `await` da confirmação — depois de um `await`, o navegador já zerou essa referência.

### 10.3b `dashboard/cursoModals.js` — criar curso

- **`renderOpcoesCurso(prefix, valorAtual)`**: popula o `<select>` de curso do prefixo dado (`nt`/`et`) a partir de `state.CURSOS`. Se `valorAtual` vier preenchido, garante que ele exista como opção mesmo que não esteja na lista curada (turma antiga com curso digitado livremente antes da tabela `cursos` existir) e o seleciona; sem `valorAtual`, mostra um placeholder desabilitado para forçar uma escolha explícita em vez de cair silenciosamente no primeiro curso da lista.
- **`abrirModalNovoCurso(prefix)` / `salvarNovoCurso()`**: modal simples de nome único; ao salvar, insere em `cursos` (`inserirCurso`), atualiza `state.CURSOS` e repopula o `<select>` de origem (`nt-curso` ou `et-curso`) já com o novo curso selecionado.

### 10.4 `chamada/chamadaView.js` — fazer a chamada

- `abrirChamada(turmaId)`: troca a visão do dashboard para a tela de chamada, mostra o logo do curso (`logoCurso`, se houver um mapeado) e preenche o `<select>`/grade de aulas.
- `renderChamada()`: para a aula escolhida, mostra contadores (presentes/faltas/gravações/sem registro), a grade de "quadradinhos" de aula (coloridos por `registroPorAulaDaTurma`, com um indicador deslizante marcando a aula ativa) e a lista de alunos com 3 botões cada (✓ Presente, ✗ Falta, ↺ Gravação — também com um indicador deslizante em vez de cada botão ligar o próprio fundo). Alunos marcados como experimentais (`a.experimental`) ganham um selo "Experimental" ao lado do nome.
- `marcar(alunoId, status)`: clicar de novo no mesmo status **desmarca** (fica "sem registro"). Atualiza a tela imediatamente (otimista, atualizando só a linha/indicadores afetados em vez de redesenhar tudo — para não interromper a animação em andamento) e só depois salva no Supabase; se der erro, avisa por toast (mas não desfaz visualmente — é a única função que não faz rollback local, diferente de `selecionarStatusDot` no relatório).

### 10.5 `alunos/` — aba "Alunos" e o modal de detalhes

- **`alunosTable.js`**: `renderTabelaAlunos()` monta a tabela com todos os filtros (busca por nome, curso, turma, status — `ativo`/`inativo`/`experimental`/`cancelado`/`alerta`/`irregular`). `atualizarTurmasAlunos()` repopula o `<select>` de turma quando o curso muda.
- **`alunoModal.js`**: o modal que abre ao clicar num aluno — mostra os dados, as aulas com registro (chips clicáveis: `irParaAulaHistorico(turmaId, aulaIndex)` leva direto para a chamada daquela turma já na aula certa), o histórico de movimentações, e um botão de engrenagem (`abrirMenuAluno`) que abre um menu flutuante com todas as ações:
  - `abrirModalEditar` / `salvarEdicao`: troca o nome. `abrirModalEditar(id)` aceita um `id` opcional — chamado sem argumento a partir do menu do modal (usa `state.alunoSelecionadoId`), ou com o `id` da linha clicada quando chamado direto de uma tabela (ex.: aba Configurações).
  - `abrirModalTransferir` / `confirmarTransferencia`: muda o aluno de turma **e** move todo o histórico de presença dele (`moverPresencasDeTurma`) para a nova turma — se mover o aluno funcionar mas mover as presenças falhar, a função desfaz a troca do aluno para não deixar dado inconsistente.
  - `toggleInativo` / `cancelarMatricula`: os dois "desligam" o aluno (`ativo = false`), a diferença é só a frase gravada no histórico (`statusInativo`, seção 8.2, usa essa frase depois para saber se foi "cancelamento" ou "inativação"). Ambos usam `confirmar()` (seção 9) em vez do `confirm()` nativo.
  - `toggleExperimental`: alterna o campo `alunos.experimental` — usado para marcar quem ainda não matriculou, só veio experimentar uma aula (aparece com selo diferenciado em todo o sistema e entra no funil de conversão da aba Métricas, seção 10.10).
  - `abrirModalNovoAluno` / `salvarNovoAluno`: cadastra aluno novo. O seletor de turma não é mais um `<select>` simples — é um "picker" com busca (`toggleNovoTurmaPainel`/`fecharNovoTurmaPainel`/`filtrarNovoTurmaBusca`/`filtrarNovoTurmaCurso`/`selecionarNovaTurmaOpcao`) que filtra por texto (turma, curso ou professor) e por chip de curso, listando só turmas ativas na mesma ordem do dashboard (dia da semana, depois nome); o `<select>` original continua escondido no DOM como fonte real do valor. Tem também um botão "Aula experimental" (`toggleNovoExperimental`) que já cadastra o aluno com `experimental: true`.
  - `verificarAlunoDuplicado()`: aviso não-bloqueante em tempo real (mesmo padrão de `verificarTurmaDuplicada`) se já existir um aluno com esse nome em **qualquer** turma do sistema (`duplicados.js`, seção 9); `salvarNovoAluno()` também pede uma confirmação bloqueante (`confirmar()`) antes de inserir se detectar duplicidade.
- **`observacoes.js`**: dentro do mesmo modal, uma seção de "anotações" sobre o aluno (reclamação, pedido de transferência, feedback...). `OBS_CATEGORIAS` é a lista fixa de categorias com ícone e cor. Cada observação é, na prática, uma linha na tabela `historico` marcada com `tipo = 'observacao'`.
- **`importarPlanilha.js`**: importação em massa de alunos a partir de uma planilha (`.xlsx`/`.xls`/`.csv`, lida com a biblioteca global `XLSX`, a mesma de `exportExcel.js`). Percorre **todas as abas** da planilha (cada aba pode representar um curso diferente, ex.: "Alunos Master", "Alunos Evolution") — abas sem uma coluna reconhecível de "Nome"/"Turma" no cabeçalho são ignoradas silenciosamente. Para cada linha:
  - resolve o **curso** a partir de uma coluna "Curso" (se existir) ou do nome da aba, comparando com os cursos que têm turma ativa — primeiro por igualdade exata, depois por palavra-chave em comum (ignorando palavras genéricas como "alunos"/"turma"); só assume automaticamente quando o resultado é **inequívoco** (uma palavra batendo em dois cursos ao mesmo tempo fica em aberto para escolha manual);
  - resolve a **turma** comparando o texto da coluna "Turma" (normalmente só o horário, ex. "Segunda 14:00") contra as turmas candidatas daquele curso — cada palavra do texto precisa aparecer no nome da turma, não um substring contíguo, porque o nome real pode ter texto no meio (ex. "Segunda Sta Dorotéia 14:00");
  - abre um modal de conferência (`#modal-importar-planilha`) com uma linha editável por aluno (nome, filtro de curso, turma, e um selo de status: OK / Sem turma / Já existe), permitindo corrigir manualmente antes de confirmar;
  - `confirmarImportacaoPlanilha()` insere um a um (`inserirAluno` + `registrarMovimentacao('Aluno importado por planilha')`), pedindo confirmação extra (`confirmar()`) se houver duplicados detectados, e reporta quantos entraram com sucesso/erro ao final.

### 10.6 `professores/` — aba "Professores" (só admin, fora do menu principal)

Alcançável só pelo ícone de engrenagem do cabeçalho (seção 10.8) — não tem mais botão na `.nav` principal.

- **`professoresView.js`**: `renderProfessores()` desenha os cartões (avatar colorido por `profColor(id)`, iniciais por `profIniciais(nome)`, quantas turmas cada um tem).
- **`professorModal.js`**:
  - `salvarNovoProf()`: cria a conta de autenticação (`criarContaAuth`, via signup público) e, se der certo, cria a linha correspondente em `professores` linkando pelo `user_id`. Senha inicial sugerida: `Teste1234`.
  - `salvarEdicaoProf()`: atualiza nome/e-mail/papel. **Não tenta mudar a senha de ninguém** — o único botão relacionado a senha no modal é "Enviar reset de senha".
  - `enviarResetSenha()`: dispara o e-mail de redefinição de senha do próprio Supabase Auth (mesma função usada pela tela pública "Esqueci minha senha", seção 10.2b).

### 10.7 `relatorios/` — aba "Relatórios"

- **`relatoriosView.js`**:
  - `popularFiltros()`: preenche todos os seletores de filtro (curso, professor, turma) a partir das turmas carregadas — chamado uma vez no boot e de novo sempre que uma turma/curso é criado/editado.
  - Os multi-selects "Curso", "Professor", "Turma", "Mostrar" (Alertas/Irregulares) e "Status" (Regular/Atenção/Alerta/**Cancelados**) são um dropdown genérico com checkboxes (`popularMultiPanel`, `getMultiSelecionados`, `onMultiCheck`, `toggleMultiDropdown`) reaproveitado 5 vezes.
  - `renderRel()`: aplica todos os filtros e desenha uma tabela por turma, com uma coluna de "pontinhos" (últimas 8 aulas com registro) clicáveis.
  - `abrirDotMenu` / `selecionarStatusDot`: clicar num pontinho abre um menu pequeno para corrigir a presença daquela aula específica sem precisar voltar para a tela de chamada — se salvar der erro, desfaz a mudança visual.
- **`exportExcel.js`**: `exportarExcel()` monta um arquivo `.xlsx` com 3 tipos de aba: um "Resumo Geral" (todo mundo, todas as turmas), uma aba por turma (aluno × aula, com o status de cada uma) e uma aba "Alertas" só com quem está em alerta. Usa a biblioteca global `XLSX` (carregada por `<script>` no `index.html`, não por `import`).

### 10.8 `configuracoes/` — zona de exclusão permanente (admin)

Único ponto do sistema inteiro que faz `DELETE` de verdade em vez de inativar/cancelar (soft delete) — todo o resto do app evita apagar dados. Alcançável só pelo ícone de engrenagem (`#btn-config`, visível apenas para admins) no cabeçalho, que abre um menu pequeno (`abrirMenuConfig`/`fecharMenuConfig`) com duas opções: "Geral" (esta seção, `goTab('configuracoes')`) e "Professores" (a tela existente da seção 10.6, `goTab('professores')`).

- **`renderConfiguracoes()`**: monta os 3 cards de estatística (cursos/turmas/alunos) e delega para `renderListaExclusao()`.
- **Três abas internas** (`selecionarTipoExclusao('curso'|'turma'|'aluno')`), cada uma com busca + filtros (curso/status) e uma tabela com botões "Editar" e "Excluir" por linha:
  - **"Editar" nunca duplica lógica**: reabre exatamente os mesmos modais já usados no resto do sistema (`abrirModalEditarTurma` do dashboard, `abrirModalEditar` da aba Alunos) — exceto para curso, que ganhou um modal próprio aqui (`abrirModalEditarCurso`/`salvarEdicaoCurso`, `#modal-editar-curso`), já que editar um curso não existia em nenhum outro lugar do app. Editar um curso renomeia a linha em `cursos` **e** propaga o novo nome para toda `turmas.curso` que usava o nome antigo (`renomearTurmasDoCurso`, chamado **antes** de `atualizarCurso`, com rollback do rename das turmas se o `update` do curso falhar depois — mesmo padrão de `confirmarTransferencia` em `alunoModal.js`). Ver [seção 7](#7-backendapi--repositórios) sobre por que isso é necessário (curso não é FK).
  - **"Excluir" (`pedirExclusao` → `#modal-excluir-item` → `confirmarExclusaoConfig`)**: exige digitar o nome exato do item para habilitar o botão (`verificarTextoExclusaoItem`), e mostra um aviso informativo (não-bloqueante, `avisoInformativo`) do que mais será afetado — quantas turmas ficam sem curso, quantos alunos ficam sem turma, ou quantos registros de presença/histórico somem junto com um aluno.
- **Curso e turma nunca levam o que está "dentro" deles junto** — excluir sempre **desvincula antes de apagar**: turmas ficam com `curso = null` (`desvincularTurmasDoCurso`) e alunos ficam com `turma_id = null` (`desvincularAlunosDaTurma`), *nessa ordem* (antes do `DELETE`), porque uma FK ainda apontando para o registro faria o banco rejeitar a exclusão. Isso é o oposto do padrão de "cascata bloqueia" — aqui a exclusão **nunca é bloqueada**, ela desvincula e segue em frente.
- **Aluno é o único caso de cascata de verdade** (`excluirAlunoCompleto`): reposições + suas opções → presenças → histórico → o aluno em si, nessa ordem (filhos antes do pai) — porque o aluno é sempre o "fim da linha" dos próprios dados, nada mais aponta para ele depois que ele se vai.
- **`erroSeNadaApagado({ data, error })`**: usada em toda exclusão desta tela — trata tanto um `error` de verdade quanto um `DELETE` "bem-sucedido" mas que não apagou nenhuma linha (bloqueado silenciosamente por RLS) como falha, evitando um toast verde de sucesso para uma exclusão que na verdade não aconteceu. Ver [seção 7](#7-backendapi--repositórios).

### 10.9 `reposicoes/` — aba "Reposições" (equipe autenticada)

- **`reposicaoModal.js`**: `abrirModalReposicao()` (aberto a partir do menu do modal de aluno) monta a lista de aulas com `calcAluno()`/`aulasDaTurma()` e pré-seleciona a primeira aula marcada como falta. A equipe monta até 4 opções de "turma destino + data" (`adicionarOpcaoReposicao`/`removerOpcaoReposicao`/`atualizarOpcaoReposicao`); `ultimaAulaRegistrada()` (domain/attendance.js, 8.1) dá a dica visual de até qual aula a turma escolhida já registrou presença.
  - **`renderSugestoesReposicao()` / `usarSugestaoReposicao()`**: acima da lista de opções manuais, sugere automaticamente outras turmas **ativas do mesmo curso** cuja `proximaAula()` seja exatamente a aula que o aluno perdeu, com a data calculada por `proximaDataTurma()` (seção 8.1) — clicar numa sugestão preenche a primeira opção vazia (ou cria uma nova, até o limite de 4).
  - `salvarReposicao()` chama `criarReposicao()` e, ao terminar:
    - abre a página pública gerada **numa nova aba automaticamente** — o truque é chamar `window.open('', '_blank')` **antes** do `await` da chamada ao Supabase (ainda dentro do gesto de clique do usuário) e só depois trocar o `location.href` dessa aba já aberta; chamar `window.open` depois de um `await` é bloqueado como pop-up pela maioria dos navegadores;
    - copia o link para a área de transferência sozinho (`navigator.clipboard`);
    - mostra o modal `modal-reposicao-link` com o link (campo copiável + botão "Abrir página novamente", via `abrirPaginaReposicaoGerada()`) para reenvio manual (WhatsApp/e-mail).
- **`reposicoesView.js`**: `renderReposicoes()` carrega tudo via `carregarReposicoes()` e guarda em `state.REPOSICOES` (ver [seção 6](#6-frontendstatestorejs) sobre esse campo não estar declarado em `store.js`); `aplicarFiltroReposicoes()` filtra por nome/status sem nova consulta. Na tabela, o status/horário escolhido pelo aluno fica num "pill" **ao lado do nome** (não numa coluna separada), para dar pra ver de relance quem já confirmou e quando. `cancelarReposicaoAcao()` marca o caso como cancelado (o link passa a mostrar "cancelada" para quem abrir). `concluirReposicaoAcao()` é o fecho do fluxo: grava `status: 'R'` (gravação/reposição — o mesmo status que já existia em `presencas`, ver 8.1) na aula de origem via `salvarPresenca()`, atualiza `state.PRESENCAS` e só então marca o caso como `concluida` — ou seja, a reposição feita em outra turma passa a contar como presença na turma original.
  - **`iniciarNotificacoesReposicoes()`**: chamada uma vez, em `inicializarApp()` (10.2), logo após o login. Usa `assinarMudancasReposicoes()` (Realtime do Supabase, `postgres_changes` na tabela `reposicoes`) para mostrar um toast **assim que um aluno confirma um horário pelo link público** — funciona em qualquer aba do painel, não só com "Reposições" aberta. Como o Realtime respeita RLS pela mesma conexão/role de quem assina, só quem está autenticado recebe esses eventos (a página pública usa outra instância do cliente Supabase, nunca loga, então nunca "ouve" essas mudanças — ver 16.3).

### 10.10 `metricas/metricasView.js` — aba "Métricas"

De longe a feature que mais cresceu desde a primeira versão deste documento — um dashboard completo, não mais uma função só com 4 tabelas simples. Tudo é recalculado a partir dos mesmos dados já carregados (nenhuma consulta nova ao Supabase); os números de "novas matrículas", "cancelamentos" e do funil de experimentais são obtidos **filtrando o texto** das descrições em `historico` (ex.: conta quantas descrições contêm "adicionado ao sistema" ou "Matrícula cancelada") — de novo, não existe uma coluna de "tipo de evento" estruturada para movimentações (só para observações, que têm `tipo = 'observacao'`).

- **Seletor de foco** (`setFocoMetricas`, `state.metricasFoco`): "Geral" ou um dos cursos com tema dedicado em `FOCOS_METRICAS` (seção 8.2 — hoje Elas/Master/Evolution). Escolher um foco filtra turmas/alunos/histórico pela mesma classificação de `temaCurso()` usada nos badges do resto do sistema, e recolore os dois KPIs principais com o gradiente daquele curso. Pílula deslizante igual à do menu principal (`moverIndicadorFoco`).
- **Linha de KPIs**: frequência média + alunos ativos (2 "hero cards") e 2 cards de variação mês-a-mês (novas matrículas / cancelamentos), com um selo de variação (`deltaBadge`) que trata o caso de base zero ("novo" em vez de uma porcentagem sem sentido) e inverte a semântica de cor para cancelamentos (uma alta aparece em vermelho, não verde).
- **Bloco "Alunos Experimentais"**: total histórico de experimentais adicionados vs. convertidos em matrícula (toggle inverso de `toggleExperimental`, seção 10.5) + taxa de conversão.
- **Gráfico de linha** (novas matrículas vs. cancelamentos, últimos 6 meses) e **gráfico de barras** (turmas ativas por dia da semana) — ambos via `shared/charts.js` (seção 9).
- **Dois donuts**: distribuição de frequência (Regular/Atenção/Alerta/Sem registro) e Ativos vs. Inativos.
- **"Ação Necessária"**: lista clicável de alunos em alerta, ordenada pela maior sequência de faltas consecutivas.
- **Tabela "Comparação por Curso"**: turmas ativas, alunos ativos, média de alunos/turma, frequência média, e a contagem regular/atenção/alerta/cancelados/inativos por curso — conta só **turmas ativas** deliberadamente (o mesmo critério da tabela de professores logo abaixo), para não inflar o total quando um aluno foi transferido para dentro de uma turma já inativa.
- **Tabela "Carga por Professor"**: agrupa turmas ativas por `professor_id` e aplica as mesmas métricas de frequência/alerta.
- **"Atividade Recente"**: as últimas 8 entradas de `historico` que não são observação, com uma cor por linha decidida também por palavra-chave na descrição (mesmo padrão de texto-livre-interpretado-por-código do resto do sistema).

---

## 11. `frontend/main.js` — a raiz de composição

Três responsabilidades, nessa ordem:

1. **Importa** a função certa de cada feature (não tem lógica própria, só import).
2. **Registra em `window`** — um único `Object.assign(window, {...})` com todas as funções que o HTML (estático ou gerado dinamicamente por `innerHTML`) chama por nome. Esse bloco é a lista completa de "o que o HTML tem permissão de chamar".
3. **Liga os fios soltos** que não pertencem a nenhuma feature específica: fecha modal ao clicar fora (`wireModalBackdrops`), transforma todo `select[data-custom-select]` presente no HTML no boot (`enhanceSelect`, seção 9), fecha o menu de pontinho / menu de ações do aluno / menu de configurações / painel de turma do modal de novo aluno / dropdowns de multi-select ao clicar fora deles, tenta restaurar sessão (`restoreSession`), liga o aviso de atualização (`startUpdateNotifier`) e o auto-login por autofill (`wireAutoLogin`).

---

## 12. Modelo de dados (inferido)

Não há acesso direto ao banco a partir deste código — o esquema abaixo foi **inferido** a partir das consultas feitas pelos repositórios (`backend/api/`). Vale conferir no painel do Supabase se quiser ter certeza:

| Tabela | Colunas usadas pelo código |
|---|---|
| `turmas` | `id`, `turma` (nome), `curso` (texto livre — ver nota abaixo), `professor` (nome, texto), `professor_id` (FK), `ativa` (bool), `cor`, `total_aulas`, `horario_inicio` (`HH:MM:SS` ou null), `dias_semana` (array de texto ou null) |
| `alunos` | `id`, `nome`, `turma_id` (FK, pode ser `null` se a turma foi excluída), `ativo` (bool), `experimental` (bool) |
| `presencas` | `turma_id`, `aluno_id`, `aula` (texto, ex. "Aula 3"), `status` (`'P'|'R'|'F'`) — chave única em `(turma_id, aluno_id, aula)` |
| `historico` | `id`, `aluno_id` (FK), `descricao` (texto livre), `created_at`, `tipo` (`'observacao'` ou vazio/null para movimentações comuns), `data_obs`, `categoria` (uma das `OBS_CATEGORIAS`) |
| `professores` | `id`, `nome`, `email`, `papel` (`'admin'|'professor'`), `user_id` (FK para o usuário do Supabase Auth) |
| `cursos` | `id`, `nome` — lista curada de sugestões para os `<select>` de curso; **não** é referenciada por FK em `turmas.curso` (ver seção 7) |
| `reposicoes` | `id`, `aluno_id` (FK), `turma_origem_id` (FK), `aula` (texto), `status` (`'aberta'|'agendada'|'concluida'|'cancelada'`), `token` (texto único, é o `?token=` do link público), `opcao_escolhida_id` (FK, null até confirmar), `criado_por` (FK professores), `created_at`, `confirmado_em` |
| `reposicao_opcoes` | `id`, `reposicao_id` (FK), `turma_destino_id` (FK), `data`, `observacao` (texto livre opcional) |

Vários campos "estruturados" no papel (curso, dia da semana, tipo de movimentação) são, na prática, **texto livre interpretado por código** (`corBadge`/`temaCurso`, `ordemDia`, os filtros de `historico.descricao` em métricas e no funil de experimentais). Funciona, mas é frágil: mudar o texto de uma dessas frases em um lugar sem atualizar todos os outros quebra a lógica silenciosamente — e a lista de frases "mágicas" hoje inclui, entre outras: `"Aluno inativado automaticamente (turma inativada)"`, `"adicionado ao sistema"`, `"adicionado ao sistema (experimental)"`, `"Marcado(a) como aluno(a) experimental"`, `"Deixou de ser aluno(a) experimental"`, `"Matrícula cancelada"`, `"Transferido"`, `"inativad"`/`"cancelad"` (para `statusInativo`).

---

## 13. Fluxos completos, passo a passo

**Login → tela inicial**
`doLogin` → `sb.auth.signInWithPassword` → `carregarPerfil` → `inicializarApp` → carrega turmas → carrega alunos → carrega (em paralelo) presenças + histórico + professores + cursos → `sincronizarCursosComTurmas` → `popularFiltros` → `renderDash` + `renderTabelaAlunos` + `renderRel` → `iniciarNotificacoesReposicoes`.

**Fazer uma chamada**
`abrirChamada(turmaId)` → guarda `state.turmaAtual`, popula o `<select>` de aulas → `renderChamada()` desenha a lista → clicar num botão chama `marcar(alunoId, status)` → atualiza `state.PRESENCAS` e a tela na hora → `salvarPresenca`/`removerPresenca` no Supabase → `renderDash` e `renderTabelaAlunos` são redesenhados para refletir a nova frequência.

**Inativar uma turma**
`toggleTurmaAtiva(e, id)` → confirmação (`confirmar()`) → `atualizarTurma(id, {ativa:false})` → busca todos os alunos ativos dessa turma → `atualizarAlunosEmLote` marca todos como inativos → grava um `historico` idêntico para cada um (`MARCA_INATIVACAO_AUTO`) → recarrega o histórico → redesenha dashboard e relatório.

**Transferir um aluno**
`confirmarTransferencia()` → `atualizarAluno(turma_id novo)` → `moverPresencasDeTurma` (todas as linhas de `presencas` desse aluno na turma antiga passam a apontar para a nova) → se isso falhar, desfaz o passo anterior → grava uma movimentação no histórico → atualiza o cache `state.PRESENCAS` local trocando as chaves de `"turmaAntiga_aula"` para `"turmaNova_aula"`.

**Importar alunos por planilha**
`importarPlanilhaSelecionada` (lê o arquivo com `XLSX.read`) → `processarPastaDeTrabalho` percorre todas as abas, tentando resolver curso e turma de cada linha por heurística de texto → abre `#modal-importar-planilha` para conferência/correção manual linha a linha → `confirmarImportacaoPlanilha` insere um a um, registrando `"Aluno importado por planilha"` no histórico de cada um.

**Excluir permanentemente um curso, turma ou aluno**
`pedirExclusao(tipo, id)` → `#modal-excluir-item`, exige digitar o nome exato → `confirmarExclusaoConfig()` → para curso/turma: desvincula dependentes (`curso=null`/`turma_id=null`) e só então faz o `DELETE`; para aluno: apaga reposições → presenças → histórico → o aluno, nessa ordem → `erroSeNadaApagado()` confere se alguma linha foi mesmo apagada (RLS pode bloquear silenciosamente) → atualiza o `state` local e redesenha dashboard/tabela de alunos/relatório/configurações.

**Exportar Excel**
`exportarExcel()` → monta as 3 famílias de aba (resumo, uma por turma, alertas) inteiramente a partir do `state` já carregado (nenhuma consulta nova) → `XLSX.writeFile` baixa o arquivo no navegador.

---

## 14. O que existe fora deste código

Duas coisas mencionadas na interface **não têm implementação neste repositório** — são responsabilidade de outra parte do sistema (provavelmente uma Supabase Edge Function agendada, ou outro serviço):

- **E-mail automático de "chamada não feita"**: o texto no modal de editar turma diz que configurar `horario_inicio`/`dias_semana` faz o sistema avisar o professor por e-mail 2 horas depois do início se a chamada não foi lançada. O front-end só **salva** esses dois campos — não existe nenhum código aqui que envia e-mail ou roda em horário programado.
- **Row Level Security (RLS)** das tabelas do Supabase: não é código deste repositório, mas é o que de fato decide quem pode ler/escrever cada linha no banco (ver [seção 15](#15-segurança--resumo)).

Se for mexer nesses dois pontos, é preciso procurar no painel do Supabase (Edge Functions / Database → Policies), não neste código.

---

## 15. Segurança — resumo

1. **`backend/config/env.js` está versionado de propósito, não escondido.** Sem passo de build, não há injeção de variáveis em tempo de deploy — o repositório é literalmente o que a Vercel serve. Isso não expõe segredo nenhum: `SUPABASE_ANON_KEY` é pública por natureza em qualquer app Supabase (vai embutida no navegador de qualquer visitante). Um commit anterior já tentou tirar o arquivo do versionamento e isso quebrou o deploy.
2. **Troca de senha de terceiros removida**: não é possível (nem deveria ser) definir a senha de outro usuário a partir do navegador — só o próprio Supabase Auth pode, via e-mail de redefinição (`enviarResetSenha`, usada tanto no modal de editar professor quanto na tela pública "Esqueci minha senha").
3. **Escape correto em atributos inline**: valores como nome de curso/turma, que acabam dentro de `onclick="fn('valor')"`, passam por `escapeAttr` (não só `escapeHtml`), para não permitir que um texto com aspas quebre o atributo.
4. **Limitação conhecida e aceita (fora de escopo)**: a interface esconde as abas "Professores" e "Configurações" (esta última nem aparece no menu — só no ícone de engrenagem) de quem não é admin, mas isso é só estética — qualquer usuário autenticado consegue chamar as mesmas funções pelo console do navegador, **incluindo as de exclusão permanente de curso/turma/aluno** (seção 10.8). A proteção de verdade contra isso precisa ser **Row Level Security** nas tabelas do Supabase, validando `papel` no banco, não no navegador.
5. **Peculiaridade do Supabase/PostgREST que já gerou bug real**: um `DELETE` bloqueado por RLS não retorna erro — a resposta vem "bem-sucedida" com `data: []` mesmo sem apagar nada. Todo `DELETE` deste projeto (aba Configurações) checa `data.length` além de `error` por causa disso (`erroSeNadaApagado()`), para não mostrar um toast de sucesso numa exclusão que na verdade não aconteceu no banco.
6. **Auditoria de RLS (feita ao construir a seção 16)**: rodando [`sql/verificar_seguranca.sql`](sql/verificar_seguranca.sql) no projeto real, as policies `professor_ver_turmas`, `professor_ver_alunos`, `professor_ver_presencas`, `professor_ver_historico`, `admin_ver_tudo_professores` e `professor_ver_proprio` apareciam com `roles = {public}` — no Postgres, isso significa "qualquer role", **incluindo `anon`** (ou seja, incluindo a página pública de reposição, que usa a mesma anon key). [`sql/reforcar_rls.sql`](sql/reforcar_rls.sql) corrige isso com `ALTER POLICY ... TO authenticated` em cada uma — só restringe **quem** pode usar a policy, sem tocar na condição (`USING`/`WITH CHECK`) que já decide o que cada professor/admin vê. As tabelas novas (`reposicoes`/`reposicao_opcoes`) já nasceram com policy restrita a `authenticated` (ver 16.3), assim como `cursos` deveria — vale conferir se essa tabela mais recente entrou nessa auditoria; se não entrou, é o primeiro lugar a checar antes de confiar nela.

---

## 16. Sistema de Reposição de Aulas

Feature separada do painel interno: uma página pública para o aluno (ou responsável) marcar, sozinho e sem login, um horário para repor uma aula que faltou. Existe porque misturar esse acesso no mesmo login de professor/admin exigiria dar a qualquer visitante a mesma chave (anon key) com as mesmas permissões amplas que o painel interno usa hoje — em vez disso, o público só fala com o banco através de duas funções SQL bem estreitas, nunca direto nas tabelas.

### 16.1 Modelo de dados

Duas tabelas novas, descritas na [seção 12](#12-modelo-de-dados-inferido): `reposicoes` (um caso = 1 aluno + 1 aula perdida + um `token` único que vira o `?token=` do link) e `reposicao_opcoes` (até 4 opções de "turma destino + data" que a equipe oferece para aquele caso). O SQL completo — tabelas, índices e as duas funções da seção 16.3 — está em [`sql/reposicoes.sql`](sql/reposicoes.sql); **precisa ser rodado uma vez manualmente no SQL Editor do painel Supabase**, não é aplicado por este código.

### 16.2 Lado interno (autenticado) — aba "Reposições"

Coberto na [seção 10.9](#109-reposicoes--aba-reposições-equipe-autenticada): a equipe cria o caso a partir do menu do modal de um aluno (com sugestões automáticas de turma/data), gera o link, acompanha status (aberta/agendada/concluída/cancelada) na aba "Reposições", e ao confirmar que a reposição aconteceu, `concluirReposicaoAcao()` grava `'R'` na aula de origem — a mesma mecânica de "gravação" que já existia em `presencas` (ver 8.1), só que disparada por este fluxo em vez da tela de chamada.

### 16.3 Lado público (sem login) — `reposicao.html`

- **Arquivos**: `reposicao.html` (na raiz, ao lado de `index.html`) + `frontend/public/reposicaoPublica.js` + `frontend/styles/public-reposicao.css`. Deliberadamente não importa nada de `frontend/state/`, `frontend/features/` ou `backend/api/` do painel — é uma mini-aplicação à parte, para não correr o risco de puxar (mesmo sem querer) alguma lógica ou dado pensado só para usuário autenticado. Reaproveita só `backend/config/env.js` (URL + anon key, que já são públicas por natureza — ver comentário em `env.example.js`) e cria sua própria instância do cliente Supabase (`window.supabase.createClient(...)`), separada de `backend/api/supabaseClient.js`.
- **Sem tabela exposta ao público**: `reposicoes`/`reposicao_opcoes` têm RLS ligado e **nenhuma policy para `anon`** — ou seja, a chave anônima não consegue ler/escrever essas tabelas diretamente, nem que alguém inspecione o JS e tente chamar `sb.from('reposicoes')` na mão. O único acesso é via duas funções Postgres `security definer` (rodam com permissão de dono, ignorando RLS internamente, mas cada uma valida o token antes de fazer qualquer coisa):
  - `reposicao_publica_get(p_token)`: devolve só os dados daquele caso (nome do aluno, aula, opções) — nunca a tabela inteira.
  - `reposicao_publica_confirmar(p_token, p_opcao_id)`: só atualiza se o caso ainda estiver `'aberta'` e a opção pertencer a esse mesmo caso; o `update ... where status='aberta'` combinado com a contagem de linhas afetadas evita que duas abas do mesmo link confirmem dois horários diferentes ao mesmo tempo (condição de corrida).
- **Sem branding pesado**: a página mostra o logo (`frontend/img/`) mas não tem nav, tema alternável ou qualquer outro elemento do painel — só carregamento → escolha de horário → confirmação, pensada para abrir num celular a partir de um link do WhatsApp (`frontend/styles/public-reposicao.css` é mobile-first, com um breakpoint extra em 380px para aparelhos bem pequenos).
- **A chave anon é compartilhada com o painel principal — de propósito, é inevitável.** Quem abre `reposicao.html` carrega o mesmo `SUPABASE_URL`/`SUPABASE_ANON_KEY` que qualquer visitante do `index.html` já carrega antes mesmo de logar (a chave "anon" sempre foi pública por natureza — ver `env.example.js`, seção 5). Ou seja, um aluno com o link **não ganha nenhum acesso a mais** do que um visitante comum já teria; o que decide tudo é RLS. [`sql/verificar_seguranca.sql`](sql/verificar_seguranca.sql) confere isso nas tabelas do painel inteiro (não só nas duas novas) — ver o ponto 6 da [seção 15](#15-segurança--resumo).
