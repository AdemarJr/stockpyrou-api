import { Hono } from 'hono';
import { query } from '../db/pool.js';
import {
  getPermissionsByRole,
  mapAppUserRole,
} from '../auth/permissions.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth, requireCompany, requirePermission } from '../middleware/auth.js';

function onlyDigits(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

function detectDocumentType(digits: string): 'cpf' | 'cnpj' | null {
  if (digits.length === 11) return 'cpf';
  if (digits.length === 14) return 'cnpj';
  return null;
}

function formatDocument(digits: string, type: 'cpf' | 'cnpj'): string {
  if (type === 'cpf' && digits.length === 11) {
    return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  }
  if (type === 'cnpj' && digits.length === 14) {
    return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  }
  return digits;
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function mapCustomer(row: Record<string, unknown>) {
  const digits = String(row.document_digits || '');
  const documentType = (row.document_type === 'cnpj' ? 'cnpj' : 'cpf') as 'cpf' | 'cnpj';
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    documentDigits: digits,
    documentType,
    documentFormatted: formatDocument(digits, documentType),
    email: row.email != null ? String(row.email) : null,
    phone: row.phone != null ? String(row.phone) : null,
    notes: row.notes != null ? String(row.notes) : null,
    logradouro: row.logradouro != null ? String(row.logradouro) : null,
    numero: row.numero != null ? String(row.numero) : null,
    complemento: row.complemento != null ? String(row.complemento) : null,
    bairro: row.bairro != null ? String(row.bairro) : null,
    municipio: row.municipio != null ? String(row.municipio) : null,
    codigoMunicipio: row.codigo_municipio != null ? String(row.codigo_municipio) : null,
    uf: row.uf != null ? String(row.uf) : null,
    cep: row.cep != null ? String(row.cep) : null,
    isActive: row.is_active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateCustomerInput(body: Record<string, unknown>) {
  const name = String(body.name || '').trim();
  if (name.length < 2) {
    return { error: 'Nome do cliente é obrigatório (mín. 2 caracteres)' };
  }
  const digits = onlyDigits(String(body.document || body.documentDigits || body.cpfCnpj || ''));
  const documentType =
    body.documentType === 'cpf' || body.documentType === 'cnpj'
      ? body.documentType
      : detectDocumentType(digits);
  if (!documentType) {
    return { error: 'CPF (11 dígitos) ou CNPJ (14 dígitos) é obrigatório' };
  }
  if (documentType === 'cpf' && digits.length !== 11) {
    return { error: 'CPF inválido — informe 11 dígitos' };
  }
  if (documentType === 'cnpj' && digits.length !== 14) {
    return { error: 'CNPJ inválido — informe 14 dígitos' };
  }

  const ufRaw = strOrNull(body.uf);
  const uf = ufRaw ? ufRaw.toUpperCase().slice(0, 2) : null;
  const cepDigits = onlyDigits(String(body.cep || ''));
  const cep = cepDigits.length ? cepDigits.slice(0, 8) : null;

  return {
    name,
    documentDigits: digits,
    documentType,
    email: strOrNull(body.email),
    phone: strOrNull(body.phone),
    notes: strOrNull(body.notes),
    logradouro: strOrNull(body.logradouro),
    numero: strOrNull(body.numero),
    complemento: strOrNull(body.complemento),
    bairro: strOrNull(body.bairro),
    municipio: strOrNull(body.municipio),
    codigoMunicipio: strOrNull(body.codigoMunicipio ?? body.codigo_municipio),
    uf,
    cep,
  };
}

const customers = new Hono<{ Variables: AppVariables }>();
customers.use('*', requireAuth, requireCompany);
customers.use('*', async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    await next();
    return;
  }
  // PDV (operador) precisa criar cliente no fiado; edição/exclusão exige estoque
  if (method === 'POST') {
    const auth = c.get('auth');
    const role = mapAppUserRole(String(auth.role || ''));
    if (role === 'superadmin') {
      await next();
      return;
    }
    const perms = auth.permissions ?? getPermissionsByRole(role);
    if (perms.canManageStock || perms.canAccessCashier) {
      await next();
      return;
    }
    return c.json({ error: 'Sem permissão para esta operação' }, 403);
  }
  return requirePermission('canManageStock')(c, next);
});

customers.get('/', async (c) => {
  const companyId = c.get('companyId');
  const q = (c.req.query('q') || '').trim();
  const activeOnly = c.req.query('active') !== 'false';

  try {
    const params: unknown[] = [companyId];
    let sql = `SELECT * FROM customers WHERE company_id = $1`;
    if (activeOnly) sql += ` AND is_active = true`;
    if (q) {
      params.push(`%${q}%`);
      params.push(`${onlyDigits(q)}%`);
      sql += ` AND (name ILIKE $${params.length - 1} OR document_digits LIKE $${params.length} OR COALESCE(phone,'') ILIKE $${params.length - 1})`;
    }
    sql += ` ORDER BY name ASC LIMIT 200`;

    const { rows } = await query(sql, params);
    return c.json({
      success: true,
      customers: rows.map((r) => mapCustomer(r as Record<string, unknown>)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/relation .* does not exist/i.test(message)) {
      return c.json({
        success: true,
        customers: [],
        needsMigration: true,
        error: 'Execute scripts/add_customers.sql no banco',
      });
    }
    console.error('[customers GET]', err);
    return c.json({ error: message }, 500);
  }
});

customers.get('/:id', async (c) => {
  const companyId = c.get('companyId');
  const { rows } = await query(
    `SELECT * FROM customers WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [c.req.param('id'), companyId],
  );
  if (!rows[0]) return c.json({ error: 'Cliente não encontrado' }, 404);
  return c.json({ success: true, customer: mapCustomer(rows[0] as Record<string, unknown>) });
});

customers.post('/', async (c) => {
  const companyId = c.get('companyId');
  const body = await c.req.json().catch(() => ({}));
  const parsed = validateCustomerInput(body as Record<string, unknown>);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);

  const addressCols = [
    parsed.logradouro,
    parsed.numero,
    parsed.complemento,
    parsed.bairro,
    parsed.municipio,
    parsed.codigoMunicipio,
    parsed.uf,
    parsed.cep,
  ];

  try {
    const { rows: existing } = await query(
      `SELECT * FROM customers WHERE company_id = $1 AND document_digits = $2 LIMIT 1`,
      [companyId, parsed.documentDigits],
    );
    if (existing[0]) {
      try {
        const { rows } = await query(
          `UPDATE customers SET
             name = $1, email = COALESCE($2, email), phone = COALESCE($3, phone),
             notes = COALESCE($4, notes),
             logradouro = COALESCE($5, logradouro),
             numero = COALESCE($6, numero),
             complemento = COALESCE($7, complemento),
             bairro = COALESCE($8, bairro),
             municipio = COALESCE($9, municipio),
             codigo_municipio = COALESCE($10, codigo_municipio),
             uf = COALESCE($11, uf),
             cep = COALESCE($12, cep),
             is_active = true, updated_at = now()
           WHERE id = $13 AND company_id = $14
           RETURNING *`,
          [
            parsed.name,
            parsed.email,
            parsed.phone,
            parsed.notes,
            ...addressCols,
            existing[0].id,
            companyId,
          ],
        );
        return c.json({
          success: true,
          customer: mapCustomer(rows[0] as Record<string, unknown>),
          reused: true,
        });
      } catch (err) {
        // Colunas de endereço ainda não migradas
        const msg = err instanceof Error ? err.message : String(err);
        if (!/logradouro|column/i.test(msg)) throw err;
        const { rows } = await query(
          `UPDATE customers SET
             name = $1, email = COALESCE($2, email), phone = COALESCE($3, phone),
             notes = COALESCE($4, notes), is_active = true, updated_at = now()
           WHERE id = $5 AND company_id = $6
           RETURNING *`,
          [
            parsed.name,
            parsed.email,
            parsed.phone,
            parsed.notes,
            existing[0].id,
            companyId,
          ],
        );
        return c.json({
          success: true,
          customer: mapCustomer(rows[0] as Record<string, unknown>),
          reused: true,
        });
      }
    }

    try {
      const { rows } = await query(
        `INSERT INTO customers (
           company_id, name, document_digits, document_type, email, phone, notes,
           logradouro, numero, complemento, bairro, municipio, codigo_municipio, uf, cep
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [
          companyId,
          parsed.name,
          parsed.documentDigits,
          parsed.documentType,
          parsed.email,
          parsed.phone,
          parsed.notes,
          ...addressCols,
        ],
      );
      return c.json(
        { success: true, customer: mapCustomer(rows[0] as Record<string, unknown>) },
        201,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/logradouro|column/i.test(msg)) throw err;
      const { rows } = await query(
        `INSERT INTO customers (
           company_id, name, document_digits, document_type, email, phone, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          companyId,
          parsed.name,
          parsed.documentDigits,
          parsed.documentType,
          parsed.email,
          parsed.phone,
          parsed.notes,
        ],
      );
      return c.json(
        { success: true, customer: mapCustomer(rows[0] as Record<string, unknown>) },
        201,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/relation .* does not exist/i.test(message)) {
      return c.json({ error: 'Execute scripts/add_customers.sql no banco' }, 503);
    }
    if (/unique|duplicate/i.test(message)) {
      return c.json({ error: 'Já existe cliente com este CPF/CNPJ' }, 409);
    }
    console.error('[customers POST]', err);
    return c.json({ error: message }, 500);
  }
});

customers.put('/:id', async (c) => {
  const companyId = c.get('companyId');
  const body = await c.req.json().catch(() => ({}));
  const parsed = validateCustomerInput(body as Record<string, unknown>);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);

  try {
    try {
      const { rows } = await query(
        `UPDATE customers SET
           name = $1,
           document_digits = $2,
           document_type = $3,
           email = $4,
           phone = $5,
           notes = $6,
           logradouro = $7,
           numero = $8,
           complemento = $9,
           bairro = $10,
           municipio = $11,
           codigo_municipio = $12,
           uf = $13,
           cep = $14,
           is_active = COALESCE($15, is_active),
           updated_at = now()
         WHERE id = $16 AND company_id = $17
         RETURNING *`,
        [
          parsed.name,
          parsed.documentDigits,
          parsed.documentType,
          parsed.email,
          parsed.phone,
          parsed.notes,
          parsed.logradouro,
          parsed.numero,
          parsed.complemento,
          parsed.bairro,
          parsed.municipio,
          parsed.codigoMunicipio,
          parsed.uf,
          parsed.cep,
          body.isActive != null ? !!body.isActive : null,
          c.req.param('id'),
          companyId,
        ],
      );
      if (!rows[0]) return c.json({ error: 'Cliente não encontrado' }, 404);
      return c.json({ success: true, customer: mapCustomer(rows[0] as Record<string, unknown>) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/logradouro|column/i.test(msg)) throw err;
      const { rows } = await query(
        `UPDATE customers SET
           name = $1,
           document_digits = $2,
           document_type = $3,
           email = $4,
           phone = $5,
           notes = $6,
           is_active = COALESCE($7, is_active),
           updated_at = now()
         WHERE id = $8 AND company_id = $9
         RETURNING *`,
        [
          parsed.name,
          parsed.documentDigits,
          parsed.documentType,
          parsed.email,
          parsed.phone,
          parsed.notes,
          body.isActive != null ? !!body.isActive : null,
          c.req.param('id'),
          companyId,
        ],
      );
      if (!rows[0]) return c.json({ error: 'Cliente não encontrado' }, 404);
      return c.json({ success: true, customer: mapCustomer(rows[0] as Record<string, unknown>) });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/unique|duplicate/i.test(message)) {
      return c.json({ error: 'Já existe cliente com este CPF/CNPJ' }, 409);
    }
    return c.json({ error: message }, 500);
  }
});

customers.delete('/:id', async (c) => {
  const companyId = c.get('companyId');
  // Soft delete — preserva histórico de vendas
  const { rows } = await query(
    `UPDATE customers SET is_active = false, updated_at = now()
     WHERE id = $1 AND company_id = $2 RETURNING id`,
    [c.req.param('id'), companyId],
  );
  if (!rows[0]) return c.json({ error: 'Cliente não encontrado' }, 404);
  return c.json({ success: true });
});

export default customers;
