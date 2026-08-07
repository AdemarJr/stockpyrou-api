import { randomUUID } from 'node:crypto';
import { kvDel, kvGet, kvSet } from '../db/kv.js';
import { query } from '../db/pool.js';

type ProductRow = Record<string, unknown> & {
  id: string;
  name?: string;
  barcode?: string | null;
  sku?: string | null;
  current_stock?: number | string;
  unit?: string;
  description?: unknown;
};

type RecipeRow = Record<string, unknown> & {
  product_id?: string;
  recipe_ingredients?: Array<Record<string, unknown>>;
};

async function loadProducts(companyId: string): Promise<ProductRow[]> {
  const { rows } = await query<ProductRow>(
    'SELECT * FROM products WHERE company_id = $1',
    [companyId],
  );
  return rows;
}

async function loadRecipesWithIngredients(companyId: string): Promise<RecipeRow[]> {
  try {
    const { rows: recipes } = await query<RecipeRow>(
      'SELECT * FROM recipes WHERE company_id = $1',
      [companyId],
    );
    if (recipes.length === 0) return [];
    const { rows: ingredients } = await query<Record<string, unknown>>(
      'SELECT * FROM recipe_ingredients WHERE recipe_id = ANY($1::uuid[])',
      [recipes.map((r) => r.id)],
    );
    return recipes.map((r) => ({
      ...r,
      recipe_ingredients: ingredients.filter((i) => i.recipe_id === r.id),
    }));
  } catch {
    console.log('Recipes table might not exist, ignoring recipes.');
    return [];
  }
}

async function insertProduct(companyId: string, productSku: string, productName: string): Promise<ProductRow> {
  const { rows } = await query<ProductRow>(
    `INSERT INTO products (
      company_id, name, category, unit, min_stock, current_stock, cost_price, sale_price,
      supplier_id, barcode, description, image_url, status, safety_stock
    ) VALUES ($1,$2,'outro','un',0,0,0,0,null,$3,null,null,'active',0)
    RETURNING *`,
    [companyId, productName || productSku, productSku],
  );
  if (!rows[0]) throw new Error('Erro ao criar produto no sistema.');
  return rows[0];
}

async function findCashRegisterById(companyId: string, registerId: string) {
  const { rows } = await query<{ id: string }>(
    'SELECT id FROM cash_registers WHERE company_id = $1 AND id = $2 LIMIT 1',
    [companyId, registerId],
  );
  return rows[0] ?? null;
}

async function insertZigVirtualRegister(companyId: string): Promise<string> {
  const now = new Date().toISOString();
  const { rows } = await query<{ id: string }>(
    `INSERT INTO cash_registers (
      company_id, cashier_id, cashier_name, initial_balance, current_balance,
      status, closed_at, created_at, updated_at
    ) VALUES ($1,'zig','Integração ZIG',0,0,'closed',$2,$2,$2)
    RETURNING id`,
    [companyId, now],
  );
  if (!rows[0]?.id) throw new Error('Falha ao criar caixa virtual para ZIG.');
  return rows[0].id;
}

async function findProductsBySkus(companyId: string, skus: string[]) {
  const { rows: byBarcode } = await query<{ id: string; barcode: string | null; sku: string | null }>(
    'SELECT id, barcode, sku FROM products WHERE company_id = $1 AND barcode = ANY($2::text[])',
    [companyId, skus],
  );
  const { rows: bySkuCol } = await query<{ id: string; barcode: string | null; sku: string | null }>(
    'SELECT id, barcode, sku FROM products WHERE company_id = $1 AND sku = ANY($2::text[])',
    [companyId, skus],
  );
  return [...byBarcode, ...bySkuCol];
}

