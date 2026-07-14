# stockpyrou-api

API Node (Hono + `pg`) do PyrouStock — Supabase **somente como Postgres**.

Repo: https://github.com/AdemarJr/stockpyrou-api

## Railway

1. New Project → Deploy from GitHub → **`AdemarJr/stockpyrou-api`**
2. Root Directory: deixe vazio (raiz do repo)
3. Variables:

```bash
DATABASE_URL=postgresql://postgres.fnkshezgoggtupqqcsoa:SUA_SENHA@aws-0-sa-east-1.pooler.supabase.com:6543/postgres
FRONTEND_URL=https://stockpyrou.com.br
```

4. Networking → Generate Domain  
5. Health: `GET /api/health`

## Local

```bash
cp .env.example .env   # preencha DATABASE_URL
npm install
npm run dev            # :3001
```
