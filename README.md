[![smithery badge](https://smithery.ai/badge/OjasKord/data-compliance-mcp)](https://smithery.ai/servers/OjasKord/data-compliance-mcp)

# Data Compliance Classifier MCP

Your agent is about to store customer data. Is it safe to? This tool tells you in one call.

## What it does

Before your agent stores, transmits, logs, or passes any data to another system — call `validate_data_safety`. Get back a clear verdict: **SAFE_TO_PROCESS**, **REDACT_BEFORE_PASSING**, **DO_NOT_STORE**, or **ESCALATE**. Your agent acts on the verdict immediately. No human interpretation needed.

Prevents GDPR, HIPAA, and PCI-DSS violations before they happen — not after.

## Why this exists

Autonomous agents handle data from users, APIs, forms, and external sources constantly. Most agents process that data without checking whether they should. When something goes wrong — a GDPR breach, a leaked credential, a PII write to an unencrypted store — it's already too late.

This tool gives agents a pre-action safety check. One call, clear verdict, agent proceeds or halts.

## Tools

### `validate_data_safety` (free tier)

Call this BEFORE your agent stores, transmits, or passes any data payload.

**Input:**
- `payload` — the data to classify (any string, JSON, form data, API response)
- `context` — what your agent is about to do with it (improves accuracy)
- `data_origin_ip` — optional IP for jurisdiction detection (GDPR if EU, CCPA if US, etc.)
- `jurisdiction` — optional override if IP unavailable

**Output:**
- `verdict` — SAFE_TO_PROCESS / REDACT_BEFORE_PASSING / DO_NOT_STORE / ESCALATE
- `sensitivity_level` — PUBLIC / INTERNAL / CONFIDENTIAL / RESTRICTED
- `detected_categories` — PII, PHI, PCI, CREDENTIALS, FINANCIAL, LOCATION, etc.
- `applicable_regulations` — GDPR, HIPAA, PCI-DSS, CCPA, PIPEDA, LGPD, etc.
- `recommended_action` — one sentence telling your agent exactly what to do next
- `jurisdiction_detected` — country detected from IP
- `credential_check` — breach status from HaveIBeenPwned k-anonymity API
- `patterns_detected` — pre-screened PII patterns found

### `get_safety_report` (paid tier)

Batch classification for up to 50 payloads plus audit-ready compliance reports.

**Modes:**
- `BATCH` — classify multiple payloads with full AI reasoning + AbuseIPDB threat intelligence
- `AUDIT` — generate a structured compliance report for a dataset description

## Data privacy

We do not store or log your data payloads. All payloads are analysed in memory and immediately discarded. Credential checks use the HaveIBeenPwned k-anonymity API — your credentials are never transmitted in full. Only the first 5 characters of a SHA-1 hash are sent.

## Data sources

- **Claude AI** — sensitivity classification and regulatory mapping
- **IPinfo** (ipinfo.io) — jurisdiction detection from IP address
- **HaveIBeenPwned** (haveibeenpwned.com) — credential breach checking via k-anonymity
- **AbuseIPDB** (abuseipdb.com) — IP threat intelligence (paid tier)

## Pricing

| Plan | Classifications | Price |
|---|---|---|
| Free | 20/month | No API key needed |
| Starter | 500-call bundle | $24 |
| Pro | 2,000-call bundle | $84 |

Upgrade at [kordagencies.com](https://kordagencies.com)

## Quick start

No API key needed for free tier:

```json
{
  "data-compliance": {
    "url": "https://data-compliance-mcp-production.up.railway.app"
  }
}
```

With paid API key:

```json
{
  "data-compliance": {
    "url": "https://data-compliance-mcp-production.up.railway.app",
    "headers": {
      "x-api-key": "your_api_key_here"
    }
  }
}
```

## Harness Integration

### Claude Code / Claude Desktop (.mcp.json)
```json
{
  "mcpServers": {
    "data-compliance": {
      "type": "http",
      "url": "https://data-compliance-mcp-production.up.railway.app"
    }
  }
}
```

### LangChain (Python)
```python
from langchain_mcp_adapters.client import MultiServerMCPClient
client = MultiServerMCPClient({
    "data-compliance": {
        "url": "https://data-compliance-mcp-production.up.railway.app",
        "transport": "http"
    }
})
tools = await client.get_tools()
```

### OpenAI Agents SDK (Python)
```python
from agents import Agent, HostedMCPTool
agent = Agent(
    name="Assistant",
    tools=[HostedMCPTool(tool_config={
        "type": "mcp",
        "server_label": "data-compliance",
        "server_url": "https://data-compliance-mcp-production.up.railway.app",
        "require_approval": "never"
    })]
)
```

### LangGraph
Same as LangChain above — langchain-mcp-adapters works with LangGraph natively.

## Example call

```bash
curl -X POST https://data-compliance-mcp-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_data_safety","arguments":{"payload":"{\"name\":\"John Smith\",\"email\":\"john@example.com\",\"dob\":\"1985-03-12\",\"address\":\"14 Baker Street, London\"}","context":"write to customer database","jurisdiction":"EU"}}}'
```

Expected response:
```json
{
  "verdict": "DO_NOT_STORE",
  "sensitivity_level": "RESTRICTED",
  "detected_categories": ["PII"],
  "applicable_regulations": ["GDPR"],
  "recommended_action": "Do not store without explicit consent and a documented lawful basis under GDPR Article 6.",
  "jurisdiction_detected": "EU"
}
```

## Legal

Classification is AI-powered and for informational purposes only. Does not constitute legal advice and does not guarantee regulatory compliance. Full terms: [kordagencies.com/terms.html](https://kordagencies.com/terms.html)
