/**
 * CERT Support Agent - Cloudflare Worker
 * Version: 2.0.0
 *
 * Edge-native AI support agent for CERT Outfitters using:
 * - Cloudflare Workers AI  (Llama-3.1-8b-instruct)
 * - Cloudflare D1          (SQLite — orders + NC county tax rates)
 * - Cloudflare KV          (rate limiting)
 * - Cloudflare Analytics Engine (Galileo-style chain trace logging)
 *
 * Observability pattern modeled after the Galileo AI eval framework:
 * Route → Retrieve → Evaluate → Synthesize, with per-step tracing,
 * faithfulness scoring, context adherence, groundedness, and completeness.
 */

// ─── Environment bindings ────────────────────────────────────────────────────

export interface Env {
  AI: Ai;
  DB: D1Database;
  RATE_LIMITER: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
  TURNSTILE_SECRET?: string;
}

// ─── Data types ───────────────────────────────────────────────────────────────

interface Order {
  order_id: string;
  customer_name: string;
  customer_state: string;
  customer_county: string;
  status: string;
  tracking_number: string;
  carrier: string;
  estimated_delivery: string;
  items: string;             // JSON: Array<{ name: string; qty: number; sku: string }>
  return_eligible: number;   // 1 = yes, 0 = no
  subtotal: number;
  tax_rate: number;          // e.g. 0.0725
  tax_collected: number;
  tax_verified: number;      // 0 = unverified, 1 = verified correct, -1 = discrepancy
  created_at: string;
}

interface OrderItem {
  name: string;
  qty: number;
  sku: string;
}

type Intent =
  | 'order_status'
  | 'order_return'
  | 'order_items'
  | 'shipping_estimate'
  | 'tax_inquiry'
  | 'general_faq'
  | 'unknown';

interface AgentRequest {
  query: string;
  turnstile_token?: string;
}

// ─── Galileo-style observability types ───────────────────────────────────────

type StepType = 'retriever' | 'llm' | 'evaluator';

interface ChainStep {
  step_id: string;
  step_type: StepType;
  input: string;
  output: string;
  latency_ms: number;
  token_estimate: number;
  metadata: Record<string, unknown>;
}

interface EvalMetrics {
  faithfulness: number;        // 0.0–1.0: response only references DB-grounded facts
  context_adherence: number;   // 0.0–1.0: response stays within detected intent scope
  groundedness: number;        // 0.0–1.0: every claim traceable to a specific order field
  completeness: number;        // 0.0–1.0: response fully addresses the customer query
  chunk_attribution: string[]; // which Order fields were actually used in the response
}

interface GalileoTrace {
  chain_id: string;
  run_id: string;
  project: string;
  timestamp: string;
  region: string;
  model: string;
  intent: Intent;
  order_id_extracted: string | null;
  order_found: boolean;
  tax_verified: number | null;
  tax_discrepancy: number | null;
  latency_ms: number;
  rate_limited: boolean;
  steps: ChainStep[];
  eval_metrics: EvalMetrics;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MODEL             = '@cf/meta/llama-3.1-8b-instruct';
const AGENT_VERSION     = 'cert-agent-v2';
const PROJECT_NAME      = 'cert-support-agent';
const RATE_LIMIT_WINDOW = 60;   // seconds
const RATE_LIMIT_MAX    = 20;   // requests per window

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age':       '86400',
};

// NC state base rate — counties add on top (sourced: NCDOR 2025)
const NC_STATE_BASE_RATE = 0.0475;

// ─── NC county tax rate table ─────────────────────────────────────────────────
// Hardcoded from NCDOR published rates — update when rates change.

