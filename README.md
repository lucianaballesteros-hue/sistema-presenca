# Sistema de Presença

Gestão de turmas, alunos e frequência (Financial Experts), com backend em [Supabase](https://supabase.com) (Postgres + Auth). É um front-end estático — sem framework, sem passo de build — organizado em módulos ES nativos do navegador.

> Para uma explicação detalhada de cada parte do sistema (o que cada arquivo faz, como os dados fluem, o modelo de dados inferido), veja [`ARQUITETURA.md`](ARQUITETURA.md).

## Estrutura

```
index.html              ponto de entrada
styles/                 CSS organizado por base/ (reset, tema) → layout/ (header, nav, content) → components/
src/
  config/               credenciais do Supabase (env.js, não versionado — veja env.example.js)
  api/                  acesso a dados: um arquivo por tabela (turmasRepo, alunosRepo, presencasRepo, historicoRepo, professoresRepo)
  state/                estado mutável central da aplicação (store.js)
  domain/               regras de negócio puras (cálculo de frequência/alerta, status)
  shared/               utilitários genéricos (escape de HTML, toasts, navegação entre abas)
  features/             uma pasta por área da tela (auth, dashboard, chamada, alunos, professores, relatorios, metricas)
  main.js               bootstrap: liga os módulos e expõe as funções que o HTML chama
img/                    logos
```

Cada `feature` só conhece o `state` compartilhado e as funções de `api`/`domain`/`shared` de que precisa — não há um arquivo "faz tudo".

## Rodando localmente

1. Copie `src/config/env.example.js` para `src/config/env.js` e preencha com a URL e a chave **anon** do seu projeto Supabase (Project Settings → API). Esse arquivo já vem preenchido neste repositório com o projeto atual — só recrie se for apontar para outro projeto Supabase.
2. Como o `index.html` carrega `src/main.js` como módulo ES (`<script type="module">`), o navegador bloqueia isso se você abrir o arquivo direto (`file://...`) — é preciso servir por HTTP. Qualquer servidor estático simples resolve, por exemplo:
   - Extensão **Live Server** do VS Code (botão "Go Live"), ou
   - `python -m http.server` na pasta do projeto (se tiver Python), ou
   - qualquer outro servidor estático de sua preferência.
3. Não há build: para publicar, basta subir os arquivos deste diretório (menos `src/config/env.js`, que cada ambiente configura por conta própria) para o mesmo tipo de hospedagem estática já usada hoje.

## Notas de segurança

- **Credenciais isoladas em `src/config/env.js`** (fora do controle de versão). Isso não torna a chave "anon" secreta — ela é pública por natureza em qualquer app Supabase, pois vai embutida no navegador. O ganho é não misturar configuração de ambiente com código-fonte e poder trocar/rotacionar a chave sem gerar diff no histórico.
- **A separação admin/professor na interface é conveniência, não segurança.** A aba "Professores" some da tela para quem não é admin, mas isso só esconde botões — qualquer usuário autenticado pode chamar as mesmas funções pelo console do navegador. A proteção real contra um professor comum criar/editar outros professores, ver turmas de outra pessoa, etc. precisa ser feita com **Row Level Security (RLS)** nas tabelas do Supabase (`turmas`, `alunos`, `presencas`, `professores`, `historico`), validando o papel do usuário no banco. Isso ficou fora do escopo desta reestruturação (só front-end) — recomendo tratar como próximo passo.
- **Trocar a senha de outra pessoa a partir do navegador não é possível** (e não deveria ser): isso exigiria a chave `service_role` do Supabase, que nunca pode existir no lado do cliente. O código anterior tentava isso com a chave pública e falhava silenciosamente às vezes; foi removido. O único fluxo válido é o botão "Enviar reset de senha", que manda um e-mail para o próprio professor escolher a senha nova.
- **Senha padrão de professores novos (`Teste1234`)** continua como está — é uma decisão de produto, não um bug de código. Recomendação para o futuro: forçar troca de senha no primeiro acesso.
