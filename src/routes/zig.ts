import type { Context } from 'hono';
import { Hono } from 'hono';
import { query } from '../db/pool.js';
import type { AppVariables } from '../middleware/auth.js';
import {
  buildZigSaidaComparisonReport,
  confirmStockFromZigPreviewSnapshot,
  fetchPendingSales,
  getAutoBaixaConfig,
  getConfig,
  getStores,
  resolveZigTokenForStores,
  runAutoBaixaZigOntem,
  saveAutoBaixaConfig,
  saveConfig,
  saveZigTokenOnly,
  type ZigConfirmLineItem,
} from '../services/zig-service.js';

const zig = new Hono<{ Variables: AppVariables }>();

function storesErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Zig Stores Error:', error);

  if (message.startsWith('ZIG_TOKEN_INVALID:')) {
    const cleanMessage = message.replace('ZIG_TOKEN_INVALID:', '');
    return {
      body: {
        stores: [],
        available: false,
        warning: cleanMessage,
        needsConfiguration: true,
      },
      status: 200 as const,
    };
  }

  let statusCode = 500;
  if (message.includes('Token ZIG inválido') || message.includes('InvalidToken')) {
    statusCode = 400;
  } else if (message.includes('ID da Rede')) {
    statusCode = 400;
  } else if (message.includes('sem permissão')) {
    statusCode = 403;
  }

  return {
    body: {
      error: message,
      details: String(error),
      statusCode,
      available: false,
    },
    status: statusCode as 400 | 403 | 500,
  };
}

zig.get('/stores', async (c) => {
  try {
    const redeId = c.req.query('rede') || '35c5259d-4d3a-4934-9dd2-78a057a3aa8f';
    const companyId = c.req.query('companyId') || undefined;
    const headerToken = c.req.header('X-ZIG-TOKEN') || undefined;
    const token = await resolveZigTokenForStores(companyId, headerToken);
    const stores = await getStores(token, redeId);
    return c.json({ stores });
  } catch (error) {
    const { body, status } = storesErrorResponse(error);
    return c.json(body, status);
  }
});