async function insertSale(payload: Record<string, unknown>): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO sales (
      company_id, register_id, cashier_id, cashier_name, total, payment_method,
      payment_details, items, timestamp, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)
    RETURNING id`,
    [
      payload.company_id,
      payload.register_id,
      payload.cashier_id,
      payload.cashier_name,
      payload.total,
      payload.payment_method,
      JSON.stringify(payload.payment_details),
      JSON.stringify(payload.items),
      payload.timestamp,
      payload.created_at,
    ],
  );
  if (!rows[0]?.id) throw new Error('Falha ao registrar receita (sales) para ZIG.');
  return rows[0].id;
}

const ZIG_API_URL = "https://api.zigcore.com.br/integration";

type ZigKvConfig = {
  storeId?: string;
  redeId?: string;
  zigToken?: string;
};

/** Token ZIG: 1) KV por empresa (`zigToken`), 2) variável de ambiente `ZIG_API_KEY` (dev/legado). */
export async function getZigTokenForCompany(companyId: string): Promise<string> {
  const cfg = (await kvGet(`zig_config:${companyId}`)) as ZigKvConfig | null;
  const fromKv = cfg?.zigToken?.trim();
  if (fromKv) return fromKv;
  const env = process.env.ZIG_API_KEY?.trim();
  if (env) return env;
  throw new Error(
    "Token ZIG não configurado. Informe e salve o token em Integrações > ZIG (ou defina ZIG_API_KEY no servidor).",
  );
}

/**
 * Lista lojas na ZIG:
 * - Com `companyId` na query: **só** o token salvo no KV dessa empresa (ignora header — evita misturar token de outra empresa).
 * - Sem `companyId`: use `X-ZIG-TOKEN` (ex.: testar token antes de salvar na configuração).
 */
export async function resolveZigTokenForStores(
  companyId: string | undefined,
  headerToken: string | undefined,
): Promise<string> {
  const cid = companyId?.trim();
  if (cid) {
    return await getZigTokenForCompany(cid);
  }
  const h = headerToken?.trim();
  if (h) return h;
  throw new Error(
    "Informe o token ZIG no campo acima (teste antes de salvar) ou salve a configuração da loja para usar o token desta empresa.",
  );
}

function maskToken(t: string): string {
  if (t.length <= 8) return "****";
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

// Types
interface ZigSale {
  transactionId: string;
  transactionDate: string;
  /** Data do evento/noite na ZIG (YYYY-MM-DD). Operação costuma cruzar meia-noite. */
  eventDate?: string | null;
  eventId?: string | null;
  productId: string;
  productSku: string;
  unitValue: number;
  /** Desconto da linha (em centavos ou BRL dependendo do ambiente). */
  discountValue?: number | null;
  /** Quantidade em unidades inteiras (API ZIG). */
  count: number;
  /** Quantidade fracionada (peso/volume), quando aplicável — documentação ZIG. */
  fractionalAmount?: number | null;
  productName: string;
  type: string;
  additions?: {
    productSku: string;
    count: number;
    fractionalAmount?: number | null;
    unitValue?: number | null;
    discountValue?: number | null;
  }[];
}

/** Quantidade para baixa: inteiros + parte fracionada quando a ZIG envia. */
function zigEffectiveCount(sale: Pick<ZigSale, "count" | "fractionalAmount">): number {
  const c = Number(sale.count) || 0;
  const raw = sale.fractionalAmount;
  const f = raw != null && raw !== "" ? Number(raw) : NaN;
  if (Number.isFinite(f) && f > 0) {
    return c + f;
  }
  return c;
}

function zigEffectiveAdditionCount(add: {
  count?: number;
  fractionalAmount?: number | null;
}): number {
  return zigEffectiveCount({
    count: Number(add.count) || 0,
    fractionalAmount: add.fractionalAmount,
  });
}

function zigLineTotalValueBrl(sale: Pick<ZigSale, "unitValue" | "discountValue" | "count" | "fractionalAmount">): number {
  const qty = zigEffectiveCount(sale);
  const gross = zigMoneyToBrl(sale.unitValue) * qty;
  const discRaw = sale.discountValue;
  const disc = discRaw == null ? 0 : zigMoneyToBrl(discRaw);
  const net = gross - disc;
  return net > 0 ? net : 0;
}

function zigAdditionTotalValueBrl(add: {
  unitValue?: number | null;
  discountValue?: number | null;
  count?: number;
  fractionalAmount?: number | null;
}): number {
  const qty = zigEffectiveAdditionCount(add);
  const gross = zigMoneyToBrl(add.unitValue ?? 0) * qty;
  const disc = zigMoneyToBrl(add.discountValue ?? 0);
  const net = gross - disc;
  return net > 0 ? net : 0;
}

/** Extrai YYYY-MM-DD de campos ZIG (`eventDate` ou ISO). */
function normalizeZigYmdField(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

/**
 * Data civil (YYYY-MM-DD) da transação no fuso America/Sao_Paulo.
 * Sem offset na string (ex.: docs ZIG `2024-08-23T12:00:00`), usa o dia do próprio texto
 * — a ZIG envia horário local BR; interpretar como UTC no Railway deslocava a madrugada.
 */
function transactionYmdSaoPaulo(iso: string | undefined): string | null {
  if (!iso || !String(iso).trim()) return null;
  const s = String(iso).trim();
  const dateOnly = normalizeZigYmdField(s);
  if (dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(s)) return dateOnly;
  // Offset-less datetime → dia civil como enviado pela ZIG (horário local da operação)
  if (
    dateOnly &&
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) &&
    !/[zZ]|[+-]\d{2}:?\d{2}\s*$/.test(s)
  ) {
    return dateOnly;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return dateOnly;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SAO_PAULO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function zigSaleEventYmd(sale: Pick<ZigSale, "eventDate">): string | null {
  return normalizeZigYmdField(sale.eventDate ?? null);
}

function zigSaleTransactionYmd(sale: Pick<ZigSale, "transactionDate">): string | null {
  return transactionYmdSaoPaulo(sale.transactionDate);
}

/**
 * Dia operacional da linha: preferir `eventDate` (noite/evento ZIG);
 * senão data civil da transação.
 */
function zigSalePrimaryYmd(
  sale: Pick<ZigSale, "eventDate" | "transactionDate">,
): string {
  return (
    zigSaleEventYmd(sale) ||
    zigSaleTransactionYmd(sale) ||
    normalizeZigYmdField(sale.transactionDate) ||
    ""
  );
}

/** Linha pertence ao dia civil `ymd` se evento ou transação cair nesse dia. */
function zigSaleBelongsToYmd(
  sale: Pick<ZigSale, "eventDate" | "transactionDate">,
  ymd: string,
): boolean {
  const eventYmd = zigSaleEventYmd(sale);
  const txYmd = zigSaleTransactionYmd(sale);
  if (eventYmd === ymd || txYmd === ymd) return true;
  // Sem datas parseáveis: não descartar (volume)
  if (!eventYmd && !txYmd) return true;
  return false;
}

/** Inclui a linha se evento ou transação estiver no intervalo inclusivo. */
function zigSaleBelongsToRange(
  sale: Pick<ZigSale, "eventDate" | "transactionDate">,
  startYmd: string,
  endYmd: string,
): boolean {
  const eventYmd = zigSaleEventYmd(sale);
  const txYmd = zigSaleTransactionYmd(sale);
  const inRange = (ymd: string | null) => !!ymd && ymd >= startYmd && ymd <= endYmd;
  if (inRange(eventYmd) || inRange(txYmd)) return true;
  if (!eventYmd && !txYmd) return true;
  return false;
}

/**
 * Uma mesma `transactionId` na ZIG pode ter várias linhas (produtos diferentes no mesmo pedido).
 * Usamos este id em preview, confirmação e KV `zig_processed` — um registro por linha, não por transação.
 */
function zigLineItemId(
  sale: Pick<ZigSale, "transactionId" | "productSku" | "productId">,
): string {
  const sku = sale.productSku ?? "";
  const pid = sale.productId ?? "";
  return `${sale.transactionId}|${sku}|${pid}`;
}

/** SKU/código para match e baixa — a ZIG pode enviar linha só com `productId`. */
function zigSaleMatchKey(
  sale: Pick<ZigSale, "productSku" | "productId">,
): string {
  const s = sale.productSku?.trim();
  if (s) return s;
  const p = sale.productId?.trim();
  if (p) return p;
  return "";
}

interface ZigStore {
  id: string;
  name: string;
}

// Helpers
const getHeaders = (token: string) => {
  // A API da Zig espera o token DIRETO, SEM "Bearer "
  return {
    "Authorization": token,
    "Content-Type": "application/json",
    "Accept": "application/json"
  };
};

/**
 * A API ZIG limita o intervalo por chamada. Buscamos **um dia civil por requisição**.
 * Preferimos primeiro `dtinicio = dtfim` (documentação); se falhar, tentamos `dtfim` = dia seguinte (intervalo semiaberto) e filtramos pela data civil.
 */
const MS_PER_UTC_DAY = 86_400_000;

function parseDateOnly(iso: string): Date {
  const part = iso.trim().split("T")[0];
  const [y, m, d] = part.split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !d) return new Date(iso);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDateOnly(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

/** Hoje (calendário) em America/Sao_Paulo como YYYY-MM-DD. */
export function getTodayYmdSaoPaulo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDaysToYmd(ymd: string, deltaDays: number): string {
  const [y, mo, d] = ymd.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return formatDateOnly(dt);
}

/** Ontem (calendário) em America/Sao_Paulo como YYYY-MM-DD. */
export function getYesterdayYmdSaoPaulo(): string {
  return addDaysToYmd(getTodayYmdSaoPaulo(), -1);
}

const SAO_PAULO_TZ = "America/Sao_Paulo";

const ymdFormatterSaoPaulo = new Intl.DateTimeFormat("en-CA", {
  timeZone: SAO_PAULO_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Instante UTC cuja data civil em São Paulo é `ymd` (YYYY-MM-DD). */
function utcInstantForLocalYmdSaoPaulo(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !d) return new Date(NaN);
  for (let hh = 0; hh < 24; hh++) {
    const t = new Date(Date.UTC(y, m - 1, d, hh, 0, 0));
    if (ymdFormatterSaoPaulo.format(t) === ymd) return t;
  }
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

/**
 * Cada dia civil entre startYmd e endYmd **no calendário de São Paulo** (inclusive).
 * A ZIG valida o intervalo provavelmente nesse fuso — evita 500 por “>5 dias” com datas UTC erradas.
 */
function eachYmdInRangeSaoPaulo(startYmd: string, endYmd: string): string[] {
  if (startYmd > endYmd) return [];
  const out: string[] = [];
  let cur = utcInstantForLocalYmdSaoPaulo(startYmd);
  if (Number.isNaN(cur.getTime())) return [];
  for (let guard = 0; guard < 400; guard++) {
    const ymd = ymdFormatterSaoPaulo.format(cur);
    out.push(ymd);
    if (ymd === endYmd) break;
    cur = new Date(cur.getTime() + MS_PER_UTC_DAY);
  }
  return out;
}

/**
 * Documentação oficial (PDF): GET /erp/saida-produtos com dtinicio, dtfim em **YYYY-MM-DD** e loja.
 * Não há `rede` neste endpoint. Buscamos um dia civil por vez; ver `fetchOneSaidaChunkForDay` para o fallback de intervalo.
 */
/** Texto útil para regex (corpo cru ou campo `message` em JSON de erro ZIG). */
function zigSaidaErrorPlainText(body: string): string {
  const t = body.trim();
  try {
    const j = JSON.parse(t) as { message?: unknown };
    if (typeof j?.message === "string" && j.message.length > 0) return j.message;
  } catch {
    /* ignore */
  }
  return t;
}

function isZigRangeLimitError(status: number, body: string): boolean {
  if (status !== 500 && status !== 400) return false;
  const text = zigSaidaErrorPlainText(body);
  return /5\s*dias|mais do que\s*5|requisitar\s+mais|limite.*dia|intervalo.*dia/i.test(text);
}

type ZigSaidaPageMeta = {
  total?: number;
  hasNext?: boolean;
  page?: number;
  pageSize?: number;
};

/**
 * A ZIG pode devolver array cru ou objeto com lista em `data` / `items` / etc.
 * Antes: não-array virava `[]` e **todas** as vendas sumiam.
 */
function parseZigSaidaProdutosBody(txt: string): {
  rows: ZigSale[];
  meta?: ZigSaidaPageMeta;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch {
    return { rows: [] };
  }
  if (Array.isArray(parsed)) {
    return { rows: parsed as ZigSale[] };
  }
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    const arrayKeys = [
      "data",
      "items",
      "result",
      "saidaProdutos",
      "saida",
      "rows",
      "values",
      "produtos",
      "content",
    ];
    for (const k of arrayKeys) {
      const v = o[k];
      if (Array.isArray(v)) {
        const total = pickNumericMeta(o, [
          "total",
          "totalCount",
          "totalElements",
          "count",
          "totalRecords",
        ]);
        const page = pickNumericMeta(o, ["page", "currentPage", "pagina", "number"]);
        const pageSize = pickNumericMeta(o, [
          "pageSize",
          "limit",
          "perPage",
          "size",
          "take",
        ]);
        const hasNext =
          typeof o.hasNext === "boolean"
            ? o.hasNext
            : typeof o.has_more === "boolean"
              ? o.has_more
              : undefined;
        const meta: ZigSaidaPageMeta = {};
        if (total !== undefined) meta.total = total;
        if (page !== undefined) meta.page = page;
        if (pageSize !== undefined) meta.pageSize = pageSize;
        if (hasNext !== undefined) meta.hasNext = hasNext;
        return {
          rows: v as ZigSale[],
          meta: Object.keys(meta).length ? meta : undefined,
        };
      }
    }
  }
  return { rows: [] };
}

function pickNumericMeta(
  o: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  }
  return undefined;
}

/** Ordem estável para detectar página duplicada (API ignora `page`). */
function zigSaidaChunkFingerprint(chunk: ZigSale[]): string {
  return chunk
    .filter((s) => s?.transactionId)
    .map((s) => zigLineItemId(s))
    .sort()
    .join("\u0001");
}

type SaidaFetchResult =
  | { ok: true; data: ZigSale[]; meta?: ZigSaidaPageMeta }
  | { ok: false; status: number; body: string };

async function fetchSaidaProdutosOnce(
  token: string,
  storeId: string,
  dtinicio: string,
  dtfim: string,
  page?: number,
): Promise<SaidaFetchResult> {
  const params = new URLSearchParams();
  params.set("dtinicio", dtinicio);
  params.set("dtfim", dtfim);
  params.set("loja", storeId);
  if (page != null && page >= 2) {
    params.set("page", String(page));
  }
  const url = `${ZIG_API_URL}/erp/saida-produtos?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      ...getHeaders(token),
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const txt = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body: txt };
  }
  try {
    const { rows, meta } = parseZigSaidaProdutosBody(txt);
    return { ok: true, data: rows, meta };
  } catch {
    return { ok: false, status: res.status, body: txt || "JSON inválido" };
  }
}

/**
 * Várias páginas quando a ZIG limita linhas por GET (comum em alto volume).
 * A 1ª requisição **não** envia `page` (compatível com o comportamento antigo).
 * Para se a próxima página repetir o mesmo conjunto (API ignora `page`).
 */