const NC_COUNTY_TAX_RATES: Record<string, number> = {
  alamance:       0.0200,
  alexander:      0.0225,
  anson:          0.0250,
  ashe:           0.0200,
  beaufort:       0.0225,
  bladen:         0.0225,
  brunswick:      0.0225,
  buncombe:       0.0250,
  burke:          0.0225,
  cabarrus:       0.0200,
  caldwell:       0.0200,
  camden:         0.0225,
  carteret:       0.0200,
  caswell:        0.0225,
  catawba:        0.0200,
  chatham:        0.0225,
  cherokee:       0.0225,
  chowan:         0.0225,
  clay:           0.0200,
  cleveland:      0.0225,
  columbus:       0.0250,
  craven:         0.0225,
  cumberland:     0.0250,
  currituck:      0.0225,
  dare:           0.0200,
  davidson:       0.0225,
  davie:          0.0225,
  duplin:         0.0225,
  durham:         0.0275,
  edgecombe:      0.0250,
  forsyth:        0.0225,
  franklin:       0.0250,
  gaston:         0.0200,
  gates:          0.0200,
  graham:         0.0200,
  granville:      0.0250,
  greene:         0.0225,
  guilford:       0.0225,
  halifax:        0.0250,
  harnett:        0.0225,
  haywood:        0.0225,
  henderson:      0.0225,
  hertford:       0.0250,
  hoke:           0.0250,
  hyde:           0.0225,
  iredell:        0.0200,
  jackson:        0.0225,
  johnston:       0.0225,
  jones:          0.0225,
  lee:            0.0225,
  lenoir:         0.0250,
  lincoln:        0.0225,
  macon:          0.0225,
  madison:        0.0225,
  martin:         0.0250,
  mcdowell:       0.0225,
  mecklenburg:    0.0250,
  mitchell:       0.0225,
  montgomery:     0.0225,
  moore:          0.0225,
  nash:           0.0250,
  newhanover:     0.0225,
  northampton:    0.0250,
  onslow:         0.0225,
  orange:         0.0275,
  pamlico:        0.0225,
  pasquotank:     0.0225,
  pender:         0.0225,
  perquimans:     0.0200,
  person:         0.0225,
  pitt:           0.0225,
  polk:           0.0225,
  randolph:       0.0200,
  richmond:       0.0250,
  robeson:        0.0250,
  rockingham:     0.0225,
  rowan:          0.0225,
  rutherford:     0.0225,
  sampson:        0.0225,
  scotland:       0.0250,
  stanly:         0.0225,
  stokes:         0.0225,
  surry:          0.0225,
  swain:          0.0225,
  transylvania:   0.0225,
  tyrrell:        0.0225,
  union:          0.0200,
  vance:          0.0250,
  wake:           0.0250,
  warren:         0.0250,
  washington:     0.0225,
  watauga:        0.0225,
  wayne:          0.0225,
  wilkes:         0.0200,
  wilson:         0.0250,
  yadkin:         0.0225,
  yancey:         0.0200,
};

// ─── Tax logic ────────────────────────────────────────────────────────────────

interface TaxVerificationResult {
  applicable: boolean;
  expected_rate: number;
  expected_tax: number;
  collected_tax: number;
  discrepancy: number;
  discrepancy_pct: number;
  verdict: 'correct' | 'discrepancy' | 'not_applicable' | 'unknown_county';
  county_rate_used: number;
}

function verifyTax(order: Order): TaxVerificationResult {
  const state = order.customer_state?.trim().toUpperCase();

  if (state !== 'NC') {
    return {
      applicable:       false,
      expected_rate:    0,
      expected_tax:     0,
      collected_tax:    order.tax_collected,
      discrepancy:      order.tax_collected,
      discrepancy_pct:  0,
      verdict:          order.tax_collected > 0 ? 'discrepancy' : 'not_applicable',
      county_rate_used: 0,
    };
  }

  const countyKey  = order.customer_county?.trim().toLowerCase().replace(/\s+/g, '');
  const countyRate = NC_COUNTY_TAX_RATES[countyKey];

  if (countyRate === undefined) {
    return {
      applicable:       true,
      expected_rate:    0,
      expected_tax:     0,
      collected_tax:    order.tax_collected,
      discrepancy:      0,
      discrepancy_pct:  0,
      verdict:          'unknown_county',
      county_rate_used: 0,
    };
  }

  const totalRate   = NC_STATE_BASE_RATE + countyRate;
  const expectedTax = Math.round(order.subtotal * totalRate * 100) / 100;
  const discrepancy = Math.round((order.tax_collected - expectedTax) * 100) / 100;
  const discPct     = expectedTax > 0
    ? Math.round((Math.abs(discrepancy) / expectedTax) * 10000) / 100
    : 0;

  return {
    applicable:       true,
    expected_rate:    totalRate,
    expected_tax:     expectedTax,
    collected_tax:    order.tax_collected,
    discrepancy,
    discrepancy_pct:  discPct,
    verdict:          Math.abs(discrepancy) < 0.01 ? 'correct' : 'discrepancy',
    county_rate_used: countyRate,
  };
}