zig.post('/config', async (c) => {
  try {
    const { companyId, storeId, redeId, zigToken } = await c.req.json();
    if (!companyId) return c.json({ error: 'Missing companyId' }, 400);

    const tok = typeof zigToken === 'string' ? zigToken.trim() : '';
    const sid = typeof storeId === 'string' ? storeId.trim() : '';

    // Token sozinho (antes de escolher loja) ou loja (+ token opcional)
    if (!sid && !tok) {
      return c.json({ error: 'Informe o token ZIG e/ou a loja' }, 400);
    }

    const saved = sid
      ? await saveConfig(companyId, sid, redeId, tok || undefined)
      : await saveZigTokenOnly(companyId, tok, redeId);

    return c.json({ success: true, config: saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro ao salvar configuração ZIG';
    console.error('Zig Config Error:', error);
    return c.json({ error: message }, 500);
  }
});

zig.get('/config/:companyId', async (c) => {
  try {
    const companyId = c.req.param('companyId');
    if (!companyId) return c.json({ error: 'Missing companyId' }, 400);
    const config = await getConfig(companyId);
    return c.json({ config });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro ao ler configuração ZIG';
    console.error('Zig Get Config Error:', error);
    return c.json({ error: message }, 500);
  }
});

zig.post('/preview', async (c) => {
  try {
    const { companyId, startDate, endDate, includeProcessed } = await c.req.json();
    if (!companyId) return c.json({ error: 'Missing companyId' }, 400);

    const result = await fetchPendingSales(companyId, startDate, endDate, {
      includeProcessed: !!includeProcessed,
    });
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro no preview ZIG';
    console.error('Zig Preview Error:', error);
    return c.json({ error: message }, 500);
  }
});

async function handleZigConfirm(c: Context<{ Variables: AppVariables }>) {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const { companyId, transactionIds, registeredOnly, lineItems, previewSessionId } = body;
    if (!companyId || !Array.isArray(transactionIds) || transactionIds.length === 0) {
      return c.json(
        {
          error:
            'Selecione pelo menos um produto na lista «Vendas ZIG — baixa no estoque» (transactionIds vazio).',
        },
        400,
      );
    }

    const sid =
      typeof previewSessionId === 'string' && previewSessionId.trim().length > 0
        ? previewSessionId.trim()
        : undefined;

    const lineItemsArr = Array.isArray(lineItems) ? lineItems : [];

    if (lineItemsArr.length === 0 && !sid) {
      return c.json(
        {
          error:
            'Use «Buscar vendas pendentes» antes de confirmar. É necessário lineItems ou previewSessionId no corpo.',
        },
        400,
      );
    }

    const result = await confirmStockFromZigPreviewSnapshot(
      companyId as string,
      transactionIds as string[],
      lineItemsArr.length > 0 ? (lineItemsArr as ZigConfirmLineItem[]) : undefined,
      sid,
      !!registeredOnly,
    );
    c.header('X-Zig-Confirm-Handler', 'snapshot-only');
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro no processamento';
    console.error('Zig Confirm Error:', error);
    return c.json({ error: message }, 500);
  }
}

zig.post('/confirm', handleZigConfirm);
zig.post('/confirm-preview', handleZigConfirm);

zig.get('/meta', (c) =>
  c.json({
    zigConfirmPostHandler: 'confirmStockFromZigPreviewSnapshot',
    callsZigApiOnConfirm: false,
  }),
);

zig.get('/auto-baixa/:companyId', async (c) => {
  try {
    const companyId = c.req.param('companyId');
    if (!companyId) return c.json({ error: 'Missing companyId' }, 400);
    const cfg = await getAutoBaixaConfig(companyId);
    return c.json(cfg);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro ao ler auto-baixa ZIG';
    console.error('Zig auto-baixa get Error:', error);
    return c.json({ error: message }, 500);
  }
});

zig.post('/auto-baixa', async (c) => {
  try {
    const { companyId, enabled } = await c.req.json();
    if (!companyId || typeof enabled !== 'boolean') {
      return c.json({ error: 'Missing companyId or enabled (boolean)' }, 400);
    }
    await saveAutoBaixaConfig(companyId, enabled);
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro ao salvar auto-baixa ZIG';
    console.error('Zig auto-baixa save Error:', error);
    return c.json({ error: message }, 500);
  }
});

zig.post('/auto-run', async (c) => {
  try {
    const { companyId } = await c.req.json();
    if (!companyId) return c.json({ error: 'Missing companyId' }, 400);
    const result = await runAutoBaixaZigOntem(companyId);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro ao executar auto-baixa ZIG';
    console.error('Zig auto-run Error:', error);
    return c.json({ error: message }, 500);
  }
});

/** Comparativo: vendas direto da API ZIG (`saida-produtos`) vs saídas locais da integração ZIG. */
zig.get('/saida-comparison', async (c) => {
  try {
    const companyId = c.req.query('companyId') || c.req.header('X-Company-Id');
    const startDate = c.req.query('startDate');
    const endDate = c.req.query('endDate');
    if (!companyId) return c.json({ error: 'Missing companyId' }, 400);
    if (!startDate || !endDate) {
      return c.json(
        { error: 'Informe startDate e endDate (YYYY-MM-DD) no período do relatório.' },
        400,
      );
    }
    const result = await buildZigSaidaComparisonReport(companyId, startDate, endDate);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro ao montar comparativo ZIG';
    console.error('Zig saida-comparison Error:', error);
    return c.json({ error: message }, 500);
  }
});

zig.post('/cron-auto-yesterday', async (c) => {
  try {
    const secret = process.env.ZIG_AUTO_CRON_SECRET;
    const bearer = c.req.header('Authorization')?.replace('Bearer ', '') || '';
    const xh = c.req.header('X-ZIG-CRON-SECRET') || '';
    if (!secret || (bearer !== secret && xh !== secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { rows: companies } = await query<{ id: string }>('SELECT id FROM companies');
    const results: Record<string, unknown>[] = [];
    for (const co of companies) {
      try {
        const r = await runAutoBaixaZigOntem(co.id);
        results.push({ companyId: co.id, ...r });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        results.push({ companyId: co.id, error: message });
      }
    }

    return c.json({ ok: true, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro no cron ZIG';
    console.error('Zig cron-auto-yesterday Error:', error);
    return c.json({ error: message }, 500);
  }
});

export default zig;