async function fetchSaidaProdutosAllPagesForWindow(
  token: string,
  storeId: string,
  dtinicio: string,
  dtfim: string,
): Promise<SaidaFetchResult> {
  const merged = new Map<string, ZigSale>();
  let lastFp: string | null = null;
  let noGrowthStreak = 0;
  const maxPages = 80;

  for (let page = 1; page <= maxPages; page++) {
    const pageArg = page === 1 ? undefined : page;
    const r = await fetchSaidaProdutosOnce(token, storeId, dtinicio, dtfim, pageArg);
    if (!r.ok) {
      if (page === 1) return r;
      console.warn(
        `ZIG: saída-produtos página ${page} falhou (${r.status}); usando ${merged.size} linha(s) já obtidas.`,
      );
      break;
    }

    const chunk = r.data;
    if (chunk.length === 0) {
      if (page === 1) return { ok: true, data: [] };
      break;
    }

    const fp = zigSaidaChunkFingerprint(chunk);
    if (lastFp !== null && fp === lastFp) {
      console.log(
        `ZIG: saída-produtos página ${page} idêntica à anterior — fim da paginação (ou API ignora page).`,
      );
      break;
    }
    lastFp = fp;

    const sizeBefore = merged.size;
    mergeZigSalesLines(merged, chunk);
    const grew = merged.size > sizeBefore;

    const m = r.meta;
    if (m?.hasNext === false) break;
    if (m?.total != null && merged.size >= m.total) break;

    // Quando a ZIG não envia meta de paginação, a única forma segura de “trazer tudo”
    // é continuar pedindo páginas enquanto aparecerem linhas novas (crescimento do merged).
    // Isso também é seguro quando a API ignora `page`: a fingerprint repete e o loop para.
    if (grew) {
      noGrowthStreak = 0;
      await new Promise((x) => setTimeout(x, ZIG_INTER_CALL_DELAY_MS));
      continue;
    }

    // Sem crescimento: pode ser fim, ou pode ser “página repetida” com ordem diferente.
    // Damos mais 1 tentativa para confirmar o fim.
    noGrowthStreak += 1;
    if (noGrowthStreak >= 2) break;
    await new Promise((x) => setTimeout(x, ZIG_INTER_CALL_DELAY_MS));
    continue;
  }

  return { ok: true, data: Array.from(merged.values()) };
}

/**
 * Mantém linhas do dia civil `ymd`: `eventDate` **ou** data da transação.
 * Noites ZIG (qua → qui) usam eventDate no dia de abertura; filtrar só por
 * transactionDate descartava a madrugada.
 * Se nenhuma linha casar mas a API devolveu dados, devolve o bruto (legado).
 */
function filterSalesToLocalYmd(sales: ZigSale[], ymd: string): ZigSale[] {
  const filtered = sales.filter((s) => zigSaleBelongsToYmd(s, ymd));
  if (filtered.length === 0 && sales.length > 0) {
    console.warn(
      `ZIG: filterSalesToLocalYmd — nenhuma linha com event/transação SP=${ymd} (${sales.length} no payload); usando resposta bruta.`,
    );
    return sales;
  }
  return filtered;
}

/**
 * Mensagem para o operador: o erro vem da API ZIG (intervalo dtinicio/dtfim), não do PostgreSQL nem do volume de vendas.
 */
function zigSaidaRangeLimitHelp(lastStatus: number, lastBody: string): string {
  const detail = lastBody.length > 800 ? `${lastBody.slice(0, 800)}…` : lastBody;
  return (
    `A ZIG devolveu erro de «limite de dias por chamada» (${lastStatus}). ` +
      `Isso refere-se ao **intervalo de datas numa única requisição HTTP** na API deles — não ao seu banco de dados, nem ao fato de ser «só hoje» ou «poucos produtos». ` +
      `O Stockpyrou já consulta **um dia civil por vez**. ` +
      `Se continuar assim, é bug ou regra estranha no servidor ZIG: encaminhe esta resposta ao suporte deles. Detalhe: ${detail}`
  );
}

/**
 * Um dia civil por vez (`ymd` em YYYY-MM-DD, calendário São Paulo).
 *
 * Ordem: primeiro **dtinicio = dtfim** (exemplo da documentação ZIG). Depois, **[dtinicio, dtfim)** com `dtfim` = dia seguinte (comum em APIs BR).
 * A primeira estratégia antiga (semiaberto primeiro) fazia a ZIG devolver 500 «>5 dias» em alguns ambientes mesmo para um único dia civil.
 */
async function fetchOneSaidaChunkForDay(
  token: string,
  storeId: string,
  ymd: string,
): Promise<ZigSale[]> {
  const ymdNext = addDaysToYmd(ymd, 1);
  const strategies: [string, string, string][] = [
    [ymd, ymd, "dtinicio = dtfim (um dia)"],
    [ymd, ymdNext, "dtfim exclusivo (dia civil)"],
  ];

  let lastFail: SaidaFetchResult | null = null;

  for (const [di, df, label] of strategies) {
    console.log(`ZIG: saída-produtos loja=${storeId} ${di}…${df} (${label})`);
    const r = await fetchSaidaProdutosAllPagesForWindow(token, storeId, di, df);
    if (r.ok) {
      return filterSalesToLocalYmd(r.data, ymd);
    }
    lastFail = r;

    if (isZigRangeLimitError(r.status, r.body)) {
      console.warn(`ZIG: estratégia «${label}» recusada com limite de intervalo; tentando próxima se houver`);
      continue;
    }

    throw new Error(`Falha ao buscar vendas ZIG (${r.status}): ${r.body}`);
  }

  if (lastFail && isZigRangeLimitError(lastFail.status, lastFail.body)) {
    throw new Error(zigSaidaRangeLimitHelp(lastFail.status, lastFail.body));
  }

  throw new Error(
    `Falha ao buscar vendas ZIG (${lastFail?.status ?? "?"}): ${lastFail?.body ?? "sem resposta"}`,
  );
}

/**
 * Mescla linhas da ZIG por item de venda (transação + SKU + productId).
 * Se a API repetir a mesma linha, soma `count` (paginação no mesmo dia).
 */
function mergeZigSalesLines(merged: Map<string, ZigSale>, chunk: ZigSale[]) {
  for (const sale of chunk) {
    if (!sale?.transactionId) continue;
    const key = zigLineItemId(sale);
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...sale });
      continue;
    }
    const total = zigEffectiveCount(prev) + zigEffectiveCount(sale);
    prev.count = total;
    prev.fractionalAmount = null;
  }
}

/**
 * União entre dias adjacentes: mesma linha (noite qua→qui) não deve somar quantidade.
 */
function unionZigSalesLines(merged: Map<string, ZigSale>, chunk: ZigSale[]) {
  for (const sale of chunk) {
    if (!sale?.transactionId) continue;
    const key = zigLineItemId(sale);
    if (!merged.has(key)) {
      merged.set(key, { ...sale });
    }
  }
}

/** Pausa entre chamadas ao gateway ZIG. */
const ZIG_INTER_CALL_DELAY_MS = 150;

/**
 * Várias chamadas GET, **uma por dia civil (SP)**; cada dia tenta primeiro dtinicio = dtfim (YYYY-MM-DD), com fallback documentado em `fetchOneSaidaChunkForDay`.
 * Após mesclar, mantém linhas cujo **evento ou transação** cai no intervalo (noites qua→qui).
 */
async function fetchZigSaidaProdutosRange(
  token: string,
  storeId: string,
  startIso: string,
  endIso: string,
): Promise<ZigSale[]> {
  const start = parseDateOnly(startIso);
  const end = parseDateOnly(endIso);
  if (start.getTime() > end.getTime()) {
    return [];
  }
  const startYmd = formatDateOnly(start);
  const endYmd = formatDateOnly(end);
  const days = eachYmdInRangeSaoPaulo(startYmd, endYmd);
  const merged = new Map<string, ZigSale>();

  console.log(
    `ZIG: saída-produtos ${startYmd} → ${endYmd} (${days.length} dia(s) ${SAO_PAULO_TZ}; 1 GET/dia, YYYY-MM-DD), loja=${storeId}`,
  );

  for (let i = 0; i < days.length; i++) {
    const ymd = days[i];
    if (i > 0) {
      await new Promise((r) => setTimeout(r, ZIG_INTER_CALL_DELAY_MS));
    }
    const chunk = await fetchOneSaidaChunkForDay(token, storeId, ymd);
    unionZigSalesLines(merged, chunk);
  }

  const all = Array.from(merged.values());
  const inRange = all.filter((s) => zigSaleBelongsToRange(s, startYmd, endYmd));
  if (inRange.length < all.length) {
    console.log(
      `ZIG: intervalo ${startYmd}→${endYmd}: ${all.length} linha(s) mescladas, ${inRange.length} no período (eventDate|transactionDate).`,
    );
  }
  return inRange;
}

const MAX_ZIG_SAIDA_REPORT_DAYS = 93;

/**
 * Normaliza valores monetários vindos do ZIG.
 *
 * Alguns ambientes da ZIG retornam preços em "centavos" (ex.: 1400.00 = R$ 14,00).
 * Heurística segura para o varejo/restaurante:
 * - se o valor é inteiro e >= 1000, tratamos como centavos e dividimos por 100
 * - caso contrário, assumimos que já está em BRL.
 */
function zigMoneyToBrl(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  const isInt = Math.abs(n - Math.round(n)) < 1e-9;
  if (isInt && n >= 1000) return n / 100;
  return n;
}

function movementYmdSaoPauloFromIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return ymdFormatterSaoPaulo.format(d);
}