// ─── Galileo-style evaluator ──────────────────────────────────────────────────

function evaluateResponse(
  intent: Intent,
  order: Order | null,
  response: string,
  taxResult: TaxVerificationResult | null
): EvalMetrics {
  const r = response.toLowerCase();
  const attribution: string[] = [];

  if (!order) {
    return {
      faithfulness:      r.includes('order') ? 0.9 : 0.7,
      context_adherence: 1.0,
      groundedness:      0.5,
      completeness:      r.length > 80 ? 0.8 : 0.5,
      chunk_attribution: [],
    };
  }

  const inventedTracking = order.tracking_number &&
    !r.includes(order.tracking_number.toLowerCase()) &&
    /\b[0-9]{10,}\b/.test(r);
  const faithfulness = inventedTracking ? 0.4 : 0.95;

  if (r.includes(order.status.toLowerCase()))                        attribution.push('status');
  if (r.includes(order.tracking_number.toLowerCase()))               attribution.push('tracking_number');
  if (r.includes(order.carrier.toLowerCase()))                       attribution.push('carrier');
  if (r.includes(order.estimated_delivery.toLowerCase()))            attribution.push('estimated_delivery');
  if (r.includes(order.customer_name.split(' ')[0].toLowerCase()))   attribution.push('customer_name');
  if (order.tax_collected && r.includes(String(order.tax_collected))) attribution.push('tax_collected');
  if (taxResult && r.includes(String(taxResult.expected_tax)))        attribution.push('expected_tax');

  const intentKeywords: Record<Intent, string[]> = {
    order_status:      ['status', 'shipped', 'processing', 'delivered', 'transit'],
    order_return:      ['return', 'refund', 'rma', 'eligible', 'exchange'],
    order_items:       ['item', 'product', 'kit', 'vest', 'gear', 'sku', 'qty'],
    shipping_estimate: ['deliver', 'arrival', 'estimated', 'carrier', 'tracking'],
    tax_inquiry:       ['tax', 'rate', 'charged', 'amount', 'county', 'correct'],
    general_faq:       ['help', 'support', 'contact', 'question'],
    unknown:           [],
  };
  const keywords         = intentKeywords[intent] ?? [];
  const hits             = keywords.filter(kw => r.includes(kw)).length;
  const contextAdherence = keywords.length > 0
    ? Math.min(1.0, 0.5 + (hits / keywords.length) * 0.5)
    : 0.8;

  const groundedness = attribution.length >= 2 ? 0.95
    : attribution.length === 1                  ? 0.75
    : 0.5;

  const completeness = r.length > 120 ? 0.9
    : r.length > 60                   ? 0.75
    : 0.5;

  return {
    faithfulness,
    context_adherence: contextAdherence,
    groundedness,
    completeness,
    chunk_attribution: attribution,
  };
}

// ─── Intent classification ────────────────────────────────────────────────────

function classifyIntent(query: string): Intent {
  const q = query.toLowerCase();

  if (/tax|taxes|taxed|tax rate|tax amount|tax charge|sales tax/i.test(q)) return 'tax_inquiry';

  if (/cert-\d{6}/i.test(query)) {
    if (/return|refund|rma|exchange|send back/i.test(q))       return 'order_return';
    if (/item|product|what.*order|contents|kit|gear/i.test(q)) return 'order_items';
    if (/deliver|arrival|when|eta|ship|transit/i.test(q))      return 'shipping_estimate';
    return 'order_status';
  }

  if (/return|refund|rma|exchange/i.test(q))             return 'order_return';
  if (/deliver|ship|transit|arrival|how long/i.test(q))  return 'shipping_estimate';

  return 'general_faq';
}

