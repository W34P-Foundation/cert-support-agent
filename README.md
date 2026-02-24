### [status::beta] CERT-Support Agent
An Autonomous Order & Inventory Intelligence Agent built on Cloudflare Workers AI.

This agent provides a natural language interface for the CERT Outfitters e-commerce platform. It leverages LLMs at the edge to transform user intent into precise database queries against Cloudflare D1.

#### [stack::edge-native] Technical Stack
Runtime: Cloudflare Workers (Serverless)

AI Engine: Llama-3-8b-instruct via Workers AI

Database: Cloudflare D1 (SQLite)

Language: TypeScript

Security: Cloudflare Turnstile integration for request validation.

#### [feature::intent-classification] Key Features
Intent Classification: Uses a specialized prompt chain to distinguish between general support inquiries and specific transactional lookups (Order Status/Inventory).

RAG-Lite Architecture: Retrieves real-time data from D1 to augment LLM responses, ensuring zero-hallucination for order tracking.

Edge-Native: Deployed globally with sub-50ms cold starts, providing instant support response times.

#### [arch::router-controller] Architecture Logic
The agent follows a Router-Controller pattern:

Sanitize: User input is cleaned and checked for SQL injection.

Route: The LLM identifies if the user is asking about an order (CERT-XXXXXX).

Execute: If an ID is present, the Worker performs a SELECT on the D1 instance.

Synthesize: The raw DB data is fed back to the LLM to generate a human-friendly response.

🔧 Getting Started
```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/cert-support-agent

# Install dependencies
npm install

# Deploy to Cloudflare
npx wrangler deploy
```
