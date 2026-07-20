# stockpyrou-api

API Node (Hono + `pg`) do PyrouStock — Supabase **somente como Postgres**.

Repo: https://github.com/AdemarJr/stockpyrou-api

## Railway

1. New Project → Deploy from GitHub → **`AdemarJr/stockpyrou-api`**
2. Root Directory: deixe vazio (raiz do repo)
3. Variables (EasyPanel Postgres — database `stock-pyrou`):

```bash
DATABASE_URL=postgresql://pyrouwebdb:SENHA_ENCODED@easypanel.pyrou.com.br:5432/stock-pyrou?sslmode=disable
FRONTEND_URL=https://stockpyrou.com.br
```

Senha com `!` `@` `*` → URL-encode (`%21` `%40` `%2A`).

4. Networking → Generate Domain  
5. Health: `GET /api/health`

## Local

```bash
cp .env.example .env   # preencha DATABASE_URL
npm install
npm run dev            # :3001
```