function extractOrderId(query: string): string | null {
  const match = query.match(/CERT-\d{6}/i);
  return match ? match[0].toUpperCase() : null;
}

// ─── Database queries ─────────────────────────────────────────────────────────

async function getOrderFromDB(db: D1Database, orderId: string): Promise<Order | null> {
  try {
    return await db
      .prepare(
        `SELECT order_id, customer_name, customer_state, customer_county,
                status, tracking_number, carrier, estimated_delivery,
                items, return_eligible, subtotal, tax_rate, tax_collected,
                tax_verified, created_at
         FROM orders WHERE order_id = ?`
      )
      .bind(orderId)
      .first<Order>();
  } catch (err) {
    console.error('[CERT-AGENT] DB error:', err);
    return null;
  }
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

async function isRateLimited(kv: KVNamespace, ip: string): Promise<boolean> {
  const key   = `rl:${ip}`;
  const raw   = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= RATE_LIMIT_MAX) return true;
  await kv.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW });
  return false;
}

// ─── Turnstile validation ─────────────────────────────────────────────────────

async function validateTurnstile(secret: string, token: string): Promise<boolean> {
  try {
    const res  = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ secret, response: token }),
    });
    const data = await res.json<{ success: boolean }>();
    return data.success === true;
  } catch {
    return false;
  }
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(
  intent: Intent,
  query: string,
  order: Order | null,
  taxResult: TaxVerificationResult | null
): string {
  const base = `You are a concise, professional customer support agent for CERT Outfitters,
an emergency-preparedness gear company. Respond in 2–4 sentences maximum.
Do not invent information. If a piece of data is missing, say so plainly.`;

  if (!order) {
    if (extractOrderId(query)) {
      return `${base}\n\nCustomer query: "${query}"\n
We could not locate this order in our system. Politely ask the customer to
double-check their order number or contact support@certoutfitters.com.`;
    }
    return `${base}\n\nCustomer query: "${query}"\n
Answer helpfully with general support information. If order data is needed,
ask for their CERT order number (format: CERT-XXXXXX).`;
  }

  const items = (() => {
    try { return JSON.parse(order.items) as OrderItem[]; }
    catch { return [] as OrderItem[]; }
  })();
  const itemList     = items.map(i => `${i.qty}x ${i.name} (SKU: ${i.sku})`).join(', ');
  const returnStatus = order.return_eligible
    ? 'eligible for return within 30 days'
    : 'not eligible for return';

  let taxBlock = '';
  if (taxResult) {
    if (!taxResult.applicable) {
      taxBlock = `\nTax Note: This order is from ${order.customer_state} — no NC sales tax applies. ` +
        (order.tax_collected > 0
          ? `However, $${order.tax_collected.toFixed(2)} was collected — this is a discrepancy.`
          : 'No tax was collected. Correct.');
    } else if (taxResult.verdict === 'correct') {
      taxBlock = `\nTax Note: NC ${order.customer_county} County. ` +
        `Rate: ${(taxResult.expected_rate * 100).toFixed(4)}% ` +
        `(State ${(NC_STATE_BASE_RATE * 100).toFixed(2)}% + County ${(taxResult.county_rate_used * 100).toFixed(2)}%). ` +
        `Tax collected $${taxResult.collected_tax.toFixed(2)} is CORRECT.`;
    } else if (taxResult.verdict === 'discrepancy') {
      const dir = taxResult.discrepancy > 0 ? 'overcharged' : 'undercharged';
      taxBlock = `\nTax Note: NC ${order.customer_county} County. ` +
        `Expected $${taxResult.expected_tax.toFixed(2)} at ` +
        `${(taxResult.expected_rate * 100).toFixed(4)}%, ` +
        `collected $${taxResult.collected_tax.toFixed(2)}. ` +
        `Customer was ${dir} by $${Math.abs(taxResult.discrepancy).toFixed(2)} — FLAG FOR REVIEW.`;
    } else if (taxResult.verdict === 'unknown_county') {
      taxBlock = `\nTax Note: County "${order.customer_county}" not found in rate table. Manual review required.`;
    }
  }

  const orderContext = `
Order ID:           ${order.order_id}
Customer:           ${order.customer_name}
State/County:       ${order.customer_state} / ${order.customer_county}
Status:             ${order.status}
Carrier:            ${order.carrier}
Tracking:           ${order.tracking_number}
Est. Delivery:      ${order.estimated_delivery}
Items:              ${itemList || 'N/A'}
Return Status:      ${returnStatus}
Subtotal:           $${order.subtotal.toFixed(2)}
Tax Collected:      $${order.tax_collected.toFixed(2)}
Order Date:         ${order.created_at}${taxBlock}`.trim();

  const intentInstructions: Record<Intent, string> = {
    order_status:      'Report the current order status and tracking details.',
    order_return:      'State whether the order is return-eligible and outline the return process.',
    order_items:       'List the items in the order clearly.',
    shipping_estimate: 'State the estimated delivery date and carrier.',
    tax_inquiry:       'Explain the tax charged, whether it is correct, and flag any discrepancy.',
    general_faq:       'Answer the general question using available context.',
    unknown:           'Answer helpfully using available context.',
  };

  return `${base}\n\nCustomer query: "${query}"\n\nOrder context:\n${orderContext}\n\nInstruction: ${intentInstructions[intent]}`;
}

