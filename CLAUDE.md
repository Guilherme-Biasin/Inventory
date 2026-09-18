# Inventory Guemat — regras para o agente

Controle de patrimônio de TI da Guemat. Projeto **irmão do Gerente Assist**
(`../gerente-assist`): mesma arquitetura, mesmo jeito de trabalhar. Em dúvida
de padrão (servidor, login, só leitura, NSSM, documentação), veja como o GA faz
e replique.

Antes de mexer em qualquer coisa, leia:

- [LEIA-ME.md](LEIA-ME.md) — produção, desenvolvimento, estrutura, papéis,
  importação e as regras de segurança;
- [ETAPAS.txt](ETAPAS.txt) — o que está feito e o que falta, na ordem;
- [api/sql/INSTALACAO.md](api/sql/INSTALACAO.md) — banco, serviço e problemas comuns.

Regras escolhidas do `CLAUDE.md` do Gerente Assist em 17/09/2026. As que
**não** vieram, e por quê, estão no fim.

---

## 1. Processo

1. **Explicar antes de codar.** Para lógica nova: diga o que entendeu, espere o
   gerente validar (ele costuma corrigir), só então implemente, e ao terminar
   valide de novo rodando. Não pule etapas.
2. **Regra de negócio ambígua: pergunte** antes de implementar. Não presuma.
3. **O agente NÃO dá `git push`.** Commita na `main` local e para. Push na
   `main` faz a Vercel publicar a tela na hora — subir sem pedir é decidir por
   ele o que vai para produção. Ao terminar, diga que o commit está feito e
   espere ele mandar subir. A API só anda com `git pull` + restart na VM, que é
   sempre ele.
4. **Documentação a cada etapa.** Ao concluir uma etapa, `LEIA-ME.md`,
   `api/sql/INSTALACAO.md` e `ETAPAS.txt` são atualizados **no mesmo commit** do
   código. Etapa sem documentação conferida não está concluída.
5. **O gerente testa no Chrome e manda prints anotados** com setas e caixas
   coloridas. Cores diferentes no mesmo print costumam ser pedidos diferentes —
   leia cada uma como uma instrução separada.
6. **Comunicação**: em português, objetiva, com um resumo claro do que foi feito
   no fim de cada rodada — não relatório longo de processo.
7. **Fileira de cards que quebraria para a segunda linha vira carrossel**
   (pedido em 18/09/2026, mesma regra do GA). A linha extra empurra para fora da
   tela justamente o que se veio ver. O padrão é `faixa-wrap`/`faixa-pista`/
   `faixa-seta`, **manual** — seta ou arraste, sem tempo automático —, com os
   cards do mesmo tamanho e as setas só aparecendo quando há o que rolar.

## 2. Testar de verdade antes de dizer "pronto"

7. **`npm test` dentro de `api/`** — roda sem banco e precisa passar inteiro.
   Mudou regra de rota? O teste muda junto.
8. **Navegador**: subir o servidor, abrir no navegador do Claude
   (`mcp__Claude_Browser__*`), simular o uso com `javascript_exec` e conferir
   `read_console_messages` com `onlyErrors: true` — zero erros.
9. **No notebook, suba com `api\iniciar-leitura.bat`** (ou `SOMENTE_LEITURA=1`).
   Não existe banco de teste: o `config/db.json` aponta para o `ESTOQUE_TI` de
   produção, e o `iniciar.bat` grava de verdade. Teste de gravação se faz com o
   banco simulado (como em `api/testes/handlers.test.js`), nunca no banco real.
10. **Se algum dado de teste chegar ao banco real, limpe** antes de encerrar a
    sessão, e avise o que foi limpo.
11. **Pare o servidor de teste ao terminar** — não deixe processo pendurado:
    ```
    Get-NetTCPConnection -LocalPort <porta> -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
    ```
    A porta **3001 é do Gerente Assist** e a 3002 é deste sistema; para teste
    use outra (ex.: `PORT=3092`).
12. **"Atualizei e não mudou nada"**: antes de investigar, compare a `versao` de
    `GET /api/v1/ambiente` com `git log --oneline -1`. Diferente = o pull não
    veio ou o serviço não reiniciou. Só depois procure outra causa (migração
    faltando, cache do navegador).

## 3. Banco

13. **Mudança de estrutura (CREATE/ALTER) roda no SSMS, pelo dono do banco.**
    O `estoque_rw` só tem SELECT/INSERT/UPDATE/DELETE no schema `app`, de
    propósito. O agente escreve o script; quem roda é o gerente.
14. **Toda migração nova é um arquivo numerado** na sequência de `api/sql/`
    (`05_migracao_...sql`, `06_...`), que confere se a mudança já existe antes de
    aplicar, e entra na tabela de migrações do `INSTALACAO.md` **no mesmo commit**
    que a cria. O `02_schema.sql` também recebe a mudança, para instalação nova
    já nascer completa.

## 4. Código

15. **Português** em variáveis, funções, comentários e textos da tela.
16. **Sem framework, sem bundler, sem TypeScript.** Front em JS puro carregado
    por `<script>` (funções no escopo global — cuidado com nomes repetidos entre
    arquivos). API em Node puro; a única dependência é o `mssql`.
17. **Comente o porquê, não o óbvio.** O código daqui explica decisões e os
    casos que as originaram; mantenha esse padrão.

## 5. Segurança — não negociável

18. **Todo texto do banco ou da planilha passa por `esc()`** antes de entrar em
    `innerHTML`, e por `escJs()` dentro de `onclick`. Cor só como `#hex`
    (`corSegura()`). Vale para número, marca, modelo, série — tudo.
19. **Permissão se aplica no servidor** (`PODE` e `soAdmin` em `server.js`).
    Esconder botão na tela é só conforto. O papel que vale é o do banco
    (`sessaoValida`), não o do token.
20. **Nenhum usuário, senha ou hash de senha no repositório** — nem em script,
    nem em documentação, nem como exemplo com nome real. Em exemplo use
    `<login>`, `Fulano de Tal`, `fulano.tal`. Senha de teste só nos testes
    automatizados, com valor claramente falso.

---

## Regras do Gerente Assist que NÃO vieram

| Regra do GA | Por que ficou de fora |
|---|---|
| Lógica antes de estilo (HTML cru até o fim) | A tela deste sistema já está estilizada |
| Nunca remover o modo mock | Aqui não existe mock — decisão pendente na ETAPA 6 do `ETAPAS.txt`. Se o mock for criado, a regra passa a valer |
| Nunca mostrar 2 empresas ao mesmo tempo | Não há loja/empresa no banco do estoque: o inventário de TI é um só |