function accumulateZigSaleForReport(
  sale: ZigSale,
  startYmd: string,
  endYmd: string,
  global: { lineCount: number; totalQty: number; totalValue: number },
  byDay: Record<string, { lines: number; qty: number; value: number }>,
) {
  const ymd = (() => {
    const eventYmd = zigSaleEventYmd(sale);
    const txYmd = zigSaleTransactionYmd(sale);
    if (eventYmd && eventYmd >= startYmd && eventYmd <= endYmd) return eventYmd;
    if (txYmd && txYmd >= startYmd && txYmd <= endYmd) return txYmd;
    return zigSalePrimaryYmd(sale);
  })();
  if (!ymd || !zigSaleBelongsToRange(sale, startYmd, endYmd)) return;

  const bump = (lines: number, qty: number, value: number) => {
    global.lineCount += lines;
    global.totalQty += qty;
    global.totalValue += value;
    if (!byDay[ymd]) byDay[ymd] = { lines: 0, qty: 0, value: 0 };
    byDay[ymd].lines += lines;
    byDay[ymd].qty += qty;
    byDay[ymd].value += value;
  };

  const mainQty = zigEffectiveCount(sale);
  const mainVal = zigLineTotalValueBrl(sale);
  bump(1, mainQty, mainVal);

  if (sale.additions?.length) {
    for (const add of sale.additions) {
      if (!add?.productSku?.trim()) continue;
      const aq = zigEffectiveAdditionCount(add);
      const av = zigAdditionTotalValueBrl(add);
      bump(1, aq, av);
    }
  }
}

/**
 * Relatório comparativo: vendas em **quantidade/valor** direto da API ZIG (`saida-produtos`)
 * vs movimentações locais geradas pela integração (notas com «Integração automática ZIG»).
 * Não filtra «pendentes» — espelha o extrato ZIG do período.
 */
export async function buildZigSaidaComparisonReport(
  companyId: string,
  startYmd: string,
  endYmd: string,
): Promise<{
  dateRange: { start: string; end: string };
  zig: {
    lineCount: number;
    totalQty: number;
    totalValue: number;
    byDay: Record<string, { lines: number; qty: number; value: number }>;
  };
  local: {
    movementCount: number;
    totalQty: number;
    totalCost: number;
    byDay: Record<string, { movements: number; qty: number; cost: number }>;
  };
  note: string;
}> {
  if (!startYmd?.trim() || !endYmd?.trim() || startYmd > endYmd) {
    throw new Error("Intervalo de datas inválido.");
  }
  const spanDays = eachYmdInRangeSaoPaulo(startYmd, endYmd).length;
  if (spanDays > MAX_ZIG_SAIDA_REPORT_DAYS) {
    throw new Error(
      `Período máximo: ${MAX_ZIG_SAIDA_REPORT_DAYS} dias (inclusivos). Reduza o intervalo no filtro do relatório.`,
    );
  }

  const token = await getZigTokenForCompany(companyId);
  const config = (await kvGet(`zig_config:${companyId}`)) as ZigKvConfig | null;
  if (!config?.storeId) {
    throw new Error(
      "Integração ZIG não configurada. Informe token e loja em Integrações → ZIG.",
    );
  }

  const sales = await fetchZigSaidaProdutosRange(
    token,
    config.storeId,
    startYmd,
    endYmd,
  );

  const zigGlobal = { lineCount: 0, totalQty: 0, totalValue: 0 };
  const zigByDay: Record<string, { lines: number; qty: number; value: number }> = {};
  for (const s of sales) {
    accumulateZigSaleForReport(s, startYmd, endYmd, zigGlobal, zigByDay);
  }

  const startIso = `${startYmd}T00:00:00.000-03:00`;
  const endIso = `${endYmd}T23:59:59.999-03:00`;

  const { rows: movRows } = await query<{
    quantity: unknown;
    movement_date: string;
    notes: string | null;
    total_value: unknown;
    unit_cost: unknown;
  }>(
    `SELECT quantity, movement_date, notes, total_value, unit_cost
     FROM stock_movements
     WHERE company_id = $1
       AND notes ILIKE '%Integração automática ZIG%'
       AND movement_date >= $2
       AND movement_date <= $3`,
    [companyId, startIso, endIso],
  );

  const localGlobal = { movementCount: 0, totalQty: 0, totalCost: 0 };
  const localByDay: Record<string, { movements: number; qty: number; cost: number }> =
    {};

  for (const row of movRows || []) {
    const qty = Number(row.quantity) || 0;
    const tvRaw = row.total_value;
    const tv =
      tvRaw != null && tvRaw !== "" ? Number(tvRaw) : NaN;
    const uc = Number(row.unit_cost) || 0;
    const cost = Number.isFinite(tv) && tv > 0 ? tv : qty * uc;

    localGlobal.movementCount += 1;
    localGlobal.totalQty += qty;
    localGlobal.totalCost += cost;

    const ymd = movementYmdSaoPauloFromIso(row.movement_date as string);
    if (!ymd) continue;
    if (!localByDay[ymd]) {
      localByDay[ymd] = { movements: 0, qty: 0, cost: 0 };
    }
    localByDay[ymd].movements += 1;
    localByDay[ymd].qty += qty;
    localByDay[ymd].cost += cost;
  }

  return {
    dateRange: { start: startYmd, end: endYmd },
    zig: {
      lineCount: zigGlobal.lineCount,
      totalQty: zigGlobal.totalQty,
      totalValue: zigGlobal.totalValue,
      byDay: zigByDay,
    },
    local: {
      movementCount: localGlobal.movementCount,
      totalQty: localGlobal.totalQty,
      totalCost: localGlobal.totalCost,
      byDay: localByDay,
    },
    note:
      "Fonte ZIG: GET /erp/saida-produtos (mesmo endpoint da documentação). " +
      "Local: apenas movimentações com «Integração automática ZIG» (baixa automática ou confirmação no PDV). " +
      "Receitas e combos podem gerar várias linhas locais por uma linha na ZIG — compare o dia e o valor de venda ZIG com o custo registrado.",
  };
}

export const getStores = async (token: string, redeId?: string): Promise<ZigStore[]> => {
  // Log para debug (mascarando o token)
  console.log(`ZIG: Usando token: ${maskToken(token)}`);
  
  const FALLBACK_REDE_ID = "35c5259d-4d3a-4934-9dd2-78a057a3aa8f";
  
  // Limpeza do parâmetro redeId
  const cleanRedeId = (redeId === 'undefined' || redeId === 'null' || !redeId || redeId.trim() === '') ? FALLBACK_REDE_ID : redeId.trim();

  // VALIDAÇÃO CRÍTICA: Se não houver redeId, a API da ZIG para este token retorna 500 "cannot be null"
  // Interceptamos aqui para dar um erro amigável 400 em vez de um 500 de erro de sistema
  if (!cleanRedeId) {
    throw new Error("O 'ID da Rede' é obrigatório para listar as lojas com este token de integração. Por favor, preencha o campo ID da Rede.");
  }

  let url = `${ZIG_API_URL}/erp/lojas?rede=${cleanRedeId}`;
  
  console.log(`ZIG: Buscando lojas para Rede: ${cleanRedeId}`);
  
  try {
    const response = await fetch(url, { 
      method: 'GET',
      headers: getHeaders(token)
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { message: errorText };
      }

      console.error(`ZIG API Error (${response.status}):`, errorData);
      
      // Tratamento específico para erro 400 - Token inválido
      // Em vez de lançar erro, retorna uma mensagem que será tratada pelo frontend
      if (response.status === 400 && (errorData.type === 'InvalidToken' || errorData.message?.toLowerCase().includes('token'))) {
        console.warn("⚠️ Token ZIG inválido - Integração ZIG não disponível");
        throw new Error("ZIG_TOKEN_INVALID:Token ZIG inválido ou ausente. Salve o token em Integrações > ZIG ou defina ZIG_API_KEY no servidor.");
      }
      
      if (response.status === 500 && (errorData.message?.includes('lojas.args.rede') || errorText.includes('rede'))) {
        throw new Error("O 'ID da Rede' informado é inválido ou obrigatório para este token.");
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error("Token de integração ZIG inválido ou sem permissão para esta rede.");
      }

      throw new Error(`Erro ZIG (${response.status}): ${errorData.message || response.statusText}`);
    }
    
    const data = await response.json();
    const stores = Array.isArray(data) ? data : (data.lojas || []);
    
    return stores.map((s: any) => ({
      id: s.id || s.loja_id || s.id_loja,
      name: s.name || s.nome || s.nome_fantasia || `Loja ${s.id}`
    }));
  } catch (error: any) {
    console.error("ZIG: Erro ao buscar lojas:", error);
    throw error;
  }
};

export const saveConfig = async (
  companyId: string,
  storeId?: string,
  redeId?: string,
  zigToken?: string,
) => {
  const prev = ((await kvGet(`zig_config:${companyId}`)) as ZigKvConfig | null) || {};
  const next: ZigKvConfig = { ...prev };
  if (storeId != null && String(storeId).trim()) {
    next.storeId = String(storeId).trim();
  }
  if (redeId != null) {
    next.redeId = String(redeId).trim();
  }
  const t = zigToken?.trim();
  if (t) {
    next.zigToken = t;
  }
  if (!next.storeId && !next.zigToken) {
    throw new Error("Informe o token ZIG e/ou a loja para salvar.");
  }
  await kvSet(`zig_config:${companyId}`, next);
  return {
    storeId: next.storeId,
    redeId: next.redeId,
    hasZigToken: !!next.zigToken?.trim(),
    zigTokenMasked: next.zigToken?.trim() ? maskToken(next.zigToken.trim()) : undefined,
  };
};

/** Persiste só o token (e opcionalmente rede), sem exigir loja. */
export const saveZigTokenOnly = async (
  companyId: string,
  zigToken: string,
  redeId?: string,
) => {
  const t = zigToken.trim();
  if (!t) throw new Error("Token ZIG vazio.");
  return saveConfig(companyId, undefined, redeId, t);
};

export const getConfig = async (companyId: string) => {
  const raw = (await kvGet(`zig_config:${companyId}`)) as ZigKvConfig | null;
  if (!raw) return null;
  const tok = raw.zigToken?.trim();
  return {
    storeId: raw.storeId,
    redeId: raw.redeId,
    hasZigToken: !!tok,
    zigTokenMasked: tok ? maskToken(tok) : undefined,
  };
};

