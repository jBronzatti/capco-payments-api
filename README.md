# API de Pagamentos — Teste Técnico Capco

API REST para o ciclo de vida de cobranças via **PIX** e **cartão de crédito** (Mercado Pago Checkout Pro),
em NestJS + PostgreSQL, com Clean Architecture.

> **Estado atual (em desenvolvimento):** os quatro endpoints e o webhook do Mercado Pago funcionam e têm
> testes automatizados (com o Mercado Pago simulado). O teste manual com o sandbox real do Mercado Pago, de
> ponta a ponta, ainda não foi feito — este README é atualizado a cada etapa.

## Como rodar

Pré-requisitos: Docker com Compose v2. Para rodar os testes ou a API fora do Docker: Node.js 24.

```bash
cp .env.example .env
docker compose up --build
```

- A API sobe em `http://localhost:3000` (publicada apenas em `127.0.0.1`).
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

Falhas parciais têm resultado definido; a resposta traz o `paymentId` para o cliente consultar o estado:

| Situação                                                                    | Resposta                           | Estado gravado                            |
| --------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| Cartão não configurado                                                      | 503 `card-payments-unavailable`    | nada é gravado                            |
| Mercado Pago recusou (4xx, exceto 408, 409, 423, 424 e 429)                 | 502 `checkout-failed`              | `FAIL` (`failureReason: CHECKOUT_FAILED`) |
| Preferência criada em outra conta que não a configurada (`MP_COLLECTOR_ID`) | 502 `checkout-failed`              | `FAIL` (`CHECKOUT_FAILED`)                |
| Timeout (inclusive corpo da resposta travado)                               | 504 `checkout-outcome-unknown`     | `FAIL` (`CHECKOUT_OUTCOME_UNKNOWN`)       |
| Conexão, 5xx, 408/409/423/424/429 ou resposta 2xx inutilizável              | 502 `checkout-outcome-unknown`     | `FAIL` (`CHECKOUT_OUTCOME_UNKNOWN`)       |
| Preferência criada, mas o registro dela falhou                              | 503 `checkout-state-not-persisted` | `PENDING` sem link                        |

Um timeout **não** prova que nada foi criado no Mercado Pago; por isso o motivo registrado é "resultado
desconhecido". A chamada ao Mercado Pago é feita uma única vez (as tentativas automáticas do SDK ficam
desligadas, porque a API de preferências não documenta idempotência) e o tratamento de erro nunca sobrescreve
um pagamento que já saiu de `PENDING`. Se outra escrita acontecer durante a chamada (uma edição de descrição,
por exemplo), o pagamento é relido e a regra reaplicada, em vez de a resposta perder o link. Se nem o registro
de `FAIL` puder ser gravado, o pagamento continua `PENDING`, e o log de erro indica `stateRecorded: false`.

Para testar com o Mercado Pago (conta de teste, sem dinheiro real):

1. Em <https://www.mercadopago.com.br/developers>, crie uma aplicação **Checkout Pro** com a **API de
   Preferences** e, nela, as contas de teste de vendedor e de comprador.
2. Coloque só o Access Token **de teste** da aplicação em `.env.mp` (`MP_ACCESS_TOKEN=...`; o arquivo é
   ignorado pelo git) e rode `npm run mp:probe`: ele cria uma preferência de teste e mostra o `collector id`
   (seu id de usuário no Mercado Pago) e o link de checkout. Nenhum segredo é impresso.
3. Para ligar o cartão na API, preencha no `.env` as três variáveis: `MP_ACCESS_TOKEN`, `MP_COLLECTOR_ID` (o
   id mostrado no passo 2) e `MP_WEBHOOK_SECRET` (a assinatura secreta que o painel mostra em _Webhooks →
   Configurar notificações_). Troque também a chave de demonstração por uma chave gerada
   (`npm run key:generate -- <id> --settle`): com cartão configurado, a chave publicada é recusada.
4. Para receber notificações, cadastre em _Webhooks → Configurar notificações_ a URL **de teste**
   `https://<seu-endereço-público>/api/webhooks/mercado-pago` com o evento **Pagamentos**. O Mercado Pago
   precisa alcançar a API pela internet; exponha só essa rota (não a API inteira) e só durante o teste.

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
`X-Request-Id`), sem stack trace e sem ecoar valores ou caminhos enviados.

