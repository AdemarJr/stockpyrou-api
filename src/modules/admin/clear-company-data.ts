import { getPool } from '../../db/pool.js';

export type ClearDataOptions = {
  stockQuantities?: boolean;
  stockEntries?: boolean;
  movements?: boolean;
  priceHistory?: boolean;
  products?: boolean;
  suppliers?: boolean;
  sales?: boolean;
  customers?: boolean;
  costs?: boolean;
  inboundNfe?: boolean;
  zigCache?: boolean;
};

export type ClearDataResult = {
  success: true;
  message: string;
  deletions: Record<string, number>;
  warnings: string[];
};

function isMissingRelation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /relation .* does not exist|does not exist/i.test(msg);
}

/**
 * Limpa dados operacionais de uma empresa em transação.
 * Tabelas ausentes (migração não rodada) são ignoradas com aviso.
 */
export async function clearCompanyData(
  companyId: string,
  rawOptions: ClearDataOptions,
): Promise<ClearDataResult> {
  const options: Required<ClearDataOptions> = {
    stockQuantities: !!rawOptions.stockQuantities,
    stockEntries: !!rawOptions.stockEntries,
    movements: !!rawOptions.movements,
    priceHistory: !!rawOptions.priceHistory,
    products: !!rawOptions.products,
    suppliers: !!rawOptions.suppliers,
    sales: !!rawOptions.sales,
    customers: !!rawOptions.customers,
    costs: !!rawOptions.costs,
    inboundNfe: !!rawOptions.inboundNfe,
    zigCache: !!rawOptions.zigCache,
  };

  if (!Object.values(options).some(Boolean)) {
    throw new Error('Selecione pelo menos um tipo de dado para limpar');
  }

  // Dependências para evitar erro de FK
  if (options.products) {
    options.movements = true;
    options.stockEntries = true;
    options.priceHistory = true;
  }
  if (options.suppliers) {
    options.stockEntries = true;
  }
  if (options.customers) {
    // receivables referenciam customer; vendas também podem
    options.sales = true;
  }
  if (options.stockEntries) {
    // Entradas de compra geram financial_movements.stock_entry_id
    options.costs = true;
  }

  const deletions: Record<string, number> = {};
  const warnings: string[] = [];
  const pool = getPool();
  const client = await pool.connect();

  const run = async (label: string, sql: string, params: unknown[] = [companyId]) => {
    try {
      const r = await client.query(sql, params);
      deletions[label] = (deletions[label] || 0) + (r.rowCount ?? 0);
    } catch (err) {
      if (isMissingRelation(err)) {
        warnings.push(`${label}: tabela inexistente (migração pendente)`);
        return;
      }
      throw err;
    }
  };

  try {
    await client.query('BEGIN');

    // --- Fiscal docs / vendas / caixa / fiado ---
    if (options.sales) {
      await run('nfceEvents', `DELETE FROM nfce_event WHERE company_id = $1`);
      await run('nfcePayments', `DELETE FROM nfce_payment WHERE company_id = $1`);
      await run('nfceItems', `DELETE FROM nfce_item WHERE company_id = $1`);
      await run('nfce', `DELETE FROM nfce WHERE company_id = $1`);
      await run('fiscalLogs', `DELETE FROM fiscal_logs WHERE company_id = $1`);

      await run(
        'receivablePayments',
        `DELETE FROM accounts_receivable_payments WHERE company_id = $1`,
      );
      await run('receivables', `DELETE FROM accounts_receivable WHERE company_id = $1`);

      // sale_items pode não ter company_id em schemas antigos
      try {
        const r = await client.query(`DELETE FROM sale_items WHERE company_id = $1`, [companyId]);
        deletions.saleItems = r.rowCount ?? 0;
      } catch (err) {
        if (isMissingRelation(err)) {
          warnings.push('saleItems: tabela inexistente');
        } else if (/column .*company_id/i.test(err instanceof Error ? err.message : String(err))) {
          const r = await client.query(
            `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = $1)`,
            [companyId],
          );
          deletions.saleItems = r.rowCount ?? 0;
        } else {
          throw err;
        }
      }

      await run('sales', `DELETE FROM sales WHERE company_id = $1`);
      await run('cashMovements', `DELETE FROM cash_movements WHERE company_id = $1`);
      await run('cashRegisters', `DELETE FROM cash_registers WHERE company_id = $1`);

      // Ledger financeiro ligado a vendas (best-effort)
      await run(
        'financialMovementsSales',
        `DELETE FROM financial_movements
         WHERE company_id = $1
           AND (
             source ILIKE 'sale:%'
             OR source ILIKE 'sales:%'
             OR source ILIKE 'cashier:%'
             OR source ILIKE '%venda%'
           )`,
      );
    }

    if (options.inboundNfe) {
      await run('inboundNfe', `DELETE FROM nfe_inbound WHERE company_id = $1`);
    }

    if (options.customers && !options.sales) {
      // se sales já limpou receivables, ok; senão limpa o que sobrar
      await run(
        'receivablePayments',
        `DELETE FROM accounts_receivable_payments WHERE company_id = $1`,
      );
      await run('receivables', `DELETE FROM accounts_receivable WHERE company_id = $1`);
    }

    if (options.customers) {
      await run('customers', `DELETE FROM customers WHERE company_id = $1`);
    }

    // --- Custos / despesas ---
    // FK: financial_movements.operational_expense_id → operational_expenses
    // Apagar ledger (e pagamentos) ANTES das despesas.
    if (options.costs) {
      await run('financialMovements', `DELETE FROM financial_movements WHERE company_id = $1`);
      await run(
        'expensePayments',
        `DELETE FROM operational_expense_payments WHERE company_id = $1`,
      );
      await run('expenses', `DELETE FROM operational_expenses WHERE company_id = $1`);
      // Não apaga cost_centers / expense_types (cadastro estrutural)
    }

    // --- Estoque / cadastros ---
    if (options.priceHistory) {
      await run('priceHistory', `DELETE FROM price_history WHERE company_id = $1`);
    }
    if (options.movements) {
      await run('movements', `DELETE FROM stock_movements WHERE company_id = $1`);
    }
    if (options.stockEntries) {
      // FK: financial_movements.stock_entry_id → stock_entries (sem ON DELETE CASCADE)
      // Alinhado ao DELETE de recebimento em routes/stock.ts
      await run(
        'financialMovementsStockEntries',
        `DELETE FROM financial_movements
         WHERE company_id = $1 AND stock_entry_id IS NOT NULL`,
      );
      // Desvincula despesas ligadas à entrada (coluna nullable)
      try {
        await client.query(
          `UPDATE operational_expenses SET stock_entry_id = NULL
           WHERE company_id = $1 AND stock_entry_id IS NOT NULL`,
          [companyId],
        );
      } catch {
        /* ignore */
      }
      await run('stockEntries', `DELETE FROM stock_entries WHERE company_id = $1`);
    }

    if (options.suppliers) {
      try {
        await client.query(
          `UPDATE products SET supplier_id = NULL WHERE company_id = $1 AND supplier_id IS NOT NULL`,
          [companyId],
        );
      } catch {
        /* ignore */
      }
      await run('suppliers', `DELETE FROM suppliers WHERE company_id = $1`);
    }

    if (options.products) {
      // FK: sale_items.product_id → products (nullable, sem CASCADE)
      try {
        await client.query(
          `UPDATE sale_items SET product_id = NULL
           WHERE company_id = $1 AND product_id IS NOT NULL`,
          [companyId],
        );
      } catch (err) {
        if (!isMissingRelation(err)) {
          // schema antigo sem company_id em sale_items
          if (/column .*company_id/i.test(err instanceof Error ? err.message : String(err))) {
            await client.query(
              `UPDATE sale_items SET product_id = NULL
               WHERE product_id IS NOT NULL
                 AND sale_id IN (SELECT id FROM sales WHERE company_id = $1)`,
              [companyId],
            );
          } else {
            throw err;
          }
        }
      }
      // FK: cost_targets.product_id → products
      await run(
        'costTargets',
        `DELETE FROM cost_targets WHERE company_id = $1 AND product_id IS NOT NULL`,
      );
      // nfce_item.product_id é nullable e sem FK; limpa referência por higiene
      try {
        await client.query(
          `UPDATE nfce_item SET product_id = NULL
           WHERE company_id = $1 AND product_id IS NOT NULL`,
          [companyId],
        );
      } catch {
        /* ignore */
      }
      await run(
        'recipeIngredients',
        `DELETE FROM recipe_ingredients WHERE company_id = $1`,
      );
      await run('recipes', `DELETE FROM recipes WHERE company_id = $1`);
      await run('products', `DELETE FROM products WHERE company_id = $1`);
    } else if (options.stockQuantities) {
      await run(
        'stockQuantities',
        `UPDATE products SET current_stock = 0, updated_at = now() WHERE company_id = $1`,
      );
    }

    // --- Cache ZIG (KV) — NÃO apaga credenciais (zig_config) nem preferências ---
    if (options.zigCache) {
      try {
        const r = await client.query(
          `DELETE FROM kv_store_8a20b27d
           WHERE key LIKE $1 OR key LIKE $2 OR key LIKE $3 OR key LIKE $4`,
          [
            `zig_processed:${companyId}:%`,
            `zig_preview_session:${companyId}:%`,
            `zig_revenue_recorded:${companyId}:%`,
            `zig_last_sync:${companyId}`,
          ],
        );
        deletions.zigCache = r.rowCount ?? 0;
      } catch (err) {
        if (isMissingRelation(err)) {
          warnings.push('zigCache: kv_store inexistente');
        } else {
          throw err;
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }

  return {
    success: true,
    message: 'Selected data cleared successfully',
    deletions,
    warnings,
  };
}