export type ZigConfirmLineItem = {
  transactionId: string;
  productSku: string;
  productName: string;
  /** Data civil (YYYY-MM-DD) em America/Sao_Paulo no momento do preview. */
  saleDate?: string;
  quantity: number;
  /** Valor unitário da linha no ZIG (BRL). Opcional para compatibilidade com deploys antigos. */
  unitValue?: number;
  /** Valor total da linha no ZIG (BRL). Opcional para compatibilidade com deploys antigos. */
  totalValue?: number;
};

// Fetch Pending Sales (Preview - Sem processar)
export const fetchPendingSales = async (
  companyId: string,
  startDate?: string,
  endDate?: string,
  options?: { includeProcessed?: boolean },
) => {
  const token = await getZigTokenForCompany(companyId);

  const config = await kvGet(`zig_config:${companyId}`);
  if (!config || !config.storeId) {
    throw new Error("Integração ZIG não configurada. Selecione uma loja nas configurações.");
  }

  // Intervalo: períodos longos são buscados em várias chamadas (regra ZIG: no máx. 5 dias por chamada).
  let apiStartDate: Date;
  let apiEndDate: Date;

  if (startDate && endDate) {
    apiStartDate = parseDateOnly(startDate);
    apiEndDate = parseDateOnly(endDate);
  } else {
    const endYmd = getTodayYmdSaoPaulo();
    const startYmd = addDaysToYmd(endYmd, -4); // 5 dias inclusivos (hoje em SP)
    apiStartDate = parseDateOnly(startYmd);
    apiEndDate = parseDateOnly(endYmd);
  }

  const startStr = formatDateOnly(apiStartDate);
  const endStr = formatDateOnly(apiEndDate);

  console.log(
    `ZIG: Buscando vendas pendentes da loja ${config.storeId} (${startStr} a ${endStr}, 1 requisição/dia)`,
  );

  try {
    const salesRaw: ZigSale[] = await fetchZigSaidaProdutosRange(
      token,
      config.storeId,
      startStr,
      endStr,
    );

    if (!Array.isArray(salesRaw)) {
      return { sales: [], salesByDate: {}, totalSales: 0, totalValue: 0 };
    }

    /**
     * A API `/erp/saida-produtos` pode trazer itens "montáveis"/adicionais dentro de `additions`.
     * O relatório da ZIG costuma listar esses itens separadamente (aba "Montáveis").
     * Se não expandirmos, a UI de baixa mostra menos produtos do que a ZIG reporta.
     */
    const sales: ZigSale[] = [];
    for (const s of salesRaw) {
      // Evita dupla contagem: adicionamos as linhas principais sem `additions` e expandimos os adicionais como linhas próprias.
      sales.push({ ...s, additions: [] });
      if (Array.isArray(s.additions) && s.additions.length > 0) {
        for (const add of s.additions) {
          const sku = String(add?.productSku || "").trim();
          if (!sku) continue;
          sales.push({
            transactionId: s.transactionId,
            transactionDate: s.transactionDate,
            eventDate: s.eventDate ?? null,
            eventId: s.eventId ?? null,
            productId: `add:${sku}`,
            productSku: sku,
            unitValue: Number((add as any)?.unitValue ?? 0) || 0,
            discountValue: Number((add as any)?.discountValue ?? 0) || 0,
            count: Number(add.count) || 0,
            fractionalAmount: add.fractionalAmount ?? null,
            productName: sku,
            type: "addition",
          } as ZigSale);
        }
      }
    }

    const includeProcessed = !!options?.includeProcessed;
    const newSales = [];
    const processedKeyPrefix = `zig_processed:${companyId}:`;
    
    for (const sale of sales) {
      const lineId = zigLineItemId(sale);
      const isProcessed = await kvGet(`${processedKeyPrefix}${lineId}`);
      if (isProcessed && !includeProcessed) continue;
      newSales.push(sale);
    }

    if (newSales.length === 0) {
      return { sales: [], salesByDate: {}, totalSales: 0, totalValue: 0 };
    }

    const products = await loadProducts(companyId);
    if (!products) throw new Error("Erro ao carregar produtos do sistema.");

    const recipesData = await loadRecipesWithIngredients(companyId);

    // Carregar mapeamentos salvos
    const productMappings = await kvGet(`zig_product_mappings:${companyId}`) || {};

    // Função para encontrar produto com match inteligente
    const findProduct = (sale: ZigSale) => {
      const mk = zigSaleMatchKey(sale);
      if (!mk) return null;

      // 1. Verificar mapeamento manual (SKU ou productId ZIG)
      if (productMappings[mk]) {
        return products.find(p => p.id === productMappings[mk]);
      }
      
      // 2. Match por SKU/Barcode
      let product = products.find(p => 
        p.barcode === mk || 
        (p.sku && p.sku === mk)
      );
      
      if (product) return product;
      
      // 3. Match por nome similar (normalizado)
      const normalizeName = (name: string) => 
        name.toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]/g, '');
      
      const zigNameNorm = normalizeName(sale.productName);
      
      product = products.find(p => {
        const productNameNorm = normalizeName(p.name);
        return productNameNorm === zigNameNorm || 
               productNameNorm.includes(zigNameNorm) ||
               zigNameNorm.includes(productNameNorm);
      });
      
      return product;
    };

    // Mapear vendas com produtos encontrados e agrupar por data
    const salesWithProducts = [];
    const salesByDate: Record<string, any[]> = {};
    
    for (const sale of newSales) {
      const matchKey = zigSaleMatchKey(sale);
      if (!matchKey) continue;
      
      const product = findProduct(sale);
      const qtyEff = zigEffectiveCount(sale);
      const saleDate = zigSalePrimaryYmd(sale);
      
      const lineId = zigLineItemId(sale);
      const displaySku = sale.productSku?.trim() || matchKey;

      if (product) {
        const recipe = recipesData.find(r => r.product_id === product.id);
        const unitValue = zigMoneyToBrl(sale.unitValue);
        const discountValue = zigMoneyToBrl((sale as any).discountValue ?? 0);
        
        const saleData = {
          zigTransactionId: sale.transactionId,
          transactionId: lineId,
          transactionDate: sale.transactionDate,
          saleDate: saleDate,
          productSku: displaySku,
          productName: sale.productName,
          quantity: qtyEff,
          unitValue,
          discountValue,
          totalValue: zigLineTotalValueBrl(sale),
          systemProduct: {
            id: product.id,
            name: product.name,
            currentStock: product.current_stock,
            unit: product.unit
          },
          isAddition: sale.type === 'addition',
          hasRecipe: !!recipe,
          matchType: productMappings[matchKey] ? 'manual' : 
                     (product.barcode === matchKey || product.sku === matchKey) ? 'sku' : 'name',
          recipe: recipe ? {
            ingredients: recipe.recipe_ingredients?.map((ing: any) => {
              const ingProduct = products.find(p => p.id === (ing.product_id || ing.ingredient_id));
              return {
                productId: ing.product_id || ing.ingredient_id,
                productName: ingProduct?.name || 'Desconhecido',
                quantity: ing.quantity || ing.amount,
                unit: ingProduct?.unit || 'un',
                quantityNeeded: (ing.quantity || ing.amount) * qtyEff
              };
            }) || []
          } : null
        };
        
        salesWithProducts.push(saleData);
        
        if (!salesByDate[saleDate]) salesByDate[saleDate] = [];
        salesByDate[saleDate].push(saleData);
        
      } else {
        const unitValue = zigMoneyToBrl(sale.unitValue);
        const discountValue = zigMoneyToBrl((sale as any).discountValue ?? 0);
        const saleData = {
          zigTransactionId: sale.transactionId,
          transactionId: lineId,
          transactionDate: sale.transactionDate,
          saleDate: saleDate,
          productSku: displaySku,
          productName: sale.productName,
          quantity: qtyEff,
          unitValue,
          discountValue,
          totalValue: zigLineTotalValueBrl(sale),
          systemProduct: null,
          isAddition: sale.type === 'addition',
          hasRecipe: false,
          recipe: null,
          notFound: true,
          matchType: 'none'
        };
        
        salesWithProducts.push(saleData);
        
        if (!salesByDate[saleDate]) salesByDate[saleDate] = [];
        salesByDate[saleDate].push(saleData);
      }
      
      // Processar adicionais
      if (sale.additions && sale.additions.length > 0) {
        for (const addition of sale.additions) {
          if (!addition.productSku) continue;
          
          const addProduct = products.find(p => 
            p.barcode === addition.productSku || 
            (p.sku && p.sku === addition.productSku)
          );
          
          if (addProduct) {
            const addQty = zigEffectiveAdditionCount(addition);
            const addSaleData = {
              zigTransactionId: sale.transactionId,
              transactionId: `${lineId}-add-${addition.productSku}`,
              transactionDate: sale.transactionDate,
              saleDate: saleDate,
              productSku: addition.productSku,
              productName: `${sale.productName} (Adicional)`,
              quantity: addQty,
              unitValue: 0,
              totalValue: 0,
              systemProduct: {
                id: addProduct.id,
                name: addProduct.name,
                currentStock: addProduct.current_stock,
                unit: addProduct.unit
              },
              hasRecipe: false,
              recipe: null,
              isAddition: true,
              matchType: 'sku'
            };
            
            salesWithProducts.push(addSaleData);
            salesByDate[saleDate].push(addSaleData);
          }
        }
      }
    }

    const previewSessionId = randomUUID();
    const previewLines: ZigConfirmLineItem[] = salesWithProducts.map((s) => ({
      transactionId: s.transactionId,
      productSku: s.productSku,
      productName: s.productName,
      saleDate: s.saleDate,
      quantity: s.quantity,
      unitValue: s.unitValue,
      totalValue: s.totalValue,
    }));
    await kvSet(`zig_preview_session:${companyId}:${previewSessionId}`, {
      lineItems: previewLines,
      expiresAt: Date.now() + 48 * 60 * 60 * 1000,
    });

    return {
      sales: salesWithProducts,
      salesByDate: salesByDate,
      totalSales: salesWithProducts.length,
      totalValue: salesWithProducts.reduce((sum, s) => sum + (s.totalValue || 0), 0),
      dateRange: { start: startStr, end: endStr },
      previewSessionId,
    };
  } catch (error: any) {
    console.error("ZIG: Erro ao buscar vendas pendentes:", error);
    throw error;
  }
};

