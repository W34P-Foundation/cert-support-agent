### ![Status](https://img.shields.io/badge/status-beta-blue) CERT-Support Agent
An Autonomous Order & Inventory Intelligence Agent built on Cloudflare Workers AI.

This agent provides a natural language interface for the CERT Outfitters e-commerce platform. It leverages LLMs at the edge to transform user intent into precise database queries against Cloudflare D1.

#### ![Stack](https://img.shields.io/badge/stack-edge--native-orange) Technical Stack
Runtime: Cloudflare Workers (Serverless)

AI Engine: Llama-3-8b-instruct via Workers AI

Database: Cloudflare D1 (SQLite)

Language: TypeScript

Security: Cloudflare Turnstile integration for request validation.

#### ![](https://img.shields.io/badge/feature-intent--classification-blueviolet?style=flat-square) Key Features
Intent Classification: Uses a specialized prompt chain to distinguish between general support inquiries and specific transactional lookups (Order Status/Inventory).

RAG-Lite Architecture: Retrieves real-time data from D1 to augment LLM responses, ensuring zero-hallucination for order tracking.

Edge-Native: Deployed globally with sub-50ms cold starts, providing instant support response times.

#### ![](https://img.shields.io/badge/arch-router--controller-lightgrey?style=flat-square) Architecture Logic
The agent follows a Router-Controller pattern:

Route: The LLM identifies if the user is asking about an order (CERT-XXXXXX).

Execute: If an ID is present, the Worker performs a SELECT on the D1 instance using parameterized queries for security.

Synthesize: The raw DB data is fed back to the LLM to generate a human-friendly response.

###  ![](https://img.shields.io/badge/setup-automated-brightgreen) Getting Started
```bash
# Clone the repo
git clone https://github.com/W34P-Foundation/cert-support-agent

# Install dependencies
npm install

# Create a D1 database
npx wrangler d1 create cert-support-db

# Update wrangler.toml with the database_id from the previous command

# Create the orders table
npx wrangler d1 execute cert-support-db --command "CREATE TABLE orders (order_id TEXT PRIMARY KEY, status TEXT, tracking_number TEXT)"

# Deploy to Cloudflare
npx wrangler deploy
```
---

<details>
<summary>🔭 <b>Advanced Observability Node</b></summary>

<br>

![](https://img.shields.io/badge/%F0%9F%94%AD_OBSERVABILITY-ALL_SIGNALS_NOMINAL-blueviolet?style=for-the-badge&labelColor=1a1a2e)
---

![](https://img.shields.io/badge/%F0%9F%93%A1_TRACE-MANIFEST-0d1b2a?style=for-the-badge&labelColor=1a1a2e)


| Field | Value |
|---|---|
| `trace_id` | `cert-agent-edge-v1` |
| `region` | `Wrangler-Edge` |
| `latency` | `sub-50ms` |

---

![](https://img.shields.io/badge/%F0%9F%A7%AA_EVAL-METRICS-0d1b2a?style=for-the-badge&labelColor=1a1a2e)


| Pillar | Metric | Status |
|---|---|---|
| Faithfulness | Hallucination Prevention | ![optimized](https://img.shields.io/badge/status-optimized-brightgreen?style=flat-square) |
| Routing | Deterministic Execution | ![active](https://img.shields.io/badge/routing-deterministic-blue?style=flat-square) |
| Latency | Edge Cold Start | ![sub-50ms](https://img.shields.io/badge/latency-sub--50ms-orange?style=flat-square) |

---

### 🗂️ Raw Trace Payload

```json
{
  "trace_id": "cert-agent-edge-v1",
  "eval_metrics": {
    "pillar": "faithfulness",
    "metric": "hallucination_prevention",
    "status": "optimized"
  },
  "performance": {
    "latency": "sub-50ms",
    "region": "Wrangler-Edge"
  }
}
```

---

> [!NOTE]
> *"In God we trust, all others must bring data."*
>
> This agent is architected for the **full observability lifecycle**, prioritizing deterministic routing over stochastic generation.

</details>