## Testes

```bash
npm ci
npm test            # unitários: domínio, casos de uso (com fakes), configuração, autenticação, serialização de logs
npm run test:int    # integração com PostgreSQL real (Testcontainers; requer Docker)
npm run test:e2e    # HTTP de ponta a ponta sobre PostgreSQL real (Testcontainers; requer Docker)
npm run lint && npm run typecheck && npm run format:check && npm run build
```

Os testes de integração e e2e sobem um PostgreSQL descartável por suíte; nunca usam o `DATABASE_URL` do
desenvolvedor. Nenhum teste automatizado chama o Mercado Pago: os testes dos adaptadores simulam só a camada
de rede (o SDK real roda), e os testes do webhook assinam as notificações no próprio teste, com o HMAC
documentado, e trocam a consulta ao Mercado Pago por um fake. O teste com o sandbox real é manual.

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

## Segurança implementada até aqui

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
- Contêineres não-root, sistema de arquivos somente leitura, sem capabilities; imagens fixadas por digest;
  a imagem de runtime não inclui a CLI do Prisma nem o TypeScript.
- A telemetria da CLI do Prisma fica desligada (`CHECKPOINT_DISABLE=1`) nas imagens Docker e nos testes; ao
  rodar comandos do Prisma no host, exporte a mesma variável se quiser o mesmo comportamento.

## Limitações conhecidas

Serão consolidadas ao final; até aqui:

- CPF em texto puro no banco (sem criptografia em repouso).
- Limite de requisições por instância (em memória).
- Auditoria de mudança de status só nos logs estruturados, sem armazenamento durável nem à prova de
  adulteração. Se a confirmação de uma escrita do webhook se perder, o reenvio encontra o pagamento já
  atualizado e não repete o evento de auditoria.
- Sem `If-Match`: a checagem de versão protege contra escritas concorrentes, mas não detecta uma edição
  baseada em uma leitura antiga feita pelo cliente minutos antes.
- Cartão, sem reconciliação: se uma notificação nunca chegar (ou se esgotarem os reenvios do Mercado Pago),
  o pagamento fica `PENDING`. O caminho de evolução é um processo agendado que consulta os pagamentos
  pendentes pelo `external_reference`.
- O saldo em conta Mercado Pago não pode ser excluído do checkout (documentação do Mercado Pago); os demais
  tipos que não são cartão são excluídos (a API aceitou esses ids ao criar uma preferência de teste). Um
  pagamento feito com saldo fica `PENDING` e registrado como anomalia `MISMATCH`, sem estorno automático.
- Anomalias ficam só na tabela `provider_anomalies` e nos logs; não há endpoint nem painel para tratá-las.
- Eventos que o ciclo reduzido não representa: um estorno parcial mantém o status `approved` no Mercado Pago
  e não deixa rastro aqui; `in_mediation` em um pagamento `PAID` não gera anomalia; e um pagamento estornado
  antes de a aprovação ser processada fica `PENDING`, também sem anomalia.
- A assinatura do webhook não tem janela de validade do `ts`: a documentação não define a unidade dele nem se
  um reenvio o renova. Uma notificação capturada e repetida custa uma consulta ao Mercado Pago e termina sem
  efeito.
- Os limites do webhook (prazo, concorrência, falhas por origem) valem por instância. Atrás de um proxy
  reverso, todas as requisições chegam com o endereço do proxy (a API não confia em `X-Forwarded-For`), então
  o limite de falhas passa a valer para o proxy inteiro.
- Sem `POST` idempotente (`Idempotency-Key`): repetir um `POST` que deu timeout pode criar um segundo
  pagamento e um segundo checkout.
- Requisições com JSON inválido são respondidas antes da autenticação (400, não 401); o custo é limitado
  pelo teto de 16 kB.
- `npm audit` aponta vulnerabilidades altas em dependências da **CLI** do Prisma (`mysql2`,
  `deepmerge-ts`), fixadas pelo próprio Prisma 7.10.0. A CLI só roda no job de migração, sobre a nossa
  configuração, e não entra na imagem de runtime.