type DeductionGroup = {
  saleDate: string;
  productSku: string;
  productName: string;
  totalQty: number;
  transactionIds: string[];
};

/** Normaliza data do snapshot/preview para YYYY-MM-DD (evita 1 grupo por horário). */
function normalizeZigSaleYmd(saleDate: string | undefined | null): string {
  const raw = String(saleDate || "").trim();
  if (!raw) return "";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (m) return m[1];
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    return transactionYmdSaoPaulo(d.toISOString()) || raw.split("T")[0] || "";
  }
  return raw.split("T")[0] || raw;
}

function addToDeductionGroup(
  groups: Map<string, DeductionGroup>,
  saleDate: string,
  productSku: string,
  productName: string,
  qty: number,
  transactionId: string,
) {
  if (!productSku) return;
  const ymd = normalizeZigSaleYmd(saleDate);
  const sku = productSku.trim();
  if (!sku) return;
  const groupKey = `${ymd}|${sku}`;
  const prev = groups.get(groupKey);
  if (!prev) {
    groups.set(groupKey, {
      saleDate: ymd,
      productSku: sku,
      productName,
      totalQty: qty || 0,
      transactionIds: [transactionId],
    });
    return;
  }
  prev.totalQty += qty || 0;
  if (!prev.productName && productName) prev.productName = productName;
  prev.transactionIds.push(transactionId);
}

function buildDeductionGroupsFromZigSales(
  sales: ZigSale[],
  selectedSet: Set<string>,
): Map<string, DeductionGroup> {
  const groups = new Map<string, DeductionGroup>();
  for (const sale of sales) {
    const lineId = zigLineItemId(sale);
    const saleDate = zigSalePrimaryYmd(sale);
    if (sale.productSku && selectedSet.has(lineId)) {
      addToDeductionGroup(
        groups,
        saleDate,
        sale.productSku,
        sale.productName,
        zigEffectiveCount(sale),
        lineId,
      );
    }
    if (sale.additions && sale.additions.length > 0) {
      for (const addition of sale.additions) {
        if (!addition.productSku) continue;
        const additionId = `${lineId}-add-${addition.productSku}`;
        if (!selectedSet.has(additionId)) continue;
        addToDeductionGroup(
          groups,
          saleDate,
          addition.productSku,
          `${sale.productName} (Adicional)`,
          zigEffectiveAdditionCount(addition),
          additionId,
        );
      }
    }
  }
  return groups;
}

function buildDeductionGroupsFromLineItems(
  lines: ZigConfirmLineItem[],
  selectedSet: Set<string>,
): Map<string, DeductionGroup> {
  const groups = new Map<string, DeductionGroup>();
  for (const line of lines) {
    if (!line.productSku?.trim()) continue;
    if (!selectedSet.has(line.transactionId)) continue;
    addToDeductionGroup(
      groups,
      line.saleDate || "",
      line.productSku.trim(),
      line.productName || line.productSku,
      Number(line.quantity) || 0,
      line.transactionId,
    );
  }
  return groups;
}

type ExecuteDeductionOpts = {
  registeredOnly: boolean;
  previewSessionIdToClear?: string;
};

function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV-1a
    h = Math.imul(h, 0x01000193);
  }
  // unsigned + hex
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Baixa de estoque + KV processado; não chama a API ZIG. */
async function executeZigStockDeductionFromGroups(
  companyId: string,
  groups: Map<string, DeductionGroup>,
  opts: ExecuteDeductionOpts,
): Promise<{ processed: number; createdProducts: number; message: string }> {
  const products = await loadProducts(companyId);
  if (!products) throw new Error("Erro ao carregar produtos do sistema.");

  const recipesData = await loadRecipesWithIngredients(companyId);
  const processedKeyPrefix = `zig_processed:${companyId}:`;

  if (groups.size === 0) {
    return {
      processed: 0,
      createdProducts: 0,
      message: "Nenhuma transação selecionada para processar.",
    };
  }

  const productMappings = (await kvGet(`zig_product_mappings:${companyId}`)) || {};

  const normalizeName = (name: string) =>
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");

  const findProduct = (sku: string, zigName?: string) => {
    if (productMappings && productMappings[sku]) {
      return products.find((p: any) => p.id === productMappings[sku]);
    }
    let product = products.find((p: any) =>
      p.barcode === sku || (p.sku && p.sku === sku),
    );
    if (product) return product;
    if (!zigName) return null;
    const zigNameNorm = normalizeName(zigName);
    product = products.find((p: any) => {
      const productNameNorm = normalizeName(p.name || "");
      return (
        productNameNorm === zigNameNorm ||
        productNameNorm.includes(zigNameNorm) ||
        zigNameNorm.includes(productNameNorm)
      );
    });
    return product || null;
  };

  const createdBySku = new Map<string, any>();
  let processedGroups = 0;
  let createdProducts = 0;

  const ensureProduct = async (productSku: string, productName: string) => {
    const alreadyCreated = createdBySku.get(productSku);
    if (alreadyCreated) return alreadyCreated;

    const existing = findProduct(productSku, productName);
    if (existing) return existing;

    const created = await insertProduct(companyId, productSku, productName);

    createdProducts++;
    products.push(created);
    createdBySku.set(productSku, created);
    return created;
  };

  /**
   * Consolida por produto do sistema + dia (não por cupom/linha ZIG).
   * Ex.: 200 Coronas em N cupons → 1 baixa de quantidade 200.
   */
  type ResolvedLot = {
    ymd: string;
    product: any;
    totalQty: number;
    productSku: string;
    productName: string;
    transactionIds: string[];
  };
  const lotsByProductDay = new Map<string, ResolvedLot>();

  for (const group of groups.values()) {
    const ymd = normalizeZigSaleYmd(group.saleDate);
    let product: any;
    if (opts.registeredOnly) {
      product = findProduct(group.productSku, group.productName);
      if (!product) {
        console.warn(
          `ZIG: registeredOnly — ignorando SKU sem cadastro: ${group.productSku}`,
        );
        continue;
      }
    } else {
      product = await ensureProduct(group.productSku, group.productName);
    }

    const lotKey = `${ymd || "sem-data"}|${product.id}`;
    const prev = lotsByProductDay.get(lotKey);
    if (!prev) {
      lotsByProductDay.set(lotKey, {
        ymd,
        product,
        totalQty: group.totalQty || 0,
        productSku: group.productSku,
        productName: group.productName || product.name || group.productSku,
        transactionIds: [...group.transactionIds],
      });
    } else {
      prev.totalQty += group.totalQty || 0;
      prev.transactionIds.push(...group.transactionIds);
      if (!prev.productName && group.productName) prev.productName = group.productName;
    }
  }

  for (const lot of lotsByProductDay.values()) {
    if (!Number.isFinite(lot.totalQty) || lot.totalQty <= 0) continue;

    const uniqueIds = Array.from(new Set(lot.transactionIds));
    const ref = uniqueIds.slice(0, 5).join(", ");
    const qtyLabel = Number(lot.totalQty).toLocaleString("pt-BR", {
      maximumFractionDigits: 4,
    });
    const reason =
      `Baixa ZIG (lote) — ${lot.productName} — qtd ${qtyLabel}` +
      (uniqueIds.length > 1 ? ` — ${uniqueIds.length} cupons/linhas` : "") +
      ` — Ref: ${ref}${uniqueIds.length > 5 ? "..." : ""}`;

    // Source estável por produto+dia (não por conjunto de cupons):
    // confirmações parciais no mesmo dia somam no mesmo lote lógico via qty,
    // mas cada confirm gera movement próprio se o hash de ids mudar — por isso
    // usamos hash só do produto+dia para idempotência do lote completo.
    // Para permitir reprocessar só o que faltou, incluímos hash dos ids deste confirm.
    const stableIds = uniqueIds.sort().join("|");
    const sourceBase = `zig:${companyId}:${lot.ymd || "sem-data"}:${lot.product.id}:${fnv1a32(stableIds)}`;
    const movementDateIso = lot.ymd
      ? `${lot.ymd}T12:00:00.000-03:00`
      : new Date().toISOString();

    console.log(
      `ZIG: baixa lote produto=${lot.product.id} (${lot.productName}) dia=${lot.ymd} qty=${lot.totalQty} linhas=${uniqueIds.length}`,
    );

    await processStockDeduction(
      companyId,
      lot.product,
      lot.totalQty,
      recipesData,
      reason,
      sourceBase,
      movementDateIso,
    );

    for (const id of uniqueIds) {
      await kvSet(`${processedKeyPrefix}${id}`, true);
    }

    processedGroups++;
  }

  const sid = opts.previewSessionIdToClear;
  if (sid) {
    try {
      await kvDel(`zig_preview_session:${companyId}:${sid}`);
    } catch {
      /* ignore */
    }
  }

  return {
    processed: processedGroups,
    createdProducts,
    message:
      `${processedGroups} produto(s) baixado(s) em lote (1 saída por produto/dia)${createdProducts > 0 ? ` — produtos criados: ${createdProducts}` : ""}.`,
  };
}

