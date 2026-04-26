# Changelog

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
