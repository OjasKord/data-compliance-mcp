# Changelog

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
