# API de Pagamentos — Teste Técnico Capco

API REST para o ciclo de vida de cobranças via **PIX** e **cartão de crédito** (Mercado Pago Checkout Pro),
em NestJS + PostgreSQL, com Clean Architecture.

> **Estado atual (em desenvolvimento):** criação e consulta de pagamentos PIX, autenticação por API key,
> validação de entrada e persistência estão prontas e testadas. Listagem, atualização (PUT), cartão via
> Mercado Pago e webhook estão em implementação — este README é atualizado a cada etapa.

## Como rodar

Pré-requisitos: Docker com Compose v2. Para rodar os testes ou a API fora do Docker: Node.js 24.

```bash
cp .env.example .env
docker compose up --build
```

- A API sobe em `http://localhost:3000` (publicada apenas em `127.0.0.1`).
- O Compose sobe o PostgreSQL, aplica as migrations em um job separado e só então inicia a API.
- O `.env.example` traz uma **chave de demonstração publicada** (`demo-key-local-pix-testing-only`), aceita
  somente com `DEMO_MODE=true`. Ela serve apenas para testes locais: não exponha uma instância em modo demo.
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
```

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
desenvolvedor.

## Arquitetura (resumo)

| Camada           | Conteúdo                                                                        | Depende de                    |
| ---------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| `domain`         | `Payment` (regras de status), `Cpf`, `Money` (centavos inteiros), `Description` | nada                          |
| `application`    | casos de uso e portas (`PaymentRepository`)                                     | `domain`                      |
| `infrastructure` | Prisma/PostgreSQL, configuração, logging                                        | camadas internas + frameworks |
| `presentation`   | controllers, DTOs, guard de API key, filtro de erros                            | camadas internas + NestJS     |

Regras de lint impedem `domain` e `application` de importar NestJS, Prisma (inclusive o cliente gerado),
Express ou o SDK do Mercado Pago; impedem o domínio de importar camadas externas; e impedem `presentation` de
importar `infrastructure` (a ligação entre elas fica só na composição: `app.module.ts`, `create-app.ts` e
`main.ts`).

## Segurança implementada até aqui

- API key em `X-API-Key`: armazenada só como hash SHA-256 e comparada em tempo constante. A política é de
  **um único lojista**: toda chave válida acessa toda a coleção de pagamentos desse lojista (não há
  isolamento por cliente). Alterar status manualmente exigirá a permissão `settle`.
- Validação de formato (DTO, campos desconhecidos rejeitados) e de significado (CPF com dígitos
  verificadores, valor com no máximo 2 casas e teto configurável). Corpo JSON limitado a 16 kB; chaves
  `__proto__`, `constructor` e `prototype` são recusadas já no parse.
- Dinheiro em centavos inteiros (`integer` no banco); nunca `valor * 100` em ponto flutuante.
- Restrições `CHECK` no banco duplicam as invariantes do domínio.
- Logs JSON: requisições registram só método, caminho (com CPFs mascarados) e **nomes** de parâmetros de
  query; nunca cabeçalhos, corpos ou valores de query. Erros registram tipo, código e stack, sem mensagens
  de driver (que podem conter valores de linhas). Há testes para isso.
- `Cache-Control: no-store`, cabeçalhos do helmet, sem `x-powered-by`.
- Contêineres não-root, sistema de arquivos somente leitura, sem capabilities; imagens fixadas por digest;
  a imagem de runtime não inclui a CLI do Prisma nem o TypeScript.
- A telemetria da CLI do Prisma fica desligada (`CHECKPOINT_DISABLE=1`) nas imagens Docker e nos testes; ao
  rodar comandos do Prisma no host, exporte a mesma variável se quiser o mesmo comportamento.

## Limitações conhecidas

Serão consolidadas ao final; até aqui:

- CPF em texto puro no banco (sem criptografia em repouso).
- Limite de requisições por instância (em memória).
- Requisições com JSON inválido são respondidas antes da autenticação (400, não 401); o custo é limitado
  pelo teto de 16 kB.
- `npm audit` aponta vulnerabilidades altas em dependências da **CLI** do Prisma (`mysql2`,
  `deepmerge-ts`), fixadas pelo próprio Prisma 7.10.0. A CLI só roda no job de migração, sobre a nossa
  configuração, e não entra na imagem de runtime.
