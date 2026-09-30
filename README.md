# API de Pagamentos — Teste Técnico Capco

API REST para o ciclo de vida de cobranças via **PIX** e **cartão de crédito** (Mercado Pago Checkout Pro),
em NestJS + PostgreSQL, com Clean Architecture.

> **Estado (30/09/2026):** os quatro endpoints e o webhook do Mercado Pago funcionam e têm testes
> automatizados (com o Mercado Pago simulado). O caminho feliz do cartão foi validado uma vez, de ponta a
> ponta, com o Mercado Pago real e contas de teste, na configuração descrita em
> [Teste de ponta a ponta](#teste-de-ponta-a-ponta-com-contas-de-teste-29092026). Reenvio, entrega duplicada,
> recusas, estornos e chargebacks **não** foram verificados com o Mercado Pago real.

## Requisitos do enunciado

| Requisito (obrigatório)                                         | Onde está                                                                | Evidência                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `POST /api/payment` cria um pagamento                           | `payment.controller.ts`, `create-payment.use-case.ts`                    | e2e `pix-payments`, `card-checkout`                                                |
| `PUT /api/payment/{id}` atualiza dados, "como o status"         | `update-payment.use-case.ts` (veja a interpretação abaixo)               | e2e `pix-list-update`; unitários `update-payment`                                  |
| `GET /api/payment/{id}`                                         | `get-payment.use-case.ts`                                                | e2e `pix-payments`                                                                 |
| `GET /api/payment` com filtros (CPF, meio de pagamento)         | `list-payments.use-case.ts`                                              | e2e `pix-list-update`                                                              |
| `id`, `cpf`, `description`, `amount`, `paymentMethod`, `status` | `domain/payment`, `payment.presenter.ts`                                 | unitários `payment`, e2e                                                           |
| `PENDING`, `PAID`, `FAIL`                                       | `domain/payment/payment-types.ts`                                        | unitários `payment`                                                                |
| PIX: só grava `PENDING`, sem integração                         | `create-payment.use-case.ts`                                             | e2e `pix-payments`                                                                 |
| Cartão: API de Preferências do Checkout Pro                     | `mercado-pago-checkout.gateway.ts`                                       | unitários do adaptador (SDK real, rede simulada); validado com o Mercado Pago real |
| Cartão: callback (notificação) atualiza o status                | `webhooks/*`, `settle-card-payment.use-case.ts`                          | unitários, integração, e2e; validado com o Mercado Pago real (`PENDING` → `PAID`)  |
| Testes unitários                                                | `test/unit`                                                              | `npm test`                                                                         |
| RESTful                                                         | recursos, verbos, códigos HTTP, erros RFC 9457                           | e2e                                                                                |
| Validação de entrada (CPF, `amount` etc.)                       | DTOs, objetos de valor (`Cpf`, `Money`, `Description`), `CHECK` no banco | unitários + e2e                                                                    |
| Clean Architecture                                              | camadas `domain`/`application`/`infrastructure`/`presentation`           | regras de lint por camada (`npm run lint`)                                         |
| Controle de versão                                              | Git, commits revisados por etapa                                         | histórico                                                                          |

**Opcional, não implementado:** Temporal.io. A entrega usa um único processo, com criação síncrona da
preferência e notificação processada dentro de um prazo; a falta de reconciliação que isso implica está em
[Limitações](#limitações-conhecidas-e-riscos-residuais).

**Interpretações nossas**, não literais no enunciado:

- `PUT`: aceita `description` (qualquer meio de pagamento e qualquer chave, enquanto `PENDING`) e `status`
  (`PAID`/`FAIL`; só PIX, com a permissão `settle`). `cpf`, `amount` e `paymentMethod` não mudam depois de
  criados, e o status de cartão muda só pelo Mercado Pago (tentar pelo `PUT` dá 409).
- Um cartão em `FAIL` passa a `PAID` quando o Mercado Pago confirma uma aprovação vinculada à cobrança (o
  enunciado dá "de PENDING para PAID ou FAIL" como exemplo, não como lista fechada).

**Adições nossas** (não pedidas): autenticação por API key e permissão `settle`; `failureReason`,
`checkoutUrl`, `createdAt` e `updatedAt` na resposta; filtro por `status` e paginação; auditoria de mudanças
de status; tabela de anomalias do provedor; CI.

## Como rodar

Pré-requisitos: Docker com Compose v2. Para rodar os testes ou a API fora do Docker: Node.js 24.9.0 ou mais
novo da linha 24 (`engines` no `package.json`: `>=24.9.0 <25`; o `.nvmrc` e o CI usam 24.15.0).

```bash
cp .env.example .env
docker compose up --build
```

- A API sobe em `http://localhost:3000` (publicada apenas em `127.0.0.1`).
- Se a porta 3000 ou a 5432 já estiver em uso (por exemplo, por outra cópia deste projeto), escolha outras
  portas e outro nome de projeto, para não tocar nos contêineres existentes:
  `API_HOST_PORT=3300 DB_HOST_PORT=55432 docker compose -p capco-outra up --build`. Com isso, a API fica em
  `http://localhost:3300`.
- O Compose sobe o PostgreSQL, aplica as migrations em um job separado e só então inicia a API.
- O `.env.example` traz uma **chave de demonstração publicada** (`demo-key-local-pix-testing-only`), aceita
  somente com `DEMO_MODE=true` e sem cartão configurado. Ela serve apenas para testes locais: não exponha uma
  instância em modo demo.
  Para gerar chaves reais: `npm run key:generate -- <id> [--settle]`.

Rodando a API no host (desenvolvimento):

```bash
npm ci
docker compose up -d db
npm run migrate:deploy
npm run start:dev   # gera o cliente Prisma e sobe com recarga automática
```

No host, a API escuta por padrão só em `127.0.0.1` (`HOST` no `.env`, um endereço IP; um `HOST` já exportado no
shell tem precedência sobre o `.env`). No Compose, o contêiner escuta em `0.0.0.0` e a porta publicada continua
restrita a `127.0.0.1`.

Com `DB_HOST_PORT` diferente de 5432, ajuste a porta em `DATABASE_URL` no `.env`.

## Exemplos

```bash
KEY=demo-key-local-pix-testing-only

# Criar um pagamento PIX (201 + Location)
curl -i -X POST http://localhost:3000/api/payment \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"cpf":"123.456.789-09","description":"Pedido #123","amount":150.75,"paymentMethod":"PIX"}'

# Consultar por id
curl http://localhost:3000/api/payment/<id> -H "X-API-Key: $KEY"

# Listar com filtros (CPF com ou sem máscara, meio de pagamento, status) e paginação (limit ≤ 100)
curl "http://localhost:3000/api/payment?cpf=12345678909&paymentMethod=PIX&status=PENDING&page=1&limit=20" \
  -H "X-API-Key: $KEY"

# Atualizar: descrição (qualquer chave, enquanto PENDING) e/ou status PIX (exige a permissão settle)
curl -X PUT http://localhost:3000/api/payment/<id> \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"status":"PAID"}'
```

`PUT` é uma **atualização parcial documentada** (o enunciado exige PUT): o corpo deve trazer `description`,
`status` ou ambos; qualquer outro campo é rejeitado. `status` aceita só `PAID` ou `FAIL`, só para PIX e só a
partir de `PENDING` (repetir o status atual não altera nada). O status de cartão pertence ao fluxo do
Mercado Pago (409). A chave de demonstração tem a permissão `settle`.

## Cartão de crédito (Mercado Pago Checkout Pro)

`POST /api/payment` com `"paymentMethod": "CREDIT_CARD"` grava o pagamento como `PENDING`, cria uma
preferência de Checkout Pro e responde `201` com `checkoutUrl` (o link onde o comprador paga). A preferência
usa o id do pagamento como `external_reference`, expira em `CHECKOUT_TTL_MINUTES` e não recebe CPF.

Se o comprador abandonar o checkout, o pagamento continua `PENDING`. A preferência é criada com
`expires: true` e `expiration_date_to` igual a agora + `CHECKOUT_TTL_MINUTES`, para que o Mercado Pago deixe de
aceitar o `checkoutUrl` depois disso (efeito não observado no teste), mas a API não expira nem reconcilia a
cobrança localmente (veja [Limitações](#limitações-conhecidas-e-riscos-residuais)).

Falhas parciais que o processo trata enquanto está rodando têm o resultado abaixo; quando o pagamento chega a
ser gravado, a resposta traz o `paymentId` para o cliente consultar o estado:

| Situação                                                                    | Resposta                           | Estado gravado                            |
| --------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| Cartão não configurado                                                      | 503 `card-payments-unavailable`    | nada é gravado                            |
| Mercado Pago recusou (4xx, exceto 408, 409, 423, 424 e 429)                 | 502 `checkout-failed`              | `FAIL` (`failureReason: CHECKOUT_FAILED`) |
| Preferência criada em outra conta que não a configurada (`MP_COLLECTOR_ID`) | 502 `checkout-failed`              | `FAIL` (`CHECKOUT_FAILED`)                |
| Timeout (inclusive corpo da resposta travado)                               | 504 `checkout-outcome-unknown`     | `FAIL` (`CHECKOUT_OUTCOME_UNKNOWN`)       |
| Conexão, 5xx, 408/409/423/424/429 ou resposta 2xx inutilizável              | 502 `checkout-outcome-unknown`     | `FAIL` (`CHECKOUT_OUTCOME_UNKNOWN`)       |
| Preferência criada, mas o registro dela falhou                              | 503 `checkout-state-not-persisted` | `PENDING` sem link                        |

Um timeout **não** prova que nada foi criado no Mercado Pago; por isso o motivo registrado é "resultado
desconhecido". `FAIL` com esse motivo também não garante que nenhuma preferência exista nem que nenhum pagamento
aconteça: se uma aprovação vinculada à cobrança chegar depois pelo webhook, a cobrança passa a `PAID`. A chamada
ao Mercado Pago é feita uma única vez (as tentativas automáticas do SDK ficam desligadas, porque a API de
preferências não documenta idempotência) e o tratamento de erro nunca sobrescreve um pagamento que já saiu de
`PENDING`. Se outra escrita acontecer durante a chamada (uma edição de descrição, por exemplo), o pagamento é
relido e a regra reaplicada, em vez de a resposta perder o link. Se a gravação de `FAIL` não puder ser
confirmada, o pagamento pode continuar `PENDING`, e o log de erro indica `stateRecorded: false`.

Esses resultados valem para erros tratados com o processo em execução. Se o processo for interrompido de forma
abrupta durante a criação (queda, `kill -9`, falta de memória), por exemplo depois de o Mercado Pago criar a
preferência e antes de o link ser gravado, o pagamento pode ficar `PENDING` sem link, e o cliente pode não
receber resposta nem `paymentId`. Não há recuperação nem reconciliação automática para esse caso (veja
[Limitações](#limitações-conhecidas-e-riscos-residuais)).

Para testar com o Mercado Pago real, com contas de teste e sem dinheiro real, siga os passos abaixo. Eles
descrevem **a única configuração validada de ponta a ponta**: contas de teste vendedora e compradora, a API
usando o Access Token da aplicação que fica **dentro da conta de teste vendedora**, e o webhook configurado
nessa mesma aplicação, no **modo produção**. Outras combinações (por exemplo, credenciais de teste da sua conta
real com a URL do modo teste) não foram validadas.

1. Em <https://www.mercadopago.com.br/developers>, crie (ou abra) sua aplicação **Checkout Pro** e, nela, as
   contas de teste de **vendedor** e de **comprador**.
2. Em uma janela anônima, entre com a conta de teste **vendedora**, abra _Suas integrações_ e a aplicação
   dessa conta. Coloque o Access Token dela em `.env.mp` (`MP_ACCESS_TOKEN=...`; o arquivo é ignorado pelo
   git) e rode `npm run mp:probe`. Ele cria uma preferência de teste e mostra, sem imprimir segredos: o
   `collector id` (o id da conta dona do token), se essa conta é um usuário de teste (`test_user`) e qual
   aplicação cria os checkouts — é nela que o webhook deve ser configurado. Qual aba de credenciais dessa
   aplicação forneceu o token do teste não ficou registrado; o sinal observado foi o pagamento aprovado sair com
   `live_mode: true`.
3. Exponha só a rota do webhook, e só durante o teste. `npm run webhook:proxy` encaminha apenas
   `POST /api/webhooks/mercado-pago` de `127.0.0.1:8081` para a API em `127.0.0.1:3000`; se a API estiver em
   outra porta (por exemplo, com `API_HOST_PORT` no Compose), use `PORT=<porta> npm run webhook:proxy`.
   Qualquer outro caminho ou método recebe 404. Aponte um túnel para o proxy — no teste usamos um Cloudflare
   Quick Tunnel (gratuito, sem conta): `cloudflared tunnel --url http://127.0.0.1:8081`. O Quick Tunnel ganha
   um endereço novo a cada início, então o passo 4 precisa ser refeito a cada execução.
4. Na aplicação indicada pelo probe, abra _Webhooks → Configurar notificações_, escolha **Modo produção** e
   cadastre `https://<endereço do túnel>/api/webhooks/mercado-pago` com o evento **Pagamentos**. No teste, o
   pagamento saiu com `live_mode: true`, e uma URL cadastrada no modo teste de outra aplicação não recebeu nada.
5. Preencha no `.env` as três variáveis de cartão: `MP_ACCESS_TOKEN`, `MP_COLLECTOR_ID` (o id do passo 2) e
   `MP_WEBHOOK_SECRET` (a assinatura secreta **dessa** configuração de webhook). Troque também a chave de
   demonstração por uma chave gerada (`npm run key:generate -- <id> --settle`): com cartão configurado, a
   chave publicada é recusada. Reinicie a API, porque o `.env` só é lido na inicialização: no Compose,
   `docker compose up -d api` (um `restart` não relê o `env_file`); no host, pare e rode `npm run start:dev`
   de novo.
6. Feche a janela anônima da conta vendedora (janelas anônimas do mesmo navegador compartilham a sessão) ou use
   outro navegador ou perfil. Crie um pagamento de cartão na API e abra o `checkoutUrl` logado como o comprador
   de teste. Pague com um dos cartões de teste da documentação do Mercado Pago (_Checkout Pro → Testar
   compras_), com o nome do titular `APRO` para aprovar.
7. Ao terminar, feche o túnel e o proxy e remova a URL do painel.

### Confirmação pelo webhook

O Mercado Pago avisa mudanças de pagamento em `POST /api/webhooks/mercado-pago`. Essa rota não usa API key:
ela é autenticada pela assinatura `x-signature` (HMAC-SHA256 com `MP_WEBHOOK_SECRET`), exigida sempre — sem
assinatura válida, nada é processado. O corpo da notificação nunca é tratado como verdade: ele só indica
**qual** pagamento mudou. A API:

1. recusa entradas ambíguas antes de validar a assinatura (id repetido, não numérico ou divergente entre
   query e corpo; cabeçalhos repetidos): 400;
2. valida a assinatura: 401;
3. ignora tópicos que não são `payment`: 200;
4. consulta o pagamento no Mercado Pago (`GET /v1/payments/:id`, uma tentativa, até 4 s);
5. confere o vínculo com a cobrança: `external_reference` é um pagamento de cartão nosso, na conta
   `MP_COLLECTOR_ID`, em BRL, com o valor exato em centavos (sem arredondar) e tipo `credit_card`;
6. aplica a transição com escrita condicional e só então responde 200.

Só um pagamento com cartão de crédito (`payment_type_id = credit_card`) liquida a cobrança. Um pagamento
aprovado com outro tipo (saldo em conta, por exemplo) não confere com a cobrança: vira anomalia `MISMATCH`, e a
cobrança fica como está — não passa a `PAID` nem a `FAIL`.

| Pagamento consultado                                                                                                                          | Efeito                                                                                                        | Resposta                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `approved`, vínculo ok                                                                                                                        | `PENDING` ou `FAIL` → `PAID`, auditado como `system:mercado-pago`                                             | 200                                                  |
| `rejected` ou `cancelled`, vínculo ok                                                                                                         | `PENDING` → `FAIL` (`PAYMENT_REJECTED`); um `PAID` não muda                                                   | 200                                                  |
| `pending`, `in_process`, `authorized`, `in_mediation`, status desconhecido, ou notificação repetida                                           | nada                                                                                                          | 200                                                  |
| outro pagamento aprovado para uma cobrança já `PAID`                                                                                          | nada; anomalia `DUPLICATE_APPROVAL` (possível cobrança em dobro)                                              | 200                                                  |
| `refunded` ou `charged_back` do pagamento que liquidou a cobrança                                                                             | continua `PAID`; anomalia `REVERSAL`                                                                          | 200                                                  |
| vínculo não confere (por exemplo, pago com saldo em conta)                                                                                    | status inalterado, **não** vira `FAIL`; anomalia `MISMATCH` com os campos divergentes                         | 200                                                  |
| `external_reference` que não é um pagamento desta base                                                                                        | anomalia `UNKNOWN_REFERENCE`                                                                                  | 200                                                  |
| Mercado Pago indisponível (inclusive 404), banco fora, conflito persistente, prazo de 10 s estourado, mais de 8 notificações em processamento | a transição não foi confirmada (após o prazo, ela ainda pode ser gravada; o reenvio então termina sem efeito) | 503 `notification-deferred` (o Mercado Pago reenvia) |

As anomalias ficam na tabela `provider_anomalies`, com uma linha por tipo, pagamento do Mercado Pago e status
observado: um reenvio não duplica nada, mas um pagamento que passa de `in_process` a `approved` ganha uma nova
linha. Elas também geram os logs `payment.provider_mismatch`, `payment.duplicate_approval`,
`payment.provider_reversal` e `webhook.unknown_reference`. Nada é estornado automaticamente.

Requisições malformadas ou com assinatura inválida contam contra o endereço de origem: depois de 20 em um
minuto, as próximas requisições inválidas dessa origem recebem 429 (o log registra só o acesso, sem repetir
o evento de segurança). A assinatura é verificada antes desse limite, então uma notificação com assinatura
válida nunca é recusada por causa da origem (o Mercado Pago pode concentrar entregas em poucos endereços); o
que limita o custo delas é o teto de processamentos simultâneos.

Erros seguem o RFC 9457 (`application/problem+json`) com um `requestId` (também no cabeçalho
`X-Request-Id`), sem stack trace e sem ecoar valores ou caminhos enviados. O nome de um campo desconhecido
só aparece se tiver a forma de um nome de campo; caso contrário, vira `(unrecognized field)`.

### Teste de ponta a ponta com contas de teste (29/09/2026)

Feito uma vez, com a configuração descrita acima: um pagamento de R$ 10,00, a API local atrás do proxy e um
Cloudflare Quick Tunnel aberto só durante o teste. Rótulos: **SANDBOX-OBSERVED** (visto neste teste),
**DOCUMENTED** (documentação do Mercado Pago), **SOURCE-INSPECTED** (código do SDK lido), **UNVERIFIED** (não
verificado).

- **SANDBOX-OBSERVED:** o comprador de teste pagou com o titular `APRO`; o Mercado Pago aprovou o pagamento e
  entregou uma notificação cerca de 2 s depois, com `x-signature`, `x-request-id`, `type=payment` e `data.id`
  numérico. A assinatura foi aceita, o pagamento foi relido no Mercado Pago e conferido (referência, valor,
  moeda, tipo e conta), e a cobrança passou de `PENDING` para `PAID` com auditoria `system:mercado-pago` e
  nenhuma anomalia. Pelo túnel, os outros caminhos testados receberam 404 e uma notificação sem assinatura
  recebeu 401.
- **SANDBOX-OBSERVED:** um pagamento aprovado enquanto o webhook estava cadastrado no modo teste de outra
  aplicação não foi notificado durante o teste e ficou `PENDING` — um exemplo da limitação "sem reconciliação"
  descrita abaixo.
- **DOCUMENTED** (página de Webhooks do Checkout Pro): o Mercado Pago espera a confirmação (200 ou 201) em
  até 22 s e, sem ela, faz "novas tentativas de envio a cada 15 minutos, até receber uma resposta".
  **SOURCE-INSPECTED:** o validador de assinatura do SDK usa o primeiro valor de um cabeçalho repetido e o
  último `ts`/`v1` dentro do `x-signature`, por isso a API recusa repetições antes de validar.
- **UNVERIFIED:** reenvio de uma notificação que falhou (e se o `ts` da assinatura é renovado nele); entrega
  duplicada; notificação de pagamento recusado e nova tentativa no mesmo checkout; estorno e chargeback. Como a
  API reage a esses casos é coberto pelos testes automatizados, com o Mercado Pago simulado.

## Testes

```bash
npm ci
npm test            # unitários: domínio, casos de uso (com fakes), configuração, autenticação, serialização de logs
npm run test:int    # integração com PostgreSQL real (Testcontainers; requer Docker)
npm run test:e2e    # HTTP de ponta a ponta sobre PostgreSQL real (Testcontainers; requer Docker)
npm run lint && npm run typecheck && npm run format:check && npm run build
npm audit --audit-level=high   # árvore completa de dependências, inclusive as de desenvolvimento
```

O workflow `.github/workflows/ci.yml` está configurado para rodar essas mesmas verificações, os testes com
PostgreSQL e uma varredura de segredos (gitleaks, versão fixada e checksum conferido) sobre todo o histórico,
com token só de leitura e ações fixadas por SHA.

Os testes de integração e e2e sobem um PostgreSQL descartável por suíte; nunca usam o `DATABASE_URL` do
desenvolvedor. Entre eles há corridas reais no PostgreSQL: uma edição de descrição contra uma liquidação, e
notificações concorrentes (aprovação, sua duplicata e uma recusa), que sempre terminam em `PAID` com uma
única transição para `PAID`. Nenhum teste automatizado chama o Mercado Pago: os testes dos adaptadores
simulam só a camada de rede (o SDK real roda), e os testes do webhook assinam as notificações no próprio
teste, com o HMAC documentado, e trocam a consulta ao Mercado Pago por um fake. O teste com o Mercado Pago
real é manual.

## Arquitetura (resumo)

| Camada           | Conteúdo                                                                                              | Depende de                    |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------- |
| `domain`         | `Payment` (regras de status), `Cpf`, `Money` (centavos inteiros), `Description`                       | nada                          |
| `application`    | casos de uso e portas (repositório, auditoria, checkout, leitura do pagamento no provedor, anomalias) | `domain`                      |
| `infrastructure` | Prisma/PostgreSQL, SDK do Mercado Pago, configuração, logging                                         | camadas internas + frameworks |
| `presentation`   | controllers (API e webhook), DTOs, guard de API key, filtro de erros                                  | camadas internas + NestJS     |
| `shared`         | prazo para chamadas assíncronas (`withDeadline`)                                                      | nada                          |

Regras de lint impedem `domain` e `application` de importar NestJS, Prisma (inclusive o cliente gerado),
Express ou o SDK do Mercado Pago; impedem o domínio de importar camadas externas; e impedem `presentation` de
importar `infrastructure` (a ligação entre elas fica só na composição: `app.module.ts`, `create-app.ts` e
`main.ts`).

## Segurança

- API key em `X-API-Key`: armazenada só como hash SHA-256 e comparada em tempo constante. A política é de
  **um único lojista**: toda chave válida acessa toda a coleção de pagamentos desse lojista (não há
  isolamento por cliente). Alterar status manualmente exige a permissão `settle` (403 sem ela), e cada
  mudança de status gera um evento de auditoria `payment.status_changed` com o id da chave que a fez.
- Validação de formato (DTO, campos desconhecidos rejeitados) e de significado (CPF com dígitos
  verificadores, valor com no máximo 2 casas e teto configurável). Corpo JSON limitado a 16 kB; chaves
  `__proto__`, `constructor` e `prototype` são recusadas já no parse.
- Dinheiro em centavos inteiros (`integer` no banco); nunca `valor * 100` em ponto flutuante.
- Restrições `CHECK` no banco duplicam as invariantes do domínio.
- Escritas condicionais por versão, só nas colunas alteradas: uma edição concorrente é relida e revalidada
  (uma vez) em vez de sobrescrever; se houver nova concorrência, a resposta é 409 `version-conflict`.
  Um teste de integração em PostgreSQL real prova que uma alteração de descrição concorrente não reverte
  uma liquidação.
- Logs JSON: requisições registram só método, caminho (com CPFs mascarados) e **nomes** de parâmetros de
  query; nunca cabeçalhos, corpos ou valores de query. Erros registram tipo, código e stack, sem mensagens
  de driver (que podem conter valores de linhas). Há testes para isso.
- Webhook: assinatura obrigatória, sem alternativa sem assinatura; entradas canonicalizadas antes da
  validação, para que o id validado seja o mesmo id consultado; o pagamento é sempre relido no Mercado Pago
  e vinculado por conta, moeda, valor e tipo antes de mudar qualquer status; prazo, teto de concorrência e
  limite de falhas por origem.
- `Cache-Control: no-store`, cabeçalhos do helmet, sem `x-powered-by`.
- Os serviços `api` e `migrate` do Compose rodam como usuário não-root (`node`), com sistema de arquivos
  somente leitura, sem capabilities e com `no-new-privileges`. O serviço `db` usa a imagem oficial do
  PostgreSQL sem essas restrições. As imagens são fixadas por digest, e a de runtime não inclui a CLI do
  Prisma nem o TypeScript.
- No Compose, as migrations rodam como dono do schema e a API conecta como `payments_app`, um papel sem
  superusuário que, nas tabelas da aplicação, só pode `SELECT`/`INSERT`/`UPDATE` em `payments` e `INSERT` em
  `provider_anomalies` (sem `DELETE`, sem DDL). O job de migração aplica `prisma/compose-app-role.sql` a cada
  `up`, de forma idempotente.
- A telemetria da CLI do Prisma fica desligada (`CHECKPOINT_DISABLE=1`) nas imagens Docker e nos testes; ao
  rodar comandos do Prisma no host, exporte a mesma variável se quiser o mesmo comportamento.

## Limitações conhecidas e riscos residuais

- CPF em texto puro no banco (sem criptografia em repouso).
- Limite de requisições por instância (em memória).
- Auditoria de mudança de status só nos logs estruturados, sem armazenamento durável nem à prova de
  adulteração. Se a confirmação de uma escrita do webhook se perder, o reenvio encontra o pagamento já
  atualizado e não repete o evento de auditoria.
- Sem `If-Match`: a checagem de versão protege contra escritas concorrentes, mas não detecta uma edição
  baseada em uma leitura antiga feita pelo cliente minutos antes.
- Cartão, sem expiração nem reconciliação locais: se o comprador abandonar o checkout, ou se uma notificação
  nunca chegar (ou se esgotarem os reenvios do Mercado Pago), o pagamento fica `PENDING`, mesmo depois de o
  `checkoutUrl` expirar. Se o processo cair no meio da criação do checkout, o pagamento pode ficar `PENDING` sem
  link e sem que o cliente tenha recebido o `paymentId`. O caminho de evolução é um processo agendado que
  consulta os pagamentos pendentes pelo `external_reference` e encerra os que expiraram.
- O saldo em conta Mercado Pago não pode ser excluído do checkout (documentação do Mercado Pago); os demais
  tipos que não são cartão são excluídos (a API aceitou esses ids ao criar uma preferência de teste). Um
  pagamento feito com saldo não liquida a cobrança, que fica como está (`PENDING`, `FAIL` se uma tentativa
  anterior foi recusada, ou `PAID` se outra já foi aprovada), e vira anomalia `MISMATCH`, sem estorno automático.
- Anomalias ficam só na tabela `provider_anomalies` e nos logs; não há endpoint nem painel para tratá-las.
- Eventos que o ciclo reduzido não representa: um estorno parcial mantém o status `approved` no Mercado Pago
  e não deixa rastro aqui; `in_mediation` em um pagamento `PAID` não gera anomalia; e um pagamento estornado
  antes de a aprovação ser processada fica `PENDING`, também sem anomalia.
- A assinatura do webhook não tem janela de validade do `ts`: a documentação não define a unidade dele nem se
  um reenvio o renova. Uma notificação capturada e repetida termina sem efeito, mas passa pela assinatura e
  por isso não conta no limite de falhas: repetida em volume, ela consome consultas ao Mercado Pago (com o
  mesmo token do checkout) e pode ocupar os 8 processamentos simultâneos, atrasando notificações legítimas
  até o reenvio do Mercado Pago.
- Os limites do webhook (prazo, concorrência, falhas por origem) valem por instância. Atrás de um proxy
  reverso, todas as requisições chegam com o endereço do proxy (a API não confia em `X-Forwarded-For`), então
  o limite de falhas passa a valer para o proxy inteiro. O mesmo vale para o limite geral de 120 requisições
  por minuto por IP; atrás de um proxy conhecido, isso exigiria habilitar o `trust proxy` do Express para ele
  (uma mudança de código).
- Rodando no host (`npm run start:dev`), a API usa o `DATABASE_URL` do `.env`, que no exemplo é o dono do
  schema; só o Compose separa os papéis (veja Segurança). As senhas dos dois papéis do Compose são locais, só
  para demonstração.
- `/health/live` e `/health/ready` são públicos e ficam fora do limite de requisições; `/health/ready`
  consulta o banco. Mantenha-os fora da exposição pública.
- Sem `POST` idempotente (`Idempotency-Key`): repetir um `POST` que deu timeout pode criar um segundo
  pagamento e um segundo checkout.
- Requisições com JSON inválido são respondidas antes da autenticação (400, não 401); o custo é limitado
  pelo teto de 16 kB.
- A CLI do Prisma 7.10.0 exige versões exatas (e vulneráveis) de `mysql2` (GHSA-3f6p-5ww8-9rcr,
  GHSA-rgwj-5xj2-c3m3) e de `deepmerge-ts` (GHSA-ggr8-5vv4-36mx). Nenhuma é explorável aqui: o `mysql2` nem é
  carregado (só o Prisma Studio o usa, para bancos MySQL), e o `deepmerge-ts` roda, mas só sobre o nosso
  `prisma.config.ts`. Mesmo assim, o `package.json` força versões corrigidas, só nesses pacotes (`overrides`:
  `mysql2` 3.24.4 sob `prisma`, na mesma versão maior, e `deepmerge-ts` 8.0.2 sob `@prisma/config`, cujas
  mudanças incompatíveis não afetam o uso que o Prisma faz dele), e `npm audit` sobre a árvore completa não
  aponta nada em 30/09/2026. Remova os `overrides` quando o Prisma publicar versões com as correções.
- A imagem do job de migração (Compose) leva todas as dependências de desenvolvimento, porque a CLI do Prisma é
  uma delas. Ela roda uma vez, sem porta exposta, mas é maior do que precisaria ser; a imagem da API não as
  leva.