async function getOrCreateZigVirtualRegisterId(companyId: string): Promise<string> {
  const kvKey = `zig_sales_register:${companyId}`;
  const cached = (await kvGet(kvKey)) as { registerId?: string } | string | null;
  const registerIdFromKv =
    typeof cached === "string" ? cached : (cached && typeof cached === "object" ? cached.registerId : undefined);
  if (registerIdFromKv && registerIdFromKv.trim()) {
    // Validate exists
    const existingReg = await findCashRegisterById(companyId, registerIdFromKv.trim());
    if (existingReg?.id) return existingReg.id;
  }

  const regId = await insertZigVirtualRegister(companyId);
  await kvSet(kvKey, { registerId: regId });
  return regId;
}

async function recordRevenueSaleFromZigSnapshot(
  companyId: string,
  selectedTransactionIds: Set<string>,
  snapshotLines: ZigConfirmLineItem[],
): Promise<{ recorded: boolean; saleId?: string; total?: number }> {
  const selected = snapshotLines.filter((l) => selectedTransactionIds.has(l.transactionId));
  if (selected.length === 0) return { recorded: false };

  // Evita duplicar receita: se todas as linhas já foram registradas, não cria `sales` novamente.
  const revenueKeyPrefix = `zig_revenue_recorded:${companyId}:`;
  const already = new Set<string>();
  for (const l of selected) {
    const k = `${revenueKeyPrefix}${l.transactionId}`;
    const v = await kvGet(k);
    if (v) already.add(l.transactionId);
  }

  const pending = selected.filter((l) => !already.has(l.transactionId));
  if (pending.length === 0) return { recorded: false };

  const registerId = await getOrCreateZigVirtualRegisterId(companyId);

  // Mapear SKU->product_id (quando existir)
  const skus = [...new Set(pending.map((p) => (p.productSku || "").trim()).filter(Boolean))];
  const productIdBySku = new Map<string, string>();
  if (skus.length > 0) {
    const skuRows = await findProductsBySkus(companyId, skus);
    for (const r of skuRows) {
      const rr = r as { id: string; barcode: string | null; sku: string | null };
      if (rr.barcode?.trim()) productIdBySku.set(rr.barcode.trim(), rr.id);
      if (rr.sku?.trim()) productIdBySku.set(rr.sku.trim(), rr.id);
    }
  }

  const items = pending.map((l) => {
    const sku = (l.productSku || "").trim();
    const unit = zigMoneyToBrl(l.unitValue);
    const tv = zigMoneyToBrl(l.totalValue);
    const qty = Number(l.quantity) || 0;
    const unitValue = Number.isFinite(unit) ? unit : (qty > 0 && Number.isFinite(tv) ? tv / qty : 0);
    const totalValue = Number.isFinite(tv) ? tv : unitValue * qty;
    return {
      productId: sku ? productIdBySku.get(sku) : undefined,
      name: l.productName || sku || "Item ZIG",
      price: Math.round(unitValue * 100) / 100,
      quantity: qty,
      total: Math.round(totalValue * 100) / 100,
      sku,
      transactionId: l.transactionId,
      source: "zig",
    };
  });

  const total = items.reduce((s, it) => s + (Number(it.total) || 0), 0);

  const insertPayload = {
      company_id: companyId,
      register_id: registerId,
      cashier_id: "zig",
      cashier_name: "Integração ZIG",
      total,
      payment_method: "credit",
      payment_details: { source: "zig", lines: items.length },
      items,
      timestamp: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

  const saleId = await insertSale(insertPayload);
  const sale = { id: saleId };

  for (const l of pending) {
    await kvSet(`${revenueKeyPrefix}${l.transactionId}`, { saleId: sale.id, at: Date.now() });
  }

  return { recorded: true, saleId: sale.id, total };
}

/**
 * Rota dedicada ao PDV: **nunca** chama GET na API ZIG — só snapshot (lineItems ou KV).
 * Use quando `/zig/confirm` ainda acionar código antigo em produção.
 */
export async function confirmStockFromZigPreviewSnapshot(
  companyId: string,
  transactionIds: string[],
  lineItems: ZigConfirmLineItem[] | undefined,
  previewSessionId: string | undefined,
  registeredOnly: boolean,
): Promise<{ processed: number; createdProducts: number; message: string }> {
  const config = await kvGet(`zig_config:${companyId}`);
  if (!config?.storeId) {
    throw new Error("Integração ZIG não configurada.");
  }

  let snapshotLines: ZigConfirmLineItem[] | undefined;
  const sid = previewSessionId?.trim();

  if (sid) {
    const sess = await kvGet(`zig_preview_session:${companyId}:${sid}`) as {
      lineItems?: ZigConfirmLineItem[];
      expiresAt?: number;
    } | null;
    if (!sess?.lineItems || !Array.isArray(sess.lineItems)) {
      throw new Error(
        "Sessão de preview inválida ou expirada. Busque as vendas na ZIG novamente e confirme em seguida.",
      );
    }
    if (typeof sess.expiresAt === "number" && Date.now() > sess.expiresAt) {
      throw new Error("Sessão de preview expirada. Busque as vendas na ZIG novamente.");
    }
    snapshotLines = sess.lineItems;
  } else if (lineItems?.length) {
    snapshotLines = lineItems;
  }

  if (!snapshotLines?.length) {
    throw new Error(
      "É necessário o preview: busque «Buscar vendas pendentes» e confirme, ou envie lineItems / previewSessionId válidos.",
    );
  }

  const selectedIds = Array.from(
    new Set((transactionIds || []).map((id) => String(id || "").trim()).filter(Boolean)),
  );
  if (selectedIds.length === 0) {
    throw new Error(
      "Nenhum produto selecionado. Marque os itens na lista «Vendas ZIG — baixa no estoque» antes de confirmar.",
    );
  }

  const selectedSet = new Set(selectedIds);
  // Snapshot do KV pode ter o dia inteiro — só processa o que foi marcado na UI.
  const onlySelectedLines = snapshotLines.filter((l) => selectedSet.has(l.transactionId));
  if (onlySelectedLines.length === 0) {
    throw new Error(
      "Os IDs selecionados não correspondem ao preview. Busque as vendas novamente e marque os produtos desejados.",
    );
  }

  const groups = buildDeductionGroupsFromLineItems(onlySelectedLines, selectedSet);

  console.log(
    `ZIG: confirm snapshot — apenas selecionados (${selectedIds.length} id(s), ${onlySelectedLines.length} linha(s) do preview), sem API ZIG`,
  );

  if (groups.size === 0) {
    throw new Error(
      "Nenhum produto selecionado válido para baixa. Marque os itens na lista e tente novamente.",
    );
  }

  const stockRes = await executeZigStockDeductionFromGroups(companyId, groups, {
    registeredOnly,
    // Não apaga a sessão se ainda houver itens não selecionados no preview
    // (permite confirmar outro lote sem buscar de novo).
    previewSessionIdToClear:
      onlySelectedLines.length >= snapshotLines.length ? sid : undefined,
  });

  // Receita só das linhas selecionadas
  try {
    await recordRevenueSaleFromZigSnapshot(companyId, selectedSet, onlySelectedLines);
  } catch (e: unknown) {
    console.error("ZIG: Falha ao registrar receita (sales) no confirm snapshot:", e);
  }

  return stockRes;
}

export type ConfirmSalesOptions = {
  /** Se true, não cria produto novo — só baixa quando já existe cadastro (SKU/nome/mapeamento). */
  registeredOnly?: boolean;
  /**
   * Linhas do último preview (mesmo período das transações selecionadas).
   * Se presente, **não** chama a API ZIG na confirmação — só baixa no estoque local.
   */
  lineItems?: ZigConfirmLineItem[];
  /**
   * ID retornado em `fetchPendingSales` — linhas gravadas no KV no servidor.
   * Preferir em relação ao body `lineItems` (evita confirmação sem snapshot quando o POST não repete o array).
   */
  previewSessionId?: string;
  /**
   * Confirmação a partir do modal de preview (PDV). Se true e não houver snapshot válido,
   * **não** chama a ZIG — retorna erro claro (evita 500 "5 dias" com deploy antigo ou sessão perdida).
   */
  fromPreview?: boolean;
  /**
   * `true` quando a chamada vem de `POST /zig/confirm` (navegador). Nunca refaz GET na ZIG sem snapshot;
   * `false`/omitido para baixa automática interna (`runAutoBaixaZigOntem`), que ainda busca na ZIG.
   */
  confirmViaHttp?: boolean;
};

// Confirm and Process Sales (Dar baixa efetivamente)
export const confirmSales = async (
  companyId: string,
  transactionIds: string[],
  startDate?: string,
  endDate?: string,
  options?: ConfirmSalesOptions,
) => {
  const config = await kvGet(`zig_config:${companyId}`);
  if (!config || !config.storeId) {
    throw new Error("Integração ZIG não configurada.");
  }

  let apiStartDate: Date;
  let apiEndDate: Date;

  if (startDate && endDate) {
    apiStartDate = parseDateOnly(startDate);
    apiEndDate = parseDateOnly(endDate);
  } else {
    const now = new Date();
    apiEndDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    apiStartDate = new Date(apiEndDate);
    apiStartDate.setUTCDate(apiStartDate.getUTCDate() - 1);
  }

  const startStr = formatDateOnly(apiStartDate);
  const endStr = formatDateOnly(apiEndDate);

  let snapshotLines: ZigConfirmLineItem[] | undefined;
  const sid = options?.previewSessionId?.trim();
  if (sid) {
    const sess = await kvGet(`zig_preview_session:${companyId}:${sid}`) as {
      lineItems?: ZigConfirmLineItem[];
      expiresAt?: number;
    } | null;
    if (!sess?.lineItems || !Array.isArray(sess.lineItems)) {
      throw new Error(
        "Sessão de preview inválida ou expirada. Busque as vendas na ZIG novamente e confirme em seguida.",
      );
    }
    if (typeof sess.expiresAt === "number" && Date.now() > sess.expiresAt) {
      throw new Error(
        "Sessão de preview expirada. Busque as vendas na ZIG novamente.",
      );
    }
    snapshotLines = sess.lineItems;
  } else if (Array.isArray(options?.lineItems) && options!.lineItems!.length > 0) {
    snapshotLines = options!.lineItems;
  }

  const usePreviewSnapshot = Array.isArray(snapshotLines) && snapshotLines.length > 0;

  if (options?.confirmViaHttp === true && !usePreviewSnapshot) {
    throw new Error(
      "Confirmação pelo app sem snapshot de vendas: clique em «Buscar vendas pendentes», aguarde o preview e confirme em seguida. " +
        "Esta rota não chama a API ZIG de novo (evita o erro «5 dias»). Se o preview funcionar e isto continuar, publique a Edge Function `make-server-8a20b27d`.",
    );
  }

  const hasSnapshotPayload =
    (Array.isArray(options?.lineItems) && options.lineItems.length > 0) ||
    !!options?.previewSessionId?.trim();

  if (!usePreviewSnapshot && (options?.fromPreview || hasSnapshotPayload)) {
    throw new Error(
      "Não foi possível usar o snapshot do preview na confirmação (sessão expirada ou dados incompletos). " +
        "Clique em «Buscar vendas pendentes» de novo e confirme em seguida.",
    );
  }

  console.log(
    usePreviewSnapshot
      ? `ZIG: Confirmando baixa só no Stockpyrou (${transactionIds.length} id(s), snapshot do preview — sem nova chamada ZIG)${sid ? " [sessão KV]" : ""}`
      : `ZIG: Confirmando e processando ${transactionIds.length} transações (selecionadas); intervalo ${startStr} → ${endStr}${options?.registeredOnly ? " [apenas produtos cadastrados]" : ""}`,
  );

  try {
    const selectedIds = Array.from(
      new Set((transactionIds || []).map((id) => String(id || "").trim()).filter(Boolean)),
    );
    if (selectedIds.length === 0) {
      throw new Error(
        "Nenhum produto selecionado. Marque os itens na lista «Vendas ZIG — baixa no estoque» antes de confirmar.",
      );
    }
    const selectedSet = new Set(selectedIds);

    let groups: Map<string, DeductionGroup>;

    if (usePreviewSnapshot) {
      const onlySelected = snapshotLines!.filter((l) => selectedSet.has(l.transactionId));
      if (onlySelected.length === 0) {
        throw new Error(
          "Os IDs selecionados não correspondem ao preview. Busque as vendas e marque os produtos desejados.",
        );
      }
      groups = buildDeductionGroupsFromLineItems(onlySelected, selectedSet);
    } else {
      const token = await getZigTokenForCompany(companyId);
      const sales: ZigSale[] = await fetchZigSaidaProdutosRange(
        token,
        config.storeId,
        startStr,
        endStr,
      );
      if (!Array.isArray(sales)) {
        throw new Error("Formato de resposta inválido da API ZIG.");
      }
      groups = buildDeductionGroupsFromZigSales(sales, selectedSet);
    }

    if (groups.size === 0) {
      throw new Error("Nenhum produto selecionado válido para baixa.");
    }

    return await executeZigStockDeductionFromGroups(companyId, groups, {
      registeredOnly: !!options?.registeredOnly,
      previewSessionIdToClear:
        usePreviewSnapshot && snapshotLines && selectedIds.length >= snapshotLines.length
          ? sid
          : usePreviewSnapshot
            ? undefined
            : sid,
    });
  } catch (error: any) {
    console.error("ZIG: Erro ao confirmar vendas:", error);
    throw error;
  }
};

// --- Baixa automática (dia seguinte = vendas de "ontem" em SP) — cria produto se faltar cadastro ---

export async function getAutoBaixaConfig(companyId: string): Promise<{ enabled: boolean }> {
  const row = await kvGet(`zig_auto_baixa:${companyId}`);
  return { enabled: !!(row && row.enabled) };
}

export async function saveAutoBaixaConfig(companyId: string, enabled: boolean): Promise<void> {
  await kvSet(`zig_auto_baixa:${companyId}`, { enabled });
}

/**
 * Busca vendas de ontem (America/Sao_Paulo), processa linhas ainda não marcadas em `zig_processed`,
 * cria produtos ausentes e dá baixa (mesma lógica de `ensureProduct` do fluxo manual).
 */
export async function runAutoBaixaZigOntem(companyId: string) {
  const auto = await getAutoBaixaConfig(companyId);
  if (!auto.enabled) {
    return {
      skipped: true,
      message: "Baixa automática desativada para esta empresa.",
      processed: 0,
    };
  }

  const config = await kvGet(`zig_config:${companyId}`);
  if (!config?.storeId) {
    return {
      skipped: true,
      message: "Integração ZIG não configurada (loja).",
      processed: 0,
    };
  }

  const token = await getZigTokenForCompany(companyId);
  const yesterdayStr = getYesterdayYmdSaoPaulo();

  const sales: ZigSale[] = await fetchZigSaidaProdutosRange(
    token,
    config.storeId,
    yesterdayStr,
    yesterdayStr,
  );

  if (!Array.isArray(sales) || sales.length === 0) {
    return {
      skipped: false,
      message: `Nenhuma venda ZIG em ${yesterdayStr}.`,
      processed: 0,
      date: yesterdayStr,
    };
  }

  const processedKeyPrefix = `zig_processed:${companyId}:`;
  /** Só inclui IDs ainda não marcados — evita re-baixar linha principal se só o adicional estiver pendente (e vice-versa). */
  const idSet = new Set<string>();
  for (const sale of sales) {
    const lineId = zigLineItemId(sale);
    if (!(await kvGet(`${processedKeyPrefix}${lineId}`))) {
      idSet.add(lineId);
    }
    if (sale.additions?.length) {
      for (const a of sale.additions) {
        if (!a.productSku) continue;
        const aid = `${lineId}-add-${a.productSku}`;
        if (!(await kvGet(`${processedKeyPrefix}${aid}`))) {
          idSet.add(aid);
        }
      }
    }
  }

  const transactionIds = Array.from(idSet);
  if (transactionIds.length === 0) {
    return {
      skipped: false,
      message: "Nenhuma venda nova de ontem pendente de processamento.",
      processed: 0,
      date: yesterdayStr,
    };
  }

  const result = await confirmSales(
    companyId,
    transactionIds,
    yesterdayStr,
    yesterdayStr,
    { registeredOnly: false },
  );

  return {
    skipped: false,
    message: result.message,
    processed: result.processed,
    createdProducts: result.createdProducts,
    date: yesterdayStr,
    transactionCount: transactionIds.length,
  };
}

async function processStockDeduction(
  companyId: string, 
  product: any, 
  qty: number, 
  recipes: any[], 
  refId: string,
  sourceBase: string,
  movementDateIso: string,
) {
  const bundleItems = parseBundleItemsFromProduct(product);
  if (bundleItems.length > 0) {
    for (const b of bundleItems) {
      const neededQty = b.quantity * qty;
      if (!b.productId || !Number.isFinite(neededQty) || neededQty <= 0) continue;
      await deductStock(
        b.productId,
        neededQty,
        `Baixa ZIG (Combo: ${product.name}) — ${refId}`,
        `${sourceBase}:${b.productId}:combo`,
        companyId,
        movementDateIso,
      );
    }
    return;
  }

  const recipe = recipes.find(r => r.product_id === product.id);

  if (recipe && recipe.recipe_ingredients && recipe.recipe_ingredients.length > 0) {
    for (const ing of recipe.recipe_ingredients) {
      const neededQty = (ing.quantity || ing.amount) * qty;
      const pid = ing.product_id || ing.ingredient_id;
      await deductStock(
        pid,
        neededQty,
        `Baixa ZIG (Receita: ${product.name}) — ${refId}`,
        `${sourceBase}:${pid}:recipe`,
        companyId,
        movementDateIso,
      );
    }
  } else {
    // Motivo já vem consolidado do lote (produto + qtd total)
    await deductStock(
      product.id,
      qty,
      refId,
      `${sourceBase}:${product.id}:direct`,
      companyId,
      movementDateIso,
    );
  }
}

function parseBundleItemsFromProduct(product: any): Array<{ productId: string; quantity: number }> {
  try {
    const desc = product?.description;
    const parsed =
      typeof desc === "string" && desc.trim().startsWith("{") ? JSON.parse(desc) :
      (desc && typeof desc === "object" ? desc : null);
    const items = parsed?.bundleItems;
    if (!Array.isArray(items)) return [];
    return items
      .map((x: any) => ({
        productId: String(x?.productId || ""),
        quantity: Number(x?.quantity || 0),
      }))
      .filter((x) => x.productId && Number.isFinite(x.quantity) && x.quantity > 0);
  } catch {
    return [];
  }
}

async function deductStock(
  productId: string,
  qty: number,
  reason: string,
  source: string,
  companyId: string,
  movementDateIso: string,
) {
  // Tipo `saida` (como baixa manual): aparece em Relatórios → Saídas como "Saída",
  // com quantidade total do lote — não uma linha por cupom ZIG.
  await query(
    `SELECT * FROM deduct_stock_once($1,$2,$3,$4,$5,$6,$7)`,
    [
      companyId,
      productId,
      qty,
      source,
      `${reason} - Integração automática ZIG`,
      'saida',
      movementDateIso || new Date().toISOString(),
    ],
  );
}