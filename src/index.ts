/**
 * CERT Support Agent - Cloudflare Worker
 * 
 * An autonomous order & inventory intelligence agent that uses:
 * - Cloudflare Workers AI (Llama-3-8b-instruct)
 * - Cloudflare D1 (SQLite database)
 * - Router-Controller pattern for intent classification
 * 
 * Architecture: Route → Execute → Synthesize
 * - Route: Extract Order ID from user query (CERT-XXXXXX format)
 * - Execute: Query D1 database using parameterized queries for security
 * - Synthesize: Generate AI response with real order data (RAG pattern)
 */

// Type definitions for Cloudflare Worker environment
export interface Env {
  AI: Ai; // Cloudflare Workers AI binding
  DB: D1Database; // Cloudflare D1 database binding
}

// Order data structure from D1 database
interface Order {
  order_id: string;
  status: string;
  tracking_number: string;
}

/**
 * Extract Order ID from user query
 * Format: CERT-XXXXXX (where X is a digit)
 */
function extractOrderId(query: string): string | null {
  const orderIdPattern = /CERT-\d{6}/i;
  const match = query.match(orderIdPattern);
  return match ? match[0].toUpperCase() : null;
}

/**
 * Query D1 database for order information
 */
async function getOrderFromDB(db: D1Database, orderId: string): Promise<Order | null> {
  try {
    const result = await db
      .prepare('SELECT order_id, status, tracking_number FROM orders WHERE order_id = ?')
      .bind(orderId)
      .first<Order>();
    
    return result;
  } catch (error) {
    console.error('Database query error:', error);
    return null;
  }
}

/**
 * Use AI to generate a friendly response based on order data
 */
async function generateAIResponse(ai: Ai, query: string, orderData: Order | null): Promise<string> {
  let prompt: string;
  
  if (orderData) {
    // RAG-augmented response with real data
    prompt = `You are a helpful customer support agent for CERT Outfitters. 
A customer asked: "${query}"

Here is the order information from our database:
- Order ID: ${orderData.order_id}
- Status: ${orderData.status}
- Tracking Number: ${orderData.tracking_number}

Please provide a friendly, helpful response to the customer based on this information. Be concise and professional.`;
  } else {
    // General support response
    prompt = `You are a helpful customer support agent for CERT Outfitters. 
A customer asked: "${query}"

Please provide a friendly, helpful response. If they mentioned an order ID but we couldn't find it, politely let them know we couldn't locate that order and suggest they double-check the order number or contact support.`;
  }

  try {
    const response = await ai.run('@cf/meta/llama-3-8b-instruct', {
      messages: [
        { role: 'system', content: 'You are a helpful customer support agent for CERT Outfitters e-commerce platform.' },
        { role: 'user', content: prompt }
      ]
    });

    return response.response || 'I apologize, but I encountered an issue generating a response. Please try again.';
  } catch (error) {
    console.error('AI generation error:', error);
    return 'I apologize, but I encountered an issue processing your request. Please try again.';
  }
}

/**
 * Main Worker handler
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response('Method not allowed. Please use POST.', { 
        status: 405,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    try {
      // Parse the request body
      const body = await request.json() as { query?: string };
      
      if (!body.query || typeof body.query !== 'string') {
        return new Response(
          JSON.stringify({ error: 'Missing or invalid "query" field in request body' }), 
          { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      // Step 1: Route - Check if query contains an Order ID
      const orderId = extractOrderId(body.query);

      let orderData: Order | null = null;

      // Step 2: Execute - If Order ID found, query D1 database
      if (orderId) {
        orderData = await getOrderFromDB(env.DB, orderId);
      }

      // Step 3: Synthesize - Generate AI response
      const aiResponse = await generateAIResponse(env.AI, body.query, orderData);

      // Return the response
      return new Response(
        JSON.stringify({
          query: body.query,
          orderId: orderId,
          orderFound: orderData !== null,
          response: aiResponse
        }),
        {
          status: 200,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );

    } catch (error) {
      console.error('Worker error:', error);
      return new Response(
        JSON.stringify({ 
          error: 'An error occurred processing your request',
          details: error instanceof Error ? error.message : 'Unknown error'
        }),
        { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }
};