// ─── AI call ──────────────────────────────────────────────────────────────────

async function callLLM(ai: Ai, prompt: string): Promise<string> {
  try {
    const response = await ai.run(MODEL, {
      messages: [
        { role: 'system', content: 'You are a helpful, concise support agent for CERT Outfitters.' },
        { role: 'user',   content: prompt },
      ],
    });
    return response.response ?? 'I could not generate a response. Please try again.';
  } catch (err) {
    console.error('[CERT-AGENT] LLM error:', err);
    return 'I encountered an issue processing your request. Please try again.';
  }
}

// ─── Galileo-style trace logger ───────────────────────────────────────────────

function emitTrace(analytics: AnalyticsEngineDataset, trace: GalileoTrace): void {
  analytics.writeDataPoint({
    blobs: [
      trace.chain_id,
      trace.run_id,
      trace.project,
      trace.intent,
      trace.order_id_extracted ?? '',
      trace.model,
    ],
    doubles: [
      trace.latency_ms,
      trace.eval_metrics.faithfulness,
      trace.eval_metrics.context_adherence,
      trace.eval_metrics.groundedness,
      trace.eval_metrics.completeness,
      trace.order_found ? 1 : 0,
      trace.rate_limited ? 1 : 0,
      trace.tax_discrepancy ?? 0,
    ],
    indexes: [trace.chain_id],
  });
}

