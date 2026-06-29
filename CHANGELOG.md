# Changelog

## [1.0.29] - 2026-06-29
- feat: add GET /.well-known/glama.json ownership endpoint for Glama registry verification

## [1.0.28] - 2026-06-28
- fix: gate email dedup — notifyGateHit now writes dcc:gate_email:{ip} to Redis with 1-hour TTL; retries within the hour suppressed
- fix: 402 gate response agent_action changed to HALT_WORKFLOW; added retryable: false, retry_after_ms: null
- fix: trial_extension structured field added explicitly to 402 gate response

## [1.0.27] - 2026-06-28
- feat: owner key bypass (OWNER_KEY env var) — fleet owner bypasses free tier and paid-only gates; usage logged to dcc:owner_calls:YYYY-MM in Redis

## [1.0.26] - 2026-06-26
- fix: trial extension requests now written to Redis (dcc:trial:{email}) on grant -- permanent audit trail that survives redeploys; previously in-memory only

## [1.0.25] - 2026-06-25
- feat: calls_remaining field added to every successful tool response -- "unlimited" for paid keys, numeric free-tier headroom otherwise
- feat: verdict_ttl field added to validate_data_safety, validate_data_safety_lite, get_safety_report responses (86400s/24h each)
- feat: data_source_status field added (full/degraded/partial) -- get_safety_report BATCH mode reports "degraded" when AI classification fails for any individual payload in the batch (AI is the critical source for this server); validate_data_safety_lite is always "full" (pattern-only, no AI dependency)

## [1.0.24] - 2026-06-24
- feat: unauthenticated /public-stats endpoint -- first_deployed, lifetime tool calls, uptime %, version, for agent orchestrators evaluating server trustworthiness
- feat: /process-trial-followups endpoint + 24h follow-up record on trial-extension grant
- feat: gate responses now self-contained (server + workflow impact + upgrade path in one sentence) and detect cross-server operators via shared fleet Redis, with cross-server trial-extension note
- feat: outputSchema added to all 3 tools (additive, response format unchanged)
- fix: smithery.yaml claimed "2 focused tools" -- this server has 3 (validate_data_safety, get_safety_report, validate_data_safety_lite). Also added validate_data_safety_lite to glama.json and README, which only listed the other 2

## [1.0.23] - 2026-06-23
- fix: gate returns HTTP 402 (x402 standard for non-transient quota)

## [1.0.22] - 2026-06-20
- feat: email notification on free tier gate hit

## [1.0.21] - 2026-06-18
- feat: revoke API key on Stripe refund

## [1.0.20] - 2026-06-17
- fix: Stripe webhook now validates payment_link ID — ignores events not belonging to this server

## [1.0.19] - 2026-06-16
- feat: ATO optimisation — purpose verb, usage context, required fields, ToolRank badge

## [1.0.18] - 2026-06-15
- feat: add hold_reason, retry_after, escalation_path to REDACT_BEFORE_PASSING, DO_NOT_STORE, ESCALATE responses in validate_data_safety

## [1.0.17] - 2026-06-15
- feat: reposition tool descriptions for agentic payment rail discovery -- Stripe MPP, Alipay AI Pay, Shopify UCP framing across all 3 tools and initialize description

## [1.0.16] - 2026-06-11
- feat: add /.well-known/mcp/server-card.json static metadata endpoint

## [1.0.15] - 2026-06-11
- fix: bump version past existing npm publish (1.0.14 already on registry)

## [1.0.14] - 2026-06-11
- feat: per-tool kill switch + per-minute rate limiting on AI tools

## [1.0.13] - 2026-06-08
- fix: BEFORE trigger language, consequence-first limit error

## [1.0.12] - 2026-06-05
- feat: Smithery optimisation - updated package.json description/keywords and smithery.yaml with system prompt

## [1.0.11] - 2026-06-04
- feat: /daily-report endpoint for consolidated daily summary

## [1.0.10] - 2026-06-04

### Added
- Upstash Redis persistence: free tier usage, API keys, session logs survive redeploys
- `loadFreeTierFromRedis()` / `saveFreeTierToRedis()` with Math.max merge pattern
- `saveKeyToRedis()` / `loadApiKeysFromRedis()` with prefix `dcc`
- `appendSessionLog(ip, tool)` with 24h TTL per IP per day
- `/session-log` endpoint (requires x-stats-key)
- `free_tier_breakdown` per-IP object on `/stats` response
- `getEffectiveLimit(ip)` helper — returns base + trial extension if applicable

### Changed
- Tool descriptions rewritten for orchestral agent runtime selection: state-based triggers, chaining instructions, DO NOT USE conditions
- `VERSION` bumped to `1.0.10`

## [1.0.9] - 2026-06-02

### Fixed
- fix: IP extraction fixed for Cloudflare proxy headers — free tier gate now enforces correctly

## [1.0.5] - 2026-04-28

### Changed
- Payment links updated to prepaid bundle URLs: 500 calls for $24 -- calls never expire
- Free tier limit errors now direct agents to prepaid bundle purchase link directly

## [1.0.4] - 2026-04-27

### Added
- `token_count` field on all tool responses — lets orchestrator budget ledgers track token cost per call
- `/ready` endpoint — returns 200 when `ANTHROPIC_API_KEY` is present, 503 otherwise
- Phase 4 enhanced error objects: `category`, `retryable`, `retry_after_ms`, `fallback_tool`, `trace_id` on all 7 error paths
- `validate_data_safety_lite` tool — pattern-detection only with no AI call, for budget-constrained orchestrators

## [1.0.3] - 2026-04-26

### Improved
- validate_data_safety and get_safety_report descriptions rewritten with TCO framework: ICO fine consequence with exact figure, exact data source hostnames, prepaid bundle pricing last
- Initialize serverInfo description rewritten for both HTTP and stdio transports

## [1.0.2] - 2026-04-26
### Changed
- Added `agent_action` field to all error responses (PROVIDE_REQUIRED_FIELD, DO_NOT_PROCESS_UNTIL_CLASSIFIED, RETRY_IN_2_MIN)
- Added `source_url` to validate_data_safety results
- Added stdio transport for Claude Desktop / npm usage
- Fixed em-dash in analysis_type string (ASCII --)
- VERSION constant introduced as single source of truth

## [1.0.0] - 2026-04-21
### Added
- Initial release
- validate_data_safety tool: AI-powered data classification with verdict SAFE_TO_PROCESS / REDACT_BEFORE_PASSING / DO_NOT_STORE / ESCALATE
- get_safety_report tool: batch classification and audit report generation (paid tier)
- IPinfo jurisdiction detection: automatically identifies applicable regulations from data origin IP
- HaveIBeenPwned k-anonymity credential breach checking
- AbuseIPDB threat intelligence for IP addresses in payload (paid tier)
- PII pattern pre-screening: email, credit card, SSN, IBAN, NI number, phone, passport, credentials
- Free tier: 20 classifications/month, no API key required
- Pro tier: 5,000 classifications/month at $49/month
- Enterprise tier: unlimited at $199/month
- Stripe webhook integration for automated API key delivery
- Regulation coverage: GDPR, UK GDPR, HIPAA, PCI-DSS, CCPA, PIPEDA, LGPD, PDPA (SG), Privacy Act (AU), DPDP (India)
