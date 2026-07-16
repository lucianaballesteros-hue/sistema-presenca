# Arquitetura do Sistema de Presença

Este documento explica, em detalhe, o que cada parte do código faz e como elas se conectam. É o complemento "por dentro" do `README.md` (que foca em como rodar o projeto).

## Índice

1. [Visão geral](#1-visão-geral)
2. [Como tudo se conecta](#2-como-tudo-se-conecta)
3. [`index.html`](#3-indexhtml)
4. [`styles/`](#4-styles)
5. [`src/config/`](#5-srcconfig)
6. [`src/state/store.js`](#6-srcstatestorejs)
7. [`src/api/`](#7-srcapi--repositórios)
8. [`src/domain/`](#8-srcdomain--regras-de-negócio)
9. [`src/shared/`](#9-srcshared--utilitários)
10. [`src/features/`](#10-srcfeatures)
11. [`src/main.js`](#11-srcmainjs--a-raiz-de-composição)
12. [Modelo de dados (inferido)](#12-modelo-de-dados-inferido)
13. [Fluxos completos, passo a passo](#13-fluxos-completos-passo-a-passo)
14. [O que existe fora deste código](#14-o-que-existe-fora-deste-código)
15. [Segurança — resumo](#15-segurança--resumo)

---

## 1. Visão geral

O sistema é um painel para a equipe da Financial Experts controlar **turmas**, **alunos** e **presença** (chamada), gerar **relatórios** e **métricas** de frequência/evasão, e administrar **professores** (usuários do sistema).

- **Front-end**: HTML + CSS + JavaScript puro, sem framework (nada de React/Vue) e sem passo de build (nada de Vite/webpack). Os módulos JS usam `import`/`export` nativos do navegador.
- **Back-end**: [Supabase](https://supabase.com) — um Postgres hospedado com API REST automática e autenticação prontas. O front-end fala diretamente com o Supabase pelo SDK `@supabase/supabase-js` (carregado via CDN no `index.html`).
- **Exportação**: a biblioteca `xlsx` (SheetJS, também via CDN) gera o arquivo `.xlsx` do relatório.
- **Sem servidor próprio**: não há backend Node/Python neste repositório. Tudo que hoje é "lógica de servidor" (autenticação, permissões, e-mails automáticos) é responsabilidade do próprio Supabase ou de algo fora deste código (veja [seção 14](#14-o-que-existe-fora-deste-código)).

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

- **`state` central** (`src/state/store.js`): um objeto só, importado por quase todo mundo, com os dados carregados (turmas, alunos, presenças...) e o "estado da tela" (qual aluno está selecionado, qual filtro está ativo etc.). Não existe estado duplicado escondido em variáveis locais de cada arquivo.
- **Ponte para o HTML** (`src/main.js`): como o HTML chama funções por nome (`onclick="abrirChamada(5)"`), e módulos ES não criam variáveis globais automaticamente, o `main.js` importa a função de cada feature e a registra explicitamente em `window`. É a única parte do código onde isso acontece — todo o resto é import/export normal.

---

## 3. `index.html`

Um único HTML com todas as telas dentro (nenhuma navegação de página — é uma SPA "manual"). Principais blocos, na ordem:

| Bloco | O que é |
|---|---|
| `<head>` | Ícone, os dois `<script>` de CDN (Supabase e xlsx), um script inline que aplica o tema salvo **antes** do CSS carregar (evita flash de tela clara ao abrir no escuro), e os 15 `<link rel="stylesheet">` de `styles/`. |
| `#login-page` | Formulário de e-mail/senha. |
| `#app` | A aplicação depois de logado: cabeçalho (`.header`), menu de abas (`.nav`) e o conteúdo (`.content`). |
| `#tab-turmas` | Contém **duas visões que se alternam**: `#dash-view` (grade de turmas) e `#chamada-view` (fazer chamada de uma turma). Só uma fica visível por vez. |
| `#tab-alunos` | Tabela de alunos com filtros. |
| `#tab-relatorio` | Filtros (multi-select) + tabelas de frequência por turma + botão de exportar Excel. |
| `#tab-metricas` | Quatro tabelas (visão geral, por curso, frequência, evasão). |
| `#tab-professores` | Grade de cartões de professores (só visível para admins). |
| `.modal-bg#modal-*` | Nove modais (aluno, editar aluno, transferir, novo aluno, novo professor, editar professor, nova turma, editar turma) — todos escondidos por padrão, abrem recebendo a classe `.open`. |
| `#toast`, `#app-loading`, `#update-banner` | Elementos de feedback global (aviso rápido, tela de carregamento, banner de "nova versão disponível"). |
| `<script type="module" src="src/main.js">` | Carrega a aplicação. Fica no fim do `<body>` para simplicidade, mas como é `type="module"`, o navegador já executa de forma adiada (equivalente a `defer`) — ou seja, roda depois que todo o HTML acima foi criado. |

Quase todo elemento interativo tem um atributo inline (`onclick`, `onchange`, `oninput`, `onkeydown`) chamando uma função pelo nome — essas funções são exatamente as que o `main.js` registra em `window` (seção 11).

---

## 4. `styles/`

O CSS antigo (um arquivo de 28KB) foi dividido por responsabilidade. A ordem de carregamento no `<head>` importa (CSS depois sobrescreve CSS de antes):

```
base/reset.css          reset básico (*, body, a)
base/theme-tokens.css   TODAS as variáveis de cor (:root = tema claro, [data-theme="dark"] = escuro)
layout/header.css       cabeçalho fixo no topo (logo, avatar, botão sair)
layout/nav.css          menu de abas
layout/content.css      container central + containers específicos da tela de chamada
components/login.css    card de login
components/buttons.css  TODOS os botões do sistema (primário, salvar, cancelar, perigo, aviso,
                         toggle de tema, presença P/F/R, presets de horário, categorias de observação...)
components/badges.css   selos coloridos (badge-verde/âmbar/vermelho/...) e as pills de filtro por curso
components/forms.css    campos de formulário, seletor de horário, seletor de dias, seletor de cor,
                         indicador "mostrar senha", classes .search-input e .field-error
components/cards.css    cards de estatística, turma, professor e as seções de métricas
components/tables.css   tabela padrão, barra de frequência, tabela de métricas
components/modals.css   estrutura dos modais + caixas de aviso/informação
components/dots.css     os "pontinhos" de histórico no relatório + o menu que abre ao clicar neles
components/multiselect.css  barra de filtros + os dropdowns de múltipla escolha do relatório
components/toast.css    toast, tela de carregamento, banner de atualização, estado vazio
```

**Como funciona o tema escuro**: todas as cores usadas nos outros arquivos são `var(--nome)`. `theme-tokens.css` define esses nomes duas vezes — uma vez dentro de `:root` (valores claros) e outra dentro de `[data-theme="dark"]` (valores escuros). Quando `toggleTema()` (seção 10.1) adiciona `data-theme="dark"` na tag `<html>`, todas as variáveis trocam de valor de uma vez, sem tocar em nenhum outro CSS.

---

## 5. `src/config/`

- **`env.js`** (não versionado — está no `.gitignore`): exporta `SUPABASE_URL` e `SUPABASE_ANON_KEY`, os únicos dois valores que mudam entre "ambientes" (ex.: se um dia existir um projeto Supabase de teste separado do de produção).
- **`env.example.js`**: o mesmo arquivo com valores de exemplo, versionado, para quem clonar o projeto saber o que preencher.

Nenhum outro arquivo tem uma credencial hardcoded — todos importam de `config/env.js` (direto, ou indiretamente via `api/supabaseClient.js`).

---

## 6. `src/state/store.js`

Um único objeto exportado, `state`, com dezoito campos. É o "banco de dados na memória" da aba aberta no navegador:

| Campo | Tipo | Para que serve |
|---|---|---|
| `TURMAS` | array | Todas as turmas visíveis para quem está logado (admin vê todas; professor só as suas). |
| `ALUNOS` | array | Todos os alunos das turmas acima. |
| `PRESENCAS` | objeto | Cache de presença, indexado por `"turmaId_NomeDaAula"` → `{ alunoId: 'P'|'R'|'F' }`. |
| `HISTORICO` | array | Toda movimentação (inativação, transferência, observação...) de todos os alunos carregados. |
| `PROFESSORES` | array | Todos os usuários do sistema (admins e professores). |
| `usuarioLogado` | objeto/null | O usuário do Supabase Auth (tem `.id`, `.email`). |
| `perfilLogado` | objeto/null | A linha correspondente na tabela `professores` (tem `.nome`, `.papel`). |
| `turmaAtual` | objeto/null | Turma aberta na tela de chamada. |
| `turmaEmEdicaoId` | number/null | Turma sendo editada no modal "Editar turma". |
| `filtroCurso` | string | Filtro ativo nas pills de curso do dashboard (`''`, um nome de curso, `'__minhas__'` ou `'__inativas__'`). |
| `alunoSelecionadoId` / `profSelecionadoId` | number/null | Quem está aberto no modal de detalhes. |
| `chamadaAlterada` | objeto | Reservado para marcar alterações não salvas na chamada — existe desde o código original, mas nada hoje lê esse valor (é reiniciado a cada `abrirChamada`, e não influencia o comportamento atual). |
| `dotMenuContext` | objeto/null | Qual aluno/turma/aula o menu de edição rápida (clique no pontinho) está editando. |
| `obsCategoriaSelecionada` | string/null | Categoria escolhida ao adicionar uma observação. |

Qualquer módulo pode ler `state.TURMAS`, por exemplo; para **alterar**, também se mexe direto no objeto (`state.TURMAS.push(...)`, `state.filtroCurso = 'x'`) — não existem "actions" ou um padrão Redux aqui, é deliberadamente simples.

---

## 7. `src/api/` — repositórios

Cada arquivo corresponde a uma tabela do Supabase e é o **único lugar** que fala com `sb` (o cliente Supabase) para aquela tabela. As features nunca chamam `sb` diretamente (exceto `auth.js`, que trata login/logout/sessão — ver seção 10.2).

| Arquivo | Tabela | Funções |
|---|---|---|
| `supabaseClient.js` | — | Cria e exporta `sb = supabase.createClient(...)`. |
| `turmasRepo.js` | `turmas` | `carregarTurmas()` (preenche `state.TURMAS`, filtrando por professor se não for admin), `inserirTurma()`, `atualizarTurma()`. |
| `alunosRepo.js` | `alunos` | `carregarAlunos()` (pagina de 1000 em 1000 linhas — ver abaixo), `inserirAluno()`, `atualizarAluno()`, `atualizarAlunosEmLote()` (usado para inativar/reativar em massa quando uma turma é inativada). |
| `presencasRepo.js` | `presencas` | `carregarPresencas()` (também paginado), `salvarPresenca()` (upsert por `turma_id+aluno_id+aula`), `removerPresenca()`, `moverPresencasDeTurma()` (usado na transferência de turma). |
| `historicoRepo.js` | `historico` | `carregarHistorico()`, `registrarMovimentacao()`, `registrarMovimentacoesEmLote()`, `carregarObservacoes()` / `registrarObservacao()` (mesma tabela, filtrando por `tipo = 'observacao'`). |
| `professoresRepo.js` | `professores` + Auth | `carregarProfessores()`, `criarContaAuth()` (chama o endpoint público de signup do Supabase Auth via `fetch`, sem afetar a sessão do admin logado), `criarPerfilProfessor()`, `atualizarProfessor()`, `enviarResetSenha()`. |

**Por que paginar `alunos` e `presencas` manualmes**: o Supabase/PostgREST limita cada resposta a um número máximo de linhas. Essas duas funções fazem um laço `while (true)` pedindo 1000 linhas por vez (`.range(from, from+999)`) até a resposta vir vazia ou menor que 1000 — sinal de que acabou.

---

## 8. `src/domain/` — regras de negócio

Funções puras (sem tocar no DOM nem no Supabase) que calculam coisas a partir do `state`.

### 8.1 `attendance.js`

- **`AULAS`**: lista fixa `['Aula 1', ..., 'Aula 32']` — o sistema suporta turmas de até 32 aulas.
- **`aulasDaTurma(turma)`**: recorta `AULAS` no `total_aulas` configurado da turma (ou usa as 32 se não configurado).
- **`calcAluno(aluno)`** — a função mais importante do sistema. Para um aluno, percorre todas as aulas da turma dele e devolve:
  - `seq`: a sequência de status (`'P'|'R'|'F'|'N'`, sendo `'N'` = não registrado) aula a aula.
  - `p`: total de presenças, **contando `P` e `R` juntos** (gravação conta como presença).
  - `r`: quantas dessas foram especificamente gravação (`R`), separado, só para exibir.
  - `f`: total de faltas.
  - `freq`: `p / (p + f)` em porcentagem arredondada — ou `null` se não há nenhuma aula com `P`/`F` registrada ainda (não penaliza quem ainda não teve nenhuma aula lançada).
  - `maxConsec`: maior sequência de faltas seguidas em toda a turma.
  - `emAlerta`: **regra de alerta** — olha só as **últimas 8 aulas que têm algum registro** (ignora as sem registro) e verifica se há 3 ou mais faltas seguidas dentro delas. Isso é o que pinta o aluno de vermelho no sistema inteiro.

### 8.2 `status.js`

- **`freqBar(freq)`**: HTML de uma barrinha colorida (verde ≥70%, âmbar ≥50%, vermelho abaixo) + o número.
- **`statusBadge(freq, emAlerta, ativo)`**: decide o selo textual — nessa ordem de prioridade: Inativo → ⚠ Alerta → Sem registro → Regular (≥70%) → Atenção (<70%).
- **`corBadge(curso)`**: mapeia o **nome** do curso para uma cor de selo (procura as palavras "Elas", "Master", "Evolution", "Clube" no nome; qualquer outro nome cai no cinza). É baseado em texto, não em um ID de curso — cursos não são uma tabela própria, são só um texto livre no campo `turmas.curso`.
- **`statusInativo(alunoId)`**: um aluno inativo é "cancelado" ou só "inativo" (temporário)? A função olha a movimentação mais recente do histórico desse aluno que contenha "inativad" ou "cancelad" no texto e decide por aí — não existe uma coluna de status separada, é inferido do texto do histórico.
- **`ordemDia(nomeTurma)`**: para ordenar as turmas no dashboard por dia da semana, procura "Segunda", "Terça" etc. **no nome da turma** (de novo, texto livre, não uma coluna estruturada).

---

## 9. `src/shared/` — utilitários

- **`dom.js`**: `escapeHtml` (escapa `&<>"'` para exibir texto com segurança dentro de HTML), `escapeAttr` (mais forte — para quando o valor vai dentro de um `onclick="fn('valor')"`, precisa neutralizar dois níveis: o literal JS de aspas simples e o atributo HTML de aspas duplas ao mesmo tempo), `showToast`, `fecharModal`, `toggleSenha` (mostra/oculta senha nos campos de senha), `wireModalBackdrops` (fecha modal ao clicar fora dele).
- **`validators.js`**: `isEmailValido` — checagem simples de formato de e-mail.
- **`navigation.js`**: `goTab(tab)` — troca qual aba está visível e, se a aba for relatório/métricas/professores, manda ela se redesenhar (essas telas são recalculadas na hora de entrar, não ficam atualizando sozinhas em segundo plano).
- **`updateNotifier.js`**: a cada 30 segundos, busca o próprio `index.html` de novo e compara a tag `<meta name="app-version">` com a que já está carregada; se mudou, mostra o banner "Atualização disponível". É a forma (simples, sem service worker) de avisar quem está com a aba aberta que subiu uma versão nova.

---

## 10. `src/features/`

Cada pasta é uma área da tela. Nenhuma feature acessa `sb` diretamente — sempre passa por `api/`.

### 10.1 `theme/` — troca de tema

Um arquivo, uma função: `toggleTema()` alterna o atributo `data-theme` da tag `<html>` e salva a escolha no `localStorage` (`'tema': 'claro'|'escuro'`). O script inline no `<head>` do `index.html` lê esse mesmo valor **antes** do CSS carregar, para não piscar claro por uma fração de segundo ao abrir no tema escuro.

### 10.2 `auth/auth.js` — login, logout, boot da aplicação

- **`doLogin()`**: lê e-mail/senha da tela, chama `sb.auth.signInWithPassword`. Se der certo, guarda o usuário em `state.usuarioLogado`, busca o perfil (`carregarPerfil`) e chama `inicializarApp()`.
- **`carregarPerfil()`**: busca a linha de `professores` cujo `user_id` bate com o usuário autenticado — é daqui que vem `state.perfilLogado.papel` (`admin`/`professor`) e `.nome`.
- **`inicializarApp()`**: mostra a tela de carregamento, preenche o avatar/nome no cabeçalho, mostra a aba "Professores" só se for admin, e dispara o carregamento de tudo (turmas → alunos → presenças/histórico/professores em paralelo) antes de desenhar o dashboard, a tabela de alunos e o relatório pela primeira vez.
- **`doLogout()`**: `sb.auth.signOut()` e volta para a tela de login.
- **`restoreSession()`**: ao abrir a página, pergunta ao Supabase se já existe uma sessão válida (token salvo no navegador) e, se sim, faz login automático sem pedir e-mail/senha de novo.

### 10.3 `dashboard/` — aba "Turmas"

- **`dashboardView.js`**:
  - `renderDash()`: desenha os 4 cartões de estatística (turmas, alunos ativos, irregulares, alertas), as "pills" de filtro por curso (incluindo os atalhos especiais "Suas Turmas" e "Turmas inativas") e a grade de cartões de turma — cada cartão mostra curso, professor, quantidade de alunos, quantos estão em alerta (clicável, ver `irParaAlertas`) e o horário configurado.
  - `setCurso(c)`: troca `state.filtroCurso` e redesenha.
  - `irParaAlertas(turmaId)`: atalho que muda para a aba Alunos já filtrando por aquela turma + status "Alerta".
- **`turmaModals.js`** (o arquivo mais longo do projeto): tudo que envolve criar/editar uma turma —
  - `TURMA_CORES`: paleta fixa de 8 cores para o "pontinho" de cada turma.
  - Um conjunto de helpers de horário/dias reaproveitados tanto no modal de criar quanto no de editar (por isso recebem um `prefix`, `'nt'` ou `'et'`, para saber em qual conjunto de campos mexer): preencher os `<select>` de hora/minuto, marcar os dias da semana, aplicar um horário "preset" (08:00, 14:00...), limpar horário.
  - `abrirModalNovaTurma` / `salvarNovaTurma` e `abrirModalEditarTurma` / `salvarEditarTurma`.
  - `toggleTurmaAtiva(tId)`: a função com mais efeito colateral do sistema — inativar uma turma **inativa em cascata todos os alunos ativos dela**, gravando no histórico a frase exata `"Aluno inativado automaticamente (turma inativada)"`. Reativar a turma **só reativa quem foi inativado por essa cascata** (compara com essa mesma frase no histórico) — um aluno que alguém cancelou manualmente antes não volta sozinho.

### 10.4 `chamada/chamadaView.js` — fazer a chamada

- `abrirChamada(turmaId)`: troca a visão do dashboard para a tela de chamada, preenche o `<select>` de aulas.
- `renderChamada()`: para a aula escolhida, mostra contadores (presentes/faltas/gravações/sem registro) e a lista de alunos com 3 botões cada (✓ Presente, ✗ Falta, ↺ Gravação).
- `marcar(alunoId, status)`: clicar de novo no mesmo status **desmarca** (fica "sem registro"). Atualiza a tela imediatamente (otimista) e só depois salva no Supabase; se der erro, avisa por toast (mas não desfaz visualmente — é a única função que não faz rollback local, diferente de `selecionarStatusDot` no relatório).

### 10.5 `alunos/` — aba "Alunos" e o modal de detalhes

- **`alunosTable.js`**: `renderTabelaAlunos()` monta a tabela com todos os filtros (busca por nome, curso, turma, status incluindo "Alerta" e "Irregular"). `atualizarTurmasAlunos()` repopula o `<select>` de turma quando o curso muda.
- **`alunoModal.js`**: o modal que abre ao clicar num aluno — mostra os dados, as últimas 8 aulas com registro, o histórico de movimentações, e tem os botões de ação:
  - `toggleInativo` / `cancelarMatricula`: os dois "desligam" o aluno (`ativo = false`), a diferença é só a frase gravada no histórico (`statusInativo`, seção 8.2, usa essa frase depois para saber se foi "cancelamento" ou "inativação").
  - `abrirModalEditar` / `salvarEdicao`: troca o nome.
  - `abrirModalTransferir` / `confirmarTransferencia`: muda o aluno de turma **e** move todo o histórico de presença dele (`moverPresencasDeTurma`) para a nova turma — se mover o aluno funcionar mas mover as presenças falhar, a função desfaz a troca do aluno para não deixar dado inconsistente.
  - `abrirModalNovoAluno` / `salvarNovoAluno`: cadastra aluno novo.
- **`observacoes.js`**: dentro do mesmo modal, uma seção de "anotações" sobre o aluno (reclamação, pedido de transferência, feedback...). `OBS_CATEGORIAS` é a lista fixa de categorias com ícone e cor. Cada observação é, na prática, uma linha na tabela `historico` marcada com `tipo = 'observacao'`.

### 10.6 `professores/` — aba "Professores" (só admin)

- **`professoresView.js`**: `renderProfessores()` desenha os cartões (avatar colorido por `profColor(id)`, iniciais por `profIniciais(nome)`, quantas turmas cada um tem).
- **`professorModal.js`**:
  - `salvarNovoProf()`: cria a conta de autenticação (`criarContaAuth`, via signup público) e, se der certo, cria a linha correspondente em `professores` linkando pelo `user_id`. Senha inicial sugerida: `Teste1234`.
  - `salvarEdicaoProf()`: atualiza nome/e-mail/papel. **Não tenta mudar a senha de ninguém** — se o campo de nova senha vier preenchido, a função para e explica para usar o reset por e-mail (ver [seção 15](#15-segurança--resumo), ponto 2).
  - `enviarResetSenha()`: dispara o e-mail de redefinição de senha do próprio Supabase Auth.

### 10.7 `relatorios/` — aba "Relatórios"

- **`relatoriosView.js`**:
  - `popularFiltros()`: preenche todos os seletores de filtro (curso, professor, turma) a partir das turmas carregadas — chamado uma vez no boot e de novo sempre que uma turma é criada/editada.
  - Os multi-selects "Curso", "Professor", "Turma", "Mostrar" e "Status" são um dropdown genérico com checkboxes (`popularMultiPanel`, `getMultiSelecionados`, `onMultiCheck`, `toggleMultiDropdown`) reaproveitado 5 vezes.
  - `renderRel()`: aplica todos os filtros e desenha uma tabela por turma, com uma coluna de "pontinhos" (últimas 8 aulas com registro) clicáveis.
  - `abrirDotMenu` / `selecionarStatusDot`: clicar num pontinho abre um menu pequeno para corrigir a presença daquela aula específica sem precisar voltar para a tela de chamada — se salvar der erro, desfaz a mudança visual.
- **`exportExcel.js`**: `exportarExcel()` monta um arquivo `.xlsx` com 3 tipos de aba: um "Resumo Geral" (todo mundo, todas as turmas), uma aba por turma (aluno × aula, com o status de cada uma) e uma aba "Alertas" só com quem está em alerta. Usa a biblioteca global `XLSX` (carregada por `<script>` no `index.html`, não por `import`, porque é só usada aqui).

### 10.8 `metricas/metricasView.js` — aba "Métricas"

Um único `renderMetricas()` que monta 4 tabelas a partir dos mesmos dados já carregados (não faz nenhuma consulta nova ao Supabase): visão geral, dimensionamento por curso, frequência/desempenho e evasão/movimentação. Os números de "transferências", "novos alunos" e "reativações" são obtidos **filtrando o texto** das descrições no `historico` (ex.: conta quantas descrições contêm a palavra "Transferido") — de novo, não existe uma coluna de "tipo de evento" estruturada para movimentações (só para observações, que têm `tipo = 'observacao'`).

---

## 11. `src/main.js` — a raiz de composição

Três responsabilidades, nessa ordem:

1. **Importa** a função certa de cada feature (não tem lógica própria, só import).
2. **Registra em `window`** — um único `Object.assign(window, {...})` com todas as ~50 funções que o HTML (estático ou gerado dinamicamente por `innerHTML`) chama por nome. Esse bloco é a lista completa de "o que o HTML tem permissão de chamar".
3. **Liga os fios soltos** que não pertencem a nenhuma feature específica: fecha modal ao clicar fora (`wireModalBackdrops`), fecha o menu de pontinho/dropdowns ao clicar fora deles, tenta restaurar sessão (`restoreSession`) e liga o aviso de atualização (`startUpdateNotifier`).

---

## 12. Modelo de dados (inferido)

Não há acesso direto ao banco a partir deste código — o esquema abaixo foi **inferido** a partir das consultas feitas pelos repositórios (`src/api/`). Vale conferir no painel do Supabase se quiser ter certeza:

| Tabela | Colunas usadas pelo código |
|---|---|
| `turmas` | `id`, `turma` (nome), `curso` (texto livre), `professor` (nome, texto), `professor_id` (FK), `ativa` (bool), `cor`, `total_aulas`, `horario_inicio` (`HH:MM:SS` ou null), `dias_semana` (array de texto ou null) |
| `alunos` | `id`, `nome`, `turma_id` (FK), `ativo` (bool) |
| `presencas` | `turma_id`, `aluno_id`, `aula` (texto, ex. "Aula 3"), `status` (`'P'|'R'|'F'`) — chave única em `(turma_id, aluno_id, aula)` |
| `historico` | `id`, `aluno_id` (FK), `descricao` (texto livre), `created_at`, `tipo` (`'observacao'` ou vazio/null para movimentações comuns), `data_obs`, `categoria` (uma das `OBS_CATEGORIAS`) |
| `professores` | `id`, `nome`, `email`, `papel` (`'admin'|'professor'`), `user_id` (FK para o usuário do Supabase Auth) |

Vários campos "estruturados" no papel (curso, dia da semana, tipo de movimentação) são, na prática, **texto livre interpretado por código** (`corBadge`, `ordemDia`, os filtros de `historico.descricao` em métricas). Funciona, mas é frágil: mudar o texto de uma dessas frases em um lugar sem atualizar todos os outros quebra a lógica silenciosamente.

---

## 13. Fluxos completos, passo a passo

**Login → tela inicial**
`doLogin` → `sb.auth.signInWithPassword` → `carregarPerfil` → `inicializarApp` → carrega turmas → carrega alunos → carrega (em paralelo) presenças + histórico + professores → `popularFiltros` → `renderDash` + `renderTabelaAlunos` + `renderRel`.

**Fazer uma chamada**
`abrirChamada(turmaId)` → guarda `state.turmaAtual`, popula o `<select>` de aulas → `renderChamada()` desenha a lista → clicar num botão chama `marcar(alunoId, status)` → atualiza `state.PRESENCAS` e a tela na hora → `salvarPresenca`/`removerPresenca` no Supabase → `renderDash` e `renderTabelaAlunos` são redesenhados para refletir a nova frequência.

**Inativar uma turma**
`toggleTurmaAtiva(id)` → confirmação → `atualizarTurma(id, {ativa:false})` → busca todos os alunos ativos dessa turma → `atualizarAlunosEmLote` marca todos como inativos → grava um `historico` idêntico para cada um (`MARCA_INATIVACAO_AUTO`) → recarrega o histórico → redesenha dashboard e relatório.

**Transferir um aluno**
`confirmarTransferencia()` → `atualizarAluno(turma_id novo)` → `moverPresencasDeTurma` (todas as linhas de `presencas` desse aluno na turma antiga passam a apontar para a nova) → se isso falhar, desfaz o passo anterior → grava uma movimentação no histórico → atualiza o cache `state.PRESENCAS` local trocando as chaves de `"turmaAntiga_aula"` para `"turmaNova_aula"`.

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

1. **Credenciais fora do código-fonte**: `SUPABASE_URL`/`SUPABASE_ANON_KEY` vivem só em `src/config/env.js`, que não é versionado.
2. **Troca de senha de terceiros removida**: não é possível (nem deveria ser) definir a senha de outro usuário a partir do navegador — só o próprio Supabase Auth pode, via e-mail de redefinição (`enviarResetSenha`).
3. **Escape correto em atributos inline**: valores como nome de curso, que acabam dentro de `onclick="fn('valor')"`, passam por `escapeAttr` (não só `escapeHtml`), para não permitir que um texto com aspas quebre o atributo.
4. **Limitação conhecida e aceita (fora de escopo)**: a interface esconde a aba "Professores" e alguns botões de quem não é admin, mas isso é só estética — qualquer usuário autenticado consegue chamar as mesmas funções pelo console do navegador. A proteção de verdade contra isso precisa ser **Row Level Security** nas tabelas do Supabase, validando `papel` no banco, não no navegador.