// ─── Response helper ──────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ─── Main Worker ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startMs = Date.now();
    const chainId = `chain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const runId   = `run-${new Date().toISOString().slice(0, 10)}`;
    const steps: ChainStep[] = [];

    // ── CORS preflight ───────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Health check ─────────────────────────────────────────────────────────
    if (request.method === 'GET' && new URL(request.url).pathname === '/health') {
      return jsonResponse({
        status:    'ok',
        version:   AGENT_VERSION,
        model:     MODEL,
        project:   PROJECT_NAME,
        timestamp: new Date().toISOString(),
      });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed. Use POST.' }, 405);
    }

    // ── Rate limiting ────────────────────────────────────────────────────────
    const clientIp    = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const rateLimited = await isRateLimited(env.RATE_LIMITER, clientIp);
    if (rateLimited) {
      return jsonResponse({ error: 'Too many requests. Please wait a moment.' }, 429);
    }

    // ── Parse body ───────────────────────────────────────────────────────────
    let body: AgentRequest;
    try {
      body = await request.json<AgentRequest>();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body.' }, 400);
    }

    if (!body.query || typeof body.query !== 'string' || !body.query.trim()) {
      return jsonResponse({ error: 'Missing or empty "query" field.' }, 400);
    }

    // ── Turnstile ────────────────────────────────────────────────────────────
    if (env.TURNSTILE_SECRET) {
      const valid = await validateTurnstile(env.TURNSTILE_SECRET, body.turnstile_token ?? '');
      if (!valid) return jsonResponse({ error: 'Turnstile verification failed.' }, 403);
    }

    // ══ STEP 1: RETRIEVER ════════════════════════════════════════════════════
    const stepRetrieverStart = Date.now();
    const intent  = classifyIntent(body.query);
    const orderId = extractOrderId(body.query);
    const order   = orderId ? await getOrderFromDB(env.DB, orderId) : null;

    const taxResult = order ? verifyTax(order) : null;

    if (order && taxResult) {
      const verifiedFlag = taxResult.verdict === 'correct'    ?  1
        : taxResult.verdict === 'discrepancy'                 ? -1
        : 0;
      ctx.waitUntil(
        env.DB
          .prepare('UPDATE orders SET tax_verified = ? WHERE order_id = ?')
          .bind(verifiedFlag, order.order_id)
          .run()
          .catch(e => console.error('[CERT-AGENT] tax_verified update error:', e))
      );
    }

    steps.push({
      step_id:        `${chainId}-retriever`,
      step_type:      'retriever',
      input:          body.query,
      output:         order
        ? JSON.stringify({ order_id: order.order_id, status: order.status })
        : 'not_found',
      latency_ms:     Date.now() - stepRetrieverStart,
      token_estimate: 0,
      metadata:       { intent, order_found: order !== null, tax_verdict: taxResult?.verdict ?? null },
    });

    // ══ STEP 2: LLM ══════════════════════════════════════════════════════════
    const stepLlmStart   = Date.now();
    const prompt         = buildPrompt(intent, body.query, order, taxResult);
    const answer         = await callLLM(env.AI, prompt);
    const llmMs          = Date.now() - stepLlmStart;
    const promptTokens   = Math.ceil(prompt.length  / 4);
    const responseTokens = Math.ceil(answer.length  / 4);

    steps.push({
      step_id:        `${chainId}-llm`,
      step_type:      'llm',
      input:          prompt,
      output:         answer,
      latency_ms:     llmMs,
      token_estimate: promptTokens + responseTokens,
      metadata:       { model: MODEL, prompt_tokens: promptTokens, response_tokens: responseTokens },
    });

    // ══ STEP 3: EVALUATOR ════════════════════════════════════════════════════
    const stepEvalStart = Date.now();
    const evalMetrics   = evaluateResponse(intent, order, answer, taxResult);

    steps.push({
      step_id:        `${chainId}-evaluator`,
      step_type:      'evaluator',
      input:          answer,
      output:         JSON.stringify(evalMetrics),
      latency_ms:     Date.now() - stepEvalStart,
      token_estimate: 0,
      metadata:       { chunk_attribution: evalMetrics.chunk_attribution },
    });

    // ══ GALILEO TRACE ════════════════════════════════════════════════════════
    const trace: GalileoTrace = {
      chain_id:           chainId,
      run_id:             runId,
      project:            PROJECT_NAME,
      timestamp:          new Date().toISOString(),
      region:             (request.cf as Record<string, string> | undefined)?.colo ?? 'unknown',
      model:              MODEL,
      intent,
      order_id_extracted: orderId,
      order_found:        order !== null,
      tax_verified:       order?.tax_verified ?? null,
      tax_discrepancy:    taxResult?.discrepancy ?? null,
      latency_ms:         Date.now() - startMs,
      rate_limited:       false,
      steps,
      eval_metrics:       evalMetrics,
    };

    ctx.waitUntil(
      Promise.resolve().then(() => emitTrace(env.ANALYTICS, trace))
    );

    console.log('[CERT-AGENT]', JSON.stringify({
      chain_id:   trace.chain_id,
      intent:     trace.intent,
      order_id:   trace.order_id_extracted,
      latency_ms: trace.latency_ms,
      eval:       trace.eval_metrics,
      tax:        taxResult
        ? { verdict: taxResult.verdict, discrepancy: taxResult.discrepancy }
        : null,
    }));

    return jsonResponse({
      query:       body.query,
      intent,
      order_id:    orderId,
      order_found: order !== null,
      response:    answer,
      tax_check:   taxResult,
      _galileo:    trace,
    });
  },
};
